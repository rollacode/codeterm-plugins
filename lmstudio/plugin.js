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
var CURATED_TOOLS = ["exec", "read_file", "write_file", "codeterm", "mem_search", "spawn_agent"];
var NATIVE_CALL_RE = /call\s*[:=]\s*((?:[A-Za-z_][A-Za-z0-9_]*\s*:\s*)*[A-Za-z_][A-Za-z0-9_]*)\s*(\{[\s\S]*?\})/g;
var NATIVE_ARG_ALIASES = {
  exec: { command: "cmd" },
  codeterm: { command: "args", cmd: "args" }
};
function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const obj = v;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
var DOCUMENTED_EXAMPLE_CANON = canonicalJson({ tool: "exec", args: { cmd: "codeterm pane list" } });
function isDocumentedExample(call) {
  return !!call && canonicalJson({ tool: call.tool, args: call.args }) === DOCUMENTED_EXAMPLE_CANON;
}
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
  const msgId = id || nextId(s);
  const existing = s.messages.find((m) => m.id === msgId);
  if (existing) {
    existing.content = content;
    return existing;
  }
  const msg = { id: msgId, type, content };
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
function collectFenceMatches(text) {
  const matches = [];
  TOOL_FENCE_RE.lastIndex = 0;
  let match;
  while ((match = TOOL_FENCE_RE.exec(text)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length, entry: parseToolJson(match[1]) });
  }
  return matches;
}
function trailingFenceGroup(text, matches) {
  if (!matches.length) return [];
  let firstTrailing = matches.length - 1;
  while (firstTrailing > 0) {
    const prev = matches[firstTrailing - 1];
    const next = matches[firstTrailing];
    if (text.slice(prev.end, next.start).trim() !== "") break;
    firstTrailing -= 1;
  }
  return matches.slice(firstTrailing);
}
function parseLooseObject(raw) {
  const attempt = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(raw);
  if (direct) return direct;
  const coerced = raw.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3').replace(/'/g, '"');
  return attempt(coerced);
}
function applyArgAliases(tool, args) {
  const aliases = NATIVE_ARG_ALIASES[tool];
  if (!aliases) return args;
  const out = { ...args };
  for (const from of Object.keys(aliases)) {
    const to = aliases[from];
    if (out[to] === void 0 && out[from] !== void 0) out[to] = out[from];
  }
  return out;
}
function collectNativeMatches(text) {
  const matches = [];
  NATIVE_CALL_RE.lastIndex = 0;
  let match;
  while ((match = NATIVE_CALL_RE.exec(text)) !== null) {
    const tool = match[1].split(":").pop().trim();
    if (!CURATED_TOOLS.includes(tool)) continue;
    let start = match.index;
    let end = match.index + match[0].length;
    const wrapBefore = text.slice(0, start).match(/<\s*\|?\s*(?:tool_call|tool▁call)\s*\|?\s*>\s*$/i);
    if (wrapBefore) start -= wrapBefore[0].length;
    const wrapAfter = text.slice(end).match(/^\s*<\s*\|?\s*(?:tool_call|tool▁call)\s*\|?\s*>/i);
    if (wrapAfter) end += wrapAfter[0].length;
    const parsed = parseLooseObject(match[2]);
    if (!parsed) {
      matches.push({ start, end, entry: { raw: match[0], error: "native tool-call args not parseable" } });
      continue;
    }
    matches.push({ start, end, entry: { raw: match[0], call: { tool, args: applyArgAliases(tool, parsed) } } });
  }
  return matches;
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
function parseToolEntries(text) {
  const fenceTools = trailingFenceGroup(text, collectFenceMatches(text)).filter(
    (m) => !isDocumentedExample(m.entry.call)
  );
  if (fenceTools.length) {
    return { entries: fenceTools.map((m) => m.entry), cleaned: stripSpans(text, fenceTools) };
  }
  const nativeTools = collectNativeMatches(text).filter((m) => !isDocumentedExample(m.entry.call));
  if (nativeTools.length) {
    return { entries: nativeTools.map((m) => m.entry), cleaned: stripSpans(text, nativeTools) };
  }
  return { entries: [], cleaned: text };
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
  if (cleaned !== content) append(s, "assistant", cleaned, messageId);
  s.pendingTools = entries.slice();
  advanceTools(s);
}
function emitToolResult(s, call, result) {
  const formatted = formatToolResult(call, result);
  append(s, "tool_result", formatted);
  s.pendingInputs.push(`tool_result:
${formatted}`);
}
function advanceTools(s) {
  if (s.pendingExec) return;
  while (s.pendingTools && s.pendingTools.length) {
    const entry = s.pendingTools.shift();
    if (entry.error || !entry.call) {
      const formatted = JSON.stringify(
        { tool: "parse_error", error: entry.error || "invalid tool call", raw: entry.raw },
        null,
        2
      );
      append(s, "tool_result", formatted);
      s.pendingInputs.push(`tool_result:
${formatted}`);
      continue;
    }
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
    if (call.tool === "exec" || call.tool === "codeterm") {
      const shell = execShellCmd(call);
      if (shell.error) {
        emitToolResult(s, call, { error: shell.error });
        continue;
      }
      const started = startExecJob(shell.shellCmd);
      if (started.jobId) {
        s.pendingExec = { call, jobId: started.jobId };
        return;
      }
      emitToolResult(s, call, { error: started.error || "host.exec.start failed" });
      continue;
    }
    emitToolResult(s, call, executeTool(call));
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
    emitToolResult(s, finished.call, execResultFromPoll(poll));
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
  }
};
var plugin_default = plugin;
