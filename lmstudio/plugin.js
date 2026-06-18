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
function parseToolJson(raw) {
  try {
    const parsed = JSON.parse(raw.trim());
    if (!parsed || typeof parsed !== "object") {
      return { raw, error: "tool JSON must be an object" };
    }
    const obj = parsed;
    if (typeof obj.tool !== "string") {
      return { raw, error: "tool JSON requires string field `tool`" };
    }
    const args = obj.args && typeof obj.args === "object" ? obj.args : {};
    return { raw, call: { tool: obj.tool, args } };
  } catch (e) {
    return { raw, error: `tool JSON parse error: ${String(e)}` };
  }
}
function parseTrailingToolEntries(text) {
  const matches = [];
  TOOL_FENCE_RE.lastIndex = 0;
  let match;
  while ((match = TOOL_FENCE_RE.exec(text)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length, body: match[1] });
  }
  if (!matches.length) return [];
  const last = matches[matches.length - 1];
  if (text.slice(last.end).trim() !== "") return [];
  let firstTrailing = matches.length - 1;
  while (firstTrailing > 0) {
    const prev = matches[firstTrailing - 1];
    const next = matches[firstTrailing];
    if (text.slice(prev.end, next.start).trim() !== "") break;
    firstTrailing -= 1;
  }
  return matches.slice(firstTrailing).map((m) => parseToolJson(m.body));
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
      prior.push({ id: m.id, line: `${m.type}: ${m.content}` });
    }
  }
  return prior.map((m) => m.line).join("\n\n");
}
function startLmStudioCall(s, input) {
  if (!s.model) {
    const resolved = resolveModelId();
    if (!resolved) {
      append(s, "system", "LM Studio error: no model configured and none could be auto-resolved from /api/v1/models.");
      s.done = true;
      return;
    }
    s.model = resolved;
  }
  const needsFallbackContext = !s.previousResponseId && s.messages.some((m) => m.type === "assistant" || m.type === "tool_result");
  const body = {
    model: s.model,
    system_prompt: s.systemPrompt,
    input: needsFallbackContext ? assembledContext(s) : input,
    stream: true,
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
  s.stream = {
    jobId: started.jobId,
    messageId: nextId(s, "lmstudio-assistant"),
    reasoningId: nextId(s, "lmstudio-reasoning"),
    content: "",
    reasoning: "",
    buffer: "",
    responseId: null
  };
  s.done = false;
}
function startNextIfIdle(s) {
  if (!s.stream && s.pendingInputs.length) {
    startLmStudioCall(s, s.pendingInputs.shift() || "");
  }
}
function finishAssistantMessage(s, content, responseId) {
  if (responseId) s.previousResponseId = responseId;
  const entries = parseTrailingToolEntries(content);
  if (!entries.length) {
    s.done = true;
    return;
  }
  for (const entry of entries) {
    if (entry.error || !entry.call) {
      const formatted2 = JSON.stringify(
        { tool: "parse_error", error: entry.error || "invalid tool call", raw: entry.raw },
        null,
        2
      );
      append(s, "tool_result", formatted2);
      s.pendingInputs.push(`tool_result:
${formatted2}`);
      continue;
    }
    const call = entry.call;
    if (s.toolRounds >= MAX_TOOL_ROUNDS) {
      s.pendingInputs = [];
      if (!s.capReached) {
        append(s, "system", `Tool round cap (${MAX_TOOL_ROUNDS}) reached; stopping this turn.`);
        s.capReached = true;
      }
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
    stream.buffer += chunks.join("");
    parseSse(stream, false);
  }
  if (poll.done) parseSse(stream, true);
  if (stream.reasoning) append(s, "reasoning", stream.reasoning, stream.reasoningId);
  if (stream.content) append(s, "assistant", stream.content, stream.messageId);
  if (poll.done) {
    host.fetchStreamClose(stream.jobId);
    s.stream = null;
    finishAssistantMessage(s, stream.content, stream.responseId);
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
    toolRounds: 0,
    capReached: false
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
    s.capReached = false;
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
  }
};
var plugin_default = plugin;
