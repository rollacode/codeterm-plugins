"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// transcriber/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);

// ../../codeterm/codeterm/packages/plugin-sdk/src/ioPrograms.ts
function defineProviderIo(source, io) {
  const exports = { ...source };
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (typeof value !== "function") continue;
    exports[key] = function(...args) {
      const result = value.apply(source, args);
      return result && typeof result.next === "function" ? io().run(result) : result;
    };
  }
  return exports;
}

// transcriber/src/plugin.ts
var WHISPER_RELEASE = "v1.9.1";
var WHISPER_BASE = "https://github.com/ggml-org/whisper.cpp/releases/download/" + WHISPER_RELEASE;
var FFMPEG_WIN_ZIP = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
var FFMPEG_LINUX_TAR = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz";
function settings() {
  try {
    return JSON.parse(host.settingsJson()) || {};
  } catch (e) {
    return {};
  }
}
function modelId() {
  const s = settings();
  return s.model && s.model.length ? s.model : "small";
}
function language() {
  const s = settings();
  if (s.language && s.language.length) return s.language;
  const env = host.envGet("CODETERM_TRANSCRIBE_LANG");
  return env && env.length ? env : "auto";
}
function endpoint() {
  const s = settings();
  const ep = s.endpoint && s.endpoint.length ? s.endpoint : host.envGet("CODETERM_TRANSCRIBE_ENDPOINT");
  return ep && ep.length ? ep.trim() : "";
}
function baseDir() {
  return host.dataDir() + "/transcriber";
}
function binDir() {
  return baseDir() + "/bin";
}
function tmpDir() {
  return baseDir() + "/tmp";
}
function modelPath() {
  return baseDir() + "/ggml-" + modelId() + ".bin";
}
function modelDonePath() {
  return modelPath() + ".done";
}
function entryName(entry) {
  return typeof entry === "string" ? entry : entry.name;
}
function* cleanupOrphanModels(activeModel) {
  const dir = baseDir();
  const h = host;
  let entries = [];
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
    yield* host.io.fs.removeFile(path);
    yield* host.io.fs.removeFile(path + ".done");
  }
}
function osKind() {
  const p = String(host.platform() || "").toLowerCase();
  if (p.indexOf("win") !== -1) return "windows";
  if (p.indexOf("mac") !== -1 || p.indexOf("darwin") !== -1 || p.indexOf("osx") !== -1)
    return "macos";
  return "linux";
}
function exeSuffix() {
  return osKind() === "windows" ? ".exe" : "";
}
function* exec(opts) {
  const raw = JSON.stringify(yield* host.io.exec(opts));
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { error: String(e) };
  }
}
function* runBin(bin, args, timeoutMs) {
  return yield* exec({ bin, args, timeoutMs });
}
function ranOk(r) {
  return !r.error;
}
function exitedOk(r) {
  return !r.error && (r.code === void 0 || r.code === 0);
}
function progress(opts) {
  const h = host;
  if (typeof h.progress === "function") h.progress(opts);
}
function errorResult(message) {
  progress({ label: "Error", error: message });
  return { error: message };
}
function* findLocalBin(name) {
  const root = binDir();
  const suffix = exeSuffix();
  const direct = root + "/" + name + suffix;
  if (yield* host.io.fs.fileExists(direct)) return direct;
  const fixedCandidates = [
    root + "/bin/" + name + suffix,
    root + "/Release/" + name + suffix
  ];
  for (const c of fixedCandidates) {
    if (yield* host.io.fs.fileExists(c)) return c;
  }
  const h = host;
  let entries = [];
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
      base + "/Release/" + name + suffix
    ];
    for (const c of candidates) {
      if (yield* host.io.fs.fileExists(c)) return c;
    }
  }
  return null;
}
function* download(url, dest) {
  yield* host.io.fs.makeDirs(dirOf(dest));
  yield* host.io.fs.removeFile(dest);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = yield* exec({ bin: "curl", args: ["-fL", "--retry", "2", "--retry-delay", "2", "-o", dest, url], timeoutMs: 18e5 });
    if (exitedOk(r)) return { ok: true };
    yield* host.io.fs.removeFile(dest);
    if (attempt === 2 && osKind() === "windows") {
      const ps = yield* downloadWithPowerShell(url, dest);
      if ("error" in ps) {
        return {
          error: "download failed (" + url + "): curl: " + (r.stderr || r.error || "exit " + r.code) + "; powershell: " + ps.error
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
function* downloadWithPowerShell(url, dest) {
  const script = "$ProgressPreference='SilentlyContinue';Invoke-WebRequest -Uri " + psQuote(url) + " -OutFile " + psQuote(dest) + " -UseBasicParsing";
  const r = yield* exec({
    bin: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    timeoutMs: 18e5
  });
  if (!exitedOk(r) || !(yield* host.io.fs.fileExists(dest))) {
    return { error: r.stderr || r.error || "powershell exit " + r.code };
  }
  return { ok: true };
}
function psQuote(value) {
  return "'" + value.replace(/'/g, "''") + "'";
}
function* untar(archive, dest) {
  yield* host.io.fs.makeDirs(dest);
  const r = yield* exec({ bin: "tar", args: ["-xf", archive, "-C", dest], timeoutMs: 6e5 });
  if (!exitedOk(r)) {
    return { error: "extract failed (" + archive + "): " + (r.stderr || r.error || "tar exit " + r.code) };
  }
  return { ok: true };
}
function dirOf(p) {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.substring(0, i) : ".";
}
function* brewPrefixes() {
  const out = [];
  for (const brew of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "brew"]) {
    const r = yield* exec({ bin: brew, args: ["--prefix"], timeoutMs: 15e3 });
    const prefix = ranOk(r) ? String(r.stdout || "").trim() : "";
    if (prefix) {
      out.push(prefix + "/bin");
      break;
    }
  }
  return out;
}
function* unixBinCandidates(name) {
  const home = host.homeDir && host.homeDir() || "";
  const dirs = (yield* brewPrefixes()).concat([
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    home ? home.replace(/\/+$/, "") + "/.local/bin" : ""
  ]);
  const seen = {};
  const out = [];
  for (const dir of dirs) {
    if (!dir || seen[dir]) continue;
    seen[dir] = true;
    out.push(dir + "/" + name);
  }
  return out;
}
function* resolveUnixBin(name) {
  const local = yield* findLocalBin(name);
  if (local) return local;
  const candidates = yield* unixBinCandidates(name);
  for (const candidate of candidates) {
    if (yield* host.io.fs.fileExists(candidate)) return candidate;
  }
  return null;
}
function* lookedIn(name) {
  return (yield* unixBinCandidates(name)).concat([binDir() + "/" + name]).join(", ");
}
function* ensureFfmpeg() {
  if (ranOk(yield* exec({ bin: "ffmpeg", args: ["-version"] }))) return { bin: "ffmpeg" };
  const local = yield* findLocalBin("ffmpeg");
  if (local) return { bin: local };
  const os = osKind();
  if (os === "macos") {
    const found = yield* resolveUnixBin("ffmpeg");
    if (found) return { bin: found };
    progress({ label: "Installing ffmpeg\u2026" });
    const r = yield* exec({ bin: "brew", args: ["install", "ffmpeg"], timeoutMs: 18e5 });
    if (exitedOk(r)) {
      const installed2 = yield* resolveUnixBin("ffmpeg");
      if (installed2) return { bin: installed2 };
      if (ranOk(yield* exec({ bin: "ffmpeg", args: ["-version"] }))) return { bin: "ffmpeg" };
    }
    return { error: "ffmpeg is required. Install it with `brew install ffmpeg`. Looked in: " + (yield* lookedIn("ffmpeg")) };
  }
  if (os === "windows") {
    progress({ label: "Installing ffmpeg\u2026" });
    const zip = baseDir() + "/ffmpeg.zip";
    const dl2 = yield* download(FFMPEG_WIN_ZIP, zip);
    if ("error" in dl2) return ffmpegManual(dl2.error);
    const ex2 = yield* untar(zip, binDir());
    if ("error" in ex2) return ffmpegManual(ex2.error);
    yield* host.io.fs.removeFile(zip);
    const installed2 = yield* findLocalBin("ffmpeg");
    if (installed2) return { bin: installed2 };
    return ffmpegManual("ffmpeg binary not found after extraction");
  }
  progress({ label: "Installing ffmpeg\u2026" });
  const tar = baseDir() + "/ffmpeg.tar.xz";
  const dl = yield* download(FFMPEG_LINUX_TAR, tar);
  if ("error" in dl) return ffmpegManual(dl.error);
  const ex = yield* untar(tar, binDir());
  if ("error" in ex) return ffmpegManual(ex.error);
  yield* host.io.fs.removeFile(tar);
  const installed = yield* findLocalBin("ffmpeg");
  if (installed) return { bin: installed };
  return ffmpegManual("ffmpeg binary not found after extraction");
}
function ffmpegManual(why) {
  return {
    error: "ffmpeg is required to decode the audio but could not be installed automatically (" + why + "). Install ffmpeg from your package manager (e.g. `apt install ffmpeg`) or https://ffmpeg.org/download.html."
  };
}
function* ensureEngine() {
  if (ranOk(yield* exec({ bin: "whisper-cli", args: ["--help"] }))) return { bin: "whisper-cli" };
  const local = yield* findLocalBin("whisper-cli");
  if (local) return { bin: local };
  const os = osKind();
  if (os === "macos") {
    const found = yield* resolveUnixBin("whisper-cli");
    if (found) return { bin: found };
    progress({ label: "Installing whisper.cpp\u2026" });
    const r = yield* exec({ bin: "brew", args: ["install", "whisper-cpp"], timeoutMs: 18e5 });
    if (exitedOk(r)) {
      const installed2 = yield* resolveUnixBin("whisper-cli");
      if (installed2) return { bin: installed2 };
      if (ranOk(yield* exec({ bin: "whisper-cli", args: ["--help"] }))) return { bin: "whisper-cli" };
    }
    return { error: "whisper-cli is required. Install it with `brew install whisper-cpp`. Looked in: " + (yield* lookedIn("whisper-cli")) };
  }
  progress({ label: "Installing whisper.cpp\u2026" });
  const asset = os === "windows" ? "whisper-bin-x64.zip" : "whisper-bin-Linux.zip";
  const archive = baseDir() + "/whisper.zip";
  const dl = yield* download(WHISPER_BASE + "/" + asset, archive);
  if ("error" in dl) return engineManual(os, dl.error);
  const ex = yield* untar(archive, binDir());
  if ("error" in ex) return engineManual(os, ex.error);
  yield* host.io.fs.removeFile(archive);
  const installed = yield* findLocalBin("whisper-cli");
  if (installed) return { bin: installed };
  return engineManual(os, "whisper-cli not found after extraction");
}
function engineManual(os, why) {
  return {
    error: "whisper-cli (whisper.cpp) is required but could not be installed automatically on " + os + " (" + why + "). Build/download whisper.cpp from https://github.com/ggml-org/whisper.cpp/releases and place `whisper-cli" + exeSuffix() + "` in " + binDir() + "."
  };
}
function* ensureModel(force = false) {
  const mp = modelPath();
  const done = modelDonePath();
  if (!force && (yield* host.io.fs.fileExists(mp)) && (yield* host.io.fs.fileExists(done))) {
    yield* cleanupOrphanModels(mp);
    return { ok: true };
  }
  yield* host.io.fs.removeFile(mp);
  yield* host.io.fs.removeFile(done);
  yield* host.io.fs.makeDirs(baseDir());
  const url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-" + modelId() + ".bin";
  progress({ label: "Downloading model ggml-" + modelId() + " (~" + modelSizeMb(modelId()) + "MB)\u2026" });
  const dl = yield* download(url, mp);
  if ("error" in dl) {
    yield* host.io.fs.removeFile(mp);
    return {
      error: "could not download the whisper model `ggml-" + modelId() + ".bin`: " + dl.error + ". Download it manually to " + mp + "."
    };
  }
  yield* host.io.fs.writeFile(done, "");
  yield* cleanupOrphanModels(mp);
  return { ok: true };
}
function modelSizeMb(id) {
  const sizes = {
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
    "large-v3-turbo": 1600
  };
  return sizes[id] || 466;
}
function* modelFileBytes(path) {
  const dir = baseDir();
  const activeName = path.substring(path.lastIndexOf("/") + 1);
  const h = host;
  let entries = [];
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
function* modelFileLabel() {
  const mp = modelPath();
  const done = modelDonePath();
  if (!(yield* host.io.fs.fileExists(mp))) return "missing (~" + modelSizeMb(modelId()) + "MB)";
  if (!(yield* host.io.fs.fileExists(done))) return "partial (~" + modelSizeMb(modelId()) + "MB)";
  const bytes = yield* modelFileBytes(mp);
  if (bytes !== null) return "present (" + bytes + " bytes, expected ~" + modelSizeMb(modelId()) + "MB)";
  return "present (~" + modelSizeMb(modelId()) + "MB)";
}
var SPEECH_PEAK_THRESHOLD_DB = -45;
function devNull() {
  return osKind() === "windows" ? "NUL" : "/dev/null";
}
function parseMaxVolumeDb(stderr) {
  const m = stderr.match(/max_volume:\s*(-?\d+[.,]\d+|-?\d+)\s*dB/i);
  if (!m) return null;
  return parseFloat(m[1].replace(",", "."));
}
function* hasSpeech(ffmpegBin, wav) {
  const r = yield* runBin(ffmpegBin, ["-i", wav, "-af", "volumedetect", "-f", "null", devNull()], 1e4);
  if (r.error) return true;
  const maxDb = parseMaxVolumeDb(r.stderr || "");
  if (maxDb === null) return true;
  return maxDb > SPEECH_PEAK_THRESHOLD_DB;
}
function joinSegments(raw) {
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data.transcription)) {
      return data.transcription.map((s) => typeof s.text === "string" ? s.text : "").join("").trim();
    }
    if (typeof data.text === "string") return data.text.trim();
    return "";
  } catch (e) {
    return "";
  }
}
function parseRemote(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { error: "unparseable daemon response: " + (raw ? raw.substring(0, 200) : "empty body") };
  }
  if (typeof data.error === "string" && data.error.length) return { error: data.error };
  if (typeof data.text !== "string") return { error: "daemon response missing `text`: " + raw.substring(0, 200) };
  const text = data.text.trim();
  if (!text.length) return { error: "daemon returned an empty transcript (no speech detected or upload rejected)" };
  return { text };
}
function* transcribeRemote(ep, path, lang) {
  const l = lang && lang.length ? lang : language();
  const args = ["-sS", "-m", "600", "-F", "file=@" + path];
  if (l && l.length && l !== "auto") args.push("-F", "language=" + l);
  args.push(ep);
  progress({ label: "Transcribing on remote\u2026" });
  const r = yield* exec({ bin: "curl", args, timeoutMs: 66e4 });
  if (!exitedOk(r)) {
    return errorResult(
      "remote transcription failed (" + ep + "): " + (r.stderr || r.error || "curl exit " + r.code)
    );
  }
  const parsed = parseRemote(r.stdout || "");
  if ("error" in parsed) return errorResult("remote transcription failed (" + ep + "): " + parsed.error);
  progress({ label: "Done", done: true });
  return { text: parsed.text };
}
function* ensureLocal(force = false) {
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
  } finally {
    yield* host.io.fs.unlockFile(lock);
  }
}
function* transcribe(path, lang) {
  const ep = endpoint();
  if (ep.length) return yield* transcribeRemote(ep, path, lang);
  const installed = yield* ensureLocal();
  if ("error" in installed) return errorResult(installed.error);
  const { ffmpeg, engine } = installed;
  yield* host.io.fs.makeDirs(tmpDir());
  const base = tmpDir() + "/job-" + host.unixNowMs() + "-" + Math.random().toString(16).slice(2);
  const wav = base + ".wav";
  const json = base + ".json";
  const conv = yield* runBin(ffmpeg.bin, ["-y", "-i", path, "-ar", "16000", "-ac", "1", "-f", "wav", wav], 12e4);
  if (!exitedOk(conv)) {
    yield* host.io.fs.removeFile(wav);
    return errorResult("ffmpeg could not decode the audio: " + (conv.stderr || conv.error || "exit " + conv.code));
  }
  if (!(yield* hasSpeech(ffmpeg.bin, wav))) {
    yield* host.io.fs.removeFile(wav);
    return { text: "" };
  }
  const l = lang && lang.length ? lang : language();
  progress({ label: "Transcribing\u2026" });
  const tr = yield* runBin(engine.bin, ["-m", modelPath(), "-f", wav, "-l", l, "-nt", "-oj", "-of", base], 6e5);
  if (!exitedOk(tr)) {
    yield* host.io.fs.removeFile(wav);
    yield* host.io.fs.removeFile(json);
    return errorResult("whisper-cli failed: " + (tr.stderr || tr.error || "exit " + tr.code));
  }
  const raw = yield* host.io.fs.readFile(json);
  yield* host.io.fs.removeFile(wav);
  yield* host.io.fs.removeFile(json);
  if (!raw) return errorResult("whisper-cli produced no transcript output");
  progress({ label: "Done", done: true });
  return { text: joinSegments(raw) };
}
function* present(name) {
  if (ranOk(yield* exec({ bin: name, args: name === "ffmpeg" ? ["-version"] : ["--help"] }))) return true;
  return (yield* findLocalBin(name)) !== null;
}
function* transcribeStatus() {
  const ep = endpoint();
  if (ep.length) return { state: "ready", reason: "remote: " + ep };
  const hasFfmpeg = yield* present("ffmpeg");
  const hasEngine = yield* present("whisper-cli");
  const hasModel = (yield* host.io.fs.fileExists(modelPath())) && (yield* host.io.fs.fileExists(modelDonePath()));
  if (hasFfmpeg && hasEngine && hasModel) return { state: "ready" };
  const missing = [];
  if (!hasEngine) missing.push("whisper-cli");
  if (!hasFfmpeg) missing.push("ffmpeg");
  if (!hasModel) missing.push("model ggml-" + modelId() + ".bin");
  return { state: "unloaded", reason: "needs: " + missing.join(", ") + " (installed on first use)" };
}
function* renderGlance() {
  const ep = endpoint();
  if (ep.length) {
    const nodes2 = [
      { kind: "badge", label: "Remote", tone: "ok" },
      { kind: "keyVal", key: "Endpoint", value: ep },
      { kind: "keyVal", key: "Language", value: language() },
      { kind: "note", body: "GPU offload \u2014 local whisper.cpp/model are not used." },
      { kind: "divider" },
      { kind: "button", label: "Settings", action: "settings" }
    ];
    return { title: "Transcriber", nodes: nodes2 };
  }
  const st = yield* transcribeStatus();
  const ready = st.state === "ready";
  const hasModel = (yield* host.io.fs.fileExists(modelPath())) && (yield* host.io.fs.fileExists(modelDonePath()));
  const badge = st.state === "unavailable" ? "Unavailable" : ready ? "Ready" : hasModel ? "Idle" : "Not installed";
  const nodes = [];
  nodes.push({
    kind: "badge",
    label: badge,
    tone: ready ? "ok" : st.state === "unavailable" ? "danger" : "warn"
  });
  nodes.push({ kind: "keyVal", key: "Model", value: "ggml-" + modelId() });
  nodes.push({ kind: "keyVal", key: "Model file", value: yield* modelFileLabel() });
  nodes.push({ kind: "keyVal", key: "Language", value: language() });
  if (st.reason) nodes.push({ kind: "note", body: st.reason });
  nodes.push({ kind: "divider" });
  if (!hasModel) nodes.push({ kind: "button", label: "Install", action: "install" });
  nodes.push({ kind: "button", label: "Reinstall", action: "reinstall" });
  nodes.push({ kind: "button", label: "Settings", action: "settings" });
  return { title: "Transcriber", nodes };
}
function* glanceAction(action) {
  if (action === "install" || action === "reinstall") {
    yield* ensureLocal(action === "reinstall");
  }
  return yield* renderGlance();
}
var plugin = defineProviderIo({
  transcribe,
  transcribeStatus,
  renderGlance,
  glanceAction
}, () => host.io);
var plugin_default = plugin;
