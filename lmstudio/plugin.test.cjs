// Plugin-side tests for the LM Studio open agent shell.
// Run: node lmstudio/plugin.test.cjs

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const fetchCalls = [];
const streamCalls = [];
const streamJobs = [];
const execCalls = [];
let settingsObj = {};
let fetchHandler = () => JSON.stringify({ error: "no fetch handler set" });

globalThis.host = {
  settingsJson: () => JSON.stringify(settingsObj),
  fetch: (optsJson) => {
    const opts = JSON.parse(optsJson);
    fetchCalls.push(opts);
    return fetchHandler(opts);
  },
  fetchStream: (optsJson) => {
    const opts = JSON.parse(optsJson);
    streamCalls.push(opts);
    const jobId = `job-${streamJobs.length}`;
    streamJobs.push({ jobId, polls: [], closed: false });
    return JSON.stringify({ jobId });
  },
  fetchStreamPoll: (jobId) => {
    const job = streamJobs.find((j) => j.jobId === jobId);
    if (!job) return JSON.stringify({ chunks: [], done: true, error: "unknown job" });
    const next = job.polls.shift() || { chunks: [], done: true, status: 200 };
    return JSON.stringify(next);
  },
  fetchStreamClose: (jobId) => {
    const job = streamJobs.find((j) => j.jobId === jobId);
    if (job) job.closed = true;
  },
  exec: (optsJson) => {
    const opts = JSON.parse(optsJson);
    execCalls.push(opts);
    return JSON.stringify({ code: 0, stdout: "pane-1\npane-2\n", stderr: "" });
  },
  readFile: (path) => `file:${path}`,
  writeFile: () => true,
  mem: (optsJson) => JSON.stringify({ results: [{ title: "memory", body: optsJson }] }),
  agent: {
    spawn: (optsJson) => JSON.stringify({ sessionId: "agent-1", opts: JSON.parse(optsJson) }),
  },
  worker: {
    start: (optsJson) => JSON.stringify({ jobId: "worker-1", opts: JSON.parse(optsJson) }),
  },
  log: () => {},
};

function loadPlugin() {
  const source = readFileSync(join(__dirname, "plugin.js"), "utf8");
  const module = { exports: {} };
  const context = vm.createContext({
    host: globalThis.host,
    module,
    exports: module.exports,
    globalThis: { host: globalThis.host },
  });
  vm.runInContext(source, context, { filename: "plugin.js" });
  return module.exports.default;
}

const plugin = loadPlugin();

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function reset(settings) {
  fetchCalls.length = 0;
  streamCalls.length = 0;
  streamJobs.length = 0;
  execCalls.length = 0;
  settingsObj = settings || {};
  fetchHandler = () => JSON.stringify({ error: "no fetch handler set" });
}

function pumpUntilDone(sessionId, limit = 50) {
  for (let i = 0; i < limit; i += 1) {
    plugin.pump(sessionId);
    const p = plugin.poll(sessionId, null);
    if (p.done) return p;
  }
  throw new Error("session did not finish within pump limit");
}

function enqueueStream(jobIndex, polls) {
  const job = streamJobs[jobIndex];
  assert(job, "missing stream job " + jobIndex);
  job.polls.push(...polls);
}

function contents(messages, type) {
  return messages.filter((m) => m.type === type).map((m) => m.content);
}

test("openSession with systemPrompt seeds a system_prompt message", () => {
  reset({ baseUrl: "http://localhost:1234", defaultPreset: "codeterm", presets: [] });
  const r = plugin.openSession({
    paneId: "pane-system",
    config: {},
    systemPrompt: "You answer only in rhymes.",
    model: "ctx-model",
  });
  assert(r.sessionId === "pane-system", "sessionId echoes paneId");

  const p = plugin.poll("pane-system", null);
  assert(p.messages.length === 1, "one seed message, got " + p.messages.length);
  assert(p.messages[0].type === "system_prompt", "seed type, got " + p.messages[0].type);
  assert(p.messages[0].content === "You answer only in rhymes.", "seed content");
});

test("sendMessage streams a growing assistant message with one stable id", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ paneId: "stream", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("stream", "hello");

  assert(streamCalls.length === 1, "stream started");
  const body = JSON.parse(streamCalls[0].body);
  assert(streamCalls[0].url === "http://localhost:1234/api/v1/chat", "native v1 url");
  assert(body.model === "llama", "model from settings");
  assert(body.system_prompt === "sys", "system prompt sent");
  assert(body.input === "hello", "input is user text");

  enqueueStream(0, [
    { chunks: ["Hel"], done: false, status: 200 },
    { chunks: ["lo 🌍"], done: false, status: 200 },
    { chunks: [], done: true, status: 200, body: JSON.stringify({ response_id: "resp-1" }) },
  ]);

  plugin.pump("stream");
  let p = plugin.poll("stream", null);
  const partial = p.messages.find((m) => m.type === "assistant");
  assert(partial && partial.content === "Hel", "first partial content");
  const id = partial.id;
  const cursor = p.cursor;

  plugin.pump("stream");
  p = plugin.poll("stream", cursor);
  assert(p.messages.length === 1, "one streaming delta, got " + p.messages.length);
  assert(p.messages[0].id === id, "assistant id is stable");
  assert(p.messages[0].content === "Hello 🌍", "grown content includes multibyte char");

  plugin.pump("stream");
  p = plugin.poll("stream", null);
  assert(p.done === true, "turn done");
  assert(streamJobs[0].closed === true, "stream closed");
});

test("codeterm-tool exec block runs host.exec, appends tool_result, then continues to final answer", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ paneId: "react", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("react", "list panes");

  enqueueStream(0, [
    {
      chunks: [
        "I'll check.\n```codeterm-tool\n",
        "{\"tool\":\"exec\",\"args\":{\"cmd\":\"codeterm pane list\",\"cwd\":\"/tmp\"}}\n```",
      ],
      done: true,
      status: 200,
      body: JSON.stringify({ response_id: "resp-tool" }),
    },
  ]);
  plugin.pump("react");

  assert(execCalls.length === 1, "host.exec called once");
  assert(
    execCalls[0].bin === "sh" && execCalls[0].args.some((arg) => String(arg).includes("codeterm pane list")),
    "exec shell call shape",
  );
  let p = plugin.poll("react", null);
  const toolResults = contents(p.messages, "tool_result");
  assert(toolResults.length === 1, "one tool_result");
  assert(toolResults[0].includes("pane-1"), "tool stdout surfaced");

  assert(streamCalls.length === 2, "continuation stream started");
  const continuation = JSON.parse(streamCalls[1].body);
  assert(continuation.previous_response_id === "resp-tool", "uses LM Studio previous_response_id");
  assert(/tool_result/.test(continuation.input), "tool result passed as continuation input");

  enqueueStream(1, [
    { chunks: ["You have pane-1 and pane-2."], done: true, status: 200, body: JSON.stringify({ response_id: "resp-final" }) },
  ]);
  pumpUntilDone("react");
  p = plugin.poll("react", null);
  const assistants = contents(p.messages, "assistant");
  assert(assistants[assistants.length - 1] === "You have pane-1 and pane-2.", "final answer");
});

test("iteration cap stops after 8 tool rounds", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ paneId: "cap", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("cap", "loop");

  for (let i = 0; i < 9; i += 1) {
    enqueueStream(i, [
      {
        chunks: ["```codeterm-tool\n{\"tool\":\"exec\",\"args\":{\"cmd\":\"echo loop\"}}\n```"],
        done: true,
        status: 200,
        body: JSON.stringify({ response_id: `resp-${i}` }),
      },
    ]);
    plugin.pump("cap");
  }

  const p = plugin.poll("cap", null);
  assert(execCalls.length === 8, "exec capped at 8, got " + execCalls.length);
  assert(p.done === true, "session marked done at cap");
  const systems = contents(p.messages, "system");
  assert(systems.some((m) => /tool round cap/i.test(m)), "cap system message present");
});

test("iteration cap clears queued continuations and emits one cap message", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ paneId: "cap-clear", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("cap-clear", "loop");

  for (let i = 0; i < 7; i += 1) {
    enqueueStream(i, [
      {
        chunks: ["```codeterm-tool\n{\"tool\":\"exec\",\"args\":{\"cmd\":\"echo loop\"}}\n```"],
        done: true,
        status: 200,
        body: JSON.stringify({ response_id: `resp-${i}` }),
      },
    ]);
    plugin.pump("cap-clear");
  }

  assert(streamCalls.length === 8, "stream 8 is waiting for the cap-triggering response");
  enqueueStream(7, [
    {
      chunks: [
        "```codeterm-tool\n{\"tool\":\"exec\",\"args\":{\"cmd\":\"echo eighth\"}}\n```\n",
        "```codeterm-tool\n{\"tool\":\"exec\",\"args\":{\"cmd\":\"echo ninth\"}}\n```",
      ],
      done: true,
      status: 200,
      body: JSON.stringify({ response_id: "resp-cap" }),
    },
  ]);
  plugin.pump("cap-clear");
  plugin.pump("cap-clear");
  plugin.pump("cap-clear");

  const p = plugin.poll("cap-clear", null);
  const capMessages = contents(p.messages, "system").filter((m) => /tool round cap/i.test(m));
  assert(execCalls.length === 8, "only eighth tool executed before cap, got " + execCalls.length);
  assert(capMessages.length === 1, "exactly one cap message, got " + capMessages.length);
  assert(streamCalls.length === 8, "no extra continuation stream after cap, got " + streamCalls.length);
  assert(p.done === true, "session done after cap");
});

test("fallback assembled context includes one final assistant entry per turn", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ paneId: "fallback-context", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("fallback-context", "first");

  enqueueStream(0, [
    { chunks: ["Hel"], done: false, status: 200 },
    { chunks: ["lo"], done: true, status: 200 },
  ]);
  plugin.pump("fallback-context");
  plugin.pump("fallback-context");

  plugin.sendMessage("fallback-context", "second");
  assert(streamCalls.length === 2, "second stream started");
  const body = JSON.parse(streamCalls[1].body);
  const assistantEntries = body.input.match(/^assistant:/gm) || [];
  assert(assistantEntries.length === 1, "one assistant entry, got " + assistantEntries.length + "\n" + body.input);
  assert(body.input.includes("assistant: Hello"), "final assistant content included");
  assert(!body.input.includes("assistant: Hel\n"), "partial assistant content omitted");
});

test("codeterm-tool fences execute only when trailing", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ paneId: "middle-fence", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("middle-fence", "explain protocol");
  enqueueStream(0, [
    {
      chunks: [
        "Example:\n```codeterm-tool\n{\"tool\":\"exec\",\"args\":{\"cmd\":\"echo should-not-run\"}}\n```\nThen I explain it.",
      ],
      done: true,
      status: 200,
      body: JSON.stringify({ response_id: "resp-middle" }),
    },
  ]);
  plugin.pump("middle-fence");
  let p = plugin.poll("middle-fence", null);
  assert(execCalls.length === 0, "middle explanatory fence did not execute");
  assert(p.done === true, "middle explanatory fence ends turn");

  plugin.openSession({ paneId: "trailing-fence", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("trailing-fence", "run trailing");
  enqueueStream(1, [
    {
      chunks: [
        "Running it now.\n```codeterm-tool\n{\"tool\":\"exec\",\"args\":{\"cmd\":\"echo trailing\"}}\n```",
      ],
      done: true,
      status: 200,
      body: JSON.stringify({ response_id: "resp-trailing" }),
    },
  ]);
  plugin.pump("trailing-fence");
  p = plugin.poll("trailing-fence", null);
  assert(execCalls.length === 1, "trailing fence executed once");
  assert(contents(p.messages, "tool_result").length === 1, "trailing fence produced tool_result");
});

test("malformed trailing tool fence appends parse-error tool_result", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ paneId: "bad-json", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("bad-json", "bad tool");
  enqueueStream(0, [
    {
      chunks: ["```codeterm-tool\n{\"tool\":\"exec\",\"args\":\n```"],
      done: true,
      status: 200,
      body: JSON.stringify({ response_id: "resp-bad-json" }),
    },
  ]);
  plugin.pump("bad-json");

  const p = plugin.poll("bad-json", null);
  const results = contents(p.messages, "tool_result");
  assert(results.length === 1, "parse error produces one tool_result");
  assert(/parse/i.test(results[0]) && /error/i.test(results[0]), "parse-error surfaced: " + results[0]);
  assert(streamCalls.length === 2, "parse-error tool_result continues the loop for retry");
});

test("listPresets returns configured presets and listModels uses /api/v1/models", () => {
  reset({
    baseUrl: "http://localhost:1234/",
    defaultPreset: "codeterm",
    presets: [
      { id: "codeterm", name: "CodeTerm", systemPrompt: "sys" },
      { id: "rhymes", name: "Rhymes", systemPrompt: "rhyme" },
    ],
  });
  const presets = plugin.listPresets();
  assert(presets.length === 2 && presets[1].id === "rhymes", "configured presets");

  fetchHandler = (opts) => {
    assert(opts.method === "GET", "GET");
    assert(opts.url === "http://localhost:1234/api/v1/models", "native models url, got " + opts.url);
    return JSON.stringify({
      status: 200,
      body: JSON.stringify({ data: [{ id: "llama-3" }, { id: "qwen2.5" }, { bogus: true }] }),
    });
  };
  const models = plugin.listModels();
  assert(models.length === 2, "two valid models");
  assert(models[0].id === "llama-3" && models[0].displayName === "llama-3", "first model");
});

test("settings schema and config expose presets/defaultPreset", () => {
  const schema = JSON.parse(readFileSync(join(__dirname, "settings.schema.json"), "utf8"));
  const schemaText = JSON.stringify(schema);
  assert(schemaText.includes("baseUrl"), "schema exposes baseUrl");
  assert(schemaText.includes("defaultPreset"), "schema exposes defaultPreset");
  assert(schemaText.includes("presets"), "schema exposes presets");

  const config = readFileSync(join(__dirname, "config.yaml"), "utf8");
  assert(/defaultPreset:\s*codeterm/.test(config), "config has defaultPreset");
  assert(/systemPrompt:\s*\|/.test(config), "config seeds block systemPrompt");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (err) { failed += 1; console.error(`✗ ${name}`); console.error(err); }
}
console.log(`lmstudio plugin: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
