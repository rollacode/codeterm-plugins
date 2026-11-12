import { defineProviderIo, ioValue, type HostIoSteps, type HostIoResult } from "@codeterm/plugin-sdk";
// Transcriber plugin — CodeTerm's speech-to-text backend (capability: transcriber).
// Authored in TypeScript against @codeterm/plugin-sdk and compiled to a
// QuickJS-compatible plugin.js by scripts/build-plugin.mjs.
//
// One-shot engine: there is no daemon and no HTTP. CodeTerm hands us an audio file
// path; we convert it to a 16 kHz mono WAV with ffmpeg, run whisper.cpp's
// `whisper-cli` once (`-oj` → JSON sidecar), read the JSON, join the segments, and
// clean up. host.fetch is text-only (can neither download a model nor upload audio),
// so every dependency is bootstrapped lazily through host.io.exec + curl instead:
//
//   • macOS   — `brew install whisper-cpp` (gives `whisper-cli`) and `brew install ffmpeg`.
//   • Windows — `curl` the whisper-bin-x64.zip GitHub release + a static ffmpeg zip,
//               extract with `tar` into the instance data directory under transcriber/bin.
//   • Linux   — `curl` the whisper-bin-Linux.zip release + a static ffmpeg build, extract
//               with `tar`; clear manual-install message if that path is unavailable.
//
// Everything is detect-first: a dependency that is already on PATH (or already in our
// bin dir) is never reinstalled. Failures return an agent-readable error telling the
// user exactly what to install by hand.
import type {
  DirEntry,
  ExecOpts,
  ExecResult,
  GlanceView,
  PluginModule,
  TranscribeResult,
  ViewNode,
} from "@codeterm/plugin-sdk";

interface TranscriberSettings {
  language?: string;
  model?: string;
  endpoint?: string;
}

type Resolved = { bin: string } | { error: string };
type Ensured = { ok: true } | { error: string };
type ProgressOptions = { label: string; percent?: number; done?: boolean; error?: string };

interface StatusResult {
  state: "ready" | "unloaded" | "unavailable";
  reason?: string;
}

// whisper.cpp release tag the prebuilt binaries are pulled from (Win/Linux only).
const WHISPER_RELEASE = "v1.9.1";
const WHISPER_BASE =
  "https://github.com/ggml-org/whisper.cpp/releases/download/" + WHISPER_RELEASE;
const FFMPEG_WIN_ZIP =
  "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const FFMPEG_LINUX_TAR =
  "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz";

// ── settings / paths ─────────────────────────────────────────────────

function settings(): TranscriberSettings {
  try {
    return (JSON.parse(host.settingsJson()) as TranscriberSettings) || {};
  } catch (e) {
    return {};
  }
}

function modelId(): string {
  const s = settings();
  return s.model && s.model.length ? s.model : "small";
}

function language(): string {
  const s = settings();
  if (s.language && s.language.length) return s.language;
  const env = host.envGet("CODETERM_TRANSCRIBE_LANG");
  return env && env.length ? env : "auto";
}

// Empty => local whisper.cpp. Set => offload to a mesh GPU daemon over curl.
function endpoint(): string {
  const s = settings();
  const ep = s.endpoint && s.endpoint.length ? s.endpoint : host.envGet("CODETERM_TRANSCRIBE_ENDPOINT");
  return ep && ep.length ? ep.trim() : "";
}

function baseDir(): string {
  return host.dataDir() + "/transcriber";
}

function binDir(): string {
  return baseDir() + "/bin";
}

function tmpDir(): string {
  return baseDir() + "/tmp";
}

function modelPath(): string {
  return baseDir() + "/ggml-" + modelId() + ".bin";
}

function modelDonePath(): string {
  return modelPath() + ".done";
}

function entryName(entry: DirEntry | string): string {
  return typeof entry === "string" ? entry : entry.name;
}

function* cleanupOrphanModels(activeModel: string): HostIoSteps<void> {
  const dir = baseDir();
  let entries: (DirEntry | string)[] = [];
  try {
    entries = yield* host.io.fs.readDir(dir);
  } catch (e) {
    return;
  }

  const activeName = activeModel.substring(activeModel.lastIndexOf("/") + 1);
  for (const entry of entries) {
    const name = entryName(entry);
    if (!/^ggml-.*\.bin$/.test(name)) continue;
    if (name === activeName) continue;

    const path = typeof entry === "string" ? dir + "/" + name : entry.path || dir + "/" + name;
    if (path === activeModel || path.endsWith(".part")) continue;
    (yield* host.io.fs.removeFile(path));
    (yield* host.io.fs.removeFile(path + ".done"));
  }
}

function osKind(): "macos" | "windows" | "linux" {
  const p = String(host.platform() || "").toLowerCase();
  if (p.indexOf("win") !== -1) return "windows";
  if (p.indexOf("mac") !== -1 || p.indexOf("darwin") !== -1 || p.indexOf("osx") !== -1)
    return "macos";
  return "linux";
}

function exeSuffix(): string {
  return osKind() === "windows" ? ".exe" : "";
}

function* exec(opts: ExecOpts): HostIoSteps<ExecResult> {
  const raw = JSON.stringify(yield* host.io.exec(opts as any));
  try {
    return JSON.parse(raw) as ExecResult;
  } catch (e) {
    return { error: String(e) };
  }
}

function* runBin(bin: string, args: string[], timeoutMs?: number): HostIoSteps<ExecResult> {
  return (yield* exec({ bin, args, timeoutMs }));
}

function ranOk(r: ExecResult): boolean {
  // "ran at all" — a missing binary surfaces as a spawn `error`; --help/--version
  // may exit non-zero, but the absence of `error` means the binary exists.
  return !r.error;
}

function exitedOk(r: ExecResult): boolean {
  return !r.error && (r.code === undefined || r.code === 0);
}

function* progress(opts: ProgressOptions): HostIoSteps<void> {
  yield* ioValue<HostIoResult<"progress">>({ op: "progress", options: opts });
}

function* errorResult(message: string): HostIoSteps<TranscribeResult> {
  (yield* progress({ label: "Error", error: message }));
  return { error: message };
}

// ── dependency bootstrap (detect-then-install) ───────────────────────

// A binary is "present" if it runs from PATH, or if we already dropped it in binDir.
function localBin(name: string): string {
  return binDir() + "/" + name + exeSuffix();
}

function* findLocalBin(name: string): HostIoSteps<string | null> {
  const root = binDir();
  const suffix = exeSuffix();
  const direct = root + "/" + name + suffix;
  if ((yield* host.io.fs.fileExists(direct))) return direct;

  const fixedCandidates = [
    root + "/bin/" + name + suffix,
    root + "/Release/" + name + suffix,
  ];
  for (const c of fixedCandidates) {
    if ((yield* host.io.fs.fileExists(c))) return c;
  }

  let entries: (DirEntry | string)[] = [];
  try {
    entries = yield* host.io.fs.readDir(root);
  } catch (e) {
    return null;
  }

  for (const entry of entries) {
    const child = entryName(entry);
    if (!child || child.indexOf("/") !== -1 || child.indexOf("\\") !== -1) continue;
    const base = root + "/" + child;
    const candidates = [
      base + "/" + name + suffix,
      base + "/bin/" + name + suffix,
      base + "/Release/" + name + suffix,
    ];
    for (const c of candidates) {
      if ((yield* host.io.fs.fileExists(c))) return c;
    }
  }
  return null;
}

function* download(url: string, dest: string): HostIoSteps<Ensured> {
  (yield* host.io.fs.makeDirs(dirOf(dest)));
  (yield* host.io.fs.removeFile(dest));

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = (yield* exec({ bin: "curl", args: ["-fL", "--retry", "2", "--retry-delay", "2", "-o", dest, url], timeoutMs: 1800000 }));
    if (exitedOk(r)) return { ok: true };
    (yield* host.io.fs.removeFile(dest));

    if (attempt === 2 && osKind() === "windows") {
      const ps = (yield* downloadWithPowerShell(url, dest));
      if ("error" in ps) {
        return {
          error:
            "download failed (" +
            url +
            "): curl: " +
            (r.stderr || r.error || "exit " + r.code) +
            "; powershell: " +
            ps.error,
        };
      }
      return ps;
    }

    if (attempt === 2) {
      return { error: "download failed (" + url + "): " + (r.stderr || r.error || "curl exit " + r.code) };
    }
  }
  return { ok: true };
}

function* downloadWithPowerShell(url: string, dest: string): HostIoSteps<Ensured> {
  const script =
    "$ProgressPreference='SilentlyContinue';" +
    "Invoke-WebRequest -Uri " +
    psQuote(url) +
    " -OutFile " +
    psQuote(dest) +
    " -UseBasicParsing";
  const r = (yield* exec({
    bin: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    timeoutMs: 1800000,
  }));
  if (!exitedOk(r) || !(yield* host.io.fs.fileExists(dest))) {
    return { error: r.stderr || r.error || "powershell exit " + r.code };
  }
  return { ok: true };
}

function psQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function* untar(archive: string, dest: string): HostIoSteps<Ensured> {
  (yield* host.io.fs.makeDirs(dest));
  // bsdtar (`tar`) ships on macOS, modern Windows, and Linux; it reads .zip, .tar.gz, .tar.xz.
  const r = (yield* exec({ bin: "tar", args: ["-xf", archive, "-C", dest], timeoutMs: 600000 }));
  if (!exitedOk(r)) {
    return { error: "extract failed (" + archive + "): " + (r.stderr || r.error || "tar exit " + r.code) };
  }
  return { ok: true };
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.substring(0, i) : ".";
}

// The plugin runtime does not inherit a login shell's PATH, so a Homebrew binary
// the user can run in their terminal is invisible to `exec({ bin: "ffmpeg" })`.
// Resolving to an ABSOLUTE path fixes both the lookup and the retry after
// `brew install`, which otherwise re-checks the same empty PATH (#1).
function* brewPrefixes(): HostIoSteps<string[]> {
  const out: string[] = [];
  // brew's own prefix is authoritative; ask it wherever brew itself can be found.
  for (const brew of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "brew"]) {
    const r = (yield* exec({ bin: brew, args: ["--prefix"], timeoutMs: 15000 }));
    const prefix = ranOk(r) ? String((r as { stdout?: string }).stdout || "").trim() : "";
    if (prefix) { out.push(prefix + "/bin"); break; }
  }
  return out;
}

function* unixBinCandidates(name: string): HostIoSteps<string[]> {
  const home = (host.homeDir && host.homeDir()) || "";
  const dirs = (yield* brewPrefixes()).concat([
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    home ? home.replace(/\/+$/, "") + "/.local/bin" : "",
  ]);
  const seen: Record<string, boolean> = {};
  const out: string[] = [];
  for (const dir of dirs) {
    if (!dir || seen[dir]) continue;
    seen[dir] = true;
    out.push(dir + "/" + name);
  }
  return out;
}

// Absolute path to `name`, or null. Checked in cost order: what we installed
// ourselves, then the well-known prefixes.
function* resolveUnixBin(name: string): HostIoSteps<string | null> {
  const local = (yield* findLocalBin(name));
  if (local) return local;
  const candidates = yield* unixBinCandidates(name);
  for (const candidate of candidates) {
    if ((yield* host.io.fs.fileExists(candidate))) return candidate;
  }
  return null;
}

// Where we looked, so a failure is diagnosable without log spelunking.
function* lookedIn(name: string): HostIoSteps<string> {
  return (yield* unixBinCandidates(name)).concat([binDir() + "/" + name]).join(", ");
}

function* ensureFfmpeg(): HostIoSteps<Resolved> {
  if (ranOk((yield* exec({ bin: "ffmpeg", args: ["-version"] })))) return { bin: "ffmpeg" };
  const local = (yield* findLocalBin("ffmpeg"));
  if (local) return { bin: local };

  const os = osKind();
  if (os === "macos") {
    const found = (yield* resolveUnixBin("ffmpeg"));
    if (found) return { bin: found };
    (yield* progress({ label: "Installing ffmpeg…" }));
    const r = (yield* exec({ bin: "brew", args: ["install", "ffmpeg"], timeoutMs: 1800000 }));
    if (exitedOk(r)) {
      // Absolute first, because the PATH probe already failed once; the probe
      // stays as the fallback for a prefix these candidates do not cover.
      const installed = (yield* resolveUnixBin("ffmpeg"));
      if (installed) return { bin: installed };
      if (ranOk((yield* exec({ bin: "ffmpeg", args: ["-version"] })))) return { bin: "ffmpeg" };
    }
    return { error: "ffmpeg is required. Install it with `brew install ffmpeg`. Looked in: " + (yield* lookedIn("ffmpeg")) };
  }
  if (os === "windows") {
    (yield* progress({ label: "Installing ffmpeg…" }));
    const zip = baseDir() + "/ffmpeg.zip";
    const dl = (yield* download(FFMPEG_WIN_ZIP, zip));
    if ("error" in dl) return ffmpegManual(dl.error);
    const ex = (yield* untar(zip, binDir()));
    if ("error" in ex) return ffmpegManual(ex.error);
    (yield* host.io.fs.removeFile(zip));
    const installed = (yield* findLocalBin("ffmpeg"));
    if (installed) return { bin: installed };
    return ffmpegManual("ffmpeg binary not found after extraction");
  }
  // linux
  (yield* progress({ label: "Installing ffmpeg…" }));
  const tar = baseDir() + "/ffmpeg.tar.xz";
  const dl = (yield* download(FFMPEG_LINUX_TAR, tar));
  if ("error" in dl) return ffmpegManual(dl.error);
  const ex = (yield* untar(tar, binDir()));
  if ("error" in ex) return ffmpegManual(ex.error);
  (yield* host.io.fs.removeFile(tar));
  const installed = (yield* findLocalBin("ffmpeg"));
  if (installed) return { bin: installed };
  return ffmpegManual("ffmpeg binary not found after extraction");
}

function ffmpegManual(why: string): Resolved {
  return {
    error:
      "ffmpeg is required to decode the audio but could not be installed automatically (" +
      why +
      "). Install ffmpeg from your package manager (e.g. `apt install ffmpeg`) or https://ffmpeg.org/download.html.",
  };
}

function* ensureEngine(): HostIoSteps<Resolved> {
  if (ranOk((yield* exec({ bin: "whisper-cli", args: ["--help"] })))) return { bin: "whisper-cli" };
  const local = (yield* findLocalBin("whisper-cli"));
  if (local) return { bin: local };

  const os = osKind();
  if (os === "macos") {
    const found = (yield* resolveUnixBin("whisper-cli"));
    if (found) return { bin: found };
    (yield* progress({ label: "Installing whisper.cpp…" }));
    const r = (yield* exec({ bin: "brew", args: ["install", "whisper-cpp"], timeoutMs: 1800000 }));
    if (exitedOk(r)) {
      const installed = (yield* resolveUnixBin("whisper-cli"));
      if (installed) return { bin: installed };
      if (ranOk((yield* exec({ bin: "whisper-cli", args: ["--help"] })))) return { bin: "whisper-cli" };
    }
    return { error: "whisper-cli is required. Install it with `brew install whisper-cpp`. Looked in: " + (yield* lookedIn("whisper-cli")) };
  }
  // Windows + Linux: prebuilt archives from the whisper.cpp GitHub release.
  (yield* progress({ label: "Installing whisper.cpp…" }));
  const asset = os === "windows" ? "whisper-bin-x64.zip" : "whisper-bin-Linux.zip";
  const archive = baseDir() + "/whisper.zip";
  const dl = (yield* download(WHISPER_BASE + "/" + asset, archive));
  if ("error" in dl) return engineManual(os, dl.error);
  const ex = (yield* untar(archive, binDir()));
  if ("error" in ex) return engineManual(os, ex.error);
  (yield* host.io.fs.removeFile(archive));
  const installed = (yield* findLocalBin("whisper-cli"));
  if (installed) return { bin: installed };
  return engineManual(os, "whisper-cli not found after extraction");
}

function engineManual(os: string, why: string): Resolved {
  return {
    error:
      "whisper-cli (whisper.cpp) is required but could not be installed automatically on " +
      os +
      " (" +
      why +
      "). Build/download whisper.cpp from https://github.com/ggml-org/whisper.cpp/releases and place `whisper-cli" +
      exeSuffix() +
      "` in " +
      binDir() +
      ".",
  };
}

function* ensureModel(force = false): HostIoSteps<Ensured> {
  const mp = modelPath();
  const done = modelDonePath();
  // Only trust a model whose download fully completed. The .done sentinel is
  // written after curl exits 0; a killed/interrupted download leaves a partial
  // mp WITHOUT the sentinel, which we detect, discard, and re-download. Without
  // this, an interrupted download poisons mp permanently — every later transcribe
  // feeds whisper-cli a truncated model and hangs.
  if (!force && (yield* host.io.fs.fileExists(mp)) && (yield* host.io.fs.fileExists(done))) {
    (yield* cleanupOrphanModels(mp));
    return { ok: true };
  }
  (yield* host.io.fs.removeFile(mp));
  (yield* host.io.fs.removeFile(done));
  (yield* host.io.fs.makeDirs(baseDir()));
  const url =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-" + modelId() + ".bin";
  (yield* progress({ label: "Downloading model ggml-" + modelId() + " (~" + modelSizeMb(modelId()) + "MB)…" }));
  const dl = (yield* download(url, mp));
  if ("error" in dl) {
    (yield* host.io.fs.removeFile(mp));
    return {
      error:
        "could not download the whisper model `ggml-" +
        modelId() +
        ".bin`: " +
        dl.error +
        ". Download it manually to " +
        mp +
        ".",
    };
  }
  (yield* host.io.fs.writeFile(done, ""));
  (yield* cleanupOrphanModels(mp));
  return { ok: true };
}

function modelSizeMb(id: string): number {
  const sizes: Record<string, number> = {
    tiny: 75,
    "tiny.en": 75,
    base: 142,
    "base.en": 142,
    small: 466,
    "small.en": 466,
    medium: 1500,
    "medium.en": 1500,
    large: 2900,
    "large-v1": 2900,
    "large-v2": 2900,
    "large-v3": 3100,
    "large-v3-turbo": 1600,
  };
  return sizes[id] || 466;
}

function* modelFileBytes(path: string): HostIoSteps<number | null> {
  const dir = baseDir();
  const activeName = path.substring(path.lastIndexOf("/") + 1);
  let entries: (DirEntry | string)[] = [];
  try {
    entries = yield* host.io.fs.readDir(dir);
  } catch (e) {
    return null;
  }
  for (const entry of entries) {
    if (typeof entry === "string") continue;
    if (entry.name === activeName && typeof entry.size === "number") return entry.size;
  }
  return null;
}

function* modelFileLabel(): HostIoSteps<string> {
  const mp = modelPath();
  const done = modelDonePath();
  if (!(yield* host.io.fs.fileExists(mp))) return "missing (~" + modelSizeMb(modelId()) + "MB)";
  if (!(yield* host.io.fs.fileExists(done))) return "partial (~" + modelSizeMb(modelId()) + "MB)";
  const bytes = (yield* modelFileBytes(mp));
  if (bytes !== null) return "present (" + bytes + " bytes, expected ~" + modelSizeMb(modelId()) + "MB)";
  return "present (~" + modelSizeMb(modelId()) + "MB)";
}

// ── transcription (one-shot) ─────────────────────────────────────────

// Whisper hallucinates text ('you', 'й', etc.) when given near-silent audio
// because it pads input to 30 s internally and generates tokens for the full
// window. Gate on the peak level measured by ffmpeg volumedetect BEFORE calling
// whisper-cli: any real speech has a peak well above -45 dBFS; hardware noise
// and ambient silence sit at -91 dBFS or below. Using max_volume (not mean)
// so a short utterance surrounded by silence is never falsely dropped.
const SPEECH_PEAK_THRESHOLD_DB = -45;

function devNull(): string {
  return osKind() === "windows" ? "NUL" : "/dev/null";
}

function parseMaxVolumeDb(stderr: string): number | null {
  // ffmpeg volumedetect writes: "[Parsed_volumedetect_0 @ 0x...] max_volume: -9.8 dB"
  // Accept comma as decimal separator for locale robustness.
  const m = stderr.match(/max_volume:\s*(-?\d+[.,]\d+|-?\d+)\s*dB/i);
  if (!m) return null;
  return parseFloat(m[1].replace(",", "."));
}

function* hasSpeech(ffmpegBin: string, wav: string): HostIoSteps<boolean> {
  const r = (yield* runBin(ffmpegBin, ["-i", wav, "-af", "volumedetect", "-f", "null", devNull()], 10000));
  if (r.error) return true; // spawn failure → let whisper decide
  const maxDb = parseMaxVolumeDb(r.stderr || "");
  if (maxDb === null) return true; // parse failed → let whisper decide
  return maxDb > SPEECH_PEAK_THRESHOLD_DB;
}

function joinSegments(raw: string): string {
  try {
    const data = JSON.parse(raw) as { transcription?: { text?: unknown }[]; text?: unknown };
    if (Array.isArray(data.transcription)) {
      return data.transcription
        .map((s) => (typeof s.text === "string" ? s.text : ""))
        .join("")
        .trim();
    }
    if (typeof data.text === "string") return data.text.trim();
    return "";
  } catch (e) {
    return "";
  }
}

// faster-whisper daemon returns {"text": "...", "language": "..."} or {"error": "..."}.
function parseRemote(raw: string): { text: string } | { error: string } {
  let data: { text?: unknown; error?: unknown };
  try {
    data = JSON.parse(raw) as { text?: unknown; error?: unknown };
  } catch (e) {
    return { error: "unparseable daemon response: " + (raw ? raw.substring(0, 200) : "empty body") };
  }
  if (typeof data.error === "string" && data.error.length) return { error: data.error };
  if (typeof data.text !== "string") return { error: "daemon response missing `text`: " + raw.substring(0, 200) };
  const text = data.text.trim();
  if (!text.length) return { error: "daemon returned an empty transcript (no speech detected or upload rejected)" };
  return { text };
}

// Remote mode: multipart-upload the raw audio to the GPU daemon; no local deps/model.
function* transcribeRemote(ep: string, path: string, lang?: string): HostIoSteps<TranscribeResult> {
  const l = lang && lang.length ? lang : language();
  const args = ["-sS", "-m", "600", "-F", "file=@" + path];
  // The daemon rejects "auto"; omit the field so faster-whisper auto-detects.
  if (l && l.length && l !== "auto") args.push("-F", "language=" + l);
  args.push(ep);
  (yield* progress({ label: "Transcribing on remote…" }));
  const r = (yield* exec({ bin: "curl", args, timeoutMs: 660000 }));
  if (!exitedOk(r)) {
    return (yield* errorResult(
      "remote transcription failed (" + ep + "): " + (r.stderr || r.error || "curl exit " + r.code),
    ));
  }
  const parsed = parseRemote(r.stdout || "");
  if ("error" in parsed) return (yield* errorResult("remote transcription failed (" + ep + "): " + parsed.error));
  (yield* progress({ label: "Done", done: true }));
  return { text: parsed.text };
}

// path: absolute audio file. lang: BCP-47 hint ("" / undefined → settings / auto).
function* ensureLocal(force = false): HostIoSteps<{ ffmpeg: { bin: string }; engine: { bin: string } } | { error: string }> {
  if (!(yield* host.io.fs.makeDirs(baseDir()))) return { error: "The transcriber data directory is unavailable." };
  const lock = yield* host.io.fs.lockFile(baseDir() + "/install.lock");
  if (!lock) return { error: "Transcriber installation is busy; retry after it completes." };
  try {
    const ffmpeg = yield* ensureFfmpeg();
    if ("error" in ffmpeg) return ffmpeg;
    const engine = yield* ensureEngine();
    if ("error" in engine) return engine;
    const model = yield* ensureModel(force);
    if ("error" in model) return model;
    return { ffmpeg, engine };
  } finally { yield* host.io.fs.unlockFile(lock); }
}

function* transcribe(path: string, lang?: string): HostIoSteps<TranscribeResult> {
  const ep = endpoint();
  // Remote mode skips the local ffmpeg silence gate by design (no local deps);
  // the GPU daemon owns its own no-speech handling.
  if (ep.length) return (yield* transcribeRemote(ep, path, lang));
  const installed = yield* ensureLocal();
  if ("error" in installed) return (yield* errorResult(installed.error));
  const { ffmpeg, engine } = installed;

  (yield* host.io.fs.makeDirs(tmpDir()));
  const base = tmpDir() + "/job-" + host.unixNowMs() + "-" + Math.random().toString(16).slice(2);
  const wav = base + ".wav";
  const json = base + ".json";

  const conv = (yield* runBin(ffmpeg.bin, ["-y", "-i", path, "-ar", "16000", "-ac", "1", "-f", "wav", wav], 120000));
  if (!exitedOk(conv)) {
    (yield* host.io.fs.removeFile(wav));
    return (yield* errorResult("ffmpeg could not decode the audio: " + (conv.stderr || conv.error || "exit " + conv.code)));
  }

  // Gate: near-silent audio produces hallucinated tokens from Whisper.
  // Return empty rather than a stray 'you' or 'й'.
  if (!(yield* hasSpeech(ffmpeg.bin, wav))) {
    (yield* host.io.fs.removeFile(wav));
    return { text: "" };
  }

  const l = lang && lang.length ? lang : language();
  (yield* progress({ label: "Transcribing…" }));
  const tr = (yield* runBin(engine.bin, ["-m", modelPath(), "-f", wav, "-l", l, "-nt", "-oj", "-of", base], 600000));
  if (!exitedOk(tr)) {
    (yield* host.io.fs.removeFile(wav));
    (yield* host.io.fs.removeFile(json));
    return (yield* errorResult("whisper-cli failed: " + (tr.stderr || tr.error || "exit " + tr.code)));
  }

  const raw = (yield* host.io.fs.readFile(json));
  (yield* host.io.fs.removeFile(wav));
  (yield* host.io.fs.removeFile(json));
  if (!raw) return (yield* errorResult("whisper-cli produced no transcript output"));
  (yield* progress({ label: "Done", done: true }));
  return { text: joinSegments(raw) };
}

function* present(name: string): HostIoSteps<boolean> {
  if (ranOk((yield* exec({ bin: name, args: name === "ffmpeg" ? ["-version"] : ["--help"] })))) return true;
  return (yield* findLocalBin(name)) !== null;
}

function* transcribeStatus(): HostIoSteps<StatusResult> {
  const ep = endpoint();
  if (ep.length) return { state: "ready", reason: "remote: " + ep };
  const hasFfmpeg = (yield* present("ffmpeg"));
  const hasEngine = (yield* present("whisper-cli"));
  const hasModel = (yield* host.io.fs.fileExists(modelPath())) && (yield* host.io.fs.fileExists(modelDonePath()));
  if (hasFfmpeg && hasEngine && hasModel) return { state: "ready" };

  const missing: string[] = [];
  if (!hasEngine) missing.push("whisper-cli");
  if (!hasFfmpeg) missing.push("ffmpeg");
  if (!hasModel) missing.push("model ggml-" + modelId() + ".bin");
  return { state: "unloaded", reason: "needs: " + missing.join(", ") + " (installed on first use)" };
}

// ── glance (status + a manual pre-warm button) ───────────────────────

function* renderGlance(): HostIoSteps<GlanceView> {
  const ep = endpoint();
  if (ep.length) {
    const nodes: ViewNode[] = [
      { kind: "badge", label: "Remote", tone: "ok" },
      { kind: "keyVal", key: "Endpoint", value: ep },
      { kind: "keyVal", key: "Language", value: language() },
      { kind: "note", body: "GPU offload — local whisper.cpp/model are not used." },
      { kind: "divider" },
      { kind: "button", label: "Settings", action: "settings" },
    ];
    return { title: "Transcriber", nodes };
  }
  const st = (yield* transcribeStatus());
  const ready = st.state === "ready";
  const hasModel = (yield* host.io.fs.fileExists(modelPath())) && (yield* host.io.fs.fileExists(modelDonePath()));
  const badge =
    st.state === "unavailable" ? "Unavailable" : ready ? "Ready" : hasModel ? "Idle" : "Not installed";
  const nodes: ViewNode[] = [];
  nodes.push({
    kind: "badge",
    label: badge,
    tone: ready ? "ok" : st.state === "unavailable" ? "danger" : "warn",
  });
  nodes.push({ kind: "keyVal", key: "Model", value: "ggml-" + modelId() });
  nodes.push({ kind: "keyVal", key: "Model file", value: (yield* modelFileLabel()) });
  nodes.push({ kind: "keyVal", key: "Language", value: language() });
  if (st.reason) nodes.push({ kind: "note", body: st.reason });
  nodes.push({ kind: "divider" });
  if (!hasModel) nodes.push({ kind: "button", label: "Install", action: "install" });
  nodes.push({ kind: "button", label: "Reinstall", action: "reinstall" });
  nodes.push({ kind: "button", label: "Settings", action: "settings" });
  return { title: "Transcriber", nodes };
}

function* glanceAction(action: string): HostIoSteps<GlanceView> {
  if (action === "install" || action === "reinstall") {
    yield* ensureLocal(action === "reinstall");
  }
  return (yield* renderGlance());
}

const plugin = defineProviderIo({
  transcribe,
  transcribeStatus,
  renderGlance,
  glanceAction,
}, () => host.io) satisfies PluginModule;

export default defineProviderIo(plugin, () => host.io);
