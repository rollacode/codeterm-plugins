// Plugin-side tests for the LM Studio open agent shell.
// Run: node lmstudio/plugin.test.cjs

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const fetchCalls = [];
const asyncFetchJobs = [];
let nextAsyncFetchJob = 0;
const streamCalls = [];
const streamJobs = [];
const execCalls = [];
const execJobs = [];
const toolParseCalls = [];
const fileStore = {};
// R6 prompt-authoring hand-off (host.workspace + host.agent spawn/send/poll/reap).
const workspaceCalls = [];
const agentSpawns = [];
const agentSends = [];
const agentReaps = [];
const agentPollCalls = [];
// Queue of poll responses the next ticket hands back, in order; null/empty → an
// immediate done carrying `agentReply`.
let agentPolls = null;
let agentReply = "DRAFTED PROMPT";
let pendingExecPolls = null;
// When set, host.toolcall.parse returns this verbatim (a tri-state JSON string)
// or, if a function, calls it (used to simulate the native parser throwing).
let forceParse = null;
let settingsObj = {};
let fetchHandler = () => JSON.stringify({ error: "no fetch handler set" });
let asyncFetchHandler = () => ({ status: 500, error: "no async fetch handler set" });
const lastModelPath = "/tmp/codeterm-home/.codeterm/plugin-data/lmstudio/last-model.json";

function parseLooseJson(raw) {
  const attempts = [
    raw,
    raw.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$-]*)(\s*:)/g, '$1"$2"$3').replace(/'/g, '"'),
  ];
  for (const attempt of attempts) {
    try { return JSON.parse(attempt); } catch {}
  }
  return null;
}

function normalizeCall(tool, args, schema) {
  const spec = (schema.tools || []).find((t) => t.name === tool);
  if (!spec || !args || typeof args !== "object" || Array.isArray(args)) return null;
  const allowed = new Set([...(spec.args || []), ...(spec.optional || [])]);
  const normalized = {};
  for (const [key, value] of Object.entries(args)) {
    const to = schema.aliases && schema.aliases[key] ? schema.aliases[key] : key;
    if (allowed.has(to)) normalized[to] = value;
  }
  if (!(spec.args || []).every((key) => Object.prototype.hasOwnProperty.call(normalized, key))) return null;
  return { tool, args: normalized };
}

function candidateFromObject(value, schema) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Array.isArray(value.tool_calls) && value.tool_calls[0] && value.tool_calls[0].function) {
    const fn = value.tool_calls[0].function;
    const args = typeof fn.arguments === "string" ? parseLooseJson(fn.arguments) : fn.arguments;
    return normalizeCall(fn.name, args || {}, schema);
  }
  return normalizeCall(value.tool || value.name, value.args || value.arguments || {}, schema);
}

function mockToolcallParse(rawText, schemaJson) {
  toolParseCalls.push({ rawText, schemaJson });
  if (typeof forceParse === "function") return forceParse(rawText, schemaJson);
  if (forceParse !== null) return forceParse;
  const schema = JSON.parse(schemaJson);
  const candidates = [];
  const addJsonCandidate = (text, offset, confidence) => {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first < 0 || last < first) return;
    const object = parseLooseJson(text.slice(first, last + 1));
    const call = candidateFromObject(object, schema);
    if (call) candidates.push({ ...call, confidence, span: [offset + first, offset + last + 1] });
  };

  const fenceRe = /```[^\r\n`]*\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = fenceRe.exec(rawText)) !== null) addJsonCandidate(match[1], match.index + match[0].indexOf(match[1]), 0.9);

  const nativeRe = /call\s*[:=]\s*((?:[A-Za-z_][A-Za-z0-9_.-]*\s*:\s*)*[A-Za-z_][A-Za-z0-9_.-]*)\s*(\{[\s\S]*?\})/g;
  while ((match = nativeRe.exec(rawText)) !== null) {
    const tool = match[1].split(":").pop().trim();
    const args = parseLooseJson(match[2]);
    const call = normalizeCall(tool, args || {}, schema);
    if (call) candidates.push({ ...call, confidence: 0.92, span: [match.index, match.index + match[0].length] });
  }

  addJsonCandidate(rawText, 0, 0.86);
  // Tri-state contract (R8a): a valid call -> {status:"ok",...}; no tool-call
  // syntax at all -> {status:"none"}. (The malformed branch is exercised via
  // forceParse, since this simplified parser can't reliably reproduce it.)
  if (!candidates.length) return JSON.stringify({ status: "none" });
  candidates.sort((a, b) => b.confidence - a.confidence);
  return JSON.stringify({ status: "ok", ...candidates[0] });
}

function mockHostFetch(optsJson) {
  const opts = JSON.parse(optsJson);
  fetchCalls.push(opts);
  return fetchHandler(opts);
}
mockHostFetch.async = (opts, then) => {
  fetchCalls.push(opts);
  const jobId = `fetch-${nextAsyncFetchJob++}`;
  const continuationId = String(nextAsyncFetchJob);
  asyncFetchJobs.push({ jobId, continuationId, opts, then, resumed: false });
  // Match host.awaitJob: the export yields now; the host invokes `then` only
  // after the job finishes and serializes whatever that continuation returns.
  return { __ctAwait__: { job: jobId, k: continuationId } };
};

const secretStore = {};
const existingPaths = new Set();
let tabCwdForTests = "";
const logLines = [];
globalThis.host = {
  homeDir: () => "/tmp/codeterm-home",
  secretGet: (name) => (Object.prototype.hasOwnProperty.call(secretStore, name) ? secretStore[name] : null),
  secretSet: (name, value) => {
    secretStore[name] = value;
    return true;
  },
  secretDelete: (name) => {
    delete secretStore[name];
    return true;
  },
  log: (level, message) => logLines.push(`${level}: ${message}`),
  makeDirs: () => true,
  settingsJson: () => JSON.stringify(settingsObj),
  fetch: mockHostFetch,
  fetchStream: (optsJson) => {
    const opts = JSON.parse(optsJson);
    streamCalls.push(opts);
    const jobId = `job-${streamJobs.length}`;
    streamJobs.push({ jobId, polls: [], closed: false, live: /\/event\?/.test(opts.url) });
    return JSON.stringify({ jobId });
  },
  fetchStreamPoll: (jobId) => {
    const job = streamJobs.find((j) => j.jobId === jobId);
    if (!job) return JSON.stringify({ chunks: [], done: true, error: "unknown job" });
    const next = job.polls.shift() || (job.live && !job.closed ? { chunks: [], done: false, status: 200 } : { chunks: [], done: true, status: 200 });
    return JSON.stringify(next);
  },
  fetchStreamClose: (jobId) => {
    const job = streamJobs.find((j) => j.jobId === jobId);
    if (job) job.closed = true;
  },
  exec: (optsJson) => {
    const opts = JSON.parse(optsJson);
    execCalls.push(opts);
    if (opts.detach) return JSON.stringify({ code: 0, pid: 4242 });
    const line = opts.args ? opts.args[opts.args.length - 1] : "";
    if (/codeterm tab inspect/.test(line)) return JSON.stringify({ code: 0, stdout: JSON.stringify([{ id: "x", cwd: tabCwdForTests }]), stderr: "" });
    return JSON.stringify({ code: 0, stdout: "pane-1\npane-2\n", stderr: "" });
  },
  fileExists: (path) => existingPaths.has(path) || Object.prototype.hasOwnProperty.call(fileStore, path),
  // Async exec: start returns a jobId, poll drains queued responses (or a
  // default done) just like the fetch-stream job-id/poll shape.
  execStart: (optsJson) => {
    const opts = JSON.parse(optsJson);
    execCalls.push(opts);
    const jobId = `exec-${execJobs.length}`;
    execJobs.push({ jobId, polls: pendingExecPolls || [], closed: false });
    pendingExecPolls = null;
    return JSON.stringify({ jobId });
  },
  execPoll: (jobId) => {
    const job = execJobs.find((j) => j.jobId === jobId);
    if (!job) return JSON.stringify({ done: true, error: "unknown exec job" });
    const next = job.polls.shift();
    if (next) return JSON.stringify(next);
    return JSON.stringify({ done: true, code: 0, stdout: "pane-1\npane-2\n", stderr: "" });
  },
  execClose: (jobId) => {
    const job = execJobs.find((j) => j.jobId === jobId);
    if (job) job.closed = true;
  },
  readFile: (path) => Object.prototype.hasOwnProperty.call(fileStore, path) ? fileStore[path] : null,
  writeFile: (path, contents) => {
    fileStore[path] = contents;
    return true;
  },
  mem: (optsJson) => JSON.stringify({ results: [{ title: "memory", body: optsJson }] }),
  // Real host compute base shape (host.ts): object returns, sync per step.
  workspace: {
    ensure: (opts) => {
      workspaceCalls.push(opts);
      return { workspaceId: "ws-author" };
    },
    panes: () => [],
  },
  agent: {
    spawn: (workspaceId, opts) => {
      agentSpawns.push({ workspaceId, opts });
      return { sessionId: `agent-${agentSpawns.length}` };
    },
    send: (sessionId, text) => {
      agentSends.push({ sessionId, text });
      return { ticket: `ticket-${agentSends.length}` };
    },
    poll: (ticket) => {
      agentPollCalls.push(ticket);
      if (agentPolls && agentPolls.length) return agentPolls.shift();
      return { done: true, reply: agentReply };
    },
    reap: (sessionId) => {
      agentReaps.push(sessionId);
    },
  },
  worker: {
    start: (optsJson) => JSON.stringify({ jobId: "worker-1", opts: JSON.parse(optsJson) }),
  },
  toolcall: {
    parse: mockToolcallParse,
  },
  toolcallParse: mockToolcallParse,
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
const DOMIOS_CONTEXT = plugin.__test_domiosContext;
// The wire system prompt is the Domios context fragment followed by the session's own prompt.
const withContext = (prompt) => (prompt ? DOMIOS_CONTEXT + "\n\n" + prompt : DOMIOS_CONTEXT);
const ownPrompt = (system) => (typeof system === "string" && system.indexOf(DOMIOS_CONTEXT + "\n\n") === 0 ? system.slice(DOMIOS_CONTEXT.length + 2) : system);

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function reset(settings) {
  fetchCalls.length = 0;
  asyncFetchJobs.length = 0;
  nextAsyncFetchJob = 0;
  streamCalls.length = 0;
  streamJobs.length = 0;
  execCalls.length = 0;
  execJobs.length = 0;
  toolParseCalls.length = 0;
  workspaceCalls.length = 0;
  agentSpawns.length = 0;
  agentSends.length = 0;
  agentReaps.length = 0;
  agentPollCalls.length = 0;
  agentPolls = null;
  agentReply = "DRAFTED PROMPT";
  pendingExecPolls = null;
  forceParse = null;
  // The legacy relay path; engine tests opt into OpenCode explicitly.
  settingsObj = Object.assign({ engine: "relay" }, settings || {});
  for (const key of Object.keys(fileStore)) delete fileStore[key];
  for (const key of Object.keys(secretStore)) delete secretStore[key];
  logLines.length = 0;
  if (plugin && plugin.__test_resetRouter) plugin.__test_resetRouter();
  fetchHandler = () => JSON.stringify({ error: "no fetch handler set" });
  asyncFetchHandler = () => ({ status: 500, error: "no async fetch handler set" });
}

// Queue the poll responses the in-flight authoring ticket hands back, in order.
function enqueueAgentPoll(polls) {
  agentPolls = polls.slice();
}

// Seed the poll responses the NEXT host.exec.start job will hand back, in order.
// Empty/unset → execPoll returns an immediate done with default stdout.
function enqueueExec(polls) {
  pendingExecPolls = polls.slice();
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

function assertJsonEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${msg}\nactual: ${a}\nexpected: ${e}`);
}

function settleFetchExport(value, method) {
  assert(
    value && typeof value === "object" && value.__ctAwait__ &&
      Object.keys(value).length === 1 &&
      typeof value.__ctAwait__.job === "string" && typeof value.__ctAwait__.k === "string",
    method + " returns the host.fetch.async await marker before a result exists",
  );
  let result = value;
  let resumed = 0;
  while (result && typeof result === "object" && result.__ctAwait__) {
    assert(resumed++ < 20, method + " exceeded async continuation limit");
    const marker = result.__ctAwait__;
    const job = asyncFetchJobs.find((entry) =>
      entry.jobId === marker.job && entry.continuationId === marker.k,
    );
    assert(job && !job.resumed, method + " returned an unknown or already-resumed fetch marker");
    job.resumed = true;
    result = job.then(asyncFetchHandler(job.opts));
  }
  assert(asyncFetchJobs.every((job) => job.resumed), method + " left a fetch continuation unawaited");
  return result;
}

function decide(request) {
  return settleFetchExport(plugin.decide(request), "decision export");
}

function decisionModels() {
  return settleFetchExport(plugin.models(), "models export");
}

// The engine owns the verdict-contract wording; this plugin owns only the fact
// that a machine turn renders assembleMachine's two messages as one string,
// carrying THIS caller's charter and state. Copying the engine's prose here made
// the suite fail on an engine rewrite while proving nothing about the plugin.
function assertMachineInput(input, charter, state, tickInput, name) {
  assert(typeof input === "string", name + ": transport input must be a string");
  assert(
    input.indexOf("system: " + charter + "\n\n") === 0,
    name + ": the system message must open with the caller's charter",
  );
  const tail = "user: " + JSON.stringify({ state: state, input: tickInput });
  assert(
    input.length >= tail.length && input.substring(input.length - tail.length) === tail,
    name + ": the user message must round-trip the caller's state and input",
  );
}

function assertMachineMessages(messages, charter, state, tickInput, name) {
  assert(Array.isArray(messages) && messages.length === 2, name + ": expected a system and a user message");
  assert(messages[0].role === "system" && messages[1].role === "user", name + ": roles are system then user");
  assert(
    String(messages[0].content).indexOf(charter) === 0,
    name + ": the system message must open with the caller's charter",
  );
  assertJsonEqual(JSON.parse(messages[1].content), { state: state, input: tickInput }, name + ": state and input round-trip");
}

function renderEngineMessages(messages) {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
}

function decisionFixture(name) {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", "decision", name), "utf8"));
}

function decisionRequest(question, instructions = "Evaluate the supplied state.") {
  return { state: { candidate: "fixture" }, instructions, question };
}

function closeTo(actual, expected, message) {
  assert(Math.abs(actual - expected) < 1e-10, `${message}: expected ${expected}, got ${actual}`);
}

function openAndStartBody(ctx) {
  plugin.openSession(ctx);
  plugin.sendMessage(ctx.tabId, "hello");
  assert(streamCalls.length === 1, "stream started for " + ctx.tabId);
  return JSON.parse(streamCalls[0].body);
}

// ── SSE builders: native /api/v1/chat emits `event: <name>` + `data: {json}`
//    blocks separated by blank lines. The answer is the message.* deltas;
//    reasoning.* is the model's private thinking; chat.end carries response_id.
function sse(type, extra) {
  return `event: ${type}\ndata: ${JSON.stringify(Object.assign({ type }, extra || {}))}\n\n`;
}
function msg(text) { return sse("message.delta", { content: text }); }
function reasoning(text) { return sse("reasoning.delta", { content: text }); }
function chatEnd(responseId) {
  return `event: chat.end\ndata: ${JSON.stringify({ type: "chat.end", result: { response_id: responseId } })}\n\n`;
}
// One self-contained streamed turn: optional reasoning, an answer, terminal chat.end.
function turn(answer, responseId) {
  return msg(answer) + chatEnd(responseId);
}

test("openSession seeds the system prompt as a user message carrying the system_prompt marker", () => {
  reset({ baseUrl: "http://localhost:1234", defaultPreset: "codeterm", presets: [] });
  const r = plugin.openSession({
    tabId: "pane-system",
    config: {},
    systemPrompt: "You answer only in rhymes.",
    model: "ctx-model",
  });
  assert(r.sessionId === "pane-system", "sessionId echoes tabId");

  const p = plugin.poll("pane-system", null);
  assert(p.messages.length === 1, "one seed message, got " + p.messages.length);
  // H1: system_prompt is not a valid ChatMessageKind — it must ride on a
  // type:'user' message via the -=-codeterm:system_prompt-=- marker so the
  // chatPrefixes detector renders the collapsible 'System prompt' card.
  assert(p.messages[0].type === "user", "seed type is user, got " + p.messages[0].type);
  assert(
    p.messages[0].content.startsWith("-=-codeterm:system_prompt-=-"),
    "seed carries the system_prompt marker, got " + p.messages[0].content,
  );
  assert(
    p.messages[0].content.includes("You answer only in rhymes."),
    "seed payload is the system prompt body",
  );
});

test("lmstudio_open_session_uses_session_config_system_prompt_and_model", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"));
  assert(manifest.capabilities.chatBackend.sessionConfig === true, "chatBackend declares sessionConfig support");
  assert(manifest.capabilities.decisionModel === true, "decisionModel remains in the backward-compatible bare form");
  assert(manifest.hostApi === 2, "manifest remains compatible with host API 2");
  assert(manifest.minCodeterm === "1.12.4", "manifest agentVerbs need a host that accepts the field (newer than 1.12.3)");
  const endpoint = "http://eight.tail0e459c.ts.net:1234";
  reset({ baseUrl: endpoint, model: "settings-model", defaultPreset: "codeterm", presets: [] });
  const ctx = {
    tabId: "session-config",
    config: {},
    systemPrompt: "Host-composed system prompt",
    model: "host-selected-model",
  };

  const body = openAndStartBody(ctx);
  assert(body.model === "host-selected-model", "openSession uses the model from host session config");
  assert(ownPrompt(body.system_prompt) === "Host-composed system prompt", "openSession uses the system prompt from host session config");
  assert(
    streamCalls[0].url === `${endpoint}/api/v1/chat`,
    "chat request uses the configured server address",
  );
});

test("sendMessage sends stream:true and streams a growing assistant message with one stable id", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "stream", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("stream", "hello");

  assert(streamCalls.length === 1, "stream started");
  const body = JSON.parse(streamCalls[0].body);
  assert(streamCalls[0].url === "http://localhost:1234/api/v1/chat", "native v1 url");
  assert(body.model === "llama", "model from settings");
  assert(ownPrompt(body.system_prompt) === "sys", "system prompt sent");
  assert(body.input === "hello", "input is user text");
  assert(body.stream === true, "stream:true requested");

  // Multibyte char (🌍 = surrogate pair) AND the data: JSON are split across
  // chunk boundaries — the parser must buffer and only parse complete events.
  enqueueStream(0, [
    { chunks: [msg("Hel")], done: false, status: 200 },
    {
      chunks: [
        'event: message.delta\ndata: {"type":"message.delta","content":"lo \uD83C',
        '\uDF0D"}\n\n' + chatEnd("resp-1"),
      ],
      done: false,
      status: 200,
    },
    { chunks: [], done: true, status: 200 },
  ]);

  plugin.pump("stream");
  let p = plugin.poll("stream", null);
  const partial = p.messages.find((m) => m.type === "assistant");
  assert(partial && partial.content === "Hel", "first partial content, got " + (partial && partial.content));
  const id = partial.id;
  const cursor = p.cursor;

  plugin.pump("stream");
  p = plugin.poll("stream", cursor);
  const grown = p.messages.find((m) => m.type === "assistant");
  assert(grown && grown.id === id, "assistant id is stable");
  assert(grown.content === "Hello 🌍", "grown content includes multibyte char, got " + (grown && grown.content));
  assert(!/event:/.test(grown.content), "no raw SSE event lines in answer");
  assert(!/"type"/.test(grown.content), "no raw JSON in answer");

  plugin.pump("stream");
  p = plugin.poll("stream", null);
  assert(p.done === true, "turn done");
  assert(streamJobs[0].closed === true, "stream closed");
});

test("reasoning is surfaced as a type:'thinking' message, never mixed into the answer", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "reason", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("reason", "think then answer");

  enqueueStream(0, [
    {
      chunks: [
        sse("reasoning.start", {}) +
          reasoning("Let me ") +
          reasoning("think.") +
          sse("reasoning.end", {}) +
          sse("message.start", {}) +
          msg("Final answer.") +
          sse("message.end", {}) +
          chatEnd("resp-reason"),
      ],
      done: true,
      status: 200,
    },
  ]);
  plugin.pump("reason");
  const p = plugin.poll("reason", null);

  const assistants = contents(p.messages, "assistant");
  assert(assistants.length >= 1, "an assistant message exists");
  assert(assistants[assistants.length - 1] === "Final answer.", "answer is clean, got " + assistants[assistants.length - 1]);
  assert(!/Let me think/.test(assistants[assistants.length - 1]), "reasoning not mixed into answer");

  // H1: 'reasoning' is not a valid ChatMessageKind; 'thinking' is rendered by
  // MessageBubble as a collapsed thinking block.
  assert(contents(p.messages, "reasoning").length === 0, "no invalid 'reasoning' kind emitted");
  const thinking = contents(p.messages, "thinking");
  assert(thinking.length >= 1, "reasoning surfaced as a thinking entry");
  assert(thinking[thinking.length - 1] === "Let me think.", "thinking text captured, got " + thinking[thinking.length - 1]);
});

test("append upserts by id: streaming reasoning+answer collapse to exactly one entry each", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "upsert", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("upsert", "go");

  // Reasoning and answer each arrive across multiple poll cycles. The buggy
  // append() pushed a fresh entry per chunk (measured 31x); upsert-by-id must
  // keep exactly one growing entry whose content is replaced in place.
  enqueueStream(0, [
    { chunks: [reasoning("a")], done: false, status: 200 },
    { chunks: [reasoning("b")], done: false, status: 200 },
    { chunks: [reasoning("c") + msg("X")], done: false, status: 200 },
    { chunks: [msg("Y")], done: false, status: 200 },
    { chunks: [msg("Z") + chatEnd("resp-upsert")], done: true, status: 200 },
  ]);
  for (let i = 0; i < 7; i += 1) plugin.pump("upsert");

  const p = plugin.poll("upsert", null);
  const thinking = p.messages.filter((m) => m.type === "thinking");
  const assistant = p.messages.filter((m) => m.type === "assistant");
  assert(thinking.length === 1, "exactly one thinking entry across chunks, got " + thinking.length);
  assert(thinking[0].content === "abc", "thinking content replaced in place, got " + thinking[0].content);
  assert(assistant.length === 1, "exactly one assistant entry across chunks, got " + assistant.length);
  assert(assistant[0].content === "XYZ", "assistant content replaced in place, got " + assistant[0].content);
  assert(p.done === true, "turn done");
});

test("empty model auto-resolves to first loaded model via /api/v1/models and caches it", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [] }); // no model configured
  fetchHandler = (opts) => {
    if (/\/api\/v1\/models$/.test(opts.url)) {
      assert(opts.method === "GET", "models probed via GET");
      return JSON.stringify({
        status: 200,
        body: JSON.stringify({
          models: [
            { key: "publisher/unloaded", loaded_instances: [] },
            { key: "google/gemma-4-31b-qat", loaded_instances: [{ id: "google/gemma-4-31b-qat" }] },
          ],
        }),
      });
    }
    return JSON.stringify({ error: "unexpected url " + opts.url });
  };

  plugin.openSession({ tabId: "empty-model", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("empty-model", "hi");

  assert(streamCalls.length === 1, "stream started after resolving model");
  const body = JSON.parse(streamCalls[0].body);
  assert(body.model === "google/gemma-4-31b-qat", "auto-resolved to first loaded model key, got " + body.model);
  assert(fetchCalls.length === 1, "models probed exactly once");

  enqueueStream(0, [{ chunks: [turn("Hi.", "resp-x")], done: true, status: 200 }]);
  pumpUntilDone("empty-model");

  // Second turn must reuse the cached model id without re-probing /models.
  plugin.sendMessage("empty-model", "again");
  assert(streamCalls.length === 2, "second stream started");
  const body2 = JSON.parse(streamCalls[1].body);
  assert(body2.model === "google/gemma-4-31b-qat", "cached model reused, got " + body2.model);
  assert(fetchCalls.length === 1, "no second /models probe, fetchCalls=" + fetchCalls.length);
});

test("codeterm-tool exec block runs host.exec, appends tool_result, then continues to final answer", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "react", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("react", "list panes");

  const answer =
    'I\'ll check.\n```codeterm-tool\n{"tool":"exec","args":{"cmd":"codeterm pane list","cwd":"/tmp"}}\n```';
  enqueueStream(0, [{ chunks: [turn(answer, "resp-tool")], done: true, status: 200 }]);
  plugin.pump("react");

  assert(execCalls.length === 1, "host.exec called once");
  assert(toolParseCalls.length >= 1, "host.toolcall.parse called");
  assert(toolParseCalls[0].rawText === answer, "raw assistant text passed to host parser");
  const schema = JSON.parse(toolParseCalls[0].schemaJson);
  assert(schema.tools.some((t) => t.name === "spawn_agent" && t.args.includes("provider") && t.optional.includes("workspace")), "schema includes curated tools");
  assert(schema.aliases.command === "cmd" && schema.aliases.file === "path", "schema includes arg aliases");
  assert(
    execCalls[0].bin === "sh" && execCalls[0].args.some((arg) => String(arg).includes("codeterm pane list")),
    "exec shell call shape",
  );
  let p = plugin.poll("react", null);
  const toolCalls = p.messages.filter((m) => m.type === "tool_call");
  assert(toolCalls.length === 1, "one structured tool_call");
  assert(toolCalls[0].toolName === "exec", "tool_call names exec");
  assert(toolCalls[0].toolInput.cmd === "codeterm pane list", "tool_call carries structured args");
  const toolResults = contents(p.messages, "tool_result");
  assert(toolResults.length === 1, "one tool_result");
  assert(toolResults[0].includes("pane-1"), "tool stdout surfaced");

  assert(streamCalls.length === 2, "continuation stream started");
  const continuation = JSON.parse(streamCalls[1].body);
  assert(continuation.previous_response_id === "resp-tool", "uses LM Studio previous_response_id");
  assert(/tool_result/.test(continuation.input), "tool result passed as continuation input");

  enqueueStream(1, [{ chunks: [turn("You have pane-1 and pane-2.", "resp-final")], done: true, status: 200 }]);
  pumpUntilDone("react");
  p = plugin.poll("react", null);
  const assistants = contents(p.messages, "assistant");
  assert(assistants[assistants.length - 1] === "You have pane-1 and pane-2.", "final answer");
});

test("exec tool runs async via host.exec.start/poll: pump polls until done, then tool_result + continuation", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "async-exec", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("async-exec", "list panes");

  const answer = 'Checking.\n```codeterm-tool\n{"tool":"exec","args":{"cmd":"sleep 1 && echo done"}}\n```';
  enqueueStream(0, [{ chunks: [turn(answer, "resp-tool")], done: true, status: 200 }]);
  // First poll: command still running; second poll: finished with output. This
  // proves the VM lock is NOT held across the exec — start returns, pump polls.
  enqueueExec([{ done: false }, { done: true, code: 0, stdout: "async-out\n", stderr: "" }]);

  plugin.pump("async-exec"); // finishes stream → starts async exec → first poll not done
  assert(execCalls.length === 1, "host.exec.start called once");
  assert(execCalls[0].bin === "sh", "async exec uses the shell shape");
  let p = plugin.poll("async-exec", null);
  assert(contents(p.messages, "tool_result").length === 0, "no tool_result while exec still running");
  assert(streamCalls.length === 1, "no continuation while exec pending");
  assert(p.done === false, "session not done while exec pending");

  plugin.pump("async-exec"); // second poll: exec done → tool_result + continuation
  p = plugin.poll("async-exec", null);
  const toolResults = contents(p.messages, "tool_result");
  assert(toolResults.length === 1, "tool_result appended after exec completes");
  assert(toolResults[0].includes("async-out"), "async stdout surfaced");
  assert(streamCalls.length === 2, "continuation stream started after exec done");
  const continuation = JSON.parse(streamCalls[1].body);
  assert(continuation.previous_response_id === "resp-tool", "continuation uses previous_response_id");

  enqueueStream(1, [{ chunks: [turn("All done.", "resp-final")], done: true, status: 200 }]);
  pumpUntilDone("async-exec");
  p = plugin.poll("async-exec", null);
  const assistants = contents(p.messages, "assistant");
  assert(assistants[assistants.length - 1] === "All done.", "final answer after async exec");
});

test("iteration cap stops after 8 tool rounds", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "cap", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("cap", "loop");

  const fence = '```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo loop"}}\n```';
  for (let i = 0; i < 9; i += 1) {
    enqueueStream(i, [{ chunks: [turn(fence, `resp-${i}`)], done: true, status: 200 }]);
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
  plugin.openSession({ tabId: "cap-clear", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("cap-clear", "loop");

  const fence = '```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo loop"}}\n```';
  for (let i = 0; i < 7; i += 1) {
    enqueueStream(i, [{ chunks: [turn(fence, `resp-${i}`)], done: true, status: 200 }]);
    plugin.pump("cap-clear");
  }

  assert(streamCalls.length === 8, "stream 8 is waiting for the cap-triggering response");
  const eighth = '```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo eighth"}}\n```';
  const ninth = '```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo ninth"}}\n```';
  enqueueStream(7, [{ chunks: [msg(eighth + "\n" + ninth) + chatEnd("resp-cap")], done: true, status: 200 }]);
  plugin.pump("cap-clear");

  assert(execCalls.length === 8, "eighth tool executed before cap, got " + execCalls.length);
  assert(streamCalls.length === 9, "continuation stream started after eighth tool");
  enqueueStream(8, [{ chunks: [turn(ninth, "resp-cap-2")], done: true, status: 200 }]);
  plugin.pump("cap-clear");
  plugin.pump("cap-clear");

  const p = plugin.poll("cap-clear", null);
  const capMessages = contents(p.messages, "system").filter((m) => /tool round cap/i.test(m));
  assert(execCalls.length === 8, "ninth tool did not execute after cap, got " + execCalls.length);
  assert(capMessages.length === 1, "exactly one cap message, got " + capMessages.length);
  assert(streamCalls.length === 9, "no extra continuation stream after cap, got " + streamCalls.length);
  assert(p.done === true, "session done after cap");
});

test("fallback assembled context includes one final assistant entry per turn", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "fallback-context", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("fallback-context", "first");

  enqueueStream(0, [
    { chunks: [msg("Hel")], done: false, status: 200 },
    { chunks: [msg("lo")], done: true, status: 200 },
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

test("watcher openSession emits the charter card and not the default preset prompt", () => {
  reset({
    baseUrl: "http://localhost:1234",
    model: "llama",
    defaultPreset: "codeterm",
    presets: [{ id: "codeterm", name: "CodeTerm", systemPrompt: "DEFAULT PRESET" }],
  });
  plugin.openSession({
    tabId: "watch-open",
    config: {},
    mode: "watcher",
    engine: { kind: "machine", charter: "WATCH CHARTER" },
  });

  const p = plugin.poll("watch-open", null);
  assert(p.messages.length === 1, "one watcher charter card");
  assert(p.messages[0].type === "user", "charter is rendered through system-prompt marker");
  assert(p.messages[0].content.includes("WATCH CHARTER"), "charter card contains charter");
  assert(!p.messages[0].content.includes("DEFAULT PRESET"), "watcher does not emit preset prompt");
});

test("watcherTick request body has no previous_response_id and renders assembleMachine messages as a string", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  const tick = { tick: 1, nowMs: 123, state: { seen: 0 }, observations: { panes: ["a"] } };
  plugin.openSession({
    tabId: "watch-body",
    config: {},
    mode: "watcher",
    engine: { kind: "machine", charter: "CHECK PROGRESS" },
  });
  plugin.watcherTick("watch-body", tick);

  assert(streamCalls.length === 1, "watcherTick starts one stream");
  const body = JSON.parse(streamCalls[0].body);
  assert(!Object.prototype.hasOwnProperty.call(body, "previous_response_id"), "watcher tick does not chain previous_response_id");
  assert(typeof body.input === "string", "watcher tick transport input is a string");
  assertMachineInput(body.input, "CHECK PROGRESS", tick.state, tick, "watcher body");
});

test("two watcher ticks do not grow context from transcript history", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({
    tabId: "watch-two",
    config: {},
    mode: "watcher",
    engine: { kind: "machine", charter: "WATCH" },
  });
  plugin.watcherTick("watch-two", { tick: 1, nowMs: 1, state: { n: 1 }, observations: { a: 1 } });
  enqueueStream(0, [{ chunks: [turn('{"status":"ok","summary":"one","state":{"n":2},"actions":[]}', "r1")], done: true, status: 200 }]);
  pumpUntilDone("watch-two");
  plugin.watcherTick("watch-two", { tick: 2, nowMs: 2, state: { n: 2 }, observations: { a: 2 } });

  assert(streamCalls.length === 2, "second watcher stream started");
  const first = JSON.parse(streamCalls[0].body).input;
  const second = JSON.parse(streamCalls[1].body).input;
  assert(typeof first === "string" && typeof second === "string", "each tick sends string transport input");
  assert(!second.includes('"summary":"one"'), "second tick excludes prior assistant/verdict transcript");
  assert(!Object.prototype.hasOwnProperty.call(JSON.parse(streamCalls[1].body), "previous_response_id"), "second tick still does not chain");
});

test("watcher machine system contract is byte-identical across ticks", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({
    tabId: "watch-contract",
    config: {},
    mode: "watcher",
    engine: { kind: "machine", charter: "IMMUTABLE" },
  });
  plugin.watcherTick("watch-contract", { tick: 1, nowMs: 1, state: { n: 1 }, observations: {} });
  enqueueStream(0, [{ chunks: [turn('{"status":"ok","summary":"done","state":{"n":2},"actions":[]}', "r1")], done: true, status: 200 }]);
  pumpUntilDone("watch-contract");
  plugin.watcherTick("watch-contract", { tick: 2, nowMs: 2, state: { n: 2 }, observations: {} });

  const p = plugin.poll("watch-contract", null);
  const contexts = contents(p.messages, "context_request").map((raw) => JSON.parse(raw));
  assert(contexts.length === 2, "two context cards emitted");
  assert(contexts[0][0].content === contexts[1][0].content, "system machine contract is byte-identical across ticks");
});

test("watcherTick emits context_request and watcher_verdict transcript messages", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  const tick = { tick: 7, nowMs: 77, state: {}, observations: { reports: [] } };
  plugin.openSession({
    tabId: "watch-transcript",
    config: {},
    mode: "watcher",
    engine: { kind: "machine", charter: "OBSERVE" },
  });
  plugin.watcherTick("watch-transcript", tick);
  enqueueStream(0, [{ chunks: [turn('{"status":"attention","summary":"check","state":{},"actions":[]}', "resp-watch")], done: true, status: 200 }]);
  const p = pumpUntilDone("watch-transcript");

  const contexts = contents(p.messages, "context_request");
  const verdicts = contents(p.messages, "watcher_verdict");
  assert(contexts.length === 1, "one context_request emitted");
  assertMachineMessages(JSON.parse(contexts[0]), "OBSERVE", tick.state, tick, "context_request");
  assert(verdicts.length === 1, "one watcher_verdict emitted");
  assert(verdicts[0] === '{"status":"attention","summary":"check","state":{},"actions":[]}', "verdict is final text verbatim");
});

test("watcherTick executes a tool block and uses the next clean round as watcher_verdict", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({
    tabId: "watch-tool",
    config: {},
    mode: "watcher",
    engine: { kind: "machine", charter: "WATCH" },
  });
  plugin.watcherTick("watch-tool", { tick: 1, nowMs: 1, state: {}, observations: {} });
  const tool = '```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo watcher"}}\n```';
  enqueueStream(0, [{ chunks: [turn(tool, "resp-tool-watch")], done: true, status: 200 }]);
  plugin.pump("watch-tool");

  assert(execCalls.length === 1, "watcher executed the tool call");
  assert(toolParseCalls.length >= 1, "watcher parsed the tool call");
  assert(streamCalls.length === 2, "watcher started a tool continuation");
  const continuation = JSON.parse(streamCalls[1].body);
  assert(continuation.previous_response_id === "resp-tool-watch", "watcher chains previous_response_id within the tick");
  assert(/tool_result/.test(continuation.input), "watcher continuation receives the tool result");

  enqueueStream(1, [{ chunks: [turn('{"status":"ok","summary":"checked via tool","state":{},"actions":[]}', "resp-watch-final")], done: true, status: 200 }]);
  const p = pumpUntilDone("watch-tool");
  const verdicts = contents(p.messages, "watcher_verdict");
  assert(verdicts.length === 1, "one watcher_verdict emitted");
  assert(verdicts[0] === '{"status":"ok","summary":"checked via tool","state":{},"actions":[]}', "clean continuation text becomes verdict");
});

test("watcherTick emits tool_call and tool_result before the watcher_verdict", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({
    tabId: "watch-transcript-tools",
    config: {},
    mode: "watcher",
    engine: { kind: "machine", charter: "WATCH" },
  });
  plugin.watcherTick("watch-transcript-tools", { tick: 1, nowMs: 1, state: {}, observations: {} });
  const tool = 'Investigating.\n```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo watcher"}}\n```';
  enqueueStream(0, [{ chunks: [turn(tool, "resp-tool-watch-order")], done: true, status: 200 }]);
  plugin.pump("watch-transcript-tools");
  enqueueStream(1, [{ chunks: [turn('{"status":"ok","summary":"done","state":{},"actions":[]}', "resp-watch-order-final")], done: true, status: 200 }]);
  const p = pumpUntilDone("watch-transcript-tools");

  const types = p.messages.map((m) => m.type);
  const callIdx = types.indexOf("tool_call");
  const resultIdx = types.indexOf("tool_result");
  const verdictIdx = types.indexOf("watcher_verdict");
  assert(callIdx >= 0, "tool_call emitted");
  assert(resultIdx >= 0, "tool_result emitted");
  assert(verdictIdx >= 0, "watcher_verdict emitted");
  assert(callIdx < verdictIdx, "tool_call appears before verdict");
  assert(resultIdx < verdictIdx, "tool_result appears before verdict");
});

test("watcherTick round cap still yields exactly one fallback watcher_verdict", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({
    tabId: "watch-cap",
    config: {},
    mode: "watcher",
    engine: { kind: "machine", charter: "WATCH" },
  });
  plugin.watcherTick("watch-cap", { tick: 1, nowMs: 1, state: {}, observations: {} });
  const fence = '```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo loop"}}\n```';
  for (let i = 0; i < 9; i += 1) {
    enqueueStream(i, [{ chunks: [turn(fence, `resp-watch-cap-${i}`)], done: true, status: 200 }]);
    plugin.pump("watch-cap");
  }

  const p = plugin.poll("watch-cap", null);
  const verdicts = contents(p.messages, "watcher_verdict");
  assert(execCalls.length === 8, "watcher exec capped at 8, got " + execCalls.length);
  assert(verdicts.length === 1, "exactly one watcher_verdict at cap");
  const fallback = JSON.parse(verdicts[0]);
  assertJsonEqual(fallback, {
    status: "attention",
    summary: "tool loop ended without a verdict",
    actions: [],
  }, "cap fallback verdict shape");
  assert(!("state" in fallback), "fallback omits state so the host keeps the previous blob");
  assert(p.done === true, "watcher session done after cap");
});

test("watcherTick after a tool loop starts from assembleMachine only", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({
    tabId: "watch-tool-isolation",
    config: {},
    mode: "watcher",
    engine: { kind: "machine", charter: "WATCH" },
  });
  const tick1 = { tick: 1, nowMs: 1, state: { n: 1 }, observations: { a: 1 } };
  plugin.watcherTick("watch-tool-isolation", tick1);
  const tool = '```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo watcher"}}\n```';
  enqueueStream(0, [{ chunks: [turn(tool, "resp-watch-iso-tool")], done: true, status: 200 }]);
  plugin.pump("watch-tool-isolation");
  enqueueStream(1, [{ chunks: [turn('{"status":"ok","summary":"tool done","state":{"n":2},"actions":[]}', "resp-watch-iso-final")], done: true, status: 200 }]);
  pumpUntilDone("watch-tool-isolation");

  const tick2 = { tick: 2, nowMs: 2, state: { n: 2 }, observations: { a: 2 } };
  plugin.watcherTick("watch-tool-isolation", tick2);
  assert(streamCalls.length === 3, "second tick starts one fresh stream after first tick's tool continuation");
  const body = JSON.parse(streamCalls[2].body);
  assert(!Object.prototype.hasOwnProperty.call(body, "previous_response_id"), "second tick does not inherit previous_response_id");
  assertMachineInput(body.input, "WATCH", tick2.state, tick2, "second tick");
  assert(!body.input.includes("tool_result"), "second tick excludes tick-1 tool result");
  assert(!body.input.includes("tool done"), "second tick excludes tick-1 verdict");
});

test("sendMessage is a no-op on watcher sessions", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  const logs = [];
  const oldLog = host.log;
  host.log = (level, message) => logs.push({ level, message });
  try {
    plugin.openSession({
      tabId: "watch-noop",
      config: {},
      mode: "watcher",
      engine: { kind: "machine", charter: "WATCH" },
    });
    plugin.sendMessage("watch-noop", "user text");
  } finally {
    host.log = oldLog;
  }

  assert(streamCalls.length === 0, "watcher sendMessage starts no request");
  const p = plugin.poll("watch-noop", null);
  assert(!contents(p.messages, "user").some((m) => m === "user text"), "watcher sendMessage appends no user message");
  assert(logs.some((l) => l.level === "warn" && /ignored for watcher/.test(l.message)), "watcher no-op logs a warning");
});

test("chat engine window caps fallback history while default sessions remain unchanged", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({
    tabId: "chat-window",
    config: {},
    systemPrompt: "sys",
    engine: { kind: "chat", window: { maxMessages: 2, policy: "top" } },
  });
  plugin.sendMessage("chat-window", "first");
  enqueueStream(0, [{ chunks: [turn("one", null)], done: true, status: 200 }]);
  pumpUntilDone("chat-window");
  plugin.sendMessage("chat-window", "second");

  const capped = JSON.parse(streamCalls[1].body).input;
  assert(capped.includes("system: sys"), "chat window keeps system prompt");
  assert(!capped.includes("user: first"), "chat window evicts older history");
  assert(capped.includes("assistant: one"), "chat window keeps recent assistant message");
  assert(capped.includes("user: second"), "chat window keeps current user message");

  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "default-history", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("default-history", "first");
  enqueueStream(0, [{ chunks: [turn("one", null)], done: true, status: 200 }]);
  pumpUntilDone("default-history");
  plugin.sendMessage("default-history", "second");
  const defaultInput = JSON.parse(streamCalls[1].body).input;
  assert(/^user: first/.test(defaultInput), "default fallback format remains assembled transcript");
  assert(defaultInput.includes("assistant: one"), "default fallback includes prior assistant reply");
  assert(defaultInput.includes("user: second"), "default fallback includes latest user turn");
  assert(!defaultInput.includes("system: sys"), "default fallback does not switch to chat-engine format");
});

test("interactive machine sendMessage uses assembleMachine and advances parsed verdict state", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({
    tabId: "machine-interactive",
    config: {},
    engine: { kind: "machine", charter: "STATEFUL" },
  });
  plugin.sendMessage("machine-interactive", "first?");
  let body = JSON.parse(streamCalls[0].body);
  assertMachineInput(body.input, "STATEFUL", {}, { query: "first?" }, "first machine turn");
  enqueueStream(0, [{ chunks: [turn('{"status":"ok","summary":"ok","state":{"step":1},"actions":[]}', null)], done: true, status: 200 }]);
  pumpUntilDone("machine-interactive");

  plugin.sendMessage("machine-interactive", "second?");
  body = JSON.parse(streamCalls[1].body);
  assertMachineInput(body.input, "STATEFUL", { step: 1 }, { query: "second?" }, "second machine turn");
  assert(!Object.prototype.hasOwnProperty.call(body, "previous_response_id"), "interactive machine request does not chain previous_response_id");
});

test("host parser receives the full assistant text and executes the validated call it returns", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  // An earlier illustrative fence, separated from a later real fence by prose:
  // only the trailing fence is a tool call; the prose-separated one is not.
  plugin.openSession({ tabId: "two-fences", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("two-fences", "explain then run");
  const twoFences =
    'For example:\n```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo example"}}\n```\n' +
    "Now I will actually run it.\n" +
    '```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo real"}}\n```';
  enqueueStream(0, [{ chunks: [turn(twoFences, "resp-two")], done: true, status: 200 }]);
  plugin.pump("two-fences");
  assert(toolParseCalls[0].rawText === twoFences, "full assistant text passed to host parser");
  assert(execCalls.length === 1, "one host-validated call executed, got " + execCalls.length);
  assert(
    execCalls[0].args.some((arg) => String(arg).includes("echo example")),
    "the host parser's selected call ran",
  );
  // The executed fence starts a continuation stream (job 1); give it a final answer and drain.
  enqueueStream(1, [{ chunks: [turn("Done.", "resp-two-final")], done: true, status: 200 }]);
  const p = pumpUntilDone("two-fences");
  assert(contents(p.messages, "tool_result").length === 1, "trailing fence produced one tool_result");
});

test("a native <|tool_call|> exec wrapper is recognized and runs host.exec", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "native", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("native", "list panes");
  // gemma-style native tool call: <|tool_call>call:NAME{args}<tool_call|> with an
  // unquoted key and the `command` alias (mapped to exec's `cmd`).
  const answer = 'Sure, let me check.\n<|tool_call>call:exec{command: "codeterm pane list"}<tool_call|>';
  enqueueStream(0, [{ chunks: [turn(answer, "resp-native")], done: true, status: 200 }]);
  plugin.pump("native");

  assert(execCalls.length === 1, "native tool-call ran host.exec, got " + execCalls.length);
  assert(
    execCalls[0].args.some((arg) => String(arg).includes("codeterm pane list")),
    "native exec command mapped to cmd and executed",
  );
  let p = plugin.poll("native", null);
  assert(contents(p.messages, "tool_result").length === 1, "native tool-call produced a tool_result");
  assert(streamCalls.length === 2, "native tool-call continues the loop");
  const assistants = contents(p.messages, "assistant");
  assert(!/tool_call/.test(assistants[0] || ""), "native wrapper stripped from bubble, got " + assistants[0]);
});

test("a namespaced native tool-call header (call:default_api:exec) runs host.exec", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "ns-native", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("ns-native", "list panes");
  // Live gemma shape: the tool name is the LAST colon segment of the call header,
  // with a `default_api:` namespace prefix and single-quoted loose args.
  const answer = "Sure.\n<|tool_call>call:default_api:exec{command: 'codeterm pane list'}<tool_call|>";
  enqueueStream(0, [{ chunks: [turn(answer, "resp-ns")], done: true, status: 200 }]);
  plugin.pump("ns-native");

  assert(execCalls.length === 1, "namespaced native tool-call ran host.exec, got " + execCalls.length);
  assert(
    execCalls[0].args.some((arg) => String(arg).includes("codeterm pane list")),
    "namespaced exec command mapped to cmd and executed",
  );
  const p = plugin.poll("ns-native", null);
  assert(contents(p.messages, "tool_result").length === 1, "namespaced tool-call produced a tool_result");
  assert(streamCalls.length === 2, "namespaced tool-call continues the loop");
  const assistants = contents(p.messages, "assistant");
  assert(!/tool_call/.test(assistants[0] || ""), "namespaced wrapper stripped from bubble, got " + assistants[0]);
});

test("an unknown namespaced native tool-call (call:unknownns:notatool) is ignored", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "ns-unknown", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("ns-unknown", "go");
  const answer = "Trying.\n<|tool_call>call:unknownns:notatool{command: 'rm -rf /'}<tool_call|>";
  enqueueStream(0, [{ chunks: [turn(answer, "resp-unk")], done: true, status: 200 }]);
  plugin.pump("ns-unknown");

  const p = plugin.poll("ns-unknown", null);
  assert(execCalls.length === 0, "unknown native tool not executed, got " + execCalls.length);
  assert(contents(p.messages, "tool_result").length === 0, "unknown native tool produced no tool_result");
  assert(streamCalls.length === 1, "unknown native tool does not continue the loop");
  assert(p.done === true, "turn ends without executing the unknown tool");
});

test("a codeterm-tool fence followed by trailing prose still executes", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "fence-prose", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("fence-prose", "go");
  const answer =
    'Running it.\n```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo hi"}}\n```\nThat should do it.';
  enqueueStream(0, [{ chunks: [turn(answer, "resp-fp")], done: true, status: 200 }]);
  plugin.pump("fence-prose");
  assert(execCalls.length === 1, "fence-with-trailing-prose executed, got " + execCalls.length);
  assert(
    execCalls[0].args.some((arg) => String(arg).includes("echo hi")),
    "the fenced command ran despite trailing prose",
  );
});

test("a trailing fence matching the old documented example now executes (no example-guard skip)", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "example", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("example", "list my panes");
  // The old isDocumentedExample guard skipped this exact call because it equals the
  // former system-prompt example ('codeterm pane list'). That guard is REMOVED: the
  // most common request ("list my panes") makes gemma emit precisely this trailing,
  // well-formed fence — and a genuine trailing tool call IS the user's intent. The
  // trailing-only / last-contiguous-group logic already prevents mid-explanation
  // echoes from running, so the guard was both wrong (broke the common case) and
  // redundant. It MUST execute, and the raw fence must NOT leak as the final answer.
  const answer =
    'Sure.\n```codeterm-tool\n{"tool": "exec", "args": {"cmd": "codeterm pane list"}}\n```';
  enqueueStream(0, [{ chunks: [turn(answer, "resp-ex")], done: true, status: 200 }]);
  plugin.pump("example");

  assert(execCalls.length === 1, "trailing example-matching fence now executes, got " + execCalls.length);
  assert(
    execCalls[0].args.some((arg) => String(arg).includes("codeterm pane list")),
    "the example command actually ran",
  );
  // continuation
  enqueueStream(1, [{ chunks: [turn("You have pane-1 and pane-2.", "resp-final")], done: true, status: 200 }]);
  const p = pumpUntilDone("example");
  assert(contents(p.messages, "tool_result").length === 1, "produced a tool_result");
  const assistants = contents(p.messages, "assistant");
  assert(!assistants.some((c) => /codeterm-tool/.test(c)), "raw fence did not leak into the bubble");
});

test("a fence-only assistant reply leaves no empty assistant bubble", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "fence-only", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("fence-only", "list panes");
  // The whole reply is the fence — after stripping the executed fence, cleaned === ''.
  // That empty content must NOT be shown as a blank assistant bubble in the transcript.
  const answer = '```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo hi"}}\n```';
  enqueueStream(0, [{ chunks: [turn(answer, "resp-fo")], done: true, status: 200 }]);
  plugin.pump("fence-only");

  assert(execCalls.length === 1, "fence-only reply still executes the tool, got " + execCalls.length);
  enqueueStream(1, [{ chunks: [turn("Done.", "resp-fo-final")], done: true, status: 200 }]);
  const p = pumpUntilDone("fence-only");
  const assistants = contents(p.messages, "assistant");
  assert(
    assistants.every((c) => c.trim() !== ""),
    "no empty assistant bubble, got " + JSON.stringify(assistants),
  );
  assert(assistants[assistants.length - 1] === "Done.", "final answer present after continuation");
});

test("an executed tool-call fence is stripped from the displayed assistant content", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "strip", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("strip", "do it");
  const answer = 'On it.\n```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo strip"}}\n```';
  enqueueStream(0, [{ chunks: [turn(answer, "resp-strip")], done: true, status: 200 }]);
  plugin.pump("strip");

  const p = plugin.poll("strip", null);
  const assistants = contents(p.messages, "assistant");
  assert(assistants.length >= 1, "assistant message exists");
  const bubble = assistants[0];
  assert(!/codeterm-tool/.test(bubble), "raw fence stripped from bubble, got: " + bubble);
  assert(!/echo strip/.test(bubble), "tool JSON stripped from bubble, got: " + bubble);
  assert(bubble.includes("On it."), "prose preserved in bubble, got: " + bubble);
  assert(execCalls.length === 1, "tool still executed");
});

test("malformed trailing tool fence is a normal assistant message when host parser returns null", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "bad-json", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("bad-json", "bad tool");
  const bad = '```codeterm-tool\n{"tool":"exec","args":\n```';
  enqueueStream(0, [{ chunks: [turn(bad, "resp-bad-json")], done: true, status: 200 }]);
  plugin.pump("bad-json");

  const p = plugin.poll("bad-json", null);
  const results = contents(p.messages, "tool_result");
  assert(results.length === 0, "no tool_result for parser null");
  assert(execCalls.length === 0, "no tool executed for parser null");
  assert(streamCalls.length === 1, "no tool continuation after parser null");
  assert(contents(p.messages, "assistant").some((m) => m.includes("codeterm-tool")), "raw malformed text remains visible as assistant text");
});

// ── R8b: tri-state host.toolcall.parse (ok / none / malformed) ─────────────
test("tri-state ok: a {status:'ok'} parse executes the validated call", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "tri-ok", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("tri-ok", "run it");
  const answer = 'Running.\n```codeterm-tool\n{"tool":"exec","args":{"cmd":"echo hi"}}\n```';
  forceParse = JSON.stringify({ status: "ok", tool: "exec", args: { cmd: "echo hi" }, confidence: 0.95, span: [9, answer.length] });
  enqueueStream(0, [{ chunks: [turn(answer, "resp-tri-ok")], done: true, status: 200 }]);
  plugin.pump("tri-ok");

  assert(execCalls.length === 1, "ok status executes the tool, got " + execCalls.length);
  assert(execCalls[0].args.some((a) => String(a).includes("echo hi")), "ok status ran the parsed command");
  const p = plugin.poll("tri-ok", null);
  assert(contents(p.messages, "tool_result").length === 1, "ok status produces a tool_result");
});

test("tri-state none: a {status:'none'} parse is a normal assistant message, no tool", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "tri-none", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("tri-none", "just talk");
  forceParse = JSON.stringify({ status: "none" });
  enqueueStream(0, [{ chunks: [turn("Here is a plain answer.", "resp-tri-none")], done: true, status: 200 }]);
  plugin.pump("tri-none");

  const p = plugin.poll("tri-none", null);
  assert(execCalls.length === 0, "none status executes no tool");
  assert(streamCalls.length === 1, "none status starts no continuation/retry");
  assert(contents(p.messages, "tool_result").length === 0, "none status produces no tool_result");
  assert(contents(p.messages, "assistant").some((m) => m.includes("Here is a plain answer.")), "none status keeps the assistant prose");
  assert(p.done === true, "none status ends the turn");
});

test("tri-state malformed: a {status:'malformed'} parse injects a retry note instead of silently dropping", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "tri-malf", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("tri-malf", "do a thing");
  forceParse = JSON.stringify({ status: "malformed", reason: "unterminated args object", span: [0, 20] });
  const bad = '```codeterm-tool\n{"tool":"exec","args":\n```';
  enqueueStream(0, [{ chunks: [turn(bad, "resp-tri-malf")], done: true, status: 200 }]);
  plugin.pump("tri-malf");

  // Not silent: no tool runs, but a continuation stream carries a corrective note.
  assert(execCalls.length === 0, "malformed runs no tool");
  assert(streamCalls.length === 2, "malformed triggers a retry continuation, got " + streamCalls.length);
  const retry = JSON.parse(streamCalls[1].body);
  assert(/ERROR/.test(retry.input), "retry input flags an error: " + retry.input);
  assert(/invalid/i.test(retry.input), "retry input says the JSON was invalid");
  assert(/unterminated args object/.test(retry.input), "retry input includes the parser's reason");
  assert(/resend a single valid tool call/i.test(retry.input), "retry input asks for a corrected call");
});

test("tri-state malformed retries are capped per turn so a stuck model cannot loop forever", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "tri-cap", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("tri-cap", "go");
  forceParse = JSON.stringify({ status: "malformed", reason: "still broken" });
  const bad = '```codeterm-tool\n{"tool":"exec"\n```';
  // Lockstep: each pump finishes the current stream and (until the cap) starts
  // the next. Three streams (initial + 2 retries) then the cap halts the loop.
  for (let i = 0; i < 3; i += 1) {
    enqueueStream(i, [{ chunks: [turn(bad, `resp-cap-${i}`)], done: true, status: 200 }]);
    plugin.pump("tri-cap");
  }

  const p = plugin.poll("tri-cap", null);
  assert(streamCalls.length === 3, "capped at 2 retries (3 streams total), got " + streamCalls.length);
  assert(execCalls.length === 0, "no tool executed across the malformed loop");
  assert(p.done === true, "session is done after the retry cap");
  const systems = contents(p.messages, "system");
  assert(systems.some((m) => /valid tool call/i.test(m)), "a user-facing fallback note is emitted after the cap");
});

test("tri-state: a thrown host.toolcall.parse is handled as a normal message, not a crash", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "tri-throw", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("tri-throw", "talk");
  forceParse = () => { throw new Error("native parser panic"); };
  enqueueStream(0, [{ chunks: [turn("A safe answer.", "resp-tri-throw")], done: true, status: 200 }]);
  plugin.pump("tri-throw");

  const p = plugin.poll("tri-throw", null);
  assert(execCalls.length === 0, "thrown parse executes no tool");
  assert(streamCalls.length === 1, "thrown parse starts no continuation/retry");
  assert(contents(p.messages, "assistant").some((m) => m.includes("A safe answer.")), "thrown parse keeps the assistant prose");
  assert(p.done === true, "thrown parse ends the turn cleanly");
});

test("listPresets returns configured presets and listModels falls back from /api/v0 to /api/v1/models", () => {
  const endpoint = "http://eight.tail0e459c.ts.net:1234";
  reset({
    baseUrl: `${endpoint}/`,
    defaultPreset: "codeterm",
    presets: [
      { id: "codeterm", name: "CodeTerm", systemPrompt: "sys" },
      { id: "rhymes", name: "Rhymes", systemPrompt: "rhyme" },
    ],
  });
  const presets = plugin.listPresets();
  assert(presets.length === 2 && presets[1].id === "rhymes", "configured presets");

  // Older servers 404 the v0 listing; the native v1 shape is { models: [{ key, ... }] }.
  const urls = [];
  fetchHandler = (opts) => {
    assert(opts.method === "GET", "GET");
    urls.push(opts.url);
    if (opts.url.endsWith("/api/v0/models")) return JSON.stringify({ status: 404, body: "{}" });
    return JSON.stringify({
      status: 200,
      body: JSON.stringify({ models: [{ key: "llama-3" }, { key: "qwen2.5" }, { bogus: true }] }),
    });
  };
  const models = plugin.listModels();
  assert(urls[0] === `${endpoint}/api/v0/models` && urls[1] === `${endpoint}/api/v1/models`, "v0 first, then v1 on the configured server, got " + urls.join(", "));
  assert(models.length === 2, "two valid models, got " + models.length);
  assert(models[0].id === "llama-3" && models[0].displayName === "llama-3", "first model");
});

test("model-bound preset resolves prompt and params for the chosen model", () => {
  reset({
    baseUrl: "http://localhost:1234",
    model: "tiny-model",
    params: { temperature: 0.7, max_tokens: 512 },
    defaultPreset: "codeterm",
    presets: [
      { id: "codeterm", name: "CodeTerm", systemPrompt: "default prompt", params: { temperature: 0.6 } },
      {
        id: "tiny",
        name: "Tiny",
        model: "tiny-model",
        systemPrompt: "simple prompt",
        params: { temperature: 0.2, top_p: 0.8 },
      },
    ],
  });

  plugin.openSession({ tabId: "bound-model", config: {} });
  let p = plugin.poll("bound-model", null);
  assert(p.messages[0].content.includes("simple prompt"), "seed uses bound preset prompt");

  plugin.sendMessage("bound-model", "hello");
  const body = JSON.parse(streamCalls[0].body);
  assert(body.model === "tiny-model", "uses chosen model");
  assert(ownPrompt(body.system_prompt) === "simple prompt", "uses bound preset prompt");
  assert(body.temperature === 0.2, "bound preset temperature overrides defaults");
  assert(body.top_p === 0.8, "bound preset params are included");
  assert(body.max_tokens === 512, "global params are retained");
});

test("unbound model falls back to defaultPreset", () => {
  reset({
    baseUrl: "http://localhost:1234",
    model: "unbound-model",
    params: { temperature: 0.7 },
    defaultPreset: "codeterm",
    presets: [
      { id: "codeterm", name: "CodeTerm", systemPrompt: "default prompt", params: { temperature: 0.6 } },
      { id: "tiny", name: "Tiny", model: "tiny-model", systemPrompt: "simple prompt", params: { temperature: 0.2 } },
    ],
  });

  const body = openAndStartBody({ tabId: "unbound-model", config: {} });
  assert(body.model === "unbound-model", "keeps unbound chosen model");
  assert(ownPrompt(body.system_prompt) === "default prompt", "falls back to default preset prompt");
  assert(body.temperature === 0.6, "default preset params override global defaults");
});

test("explicit preset request wins when the model has no binding", () => {
  reset({
    baseUrl: "http://localhost:1234",
    params: { temperature: 0.7 },
    defaultPreset: "codeterm",
    presets: [
      { id: "codeterm", name: "CodeTerm", systemPrompt: "default prompt", params: { temperature: 0.6 } },
      { id: "creative", name: "Creative", systemPrompt: "creative prompt", params: { temperature: 0.95 } },
      { id: "tiny", name: "Tiny", model: "tiny-model", systemPrompt: "simple prompt", params: { temperature: 0.2 } },
    ],
  });

  const body = openAndStartBody({ tabId: "explicit-preset", config: {}, model: "unbound-model", preset: "creative" });
  assert(body.model === "unbound-model", "keeps explicit unbound model");
  assert(ownPrompt(body.system_prompt) === "creative prompt", "uses explicit preset prompt");
  assert(body.temperature === 0.95, "uses explicit preset params");
});

test("model-bound preset without systemPrompt falls back to default prompt", () => {
  reset({
    baseUrl: "http://localhost:1234",
    model: "tiny-model",
    defaultPreset: "codeterm",
    presets: [
      { id: "codeterm", name: "CodeTerm", systemPrompt: "default prompt", params: { temperature: 0.6 } },
      { id: "tiny", name: "Tiny", model: "tiny-model", params: { temperature: 0.2 } },
    ],
  });

  const body = openAndStartBody({ tabId: "bound-without-prompt", config: {} });
  assert(ownPrompt(body.system_prompt) === "default prompt", "missing bound prompt falls back to default");
  assert(body.temperature === 0.2, "bound preset params still apply");
});

test("setModel persists the last-used model", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ tabId: "persist-set-model", config: {}, systemPrompt: "sys" });

  plugin.setModel("persist-set-model", "qwen-2.5");

  const stored = JSON.parse(fileStore[lastModelPath] || "{}");
  assert(stored.lastModel === "qwen-2.5", "last-used model persisted, got " + JSON.stringify(stored));
});

test("describeModelSwitch asks for confirmation only when target differs from active model", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [] });
  plugin.openSession({ tabId: "describe-switch", config: {}, systemPrompt: "sys", model: "llama-3" });

  let desc = plugin.describeModelSwitch("describe-switch", "llama-3");
  assert(desc.needsConfirm === false, "same model is a no-op");
  assert(desc.message === "", "same model has no confirm message");

  desc = plugin.describeModelSwitch("describe-switch", "qwen-2.5");
  assert(desc.needsConfirm === true, "different model needs confirmation");
  assert(/qwen-2\.5/.test(desc.message), "message names target model, got " + desc.message);
  assert(/unload the current one \(VRAM\)/.test(desc.message), "message explains unload/VRAM, got " + desc.message);
});

test("openSession without explicit model or preset binding restores the persisted last-used model", () => {
  reset({ baseUrl: "http://localhost:1234", model: "default-model", presets: [] });
  fileStore[lastModelPath] = JSON.stringify({ lastModel: "remembered-model" });

  const body = openAndStartBody({ tabId: "restore-last-model", config: {}, systemPrompt: "sys" });

  assert(body.model === "remembered-model", "restored persisted model, got " + body.model);
  const stored = JSON.parse(fileStore[lastModelPath] || "{}");
  assert(stored.lastModel === "remembered-model", "openSession records chosen model");
});

test("explicit model and preset-bound model win over the persisted last-used model", () => {
  reset({
    baseUrl: "http://localhost:1234",
    model: "default-model",
    defaultPreset: "codeterm",
    presets: [
      { id: "codeterm", name: "CodeTerm", systemPrompt: "default prompt" },
      { id: "tiny", name: "Tiny", model: "tiny-model", systemPrompt: "tiny prompt" },
    ],
  });
  fileStore[lastModelPath] = JSON.stringify({ lastModel: "remembered-model" });

  let body = openAndStartBody({ tabId: "explicit-over-persisted", config: {}, model: "explicit-model" });
  assert(body.model === "explicit-model", "explicit model wins, got " + body.model);

  streamCalls.length = 0;
  streamJobs.length = 0;
  fileStore[lastModelPath] = JSON.stringify({ lastModel: "remembered-model" });
  body = openAndStartBody({ tabId: "preset-over-persisted", config: {}, preset: "tiny" });
  assert(body.model === "tiny-model", "preset-bound model wins, got " + body.model);
  assert(ownPrompt(body.system_prompt) === "tiny prompt", "preset-bound prompt used");
});

test("missing or corrupt persisted last-used model falls back to defaultModel without throwing", () => {
  reset({ baseUrl: "http://localhost:1234", model: "default-model", presets: [] });
  let body = openAndStartBody({ tabId: "missing-last-model", config: {}, systemPrompt: "sys" });
  assert(body.model === "default-model", "missing persisted model falls back to default");

  streamCalls.length = 0;
  streamJobs.length = 0;
  fileStore[lastModelPath] = "{not-json";
  body = openAndStartBody({ tabId: "corrupt-last-model", config: {}, systemPrompt: "sys" });
  assert(body.model === "default-model", "corrupt persisted model falls back to default");
});

test("sessionInfo reports the session model and setModel switches it for the next turn", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [] });
  plugin.openSession({ tabId: "switch", config: {}, systemPrompt: "sys", model: "llama-3" });

  // sessionInfo surfaces the model the session opened with.
  assert(plugin.sessionInfo("switch").model === "llama-3", "sessionInfo returns opened model");

  // setModel swaps the model the next /api/v1/chat will use.
  plugin.setModel("switch", "qwen-2.5");
  assert(plugin.sessionInfo("switch").model === "qwen-2.5", "setModel updates the session model");

  // An unknown session / empty model is a safe no-op (no throw).
  plugin.setModel("nope", "x");
  plugin.setModel("switch", "");
  assert(plugin.sessionInfo("switch").model === "qwen-2.5", "empty/unknown setModel is a no-op");
  assert(plugin.sessionInfo("nope").model === undefined, "unknown session has no model");
});

test("setModel surfaces a JIT-load VRAM failure from chat as a clean system message", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [] });
  plugin.openSession({ tabId: "vram-switch", config: {}, systemPrompt: "sys", model: "llama-3" });

  plugin.setModel("vram-switch", "qwen-72b");
  plugin.sendMessage("vram-switch", "hello");
  enqueueStream(0, [
    {
      chunks: [],
      done: true,
      status: 500,
      body: JSON.stringify({ error: "Failed to load model: insufficient VRAM" }),
    },
  ]);

  const p = pumpUntilDone("vram-switch");
  const systems = contents(p.messages, "system");
  assert(
    systems.some((m) => m === "couldn't load qwen-72b: not enough VRAM — unload a model in LM Studio or pick a smaller one"),
    "clean VRAM system message present, got " + JSON.stringify(systems),
  );
});

test("charter: id resolves shipped prompts/watcher-orchestration.md in openSession", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  const md = readFileSync(join(__dirname, "prompts", "watcher-orchestration.md"), "utf8").replace(/\s+$/, "");
  const r = plugin.openSession({
    tabId: "charter-ref",
    config: {},
    mode: "watcher",
    engine: { kind: "machine", charter: "charter:watcher-orchestration" },
  });
  assert(r.sessionId === "charter-ref", "openSession succeeds, got " + JSON.stringify(r));

  const p = plugin.poll("charter-ref", null);
  assert(p.messages.length === 1, "charter card emitted");
  const card = p.messages[0].content.replace("-=-codeterm:system_prompt-=-", "").trim();
  assert(card === md, "shipped charter matches prompts/watcher-orchestration.md byte-for-byte (trailing ws normalized)");
});

test("charter: id accepts inline config override for custom charters", () => {
  reset({
    baseUrl: "http://localhost:1234",
    model: "llama",
    presets: [],
    charters: { custom: "INLINE CHARTER BODY" },
  });
  plugin.openSession({
    tabId: "charter-inline",
    config: {},
    mode: "watcher",
    engine: { kind: "machine", charter: "charter:custom" },
  });
  const card = plugin.poll("charter-inline", null).messages[0].content;
  assert(card.includes("INLINE CHARTER BODY"), "inline config charter used for unknown shipped id");
});

test("unknown charter: id fails openSession with an error", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [], charters: {} });
  const r = plugin.openSession({
    tabId: "charter-missing",
    config: {},
    mode: "watcher",
    engine: { kind: "machine", charter: "charter:does-not-exist" },
  });
  assert(r.error === "unknown charter id: does-not-exist", "openSession returns error, got " + JSON.stringify(r));
  assert(!r.sessionId, "no sessionId on failure");
});

test("charter ref resolves before watcherTick uses assembleMachine", () => {
  reset({
    baseUrl: "http://localhost:1234",
    model: "llama",
    presets: [],
    charters: { health: "HEALTH CHARTER" },
  });
  plugin.openSession({
    tabId: "charter-tick",
    config: {},
    mode: "watcher",
    engine: { kind: "machine", charter: "charter:health" },
  });
  const tick = { tick: 1, nowMs: 99, state: {}, observations: {} };
  plugin.watcherTick("charter-tick", tick);
  const body = JSON.parse(streamCalls[0].body);
  assertMachineInput(body.input, "HEALTH CHARTER", tick.state, tick, "charter ref");
});

test("settings schema and config expose presets/defaultPreset", () => {
  const schema = JSON.parse(readFileSync(join(__dirname, "settings.schema.json"), "utf8"));
  const schemaText = JSON.stringify(schema);
  assert(schemaText.includes("baseUrl"), "schema exposes baseUrl");
  const serverSection = schema.find((section) => section.title === "LM Studio server");
  const baseUrlField = serverSection && serverSection.fields.find((field) => field.key === "baseUrl");
  assert(baseUrlField && baseUrlField.label === "Server address", "SchemaRenderer exposes a labeled Server address field");
  assert(baseUrlField.description.includes("tailnet"), "Server address describes remote Tailscale endpoints");
  assert(schemaText.includes("defaultPreset"), "schema exposes defaultPreset");
  assert(schemaText.includes("presets"), "schema exposes presets");

  const config = readFileSync(join(__dirname, "config.yaml"), "utf8");
  assert(/# Server address, e\.g\. http:\/\/localhost:1234/.test(config), "config documents the server address");
  assert(config.includes("<mac>.<tailnet>.ts.net:1234"), "config documents a remote Tailscale address");
  assert(/^baseUrl:\s*http:\/\/localhost:1234$/m.test(config), "config keeps the localhost default");
  assert(/defaultPreset:\s*codeterm/.test(config), "config has defaultPreset");
  assert(/systemPrompt:\s*\|/.test(config), "config seeds block systemPrompt");
  assert(/charters:/.test(config), "config exposes charters map");
  assert(/watcher-orchestration:\s*prompts\/watcher-orchestration\.md/.test(config), "config references shipped charter path");

  const watcherCharter = readFileSync(join(__dirname, "prompts", "watcher-orchestration.md"), "utf8").replace(/\s+$/, "");
  assert(watcherCharter.includes("orchestrator_id"), "watcher charter documents orchestrator_id + panes[] shape");
  assert(watcherCharter.includes("chatTail"), "watcher charter documents per-pane chatTail objects");
  assert(watcherCharter.includes("from_pane_id"), "watcher charter documents report field names");
  assert(watcherCharter.includes("7+ minutes"), "stalled example aligns with ~5+ min threshold");

  // CLI contract: every `codeterm <noun>` the shipped prompts teach must be a live top-level noun.
  const cliNouns = new Set(["tab", "send", "agent", "plan", "task", "mem", "docs", "workspace", "team", "orchestrator", "inbox", "notify", "cron", "mesh", "sessions", "plugin", "pad", "identify"]);
  const shipped = [config, watcherCharter, readFileSync(join(__dirname, "prompts", "codeterm-default.md"), "utf8"), DOMIOS_CONTEXT];
  for (const text of shipped) {
    for (const m of text.matchAll(/[`"]codeterm ([a-z][a-z-]*)/g)) assert(cliNouns.has(m[1]), `prompt teaches unknown CLI noun: codeterm ${m[1]}`);
    for (const m of text.matchAll(/"args":"([a-z][a-z-]*)/g)) assert(cliNouns.has(m[1]), `tool example uses unknown CLI noun: ${m[1]}`);
  }
});

// ── R6: authorSystemPrompt — author/refine a pane's system prompt ─────────────

const authoredPromptsPath = "/tmp/codeterm-home/.codeterm/plugin-data/lmstudio/authored-prompts.json";

test("sessionInfo returns model and systemPrompt so an external author can read the current state", () => {
  reset({
    baseUrl: "http://localhost:1234",
    presets: [{ id: "p1", name: "P1", systemPrompt: "Base prompt text" }],
    defaultPreset: "p1",
  });
  plugin.openSession({ tabId: "info-r6", config: {}, model: "gemma-3" });
  const info = plugin.sessionInfo("info-r6");
  assert(info.model === "gemma-3", "sessionInfo.model matches opened model, got " + info.model);
  assert(info.systemPrompt === "Base prompt text", "sessionInfo.systemPrompt matches preset, got " + info.systemPrompt);
});

test("authorSystemPrompt saves the drafted prompt for the session's model to the authored-prompts file", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [], model: "gemma-3" });
  plugin.openSession({ tabId: "author-save-r6", config: {}, model: "gemma-3", systemPrompt: "original" });

  plugin.authorSystemPrompt("author-save-r6", "My tuned prompt for gemma");

  const stored = JSON.parse(fileStore[authoredPromptsPath] || "{}");
  assert(stored["gemma-3"] === "My tuned prompt for gemma", "authored prompt stored for model, got " + JSON.stringify(stored));
});

test("authorSystemPrompt updates the live sessionInfo.systemPrompt immediately", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [], model: "qwen-2.5" });
  plugin.openSession({ tabId: "author-live-r6", config: {}, model: "qwen-2.5", systemPrompt: "old" });

  plugin.authorSystemPrompt("author-live-r6", "Tuned for qwen");

  const info = plugin.sessionInfo("author-live-r6");
  assert(info.systemPrompt === "Tuned for qwen", "live sessionInfo reflects authored prompt, got " + info.systemPrompt);
});

test("openSession for the same model picks up the authored prompt on subsequent init", () => {
  reset({
    baseUrl: "http://localhost:1234",
    presets: [{ id: "p1", name: "P1", systemPrompt: "Preset prompt", model: "gemma-3" }],
    defaultPreset: "p1",
  });

  // Seed the authored prompt as if a prior authorSystemPrompt call had written it.
  fileStore[authoredPromptsPath] = JSON.stringify({ "gemma-3": "Tuned prompt from author" });

  const body = openAndStartBody({ tabId: "authored-init-r6", config: {}, model: "gemma-3" });
  assert(
    ownPrompt(body.system_prompt) === "Tuned prompt from author",
    "authored prompt wins over preset on session init, got " + body.system_prompt,
  );
});

test("authorSystemPrompt on unknown session is a safe no-op that writes nothing", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [] });
  // Must not throw
  plugin.authorSystemPrompt("no-such-session", "some draft");
  assert(!fileStore[authoredPromptsPath], "nothing written for unknown session");
});

test("authorSystemPrompt persists across multiple models independently", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [], model: "m1" });
  plugin.openSession({ tabId: "multi-a", config: {}, model: "model-a", systemPrompt: "orig-a" });
  plugin.openSession({ tabId: "multi-b", config: {}, model: "model-b", systemPrompt: "orig-b" });

  plugin.authorSystemPrompt("multi-a", "Tuned for model-a");
  plugin.authorSystemPrompt("multi-b", "Tuned for model-b");

  const stored = JSON.parse(fileStore[authoredPromptsPath] || "{}");
  assert(stored["model-a"] === "Tuned for model-a", "model-a stored, got " + stored["model-a"]);
  assert(stored["model-b"] === "Tuned for model-b", "model-b stored, got " + stored["model-b"]);
});

// ── R6: requestPromptAuthoring — hand the tuning off to another agent pane ────

test("requestPromptAuthoring hands off to an agent pane: ensures a workspace, spawns, and sends the current model + prompt", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [], model: "gemma-3" });
  plugin.openSession({ tabId: "author-handoff-r6", config: {}, model: "gemma-3", systemPrompt: "current prompt body" });

  agentReply = "TUNED PROMPT FOR GEMMA";
  const res = plugin.requestPromptAuthoring("author-handoff-r6", "make it shorter and example-led");
  assert(res && res.ok === true, "requestPromptAuthoring reports ok, got " + JSON.stringify(res));

  assert(workspaceCalls.length === 1, "a workspace was ensured for the author, got " + workspaceCalls.length);
  assert(agentSpawns.length === 1, "an author agent was spawned, got " + agentSpawns.length);
  assert(agentSpawns[0].workspaceId === "ws-author", "spawn used the ensured workspace");
  assert(agentSends.length === 1, "the authoring request was sent to the agent, got " + agentSends.length);
  const sent = agentSends[0].text;
  assert(/gemma-3/.test(sent), "request names the target model, got " + sent);
  assert(/current prompt body/.test(sent), "request includes the current prompt, got " + sent);
  assert(/make it shorter and example-led/.test(sent), "request includes the user instruction, got " + sent);
});

test("requestPromptAuthoring round-trip writes the agent's reply back as the authored prompt and updates the live session", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [], model: "gemma-3" });
  plugin.openSession({ tabId: "author-rt-r6", config: {}, model: "gemma-3", systemPrompt: "old" });

  agentReply = "TUNED PROMPT FOR GEMMA";
  plugin.requestPromptAuthoring("author-rt-r6", "tune it");
  pumpUntilDone("author-rt-r6");

  const stored = JSON.parse(fileStore[authoredPromptsPath] || "{}");
  assert(stored["gemma-3"] === "TUNED PROMPT FOR GEMMA", "authored prompt written for model, got " + JSON.stringify(stored));
  assert(
    plugin.sessionInfo("author-rt-r6").systemPrompt === "TUNED PROMPT FOR GEMMA",
    "live session prompt updated, got " + plugin.sessionInfo("author-rt-r6").systemPrompt,
  );
  assert(agentReaps.length === 1 && agentReaps[0] === "agent-1", "the author agent was reaped, got " + JSON.stringify(agentReaps));
});

test("the prompt authored via the round-trip is used on the next session init", () => {
  reset({
    baseUrl: "http://localhost:1234",
    model: "gemma-3",
    presets: [{ id: "p1", name: "P1", systemPrompt: "Preset prompt", model: "gemma-3" }],
    defaultPreset: "p1",
  });
  plugin.openSession({ tabId: "author-init-rt-r6", config: {}, model: "gemma-3", systemPrompt: "Preset prompt" });

  agentReply = "ROUND-TRIP TUNED PROMPT";
  plugin.requestPromptAuthoring("author-init-rt-r6", "tune");
  pumpUntilDone("author-init-rt-r6");

  // A fresh session for the same model must pick up the authored prompt.
  streamCalls.length = 0;
  streamJobs.length = 0;
  const body = openAndStartBody({ tabId: "author-init-rt-r6b", config: {}, model: "gemma-3" });
  assert(
    ownPrompt(body.system_prompt) === "ROUND-TRIP TUNED PROMPT",
    "next init uses the round-trip authored prompt over the preset, got " + body.system_prompt,
  );
});

test("requestPromptAuthoring parks across pumps until the author agent's reply is ready", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [], model: "qwen-2.5" });
  plugin.openSession({ tabId: "author-park-r6", config: {}, model: "qwen-2.5", systemPrompt: "p" });

  enqueueAgentPoll([{ done: false }, { done: false }, { done: true, reply: "READY PROMPT" }]);
  plugin.requestPromptAuthoring("author-park-r6", "tune");

  // Not done while the agent is still working.
  plugin.pump("author-park-r6");
  assert(plugin.poll("author-park-r6", null).done === false, "session not done while author is in flight");

  pumpUntilDone("author-park-r6");
  assert(agentPollCalls.length >= 3, "polled until the reply was ready, got " + agentPollCalls.length);
  const stored = JSON.parse(fileStore[authoredPromptsPath] || "{}");
  assert(stored["qwen-2.5"] === "READY PROMPT", "authored prompt written after parking, got " + JSON.stringify(stored));
});

test("requestPromptAuthoring strips a code fence the author agent wraps the prompt in", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [], model: "gemma-3" });
  plugin.openSession({ tabId: "author-fence-r6", config: {}, model: "gemma-3", systemPrompt: "p" });

  agentReply = "```\nUNFENCED PROMPT\n```";
  plugin.requestPromptAuthoring("author-fence-r6", "tune");
  pumpUntilDone("author-fence-r6");

  const stored = JSON.parse(fileStore[authoredPromptsPath] || "{}");
  assert(stored["gemma-3"] === "UNFENCED PROMPT", "fence stripped from authored prompt, got " + JSON.stringify(stored));
});

test("requestPromptAuthoring surfaces an author-agent error as a system message and writes nothing", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [], model: "gemma-3" });
  plugin.openSession({ tabId: "author-err-r6", config: {}, model: "gemma-3", systemPrompt: "keep me" });

  enqueueAgentPoll([{ done: true, error: "author agent crashed" }]);
  plugin.requestPromptAuthoring("author-err-r6", "tune");
  const p = pumpUntilDone("author-err-r6");

  assert(!fileStore[authoredPromptsPath], "nothing written on author error");
  assert(plugin.sessionInfo("author-err-r6").systemPrompt === "keep me", "live prompt unchanged on error");
  const systems = contents(p.messages, "system");
  assert(systems.some((m) => /author agent crashed/.test(m)), "error surfaced as system message, got " + JSON.stringify(systems));
  assert(agentReaps.length === 1, "agent reaped even on error");
});

test("requestPromptAuthoring on an unknown session or one without a model is a safe no-op", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [] });
  const res = plugin.requestPromptAuthoring("no-such-session", "x");
  assert(res && res.ok === false, "unknown session reports not-ok, got " + JSON.stringify(res));
  assert(agentSpawns.length === 0 && workspaceCalls.length === 0, "no agent spawned for unknown session");
});

test("decision_noul_chains_model_discovery_from_the_async_continuation", () => {
  reset({ baseUrl: "http://localhost:1234", model: "", decision: { model: "" } });
  asyncFetchHandler = (opts) => {
    if (opts.url.endsWith("/models")) {
      return { status: 200, body: JSON.stringify(decisionFixture("models.fixture.json")) };
    }
    return { status: 200, body: JSON.stringify(decisionFixture("noul-variants.fixture.json")) };
  };

  const answer = decide(decisionRequest({ type: "noul", criteria: null }));

  assert(answer.type === "noul", "noul result type after discovery");
  closeTo(answer.p, 0.8, "model discovery chains to the logprob request");
  assert(fetchCalls.length === 2, "model list and completion requests both settle");
  assert(fetchCalls[0].method === "GET" && fetchCalls[0].url.endsWith("/models"), "first continuation loads model ids");
  assert(JSON.parse(fetchCalls[1].body).model === "owner/model-a", "completion uses the first server model");
});

test("decision_noul_ratio_from_logprobs merges variants after leading whitespace tokens", () => {
  reset({ baseUrl: "http://localhost:1234", decision: { model: "fixture-model", maxTokens: 1, timeoutMs: 2400 } });
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(decisionFixture("noul-variants.fixture.json")) });

  const answer = decide(decisionRequest({
    type: "noul",
    criteria: { true: "the candidate matches", false: "the candidate does not match" },
  }));

  assert(answer.type === "noul", "noul result type");
  closeTo(answer.p, 0.8, "yes mass divided by yes and no mass");
  const body = JSON.parse(fetchCalls[0].body);
  assert(fetchCalls[0].timeoutMs === 2400, "configured request timeout passed to async fetch");
  assert(body.max_tokens === 8 && body.logprobs === true && body.top_logprobs === 5, "bounded request leaves room for leading whitespace");
});

test("decision_noul_null_logprobs_uses_confidence_schema_fallback", () => {
  reset({ decision: { model: "fixture-model" } });
  const responses = [
    decisionFixture("mlx-null-logprobs-whitespace.fixture.json"),
    decisionFixture("constrained-noul-confidence.fixture.json"),
  ];
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(responses.shift()) });

  const answer = decide(decisionRequest({ type: "noul", criteria: null }));

  assert(answer.type === "noul", "noul fallback result type");
  closeTo(answer.p, 0.8, "yes confidence maps to yes probability");
  assert(fetchCalls.length === 2, "null logprobs triggers one constrained retry");
  const body = JSON.parse(fetchCalls[1].body);
  assert(body.logprobs === undefined, "constrained retry does not claim token logprobs");
  const schema = body.response_format.json_schema.schema;
  assert(schema.properties.answer.enum.join(",") === "yes,no", "fallback constrains yes/no answer");
  assert(schema.properties.confidence.minimum === 0 && schema.properties.confidence.maximum === 100, "fallback constrains integer confidence");
  assert(JSON.parse(fetchCalls[0].body).max_tokens === 64, "default token budget reaches past leading whitespace");
});

test("decision_noul_empty_null_logprobs_retries_instead_of_guessing", () => {
  reset({ decision: { model: "fixture-model" } });
  const noAnswer = decisionFixture("constrained-noul-confidence.fixture.json");
  noAnswer.choices[0].message.content = JSON.stringify({ answer: "no", confidence: 80 });
  const responses = [decisionFixture("mlx-null-logprobs-empty.fixture.json"), noAnswer];
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(responses.shift()) });

  const answer = decide(decisionRequest({ type: "noul", criteria: null }));

  assert(answer.type === "noul", "noul fallback result type");
  closeTo(answer.p, 0.2, "no confidence maps to the complementary yes probability");
  assert(fetchCalls.length === 2, "empty content with null logprobs makes a constrained request");
});

test("decision_noul_mlx_defaults_to_one_constrained_json_request", () => {
  reset({ decision: { model: "owner/jev-style-qwen3.5-2b-decision-mlx-bf16" } });
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(decisionFixture("constrained-noul-confidence.fixture.json")) });

  const answer = decide(decisionRequest({ type: "noul", criteria: null }));

  assert(answer.type === "noul", "MLX noul result type");
  closeTo(answer.p, 0.8, "MLX constrained confidence maps to yes probability");
  assert(fetchCalls.length === 1, "known null-logprobs model avoids a speculative completion");
  const body = JSON.parse(fetchCalls[0].body);
  assert(body.logprobs === undefined && body.response_format.json_schema.schema.properties.answer.enum.join(",") === "yes,no", "first MLX request is constrained JSON");
});

test("decision_noul_present_logprobs_without_yes_no_tokens_is_parse_error", () => {
  reset({ decision: { model: "fixture-model" } });
  const response = decisionFixture("noul-variants.fixture.json");
  response.choices[0].logprobs.content[1].top_logprobs = [
    { token: "maybe", logprob: -0.10536051565782628 },
  ];
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(response) });

  let error = "";
  try {
    decide(decisionRequest({ type: "noul", criteria: null }));
  } catch (caught) {
    error = String(caught && caught.message || caught);
  }
  assert(/parse error: candidate tokens are absent/.test(error), "missing yes/no logprobs produce parse error, got " + error);
  assert(fetchCalls.length === 1, "present but incomplete logprobs do not trigger a guessed fallback");
});

test("decision_choice_normalizes_label_logprobs", () => {
  reset({ decision: { model: "fixture-model" } });
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(decisionFixture("choice-logprobs.fixture.json")) });

  const answer = decide(decisionRequest({
    type: "choice",
    options: { keep: "Retain the candidate", drop: "Discard the candidate" },
  }));

  assert(answer.type === "choice" && answer.choice === "drop", "highest normalized label selected");
  closeTo(answer.probabilities.keep, 0.25, "keep probability");
  closeTo(answer.probabilities.drop, 0.75, "drop probability");
  closeTo(answer.confidence, 0.75, "choice confidence");
});

test("decision_choice_null_logprobs_uses_confidence_and_spreads_remainder", () => {
  reset({ decision: { model: "fixture-model" } });
  const constrainedChoice = {
    id: "chatcmpl-fixture-choice-confidence",
    choices: [{
      logprobs: null,
      message: { role: "assistant", content: JSON.stringify({ choice: "drop", confidence: 75 }) },
    }],
  };
  const responses = [decisionFixture("mlx-null-logprobs-empty.fixture.json"), constrainedChoice];
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(responses.shift()) });

  const answer = decide(decisionRequest({
    type: "choice",
    options: { keep: "Retain the candidate", drop: "Discard the candidate" },
  }));

  assert(answer.type === "choice" && answer.choice === "drop", "constrained label is returned");
  assertJsonEqual(answer.probabilities, { keep: 0.25, drop: 0.75 }, "confidence maps to selected label and remainder");
  closeTo(answer.confidence, 0.75, "fallback confidence");
  const schema = JSON.parse(fetchCalls[1].body).response_format.json_schema.schema;
  assert(schema.properties.choice.enum.join(",") === "keep,drop", "JSON schema constrains supplied labels");
  assert(schema.properties.confidence.minimum === 0 && schema.properties.confidence.maximum === 100, "JSON schema constrains confidence");
});

test("decision_choice_mlx_defaults_to_one_constrained_json_request", () => {
  reset({ decision: { model: "owner/jev-style-qwen3.5-2b-decision-mlx-bf16" } });
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(decisionFixture("constrained-choice.fixture.json")) });

  const answer = decide(decisionRequest({
    type: "choice",
    options: { allow: "Allow the action", alternate: "Choose an alternative", deny: "Deny the action" },
  }));

  assert(answer.type === "choice" && answer.choice === "alternate", "MLX constrained label is returned");
  assert(fetchCalls.length === 1, "known null-logprobs model uses one constrained request");
  assert(JSON.parse(fetchCalls[0].body).logprobs === undefined, "MLX constrained request does not request token logprobs");
});

test("decision_choice_batches_36_candidates_in_three_constrained_requests", () => {
  reset({ decision: { model: "owner/jev-style-qwen3.5-2b-decision-mlx-bf16" } });
  const options = Object.fromEntries(Array.from({ length: 36 }, (_, index) => [
    `candidate-${String(index).padStart(2, "0")}`,
    `Candidate ${index}`,
  ]));
  let batchIndex = 0;
  asyncFetchHandler = (opts) => {
    const body = JSON.parse(opts.body);
    const schema = body.response_format.json_schema.schema;
    const keys = Object.keys(schema.properties.scores.properties);
    assert(keys.length > 0 && keys.length <= 12, "each constrained request scores at most twelve candidates");
    const scores = {};
    keys.forEach((key, index) => { scores[key] = batchIndex * 12 + index + 1; });
    batchIndex += 1;
    return {
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify({ scores }) } }],
      }),
    };
  };

  const answer = decide(decisionRequest({ type: "choice", options }));

  assert(answer.type === "choice" && answer.choice === "candidate-35", "highest batch score selects the final candidate");
  closeTo(answer.probabilities["candidate-35"], 36 / 666, "batch scores normalize over the complete candidate set");
  assert(fetchCalls.length === 3, "36 candidates require three serialized model calls");
  assert(fetchCalls.every((call) => JSON.parse(call.body).logprobs === undefined), "known null-logprobs model uses constrained requests only");
});

test("decision_choice_batch_rejects_more_than_36_labels_without_a_guess", () => {
  reset({ decision: { model: "owner/jev-style-qwen3.5-2b-decision-mlx-bf16" } });
  const options = Object.fromEntries(Array.from({ length: 37 }, (_, index) => [`candidate-${index}`, `Candidate ${index}`]));

  let error = "";
  try {
    decide(decisionRequest({ type: "choice", options }));
  } catch (caught) {
    error = String(caught && caught.message || caught);
  }

  assert(/parse error: choice supports at most 36 labels/.test(error), "oversized batch fails explicitly, got " + error);
  assert(fetchCalls.length === 0, "oversized batch sends no partial or guessed requests");
});

test("decision_choice_shared_prefix_falls_back_constrained", () => {
  reset({ decision: { model: "fixture-model" } });
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(decisionFixture("constrained-choice.fixture.json")) });

  const answer = decide(decisionRequest({
    type: "choice",
    options: { allow: "Allow the action", alternate: "Choose an alternative", deny: "Deny the action" },
  }));

  assert(answer.type === "choice" && answer.choice === "alternate", "constrained label is returned");
  closeTo(answer.probabilities.allow, 0.1, "confidence remainder is spread evenly (allow)");
  closeTo(answer.probabilities.alternate, 0.8, "constrained label keeps its confidence");
  closeTo(answer.probabilities.deny, 0.1, "confidence remainder is spread evenly (deny)");
  closeTo(answer.confidence, 0.8, "constrained confidence");
  assert(fetchCalls.length === 1, "shared first-token prefixes use the constrained request directly");
  const body = JSON.parse(fetchCalls[0].body);
  const schema = body.response_format.json_schema.schema;
  assert(body.logprobs === undefined, "constrained response does not claim token logprobs");
  assert(schema.properties.choice.enum.join(",") === "allow,alternate,deny", "JSON schema constrains supplied labels");
  assert(body.max_tokens >= 32, "schema response has enough output budget for JSON");
});

test("decision_score_index_keyed_map", () => {
  reset({ decision: { model: "fixture-model" } });
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(decisionFixture("score-logprobs.fixture.json")) });

  const answer = decide(decisionRequest({ type: "score", levels: ["low", "medium", "high"] }));

  assert(answer.type === "score", "score result type");
  assertJsonEqual(Object.keys(answer.probabilities), ["0", "1", "2"], "probabilities use level indexes");
  closeTo(answer.probabilities["0"], 0.2, "low level probability");
  closeTo(answer.probabilities["1"], 0.3, "medium level probability");
  closeTo(answer.probabilities["2"], 0.5, "high level probability");
  closeTo(answer.score, 1.3, "score is the probability-weighted level index");
});

test("decision_score_null_logprobs_uses_constrained_point_and_interpolated_index_map", () => {
  reset({ decision: { model: "fixture-model" } });
  const responses = [
    decisionFixture("mlx-null-logprobs-empty.fixture.json"),
    decisionFixture("constrained-score.fixture.json"),
  ];
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(responses.shift()) });

  const answer = decide(decisionRequest({ type: "score", levels: ["low", "medium", "high"] }));

  assert(answer.type === "score", "score fallback result type");
  closeTo(answer.score, 1.25, "constrained score point");
  assertJsonEqual(answer.probabilities, { "1": 0.75, "2": 0.25 }, "interpolation preserves the point estimate");
  assert(answer.confidence === null, "point-score interpolation is not model confidence");
  const schema = JSON.parse(fetchCalls[1].body).response_format.json_schema.schema;
  assert(schema.properties.score.minimum === 0 && schema.properties.score.maximum === 2, "schema constrains the declared level range");
});

test("decision_score_mlx_defaults_to_one_constrained_json_request", () => {
  reset({ decision: { model: "owner/jev-style-qwen3.5-2b-decision-mlx-bf16" } });
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(decisionFixture("constrained-score.fixture.json")) });

  const answer = decide(decisionRequest({ type: "score", levels: ["low", "medium", "high"] }));

  assert(answer.type === "score", "MLX score result type");
  closeTo(answer.score, 1.25, "MLX constrained score point");
  assert(fetchCalls.length === 1, "known null-logprobs model uses one constrained request");
  assert(JSON.parse(fetchCalls[0].body).logprobs === undefined, "MLX score request does not claim token logprobs");
});

test("decision_models_returns_nonempty_server_catalog_through_async_marker_without_hardcoded_ids", () => {
  const endpoint = "http://eight.tail0e459c.ts.net:1234/v1";
  reset({ baseUrl: endpoint });
  const catalog = decisionFixture("models.fixture.json");
  asyncFetchHandler = (opts) => {
    assert(opts.url === `${endpoint}/models`, "OpenAI-compatible model endpoint uses the configured server address");
    return { status: 200, body: JSON.stringify(catalog) };
  };

  const pending = plugin.models();
  assert(pending && pending.__ctAwait__, "models export yields the host.fetch.async marker");
  const models = settleFetchExport(pending, "models export");

  assertJsonEqual(models, [
    { id: "owner/model-a", display_name: "Model A" },
    { id: "owner/model-b", display_name: "owner/model-b" },
  ], "server model ids and display names returned as listed");
  assert(fetchCalls.length === 1 && asyncFetchJobs[0].resumed, "non-empty catalogue is parsed after the marker resumes");
});

test("decision_completion_uses_configured_remote_server_address", () => {
  const endpoint = "http://eight.tail0e459c.ts.net:1234";
  reset({ baseUrl: endpoint, decision: { model: "owner/model-a", logprobsMode: "constrained" } });
  asyncFetchHandler = (opts) => {
    assert(opts.url === `${endpoint}/v1/chat/completions`, "decision endpoint uses the configured server address");
    return { status: 200, body: JSON.stringify(decisionFixture("constrained-noul-confidence.fixture.json")) };
  };

  const answer = decide(decisionRequest({ type: "noul" }));
  assert(answer.type === "noul", "decision request completes against the configured endpoint");
});

test("decision_models_marks_models_after_approximate_fallback", () => {
  reset({ decision: { model: "catalog-model" } });
  const responses = [
    decisionFixture("mlx-null-logprobs-empty.fixture.json"),
    decisionFixture("constrained-noul-confidence.fixture.json"),
  ];
  asyncFetchHandler = (opts) => {
    if (opts.url.endsWith("/chat/completions")) {
      return { status: 200, body: JSON.stringify(responses.shift()) };
    }
    return { status: 200, body: JSON.stringify({ data: [{ id: "catalog-model", name: "Catalog Model" }] }) };
  };

  decide(decisionRequest({ type: "noul", criteria: null }));
  const models = decisionModels();

  assert(models.length === 1 && models[0].id === "catalog-model", "loaded model id remains selectable");
  assert(models[0].display_name === "Catalog Model (approximate fallback)", "model info marks constrained fallback as approximate");
});

test("decision_select_model_applies_without_a_fetch_and_reports_the_model_id", () => {
  reset({ decision: { model: "configured-model" } });
  asyncFetchHandler = () => { throw new Error("selectModel must not fetch"); };
  assert(plugin.modelId() === "configured-model", "configured model is reported before selection");
  assert(plugin.selectModel("other-model") === true, "a host-verified id is applied");
  assert(plugin.modelId() === "other-model", "the applied model is reported back");
  assert(plugin.selectModel("") === false, "an empty id is refused");
  assert(plugin.metadata().display_name === "LM Studio", "metadata names the adapter");
});

test("decision_selected_model_reaches_remote_requests_independently_of_chat_session_model", () => {
  const endpoint = "http://eight.tail0e459c.ts.net:1234";
  reset({ baseUrl: endpoint, model: "general-model", decision: { model: "configured-decision", logprobsMode: "constrained" }, presets: [] });
  const adapter = loadPlugin();
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(decisionFixture("constrained-noul-confidence.fixture.json")) });
  adapter.openSession({ tabId: "independent-selection", config: {}, model: "chat-model" });
  assert(adapter.selectModel("supporter-model") === true, "Supporter model selection is accepted");

  const answer = settleFetchExport(adapter.decide(decisionRequest({ type: "noul" })), "selected model decision");
  assert(answer.type === "noul", "selected model produces a decision through the async continuation");
  assert(fetchCalls.length === 1, "selected model needs no extra catalogue request");
  assert(fetchCalls[0].url === `${endpoint}/v1/chat/completions`, "selection retains the remote endpoint");
  assert(JSON.parse(fetchCalls[0].body).model === "supporter-model", "request uses the selection ahead of configured models");
  assert(!Object.keys(fetchCalls[0].headers).some((key) => key.toLowerCase() === "authorization"), "plugin request requires no token setting; the host owns optional authentication");
  assert(adapter.sessionInfo("independent-selection").model === "chat-model", "Supporter selection preserves the chat model");

  adapter.setModel("independent-selection", "next-chat-model");
  adapter.sendMessage("independent-selection", "hello");
  assert(JSON.parse(streamCalls[0].body).model === "next-chat-model", "chat stream uses the changed chat model");
  assert(adapter.modelId() === "supporter-model", "chat model switch preserves Supporter selection");
  assert(adapter.selectModel("") === false && adapter.modelId() === "supporter-model", "refused selection preserves the applied model");
  settleFetchExport(adapter.decide(decisionRequest({ type: "noul" })), "decision after chat switch");
  assert(JSON.parse(fetchCalls[1].body).model === "supporter-model", "later decisions retain Supporter selection after chat changes");
  assert(settingsObj.decision.model === "configured-decision" && settingsObj.model === "general-model", "selection leaves configured model defaults intact");
  adapter.closeSession("independent-selection");
});

test("decision_model_id_reports_catalogue_fallback_and_metadata_normalizes_remote_address", () => {
  const endpoint = "http://eight.tail0e459c.ts.net:1234";
  reset({ baseUrl: ` ${endpoint}/v1/// ` });
  const adapter = loadPlugin();
  assert(adapter.modelId() === null, "no selected, configured or discovered model initially");
  asyncFetchHandler = () => ({ status: 200, body: JSON.stringify(decisionFixture("models.fixture.json")) });
  const models = settleFetchExport(adapter.models(), "catalogue fallback models");
  assert(models.length > 0 && adapter.modelId() === models[0].id, "modelId reports the first discovered model fallback");
  assert(adapter.metadata().server_address === endpoint, "metadata reports the normalized configured server address");
});


// ── Router: multi-provider routing, keys, usage, verbs, view bridge ──

const ROUTER_STATE = "/tmp/codeterm-home/.codeterm/plugin-data/lmstudio/router.json";
const MIMO_KEY = "tp-0123456789abcdef";

function routerSettings(extra) {
  return Object.assign({ baseUrl: "http://localhost:1234", presets: [] }, extra || {});
}

function seedRouter(state) {
  fileStore[ROUTER_STATE] = JSON.stringify(state);
}

function mimoProviders() {
  return {
    providers: [
      { id: "mimo", name: "Xiaomi MiMo", kind: "openai", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", apiKeySecret: "mimo_api_key" },
      { id: "mimo-anthropic", name: "MiMo (Anthropic)", kind: "anthropic", baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic", apiKeySecret: "mimo_api_key" },
    ],
  };
}

function oaiChunk(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }
function anthEvent(type, obj) { return `event: ${type}\ndata: ${JSON.stringify(Object.assign({ type }, obj))}\n\n`; }

function allText() {
  return JSON.stringify(fileStore) + JSON.stringify(settingsObj) + logLines.join("\n");
}

test("router_openai_provider_streams_through_chat_completions_with_bearer_key_and_usage_line", () => {
  reset(routerSettings());
  seedRouter(mimoProviders());
  secretStore.mimo_api_key = MIMO_KEY;
  plugin.openSession({ tabId: "r-oai", config: {}, model: "mimo::mimo-v2.6-pro", systemPrompt: "Be brief." });
  assert(plugin.sessionInfo("r-oai").model === "mimo::mimo-v2.6-pro", "session reports the qualified model");
  plugin.sendMessage("r-oai", "reply with OK");
  const call = streamCalls[0];
  assert(call.url === "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions", "openai route, got " + call.url);
  assert(call.headers.authorization === `Bearer ${MIMO_KEY}`, "bearer key header");
  const body = JSON.parse(call.body);
  assert(body.model === "mimo-v2.6-pro" && body.stream === true, "bare model id on the wire");
  assertJsonEqual(body.messages, [{ role: "system", content: withContext("Be brief.") }, { role: "user", content: "reply with OK" }], "system + user messages");
  assert(!call.body.includes(MIMO_KEY), "key never in the request body");
  enqueueStream(0, [
    { chunks: [oaiChunk({ id: "c1", choices: [{ delta: { content: "O" } }] })], done: false, status: 200 },
    { chunks: [oaiChunk({ choices: [{ delta: { content: "K" } }] }), oaiChunk({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1024 } } }), "data: [DONE]\n\n"], done: true, status: 200 },
  ]);
  const p = pumpUntilDone("r-oai");
  assert(contents(p.messages, "assistant").join("") === "OK", "assistant reply OK, got " + contents(p.messages, "assistant"));
  const usage = contents(p.messages, "system").find((m) => /cached/.test(m));
  assert(usage === "mimo::mimo-v2.6-pro · 1,200 in · 1,024 cached · 176 fresh · 2 out", "usage line, got " + usage);
  assert(!allText().includes(MIMO_KEY), "key never in settings, state files or logs");
  plugin.closeSession("r-oai");
});

test("router_anthropic_provider_uses_messages_api_cache_breakpoints_and_cache_read_usage", () => {
  reset(routerSettings());
  seedRouter(mimoProviders());
  secretStore.mimo_api_key = MIMO_KEY;
  plugin.openSession({ tabId: "r-anth", config: {}, model: "mimo-anthropic::mimo-v2.6-pro", systemPrompt: "LONG STABLE PREFIX" });
  plugin.sendMessage("r-anth", "first");
  let call = streamCalls[0];
  assert(call.url === "https://token-plan-sgp.xiaomimimo.com/anthropic/v1/messages", "anthropic route, got " + call.url);
  assert(call.headers["x-api-key"] === MIMO_KEY && call.headers["anthropic-version"] === "2023-06-01", "anthropic auth headers");
  assert(!call.headers.authorization, "no bearer header for anthropic");
  let body = JSON.parse(call.body);
  assertJsonEqual(body.system, [{ type: "text", text: withContext("LONG STABLE PREFIX"), cache_control: { type: "ephemeral" } }], "system block is a breakpoint");
  assert(body.max_tokens === 4096, "default max_tokens");
  enqueueStream(0, [{
    chunks: [
      anthEvent("message_start", { message: { id: "msg_1", usage: { input_tokens: 20, cache_creation_input_tokens: 1500, output_tokens: 1 } } }),
      anthEvent("content_block_delta", { delta: { type: "text_delta", text: "OK" } }),
      anthEvent("message_delta", { usage: { output_tokens: 2 } }),
      anthEvent("message_stop", {}),
    ],
    done: true,
    status: 200,
  }]);
  pumpUntilDone("r-anth");
  plugin.sendMessage("r-anth", "second");
  call = streamCalls[1];
  body = JSON.parse(call.body);
  assert(body.messages.length === 3, "stateless history resent, got " + body.messages.length);
  assert(body.messages[1].role === "assistant" && body.messages[1].content[0].cache_control, "breakpoint on the turn before the newest user message");
  assert(!body.messages[2].content[0].cache_control, "newest user turn is not cached");
  assert(JSON.stringify(body).split("cache_control").length - 1 === 2, "exactly two breakpoints");
  enqueueStream(1, [{
    chunks: [
      anthEvent("message_start", { message: { id: "msg_2", usage: { input_tokens: 9, cache_read_input_tokens: 1500, output_tokens: 1 } } }),
      anthEvent("content_block_delta", { delta: { type: "text_delta", text: "OK again" } }),
      anthEvent("message_delta", { usage: { output_tokens: 3 } }),
    ],
    done: true,
    status: 200,
  }]);
  const p = pumpUntilDone("r-anth");
  const usage = contents(p.messages, "system").filter((m) => /in · /.test(m));
  assert(usage[0] === "mimo-anthropic::mimo-v2.6-pro · 1,520 in · 0 cached · 1,520 fresh · 1,500 cache write · 2 out", "first usage, got " + usage[0]);
  assert(usage[1] === "mimo-anthropic::mimo-v2.6-pro · 1,509 in · 1,500 cached · 9 fresh · 3 out", "second usage, got " + usage[1]);
  plugin.closeSession("r-anth");
});

test("router_http_error_is_typed_and_redacts_an_echoed_key", () => {
  reset(routerSettings());
  seedRouter(mimoProviders());
  secretStore.mimo_api_key = MIMO_KEY;
  plugin.openSession({ tabId: "r-401", config: {}, model: "mimo::mimo-v2.6-pro" });
  plugin.sendMessage("r-401", "hi");
  enqueueStream(0, [{ chunks: [], done: true, status: 401, body: JSON.stringify({ error: { message: `invalid key ${MIMO_KEY}` } }) }]);
  const p = pumpUntilDone("r-401");
  const err = contents(p.messages, "system").join("\n");
  assert(/Xiaomi MiMo HTTP 401/.test(err) && /check the API key/.test(err), "typed auth error, got " + err);
  assert(!JSON.stringify(p.messages).includes(MIMO_KEY), "echoed key is redacted from the transcript");
});

test("router_unknown_provider_reports_a_route_error_without_network", () => {
  reset(routerSettings());
  plugin.openSession({ tabId: "r-unknown", config: {}, model: "ghost::m" });
  plugin.sendMessage("r-unknown", "hi");
  const p = pumpUntilDone("r-unknown");
  assert(streamCalls.length === 0, "no stream for an unknown provider");
  assert(contents(p.messages, "system").some((m) => /unknown provider "ghost"/.test(m)), "route error surfaced");
});

test("router_setModel_switches_provider_for_the_next_turn", () => {
  reset(routerSettings());
  seedRouter(mimoProviders());
  secretStore.mimo_api_key = MIMO_KEY;
  plugin.openSession({ tabId: "r-switch", config: {}, model: "llama-3" });
  plugin.setModel("r-switch", "mimo::mimo-v2.6-flash");
  assert(plugin.sessionInfo("r-switch").model === "mimo::mimo-v2.6-flash", "qualified model after switch");
  plugin.sendMessage("r-switch", "hi");
  assert(streamCalls[0].url.endsWith("/v1/chat/completions") && JSON.parse(streamCalls[0].body).model === "mimo-v2.6-flash", "next turn routes to mimo");
  plugin.setModel("r-switch", "llama-3");
  assert(plugin.sessionInfo("r-switch").model === "llama-3", "bare id switches back to LM Studio");
  plugin.closeSession("r-switch");
});

test("router_listModels_groups_providers_and_skips_providers_missing_a_key", () => {
  reset(routerSettings());
  seedRouter(mimoProviders());
  fetchHandler = (opts) => {
    if (opts.url.endsWith("/api/v0/models")) return JSON.stringify({ status: 200, body: JSON.stringify({ data: [{ id: "qwen", type: "vlm", state: "loaded", max_context_length: 32768 }] }) });
    throw new Error("no fetch expected without a key: " + opts.url);
  };
  let models = plugin.listModels();
  assertJsonEqual(models.map((m) => [m.id, m.group, m.badge]), [["qwen", "LM Studio", "loaded"]], "only LM Studio without a key");

  plugin.__test_resetRouter();
  secretStore.mimo_api_key = MIMO_KEY;
  const seen = [];
  fetchHandler = (opts) => {
    seen.push([opts.url, opts.headers.authorization || opts.headers["x-api-key"] || ""]);
    if (opts.url.endsWith("/api/v0/models")) return JSON.stringify({ status: 200, body: JSON.stringify({ data: [] }) });
    return JSON.stringify({ status: 200, body: JSON.stringify({ data: [{ id: "mimo-v2.6-pro" }, { id: "mimo-v2.6-flash", context_length: 262144 }] }) });
  };
  models = plugin.listModels();
  assertJsonEqual(
    models.map((m) => [m.id, m.group]),
    [["mimo::mimo-v2.6-pro", "Xiaomi MiMo"], ["mimo::mimo-v2.6-flash", "Xiaomi MiMo"], ["mimo-anthropic::mimo-v2.6-pro", "MiMo (Anthropic)"], ["mimo-anthropic::mimo-v2.6-flash", "MiMo (Anthropic)"]],
    "models grouped per provider",
  );
  assert(models[1].badge === "262k", "context badge");
  assertJsonEqual(seen.slice(1).map((x) => x[0]), ["https://token-plan-sgp.xiaomimimo.com/v1/models", "https://token-plan-sgp.xiaomimimo.com/anthropic/v1/models"], "per-kind model endpoints");
  assert(seen[1][1] === `Bearer ${MIMO_KEY}` && seen[2][1] === MIMO_KEY, "per-kind auth");
  const before = seen.length;
  plugin.listModels();
  assert(seen.length === before, "a second listing within the TTL is served from the cache");
  assert(!allText().includes(MIMO_KEY), "model cache never stores the key");
});

test("router_preset_with_provider_model_and_knobs_routes_and_maps_params", () => {
  reset(routerSettings());
  seedRouter(Object.assign(mimoProviders(), { presets: [{ id: "mimo-fast", name: "MiMo fast", provider: "mimo", model: "mimo-v2.6-flash", temperature: 0.2, maxTokens: 64, systemPrompt: "Terse." }] }));
  secretStore.mimo_api_key = MIMO_KEY;
  const presets = plugin.listPresets();
  assert(presets.some((p) => p.id === "mimo-fast"), "user preset listed");
  plugin.openSession({ tabId: "r-preset", config: {}, preset: "mimo-fast" });
  assert(plugin.sessionInfo("r-preset").model === "mimo::mimo-v2.6-flash", "preset routes to its provider/model, got " + plugin.sessionInfo("r-preset").model);
  plugin.sendMessage("r-preset", "hi");
  const body = JSON.parse(streamCalls[0].body);
  assert(body.temperature === 0.2 && body.max_tokens === 64, "preset knobs on the wire");
  assert(ownPrompt(body.messages[0].content) === "Terse.", "preset system prompt");
  plugin.closeSession("r-preset");
});

test("router_agent_verbs_manage_providers_and_presets_without_touching_keys", () => {
  reset(routerSettings());
  let r = plugin.onAgentCommand({ sessionId: "a", verb: "add-provider", args: ["mimo", "openai", "https://token-plan-sgp.xiaomimimo.com/v1", "--name", "Xiaomi MiMo"] });
  assert(r.result && /added mimo/.test(r.result), "added, got " + JSON.stringify(r));
  assert(/--secret mimo_api_key/.test(r.result), "next step names the declared key slot");
  assert(/--allow-host token-plan-sgp\.xiaomimimo\.com/.test(r.result), "next step names the host grant");
  const state = JSON.parse(fileStore[ROUTER_STATE]);
  assertJsonEqual(state.providers, [{ id: "mimo", name: "Xiaomi MiMo", kind: "openai", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", apiKeySecret: "mimo_api_key" }], "state has no key material");
  r = plugin.onAgentCommand({ sessionId: "a", verb: "add-provider", args: ["mimo", "openai", "https://x/v1"] });
  assert(r.error && /already exists/.test(r.error), "duplicate refused");
  r = plugin.onAgentCommand({ sessionId: "a", verb: "providers", args: [] });
  assert(/^lmstudio\tlmstudio/m.test(r.result) && /^mimo\topenai\tkey_missing/m.test(r.result) && /key=mimo_api_key:unset/.test(r.result), "providers table, got " + r.result);
  r = plugin.onAgentCommand({ sessionId: "a", verb: "add-preset", args: ["quick", "mimo::mimo-v2.6-flash", "--temperature", "0.3", "--max-tokens", "100"] });
  assert(r.result === "saved preset quick", "preset saved, got " + JSON.stringify(r));
  r = plugin.onAgentCommand({ sessionId: "a", verb: "presets", args: [] });
  assert(/quick\tquick\tmimo::mimo-v2.6-flash\tt=0.3 max=100/.test(r.result), "presets table, got " + r.result);
  r = plugin.onAgentCommand({ sessionId: "a", verb: "add-preset", args: ["hot", "mimo::x", "--temperature", "9"] });
  assert(r.error && /Temperature/.test(r.error), "invalid knob refused");
  secretStore.mimo_api_key = MIMO_KEY;
  fetchHandler = (opts) => {
    if (opts.url.indexOf("localhost") >= 0) return JSON.stringify({ error: "connection refused" });
    return JSON.stringify({ status: 200, body: JSON.stringify({ data: [{ id: "mimo-v2.6-pro" }, { id: "mimo-v2.6-flash" }] }) });
  };
  r = plugin.onAgentCommand({ sessionId: "a", verb: "models", args: ["mimo", "flash"] });
  assert(/## Xiaomi MiMo \(mimo\) — 1\/2/.test(r.result) && /^mimo::mimo-v2.6-flash$/m.test(r.result), "filtered section, got " + r.result);
  r = plugin.onAgentCommand({ sessionId: "a", verb: "remove-provider", args: ["lmstudio"] });
  assert(r.error && /built in/.test(r.error), "builtin cannot be removed");
  r = plugin.onAgentCommand({ sessionId: "a", verb: "remove-provider", args: ["mimo"] });
  assert(/removed mimo/.test(r.result), "removed");
  assert(JSON.parse(fileStore[ROUTER_STATE]).presets.length === 0, "presets of a removed provider go with it");
  assert(plugin.onAgentCommand({ sessionId: "a", verb: "bogus", args: [] }).error, "unknown verb errors");
  assert(!allText().includes(MIMO_KEY), "verbs never persist keys");
});

test("router_view_bridge_stores_keys_in_the_secret_bucket_and_never_returns_them", () => {
  reset(routerSettings());
  let r = plugin.viewCall("addProvider", { provider: { id: "mimo", name: "Xiaomi MiMo", kind: "openai", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" } });
  assert(r.ok && r.provider.status.state === "key_missing", "added with key missing, got " + JSON.stringify(r));
  r = plugin.viewCall("addProvider", { provider: { id: "BAD ID", kind: "x", baseUrl: "nope" } });
  assert(!r.ok && r.fieldErrors.length === 3, "field errors for the form, got " + JSON.stringify(r));
  r = plugin.viewCall("setProviderKey", { id: "mimo", key: `  ${MIMO_KEY}  ` });
  assert(r.ok === true && Object.keys(r).length === 1, "set returns only ok");
  assert(secretStore.mimo_api_key === MIMO_KEY, "key trimmed into the declared slot");
  fetchHandler = (opts) => JSON.stringify(opts.url.indexOf("localhost") >= 0 ? { error: "fetch denied: localhost:1234" } : { status: 200, body: JSON.stringify({ data: [{ id: "mimo-v2.6-pro" }] }) });
  r = plugin.viewCall("testProvider", { id: "mimo" });
  assert(r.ok && r.provider.status.state === "connected" && r.provider.status.modelCount === 1, "connected after test, got " + JSON.stringify(r.provider.status));
  r = plugin.viewCall("testProvider", { id: "lmstudio" });
  assert(r.provider.status.state === "denied" && /--allow-host localhost:1234/.test(r.provider.status.message), "denied status carries the grant command");
  const overview = plugin.viewCall("overview", {});
  assert(overview.providers.find((p) => p.id === "mimo").hasKey === true, "overview reports key presence");
  assert(overview.templates.length > 5 && overview.kinds.length === 3, "templates and kinds for the form");
  const sections = plugin.viewCall("models", { query: "pro" }).sections;
  assert(sections.find((s) => s.providerId === "mimo").models[0].id === "mimo::mimo-v2.6-pro", "model sections with qualified ids");
  r = plugin.viewCall("savePreset", { preset: { id: "p1", provider: "mimo", model: "mimo-v2.6-pro", temperature: "0.5" }, replace: false });
  assert(r.ok, "preset saved");
  r = plugin.viewCall("savePreset", { preset: { id: "p1", name: "renamed" }, replace: false });
  assert(!r.ok && r.fieldErrors[0].field === "id", "duplicate preset id reported on the id field");
  r = plugin.viewCall("savePreset", { preset: { id: "p1", name: "renamed" }, replace: true });
  assert(r.ok && r.preset.name === "renamed", "replace edits in place");
  plugin.viewCall("setProviderEnabled", { id: "lmstudio", enabled: false });
  assert(plugin.viewCall("overview", {}).defaultProvider === "mimo", "disabling LM Studio moves the default");
  for (const method of ["overview", "models"]) assert(!JSON.stringify(plugin.viewCall(method, {})).includes(MIMO_KEY), method + " never returns the key");
  r = plugin.viewCall("clearProviderKey", { id: "mimo" });
  assert(r.ok && secretStore.mimo_api_key === undefined, "key cleared");
  assert(!allText().includes(MIMO_KEY), "no key in settings, state or logs");
});

test("router_provider_without_model_listing_falls_back_to_configured_model_ids", () => {
  reset(routerSettings());
  secretStore.mimo_api_key = MIMO_KEY;
  let r = plugin.onAgentCommand({ sessionId: "a", verb: "add-provider", args: ["mimo-anthropic", "anthropic", "https://token-plan-sgp.xiaomimimo.com/anthropic", "--key-slot", "mimo_api_key", "--models", "mimo-v2.6-pro,mimo-v2.6-flash"] });
  assert(r.result, "added, got " + JSON.stringify(r));
  fetchHandler = (opts) => JSON.stringify(opts.url.indexOf("localhost") >= 0 ? { error: "connection refused" } : { status: 404, body: "<html><title>404 Not Found</title><h1>404 Not Found</h1></html>" });
  r = plugin.onAgentCommand({ sessionId: "a", verb: "test-provider", args: ["mimo-anthropic"] });
  assert(/connected — No model listing here; using 2 configured models/.test(r.result), "configured fallback, got " + r.result);
  const ids = plugin.listModels().map((m) => m.id);
  assertJsonEqual(ids, ["mimo-anthropic::mimo-v2.6-pro", "mimo-anthropic::mimo-v2.6-flash"], "configured ids listed");
  plugin.__test_resetRouter();
  r = plugin.onAgentCommand({ sessionId: "a", verb: "add-provider", args: ["bare-anth", "anthropic", "https://other.example/anthropic", "--key-slot", "mimo_api_key"] });
  r = plugin.onAgentCommand({ sessionId: "a", verb: "test-provider", args: ["bare-anth"] });
  assert(/error — Endpoint not found \(HTTP 404\): 404 Not Found$/m.test(r.result), "404 without configured ids stays an error with clean text, got " + r.result);
});

test("router_failed_discovery_is_cached_briefly_and_a_new_key_invalidates_it", () => {
  reset(routerSettings({ baseUrl: "http://localhost:1234" }));
  seedRouter({ providers: [mimoProviders().providers[0]], disabled: ["lmstudio"] });
  secretStore.mimo_api_key = "old-key";
  const urls = [];
  fetchHandler = (opts) => {
    urls.push(opts.url);
    return JSON.stringify({ status: 401, body: JSON.stringify({ error: { message: "bad key" } }) });
  };
  plugin.listModels();
  plugin.listModels();
  assert(urls.length === 1, "an auth failure is not re-probed on every picker open, got " + urls.length);
  plugin.viewCall("setProviderKey", { id: "mimo", key: MIMO_KEY });
  fetchHandler = (opts) => {
    urls.push(opts.url);
    return JSON.stringify({ status: 200, body: JSON.stringify({ data: [{ id: "mimo-v2.6-pro" }] }) });
  };
  const ids = plugin.listModels().map((m) => m.id);
  assert(urls.length === 2 && ids[0] === "mimo::mimo-v2.6-pro", "new key re-probes at once, got " + JSON.stringify(ids));
});

test("router_manifest_declares_view_secrets_agent_verbs_and_key_slots", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"));
  assert(manifest.id === "lmstudio", "plugin id kept for upgrade continuity");
  assert(manifest.capabilities.view === true, "view capability");
  assert(manifest.permissions.secrets === true && manifest.permissions.agentCommands === true, "secrets + agent commands");
  for (const verb of ["providers", "add-provider", "remove-provider", "models", "presets", "add-preset"]) {
    assert(manifest.agentVerbs.some((v) => v.split(" ")[0] === verb), "verb declared: " + verb);
  }
  const schema = JSON.parse(readFileSync(join(__dirname, "settings.schema.json"), "utf8"));
  const slots = [];
  const walk = (fields) => fields.forEach((f) => (f.kind === "api_key" ? slots.push(f.env_var) : f.fields && walk(f.fields)));
  walk(schema);
  for (const slot of ["mimo_api_key", "openrouter_api_key", "anthropic_api_key", "custom1_api_key"]) assert(slots.includes(slot), "declared key slot " + slot);
});

let failed = 0;
// ── Router: native tool calls and the Qwen/Hermes text fallback ──
const DECLARED_TOOLS = ["codeterm", "exec", "mem_search", "read_file", "spawn_agent", "write_file"];

function pumpUntilStreams(sid, count, limit = 50) {
  for (let i = 0; i < limit && streamCalls.length < count; i += 1) plugin.pump(sid);
  assert(streamCalls.length >= count, `expected ${count} stream requests, got ${streamCalls.length}`);
}

function openMimo(sid, model) {
  reset(routerSettings());
  seedRouter(mimoProviders());
  secretStore.mimo_api_key = MIMO_KEY;
  plugin.openSession({ tabId: sid, config: {}, model: model || "mimo::mimo-v2.6-pro" });
}

function oaiDone(text) {
  return [{ chunks: [oaiChunk({ choices: [{ delta: { content: text } }] }), "data: [DONE]\n\n"], done: true, status: 200 }];
}

function shellOf(execCall) {
  return execCall.args[execCall.args.length - 1].replace(/^(export [A-Z_]+=[^;]*; )+/, "");
}

test("router_native_openai_tool_call_executes_and_loops_with_tool_history", () => {
  openMimo("t-oai");
  plugin.sendMessage("t-oai", "list my tabs");
  let body = JSON.parse(streamCalls[0].body);
  assertJsonEqual(body.tools.map((t) => t.function.name).sort(), DECLARED_TOOLS, "declared tools on the wire");
  assert(body.tools.every((t) => t.type === "function" && t.function.parameters.type === "object"), "OpenAI function schema");
  assert(body.tool_choice === "auto", "tool_choice auto");
  enqueueStream(0, [{
    chunks: [
      oaiChunk({ id: "c1", choices: [{ delta: { reasoning_content: "Need the tab list." } }] }),
      oaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "codeterm", arguments: "" } }] } }] }),
      oaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"args\":\"tab" } }] } }] }),
      oaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: " list\"}" } }] }, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    ],
    done: true,
    status: 200,
  }]);
  enqueueExec([{ done: true, code: 0, stdout: "e3ec9ee9 Fermi\n", stderr: "" }]);
  pumpUntilStreams("t-oai", 2);
  assert(execCalls.length === 1 && shellOf(execCalls[0]) === "codeterm tab list", "declared tool executed once, got " + JSON.stringify(execCalls));
  assert(/^export CODETERM_TAB_ID='t-oai'; /.test(execCalls[0].args[1]), "tool shell carries this tab's identity");
  const rows = plugin.poll("t-oai", null).messages;
  const call = rows.find((m) => m.type === "tool_call");
  assert(call && call.toolName === "codeterm" && call.content === "codeterm tab list", "tool row shows the command");
  assert(rows.some((m) => m.type === "thinking" && m.content === "Need the tab list."), "reasoning lands in the thinking row");
  body = JSON.parse(streamCalls[1].body);
  const assistant = body.messages.find((m) => m.role === "assistant");
  assertJsonEqual(assistant.tool_calls, [{ id: "call_a", type: "function", function: { name: "codeterm", arguments: "{\"args\":\"tab list\"}" } }], "assistant tool_calls replayed");
  const tool = body.messages.find((m) => m.role === "tool");
  assert(tool && tool.tool_call_id === "call_a" && tool.content.includes("e3ec9ee9 Fermi"), "tool result fed back by id");
  assert(!body.messages.some((m) => m.role === "user" && /tool_result/.test(m.content)), "no text tool_result turn for a native call");
  assert(body.messages.filter((m) => m.role === "user").length === 1, "user turn sent once");
  enqueueStream(1, oaiDone("One tab: Fermi (e3ec9ee9)."));
  const p = pumpUntilDone("t-oai");
  assert(contents(p.messages, "assistant").pop() === "One tab: Fermi (e3ec9ee9).", "answer after the tool result");
  assert(streamCalls.length === 2, "loop ends after a text answer");
  plugin.closeSession("t-oai");
});

test("router_two_native_calls_run_before_one_continuation", () => {
  openMimo("t-two");
  plugin.sendMessage("t-two", "tabs and help");
  enqueueStream(0, [{
    chunks: [
      oaiChunk({ choices: [{ delta: { tool_calls: [
        { index: 0, id: "c0", function: { name: "codeterm", arguments: "{\"args\":\"tab list\"}" } },
        { index: 1, id: "c1", function: { name: "exec", arguments: "{\"cmd\":\"codeterm --help\"}" } },
      ] } }] }),
      "data: [DONE]\n\n",
    ],
    done: true,
    status: 200,
  }]);
  pumpUntilStreams("t-two", 2);
  for (let i = 0; i < 5; i += 1) plugin.pump("t-two");
  assert(streamCalls.length === 2, "one continuation for the whole round, got " + streamCalls.length);
  assertJsonEqual(execCalls.map(shellOf), ["codeterm tab list", "codeterm --help"], "both calls executed in order");
  const body = JSON.parse(streamCalls[1].body);
  assertJsonEqual(body.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id), ["c0", "c1"], "both results paired");
  plugin.closeSession("t-two");
});

test("router_text_fallback_runs_the_exact_mimo_strings_as_tool_rows", () => {
  const replies = [
    ["Let me look.\n<tool_call><function=exec><parameter=cmd>codeterm pane list</tool_call>", "codeterm pane list", "Let me look."],
    ["<tool_call><function=exec><parameter=cmd>codeterm --help</tool_call>", "codeterm --help", ""],
  ];
  for (const [reply, cmd, prose] of replies) {
    openMimo("t-txt");
    plugin.sendMessage("t-txt", "create a couple of tabs");
    enqueueStream(0, oaiDone(reply));
    pumpUntilStreams("t-txt", 2);
    assert(execCalls.length === 1 && shellOf(execCalls[0]) === cmd, "text-form call executed: " + cmd);
    const rows = plugin.poll("t-txt", null).messages;
    assert(rows.some((m) => m.type === "tool_call" && m.toolName === "exec" && m.content === cmd), "shown as a tool row");
    assertJsonEqual(contents(rows, "assistant"), prose ? [prose] : [], "raw call text is not shown");
    const body = JSON.parse(streamCalls[1].body);
    const assistant = body.messages.find((m) => m.role === "assistant");
    assert(assistant.tool_calls[0].function.name === "exec", "replayed as a native call");
    assert(body.messages.find((m) => m.role === "tool").tool_call_id === assistant.tool_calls[0].id, "result paired with the synthetic id");
    plugin.closeSession("t-txt");
  }
});

test("router_undeclared_tools_never_execute", () => {
  openMimo("t-bad");
  plugin.sendMessage("t-bad", "go");
  enqueueStream(0, [{ chunks: [oaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "x1", function: { name: "shell", arguments: "{\"cmd\":\"rm -rf /\"}" } }] } }] }), "data: [DONE]\n\n"], done: true, status: 200 }]);
  pumpUntilStreams("t-bad", 2);
  assert(execCalls.length === 0, "undeclared native tool not executed");
  const tool = JSON.parse(streamCalls[1].body).messages.find((m) => m.role === "tool");
  assert(tool && tool.tool_call_id === "x1" && /unknown tool/.test(tool.content), "error result keeps the call paired");
  plugin.closeSession("t-bad");

  openMimo("t-bad2");
  plugin.sendMessage("t-bad2", "go");
  enqueueStream(0, oaiDone("<tool_call><function=shell><parameter=cmd>rm -rf /</parameter></function></tool_call>"));
  pumpUntilStreams("t-bad2", 2);
  assert(execCalls.length === 0, "undeclared text-form tool not executed");
  assert(toolParseCalls.length === 0, "a tool_call block never falls through to a looser parser");
  const last = JSON.parse(streamCalls[1].body).messages.pop();
  assert(last.role === "user" && /invalid/.test(last.content), "corrective note asks for a valid call");
  plugin.closeSession("t-bad2");
});

test("router_native_anthropic_tool_use_executes_and_replays_blocks", () => {
  openMimo("t-anth", "mimo-anthropic::mimo-v2.6-pro");
  plugin.sendMessage("t-anth", "list my tabs");
  let body = JSON.parse(streamCalls[0].body);
  assertJsonEqual(body.tools.map((t) => t.name).sort(), DECLARED_TOOLS, "declared tools on the wire");
  assert(body.tools.every((t) => t.input_schema.type === "object"), "Anthropic input_schema");
  assertJsonEqual(body.tool_choice, { type: "auto" }, "tool_choice auto");
  enqueueStream(0, [{
    chunks: [
      anthEvent("message_start", { message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } } }),
      anthEvent("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "codeterm", input: {} } }),
      anthEvent("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{\"args\":" } }),
      anthEvent("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "\"tab list\"}" } }),
      anthEvent("content_block_stop", { index: 0 }),
      anthEvent("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
    ],
    done: true,
    status: 200,
  }]);
  pumpUntilStreams("t-anth", 2);
  assert(execCalls.length === 1 && shellOf(execCalls[0]) === "codeterm tab list", "tool_use executed");
  body = JSON.parse(streamCalls[1].body);
  const assistant = body.messages.find((m) => m.role === "assistant");
  assertJsonEqual(assistant.content.map((b) => [b.type, b.id, b.name, b.input]), [["tool_use", "toolu_1", "codeterm", { args: "tab list" }]], "tool_use block replayed");
  const result = body.messages[body.messages.length - 1];
  assert(result.role === "user" && result.content[0].type === "tool_result" && result.content[0].tool_use_id === "toolu_1", "tool_result block answers it");
  plugin.closeSession("t-anth");
});

test("lmstudio_native_text_call_feeds_results_back_as_input", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [] });
  plugin.openSession({ tabId: "t-lms", config: {}, model: "qwen3-coder" });
  plugin.sendMessage("t-lms", "list tabs");
  assert(!JSON.parse(streamCalls[0].body).tools, "LM Studio native chat gets no native tools");
  enqueueStream(0, [{ chunks: [msg("<tool_call>\n<function=codeterm>\n<parameter=args>\ntab list\n</parameter>\n</function>\n</tool_call>"), chatEnd("resp-1")], done: true, status: 200 }]);
  pumpUntilStreams("t-lms", 2);
  assert(execCalls.length === 1 && shellOf(execCalls[0]) === "codeterm tab list", "text call executed");
  const body = JSON.parse(streamCalls[1].body);
  assert(body.previous_response_id === "resp-1" && /^tool_result:/.test(body.input), "result continues the stateful chain");
  plugin.closeSession("t-lms");
});

test("lmstudio_native_usage_reads_cache_fields", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [] });
  plugin.openSession({ tabId: "t-usage", config: {}, model: "qwen3" });
  plugin.sendMessage("t-usage", "hi");
  enqueueStream(0, [{ chunks: [msg("hello"), sse("chat.end", { result: { response_id: "r1", stats: { input_tokens: 100, total_output_tokens: 5, cached_tokens: 64 } } })], done: true, status: 200 }]);
  const p = pumpUntilDone("t-usage");
  const usage = contents(p.messages, "system").find((m) => / in · /.test(m));
  assert(usage === "qwen3 · 100 in · 64 cached · 36 fresh · 5 out", "cached input reported, got " + usage);
  plugin.closeSession("t-usage");
});

test("router_activity_tracks_the_request_and_cancel_stops_it", () => {
  openMimo("t-act");
  assert(plugin.poll("t-act", null).activity.state === "idle", "idle before a send");
  plugin.sendMessage("t-act", "list my tabs");
  assert(plugin.poll("t-act", null).activity.state === "thinking", "thinking once the request starts");
  enqueueStream(0, [{ chunks: [oaiChunk({ choices: [{ delta: { content: "Work" } }] })], done: false, status: 200 }]);
  plugin.pump("t-act");
  const working = plugin.poll("t-act", null);
  assert(working.activity.state === "working" && !working.done, "working while answer tokens stream");
  assert(working.activity.statusLine.includes("mimo::mimo-v2.6-pro"), "status line names the model");
  plugin.cancel("t-act");
  const stopped = plugin.poll("t-act", null);
  assert(streamJobs[0].closed, "cancel closes the in-flight request");
  assert(stopped.done && stopped.activity.state === "idle" && stopped.activity.statusLine === "", "cancel clears the working state");
  plugin.pump("t-act");
  assert(streamCalls.length === 1, "nothing restarts after cancel");
  plugin.closeSession("t-act");
});

test("router_cancel_during_a_tool_closes_the_exec_and_keeps_history_paired", () => {
  openMimo("t-cx");
  plugin.sendMessage("t-cx", "go");
  enqueueStream(0, [{ chunks: [oaiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c9", function: { name: "exec", arguments: "{\"cmd\":\"sleep-like\"}" } }] } }] }), "data: [DONE]\n\n"], done: true, status: 200 }]);
  enqueueExec([{ done: false }, { done: false }]);
  plugin.pump("t-cx");
  assert(plugin.poll("t-cx", null).activity.state === "working", "working while a tool runs");
  plugin.cancel("t-cx");
  assert(execJobs[0].closed, "cancel closes the exec job");
  const p = plugin.poll("t-cx", null);
  assert(p.done && p.messages.some((m) => m.type === "tool_result" && m.callId === "c9" && /cancelled/.test(m.content)), "call answered as cancelled");
  plugin.closeSession("t-cx");
});

// ── Router: user state outlives reinstall; live sessions follow the registry ──
const LEGACY_DIR = "/tmp/codeterm-home/.codeterm/plugins/lmstudio/";
const DATA_DIR = "/tmp/codeterm-home/.codeterm/plugin-data/lmstudio/";

test("router_state_is_written_outside_the_install_dir", () => {
  reset(routerSettings());
  const out = plugin.onAgentCommand({ verb: "add-provider", args: ["mimo", "openai", "https://token-plan-sgp.xiaomimimo.com/v1"] });
  assert(!out.error, "add-provider ok: " + JSON.stringify(out));
  plugin.openSession({ tabId: "t-paths", config: {}, model: "mimo::mimo-v2.6-pro" });
  const written = Object.keys(fileStore);
  assert(written.includes(DATA_DIR + "router.json") && written.includes(DATA_DIR + "last-model.json"), "state in the data dir, got " + written);
  assert(!written.some((p) => p.indexOf(LEGACY_DIR) === 0), "nothing written into the install dir");
  plugin.closeSession("t-paths");
});

test("router_state_left_in_the_install_dir_migrates_on_first_read", () => {
  reset(routerSettings());
  fileStore[LEGACY_DIR + "router.json"] = JSON.stringify(mimoProviders());
  fileStore[LEGACY_DIR + "last-model.json"] = JSON.stringify({ lastModel: "mimo::mimo-v2.6-pro" });
  const listed = plugin.onAgentCommand({ verb: "providers", args: [] });
  assert(/mimo-anthropic/.test(listed.result), "legacy providers still listed");
  assert(JSON.parse(fileStore[DATA_DIR + "router.json"]).providers.length === 2, "copied into the data dir");
  plugin.openSession({ tabId: "t-mig", config: {} });
  assert(plugin.sessionInfo("t-mig").model === "mimo::mimo-v2.6-pro", "last model migrated too");
  plugin.closeSession("t-mig");
});

test("router_live_session_follows_registry_changes_without_a_new_tab", () => {
  reset(routerSettings());
  secretStore.mimo_api_key = MIMO_KEY;
  plugin.openSession({ tabId: "t-live", config: {}, model: "mimo::mimo-v2.6-pro" });
  plugin.sendMessage("t-live", "hi");
  let p = pumpUntilDone("t-live");
  assert(contents(p.messages, "system").some((m) => /unknown provider "mimo"/.test(m)), "missing provider reported");
  assert(streamCalls.length === 0, "no request without a route");
  assert(plugin.sessionInfo("t-live").model === "mimo::mimo-v2.6-pro", "session keeps reporting the requested model");
  seedRouter(mimoProviders());
  plugin.sendMessage("t-live", "list my tabs");
  assert(streamCalls.length === 1 && streamCalls[0].url === "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions", "re-added provider used by the open session");
  enqueueStream(0, oaiDone("ok"));
  p = pumpUntilDone("t-live");
  assert(contents(p.messages, "assistant").pop() === "ok", "the open session answers");
  seedRouter({ providers: [{ ...mimoProviders().providers[0], baseUrl: "https://other.example/v1" }] });
  plugin.sendMessage("t-live", "again");
  assert(streamCalls[1].url === "https://other.example/v1/chat/completions", "edited provider applies to the next request");
  plugin.closeSession("t-live");
});

test("router_session_revives_after_a_plugin_reload_without_a_new_tab", () => {
  openMimo("t-rev");
  plugin.sendMessage("t-rev", "hello");
  enqueueStream(0, oaiDone("first"));
  const before = pumpUntilDone("t-rev");
  const oldIds = new Set(before.messages.map((m) => m.id));
  const staleCursor = before.cursor;

  const reloaded = loadPlugin();
  reloaded.sendMessage("t-rev", "list my tabs");
  assert(streamCalls.length === 2 && /xiaomimimo\.com\/v1\/chat\/completions$/.test(streamCalls[1].url), "revived session routes to its saved provider");
  enqueueStream(1, oaiDone("second"));
  for (let i = 0; i < 5; i += 1) reloaded.pump("t-rev");
  const p = reloaded.poll("t-rev", staleCursor);
  assert(contents(p.messages, "assistant").includes("second"), "the answer reaches a host still holding the old cursor");
  assert(contents(p.messages, "user").includes("list my tabs"), "the revived send is delivered");
  assert(!p.messages.some((m) => oldIds.has(m.id) && m.id !== "system-prompt"), "revived rows never reuse stored ids");
  assert(reloaded.sessionInfo("t-rev").model === "mimo::mimo-v2.6-pro", "model survives the reload");
  reloaded.closeSession("t-rev");
  assert(!/t-rev/.test(fileStore[DATA_DIR + "sessions.json"] || ""), "closing forgets the saved route");
  plugin.closeSession("t-rev");
});

// ── Engine: OpenCode serve as the agent loop, against an in-process fake server ──

const ENGINE_DIR = DATA_DIR + "engine/";
const ROOT = "/work/scratch";
const SID_OC = "ses_fake1";

function fakeOpencode() {
  const fake = { requests: [], sessions: {}, nextSession: 1, password: null, healthy: true, version: "1.18.34" };
  fake.handle = (opts) => {
    const url = new URL(opts.url);
    const auth = (opts.headers || {}).authorization || "";
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    fake.requests.push({ method: opts.method, path: url.pathname, directory: url.searchParams.get("directory"), body, auth });
    const ok = (status, payload) => JSON.stringify({ status, body: payload === undefined ? "" : JSON.stringify(payload) });
    if (!/^Basic /.test(auth)) return ok(401, { error: "unauthorized" });
    if (url.pathname === "/global/health") return fake.healthy ? ok(200, { healthy: true, version: fake.version }) : JSON.stringify({ error: "connection refused" });
    if (opts.method === "POST" && url.pathname === "/session") {
      const id = fake.nextSession === 1 ? SID_OC : `ses_fake${fake.nextSession}`;
      fake.nextSession += 1;
      fake.sessions[id] = { permission: body.permission, directory: url.searchParams.get("directory") };
      return ok(200, { id, directory: url.searchParams.get("directory"), permission: body.permission });
    }
    const m = /^\/session\/([^/]+)(\/[a-z_]+)?$/.exec(url.pathname);
    if (m && opts.method === "PATCH" && !m[2]) {
      if (!fake.sessions[m[1]]) return ok(404, { name: "NotFoundError", data: { message: "Session not found" } });
      fake.sessions[m[1]].permission = body.permission;
      return ok(200, { id: m[1] });
    }
    if (m && m[2] === "/prompt_async") return ok(204);
    if (m && m[2] === "/abort") return ok(200, true);
    if (m && m[2] === "/message") return ok(200, []);
    if (url.pathname === "/session/status") return ok(200, {});
    if (/^\/permission\/[^/]+\/reply$/.test(url.pathname)) return ok(200, true);
    return ok(404, { name: "NotFoundError" });
  };
  fake.find = (method, re) => fake.requests.filter((r) => r.method === method && re.test(r.path));
  return fake;
}

function ocEvent(type, properties) {
  return `data: ${JSON.stringify({ id: "evt_" + type, type, properties: Object.assign({ sessionID: SID_OC }, properties) })}\n\n`;
}

function engineSettings(extra) {
  return routerSettings(Object.assign({ engine: "opencode", root: ROOT }, extra || {}));
}

function launchCall() {
  return execCalls.find((c) => c.detach);
}

// Drives the plugin until the fake engine is up: launch, the listening line in the launch log, then health.
function bootEngine(fake, sid) {
  fetchHandler = (opts) => fake.handle(opts);
  plugin.pump(sid);
  const launch = launchCall();
  assert(launch, "the engine is launched as a detached host job");
  fileStore[launch.logFile] = "router-engine: launching 1.18.34\nopencode server listening on http://127.0.0.1:4555\n";
  for (let i = 0; i < 5 && !streamCalls.length; i += 1) plugin.pump(sid);
  assert(streamCalls.length === 1 && /^http:\/\/127\.0\.0\.1:4555\/event\?directory=/.test(streamCalls[0].url), "event stream opened, got " + JSON.stringify(streamCalls.map((c) => c.url)));
}

function openEngineTab(sid, settings) {
  reset(settings || engineSettings());
  seedRouter(mimoProviders());
  secretStore.mimo_api_key = MIMO_KEY;
  existingPaths.add(ROOT);
  plugin.openSession({ tabId: sid, config: {}, model: "mimo::mimo-v2.6-pro", systemPrompt: "Be terse." });
}

const EDIT_TURN = [
  ocEvent("session.status", { status: { type: "busy" } }),
  ocEvent("message.updated", { info: { id: "msg_a1", role: "assistant", time: { created: 2 } } }),
  ocEvent("message.part.updated", { part: { id: "prt_r1", messageID: "msg_a1", type: "reasoning", text: "Add the function.", time: { start: 2 } }, time: 2 }),
  ocEvent("message.part.updated", { part: { id: "prt_e1", messageID: "msg_a1", type: "tool", tool: "edit", callID: "call_1", state: { status: "completed", input: { filePath: "math.ts", oldString: "export {}", newString: "export function add(a: number, b: number) {\n  return a + b;\n}" }, output: "Edit applied successfully.", title: "math.ts", metadata: {}, time: { start: 3, end: 4 } } }, time: 4 }),
  ocEvent("message.part.updated", { part: { id: "prt_t1", messageID: "msg_a1", type: "text", text: "Added" }, time: 5 }),
  ocEvent("message.part.delta", { messageID: "msg_a1", partID: "prt_t1", field: "text", delta: " add()." }),
  ocEvent("message.updated", { info: { id: "msg_a1", role: "assistant", time: { created: 2, completed: 6 }, tokens: { input: 1200, output: 40, reasoning: 0, cache: { read: 1000, write: 0 } } } }),
  ocEvent("session.status", { status: { type: "idle" } }),
  ocEvent("session.idle", {}),
].join("");

test("engine_turn_runs_through_opencode_and_renders_edit_diff_rows", () => {
  openEngineTab("e-edit");
  const fake = fakeOpencode();
  plugin.sendMessage("e-edit", "add an add() function to math.ts");
  bootEngine(fake, "e-edit");
  const launch = launchCall();
  assert(launch.bin === "sh" && !JSON.stringify(launch.args).includes(MIMO_KEY), "the key is not in argv");
  assert(launch.env.ROUTER_KEY_MIMO === MIMO_KEY, "the key reaches the engine through its env");
  const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
  assert(config.provider["router-mimo"].options.apiKey === "{env:ROUTER_KEY_MIMO}" && !launch.env.OPENCODE_CONFIG_CONTENT.includes(MIMO_KEY), "config names the key variable only");
  assert(config.provider["router-mimo"].models["mimo-v2.6-pro"], "the session's model is declared");
  assert(/^.+\/engine\/xdg\/data$/.test(launch.env.XDG_DATA_HOME), "engine state lives in the plugin data dir");
  const created = fake.find("POST", /^\/session$/)[0];
  assert(created && created.directory === ROOT, "session rooted at the tab root");
  assert(created.body.permission.some((r) => r.permission === "external_directory" && r.action === "deny"), "confined to root");
  assert(!created.body.permission.some((r) => r.permission === "bash"), "shell on by default");
  assert(fake.find("POST", /prompt_async$/).length === 0, "no prompt before the stream is connected");
  enqueueStream(0, [{ chunks: [ocEvent("server.connected", {})], done: false, status: 200 }]);
  plugin.pump("e-edit");
  const prompt = fake.find("POST", /prompt_async$/)[0];
  assert(prompt && prompt.path === `/session/${SID_OC}/prompt_async`, "prompt posted to the tab's session");
  assertJsonEqual(prompt.body.model, { providerID: "router-mimo", modelID: "mimo-v2.6-pro" }, "per-message model");
  assertJsonEqual(prompt.body.parts, [{ type: "text", text: "add an add() function to math.ts" }], "the user's text");
  assert(/Domios Router coding agent/.test(prompt.body.system) && /Be terse\.$/.test(prompt.body.system), "Domios context plus the preset prompt");
  assert(!plugin.poll("e-edit", null).done, "turn in flight");
  enqueueStream(0, [{ chunks: [EDIT_TURN], done: false, status: 200 }]);
  const p = pumpUntilDone("e-edit");
  const edit = p.messages.find((m) => m.type === "tool_call");
  assert(edit && edit.toolKind === "edit" && edit.toolName === "edit", "edit tool row, got " + JSON.stringify(edit));
  assertJsonEqual(edit.toolEdits, [{ path: "math.ts", old: "export {}", new: "export function add(a: number, b: number) {\n  return a + b;\n}" }], "diff pair for the UI");
  assert(edit.toolInput.filePath === "math.ts" && edit.toolInput.oldString === "export {}", "OpenCode input shape kept");
  assert(contents(p.messages, "thinking").includes("Add the function."), "reasoning row");
  assert(contents(p.messages, "assistant").pop() === "Added add().", "assistant text grows with deltas");
  assert(contents(p.messages, "system").some((m) => m === "mimo::mimo-v2.6-pro · 1,200 in · 1,000 cached · 200 fresh · 40 out"), "usage line");
  assert(contents(p.messages, "user").filter((m) => /add an add/.test(m)).length === 1, "user bubble not duplicated");
  assert(streamJobs[0].closed, "event stream closed once idle");
  assert(!allText().includes(MIMO_KEY), "key never in files, settings or logs");
  plugin.closeSession("e-edit");
});

test("engine_stop_aborts_the_opencode_turn", () => {
  openEngineTab("e-stop");
  const fake = fakeOpencode();
  plugin.sendMessage("e-stop", "long task");
  bootEngine(fake, "e-stop");
  enqueueStream(0, [{ chunks: [ocEvent("server.connected", {}), ocEvent("session.status", { status: { type: "busy" } })], done: false, status: 200 }]);
  plugin.pump("e-stop");
  plugin.pump("e-stop");
  assert(plugin.poll("e-stop", null).activity.state !== "idle", "busy while the turn runs");
  plugin.cancel("e-stop");
  const abort = fake.find("POST", /\/abort$/);
  assert(abort.length === 1 && abort[0].path === `/session/${SID_OC}/abort` && abort[0].directory === ROOT, "abort route called");
  const p = plugin.poll("e-stop", null);
  assert(p.done && contents(p.messages, "system").includes("Stopped."), "turn ends with Stopped.");
  assert(streamJobs[0].closed, "stream closed");
  plugin.closeSession("e-stop");
});

test("engine_restart_reattaches_the_same_opencode_session_and_reuses_the_running_engine", () => {
  openEngineTab("e-rev");
  const fake = fakeOpencode();
  plugin.sendMessage("e-rev", "first");
  bootEngine(fake, "e-rev");
  enqueueStream(0, [{ chunks: [ocEvent("server.connected", {}), EDIT_TURN], done: false, status: 200 }]);
  pumpUntilDone("e-rev");
  assert(/ses_fake1/.test(fileStore[DATA_DIR + "sessions.json"]), "the tab's OpenCode session is stored");
  assert(JSON.parse(fileStore[ENGINE_DIR + "engine.json"]).port === 4555, "engine record stored");

  const reloaded = loadPlugin();
  reloaded.__test_resetRouter();
  reloaded.openSession({ tabId: "e-rev", config: {}, model: "mimo::mimo-v2.6-pro", systemPrompt: "Be terse." });
  reloaded.sendMessage("e-rev", "second");
  for (let i = 0; i < 3 && streamCalls.length < 2; i += 1) reloaded.pump("e-rev");
  assert(execCalls.filter((c) => c.detach).length === 1, "the running engine is adopted, not relaunched");
  assert(fake.find("POST", /^\/session$/).length === 1, "no second session created");
  const patch = fake.find("PATCH", /^\/session\/ses_fake1$/);
  assert(patch.length === 1 && patch[0].body.permission.some((r) => r.permission === "external_directory"), "re-attached with this tab's rules");
  enqueueStream(1, [{ chunks: [ocEvent("server.connected", {})], done: false, status: 200 }]);
  reloaded.pump("e-rev");
  const prompts = fake.find("POST", /prompt_async$/);
  assert(prompts.length === 2 && prompts[1].path === `/session/${SID_OC}/prompt_async`, "second turn continues the same conversation");
  reloaded.closeSession("e-rev");
});

test("engine_shell_off_denies_bash_and_says_so", () => {
  openEngineTab("e-noshell", engineSettings({ shell: "off" }));
  const fake = fakeOpencode();
  plugin.sendMessage("e-noshell", "hi");
  bootEngine(fake, "e-noshell");
  const created = fake.find("POST", /^\/session$/)[0];
  assertJsonEqual(created.body.permission.filter((r) => r.permission === "bash"), [{ permission: "bash", pattern: "*", action: "deny" }], "bash denied for the session");
  enqueueStream(0, [{ chunks: [ocEvent("server.connected", {})], done: false, status: 200 }]);
  plugin.pump("e-noshell");
  const prompt = fake.find("POST", /prompt_async$/)[0];
  assert(/Shell commands are disabled/.test(prompt.body.system) && !/bash tool/.test(prompt.body.system), "context matches the confinement");
  plugin.closeSession("e-noshell");
});

test("engine_defaults_root_to_the_tab_cwd_and_refuses_a_missing_root", () => {
  openEngineTab("e-cwd", engineSettings({ root: "" }));
  tabCwdForTests = "/work/from-tab";
  existingPaths.add("/work/from-tab");
  const fake = fakeOpencode();
  plugin.sendMessage("e-cwd", "hi");
  bootEngine(fake, "e-cwd");
  assert(fake.find("POST", /^\/session$/)[0].directory === "/work/from-tab", "root is the tab's cwd");
  plugin.closeSession("e-cwd");

  openEngineTab("e-noroot", engineSettings({ root: "/does/not/exist" }));
  fetchHandler = (opts) => fakeOpencode().handle(opts);
  plugin.sendMessage("e-noroot", "hi");
  const p = pumpUntilDone("e-noroot");
  assert(contents(p.messages, "system").some((m) => /root \/does\/not\/exist does not exist/.test(m)), "typed refusal");
  assert(!launchCall(), "no engine launched for a refused root");
  plugin.closeSession("e-noroot");
  tabCwdForTests = "";
});

test("engine_rejects_approval_requests_instead_of_hanging", () => {
  openEngineTab("e-perm");
  const fake = fakeOpencode();
  plugin.sendMessage("e-perm", "read the env file");
  bootEngine(fake, "e-perm");
  enqueueStream(0, [{ chunks: [ocEvent("server.connected", {}), ocEvent("session.status", { status: { type: "busy" } }), ocEvent("permission.asked", { id: "per_1", permission: "read", patterns: [".env"], metadata: {}, always: [] })], done: false, status: 200 }]);
  plugin.pump("e-perm");
  plugin.pump("e-perm");
  const reply = fake.find("POST", /^\/permission\/per_1\/reply$/);
  assert(reply.length === 1 && reply[0].body.reply === "reject", "auto-rejected");
  plugin.closeSession("e-perm");
});

test("engine_missing_opencode_reports_the_install_command", () => {
  openEngineTab("e-missing");
  fetchHandler = (opts) => fakeOpencode().handle(opts);
  plugin.sendMessage("e-missing", "hi");
  plugin.pump("e-missing");
  fileStore[launchCall().logFile] = "router-engine: opencode not found on PATH\n";
  const p = pumpUntilDone("e-missing");
  assert(contents(p.messages, "system").some((m) => /npm i -g opencode-ai@1\.18\.34/.test(m)), "install hint, got " + JSON.stringify(contents(p.messages, "system")));
  plugin.closeSession("e-missing");
});

for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (err) { failed += 1; console.error(`✗ ${name}`); console.error(err); }
}
console.log(`lmstudio plugin: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
