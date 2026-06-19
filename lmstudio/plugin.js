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
  let raw = "null";
  try {
    raw = host.toolcall.parse(text, TOOL_SCHEMA_JSON);
  } catch (e) {
    host.log("warn", `host.toolcall.parse failed: ${String(e)}`);
    return { entries: [], cleaned: text };
  }
  if (raw === "null") return { entries: [], cleaned: text };
  const parsed = parseJson(raw, null);
  if (!parsed || typeof parsed.tool !== "string") return { entries: [], cleaned: text };
  const args = parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args) ? parsed.args : {};
  const span = parsedSpan(parsed, text);
  const cleaned = span ? stripSpans(text, [expandToolSpan(text, span)]) : text;
  return {
    entries: [{ call: { tool: parsed.tool, args } }],
    cleaned
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
function finishAssistantMessage(s, content, responseId, messageId) {
  if (responseId) s.previousResponseId = responseId;
  const { entries, cleaned } = parseToolEntries(content);
  if (!entries.length) {
    s.done = true;
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
      s.done = true;
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
  const chosenModel = ctx.model || s.model || "";
  const boundPreset = presetBoundToModel(allPresets, chosenModel);
  const preset = boundPreset || resolvePreset(ctx.preset, chosenModel);
  const model = ctx.model || preset && preset.model || s.model || "";
  const presetSystemPrompt = preset && typeof preset.systemPrompt === "string" ? preset.systemPrompt : "";
  const generalSystemPrompt = (boundPreset ? presetSystemPrompt || defaultSystemPrompt(allPresets) : ctx.systemPrompt || presetSystemPrompt) || defaultSystemPrompt(allPresets) || "";
  const systemPrompt = systemPromptForModel(generalSystemPrompt, model);
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
    capReached: false,
    pendingTools: null,
    pendingExec: null
  };
}
var plugin = {
  openSession(ctx) {
    const sid = ctx.paneId;
    const s = resolveSession(ctx);
    if (s.systemPrompt) append(s, "user", markSystemPrompt(s.systemPrompt), "system-prompt");
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
    drainExec(s);
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
      done: s.done && !s.stream && !s.pendingExec && s.pendingInputs.length === 0
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
    return { model: s ? s.model : void 0 };
  },
  setModel(sid, model) {
    const s = sessions.get(sid);
    if (!s || typeof model !== "string" || !model) return;
    s.model = model;
    s.previousResponseId = null;
  }
};
var plugin_default = plugin;
