// Plugin-side tests for the one-shot whisper-cli Transcriber, exercised against a
// FAKE host (exec + an in-memory filesystem). The unit under test is the plugin's
// pure bootstrap/transcribe logic — no real ffmpeg/whisper-cli/brew/curl runs.
// Run: npx tsx transcriber/plugin.test.cjs
const { readFileSync } = require("fs");
const { join } = require("path");

const HOME = "/home/test";
const MODEL = HOME + "/.codeterm/transcriber/ggml-small.bin";
const BASE_MODEL = HOME + "/.codeterm/transcriber/ggml-base.bin";
const MANIFEST = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"));
const SUBPROCESS_ALLOW = MANIFEST.permissions.subprocess.allow;

// ── Configurable fake host ─────────────────────────────────────────────
const execCalls = [];
const progressCalls = [];
let execHandler = () => JSON.stringify({ code: 0, stdout: "", stderr: "" });
let settingsObj = {};
let platformStr = "macos";
let files = {}; // path -> contents (in-memory fs)
const removedFiles = [];

globalThis.host = {
  settingsJson: () => JSON.stringify(settingsObj),
  platform: () => platformStr,
  homeDir: () => HOME,
  expandHome: (p) => p,
  envGet: () => null,
  unixNow: () => 1700000000,
  unixNowMs: () => 1700000000000,
  log: () => {},
  fileExists: (p) => Object.prototype.hasOwnProperty.call(files, p),
  readFile: (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null),
  writeFile: (p, c) => { files[p] = c; return true; },
  removeFile: (p) => { removedFiles.push(p); delete files[p]; return true; },
  readDir: (p) => {
    const prefix = p.endsWith("/") ? p : p + "/";
    const names = new Set();
    for (const f of Object.keys(files)) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.substring(prefix.length);
      if (!rest.length) continue;
      const slash = rest.indexOf("/");
      names.add(slash === -1 ? rest : rest.substring(0, slash));
    }
    return Array.from(names);
  },
  makeDirs: () => true,
  writeTempFile: (c, suffix) => { const p = "/tmp/ct" + (suffix || ""); files[p] = c; return p; },
  progress: (opts) => { progressCalls.push(opts); },
  exec: (json) => {
    const opts = JSON.parse(json);
    execCalls.push(opts);
    return execHandler(opts);
  },
};

const plugin = require("./plugin.js").default;

// ── Tiny runner ────────────────────────────────────────────────────────
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function reset(settings, platform) {
  execCalls.length = 0;
  progressCalls.length = 0;
  removedFiles.length = 0;
  settingsObj = settings || {};
  platformStr = platform || "macos";
  files = {};
  execHandler = () => JSON.stringify({ code: 0, stdout: "", stderr: "" });
}

// Canonical whisper.cpp `-oj` output for the given segment texts.
function whisperJson(segments) {
  return JSON.stringify({
    systeminfo: "fake",
    model: { type: "small" },
    result: { language: "en" },
    transcription: segments.map((t) => ({ text: t })),
  });
}

// Handler that succeeds for everything and, when whisper-cli runs with -of <base>,
// writes <base>.json so the plugin can read it back.
function happyHandler(segments) {
  return (opts) => {
    if (/whisper-cli/.test(opts.bin)) {
      const i = (opts.args || []).indexOf("-of");
      if (i >= 0) files[opts.args[i + 1] + ".json"] = whisperJson(segments);
    }
    return JSON.stringify({ code: 0, stdout: "", stderr: "" });
  };
}

const indexOfCall = (pred) => execCalls.findIndex(pred);
const progressLabels = () => progressCalls.map((c) => c.label);
const buttonLabels = (view) => view.nodes.filter((n) => n.kind === "button").map((n) => n.label);
const badgeLabels = (view) => view.nodes.filter((n) => n.kind === "badge").map((n) => n.label);

function installHandler() {
  let ffmpegInstalled = false;
  let whisperInstalled = false;
  return (opts) => {
    if (opts.bin === "ffmpeg" && (opts.args || [])[0] === "-version") {
      return JSON.stringify(ffmpegInstalled ? { code: 0 } : { error: "not found" });
    }
    if (opts.bin === "whisper-cli" && (opts.args || [])[0] === "--help") {
      return JSON.stringify(whisperInstalled ? { code: 0 } : { error: "not found" });
    }
    if (opts.bin === "brew" && (opts.args || [])[1] === "ffmpeg") {
      ffmpegInstalled = true;
      return JSON.stringify({ code: 0 });
    }
    if (opts.bin === "brew" && (opts.args || [])[1] === "whisper-cpp") {
      whisperInstalled = true;
      return JSON.stringify({ code: 0 });
    }
    if (opts.bin === "curl") {
      const i = (opts.args || []).indexOf("-o");
      if (i >= 0) files[opts.args[i + 1]] = "downloaded";
      return JSON.stringify({ code: 0 });
    }
    return JSON.stringify({ code: 0, stdout: "", stderr: "" });
  };
}

function basename(bin) {
  return String(bin).split(/[\\/]/).pop();
}

function manifestAllowsExec(bin) {
  const base = basename(bin);
  return SUBPROCESS_ALLOW.some((entry) => entry === bin || entry === base);
}

function withSandbox(handler) {
  return (opts) => {
    if (!manifestAllowsExec(opts.bin)) {
      return JSON.stringify({ error: "denied exec(" + opts.bin + ") — not in subprocess.allow" });
    }
    return handler(opts);
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

test("progress: cold transcribe reports install, model download, transcribe, done phases", () => {
  reset({}, "macos");
  let ffmpegInstalled = false;
  let whisperInstalled = false;
  execHandler = (opts) => {
    if (opts.bin === "ffmpeg" && (opts.args || [])[0] === "-version") {
      return JSON.stringify(ffmpegInstalled ? { code: 0 } : { error: "not found" });
    }
    if (opts.bin === "whisper-cli" && (opts.args || [])[0] === "--help") {
      return JSON.stringify(whisperInstalled ? { code: 0 } : { error: "not found" });
    }
    if (opts.bin === "brew" && (opts.args || [])[1] === "ffmpeg") {
      ffmpegInstalled = true;
      return JSON.stringify({ code: 0 });
    }
    if (opts.bin === "brew" && (opts.args || [])[1] === "whisper-cpp") {
      whisperInstalled = true;
      return JSON.stringify({ code: 0 });
    }
    if (/whisper-cli/.test(opts.bin)) {
      const i = (opts.args || []).indexOf("-of");
      if (i >= 0) files[opts.args[i + 1] + ".json"] = whisperJson(["cold path"]);
    }
    return JSON.stringify({ code: 0, stdout: "", stderr: "" });
  };

  const r = plugin.transcribe("/tmp/note.oga");
  assert(r.text === "cold path", "transcribes after bootstrap, got " + JSON.stringify(r));
  assert(JSON.stringify(progressLabels()) === JSON.stringify([
    "Installing ffmpeg…",
    "Installing whisper.cpp…",
    "Downloading model ggml-small (~466MB)…",
    "Transcribing…",
    "Done",
  ]), "unexpected progress labels: " + JSON.stringify(progressCalls));
  assert(progressCalls[progressCalls.length - 1].done === true, "final progress call marks done");
});

test("progress: warm transcribe reports only transcribing and done phases", () => {
  reset({}, "macos");
  files[MODEL] = "x"; files[MODEL + ".done"] = "x";
  execHandler = happyHandler(["warm path"]);

  const r = plugin.transcribe("/tmp/note.oga");
  assert(r.text === "warm path", "transcribes warm path, got " + JSON.stringify(r));
  assert(JSON.stringify(progressLabels()) === JSON.stringify([
    "Transcribing…",
    "Done",
  ]), "unexpected warm progress labels: " + JSON.stringify(progressCalls));
  assert(progressCalls[progressCalls.length - 1].done === true, "final progress call marks done");
});

test("deps present + model present: transcribe installs nothing (no brew/curl)", () => {
  reset({}, "macos");
  files[MODEL] = "x"; files[MODEL + ".done"] = "x"; // model already downloaded
  execHandler = happyHandler(["hello world"]);

  const r = plugin.transcribe("/tmp/note.oga");
  assert(!r.error, "no error, got " + JSON.stringify(r));
  assert(r.text === "hello world", "text joined, got " + JSON.stringify(r));

  const installed = execCalls.some((c) => c.bin === "brew" || c.bin === "curl");
  assert(!installed, "must not install when deps present; calls=" +
    JSON.stringify(execCalls.map((c) => c.bin)));
});

test("poison partial: model file present but no .done sentinel → re-downloads (not trusted)", () => {
  reset({}, "macos");
  files[MODEL] = "partial-30mb"; // an interrupted download left a truncated file, no .done
  execHandler = happyHandler(["recovered"]);

  const r = plugin.transcribe("/tmp/note.oga");
  assert(!r.error, "should recover, got " + JSON.stringify(r));
  // It must re-download (curl) rather than feed whisper-cli the truncated model.
  const reDownloaded = execCalls.some((c) => c.bin === "curl");
  assert(reDownloaded, "must re-download when .done sentinel is missing; calls=" +
    JSON.stringify(execCalls.map((c) => c.bin)));
  assert(files[MODEL + ".done"] !== undefined, "writes .done sentinel after a successful download");
});

test("model switch cleanup: removes orphan ggml bins and matching done sentinels, keeps active and part", () => {
  reset({ model: "base" }, "macos");
  const dir = HOME + "/.codeterm/transcriber";
  const active = dir + "/ggml-base.bin";
  files[active] = "active"; files[active + ".done"] = "ok";
  files[dir + "/ggml-small.bin"] = "old"; files[dir + "/ggml-small.bin.done"] = "ok";
  files[dir + "/ggml-medium.bin"] = "old2"; files[dir + "/ggml-medium.bin.done"] = "ok";
  files[dir + "/ggml-large-v3.bin.part"] = "in-progress";
  execHandler = happyHandler(["switched"]);

  const r = plugin.transcribe("/tmp/note.oga");
  assert(r.text === "switched", "transcribes with active model, got " + JSON.stringify(r));
  assert(files[active] === "active", "active model kept");
  assert(files[active + ".done"] === "ok", "active sentinel kept");
  assert(files[dir + "/ggml-small.bin"] === undefined, "old small model removed");
  assert(files[dir + "/ggml-small.bin.done"] === undefined, "old small sentinel removed");
  assert(files[dir + "/ggml-medium.bin"] === undefined, "old medium model removed");
  assert(files[dir + "/ggml-medium.bin.done"] === undefined, "old medium sentinel removed");
  assert(files[dir + "/ggml-large-v3.bin.part"] === "in-progress", "in-progress part kept");
});

test("model switch cleanup: active-only model deletes nothing", () => {
  reset({ model: "base" }, "macos");
  const dir = HOME + "/.codeterm/transcriber";
  const active = dir + "/ggml-base.bin";
  files[active] = "active"; files[active + ".done"] = "ok";
  execHandler = happyHandler(["active only"]);

  const r = plugin.transcribe("/tmp/note.oga");
  assert(r.text === "active only", "transcribes with active model, got " + JSON.stringify(r));
  const modelDeletes = removedFiles.filter((p) => p.indexOf(dir + "/ggml-") === 0);
  assert(modelDeletes.length === 0, "must not delete any model files; removed=" + JSON.stringify(removedFiles));
});

test("transcribe pipeline: ffmpeg converts to 16k wav BEFORE whisper-cli, json joined", () => {
  reset({}, "macos");
  files[MODEL] = "x"; files[MODEL + ".done"] = "x";
  execHandler = happyHandler(["one ", "two"]);

  const r = plugin.transcribe("/tmp/note.webm");
  assert(r.text === "one two", "segments joined, got " + JSON.stringify(r));

  const ffmpeg = indexOfCall((c) => /ffmpeg/.test(c.bin) && (c.args || []).indexOf("-i") >= 0);
  const whisper = indexOfCall((c) => /whisper-cli/.test(c.bin) && (c.args || []).indexOf("-oj") >= 0);
  assert(ffmpeg >= 0, "ffmpeg convert call present");
  assert(whisper >= 0, "whisper-cli call present");
  assert(ffmpeg < whisper, "ffmpeg must run before whisper-cli");

  // ffmpeg targets 16kHz mono wav from the input
  const conv = execCalls[ffmpeg].args;
  assert(conv.indexOf("16000") >= 0, "16kHz sample rate");
  assert(conv.indexOf("/tmp/note.webm") >= 0, "input path passed to ffmpeg");
});

test("language: explicit arg wins, else settings.language, else auto", () => {
  reset({ language: "ru" }, "macos");
  files[MODEL] = "x"; files[MODEL + ".done"] = "x";
  execHandler = happyHandler(["x"]);
  plugin.transcribe("/tmp/a.oga");
  let w = execCalls.find((c) => /whisper-cli/.test(c.bin) && (c.args || []).indexOf("-l") >= 0);
  let li = w.args.indexOf("-l");
  assert(w.args[li + 1] === "ru", "settings language used, got " + w.args[li + 1]);

  reset({ language: "ru" }, "macos");
  files[MODEL] = "x"; files[MODEL + ".done"] = "x";
  execHandler = happyHandler(["x"]);
  plugin.transcribe("/tmp/a.oga", "de");
  w = execCalls.find((c) => /whisper-cli/.test(c.bin) && (c.args || []).indexOf("-l") >= 0);
  li = w.args.indexOf("-l");
  assert(w.args[li + 1] === "de", "explicit arg wins, got " + w.args[li + 1]);

  reset({}, "macos");
  files[MODEL] = "x"; files[MODEL + ".done"] = "x";
  execHandler = happyHandler(["x"]);
  plugin.transcribe("/tmp/a.oga");
  w = execCalls.find((c) => /whisper-cli/.test(c.bin) && (c.args || []).indexOf("-l") >= 0);
  li = w.args.indexOf("-l");
  assert(w.args[li + 1] === "auto", "defaults to auto, got " + w.args[li + 1]);
});

test("missing deps that cannot be installed: clear actionable error", () => {
  reset({}, "linux");
  // Everything fails: probes error (binary absent), curl download errors too.
  execHandler = () => JSON.stringify({ error: "executable not found" });

  const r = plugin.transcribe("/tmp/note.oga");
  assert(r.error, "must surface an error, got " + JSON.stringify(r));
  assert(!r.text, "no text on failure");
  assert(/install/i.test(r.error), "error tells the user to install, got: " + r.error);
});

test("windows: downloads whisper.cpp from current ggml-org release asset", () => {
  reset({}, "windows");
  files[HOME + "/.codeterm/transcriber/bin/ffmpeg.exe"] = "ffmpeg";
  files[MODEL] = "x"; files[MODEL + ".done"] = "x";
  execHandler = withSandbox((opts) => {
    if (opts.bin === "ffmpeg" && (opts.args || [])[0] === "-version") {
      return JSON.stringify({ error: "not on PATH" });
    }
    if (opts.bin === "whisper-cli" && (opts.args || [])[0] === "--help") {
      return JSON.stringify({ error: "not found" });
    }
    if (opts.bin === "curl" && (opts.args || []).indexOf("https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip") >= 0) {
      const i = opts.args.indexOf("-o");
      files[opts.args[i + 1]] = "zip";
      return JSON.stringify({ code: 0 });
    }
    if (opts.bin === "tar") {
      files[HOME + "/.codeterm/transcriber/bin/Release/whisper-cli.exe"] = "exe";
      return JSON.stringify({ code: 0 });
    }
    if (/whisper-cli/.test(opts.bin)) {
      const i = (opts.args || []).indexOf("-of");
      if (i >= 0) files[opts.args[i + 1] + ".json"] = whisperJson(["win ok"]);
      return JSON.stringify({ code: 0 });
    }
    return JSON.stringify({ code: 0, stdout: "", stderr: "" });
  });

  const r = plugin.transcribe("/tmp/note.oga");
  assert(r.text === "win ok", "transcribes after windows bootstrap, got " + JSON.stringify(r));
  const whisperCurl = execCalls.find((c) => c.bin === "curl" && (c.args || []).some((a) => /whisper-bin-x64\.zip$/.test(a)));
  assert(whisperCurl, "whisper asset downloaded with curl");
  assert(whisperCurl.args.indexOf("https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip") >= 0,
    "uses current ggml-org asset, got " + JSON.stringify(whisperCurl.args));
});

test("windows: discovers ffmpeg inside nested gyan.dev zip layout", () => {
  reset({}, "windows");
  const nestedFfmpeg = HOME + "/.codeterm/transcriber/bin/ffmpeg-7.1.1-essentials_build/bin/ffmpeg.exe";
  files[nestedFfmpeg] = "ffmpeg";
  files[HOME + "/.codeterm/transcriber/bin/whisper-cli.exe"] = "whisper";
  files[MODEL] = "x"; files[MODEL + ".done"] = "x";
  execHandler = withSandbox((opts) => {
    if (opts.bin === "ffmpeg" && (opts.args || [])[0] === "-version") {
      return JSON.stringify({ error: "not on PATH" });
    }
    if (opts.bin === "whisper-cli" && (opts.args || [])[0] === "--help") {
      return JSON.stringify({ error: "not on PATH" });
    }
    if (/whisper-cli/.test(opts.bin)) {
      const i = (opts.args || []).indexOf("-of");
      if (i >= 0) files[opts.args[i + 1] + ".json"] = whisperJson(["nested ffmpeg ok"]);
    }
    return JSON.stringify({ code: 0, stdout: "", stderr: "" });
  });

  const r = plugin.transcribe("/tmp/note.oga");
  assert(r.text === "nested ffmpeg ok", "transcribes with nested ffmpeg, got " + JSON.stringify(r));
  const conv = execCalls.find((c) => c.bin === nestedFfmpeg && (c.args || []).indexOf("-ar") >= 0);
  assert(conv, "uses nested ffmpeg for conversion, calls=" + JSON.stringify(execCalls.map((c) => c.bin)));
  assert(!execCalls.some((c) => c.bin === "curl"), "must not redownload ffmpeg when nested binary exists");
});

test("windows: falls back to PowerShell when curl cannot write the release asset", () => {
  reset({}, "windows");
  const archive = HOME + "/.codeterm/transcriber/whisper.zip";
  files[HOME + "/.codeterm/transcriber/bin/ffmpeg.exe"] = "ffmpeg";
  files[MODEL] = "x"; files[MODEL + ".done"] = "x";
  execHandler = withSandbox((opts) => {
    if (opts.bin === "ffmpeg" && (opts.args || [])[0] === "-version") {
      return JSON.stringify({ error: "not on PATH" });
    }
    if (opts.bin === "whisper-cli" && (opts.args || [])[0] === "--help") {
      return JSON.stringify({ error: "not found" });
    }
    if (opts.bin === "curl" && (opts.args || []).some((a) => /whisper-bin-x64\.zip$/.test(a))) {
      return JSON.stringify({ code: 23, stderr: "curl: (23) client returned ERROR on write" });
    }
    if (opts.bin === "powershell.exe" && (opts.args || []).join(" ").indexOf("Invoke-WebRequest") >= 0) {
      files[archive] = "zip";
      return JSON.stringify({ code: 0 });
    }
    if (opts.bin === "tar") {
      files[HOME + "/.codeterm/transcriber/bin/Release/whisper-cli.exe"] = "exe";
      return JSON.stringify({ code: 0 });
    }
    if (/whisper-cli/.test(opts.bin)) {
      const i = (opts.args || []).indexOf("-of");
      if (i >= 0) files[opts.args[i + 1] + ".json"] = whisperJson(["fallback ok"]);
      return JSON.stringify({ code: 0 });
    }
    return JSON.stringify({ code: 0, stdout: "", stderr: "" });
  });

  const r = plugin.transcribe("/tmp/note.oga");
  assert(r.text === "fallback ok", "transcribes after powershell fallback, got " + JSON.stringify(r));
  assert(execCalls.some((c) => c.bin === "powershell.exe" && (c.args || []).join(" ").indexOf("Invoke-WebRequest") >= 0),
    "powershell fallback invoked only for download");
  assert(!execCalls.some((c) => c.bin === "powershell.exe" && (c.args || []).join(" ").indexOf("whisper-cli.exe") >= 0),
    "must not run downloaded whisper-cli through powershell");
});

test("windows: downloaded binaries execute directly by manifest basename, without sandbox denial", () => {
  reset({}, "windows");
  files[HOME + "/.codeterm/transcriber/bin/ffmpeg.exe"] = "ffmpeg";
  const nestedWhisper = HOME + "/.codeterm/transcriber/bin/Release/whisper-cli.exe";
  files[nestedWhisper] = "exe";
  files[MODEL] = "x"; files[MODEL + ".done"] = "x";
  execHandler = withSandbox((opts) => {
    if (opts.bin === "ffmpeg" && (opts.args || [])[0] === "-version") {
      return JSON.stringify({ error: "not on PATH" });
    }
    if (opts.bin === "whisper-cli" && (opts.args || [])[0] === "--help") {
      return JSON.stringify({ error: "not on PATH" });
    }
    if (/whisper-cli/.test(opts.bin)) {
      const i = (opts.args || []).indexOf("-of");
      if (i >= 0) files[opts.args[i + 1] + ".json"] = whisperJson(["direct"]);
    }
    return JSON.stringify({ code: 0, stdout: "", stderr: "" });
  });

  const r = plugin.transcribe("/tmp/note.oga");
  assert(r.text === "direct", "transcribes by direct downloaded binary exec, got " + JSON.stringify(r));
  assert(execCalls.some((c) => c.bin === HOME + "/.codeterm/transcriber/bin/ffmpeg.exe"),
    "direct local ffmpeg.exe exec should be allowed by manifest basename");
  assert(execCalls.some((c) => c.bin === nestedWhisper),
    "direct nested whisper-cli.exe exec should be allowed by manifest basename");
  assert(!execCalls.some((c) => c.bin === "powershell.exe"),
    "must not use powershell runtime wrapper for downloaded binaries");
});

test("transcribeStatus: ready when deps+model present, unloaded otherwise", () => {
  reset({}, "macos");
  files[MODEL] = "x"; files[MODEL + ".done"] = "x";
  execHandler = () => JSON.stringify({ code: 0 }); // probes succeed
  let s = plugin.transcribeStatus();
  assert(s.state === "ready", "ready when all present, got " + JSON.stringify(s));

  reset({}, "macos"); // no model, probes fail
  execHandler = () => JSON.stringify({ error: "not found" });
  s = plugin.transcribeStatus();
  assert(s.state === "unloaded", "unloaded when deps missing, got " + JSON.stringify(s));
});

test("glance: inactive model shows install and reinstall with not-installed status", () => {
  reset({ model: "base", language: "ru" }, "macos");
  execHandler = () => JSON.stringify({ code: 0 });

  const view = plugin.renderGlance();
  assert(JSON.stringify(badgeLabels(view)) === JSON.stringify(["Not installed"]),
    "not-installed badge shown, got " + JSON.stringify(view.nodes));
  assert(view.nodes.some((n) => n.kind === "keyVal" && n.key === "Model" && n.value === "ggml-base"),
    "active settings model shown, got " + JSON.stringify(view.nodes));
  assert(view.nodes.some((n) => n.kind === "keyVal" && n.key === "Model file" && /missing/i.test(n.value)),
    "missing model file status shown, got " + JSON.stringify(view.nodes));
  assert(JSON.stringify(buttonLabels(view)) === JSON.stringify(["Install", "Reinstall", "Settings"]),
    "install, reinstall, settings buttons shown, got " + JSON.stringify(view.nodes));
});

test("glanceAction install downloads the active settings model and emits progress", () => {
  reset({ model: "base" }, "macos");
  execHandler = installHandler();

  const view = plugin.glanceAction("install");
  assert(files[BASE_MODEL] === "downloaded", "active base model downloaded");
  assert(files[BASE_MODEL + ".done"] !== undefined, "done sentinel written for active model");
  assert(JSON.stringify(progressLabels()) === JSON.stringify([
    "Installing ffmpeg…",
    "Installing whisper.cpp…",
    "Downloading model ggml-base (~142MB)…",
  ]), "unexpected install progress labels: " + JSON.stringify(progressCalls));
  assert(JSON.stringify(badgeLabels(view)) === JSON.stringify(["Ready"]),
    "glance rerendered ready status, got " + JSON.stringify(view.nodes));
  assert(JSON.stringify(buttonLabels(view)) === JSON.stringify(["Reinstall", "Settings"]),
    "install hidden after model exists, got " + JSON.stringify(view.nodes));
});

test("glanceAction reinstall after settings model change prunes old and keeps only active", () => {
  reset({ model: "base" }, "macos");
  files[MODEL] = "old-small"; files[MODEL + ".done"] = "ok";
  execHandler = installHandler();

  const view = plugin.glanceAction("reinstall");
  assert(files[BASE_MODEL] === "downloaded", "new active base model downloaded");
  assert(files[BASE_MODEL + ".done"] !== undefined, "new active sentinel written");
  assert(files[MODEL] === undefined, "old small model pruned");
  assert(files[MODEL + ".done"] === undefined, "old small sentinel pruned");
  const remainingModels = Object.keys(files).filter((p) => /\/ggml-.*\.bin$/.test(p)).sort();
  assert(JSON.stringify(remainingModels) === JSON.stringify([BASE_MODEL]),
    "only active model remains, got " + JSON.stringify(remainingModels));
  assert(JSON.stringify(progressLabels()) === JSON.stringify([
    "Installing ffmpeg…",
    "Installing whisper.cpp…",
    "Downloading model ggml-base (~142MB)…",
  ]), "unexpected reinstall progress labels: " + JSON.stringify(progressCalls));
  assert(JSON.stringify(badgeLabels(view)) === JSON.stringify(["Ready"]),
    "glance rerendered ready status, got " + JSON.stringify(view.nodes));
});

// ── Remote mode (mesh GPU offload) ──────────────────────────────────────

// Fake daemon: respond to a curl multipart upload with the given JSON body.
function remoteHandler(body) {
  return (opts) => {
    if (opts.bin === "curl") return JSON.stringify({ code: 0, stdout: JSON.stringify(body), stderr: "" });
    return JSON.stringify({ code: 0, stdout: "", stderr: "" });
  };
}

test("remote: uploads via curl to endpoint and parses daemon text, no local deps", () => {
  reset({ endpoint: "http://gpu:7891/transcribe", language: "ru" }, "macos");
  execHandler = remoteHandler({ text: "  привет мир  ", language: "ru" });

  const r = plugin.transcribe("/tmp/note.m4a");
  assert(r.text === "привет мир", "trims remote transcript, got " + JSON.stringify(r));

  const curl = execCalls.find((c) => c.bin === "curl");
  assert(curl, "curl invoked, calls=" + JSON.stringify(execCalls.map((c) => c.bin)));
  const a = curl.args;
  assert(a.indexOf("http://gpu:7891/transcribe") >= 0, "endpoint passed to curl, got " + JSON.stringify(a));
  const fi = a.indexOf("-F");
  assert(a.indexOf("file=@/tmp/note.m4a") >= 0, "audio uploaded as file field, got " + JSON.stringify(a));
  assert(a.indexOf("language=ru") >= 0, "language hint forwarded, got " + JSON.stringify(a));

  // Remote mode must NOT touch ffmpeg/whisper-cli/brew/model.
  const localBins = execCalls.filter((c) => /ffmpeg|whisper-cli|brew/.test(c.bin));
  assert(localBins.length === 0, "no local engine calls in remote mode, got " + JSON.stringify(localBins.map((c) => c.bin)));
});

test("remote: language=auto omits the language field (daemon rejects 'auto')", () => {
  reset({ endpoint: "http://gpu:7891/transcribe" }, "macos"); // no language → auto
  execHandler = remoteHandler({ text: "hello", language: "en" });

  plugin.transcribe("/tmp/note.m4a");
  const curl = execCalls.find((c) => c.bin === "curl");
  assert(curl.args.every((x) => x.indexOf("language=") !== 0), "must not send language field, got " + JSON.stringify(curl.args));
});

test("remote: explicit lang arg wins over settings", () => {
  reset({ endpoint: "http://gpu:7891/transcribe", language: "ru" }, "macos");
  execHandler = remoteHandler({ text: "x", language: "de" });

  plugin.transcribe("/tmp/note.m4a", "de");
  const curl = execCalls.find((c) => c.bin === "curl");
  assert(curl.args.indexOf("language=de") >= 0, "explicit arg forwarded, got " + JSON.stringify(curl.args));
});

test("remote: daemon error body is surfaced", () => {
  reset({ endpoint: "http://gpu:7891/transcribe" }, "macos");
  execHandler = remoteHandler({ error: "bad audio" });

  const r = plugin.transcribe("/tmp/note.m4a");
  assert(r.error, "must surface error, got " + JSON.stringify(r));
  assert(/bad audio/.test(r.error), "includes daemon message, got " + r.error);
  assert(!r.text, "no text on failure");
});

test("remote: empty transcript is surfaced as an error (no silent empty result)", () => {
  reset({ endpoint: "http://gpu:7891/transcribe" }, "macos");
  execHandler = remoteHandler({ text: "", language: "nn" });

  const r = plugin.transcribe("/tmp/note.m4a");
  assert(r.error, "empty transcript surfaces error, got " + JSON.stringify(r));
  assert(/empty transcript/.test(r.error), "explains empty transcript, got " + r.error);
});

test("remote: curl transport failure is surfaced, no local fallback", () => {
  reset({ endpoint: "http://gpu:7891/transcribe" }, "macos");
  execHandler = (opts) => {
    if (opts.bin === "curl") return JSON.stringify({ error: "Connection refused" });
    return JSON.stringify({ code: 0 });
  };

  const r = plugin.transcribe("/tmp/note.m4a");
  assert(r.error, "transport failure surfaces error, got " + JSON.stringify(r));
  assert(/remote transcription failed/.test(r.error), "clear remote error, got " + r.error);
  const localBins = execCalls.filter((c) => /ffmpeg|whisper-cli|brew/.test(c.bin));
  assert(localBins.length === 0, "no silent local fallback, got " + JSON.stringify(localBins.map((c) => c.bin)));
});

test("remote: status is ready and glance shows the endpoint", () => {
  reset({ endpoint: "http://gpu:7891/transcribe" }, "macos");
  execHandler = () => JSON.stringify({ code: 0 });

  const s = plugin.transcribeStatus();
  assert(s.state === "ready", "remote status ready, got " + JSON.stringify(s));

  const view = plugin.renderGlance();
  assert(JSON.stringify(badgeLabels(view)) === JSON.stringify(["Remote"]), "remote badge, got " + JSON.stringify(view.nodes));
  assert(view.nodes.some((n) => n.kind === "keyVal" && n.key === "Endpoint" && n.value === "http://gpu:7891/transcribe"),
    "endpoint shown, got " + JSON.stringify(view.nodes));
  assert(JSON.stringify(buttonLabels(view)) === JSON.stringify(["Settings"]), "only settings button, got " + JSON.stringify(view.nodes));
});

// ── Run ────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (err) { failed += 1; console.error(`✗ ${name}`); console.error(err); }
}
console.log(`transcriber plugin: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
