// Plugin-side tests for the LM Studio open agent shell.
// Run: node lmstudio/plugin.test.cjs

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const fetchCalls = [];
const streamCalls = [];
const streamJobs = [];
const execCalls = [];
const execJobs = [];
const toolParseCalls = [];
let pendingExecPolls = null;
let settingsObj = {};
let fetchHandler = () => JSON.stringify({ error: "no fetch handler set" });

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
  if (!candidates.length) return "null";
  candidates.sort((a, b) => b.confidence - a.confidence);
  return JSON.stringify(candidates[0]);
}

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
  readFile: (path) => `file:${path}`,
  writeFile: () => true,
  mem: (optsJson) => JSON.stringify({ results: [{ title: "memory", body: optsJson }] }),
  agent: {
    spawn: (optsJson) => JSON.stringify({ sessionId: "agent-1", opts: JSON.parse(optsJson) }),
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

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function reset(settings) {
  fetchCalls.length = 0;
  streamCalls.length = 0;
  streamJobs.length = 0;
  execCalls.length = 0;
  execJobs.length = 0;
  toolParseCalls.length = 0;
  pendingExecPolls = null;
  settingsObj = settings || {};
  fetchHandler = () => JSON.stringify({ error: "no fetch handler set" });
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

function openAndStartBody(ctx) {
  plugin.openSession(ctx);
  plugin.sendMessage(ctx.paneId, "hello");
  assert(streamCalls.length === 1, "stream started for " + ctx.paneId);
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
    paneId: "pane-system",
    config: {},
    systemPrompt: "You answer only in rhymes.",
    model: "ctx-model",
  });
  assert(r.sessionId === "pane-system", "sessionId echoes paneId");

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

test("sendMessage sends stream:true and streams a growing assistant message with one stable id", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  plugin.openSession({ paneId: "stream", config: {}, systemPrompt: "sys" });
  plugin.sendMessage("stream", "hello");

  assert(streamCalls.length === 1, "stream started");
  const body = JSON.parse(streamCalls[0].body);
  assert(streamCalls[0].url === "http://localhost:1234/api/v1/chat", "native v1 url");
  assert(body.model === "llama", "model from settings");
  assert(body.system_prompt === "sys", "system prompt sent");
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
  plugin.openSession({ paneId: "reason", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "upsert", config: {}, systemPrompt: "sys" });
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

  plugin.openSession({ paneId: "empty-model", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "react", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "async-exec", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "cap", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "cap-clear", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "fallback-context", config: {}, systemPrompt: "sys" });
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

test("host parser receives the full assistant text and executes the validated call it returns", () => {
  reset({ baseUrl: "http://localhost:1234", model: "llama", presets: [] });
  // An earlier illustrative fence, separated from a later real fence by prose:
  // only the trailing fence is a tool call; the prose-separated one is not.
  plugin.openSession({ paneId: "two-fences", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "native", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "ns-native", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "ns-unknown", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "fence-prose", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "example", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "fence-only", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "strip", config: {}, systemPrompt: "sys" });
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
  plugin.openSession({ paneId: "bad-json", config: {}, systemPrompt: "sys" });
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

  // Native shape: { models: [{ key, ... }] }.
  fetchHandler = (opts) => {
    assert(opts.method === "GET", "GET");
    assert(opts.url === "http://localhost:1234/api/v1/models", "native models url, got " + opts.url);
    return JSON.stringify({
      status: 200,
      body: JSON.stringify({ models: [{ key: "llama-3" }, { key: "qwen2.5" }, { bogus: true }] }),
    });
  };
  const models = plugin.listModels();
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

  plugin.openSession({ paneId: "bound-model", config: {} });
  let p = plugin.poll("bound-model", null);
  assert(p.messages[0].content.includes("simple prompt"), "seed uses bound preset prompt");

  plugin.sendMessage("bound-model", "hello");
  const body = JSON.parse(streamCalls[0].body);
  assert(body.model === "tiny-model", "uses chosen model");
  assert(body.system_prompt === "simple prompt", "uses bound preset prompt");
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

  const body = openAndStartBody({ paneId: "unbound-model", config: {} });
  assert(body.model === "unbound-model", "keeps unbound chosen model");
  assert(body.system_prompt === "default prompt", "falls back to default preset prompt");
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

  const body = openAndStartBody({ paneId: "explicit-preset", config: {}, model: "unbound-model", preset: "creative" });
  assert(body.model === "unbound-model", "keeps explicit unbound model");
  assert(body.system_prompt === "creative prompt", "uses explicit preset prompt");
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

  const body = openAndStartBody({ paneId: "bound-without-prompt", config: {} });
  assert(body.system_prompt === "default prompt", "missing bound prompt falls back to default");
  assert(body.temperature === 0.2, "bound preset params still apply");
});

test("sessionInfo reports the session model and setModel switches it for the next turn", () => {
  reset({ baseUrl: "http://localhost:1234", presets: [] });
  plugin.openSession({ paneId: "switch", config: {}, systemPrompt: "sys", model: "llama-3" });

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

test("settings schema and config expose presets/defaultPreset", () => {
  const schema = JSON.parse(readFileSync(join(__dirname, "settings.schema.json"), "utf8"));
  const schemaText = JSON.stringify(schema);
  assert(schemaText.includes("baseUrl"), "schema exposes baseUrl");
  assert(schemaText.includes("defaultPreset"), "schema exposes defaultPreset");
  assert(schemaText.includes("presets"), "schema exposes presets");

  const config = readFileSync(join(__dirname, "config.yaml"), "utf8");
  assert(/defaultPreset:\s*codeterm/.test(config), "config has defaultPreset");
  assert(/systemPrompt:\s*\|/.test(config), "config seeds block systemPrompt");

  const prompt = readFileSync(join(__dirname, "prompts", "codeterm-default.md"), "utf8");
  const replyExample = '{"tool":"codeterm","args":{"args":"send \\"Hi, I got your message.\\" --pane 36b00886"}}';
  assert(prompt.includes("Replying to messages from other panes"), "prompt documents inbound pane replies");
  assert(prompt.includes("from_mesh=<peer>"), "prompt documents mesh reply routing");
  assert(prompt.includes(replyExample), "prompt includes single-string codeterm reply example");
  assert(config.includes(replyExample), "seed config includes single-string codeterm reply example");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (err) { failed += 1; console.error(`✗ ${name}`); console.error(err); }
}
console.log(`lmstudio plugin: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
