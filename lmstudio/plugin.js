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
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);
var DEFAULT_BASE_URL = "http://localhost:1234";
var MAX_TOOL_ROUNDS = 8;
var TOOL_FENCE_RE = /```codeterm-tool\s*\n([\s\S]*?)\n?```/g;
var sessions = /* @__PURE__ */ new Map();
function readSettings() {
  try {
    const raw = JSON.parse(host.settingsJson() || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
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
    (p) => !!p && typeof p.id === "string" && typeof p.name === "string" && typeof p.systemPrompt === "string"
  );
}
function resolvePreset(id) {
  const all = presets();
  if (!all.length) return null;
  const s = readSettings();
  const wanted = id || s.defaultPreset || all[0].id;
  return all.find((p) => p.id === wanted) || all[0];
}
function nextId(s, prefix = "lmstudio") {
  const id = `${prefix}-${s.seq}`;
  s.seq += 1;
  return id;
}
function append(s, type, content, id) {
  const msg = { id: id || nextId(s), type, content };
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
function execShell(cmd, cwd) {
  const shellCmd = cwd && cwd.trim() ? `cd ${shellQuote(cwd)} && ${cmd}` : cmd;
  return parseJson(
    host.exec(JSON.stringify({ bin: "sh", args: ["-lc", shellCmd], timeoutMs: 12e4 })),
    { error: "host.exec returned non-JSON" }
  );
}
function formatToolResult(call, result) {
  return JSON.stringify({ tool: call.tool, args: call.args, result }, null, 2);
}
function parseToolCalls(text) {
  const calls = [];
  TOOL_FENCE_RE.lastIndex = 0;
  let match;
  while ((match = TOOL_FENCE_RE.exec(text)) !== null) {
    const parsed = parseJson(match[1].trim(), null);
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed;
    if (typeof obj.tool !== "string") continue;
    const args = obj.args && typeof obj.args === "object" ? obj.args : {};
    calls.push({ tool: obj.tool, args });
  }
  return calls;
}
function executeTool(call) {
  switch (call.tool) {
    case "exec": {
      const cmd = typeof call.args.cmd === "string" ? call.args.cmd : "";
      const cwd = typeof call.args.cwd === "string" ? call.args.cwd : void 0;
      if (!cmd) return { error: "exec requires args.cmd" };
      return execShell(cmd, cwd);
    }
    case "codeterm": {
      const args = typeof call.args.args === "string" ? call.args.args : "";
      if (!args) return { error: "codeterm requires args.args" };
      return execShell(`codeterm ${args}`);
    }
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
function extractResponseId(poll, content) {
  const sources = [poll.body, content];
  for (const source of sources) {
    if (!source || source.trim()[0] !== "{") continue;
    const data = parseJson(source, {});
    if (typeof data.response_id === "string") return data.response_id;
  }
  return null;
}
function assembledContext(s) {
  const prior = [];
  for (const m of s.messages) {
    if (m.type === "user" || m.type === "assistant" || m.type === "tool_result") {
      prior.push(`${m.type}: ${m.content}`);
    }
  }
  return prior.join("\n\n");
}
function startLmStudioCall(s, input) {
  const needsFallbackContext = !s.previousResponseId && s.messages.some((m) => m.type === "assistant" || m.type === "tool_result");
  const body = {
    model: s.model,
    system_prompt: s.systemPrompt,
    input: needsFallbackContext ? assembledContext(s) : input,
    ...s.params
  };
  if (s.previousResponseId) body.previous_response_id = s.previousResponseId;
  const started = startFetchStream({
    url: `${baseUrl()}/api/v1/chat`,
    method: "POST",
    body: JSON.stringify(body)
  });
  if (!started.jobId) {
    append(s, "system", `LM Studio stream error: ${started.error || "missing jobId"}`);
    s.done = true;
    return;
  }
  s.stream = { jobId: started.jobId, messageId: nextId(s, "lmstudio-assistant"), content: "" };
  s.done = false;
}
function startNextIfIdle(s) {
  if (!s.stream && s.pendingInputs.length) {
    startLmStudioCall(s, s.pendingInputs.shift() || "");
  }
}
function finishAssistantMessage(s, content, poll) {
  const responseId = extractResponseId(poll, content);
  if (responseId) s.previousResponseId = responseId;
  const calls = parseToolCalls(content);
  if (!calls.length) {
    s.done = true;
    return;
  }
  for (const call of calls) {
    if (s.toolRounds >= MAX_TOOL_ROUNDS) {
      append(s, "system", `Tool round cap (${MAX_TOOL_ROUNDS}) reached; stopping this turn.`);
      s.done = true;
      return;
    }
    s.toolRounds += 1;
    const result = executeTool(call);
    const formatted = formatToolResult(call, result);
    append(s, "tool_result", formatted);
    s.pendingInputs.push(`tool_result:
${formatted}`);
  }
  startNextIfIdle(s);
}
function pollStream(s) {
  if (!s.stream) return;
  const stream = s.stream;
  const poll = pollFetchStream(stream.jobId);
  if (poll.error) {
    append(s, "system", `LM Studio stream error: ${poll.error}`);
    host.fetchStreamClose(stream.jobId);
    s.stream = null;
    s.done = true;
    return;
  }
  if (poll.status && poll.status >= 400) {
    append(s, "system", `LM Studio HTTP ${poll.status}`);
    host.fetchStreamClose(stream.jobId);
    s.stream = null;
    s.done = true;
    return;
  }
  const chunks = Array.isArray(poll.chunks) ? poll.chunks : [];
  if (chunks.length) {
    stream.content += chunks.join("");
    append(s, "assistant", stream.content, stream.messageId);
  }
  if (poll.done) {
    if (!chunks.length && !s.messages.some((m) => m.id === stream.messageId)) {
      append(s, "assistant", stream.content, stream.messageId);
    }
    host.fetchStreamClose(stream.jobId);
    s.stream = null;
    finishAssistantMessage(s, stream.content, poll);
  }
}
function resolveSession(ctx) {
  const s = readSettings();
  const preset = resolvePreset(ctx.preset);
  const systemPrompt = ctx.systemPrompt || preset && preset.systemPrompt || "";
  const model = ctx.model || preset && preset.model || s.model || "";
  const params = { ...s.params || {}, ...preset && preset.params || {} };
  return {
    messages: [],
    seq: 0,
    systemPrompt,
    model,
    params,
    previousResponseId: null,
    pendingInputs: [],
    stream: null,
    done: true,
    toolRounds: 0
  };
}
var plugin = {
  openSession(ctx) {
    const sid = ctx.paneId;
    const s = resolveSession(ctx);
    if (s.systemPrompt) append(s, "system_prompt", s.systemPrompt, "system-prompt");
    sessions.set(sid, s);
    return { sessionId: sid };
  },
  sendMessage(sid, text) {
    const s = sessions.get(sid);
    if (!s) return;
    append(s, "user", text);
    s.toolRounds = 0;
    s.done = false;
    s.pendingInputs.push(text);
    startNextIfIdle(s);
  },
  pump(sid) {
    const s = sessions.get(sid);
    if (!s) return;
    pollStream(s);
    startNextIfIdle(s);
  },
  poll(sid, cursor) {
    const s = sessions.get(sid);
    if (!s) return { messages: [], cursor: cursor ?? "0", done: true };
    const from = Number(cursor ?? 0) || 0;
    return {
      messages: s.messages.slice(from),
      cursor: String(s.messages.length),
      done: s.done && !s.stream && s.pendingInputs.length === 0
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
    const rows = data.data || [];
    const models = [];
    for (const r of rows) {
      if (r && typeof r.id === "string") models.push({ id: r.id, displayName: r.id });
    }
    return models;
  },
  listPresets() {
    return presets().map((p) => ({ id: p.id, name: p.name, description: p.description }));
  }
};
var plugin_default = plugin;
