// Transcriber plugin — CodeTerm's speech-to-text backend (capability: transcriber).
// Authored in TypeScript against @codeterm/plugin-sdk and compiled to a
// QuickJS-compatible plugin.js by scripts/build-plugin.mjs.
//
// One-shot engine: there is no daemon and no HTTP. CodeTerm hands us an audio file
// path; we convert it to a 16 kHz mono WAV with ffmpeg, run whisper.cpp's
// `whisper-cli` once (`-oj` → JSON sidecar), read the JSON, join the segments, and
// clean up. host.fetch is text-only (can neither download a model nor upload audio),
// so every dependency is bootstrapped lazily through host.exec + curl instead:
//
//   • macOS   — `brew install whisper-cpp` (gives `whisper-cli`) and `brew install ffmpeg`.
//   • Windows — `curl` the whisper-bin-x64.zip GitHub release + a static ffmpeg zip,
//               extract with `tar` into ~/.codeterm/transcriber/bin.
//   • Linux   — `curl` the whisper-bin-ubuntu tarball + a static ffmpeg build, extract
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
const WHISPER_RELEASE = "v1.7.4";
const WHISPER_BASE =
  "https://github.com/ggerganov/whisper.cpp/releases/download/" + WHISPER_RELEASE;
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
  const home = host.homeDir() || ".";
  return home + "/.codeterm/transcriber";
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

function cleanupOrphanModels(activeModel: string): void {
  const dir = baseDir();
  const h = host as typeof host & { readDir?: (path: string) => DirEntry[] };
  let entries: (DirEntry | string)[] = [];
  try {
    entries = h.readDir ? h.readDir(dir) : host.fs.readDir(dir);
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
    host.removeFile(path);
    host.removeFile(path + ".done");
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

function exec(opts: ExecOpts): ExecResult {
  const raw = host.exec(JSON.stringify(opts));
  try {
    return JSON.parse(raw) as ExecResult;
  } catch (e) {
    return { error: String(e) };
  }
}

function ranOk(r: ExecResult): boolean {
  // "ran at all" — a missing binary surfaces as a spawn `error`; --help/--version
  // may exit non-zero, but the absence of `error` means the binary exists.
  return !r.error;
}

function exitedOk(r: ExecResult): boolean {
  return !r.error && (r.code === undefined || r.code === 0);
}

function progress(opts: ProgressOptions): void {
  const h = host as typeof host & { progress?: (opts: ProgressOptions) => void };
  if (typeof h.progress === "function") h.progress(opts);
}

function errorResult(message: string): TranscribeResult {
  progress({ label: "Error", error: message });
  return { error: message };
}

// ── dependency bootstrap (detect-then-install) ───────────────────────

// A binary is "present" if it runs from PATH, or if we already dropped it in binDir.
function localBin(name: string): string {
  return binDir() + "/" + name + exeSuffix();
}

function download(url: string, dest: string): Ensured {
  host.makeDirs(dirOf(dest));
  const r = exec({ bin: "curl", args: ["-fsSL", "-o", dest, url], timeoutMs: 1800000 });
  if (!exitedOk(r)) {
    return { error: "download failed (" + url + "): " + (r.stderr || r.error || "curl exit " + r.code) };
  }
  return { ok: true };
}

function untar(archive: string, dest: string): Ensured {
  host.makeDirs(dest);
  // bsdtar (`tar`) ships on macOS, modern Windows, and Linux; it reads .zip, .tar.gz, .tar.xz.
  const r = exec({ bin: "tar", args: ["-xf", archive, "-C", dest], timeoutMs: 600000 });
  if (!exitedOk(r)) {
    return { error: "extract failed (" + archive + "): " + (r.stderr || r.error || "tar exit " + r.code) };
  }
  return { ok: true };
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.substring(0, i) : ".";
}

function ensureFfmpeg(): Resolved {
  if (ranOk(exec({ bin: "ffmpeg", args: ["-version"] }))) return { bin: "ffmpeg" };
  const local = localBin("ffmpeg");
  if (host.fileExists(local)) return { bin: local };

  const os = osKind();
  if (os === "macos") {
    progress({ label: "Installing ffmpeg…" });
    const r = exec({ bin: "brew", args: ["install", "ffmpeg"], timeoutMs: 1800000 });
    if (exitedOk(r) && ranOk(exec({ bin: "ffmpeg", args: ["-version"] }))) return { bin: "ffmpeg" };
    return { error: "ffmpeg is required. Install it with `brew install ffmpeg`." };
  }
  if (os === "windows") {
    progress({ label: "Installing ffmpeg…" });
    const zip = baseDir() + "/ffmpeg.zip";
    const dl = download(FFMPEG_WIN_ZIP, zip);
    if ("error" in dl) return ffmpegManual(dl.error);
    const ex = untar(zip, binDir());
    if ("error" in ex) return ffmpegManual(ex.error);
    host.removeFile(zip);
    if (host.fileExists(local)) return { bin: local };
    return ffmpegManual("ffmpeg binary not found after extraction");
  }
  // linux
  progress({ label: "Installing ffmpeg…" });
  const tar = baseDir() + "/ffmpeg.tar.xz";
  const dl = download(FFMPEG_LINUX_TAR, tar);
  if ("error" in dl) return ffmpegManual(dl.error);
  const ex = untar(tar, binDir());
  if ("error" in ex) return ffmpegManual(ex.error);
  host.removeFile(tar);
  if (host.fileExists(local)) return { bin: local };
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

function ensureEngine(): Resolved {
  if (ranOk(exec({ bin: "whisper-cli", args: ["--help"] }))) return { bin: "whisper-cli" };
  const local = localBin("whisper-cli");
  if (host.fileExists(local)) return { bin: local };

  const os = osKind();
  if (os === "macos") {
    progress({ label: "Installing whisper.cpp…" });
    const r = exec({ bin: "brew", args: ["install", "whisper-cpp"], timeoutMs: 1800000 });
    if (exitedOk(r) && ranOk(exec({ bin: "whisper-cli", args: ["--help"] }))) return { bin: "whisper-cli" };
    return { error: "whisper-cli is required. Install it with `brew install whisper-cpp`." };
  }
  // Windows + Linux: prebuilt archives from the whisper.cpp GitHub release.
  progress({ label: "Installing whisper.cpp…" });
  const asset = os === "windows" ? "whisper-bin-x64.zip" : "whisper-bin-Linux.zip";
  const archive = baseDir() + "/whisper.zip";
  const dl = download(WHISPER_BASE + "/" + asset, archive);
  if ("error" in dl) return engineManual(os, dl.error);
  const ex = untar(archive, binDir());
  if ("error" in ex) return engineManual(os, ex.error);
  host.removeFile(archive);
  if (host.fileExists(local)) return { bin: local };
  // Some archives nest the binary under Release/; fall back to a discovered path.
  const nested = binDir() + "/Release/whisper-cli" + exeSuffix();
  if (host.fileExists(nested)) return { bin: nested };
  return engineManual(os, "whisper-cli not found after extraction");
}

function engineManual(os: string, why: string): Resolved {
  return {
    error:
      "whisper-cli (whisper.cpp) is required but could not be installed automatically on " +
      os +
      " (" +
      why +
      "). Build/download whisper.cpp from https://github.com/ggerganov/whisper.cpp/releases and place `whisper-cli" +
      exeSuffix() +
      "` in " +
      binDir() +
      ".",
  };
}

function ensureModel(force = false): Ensured {
  const mp = modelPath();
  const done = modelDonePath();
  // Only trust a model whose download fully completed. The .done sentinel is
  // written after curl exits 0; a killed/interrupted download leaves a partial
  // mp WITHOUT the sentinel, which we detect, discard, and re-download. Without
  // this, an interrupted download poisons mp permanently — every later transcribe
  // feeds whisper-cli a truncated model and hangs.
  if (!force && host.fileExists(mp) && host.fileExists(done)) {
    cleanupOrphanModels(mp);
    return { ok: true };
  }
  host.removeFile(mp);
  host.removeFile(done);
  host.makeDirs(baseDir());
  const url =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-" + modelId() + ".bin";
  progress({ label: "Downloading model ggml-" + modelId() + " (~" + modelSizeMb(modelId()) + "MB)…" });
  const dl = download(url, mp);
  if ("error" in dl) {
    host.removeFile(mp);
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
  host.writeFile(done, "");
  cleanupOrphanModels(mp);
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

function modelFileBytes(path: string): number | null {
  const dir = baseDir();
  const activeName = path.substring(path.lastIndexOf("/") + 1);
  const h = host as typeof host & { readDir?: (path: string) => DirEntry[] };
  let entries: (DirEntry | string)[] = [];
  try {
    entries = h.readDir ? h.readDir(dir) : host.fs.readDir(dir);
  } catch (e) {
    return null;
  }
  for (const entry of entries) {
    if (typeof entry === "string") continue;
    if (entry.name === activeName && typeof entry.size === "number") return entry.size;
  }
  return null;
}

function modelFileLabel(): string {
  const mp = modelPath();
  const done = modelDonePath();
  if (!host.fileExists(mp)) return "missing (~" + modelSizeMb(modelId()) + "MB)";
  if (!host.fileExists(done)) return "partial (~" + modelSizeMb(modelId()) + "MB)";
  const bytes = modelFileBytes(mp);
  if (bytes !== null) return "present (" + bytes + " bytes, expected ~" + modelSizeMb(modelId()) + "MB)";
  return "present (~" + modelSizeMb(modelId()) + "MB)";
}

// ── transcription (one-shot) ─────────────────────────────────────────

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
function transcribeRemote(ep: string, path: string, lang?: string): TranscribeResult {
  const l = lang && lang.length ? lang : language();
  const args = ["-sS", "-m", "600", "-F", "file=@" + path];
  // The daemon rejects "auto"; omit the field so faster-whisper auto-detects.
  if (l && l.length && l !== "auto") args.push("-F", "language=" + l);
  args.push(ep);
  progress({ label: "Transcribing on remote…" });
  const r = exec({ bin: "curl", args, timeoutMs: 660000 });
  if (!exitedOk(r)) {
    return errorResult(
      "remote transcription failed (" + ep + "): " + (r.stderr || r.error || "curl exit " + r.code),
    );
  }
  const parsed = parseRemote(r.stdout || "");
  if ("error" in parsed) return errorResult("remote transcription failed (" + ep + "): " + parsed.error);
  progress({ label: "Done", done: true });
  return { text: parsed.text };
}

// path: absolute audio file. lang: BCP-47 hint ("" / undefined → settings / auto).
function transcribe(path: string, lang?: string): TranscribeResult {
  const ep = endpoint();
  if (ep.length) return transcribeRemote(ep, path, lang);
  const ffmpeg = ensureFfmpeg();
  if ("error" in ffmpeg) return errorResult(ffmpeg.error);
  const engine = ensureEngine();
  if ("error" in engine) return errorResult(engine.error);
  const model = ensureModel();
  if ("error" in model) return errorResult(model.error);

  host.makeDirs(tmpDir());
  const base = tmpDir() + "/job-" + host.unixNowMs();
  const wav = base + ".wav";
  const json = base + ".json";

  const conv = exec({
    bin: ffmpeg.bin,
    args: ["-y", "-i", path, "-ar", "16000", "-ac", "1", "-f", "wav", wav],
    timeoutMs: 120000,
  });
  if (!exitedOk(conv)) {
    host.removeFile(wav);
    return errorResult("ffmpeg could not decode the audio: " + (conv.stderr || conv.error || "exit " + conv.code));
  }

  const l = lang && lang.length ? lang : language();
  progress({ label: "Transcribing…" });
  const tr = exec({
    bin: engine.bin,
    args: ["-m", modelPath(), "-f", wav, "-l", l, "-nt", "-oj", "-of", base],
    timeoutMs: 600000,
  });
  if (!exitedOk(tr)) {
    host.removeFile(wav);
    host.removeFile(json);
    return errorResult("whisper-cli failed: " + (tr.stderr || tr.error || "exit " + tr.code));
  }

  const raw = host.readFile(json);
  host.removeFile(wav);
  host.removeFile(json);
  if (!raw) return errorResult("whisper-cli produced no transcript output");
  progress({ label: "Done", done: true });
  return { text: joinSegments(raw) };
}

function present(name: string): boolean {
  if (ranOk(exec({ bin: name, args: name === "ffmpeg" ? ["-version"] : ["--help"] }))) return true;
  return host.fileExists(localBin(name));
}

function transcribeStatus(): StatusResult {
  const ep = endpoint();
  if (ep.length) return { state: "ready", reason: "remote: " + ep };
  if (!host.homeDir()) return { state: "unavailable", reason: "no home directory" };
  const hasFfmpeg = present("ffmpeg");
  const hasEngine = present("whisper-cli");
  const hasModel = host.fileExists(modelPath()) && host.fileExists(modelDonePath());
  if (hasFfmpeg && hasEngine && hasModel) return { state: "ready" };

  const missing: string[] = [];
  if (!hasEngine) missing.push("whisper-cli");
  if (!hasFfmpeg) missing.push("ffmpeg");
  if (!hasModel) missing.push("model ggml-" + modelId() + ".bin");
  return { state: "unloaded", reason: "needs: " + missing.join(", ") + " (installed on first use)" };
}

// ── glance (status + a manual pre-warm button) ───────────────────────

function renderGlance(): GlanceView {
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
  const st = transcribeStatus();
  const ready = st.state === "ready";
  const hasModel = host.fileExists(modelPath()) && host.fileExists(modelDonePath());
  const badge =
    st.state === "unavailable" ? "Unavailable" : ready ? "Ready" : hasModel ? "Idle" : "Not installed";
  const nodes: ViewNode[] = [];
  nodes.push({
    kind: "badge",
    label: badge,
    tone: ready ? "ok" : st.state === "unavailable" ? "danger" : "warn",
  });
  nodes.push({ kind: "keyVal", key: "Model", value: "ggml-" + modelId() });
  nodes.push({ kind: "keyVal", key: "Model file", value: modelFileLabel() });
  nodes.push({ kind: "keyVal", key: "Language", value: language() });
  if (st.reason) nodes.push({ kind: "note", body: st.reason });
  nodes.push({ kind: "divider" });
  if (!hasModel) nodes.push({ kind: "button", label: "Install", action: "install" });
  nodes.push({ kind: "button", label: "Reinstall", action: "reinstall" });
  nodes.push({ kind: "button", label: "Settings", action: "settings" });
  return { title: "Transcriber", nodes };
}

function glanceAction(action: string): GlanceView {
  if (action === "install" || action === "reinstall") {
    const ffmpeg = ensureFfmpeg();
    if (!("error" in ffmpeg)) {
      const engine = ensureEngine();
      if (!("error" in engine)) ensureModel(action === "reinstall");
    }
  }
  return renderGlance();
}

const plugin: PluginModule = {
  transcribe,
  transcribeStatus,
  renderGlance,
  glanceAction,
};

export default plugin;
