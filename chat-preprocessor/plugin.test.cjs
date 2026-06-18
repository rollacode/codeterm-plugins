// Plugin-side tests for the chat-preprocessor: the compose logic and the three
// context backends (mem / groq / worker), exercised against a FAKE host (like the
// LM Studio plugin fakes host.fetch). No live host: host.mem / host.worker /
// host.fetch / host.secretGet are all stubbed synchronously — which is exactly the
// runtime contract the compose stage requires (chatPreprocess is synchronous; the
// real sync host.mem/host.worker binds land with Track C2).
// Run: npx tsx chat-preprocessor/plugin.test.cjs

let settingsObj = {};
let memHandler = () => ({ hits: [] });
let fetchHandler = () => JSON.stringify({ error: "no fetch handler set" });
let workerStartHandler = () => ({ jobId: "job-1" });
let workerPollHandler = () => ({ done: true, report: "" });
let secrets = {};
const fetchCalls = [];
const memCalls = [];

globalThis.host = {
  settingsJson: () => JSON.stringify(settingsObj),
  secretGet: (name) => (name in secrets ? secrets[name] : null),
  fetch: (optsJson) => {
    const opts = JSON.parse(optsJson);
    fetchCalls.push(opts);
    return fetchHandler(opts);
  },
  mem: {
    search: (opts) => {
      memCalls.push(opts);
      return memHandler(opts);
    },
  },
  worker: {
    start: (opts) => workerStartHandler(opts),
    poll: (jobId) => workerPollHandler(jobId),
  },
  envGet: () => null,
  log: () => {},
};

const plugin = require("./plugin.js").default;

const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// Collect every settable `key` from a settings.schema.json (sections nest
// `fields`, `when` nests `then`).
function collectSchemaKeys(schema) {
  const keys = [];
  const walk = (fields) => {
    for (const f of fields || []) {
      if (f && f.key) keys.push(f.key);
      if (f && Array.isArray(f.fields)) walk(f.fields);
      if (f && Array.isArray(f.then)) walk(f.then);
    }
  };
  walk(schema);
  return keys;
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function reset(settings) {
  settingsObj = settings || {};
  memHandler = () => ({ hits: [] });
  fetchHandler = () => JSON.stringify({ error: "no fetch handler set" });
  workerStartHandler = () => ({ jobId: "job-1" });
  workerPollHandler = () => ({ done: true, report: "" });
  secrets = {};
  fetchCalls.length = 0;
  memCalls.length = 0;
}

// A representative ctx the host hands the stage.
function ctx(text) {
  return { paneId: "p", cwd: null, provider: null, text: text, turnIndex: 0 };
}

// ── capability shape ──

test("declares match: 'text' (the slot it grabs)", () => {
  assert(plugin.match === "text", "match is text, got " + plugin.match);
  assert(typeof plugin.chatPreprocess === "function", "chatPreprocess is a function");
});

// ── passthrough (null) cases ──

test("disabled → passthrough (null)", () => {
  reset({ enabled: false, backend: "mem" });
  memHandler = () => ({ hits: [{ id: "1", text: "should not be used", score: 1 }] });
  assert(plugin.chatPreprocess(ctx("hello")) === null, "returns null when disabled");
  assert(memCalls.length === 0, "mem is not even consulted when disabled");
});

test("enabled omitted → passthrough (null)", () => {
  reset({ backend: "mem" });
  assert(plugin.chatPreprocess(ctx("hello")) === null, "null when enabled is absent");
});

test("mem backend, no hits → passthrough (null)", () => {
  reset({ enabled: true, backend: "mem" });
  memHandler = () => ({ hits: [] });
  assert(plugin.chatPreprocess(ctx("hello")) === null, "null when no hits");
  assert(memCalls.length === 1 && memCalls[0].query === "hello", "queried mem with the text");
});

test("empty / whitespace text → passthrough (null)", () => {
  reset({ enabled: true, backend: "mem" });
  memHandler = () => ({ hits: [{ id: "1", text: "x", score: 1 }] });
  assert(plugin.chatPreprocess(ctx("")) === null, "null on empty text");
  assert(plugin.chatPreprocess(ctx("   ")) === null, "null on whitespace text");
  assert(memCalls.length === 0, "mem not consulted for empty text");
});

test("unknown backend → passthrough (null)", () => {
  reset({ enabled: true, backend: "nope" });
  assert(plugin.chatPreprocess(ctx("hi")) === null, "null on unknown backend");
});

// ── mem backend: hits → augmented text ──

test("mem backend, hits → text augmented with a <context> block (append default)", () => {
  reset({ enabled: true, backend: "mem" });
  memHandler = (opts) => {
    assert(opts.query === "what is the deploy flow?", "query is the turn text");
    assert(opts.k === 3, "default k=3, got " + opts.k);
    return {
      hits: [
        { id: "a", text: "Deploy via ./build.sh release", score: 0.9 },
        { id: "b", text: "Tags trigger the OIDC publish", score: 0.8 },
      ],
    };
  };
  const out = plugin.chatPreprocess(ctx("what is the deploy flow?"));
  assert(out && typeof out.text === "string", "returns { text }");
  assert(out.text.indexOf("what is the deploy flow?") === 0, "original text comes first (append)");
  assert(out.text.includes("<context>") && out.text.includes("</context>"), "wrapped in <context>");
  assert(out.text.includes("- Deploy via ./build.sh release"), "hit 1 rendered as a bullet");
  assert(out.text.includes("- Tags trigger the OIDC publish"), "hit 2 rendered as a bullet");
});

test("composeMode: prepend puts the <context> block before the text", () => {
  reset({ enabled: true, backend: "mem", composeMode: "prepend" });
  memHandler = () => ({ hits: [{ id: "a", text: "fact one", score: 1 }] });
  const out = plugin.chatPreprocess(ctx("my question"));
  assert(out.text.indexOf("<context>") === 0, "context block comes first");
  assert(out.text.trim().endsWith("my question"), "original text comes last, got: " + out.text);
});

test("mem backend tolerates a malformed search result → passthrough", () => {
  reset({ enabled: true, backend: "mem" });
  memHandler = () => { throw new Error("boom"); };
  assert(plugin.chatPreprocess(ctx("hi")) === null, "null when mem.search throws");
});

// ── groq backend ──

test("groq backend without an API key → passthrough (null)", () => {
  reset({ enabled: true, backend: "groq" });
  // no groqApiKey secret set
  assert(plugin.chatPreprocess(ctx("hi")) === null, "null without api key");
  assert(fetchCalls.length === 0, "no fetch attempted without a key");
});

test("groq backend POSTs to api.groq.com with the bearer key and folds the reply in", () => {
  reset({ enabled: true, backend: "groq", model: "llama-3.3-70b-versatile" });
  secrets = { groqApiKey: "gsk_test" };
  fetchHandler = (opts) => {
    assert(opts.method === "POST", "POST");
    assert(opts.url === "https://api.groq.com/openai/v1/chat/completions", "groq url, got " + opts.url);
    assert(opts.headers.authorization === "Bearer gsk_test", "bearer header");
    const body = JSON.parse(opts.body);
    assert(body.model === "llama-3.3-70b-versatile", "model passed through, got " + body.model);
    return JSON.stringify({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "- relevant background" } }] }),
    });
  };
  const out = plugin.chatPreprocess(ctx("question"));
  assert(out && out.text.includes("<context>"), "context block present");
  assert(out.text.includes("- relevant background"), "groq content folded in");
  assert(fetchCalls.length === 1, "one fetch call");
});

test("groq backend, empty content → passthrough (null)", () => {
  reset({ enabled: true, backend: "groq" });
  secrets = { groqApiKey: "gsk_test" };
  fetchHandler = () =>
    JSON.stringify({ status: 200, body: JSON.stringify({ choices: [{ message: { content: "" } }] }) });
  assert(plugin.chatPreprocess(ctx("question")) === null, "null on empty groq content");
});

test("groq backend, HTTP error → passthrough (null)", () => {
  reset({ enabled: true, backend: "groq" });
  secrets = { groqApiKey: "gsk_test" };
  fetchHandler = () => JSON.stringify({ status: 500, body: "boom" });
  assert(plugin.chatPreprocess(ctx("question")) === null, "null on http 500");
});

test("groq backend defaults the model when none configured", () => {
  reset({ enabled: true, backend: "groq" });
  secrets = { groqApiKey: "gsk_test" };
  fetchHandler = (opts) => {
    const body = JSON.parse(opts.body);
    assert(body.model === "llama-3.1-8b-instant", "default model, got " + body.model);
    return JSON.stringify({ status: 200, body: JSON.stringify({ choices: [{ message: { content: "ctx" } }] }) });
  };
  const out = plugin.chatPreprocess(ctx("q"));
  assert(out && out.text.includes("ctx"), "folded in with default model");
});

// ── worker backend ──

test("worker backend starts a job, polls to completion, folds the report in", () => {
  reset({ enabled: true, backend: "worker" });
  let started = null;
  workerStartHandler = (opts) => { started = opts; return { jobId: "job-42" }; };
  let polls = 0;
  workerPollHandler = (jobId) => {
    assert(jobId === "job-42", "polls the started job id, got " + jobId);
    polls += 1;
    return polls < 2 ? { done: false } : { done: true, report: "worker-supplied context" };
  };
  const out = plugin.chatPreprocess(ctx("plan the migration"));
  assert(started && started.task.includes("plan the migration"), "task carries the turn text");
  assert(out && out.text.includes("<context>"), "context block present");
  assert(out.text.includes("worker-supplied context"), "worker report folded in");
  assert(polls === 2, "polled until done, polls=" + polls);
});

test("worker backend, job error → passthrough (null)", () => {
  reset({ enabled: true, backend: "worker" });
  workerPollHandler = () => ({ done: true, error: "agent crashed" });
  assert(plugin.chatPreprocess(ctx("hi")) === null, "null when the worker reports an error");
});

test("worker backend, empty report → passthrough (null)", () => {
  reset({ enabled: true, backend: "worker" });
  workerPollHandler = () => ({ done: true, report: "   " });
  assert(plugin.chatPreprocess(ctx("hi")) === null, "null on a blank worker report");
});

test("worker backend, never finishes → passthrough (null), bounded poll loop", () => {
  reset({ enabled: true, backend: "worker" });
  let polls = 0;
  workerPollHandler = () => { polls += 1; return { done: false }; };
  assert(plugin.chatPreprocess(ctx("hi")) === null, "null when the job never completes");
  assert(polls > 0 && polls <= 60, "poll loop is bounded, polls=" + polls);
});

// ── manifest + settings schema (Track S) ──

test("settings.schema.json exposes the strategy + backend keys the plugin reads", () => {
  const schema = JSON.parse(readFileSync(join(__dirname, "settings.schema.json"), "utf8"));
  assert(Array.isArray(schema), "schema is a top-level array of sections");
  const keys = collectSchemaKeys(schema);
  // "strategy" in the design maps to composeMode (the compose strategy).
  assert(keys.includes("backend"), "schema exposes backend, got " + keys.join(","));
  assert(keys.includes("composeMode"), "schema exposes composeMode (compose strategy), got " + keys.join(","));
  assert(keys.includes("enabled"), "schema exposes the enabled toggle, got " + keys.join(","));
});

test("the backend select offers exactly the backends the plugin implements", () => {
  const schema = JSON.parse(readFileSync(join(__dirname, "settings.schema.json"), "utf8"));
  let backendField = null;
  const walk = (fields) => {
    for (const f of fields || []) {
      if (f && f.key === "backend") backendField = f;
      if (f && Array.isArray(f.fields)) walk(f.fields);
      if (f && Array.isArray(f.then)) walk(f.then);
    }
  };
  walk(schema);
  assert(backendField && backendField.kind === "select", "backend is a select");
  const ids = backendField.options.map((o) => o[0]).sort();
  assert(JSON.stringify(ids) === JSON.stringify(["groq", "mem", "worker"]), "backend options, got " + ids.join(","));
});

test("plugin.json references the schema and carries a non-empty configHelp", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"));
  assert(manifest.settingsSchema === "settings.schema.json", "settingsSchema ref, got " + manifest.settingsSchema);
  assert(typeof manifest.configHelp === "string" && manifest.configHelp.trim().length > 0, "configHelp is a non-empty string");
  assert(manifest.configHelp.includes("codeterm plugin config"), "configHelp tells the agent the config command");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (err) { failed += 1; console.error(`✗ ${name}`); console.error(err); }
}
console.log(`chat-preprocessor plugin: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
