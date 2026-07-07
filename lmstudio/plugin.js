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

// lmstudio/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  default: () => plugin_default,
  describeModelSwitch: () => describeModelSwitch
});
module.exports = __toCommonJS(plugin_exports);

// ../codeterm-canvas/packages/chat-engine/src/index.ts
var VERDICT_CONTRACT = [
  "Respond ONLY with a JSON object of this exact shape (no markdown fences, no surrounding prose):",
  "{",
  '  "status": "ok" | "attention" | "stalled",',
  '  "summary": "<one-line assessment>",',
  '  "state": <updated state object>,',
  '  "actions": [{ "kind": "nudge" | "notify" | "report", "pane": "<optional pane id>", "message": "<text>" }]',
  "}"
].join("\n");
function assembleChat(history, window) {
  const maxMessages = window?.maxMessages;
  if (maxMessages === void 0) {
    return history;
  }
  const leadingSystem = history[0]?.role === "system" ? history[0] : void 0;
  const nonSystem = history.filter((m) => m.role !== "system");
  const tail = nonSystem.slice(-maxMessages);
  return leadingSystem ? [leadingSystem, ...tail] : tail;
}
function assembleMachine(charter, state, input) {
  return [
    {
      role: "system",
      content: `${charter}

${VERDICT_CONTRACT}`
    },
    {
      role: "user",
      content: JSON.stringify({ state, input })
    }
  ];
}

// lmstudio/prompts/watcher-orchestration.md
var watcher_orchestration_default = '# Orchestration health watcher\n\nYou observe a **read-only snapshot** of an orchestration group (orchestrator + its managers and workers). Decide whether work is **progressing** or **stalled**. When stalled, you may request a **nudge** to the stuck pane.\n\nYou may investigate with tools when observations are insufficient, then you must finish with **ONLY the verdict JSON** as the final assistant message (no markdown fences, no prose before or after, and no tool block in the final message).\n\n## Tools\n\nWhen the snapshot is ambiguous or missing key evidence, use at most the tools needed to clarify it. Available curated tools:\n\n- `exec`: run a shell command.\n- `read_file`: read a file.\n- `write_file`: write a file.\n- `codeterm`: run a CodeTerm command, such as `codeterm plan get` or `codeterm pane status --pane <id>`.\n- `mem_search`: search memory.\n- `spawn_agent`: start an agent only if explicitly needed for investigation.\n\nTool calls use fenced `codeterm-tool` JSON blocks. After each tool result, continue reasoning internally and either call another needed tool or finish with the verdict JSON. Use tools for facts you cannot infer reliably from `observations`, for example checking a pane\'s status or the current plan. Do not include a tool block in the final verdict message.\n\n## Input you receive each tick\n\nThe user message is JSON: `{ "state": <your prior state>, "input": { "tick", "nowMs", "state", "observations" } }`.\n\n`observations` is the host-assembled snapshot. Typical shape:\n\n```json\n{\n  "orchestrator_id": "abc123",\n  "panes": [\n    {\n      "pane_id": "abc123",\n      "title": "Orchestrator",\n      "role": "Orchestrator",\n      "status": "Working",\n      "last_activity_ms": 1700000000000\n    },\n    {\n      "pane_id": "def456",\n      "title": "Worker Alpha",\n      "role": "Worker",\n      "role_profile": null,\n      "status": "Working",\n      "last_activity_ms": 1700000005000,\n      "chatTail": [\n        { "id": "m1", "kind": "user", "content": "finish the task" },\n        { "id": "m2", "kind": "assistant", "content": "working on it\u2026" }\n      ]\n    }\n  ],\n  "reports": [\n    {\n      "id": "r1",\n      "from_pane_id": "def456",\n      "from_title": "Worker Alpha",\n      "message": "Completed step 1",\n      "timestamp": 1700000006000,\n      "status": "Done"\n    }\n  ]\n}\n```\n\nFields you care about on each pane:\n\n| Field | Meaning |\n|---|---|\n| `pane_id` | Target for nudge actions |\n| `title` | Human label |\n| `role` | `Orchestrator`, `Manager`, or `Worker` (may be absent) |\n| `role_profile` | Manager specialization (`planner`, `watcher`, \u2026) or null |\n| `status` | `Working`, `Waiting`, `Idle`, `Dead`, or `Unknown` |\n| `last_activity_ms` | Host clock when the pane last did something meaningful |\n| `chatTail` | Optional: last N parsed chat messages as `{id, kind, content}` objects |\n\nTop-level `orchestrator_id` identifies the orchestrator; the orchestrator also appears as a row in `panes[]`. `reports` is optional (when observation config enables it).\n\n## Progressing vs stalled\n\n**Progressing (`status: "ok"`)** \u2014 recent activity and forward motion:\n\n- `last_activity_ms` on key panes is within ~3 minutes of `nowMs`, **or**\n- worker/manager `status` values are advancing (e.g. `Waiting` \u2192 `Working`, `Working` with fresh `chatTail`), **or**\n- new agent reports arrive at the orchestrator with concrete progress.\n\n**Attention (`status: "attention"`)** \u2014 ambiguous or early warning:\n\n- activity is slowing but not clearly stuck yet, **or**\n- you lack enough data to judge (empty snapshot, missing tails).\n\n**Stalled (`status: "stalled"`)** \u2014 the group needs a kick:\n\n- no meaningful activity on workers for ~5+ minutes while tasks should be active, **or**\n- a worker sits on the same status with no `chatTail` movement, **or**\n- the orchestrator is `Idle` while workers are `Waiting`/`Idle` with no progress, **or**\n- unread reports pile up at the orchestrator with no follow-up.\n\nWhen stalled, emit **at most one nudge** to the most stuck pane. Nudges must be:\n\n- **Short** (1\u20132 sentences)\n- **Evidence-based** (cite what you saw: idle time, status, last `chatTail` line)\n- **Addressed to that pane** (use its `pane_id` in the action)\n\nDo not nudge watchers or the orchestrator unless the orchestrator itself is clearly idle with pending work.\n\n## State\n\nUse `state` to remember lightweight notes across ticks (e.g. `{ "last_nudged": { "def456": 1700000000000 } }`). Keep it small.\n\n## Worked example 1 \u2014 progressing (ok)\n\nObservation (abbreviated):\n\n```json\n{\n  "tick": 2,\n  "nowMs": 1700000120000,\n  "observations": {\n    "orchestrator_id": "o1",\n    "panes": [\n      { "pane_id": "o1", "title": "Orch", "role": "Orchestrator", "status": "Working", "last_activity_ms": 1700000110000 },\n      { "pane_id": "w1", "title": "Worker", "role": "Worker", "role_profile": null, "status": "Working", "last_activity_ms": 1700000118000 }\n    ],\n    "reports": [\n      { "id": "r1", "from_pane_id": "w1", "from_title": "Worker", "message": "Implemented tests", "timestamp": 1700000119000, "status": "Partial" }\n    ]\n  }\n}\n```\n\nYour verdict:\n\n```json\n{"status":"ok","summary":"Worker active in last minute with a progress report.","state":{"seen_ticks":2},"actions":[]}\n```\n\n## Worked example 2 \u2014 stalled worker (one nudge)\n\nObservation (abbreviated):\n\n```json\n{\n  "tick": 5,\n  "nowMs": 1700000420000,\n  "observations": {\n    "orchestrator_id": "o1",\n    "panes": [\n      { "pane_id": "o1", "title": "Orch", "role": "Orchestrator", "status": "Idle", "last_activity_ms": 1700000200000 },\n      {\n        "pane_id": "w1",\n        "title": "Worker",\n        "role": "Worker",\n        "role_profile": null,\n        "status": "Waiting",\n        "last_activity_ms": 1700000000000,\n        "chatTail": [\n          { "id": "m1", "kind": "user", "content": "run the tests" },\n          { "id": "m2", "kind": "assistant", "content": "I\'ll get to it\u2026" }\n        ]\n      }\n    ]\n  }\n}\n```\n\nWorker `w1` has been silent ~7 minutes (`nowMs - last_activity_ms` = 420000 ms) with `status: Waiting` and no new `chatTail`.\n\nYour verdict:\n\n```json\n{"status":"stalled","summary":"Worker w1 Waiting with no activity for 7+ minutes.","state":{"seen_ticks":5,"last_nudged":{"w1":1700000420000}},"actions":[{"kind":"nudge","pane":"w1","message":"Stalled ~7m on \'run the tests\' \u2014 status Waiting, no new chat since \'I\'ll get to it\u2026\'. Please run tests and report STATUS."}]}\n```\n\n## Worked example 3 \u2014 investigate with a codeterm tool, then verdict\n\nObservation (abbreviated):\n\n```json\n{\n  "tick": 8,\n  "nowMs": 1700000600000,\n  "observations": {\n    "orchestrator_id": "o1",\n    "panes": [\n      { "pane_id": "o1", "title": "Orch", "role": "Orchestrator", "status": "Working", "last_activity_ms": 1700000580000 },\n      { "pane_id": "w1", "title": "Worker", "role": "Worker", "status": "Unknown", "last_activity_ms": 1700000200000 }\n    ]\n  }\n}\n```\n\nThe worker looks stale, but `status: Unknown` and missing `chatTail` are insufficient evidence. First check the pane:\n\n```codeterm-tool\n{"tool":"codeterm","args":{"args":"pane status --pane w1"}}\n```\n\nTool result (abbreviated): `{"status":"Working","last_activity_ms":1700000590000,"prompt":"running focused tests"}`\n\nYour final message:\n\n```json\n{"status":"ok","summary":"Worker w1 is active after status check and is running focused tests.","state":{"seen_ticks":8},"actions":[]}\n```\n';

// lmstudio/src/plugin.ts
var CHARTER_REF_PREFIX = "charter:";
var SHIPPED_CHARTERS = {
  "watcher-orchestration": watcher_orchestration_default.replace(/\s+$/, "")
};
function resolveCharterRef(ref) {
  if (!ref.startsWith(CHARTER_REF_PREFIX)) return { charter: ref };
  const id = ref.slice(CHARTER_REF_PREFIX.length).trim();
  if (!id) return { charter: "", error: "charter reference is missing an id" };
  const shipped = SHIPPED_CHARTERS[id];
  if (shipped) return { charter: shipped };
  const settings = readSettings();
  const raw = settings.charters;
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw[id] : void 0;
  if (typeof body === "string" && body.trim() && !body.trim().endsWith(".md")) {
    return { charter: body.trim() };
  }
  return { charter: "", error: `unknown charter id: ${id}` };
}
var DEFAULT_BASE_URL = "http://localhost:1234";
var LAST_MODEL_PATH = ".codeterm/plugins/lmstudio/last-model.json";
var AUTHORED_PROMPTS_PATH = ".codeterm/plugins/lmstudio/authored-prompts.json";
var PROMPT_AUTHOR_WORKSPACE = "lmstudio-prompt-authoring";
var MAX_TOOL_ROUNDS = 8;
var MAX_MALFORMED_RETRIES = 2;
var TOOL_SCHEMA_JSON = JSON.stringify({
  tools: [
    { name: "exec", args: ["cmd"], optional: ["cwd"] },
    { name: "read_file", args: ["path"], optional: [] },
    { name: "write_file", args: ["path", "content"], optional: [] },
    { name: "codeterm", args: ["args"], optional: [] },
    { name: "mem_search", args: ["query"], optional: [] },
    { name: "spawn_agent", args: ["provider", "task"], optional: ["workspace"] }
  ],
  aliases: { command: "cmd", file: "path", filepath: "path" }
});
var FENCE_RE = /```[^\r\n`]*\r?\n[\s\S]*?```/g;
var TOOL_WRAPPER_RE = /<\s*\|?\/?\s*(?:tool_call|tool▁call)\s*\|?\s*>/gi;
var SYSTEM_PROMPT_MARKER = "-=-codeterm:system_prompt-=-";
function markSystemPrompt(body) {
  return SYSTEM_PROMPT_MARKER + body;
}
var sessions = /* @__PURE__ */ new Map();
function readSettings() {
  try {
    const raw = JSON.parse(host.settingsJson() || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
function cleanModel(model) {
  return typeof model === "string" ? model.trim() : "";
}
function lastModelFilePath() {
  try {
    const home = typeof host.homeDir === "function" ? host.homeDir() : null;
    if (!home) return null;
    return `${home.replace(/\/+$/, "")}/${LAST_MODEL_PATH}`;
  } catch {
    return null;
  }
}
function readLastModel() {
  try {
    const path = lastModelFilePath();
    if (!path) return "";
    const raw = host.readFile(path);
    if (!raw) return "";
    const state = JSON.parse(raw);
    return cleanModel(state && state.lastModel);
  } catch {
    return "";
  }
}
function rememberLastModel(model) {
  const lastModel = cleanModel(model);
  if (!lastModel) return;
  try {
    const path = lastModelFilePath();
    if (!path) return;
    const slash = path.lastIndexOf("/");
    if (slash > 0 && typeof host.makeDirs === "function") host.makeDirs(path.slice(0, slash));
    host.writeFile(path, JSON.stringify({ lastModel }));
  } catch {
  }
}
function authoredPromptsFilePath() {
  try {
    const home = typeof host.homeDir === "function" ? host.homeDir() : null;
    if (!home) return null;
    return `${home.replace(/\/+$/, "")}/${AUTHORED_PROMPTS_PATH}`;
  } catch {
    return null;
  }
}
function readAuthoredPrompts() {
  try {
    const path = authoredPromptsFilePath();
    if (!path) return {};
    const raw = host.readFile(path);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}
function writeAuthoredPrompt(model, draft) {
  try {
    const path = authoredPromptsFilePath();
    if (!path) return;
    const current = readAuthoredPrompts();
    current[model] = draft;
    const slash = path.lastIndexOf("/");
    if (slash > 0 && typeof host.makeDirs === "function") host.makeDirs(path.slice(0, slash));
    host.writeFile(path, JSON.stringify(current));
  } catch {
  }
}
function applyAuthoredPrompt(s, model, draft) {
  if (!model) return;
  writeAuthoredPrompt(model, draft);
  s.systemPrompt = draft;
}
function buildAuthoringRequest(model, currentPrompt, instruction) {
  const ask = instruction && instruction.trim() ? `

User's tuning request: ${instruction.trim()}` : "";
  return `You are tuning the system prompt for a local LM Studio chat model "${model}". Rewrite and improve the prompt below so it works well for that model \u2014 small local models learn best from short, concrete, example-led prompts. Preserve its intent and any tool-use rules. Reply with ONLY the new system prompt text: no preamble, no commentary, no code fences.` + ask + `

--- CURRENT SYSTEM PROMPT ---
${currentPrompt}`;
}
function stripPromptFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n?```$/);
  return (fenced ? fenced[1] : trimmed).trim();
}
function describeSwitchMessage(targetModel) {
  return `Switching to ${targetModel} will unload the current one (VRAM). Continue?`;
}
function describeModelSwitch(sessionId, targetModel) {
  const target = cleanModel(targetModel);
  if (!target) return { needsConfirm: false, message: "" };
  const s = sessions.get(sessionId);
  const active = cleanModel(s && s.model);
  if (!s || active === target) return { needsConfirm: false, message: "" };
  return { needsConfirm: true, message: describeSwitchMessage(target) };
}
function baseUrl() {
  const s = readSettings();
  const url = s.baseUrl && s.baseUrl.trim() ? s.baseUrl.trim() : DEFAULT_BASE_URL;
  return url.replace(/\/+$/, "");
}
function presets() {
  const s = readSettings();
  if (!Array.isArray(s.presets)) return [];
  return s.presets.filter(
    (p) => !!p && typeof p.id === "string" && typeof p.name === "string" && (p.systemPrompt === void 0 || typeof p.systemPrompt === "string")
  );
}
function presetById(all, id) {
  if (!id) return null;
  return all.find((p) => p.id === id) || null;
}
function defaultPreset(all) {
  if (!all.length) return null;
  const s = readSettings();
  return presetById(all, s.defaultPreset) || all[0];
}
function presetBoundToModel(all, modelId) {
  if (!modelId) return null;
  return all.find((p) => typeof p.model === "string" && p.model.trim() === modelId) || null;
}
function resolvePreset(id, modelId) {
  const all = presets();
  if (!all.length) return null;
  return presetBoundToModel(all, modelId || "") || presetById(all, id) || defaultPreset(all);
}
function defaultSystemPrompt(all) {
  const p = defaultPreset(all);
  return p && typeof p.systemPrompt === "string" ? p.systemPrompt : "";
}
function nextId(s, prefix = "lmstudio") {
  const id = `${prefix}-${s.seq}`;
  s.seq += 1;
  return id;
}
function append(s, type, content, id, extras) {
  const msgId = id || nextId(s);
  const existing = s.messages.find((m) => m.id === msgId);
  if (existing) {
    existing.content = content;
    if (extras) Object.assign(existing, extras);
    return existing;
  }
  const msg = { id: msgId, type, content, ...extras || {} };
  s.messages.push(msg);
  return msg;
}
function parseJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function fetchJson(opts) {
  const raw = host.fetch(
    JSON.stringify({
      url: opts.url,
      method: opts.method,
      headers: { "content-type": "application/json" },
      body: opts.body,
      timeoutMs: 12e4
    })
  );
  return parseJson(raw, { error: "fetch returned non-JSON" });
}
function resolveModelId() {
  const res = fetchJson({ url: `${baseUrl()}/api/v1/models`, method: "GET" });
  if (res.error || res.status && res.status >= 400) return "";
  const data = parseJson(res.body || "{}", {});
  const rows = Array.isArray(data.models) ? data.models : [];
  const loaded = rows.find(
    (r) => r && typeof r.key === "string" && Array.isArray(r.loaded_instances) && r.loaded_instances.length > 0
  );
  if (loaded && typeof loaded.key === "string") return loaded.key;
  const first = rows.find((r) => r && typeof r.key === "string");
  return first && typeof first.key === "string" ? first.key : "";
}
function startFetchStream(opts) {
  return parseJson(
    host.fetchStream(
      JSON.stringify({
        url: opts.url,
        method: opts.method,
        headers: { "content-type": "application/json" },
        body: opts.body,
        timeoutMs: 12e4
      })
    ),
    { error: "fetchStream returned non-JSON" }
  );
}
function errorTextFromBody(raw) {
  if (!raw) return "";
  const parsed = parseJson(raw, null);
  if (parsed && typeof parsed === "object") {
    const obj = parsed;
    const error = obj.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const nested = error;
      if (typeof nested.message === "string") return nested.message;
      if (typeof nested.error === "string") return nested.error;
    }
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.detail === "string") return obj.detail;
  }
  return raw;
}
function isVramLoadFailure(text) {
  return /(vram|insufficient|not enough|out of memory|failed to load|could not load|couldn't load)/i.test(text);
}
function vramLoadFailureMessage(model) {
  return `couldn't load ${model}: not enough VRAM \u2014 unload a model in LM Studio or pick a smaller one`;
}
function pollFetchStream(jobId) {
  return parseJson(host.fetchStreamPoll(jobId), {
    chunks: [],
    done: true,
    error: "fetchStreamPoll returned non-JSON"
  });
}
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
function execShellCmd(call) {
  if (call.tool === "exec") {
    const cmd = typeof call.args.cmd === "string" ? call.args.cmd : "";
    const cwd = typeof call.args.cwd === "string" ? call.args.cwd : void 0;
    if (!cmd) return { error: "exec requires args.cmd" };
    return { shellCmd: cwd && cwd.trim() ? `cd ${shellQuote(cwd)} && ${cmd}` : cmd };
  }
  const args = typeof call.args.args === "string" ? call.args.args : "";
  if (!args) return { error: "codeterm requires args.args" };
  return { shellCmd: `codeterm ${args}` };
}
function startExecJob(shellCmd) {
  return parseJson(
    host.execStart(JSON.stringify({ bin: "sh", args: ["-lc", shellCmd], timeoutMs: 12e4 })),
    { error: "host.exec.start returned non-JSON" }
  );
}
function pollExecJob(jobId) {
  return parseJson(host.execPoll(jobId), { done: true, error: "host.exec.poll returned non-JSON" });
}
function execResultFromPoll(poll) {
  const result = {};
  if (typeof poll.code === "number") result.code = poll.code;
  if (typeof poll.stdout === "string") result.stdout = poll.stdout;
  if (typeof poll.stderr === "string") result.stderr = poll.stderr;
  if (typeof poll.error === "string") result.error = poll.error;
  return result;
}
function formatToolResult(call, result) {
  return JSON.stringify({ tool: call.tool, args: call.args, result }, null, 2);
}
function stripSpans(text, spans) {
  if (!spans.length) return text;
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const s of ordered) {
    if (s.start < cursor) continue;
    out += text.slice(cursor, s.start);
    cursor = s.end;
  }
  out += text.slice(cursor);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
function expandToolSpan(text, span) {
  FENCE_RE.lastIndex = 0;
  let match;
  while ((match = FENCE_RE.exec(text)) !== null) {
    const start2 = match.index;
    const end2 = match.index + match[0].length;
    if (span.start >= start2 && span.end <= end2) return { start: start2, end: end2 };
  }
  let start = span.start;
  let end = span.end;
  const before = text.slice(0, start);
  TOOL_WRAPPER_RE.lastIndex = 0;
  let wrapper;
  let lastBefore = null;
  while ((wrapper = TOOL_WRAPPER_RE.exec(before)) !== null) lastBefore = wrapper;
  if (lastBefore && before.slice(lastBefore.index + lastBefore[0].length).trim() === "") start = lastBefore.index;
  const after = text.slice(end);
  const afterWrapper = after.match(/^\s*<\s*\|?\/?\s*(?:tool_call|tool▁call)\s*\|?\s*>/i);
  if (afterWrapper) end += afterWrapper[0].length;
  return { start, end };
}
function parsedSpan(parsed, text) {
  if (!Array.isArray(parsed.span) || parsed.span.length !== 2) return null;
  const start = typeof parsed.span[0] === "number" ? parsed.span[0] : -1;
  const end = typeof parsed.span[1] === "number" ? parsed.span[1] : -1;
  if (start < 0 || end < start || end > text.length) return null;
  return { start, end };
}
function parseToolEntries(text) {
  let raw = "";
  try {
    raw = host.toolcall.parse(text, TOOL_SCHEMA_JSON);
  } catch (e) {
    host.log("warn", `host.toolcall.parse failed: ${String(e)}`);
    return { entries: [], cleaned: text, status: "none" };
  }
  const parsed = parseJson(raw, null);
  if (!parsed || typeof parsed !== "object") return { entries: [], cleaned: text, status: "none" };
  if (parsed.status === "malformed") {
    const reason = typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "unparseable tool call";
    return { entries: [], cleaned: text, status: "malformed", reason };
  }
  if (parsed.status !== "ok" || typeof parsed.tool !== "string") {
    return { entries: [], cleaned: text, status: "none" };
  }
  const args = parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args) ? parsed.args : {};
  const span = parsedSpan(parsed, text);
  const cleaned = span ? stripSpans(text, [expandToolSpan(text, span)]) : text;
  return {
    entries: [{ call: { tool: parsed.tool, args } }],
    cleaned,
    status: "ok"
  };
}
function toolContent(call) {
  if (call.tool === "exec" && typeof call.args.cmd === "string") return call.args.cmd;
  if (call.tool === "codeterm" && typeof call.args.args === "string") return `codeterm ${call.args.args}`;
  return JSON.stringify(call.args);
}
function emitToolCall(s, call) {
  const toolId = nextId(s, `lmstudio-tool-${call.tool}`);
  const toolArgs = JSON.stringify(call.args);
  append(s, "tool_call", toolContent(call), toolId, {
    toolName: call.tool,
    toolInput: call.args,
    toolArgs,
    toolId,
    collapsed: true,
    provider: "lmstudio"
  });
  return toolId;
}
function emitToolResult(s, call, result, toolId) {
  const formatted = formatToolResult(call, result);
  append(s, "tool_result", formatted, void 0, {
    toolId,
    toolResult: formatted,
    collapsed: true,
    provider: "lmstudio"
  });
  s.pendingInputs.push(`tool_result:
${formatted}`);
}
function promptVariantForModel(modelId, generalPrompt) {
  void modelId;
  return generalPrompt;
}
function systemPromptForModel(generalPrompt, modelId) {
  if (!modelId) return generalPrompt;
  return promptVariantForModel(modelId, generalPrompt);
}
function executeTool(call) {
  switch (call.tool) {
    case "read_file": {
      const path = typeof call.args.path === "string" ? call.args.path : "";
      if (!path) return { error: "read_file requires args.path" };
      return { content: host.readFile(path) };
    }
    case "write_file": {
      const path = typeof call.args.path === "string" ? call.args.path : "";
      const content = typeof call.args.content === "string" ? call.args.content : "";
      if (!path) return { error: "write_file requires args.path" };
      return { ok: host.writeFile(path, content) };
    }
    case "mem_search": {
      const query = typeof call.args.query === "string" ? call.args.query : "";
      if (!query) return { error: "mem_search requires args.query" };
      const maybeHost = host;
      if (typeof maybeHost.mem === "function") {
        return parseJson(maybeHost.mem(JSON.stringify({ query })), { error: "host.mem returned non-JSON" });
      }
      return maybeHost.mem && maybeHost.mem.search ? maybeHost.mem.search({ query, k: 5 }) : { error: "host.mem.search unavailable" };
    }
    case "spawn_agent": {
      const provider = typeof call.args.provider === "string" ? call.args.provider : "";
      const task = typeof call.args.task === "string" ? call.args.task : "";
      const workspace = typeof call.args.workspace === "string" ? call.args.workspace : "default";
      if (!provider || !task) return { error: "spawn_agent requires args.provider and args.task" };
      const maybeHost = host;
      if (maybeHost.agent && maybeHost.agent.spawn) {
        return maybeHost.agent.spawn(workspace, { backend: { provider }, task });
      }
      if (maybeHost.worker && maybeHost.worker.start) {
        return maybeHost.worker.start(JSON.stringify({ provider, task, workspace }));
      }
      return { error: "host.agent.spawn unavailable" };
    }
    default:
      return { error: `unknown tool: ${call.tool}` };
  }
}
function consumeSseEvent(stream, segment) {
  if (!segment) return;
  let dataStr = "";
  for (const line of segment.split(/\r?\n/)) {
    if (line.indexOf("data:") !== 0) continue;
    let value = line.slice(5);
    if (value.charAt(0) === " ") value = value.slice(1);
    dataStr += value;
  }
  if (!dataStr) return;
  const data = parseJson(
    dataStr,
    null
  );
  if (!data || typeof data !== "object") return;
  const type = typeof data.type === "string" ? data.type : "";
  if (type.indexOf("message.") === 0 && typeof data.content === "string") {
    stream.content += data.content;
  } else if (type.indexOf("reasoning.") === 0 && typeof data.content === "string") {
    stream.reasoning += data.content;
  } else if (type === "chat.end") {
    const rid = data.result && data.result.response_id;
    if (typeof rid === "string") stream.responseId = rid;
  }
}
function parseSse(stream, flush) {
  const segments = stream.buffer.split(/\r?\n\r?\n/);
  stream.buffer = flush ? "" : segments.pop() ?? "";
  for (const seg of segments) consumeSseEvent(stream, seg);
}
function assembledContext(s) {
  const prior = [];
  const assistantIndex = {};
  for (const m of s.messages) {
    if (m.type === "assistant") {
      if (assistantIndex[m.id] === void 0) {
        assistantIndex[m.id] = prior.length;
        prior.push({ id: m.id, line: `assistant: ${m.content}` });
      } else {
        prior[assistantIndex[m.id]].line = `assistant: ${m.content}`;
      }
    } else if (m.type === "user" || m.type === "tool_result") {
      if (m.type === "user" && m.content.indexOf(SYSTEM_PROMPT_MARKER) === 0) continue;
      prior.push({ id: m.id, line: `${m.type}: ${m.content}` });
    }
  }
  return prior.map((m) => m.line).join("\n\n");
}
function messagesAsEngineHistory(s) {
  const history = [];
  if (s.systemPrompt) history.push({ role: "system", content: s.systemPrompt });
  for (const m of s.messages) {
    if (m.type === "user") {
      if (m.content.indexOf(SYSTEM_PROMPT_MARKER) === 0) continue;
      history.push({ role: "user", content: m.content });
    } else if (m.type === "assistant") {
      history.push({ role: "assistant", content: m.content });
    }
  }
  return history;
}
function requestInputFromMessages(messages) {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
}
function startLmStudioCall(s, input, opts) {
  if (!s.model) {
    const resolved = resolveModelId();
    if (!resolved) {
      append(s, "system", "LM Studio error: no model configured and none could be auto-resolved from /api/v1/models.");
      s.done = true;
      return;
    }
    s.model = resolved;
    rememberLastModel(resolved);
  }
  const needsFallbackContext = !s.previousResponseId && s.messages.some((m) => m.type === "assistant" || m.type === "tool_result");
  let requestInput = input;
  if (opts?.messages) {
    requestInput = requestInputFromMessages(opts.messages);
  } else if (s.engine && s.engine.kind === "chat" && s.engine.window?.maxMessages !== void 0) {
    requestInput = requestInputFromMessages(assembleChat(messagesAsEngineHistory(s), s.engine.window));
  } else if (needsFallbackContext) {
    requestInput = assembledContext(s);
  }
  const body = {
    model: s.model,
    system_prompt: s.systemPrompt,
    input: requestInput,
    stream: true,
    ...s.params
  };
  if (!opts?.messages && s.previousResponseId) body.previous_response_id = s.previousResponseId;
  const started = startFetchStream({
    url: `${baseUrl()}/api/v1/chat`,
    method: "POST",
    body: JSON.stringify(body)
  });
  if (!started.jobId) {
    const err = started.error || "missing jobId";
    append(s, "system", isVramLoadFailure(err) ? vramLoadFailureMessage(s.model) : `LM Studio stream error: ${err}`);
    s.done = true;
    return;
  }
  s.stream = {
    jobId: started.jobId,
    messageId: nextId(s, "lmstudio-assistant"),
    reasoningId: nextId(s, "lmstudio-reasoning"),
    content: "",
    reasoning: "",
    buffer: "",
    responseId: null
  };
  s.currentRun = opts?.watcher || s.mode === "watcher" ? "watcher" : "interactive";
  s.done = false;
}
function startNextIfIdle(s) {
  if (!s.stream && s.pendingInputs.length) {
    const next = s.pendingInputs.shift() || "";
    const queued = parseJson(next, null);
    if (queued && Array.isArray(queued.watcherMessages)) {
      startLmStudioCall(s, "", { messages: queued.watcherMessages, watcher: true });
    } else if (queued && Array.isArray(queued.machineMessages)) {
      startLmStudioCall(s, "", { messages: queued.machineMessages });
    } else {
      startLmStudioCall(s, next);
    }
  }
}
function finishAssistantMessage(s, content, responseId, messageId) {
  if (s.currentRun === "watcher") {
    finishLoopAssistantMessage(s, content, responseId, messageId);
    return;
  }
  if (responseId && !(s.engine && s.engine.kind === "machine")) s.previousResponseId = responseId;
  finishLoopAssistantMessage(s, content, responseId, messageId);
}
function finishLoopAssistantMessage(s, content, responseId, messageId) {
  if (s.currentRun === "watcher") {
    s.watcherLastAssistant = content;
    if (responseId) s.previousResponseId = responseId;
  }
  const { entries, cleaned, status, reason } = parseToolEntries(content);
  if (status === "malformed") {
    if (s.malformedRetries < MAX_MALFORMED_RETRIES) {
      s.malformedRetries += 1;
      s.pendingInputs.push(
        `tool_result:
ERROR: your codeterm-tool JSON was invalid (${reason || "unparseable tool call"}). Resend a single valid JSON tool call, or answer in plain text if no tool is needed.`
      );
      return;
    }
    if (s.currentRun === "watcher") {
      append(s, "system", `Could not parse a valid tool call after ${MAX_MALFORMED_RETRIES} retries; ending this watcher tick.`);
      completeWatcherTick(s, content);
    } else {
      append(
        s,
        "system",
        `Could not parse a valid tool call after ${MAX_MALFORMED_RETRIES} retries; treating the reply as a normal message.`
      );
      s.done = true;
    }
    return;
  }
  if (!entries.length) {
    if (s.currentRun === "watcher") completeWatcherTick(s, content);
    else {
      if (s.engine && s.engine.kind === "machine") s.machineState = extractVerdictState(content, s.machineState);
      s.done = true;
    }
    return;
  }
  if (cleaned !== content) {
    if (cleaned.trim() === "") {
      const idx = s.messages.findIndex((m) => m.id === messageId);
      if (idx >= 0) s.messages.splice(idx, 1);
    } else {
      append(s, "assistant", cleaned, messageId);
    }
  }
  s.pendingTools = entries.slice();
  advanceTools(s);
}
function watcherFallbackVerdict() {
  return JSON.stringify({
    status: "attention",
    summary: "tool loop ended without a verdict",
    state: {},
    actions: []
  });
}
function completeWatcherTick(s, verdict) {
  if (!s.watcherVerdictEmitted) {
    const text = verdict && verdict.trim() ? verdict : watcherFallbackVerdict();
    append(s, "watcher_verdict", text);
    s.watcherVerdictEmitted = true;
  }
  s.done = true;
}
function extractVerdictState(text, prior) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const raw = fenced ? fenced[1] : trimmed;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "state")) {
      return parsed.state;
    }
  } catch {
  }
  return prior;
}
function advanceTools(s) {
  if (s.pendingExec) return;
  while (s.pendingTools && s.pendingTools.length) {
    const entry = s.pendingTools.shift();
    const call = entry.call;
    if (s.toolRounds >= MAX_TOOL_ROUNDS) {
      s.pendingInputs = [];
      s.pendingTools = null;
      if (!s.capReached) {
        append(s, "system", `Tool round cap (${MAX_TOOL_ROUNDS}) reached; stopping this turn.`);
        s.capReached = true;
      }
      if (s.currentRun === "watcher") completeWatcherTick(s, null);
      else s.done = true;
      return;
    }
    s.toolRounds += 1;
    const toolId = emitToolCall(s, call);
    if (call.tool === "exec" || call.tool === "codeterm") {
      const shell = execShellCmd(call);
      if (shell.error) {
        emitToolResult(s, call, { error: shell.error }, toolId);
        continue;
      }
      const started = startExecJob(shell.shellCmd);
      if (started.jobId) {
        s.pendingExec = { call, jobId: started.jobId, toolId };
        return;
      }
      emitToolResult(s, call, { error: started.error || "host.exec.start failed" }, toolId);
      continue;
    }
    emitToolResult(s, call, executeTool(call), toolId);
  }
  s.pendingTools = null;
}
function drainExec(s) {
  while (s.pendingExec) {
    const poll = pollExecJob(s.pendingExec.jobId);
    if (!poll.done) return;
    const finished = s.pendingExec;
    host.execClose(finished.jobId);
    s.pendingExec = null;
    emitToolResult(s, finished.call, execResultFromPoll(poll), finished.toolId);
    advanceTools(s);
  }
}
function drainAuthor(s) {
  if (!s.pendingAuthor) return;
  const pending = s.pendingAuthor;
  let poll;
  try {
    poll = host.agent.poll(pending.ticket);
  } catch (e) {
    s.pendingAuthor = null;
    try {
      host.agent.reap(pending.agentSessionId);
    } catch {
    }
    append(s, "system", `Prompt authoring failed: ${String(e)}`);
    s.done = true;
    return;
  }
  if (!poll || !poll.done) return;
  s.pendingAuthor = null;
  try {
    host.agent.reap(pending.agentSessionId);
  } catch {
  }
  const reply = typeof poll.reply === "string" ? poll.reply : "";
  if (poll.error || !reply.trim()) {
    append(s, "system", `Prompt authoring failed: ${poll.error || "the author agent returned no prompt"}.`);
    s.done = true;
    return;
  }
  applyAuthoredPrompt(s, pending.model, stripPromptFence(reply));
  append(s, "system", `Updated the system prompt for ${pending.model} from the author agent.`);
  s.done = true;
}
function pollStream(s) {
  if (!s.stream) return;
  const stream = s.stream;
  const poll = pollFetchStream(stream.jobId);
  if (poll.error) {
    append(s, "system", isVramLoadFailure(poll.error) ? vramLoadFailureMessage(s.model) : `LM Studio stream error: ${poll.error}`);
    host.fetchStreamClose(stream.jobId);
    s.stream = null;
    s.done = true;
    return;
  }
  if (poll.status && poll.status >= 400) {
    const err = errorTextFromBody(poll.body);
    append(
      s,
      "system",
      isVramLoadFailure(err) ? vramLoadFailureMessage(s.model) : `LM Studio HTTP ${poll.status}`
    );
    host.fetchStreamClose(stream.jobId);
    s.stream = null;
    s.done = true;
    return;
  }
  const chunks = Array.isArray(poll.chunks) ? poll.chunks : [];
  if (chunks.length) {
    stream.buffer += chunks.join("");
    parseSse(stream, false);
  }
  if (poll.done) parseSse(stream, true);
  if (stream.reasoning) append(s, "thinking", stream.reasoning, stream.reasoningId);
  if (stream.content) append(s, "assistant", stream.content, stream.messageId);
  if (poll.done) {
    host.fetchStreamClose(stream.jobId);
    s.stream = null;
    finishAssistantMessage(s, stream.content, stream.responseId, stream.messageId);
  }
}
function resolveSession(ctx) {
  const s = readSettings();
  const allPresets = presets();
  const explicitModel = cleanModel(ctx.model);
  const requestedPreset = presetById(allPresets, ctx.preset);
  const presetModel = explicitModel ? "" : cleanModel(requestedPreset && requestedPreset.model);
  const persistedModel = explicitModel || presetModel ? "" : readLastModel();
  const chosenModel = explicitModel || presetModel || persistedModel || cleanModel(s.model);
  const boundPreset = presetBoundToModel(allPresets, chosenModel);
  const preset = boundPreset || resolvePreset(ctx.preset, chosenModel);
  const model = chosenModel || cleanModel(preset && preset.model);
  const presetSystemPrompt = preset && typeof preset.systemPrompt === "string" ? preset.systemPrompt : "";
  const generalSystemPrompt = (boundPreset ? presetSystemPrompt || defaultSystemPrompt(allPresets) : ctx.systemPrompt || presetSystemPrompt) || defaultSystemPrompt(allPresets) || "";
  const authoredPrompts = readAuthoredPrompts();
  const systemPrompt = model && authoredPrompts[model] || systemPromptForModel(generalSystemPrompt, model);
  const params = { ...s.params || {}, ...preset && preset.params || {} };
  const mode = ctx.mode === "watcher" ? "watcher" : "interactive";
  const engine = ctx.engine && typeof ctx.engine === "object" ? ctx.engine : null;
  let charter = "";
  let charterError;
  if (engine && engine.kind === "machine") {
    const resolved = resolveCharterRef(engine.charter);
    charter = resolved.charter;
    charterError = resolved.error;
  }
  if (mode === "watcher" && !charter && !charterError) {
    charter = SHIPPED_CHARTERS["watcher-orchestration"] ?? "";
    if (!charter) charterError = "no charter provided and no shipped default";
  }
  const effectiveSystemPrompt = mode === "watcher" ? "" : systemPrompt;
  return {
    messages: [],
    seq: 0,
    systemPrompt: effectiveSystemPrompt,
    mode,
    engine,
    charter,
    machineState: {},
    currentRun: "interactive",
    watcherTicks: 0,
    watcherVerdictEmitted: false,
    watcherLastAssistant: "",
    model,
    params,
    previousResponseId: null,
    pendingInputs: [],
    stream: null,
    done: true,
    toolRounds: 0,
    capReached: false,
    malformedRetries: 0,
    pendingTools: null,
    pendingExec: null,
    pendingAuthor: null,
    charterError
  };
}
var plugin = {
  openSession(ctx) {
    const sid = ctx.paneId;
    const s = resolveSession(ctx);
    if (s.charterError) {
      host.log("error", `openSession failed for ${sid}: ${s.charterError}`);
      return { error: s.charterError };
    }
    if (s.mode === "watcher") {
      if (s.charter) append(s, "user", markSystemPrompt(s.charter), "system-prompt");
    } else if (s.systemPrompt) {
      append(s, "user", markSystemPrompt(s.systemPrompt), "system-prompt");
    }
    sessions.set(sid, s);
    rememberLastModel(s.model);
    return { sessionId: sid };
  },
  sendMessage(sid, text) {
    const s = sessions.get(sid);
    if (!s) return;
    if (s.mode === "watcher") {
      host.log("warn", `sendMessage ignored for watcher session ${sid}`);
      return;
    }
    append(s, "user", text);
    s.toolRounds = 0;
    s.capReached = false;
    s.malformedRetries = 0;
    s.done = false;
    if (s.engine && s.engine.kind === "machine") {
      const messages = assembleMachine(s.charter, s.machineState, { query: text });
      s.pendingInputs.push(JSON.stringify({ machineMessages: messages }));
    } else {
      s.pendingInputs.push(text);
    }
    startNextIfIdle(s);
  },
  watcherTick(sid, input) {
    const s = sessions.get(sid);
    if (!s || s.mode !== "watcher") return;
    const tickInput = input;
    const messages = assembleMachine(s.charter, tickInput.state, tickInput);
    s.watcherTicks += 1;
    append(s, "context_request", JSON.stringify(messages));
    s.currentRun = "watcher";
    s.previousResponseId = null;
    s.pendingInputs = [];
    s.pendingTools = null;
    s.pendingExec = null;
    s.stream = null;
    s.toolRounds = 0;
    s.capReached = false;
    s.malformedRetries = 0;
    s.watcherVerdictEmitted = false;
    s.watcherLastAssistant = "";
    s.done = false;
    s.pendingInputs.push(JSON.stringify({ watcherMessages: messages }));
    startNextIfIdle(s);
  },
  pump(sid) {
    const s = sessions.get(sid);
    if (!s) return;
    pollStream(s);
    drainExec(s);
    drainAuthor(s);
    startNextIfIdle(s);
  },
  poll(sid, cursor) {
    const s = sessions.get(sid);
    if (!s) return { messages: [], cursor: cursor ?? "0", done: true };
    const from = Number(cursor ?? 0) || 0;
    let liveFrom = -1;
    if (s.stream) {
      for (let i = 0; i < s.messages.length; i += 1) {
        if (s.messages[i].id === s.stream.messageId || s.messages[i].id === s.stream.reasoningId) {
          liveFrom = i;
          break;
        }
      }
    }
    const nextCursor = liveFrom >= 0 ? liveFrom : s.messages.length;
    return {
      messages: s.messages.slice(from),
      cursor: String(nextCursor),
      done: s.done && !s.stream && !s.pendingExec && !s.pendingAuthor && s.pendingInputs.length === 0
    };
  },
  closeSession(sid) {
    const s = sessions.get(sid);
    if (s && s.stream) host.fetchStreamClose(s.stream.jobId);
    sessions.delete(sid);
  },
  listModels() {
    const res = fetchJson({ url: `${baseUrl()}/api/v1/models`, method: "GET" });
    if (res.error || res.status && res.status >= 400) return [];
    const data = parseJson(res.body || "{}", {});
    const models = [];
    if (Array.isArray(data.models)) {
      for (const r of data.models) {
        if (r && typeof r.key === "string") {
          const displayName = typeof r.display_name === "string" ? r.display_name : r.key;
          models.push({ id: r.key, displayName });
        }
      }
    } else if (Array.isArray(data.data)) {
      for (const r of data.data) {
        if (r && typeof r.id === "string") models.push({ id: r.id, displayName: r.id });
      }
    }
    return models;
  },
  listPresets() {
    return presets().map((p) => ({ id: p.id, name: p.name, description: p.description }));
  },
  sessionInfo(sid) {
    const s = sessions.get(sid);
    return { model: s ? s.model : void 0, systemPrompt: s ? s.systemPrompt : void 0 };
  },
  describeModelSwitch,
  authorSystemPrompt(sid, draft) {
    const s = sessions.get(sid);
    if (!s || !s.model) return;
    applyAuthoredPrompt(s, s.model, draft);
  },
  // R6: hand the "tune this pane's system prompt for model X" task off to a
  // separate agent pane. Plugin-mediated end to end: we read THIS session's
  // model + current prompt, spawn an author agent (host.workspace/agent), send
  // it the request, and park `pendingAuthor`. pump → drainAuthor polls the
  // ticket across turns and writes the reply back via applyAuthoredPrompt, so
  // the user iteratively improves the per-model prompt without editing JSON.
  requestPromptAuthoring(sid, instruction) {
    const s = sessions.get(sid);
    if (!s || !s.model) return { ok: false, error: "no active session or model to author for" };
    if (s.pendingAuthor) return { ok: false, error: "prompt authoring already in progress" };
    let workspaceId = "";
    try {
      workspaceId = host.workspace.ensure({ name: PROMPT_AUTHOR_WORKSPACE }).workspaceId;
    } catch (e) {
      append(s, "system", `Prompt authoring unavailable: ${String(e)}`);
      return { ok: false, error: String(e) };
    }
    if (!workspaceId) {
      append(s, "system", "Prompt authoring failed: could not open an authoring workspace.");
      return { ok: false, error: "no workspace" };
    }
    const spawned = host.agent.spawn(workspaceId, {
      task: `Help tune the system prompt for the local LM Studio model "${s.model}".`
    });
    const agentSessionId = spawned && spawned.sessionId;
    if (!agentSessionId) {
      append(s, "system", "Prompt authoring failed: could not spawn an author agent.");
      return { ok: false, error: "spawn failed" };
    }
    const sent = host.agent.send(agentSessionId, buildAuthoringRequest(s.model, s.systemPrompt, instruction));
    const ticket = sent && sent.ticket;
    if (!ticket) {
      try {
        host.agent.reap(agentSessionId);
      } catch {
      }
      append(s, "system", "Prompt authoring failed: could not send the request to the author agent.");
      return { ok: false, error: "send failed" };
    }
    s.pendingAuthor = { ticket, agentSessionId, model: s.model };
    s.done = false;
    append(s, "system", `Handing off system-prompt authoring for ${s.model} to an agent\u2026`);
    return { ok: true };
  },
  setModel(sid, model) {
    const s = sessions.get(sid);
    if (!s || typeof model !== "string" || !model) return;
    if (s.model === model) return;
    s.model = model;
    rememberLastModel(model);
    s.previousResponseId = null;
  }
};
var plugin_default = plugin;
