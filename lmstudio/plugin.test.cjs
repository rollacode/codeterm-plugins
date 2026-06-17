// Plugin-side tests for the LM Studio chatBackend: poll cursoring + the
// sendMessage / listModels request shapes, exercised against a FAKE host.fetch
// (R7 — no live LM Studio server; the plugin's pure logic is the unit under test).
// Run: npx tsx lmstudio/plugin.test.cjs

// Configurable fake host. Each test installs its own fetch handler + settings.
const fetchCalls = [];
let fetchHandler = () => JSON.stringify({ error: "no fetch handler set" });
let settingsObj = {};

globalThis.host = {
  settingsJson: () => JSON.stringify(settingsObj),
  fetch: (optsJson) => {
    const opts = JSON.parse(optsJson);
    fetchCalls.push(opts);
    return fetchHandler(opts);
  },
  envGet: () => null,
  log: () => {},
};

const plugin = require("./plugin.js").default;

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function reset(settings) {
  fetchCalls.length = 0;
  settingsObj = settings || {};
  fetchHandler = () => JSON.stringify({ error: "no fetch handler set" });
}

// Canonical chat-completions reply for a given assistant content.
function chatReply(content) {
  return JSON.stringify({
    status: 200,
    body: JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
  });
}

test("openSession returns the paneId as sessionId", () => {
  reset();
  const r = plugin.openSession({ paneId: "pane-1", config: {} });
  assert(r.sessionId === "pane-1", "sessionId echoes paneId, got " + r.sessionId);
});

test("sendMessage POSTs the OpenAI request shape to baseUrl/v1/chat/completions", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama-3" });
  fetchHandler = () => chatReply("hi there");
  plugin.openSession({ paneId: "p", config: {} });
  plugin.sendMessage("p", "hello");

  assert(fetchCalls.length === 1, "one fetch call, got " + fetchCalls.length);
  const call = fetchCalls[0];
  assert(call.method === "POST", "POST, got " + call.method);
  assert(
    call.url === "http://localhost:1234/v1/chat/completions",
    "url, got " + call.url,
  );
  assert(call.headers["content-type"] === "application/json", "json content-type");
  const body = JSON.parse(call.body);
  assert(body.model === "llama-3", "model passed through, got " + body.model);
  assert(Array.isArray(body.messages) && body.messages.length === 1, "one message");
  assert(
    body.messages[0].role === "user" && body.messages[0].content === "hello",
    "user turn, got " + JSON.stringify(body.messages[0]),
  );
});

test("trailing slash in baseUrl is normalized; blank baseUrl defaults to localhost:1234", () => {
  reset({ baseUrl: "http://10.0.0.5:9999/", model: "m" });
  fetchHandler = () => chatReply("x");
  plugin.openSession({ paneId: "p", config: {} });
  plugin.sendMessage("p", "hi");
  assert(
    fetchCalls[0].url === "http://10.0.0.5:9999/v1/chat/completions",
    "trailing slash stripped, got " + fetchCalls[0].url,
  );

  reset({});
  fetchHandler = () => chatReply("x");
  plugin.openSession({ paneId: "q", config: {} });
  plugin.sendMessage("q", "hi");
  assert(
    fetchCalls[0].url === "http://localhost:1234/v1/chat/completions",
    "default baseUrl, got " + fetchCalls[0].url,
  );
});

test("poll cursoring: returns only new messages and advances the cursor", () => {
  reset({ baseUrl: "http://localhost:1234", model: "m" });
  fetchHandler = () => chatReply("reply one");
  plugin.openSession({ paneId: "c", config: {} });

  // Nothing sent yet.
  let p = plugin.poll("c", null);
  assert(p.messages.length === 0, "empty before send");
  assert(p.cursor === "0", "cursor 0, got " + p.cursor);

  plugin.sendMessage("c", "first");
  p = plugin.poll("c", null);
  assert(p.messages.length === 2, "user + assistant, got " + p.messages.length);
  assert(p.messages[0].type === "user" && p.messages[0].content === "first", "user msg");
  assert(
    p.messages[1].type === "assistant" && p.messages[1].content === "reply one",
    "assistant msg, got " + JSON.stringify(p.messages[1]),
  );
  assert(p.cursor === "2", "cursor 2, got " + p.cursor);
  assert(p.messages.every((m) => typeof m.id === "string" && m.id.length), "stable ids");

  // Polling from the returned cursor yields nothing new.
  const empty = plugin.poll("c", p.cursor);
  assert(empty.messages.length === 0, "no new messages, got " + empty.messages.length);
  assert(empty.cursor === "2", "cursor unchanged, got " + empty.cursor);

  // A second turn surfaces exactly the two new messages from the old cursor.
  fetchHandler = () => chatReply("reply two");
  plugin.sendMessage("c", "second");
  const next = plugin.poll("c", "2");
  assert(next.messages.length === 2, "two new messages, got " + next.messages.length);
  assert(next.messages[1].content === "reply two", "second reply");
  assert(next.cursor === "4", "cursor 4, got " + next.cursor);
});

test("full conversation history is replayed to LM Studio on each turn", () => {
  reset({ baseUrl: "http://localhost:1234", model: "m" });
  fetchHandler = () => chatReply("ack");
  plugin.openSession({ paneId: "h", config: {} });
  plugin.sendMessage("h", "one");
  plugin.sendMessage("h", "two");
  const body = JSON.parse(fetchCalls[1].body);
  // turn 2 sees: user one, assistant ack, user two
  assert(body.messages.length === 3, "3 messages replayed, got " + body.messages.length);
  assert(body.messages[0].content === "one", "history[0]");
  assert(body.messages[1].role === "assistant" && body.messages[1].content === "ack", "history[1]");
  assert(body.messages[2].content === "two", "history[2]");
});

test("fetch error becomes a system message, transcript still polls", () => {
  reset({ model: "m" });
  fetchHandler = () => JSON.stringify({ error: "connection refused" });
  plugin.openSession({ paneId: "e", config: {} });
  plugin.sendMessage("e", "hi");
  const p = plugin.poll("e", null);
  assert(p.messages.length === 2, "user + system error, got " + p.messages.length);
  assert(p.messages[1].type === "system", "error is system typed");
  assert(/connection refused/.test(p.messages[1].content), "error surfaced");
});

test("HTTP >= 400 becomes a system message", () => {
  reset({ model: "m" });
  fetchHandler = () => JSON.stringify({ status: 500, body: "boom" });
  plugin.openSession({ paneId: "x", config: {} });
  plugin.sendMessage("x", "hi");
  const p = plugin.poll("x", null);
  assert(p.messages[1].type === "system" && /HTTP 500/.test(p.messages[1].content), "http error");
});

test("listModels GETs /v1/models and maps id -> {id, displayName}", () => {
  reset({ baseUrl: "http://localhost:1234" });
  fetchHandler = (opts) => {
    assert(opts.method === "GET", "GET");
    assert(opts.url === "http://localhost:1234/v1/models", "models url, got " + opts.url);
    return JSON.stringify({
      status: 200,
      body: JSON.stringify({ data: [{ id: "llama-3" }, { id: "qwen2.5" }, { bogus: true }] }),
    });
  };
  const models = plugin.listModels();
  assert(models.length === 2, "two valid models, got " + models.length);
  assert(models[0].id === "llama-3" && models[0].displayName === "llama-3", "first model");
  assert(models[1].id === "qwen2.5", "second model");
});

test("closeSession drops the session; poll on unknown is empty", () => {
  reset();
  plugin.openSession({ paneId: "z", config: {} });
  plugin.closeSession("z");
  const p = plugin.poll("z", "0");
  assert(p.messages.length === 0, "no messages after close");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (err) { failed += 1; console.error(`✗ ${name}`); console.error(err); }
}
console.log(`lmstudio plugin: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
