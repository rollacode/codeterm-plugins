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

// rotterdom/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);

// rotterdom/src/toolwire.ts
function pairToolCalls(turns) {
  const answered = /* @__PURE__ */ new Set();
  for (const t of turns) if (t.role === "tool" && t.toolCallId) answered.add(t.toolCallId);
  const out = [];
  let open2 = /* @__PURE__ */ new Set();
  for (const t of turns) {
    if (t.role === "tool") {
      if (t.toolCallId && open2.has(t.toolCallId)) out.push({ ...t });
      continue;
    }
    if (t.role === "assistant" && t.toolCalls && t.toolCalls.length) {
      const kept = t.toolCalls.filter((c) => answered.has(c.id));
      open2 = new Set(kept.map((c) => c.id));
      const turn = { role: "assistant", content: t.content };
      if (kept.length) turn.toolCalls = kept;
      out.push(turn);
      continue;
    }
    if (t.role === "user") open2 = /* @__PURE__ */ new Set();
    out.push({ ...t });
  }
  return out;
}
function mergeToolParts(into, parts) {
  for (const part of parts) {
    const slot = into.find((x) => x.index === part.index);
    if (!slot) {
      into.push({ ...part });
      continue;
    }
    if (part.id) slot.id = part.id;
    if (part.name) slot.name = part.name;
    slot.args += part.args;
  }
}
function finishToolCalls(parts) {
  return parts.filter((x) => x.name).sort((a, b) => a.index - b.index).map((x) => ({ id: x.id || `call_${x.index}`, name: x.name, arguments: x.args.trim() || "{}" }));
}
function openAiMessage(t) {
  if (t.role === "tool") return { role: "tool", tool_call_id: t.toolCallId, content: t.content };
  if (t.role === "assistant" && t.toolCalls && t.toolCalls.length) {
    return {
      role: "assistant",
      content: t.content || null,
      tool_calls: t.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }))
    };
  }
  return { role: t.role, content: t.content };
}

// rotterdom/src/toolspec.ts
var TOOL_SPECS = [
  { name: "shell", description: "Run an arbitrary shell command in the profile root. Shell can write and is not filesystem-confined.", required: ["command"] },
  { name: "read_file", description: "Read a bounded UTF-8 file under the profile root.", required: ["path"] },
  { name: "write_file", description: "Create or replace a file. expected must equal its entire current content (empty for a new file).", required: ["path", "content", "expected"] },
  { name: "edit_file", description: "Replace one unique occurrence after checking the entire current content against expected.", required: ["path", "old", "new", "expected"] },
  { name: "glob", description: "List files matching a root-relative glob (*, **, ?).", required: ["pattern"] },
  { name: "search", description: "Find literal text in root-confined files.", required: ["text"], optional: ["pattern"] }
];
function checkToolArgs(name, raw) {
  const spec = TOOL_SPECS.find((t) => t.name === name);
  if (!spec) throw new Error(`unknown tool: ${name}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("arguments must be an object");
  const args = raw;
  for (const key of Object.keys(args)) {
    if (![...spec.required, ...spec.optional || []].includes(key) || typeof args[key] !== "string") {
      throw new Error(`invalid argument: ${key}`);
    }
  }
  for (const key of spec.required) if (typeof args[key] !== "string") throw new Error(`missing argument: ${key}`);
  return args;
}
function openAiTools(names) {
  return TOOL_SPECS.filter((t) => names.includes(t.name)).map((t) => ({ type: "function", function: {
    name: t.name,
    description: t.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries([...t.required, ...t.optional || []].map((k) => [k, { type: "string" }])),
      required: t.required,
      additionalProperties: false
    }
  } }));
}

// rotterdom/src/policy.ts
var WRITERS = /* @__PURE__ */ new Set(["shell", "write_file", "edit_file"]);
function permitted(profile, name) {
  return TOOL_SPECS.some((t) => t.name === name) && profile.allow.includes(name) && !profile.deny.includes(name) && !profile.deny.includes("*") && !(profile.readOnly && WRITERS.has(name));
}
function offeredTools(profile) {
  return TOOL_SPECS.map((t) => t.name).filter((name) => permitted(profile, name));
}
function inside(root, path2, windows = false) {
  const norm = (s) => {
    const value = s.replace(/\\/g, "/").replace(/\/+$/, "");
    return windows ? value.toLowerCase() : value;
  };
  const r = norm(root), p = norm(path2);
  return p === r || p.startsWith(`${r}/`);
}
function relativePath(root, path2) {
  if (!path2 || /[\x00-\x1f]/.test(path2) || /^[\\/]|^[A-Za-z]:/.test(path2)) throw new Error("path must be root-relative");
  const parts = path2.replace(/\\/g, "/").split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || /[:]/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || /[. ]$/.test(p))) throw new Error("unsafe path");
  return `${root.replace(/[\\/]+$/, "")}/${parts.join("/")}`;
}
function edited(content, expected, old, replacement) {
  if (content !== expected) throw new Error("stale content");
  if (!old || content.indexOf(old) < 0 || content.indexOf(old) !== content.lastIndexOf(old)) throw new Error("edit requires one unique match");
  return content.replace(old, () => replacement);
}
function globPattern(pattern) {
  if (pattern.length > 256) throw new Error("glob too long");
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        out += "(?:.*/)?";
      } else out += ".*";
    } else if (pattern[i] === "*") out += "[^/]*";
    else if (pattern[i] === "?") out += "[^/]";
    else out += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}

// rotterdom/src/adapters.ts
function request(endpoint, profile, turns, key, remainingTokens) {
  if (!/^https?:\/\/[^\s?#]+$/.test(endpoint.baseUrl) || /\/\/[^/]*@/.test(endpoint.baseUrl)) throw new Error("invalid endpoint URL");
  const tools = openAiTools(offeredTools(profile));
  return {
    url: `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    method: "POST",
    headers: { "content-type": "application/json", ...key ? { authorization: `Bearer ${key}` } : {} },
    body: JSON.stringify({
      ...profile.params,
      model: profile.model,
      stream: false,
      max_tokens: Math.min(4096, remainingTokens),
      messages: [{ role: "system", content: profile.systemPrompt }, ...pairToolCalls(turns).map(openAiMessage)],
      ...tools.length ? { tools, tool_choice: "auto" } : {}
    }),
    timeoutMs: profile.budgets.deadlineMs
  };
}
function response(raw) {
  const data = JSON.parse(raw);
  if (data.error) throw new Error(String(data.error.message || "endpoint error"));
  const message = data.choices?.[0]?.message;
  if (!message || message.content != null && typeof message.content !== "string") throw new Error("invalid assistant response");
  const calls = message.tool_calls;
  if (calls !== void 0 && (!Array.isArray(calls) || calls.length > 16)) throw new Error("invalid tool calls");
  const ids = /* @__PURE__ */ new Set();
  const toolCalls = (calls || []).map((c) => {
    if (typeof c.id !== "string" || !c.id || ids.has(c.id) || c.type !== "function" || typeof c.function?.name !== "string" || typeof c.function?.arguments !== "string") throw new Error("invalid tool call");
    ids.add(c.id);
    return { id: c.id, name: c.function.name, arguments: c.function.arguments };
  });
  const tokens = data.usage?.total_tokens;
  if (!Number.isInteger(tokens) || tokens < 0) throw new Error("endpoint must report token usage for the token budget");
  return { turn: { role: "assistant", content: message.content || "", ...toolCalls.length ? { toolCalls } : {} }, tokens };
}

// rotterdom/src/history.ts
function claim(history, id, signature) {
  const old = history.ledger[id];
  if (old) {
    if (old.signature !== signature) return JSON.stringify({ error: "call id reused with different arguments" });
    return old.state === "completed" ? old.result : JSON.stringify({ error: "call outcome unconfirmed; never replayed" });
  }
  history.ledger[id] = { signature, state: "claimed" };
  return null;
}
function complete(history, id, result2) {
  history.ledger[id] = { ...history.ledger[id], state: "completed", result: result2 };
}
function recover(history) {
  const answered = new Set(history.turns.filter((t) => t.role === "tool").map((t) => t.toolCallId));
  for (const turn of [...history.turns]) for (const call of turn.toolCalls || []) {
    if (answered.has(call.id)) continue;
    const result2 = history.ledger[call.id];
    history.turns.push({
      role: "tool",
      toolCallId: call.id,
      content: result2?.state === "completed" ? result2.result : JSON.stringify({ error: "call outcome unconfirmed; never replayed" })
    });
    answered.add(call.id);
  }
}
function path(id) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("invalid session id");
  const dir = host.fs.expandHome("~/.codeterm/rotterdom");
  if (!dir || !host.makeDirs(dir)) throw new Error("history directory unavailable");
  return `${dir}/session-${id}.json`;
}
function save(history) {
  if (!host.writeFileAtomic(path(history.id), JSON.stringify(history))) throw new Error("history persistence failed; execution stopped");
}
function load(id) {
  const raw = host.readFile(path(id));
  if (raw === null) return null;
  const h = JSON.parse(raw);
  if (h.version !== 1 || h.id !== id || !Array.isArray(h.turns) || !h.ledger || !h.profile) throw new Error("invalid persisted history");
  recover(h);
  return h;
}

// rotterdom/src/runtime.ts
var MAX_FILE = 128 * 1024;
function confinedPath(profile, name, writing = false) {
  const root = host.canonicalPath(profile.root);
  if (!root) throw new Error("root unavailable or denied by host");
  const path2 = relativePath(root, name);
  const windows = host.platform() === "windows";
  const parts = path2.slice(root.length + 1).split("/");
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current += `/${parts[i]}`;
    const canonical = host.canonicalPath(current);
    if (!canonical) {
      if (writing && i === parts.length - 1 && !host.fileExists(current)) return current;
      throw new Error("path unavailable or denied by host");
    }
    if (!inside(root, canonical, windows) || host.isSymlink(current) !== false) throw new Error("symlink or root escape refused");
  }
  return current;
}
function read(path2) {
  const content = host.readFileHead(path2, MAX_FILE + 1);
  if (content === null) throw new Error("read unavailable or denied by host");
  if (content.length > MAX_FILE || unescape(encodeURIComponent(content)).length > MAX_FILE) throw new Error("file exceeds read limit");
  return content;
}
function execute(profile, name, raw, deadline) {
  if (!permitted(profile, name)) throw new Error(`tool refused: ${name}`);
  const a = checkToolArgs(name, raw);
  if (name === "shell") {
    if (!a.command || a.command.length > 32768) throw new Error("invalid shell command");
    const root = host.canonicalPath(profile.root);
    if (!root) throw new Error("root unavailable or denied by host");
    const windows = host.platform() === "windows";
    const cmd = windows ? `Set-Location -LiteralPath ${host.shell.quoteFor(root, "windows")}; if (!$?) { exit 1 }; ${a.command}` : `cd ${host.shell.quoteFor(root, host.platform())} && ${a.command}`;
    const result2 = host.exec.start({
      bin: windows ? "powershell" : "sh",
      args: windows ? ["-NoProfile", "-NonInteractive", "-Command", cmd] : ["-c", cmd],
      timeoutMs: Math.max(1, Math.min(12e4, deadline - host.unixNowMs()))
    });
    if (!result2.jobId) throw new Error(result2.error || "shell start failed");
    return { jobId: result2.jobId };
  }
  if (name === "read_file") return { content: read(confinedPath(profile, a.path)) };
  if (name === "write_file" || name === "edit_file") {
    const path2 = confinedPath(profile, a.path, name === "write_file");
    const lock = host.lockFile(path2);
    if (!lock) throw new Error("file lock unavailable or denied by host");
    try {
      const content = host.fileExists(path2) ? read(path2) : "";
      if (content !== a.expected) throw new Error("stale content");
      const next = name === "edit_file" ? edited(content, a.expected, a.old, a.new) : a.content;
      if (unescape(encodeURIComponent(next)).length > MAX_FILE) throw new Error("write exceeds limit");
      if (!host.writeFileAtomic(path2, next)) throw new Error("write failed or denied by host");
      return { path: a.path, written: true };
    } finally {
      host.unlockFile(lock);
    }
  }
  if (name === "glob" || name === "search") {
    const pattern = globPattern(a.pattern || "**/*");
    const root = host.canonicalPath(profile.root);
    if (!root) throw new Error("root unavailable or denied by host");
    const files = [];
    const queue = [{ path: root, depth: 0 }];
    let visited = 0;
    while (queue.length) {
      const dir = queue.shift();
      for (const entry of host.fs.readDir(dir.path).sort((a2, b) => a2.path.localeCompare(b.path))) {
        if (++visited > 2e3) throw new Error("search exceeds entry budget");
        const rel = entry.path.replace(/\\/g, "/").slice(root.replace(/\\/g, "/").length + 1);
        try {
          confinedPath(profile, rel);
        } catch {
          continue;
        }
        if (entry.isDir && dir.depth < 8) queue.push({ path: entry.path, depth: dir.depth + 1 });
        if (entry.isFile && pattern.test(rel)) files.push(rel);
      }
    }
    if (name === "glob") return { files: files.sort().slice(0, 200), truncated: files.length > 200 };
    if (!a.text || a.text.length > 4096) throw new Error("invalid search text");
    const matches = [];
    for (const file of files.sort()) {
      let content;
      try {
        content = read(confinedPath(profile, file));
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) if (lines[i].includes(a.text)) {
        matches.push({ path: file, line: i + 1, text: lines[i].slice(0, 500) });
        if (matches.length >= 200) return { matches, truncated: true };
      }
    }
    return { matches, truncated: false };
  }
  throw new Error(`unknown tool: ${name}`);
}

// rotterdom/src/transcript.ts
function transcriptTurns(rows, skipUser) {
  const turns = [];
  let reply = null;
  for (const m of rows) {
    if (m.type === "user") {
      if (skipUser(m.content)) continue;
      turns.push({ role: "user", content: m.content });
      reply = null;
    } else if (m.type === "assistant") {
      const turn = { role: "assistant", content: m.content };
      turns.push(turn);
      reply = { id: m.id, turn };
    } else if (m.type === "tool_call" && typeof m.callId === "string" && typeof m.toolName === "string") {
      const call = { id: m.callId, name: m.toolName, arguments: typeof m.toolArgs === "string" ? m.toolArgs : "{}" };
      const replyId = typeof m.replyId === "string" ? m.replyId : "";
      if (!reply || reply.id !== replyId) {
        const turn = { role: "assistant", content: "" };
        turns.push(turn);
        reply = { id: replyId, turn };
      }
      reply.turn.toolCalls = [...reply.turn.toolCalls || [], call];
    } else if (m.type === "tool_result") {
      if (typeof m.callId === "string") turns.push({ role: "tool", content: m.content, toolCallId: m.callId });
      else {
        turns.push({ role: "user", content: `tool_result:
${m.content}` });
        reply = null;
      }
    }
  }
  return turns;
}

// rotterdom/src/harness.ts
var sessions = /* @__PURE__ */ new Map();
function row(s, type, content, extra = {}) {
  s.rows.push({ id: `${s.history.id}-${s.rows.length}`, type, content, ...extra });
}
function restoredRows(s) {
  for (const turn of s.history.turns) {
    row(s, turn.role === "tool" ? "tool_result" : turn.role, turn.content, { callId: turn.toolCallId });
    const replyId = s.rows[s.rows.length - 1].id;
    for (const c of turn.toolCalls || []) row(s, "tool_call", c.arguments, { callId: c.id, toolName: c.name, toolArgs: c.arguments, replyId });
  }
}
function session(id) {
  const s = sessions.get(id);
  if (!s) throw new Error("session is not open");
  return s;
}
function open(id, profile, endpoint, resume = false) {
  if (sessions.has(id)) throw new Error("session already open");
  const old = resume ? load(id) : null;
  if (resume && !old) throw new Error("persisted session not found");
  const history = old || { version: 1, id, profile, turns: [], ledger: {}, run: 0 };
  if (old && (old.profile.id !== profile.id || old.profile.root !== profile.root)) throw new Error("resume profile or root changed");
  history.profile = profile;
  const s = { history, rows: [], endpoint, deadline: 0, tokens: 0, rounds: 0, done: true, calls: [] };
  restoredRows(s);
  save(history);
  sessions.set(id, s);
  return id;
}
function cancel(s) {
  if (s.request) host.fetch.streamClose(s.request.job);
  if (s.execution) host.exec.close(s.execution.job);
  s.request = void 0;
  s.execution = void 0;
  s.calls = [];
}
function stop(s, reason) {
  cancel(s);
  recover(s.history);
  row(s, "assistant", reason);
  s.done = true;
  save(s.history);
}
function startRequest(s) {
  if (host.unixNowMs() >= s.deadline) throw new Error("deadline budget exhausted");
  if (++s.rounds > s.history.profile.budgets.turns) throw new Error("turn budget exhausted");
  const remaining = s.history.profile.budgets.tokens - s.tokens;
  if (remaining <= 0) throw new Error("token budget exhausted");
  const key = s.endpoint.secret ? host.secretGet(s.endpoint.secret) : null;
  if (s.endpoint.secret && !key) throw new Error("endpoint secret unavailable");
  const opts = request(s.endpoint, s.history.profile, s.history.turns, key, remaining);
  opts.timeoutMs = Math.max(1, Math.min(opts.timeoutMs, s.deadline - host.unixNowMs()));
  const job = host.fetch.stream(opts);
  if (!job.jobId) throw new Error(job.error || "request start failed");
  s.request = { job: job.jobId, body: "" };
}
function send(id, text) {
  const s = session(id);
  if (!s.done) throw new Error("session is busy");
  if (!text || text.length > 32768) throw new Error("invalid message size");
  if (s.history.turns.length > 1e3) throw new Error("history limit reached; open a new session");
  s.history.run++;
  s.history.turns.push({ role: "user", content: text });
  row(s, "user", text);
  s.deadline = host.unixNowMs() + s.history.profile.budgets.deadlineMs;
  s.rounds = 0;
  s.tokens = 0;
  s.done = false;
  save(s.history);
  try {
    startRequest(s);
  } catch (e) {
    stop(s, String(e));
  }
}
function result(s, call, value) {
  const raw = JSON.stringify(value).slice(0, 32768);
  complete(s.history, call.id, raw);
  s.history.turns.push({ role: "tool", toolCallId: call.id, content: raw });
  row(s, "tool_result", raw, { callId: call.id });
  save(s.history);
}
function pump(id) {
  const s = session(id);
  if (s.done) return;
  try {
    if (host.unixNowMs() >= s.deadline) throw new Error("deadline budget exhausted");
    if (s.request) {
      const current = s.request;
      const poll2 = host.fetch.streamPoll(current.job);
      current.body += (poll2.chunks || []).join("");
      if (current.body.length > 2 * 1024 * 1024) throw new Error("response exceeds limit");
      if (!poll2.done) return;
      host.fetch.streamClose(current.job);
      s.request = void 0;
      if (poll2.error || !poll2.status || poll2.status < 200 || poll2.status >= 300) throw new Error(poll2.error || `endpoint HTTP ${poll2.status || "unknown"}`);
      const { turn, tokens } = response(current.body);
      s.tokens += tokens;
      if (s.tokens > s.history.profile.budgets.tokens) throw new Error("token budget exhausted");
      s.history.turns.push(turn);
      row(s, "assistant", turn.content);
      const replyId = s.rows[s.rows.length - 1].id;
      s.calls = [...turn.toolCalls || []];
      for (const call2 of s.calls) row(s, "tool_call", call2.arguments, { callId: call2.id, toolName: call2.name, toolArgs: call2.arguments, replyId });
      save(s.history);
      if (!s.calls.length) {
        s.done = true;
        return;
      }
    }
    if (s.execution) {
      const pending = s.execution;
      const polled = host.exec.poll(pending.job);
      if (!polled.done) return;
      host.exec.close(pending.job);
      s.execution = void 0;
      result(s, pending.call, polled);
    }
    const call = s.calls.shift();
    if (call) {
      const previous = claim(s.history, call.id, `${call.name}:${call.arguments}`);
      if (previous !== null) {
        s.history.turns.push({ role: "tool", toolCallId: call.id, content: previous });
        row(s, "tool_result", previous, { callId: call.id });
        save(s.history);
      } else {
        save(s.history);
        let value;
        try {
          value = execute(s.history.profile, call.name, JSON.parse(call.arguments), s.deadline);
        } catch (e) {
          value = { error: String(e) };
        }
        if (value && typeof value === "object" && "jobId" in value) s.execution = { job: String(value.jobId), call };
        else result(s, call, value);
      }
      return;
    }
    if (!s.execution) startRequest(s);
  } catch (e) {
    stop(s, String(e));
  }
}
function poll(id, cursor) {
  const s = session(id);
  const index = cursor == null ? 0 : Number(cursor);
  if (!Number.isInteger(index) || index < 0 || index > s.rows.length) throw new Error("invalid cursor");
  return { messages: s.rows.slice(index), cursor: String(s.rows.length), done: s.done };
}
function close(id) {
  const s = session(id);
  if (!s.done) stop(s, "Turn cancelled; uncertain calls will not replay.");
  sessions.delete(id);
}
function historyTurns(id) {
  return transcriptTurns(session(id).rows, () => false);
}

// rotterdom/src/config.ts
function settings() {
  const value = JSON.parse(host.settingsJson() || "{}");
  if (!Array.isArray(value.endpoints) || !Array.isArray(value.profiles)) throw new Error("configure endpoints and profiles first");
  for (const group of [value.endpoints, value.profiles]) {
    const ids = /* @__PURE__ */ new Set();
    for (const item of group) {
      if (!item || typeof item.id !== "string" || !/^[a-z0-9_-]+$/.test(item.id) || ids.has(item.id)) throw new Error("invalid or duplicate config id");
      ids.add(item.id);
    }
  }
  return value;
}
function resolve(id, model, systemPrompt) {
  const s = settings();
  const p = s.profiles.find((p2) => p2.id === (id || s.defaultProfile));
  if (!p) throw new Error("unknown profile");
  const profile = {
    ...p,
    model: model || p.model,
    systemPrompt: systemPrompt === void 0 ? p.systemPrompt : systemPrompt
  };
  const endpoint = s.endpoints.find((e) => e.id === p.endpoint);
  if (!endpoint || typeof endpoint.baseUrl !== "string" || !Array.isArray(endpoint.models)) throw new Error("unknown or invalid endpoint");
  if (!profile.model || typeof profile.systemPrompt !== "string" || typeof profile.root !== "string" || !/^(\/|[A-Za-z]:[\\/])/.test(profile.root) || !Array.isArray(profile.allow) || !Array.isArray(profile.deny)) throw new Error("invalid profile");
  for (const [key, ceiling] of [["tokens", 1e6], ["turns", 100], ["deadlineMs", 36e5]]) {
    const budget = profile.budgets?.[key];
    if (!Number.isInteger(budget) || budget <= 0 || budget > ceiling) throw new Error(`invalid ${key} budget`);
  }
  return { profile, endpoint };
}

// rotterdom/src/plugin.ts
var plugin_default = {
  __test: { permitted, offeredTools, relativePath, inside, edited, globPattern, request, response, claim, complete, recover, finishToolCalls, mergeToolParts, historyTurns },
  profileOpen(id, profile, resume = false) {
    const selected = resolve(profile);
    return { sessionId: open(id, selected.profile, selected.endpoint, resume) };
  },
  profileSend: send,
  profilePump: pump,
  profilePoll: poll,
  profileClose: close
};
