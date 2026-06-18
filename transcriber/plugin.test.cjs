// Plugin-side tests for the one-shot whisper-cli Transcriber, exercised against a
// FAKE host (exec + an in-memory filesystem). The unit under test is the plugin's
// pure bootstrap/transcribe logic — no real ffmpeg/whisper-cli/brew/curl runs.
// Run: npx tsx transcriber/plugin.test.cjs

const HOME = "/home/test";
const MODEL = HOME + "/.codeterm/transcriber/ggml-small.bin";

// ── Configurable fake host ─────────────────────────────────────────────
const execCalls = [];
let execHandler = () => JSON.stringify({ code: 0, stdout: "", stderr: "" });
let settingsObj = {};
let platformStr = "macos";
let files = {}; // path -> contents (in-memory fs)

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
  removeFile: (p) => { delete files[p]; return true; },
  makeDirs: () => true,
  writeTempFile: (c, suffix) => { const p = "/tmp/ct" + (suffix || ""); files[p] = c; return p; },
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

// ── Tests ──────────────────────────────────────────────────────────────

test("deps present + model present: transcribe installs nothing (no brew/curl)", () => {
  reset({}, "macos");
  files[MODEL] = "x"; // model already downloaded
  execHandler = happyHandler(["hello world"]);

  const r = plugin.transcribe("/tmp/note.oga");
  assert(!r.error, "no error, got " + JSON.stringify(r));
  assert(r.text === "hello world", "text joined, got " + JSON.stringify(r));

  const installed = execCalls.some((c) => c.bin === "brew" || c.bin === "curl");
  assert(!installed, "must not install when deps present; calls=" +
    JSON.stringify(execCalls.map((c) => c.bin)));
});

test("transcribe pipeline: ffmpeg converts to 16k wav BEFORE whisper-cli, json joined", () => {
  reset({}, "macos");
  files[MODEL] = "x";
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
  files[MODEL] = "x";
  execHandler = happyHandler(["x"]);
  plugin.transcribe("/tmp/a.oga");
  let w = execCalls.find((c) => /whisper-cli/.test(c.bin) && (c.args || []).indexOf("-l") >= 0);
  let li = w.args.indexOf("-l");
  assert(w.args[li + 1] === "ru", "settings language used, got " + w.args[li + 1]);

  reset({ language: "ru" }, "macos");
  files[MODEL] = "x";
  execHandler = happyHandler(["x"]);
  plugin.transcribe("/tmp/a.oga", "de");
  w = execCalls.find((c) => /whisper-cli/.test(c.bin) && (c.args || []).indexOf("-l") >= 0);
  li = w.args.indexOf("-l");
  assert(w.args[li + 1] === "de", "explicit arg wins, got " + w.args[li + 1]);

  reset({}, "macos");
  files[MODEL] = "x";
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

test("transcribeStatus: ready when deps+model present, unloaded otherwise", () => {
  reset({}, "macos");
  files[MODEL] = "x";
  execHandler = () => JSON.stringify({ code: 0 }); // probes succeed
  let s = plugin.transcribeStatus();
  assert(s.state === "ready", "ready when all present, got " + JSON.stringify(s));

  reset({}, "macos"); // no model, probes fail
  execHandler = () => JSON.stringify({ error: "not found" });
  s = plugin.transcribeStatus();
  assert(s.state === "unloaded", "unloaded when deps missing, got " + JSON.stringify(s));
});

// ── Run ────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (err) { failed += 1; console.error(`✗ ${name}`); console.error(err); }
}
console.log(`transcriber plugin: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
