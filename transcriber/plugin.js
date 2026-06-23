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
var WHISPER_RELEASE = "v1.7.4";
var WHISPER_BASE = "https://github.com/ggerganov/whisper.cpp/releases/download/" + WHISPER_RELEASE;
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
  const home = host.homeDir() || ".";
  return home + "/.codeterm/transcriber";
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
function cleanupOrphanModels(activeModel) {
  const dir = baseDir();
  const h = host;
  let entries = [];
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
function exec(opts) {
  const raw = host.exec(JSON.stringify(opts));
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { error: String(e) };
  }
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
function localBin(name) {
  return binDir() + "/" + name + exeSuffix();
}
function download(url, dest) {
  host.makeDirs(dirOf(dest));
  const r = exec({ bin: "curl", args: ["-fsSL", "-o", dest, url], timeoutMs: 18e5 });
  if (!exitedOk(r)) {
    return { error: "download failed (" + url + "): " + (r.stderr || r.error || "curl exit " + r.code) };
  }
  return { ok: true };
}
function untar(archive, dest) {
  host.makeDirs(dest);
  const r = exec({ bin: "tar", args: ["-xf", archive, "-C", dest], timeoutMs: 6e5 });
  if (!exitedOk(r)) {
    return { error: "extract failed (" + archive + "): " + (r.stderr || r.error || "tar exit " + r.code) };
  }
  return { ok: true };
}
function dirOf(p) {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.substring(0, i) : ".";
}
function ensureFfmpeg() {
  if (ranOk(exec({ bin: "ffmpeg", args: ["-version"] }))) return { bin: "ffmpeg" };
  const local = localBin("ffmpeg");
  if (host.fileExists(local)) return { bin: local };
  const os = osKind();
  if (os === "macos") {
    progress({ label: "Installing ffmpeg\u2026" });
    const r = exec({ bin: "brew", args: ["install", "ffmpeg"], timeoutMs: 18e5 });
    if (exitedOk(r) && ranOk(exec({ bin: "ffmpeg", args: ["-version"] }))) return { bin: "ffmpeg" };
    return { error: "ffmpeg is required. Install it with `brew install ffmpeg`." };
  }
  if (os === "windows") {
    progress({ label: "Installing ffmpeg\u2026" });
    const zip = baseDir() + "/ffmpeg.zip";
    const dl2 = download(FFMPEG_WIN_ZIP, zip);
    if ("error" in dl2) return ffmpegManual(dl2.error);
    const ex2 = untar(zip, binDir());
    if ("error" in ex2) return ffmpegManual(ex2.error);
    host.removeFile(zip);
    if (host.fileExists(local)) return { bin: local };
    return ffmpegManual("ffmpeg binary not found after extraction");
  }
  progress({ label: "Installing ffmpeg\u2026" });
  const tar = baseDir() + "/ffmpeg.tar.xz";
  const dl = download(FFMPEG_LINUX_TAR, tar);
  if ("error" in dl) return ffmpegManual(dl.error);
  const ex = untar(tar, binDir());
  if ("error" in ex) return ffmpegManual(ex.error);
  host.removeFile(tar);
  if (host.fileExists(local)) return { bin: local };
  return ffmpegManual("ffmpeg binary not found after extraction");
}
function ffmpegManual(why) {
  return {
    error: "ffmpeg is required to decode the audio but could not be installed automatically (" + why + "). Install ffmpeg from your package manager (e.g. `apt install ffmpeg`) or https://ffmpeg.org/download.html."
  };
}
function ensureEngine() {
  if (ranOk(exec({ bin: "whisper-cli", args: ["--help"] }))) return { bin: "whisper-cli" };
  const local = localBin("whisper-cli");
  if (host.fileExists(local)) return { bin: local };
  const os = osKind();
  if (os === "macos") {
    progress({ label: "Installing whisper.cpp\u2026" });
    const r = exec({ bin: "brew", args: ["install", "whisper-cpp"], timeoutMs: 18e5 });
    if (exitedOk(r) && ranOk(exec({ bin: "whisper-cli", args: ["--help"] }))) return { bin: "whisper-cli" };
    return { error: "whisper-cli is required. Install it with `brew install whisper-cpp`." };
  }
  progress({ label: "Installing whisper.cpp\u2026" });
  const asset = os === "windows" ? "whisper-bin-x64.zip" : "whisper-bin-Linux.zip";
  const archive = baseDir() + "/whisper.zip";
  const dl = download(WHISPER_BASE + "/" + asset, archive);
  if ("error" in dl) return engineManual(os, dl.error);
  const ex = untar(archive, binDir());
  if ("error" in ex) return engineManual(os, ex.error);
  host.removeFile(archive);
  if (host.fileExists(local)) return { bin: local };
  const nested = binDir() + "/Release/whisper-cli" + exeSuffix();
  if (host.fileExists(nested)) return { bin: nested };
  return engineManual(os, "whisper-cli not found after extraction");
}
function engineManual(os, why) {
  return {
    error: "whisper-cli (whisper.cpp) is required but could not be installed automatically on " + os + " (" + why + "). Build/download whisper.cpp from https://github.com/ggerganov/whisper.cpp/releases and place `whisper-cli" + exeSuffix() + "` in " + binDir() + "."
  };
}
function ensureModel(force = false) {
  const mp = modelPath();
  const done = modelDonePath();
  if (!force && host.fileExists(mp) && host.fileExists(done)) {
    cleanupOrphanModels(mp);
    return { ok: true };
  }
  host.removeFile(mp);
  host.removeFile(done);
  host.makeDirs(baseDir());
  const url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-" + modelId() + ".bin";
  progress({ label: "Downloading model ggml-" + modelId() + " (~" + modelSizeMb(modelId()) + "MB)\u2026" });
  const dl = download(url, mp);
  if ("error" in dl) {
    host.removeFile(mp);
    return {
      error: "could not download the whisper model `ggml-" + modelId() + ".bin`: " + dl.error + ". Download it manually to " + mp + "."
    };
  }
  host.writeFile(done, "");
  cleanupOrphanModels(mp);
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
function modelFileBytes(path) {
  const dir = baseDir();
  const activeName = path.substring(path.lastIndexOf("/") + 1);
  const h = host;
  let entries = [];
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
function modelFileLabel() {
  const mp = modelPath();
  const done = modelDonePath();
  if (!host.fileExists(mp)) return "missing (~" + modelSizeMb(modelId()) + "MB)";
  if (!host.fileExists(done)) return "partial (~" + modelSizeMb(modelId()) + "MB)";
  const bytes = modelFileBytes(mp);
  if (bytes !== null) return "present (" + bytes + " bytes, expected ~" + modelSizeMb(modelId()) + "MB)";
  return "present (~" + modelSizeMb(modelId()) + "MB)";
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
function transcribeRemote(ep, path, lang) {
  const l = lang && lang.length ? lang : language();
  const args = ["-sS", "-m", "600", "-F", "file=@" + path];
  if (l && l.length && l !== "auto") args.push("-F", "language=" + l);
  args.push(ep);
  progress({ label: "Transcribing on remote\u2026" });
  const r = exec({ bin: "curl", args, timeoutMs: 66e4 });
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
function transcribe(path, lang) {
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
    timeoutMs: 12e4
  });
  if (!exitedOk(conv)) {
    host.removeFile(wav);
    return errorResult("ffmpeg could not decode the audio: " + (conv.stderr || conv.error || "exit " + conv.code));
  }
  const l = lang && lang.length ? lang : language();
  progress({ label: "Transcribing\u2026" });
  const tr = exec({
    bin: engine.bin,
    args: ["-m", modelPath(), "-f", wav, "-l", l, "-nt", "-oj", "-of", base],
    timeoutMs: 6e5
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
function present(name) {
  if (ranOk(exec({ bin: name, args: name === "ffmpeg" ? ["-version"] : ["--help"] }))) return true;
  return host.fileExists(localBin(name));
}
function transcribeStatus() {
  const ep = endpoint();
  if (ep.length) return { state: "ready", reason: "remote: " + ep };
  if (!host.homeDir()) return { state: "unavailable", reason: "no home directory" };
  const hasFfmpeg = present("ffmpeg");
  const hasEngine = present("whisper-cli");
  const hasModel = host.fileExists(modelPath()) && host.fileExists(modelDonePath());
  if (hasFfmpeg && hasEngine && hasModel) return { state: "ready" };
  const missing = [];
  if (!hasEngine) missing.push("whisper-cli");
  if (!hasFfmpeg) missing.push("ffmpeg");
  if (!hasModel) missing.push("model ggml-" + modelId() + ".bin");
  return { state: "unloaded", reason: "needs: " + missing.join(", ") + " (installed on first use)" };
}
function renderGlance() {
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
  const st = transcribeStatus();
  const ready = st.state === "ready";
  const hasModel = host.fileExists(modelPath()) && host.fileExists(modelDonePath());
  const badge = st.state === "unavailable" ? "Unavailable" : ready ? "Ready" : hasModel ? "Idle" : "Not installed";
  const nodes = [];
  nodes.push({
    kind: "badge",
    label: badge,
    tone: ready ? "ok" : st.state === "unavailable" ? "danger" : "warn"
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
function glanceAction(action) {
  if (action === "install" || action === "reinstall") {
    const ffmpeg = ensureFfmpeg();
    if (!("error" in ffmpeg)) {
      const engine = ensureEngine();
      if (!("error" in engine)) ensureModel(action === "reinstall");
    }
  }
  return renderGlance();
}
var plugin = {
  transcribe,
  transcribeStatus,
  renderGlance,
  glanceAction
};
var plugin_default = plugin;
