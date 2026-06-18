// LM Studio plugin — open agent shell (capability: chatBackend).
//
// The shell talks to LM Studio's native /api/v1/chat endpoint, streams via the
// host fetch-stream bridge, and runs the CodeTerm text-tool protocol itself.
import type {
  ChatBackend,
  ChatBackendOpenSessionCtx,
  FetchResult,
  Model,
  NormalizedChatMessage,
  PresetInfo,
} from "@codeterm/plugin-sdk";

interface Preset {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  model?: string;
  params?: Record<string, unknown>;
}

interface LmStudioSettings {
  baseUrl?: string;
  model?: string;
  defaultPreset?: string;
  presets?: Preset[];
  params?: Record<string, unknown>;
}

interface StreamState {
  jobId: string;
  messageId: string;
  content: string;
}

interface Session {
  messages: NormalizedChatMessage[];
  seq: number;
  systemPrompt: string;
  model: string;
  params: Record<string, unknown>;
  previousResponseId: string | null;
  pendingInputs: string[];
  stream: StreamState | null;
  done: boolean;
  toolRounds: number;
  capReached: boolean;
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

interface ToolParseEntry {
  call?: ToolCall;
  error?: string;
  raw: string;
}

interface StreamPoll {
  chunks?: string[];
  done?: boolean;
  status?: number;
  error?: string;
  body?: string;
}

const DEFAULT_BASE_URL = "http://localhost:1234";
const MAX_TOOL_ROUNDS = 8;
const TOOL_FENCE_RE = /```codeterm-tool\s*\n([\s\S]*?)\n?```/g;

const sessions = new Map<string, Session>();

function readSettings(): LmStudioSettings {
  try {
    const raw = JSON.parse(host.settingsJson() || "{}") as LmStudioSettings;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function baseUrl(): string {
  const s = readSettings();
  const url = s.baseUrl && s.baseUrl.trim() ? s.baseUrl.trim() : DEFAULT_BASE_URL;
  return url.replace(/\/+$/, "");
}

function presets(): Preset[] {
  const s = readSettings();
  if (!Array.isArray(s.presets)) return [];
  return s.presets.filter(
    (p): p is Preset =>
      !!p &&
      typeof p.id === "string" &&
      typeof p.name === "string" &&
      typeof p.systemPrompt === "string",
  );
}

function resolvePreset(id?: string): Preset | null {
  const all = presets();
  if (!all.length) return null;
  const s = readSettings();
  const wanted = id || s.defaultPreset || all[0].id;
  return all.find((p) => p.id === wanted) || all[0];
}

function nextId(s: Session, prefix = "lmstudio"): string {
  const id = `${prefix}-${s.seq}`;
  s.seq += 1;
  return id;
}

function append(s: Session, type: string, content: string, id?: string): NormalizedChatMessage {
  const msg = { id: id || nextId(s), type, content };
  s.messages.push(msg);
  return msg;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function fetchJson(opts: {
  url: string;
  method: string;
  body?: string;
}): FetchResult {
  const raw = host.fetch(
    JSON.stringify({
      url: opts.url,
      method: opts.method,
      headers: { "content-type": "application/json" },
      body: opts.body,
      timeoutMs: 120000,
    }),
  );
  return parseJson<FetchResult>(raw, { error: "fetch returned non-JSON" });
}

function startFetchStream(opts: {
  url: string;
  method: string;
  body: string;
}): { jobId?: string; error?: string } {
  return parseJson<{ jobId?: string; error?: string }>(
    host.fetchStream(
      JSON.stringify({
        url: opts.url,
        method: opts.method,
        headers: { "content-type": "application/json" },
        body: opts.body,
        timeoutMs: 120000,
      }),
    ),
    { error: "fetchStream returned non-JSON" },
  );
}

function pollFetchStream(jobId: string): StreamPoll {
  return parseJson<StreamPoll>(host.fetchStreamPoll(jobId), {
    chunks: [],
    done: true,
    error: "fetchStreamPoll returned non-JSON",
  });
}

function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function execShell(cmd: string, cwd?: string): unknown {
  const shellCmd = cwd && cwd.trim() ? `cd ${shellQuote(cwd)} && ${cmd}` : cmd;
  return parseJson<unknown>(
    host.exec(JSON.stringify({ bin: "sh", args: ["-lc", shellCmd], timeoutMs: 120000 })),
    { error: "host.exec returned non-JSON" },
  );
}

function formatToolResult(call: ToolCall, result: unknown): string {
  return JSON.stringify({ tool: call.tool, args: call.args, result }, null, 2);
}

function parseToolJson(raw: string): ToolParseEntry {
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { raw, error: "tool JSON must be an object" };
    }
    const obj = parsed as { tool?: unknown; args?: unknown };
    if (typeof obj.tool !== "string") {
      return { raw, error: "tool JSON requires string field `tool`" };
    }
    const args = obj.args && typeof obj.args === "object" ? (obj.args as Record<string, unknown>) : {};
    return { raw, call: { tool: obj.tool, args } };
  } catch (e) {
    return { raw, error: `tool JSON parse error: ${String(e)}` };
  }
}

function parseTrailingToolEntries(text: string): ToolParseEntry[] {
  const matches: { start: number; end: number; body: string }[] = [];
  TOOL_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
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

function executeTool(call: ToolCall): unknown {
  switch (call.tool) {
    case "exec": {
      const cmd = typeof call.args.cmd === "string" ? call.args.cmd : "";
      const cwd = typeof call.args.cwd === "string" ? call.args.cwd : undefined;
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
      const maybeHost = host as unknown as {
        mem?: { search?: (opts: { query: string; k?: number }) => unknown } | ((optsJson: string) => string);
      };
      if (typeof maybeHost.mem === "function") {
        return parseJson<unknown>(maybeHost.mem(JSON.stringify({ query })), { error: "host.mem returned non-JSON" });
      }
      return maybeHost.mem && maybeHost.mem.search ? maybeHost.mem.search({ query, k: 5 }) : { error: "host.mem.search unavailable" };
    }
    case "spawn_agent": {
      const provider = typeof call.args.provider === "string" ? call.args.provider : "";
      const task = typeof call.args.task === "string" ? call.args.task : "";
      const workspace = typeof call.args.workspace === "string" ? call.args.workspace : "default";
      if (!provider || !task) return { error: "spawn_agent requires args.provider and args.task" };
      const maybeHost = host as unknown as {
        agent?: { spawn?: (...args: unknown[]) => unknown };
        worker?: { start?: (...args: unknown[]) => unknown };
      };
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

function extractResponseId(poll: StreamPoll, content: string): string | null {
  const sources = [poll.body, content];
  for (const source of sources) {
    if (!source || source.trim()[0] !== "{") continue;
    const data = parseJson<{ response_id?: unknown }>(source, {});
    if (typeof data.response_id === "string") return data.response_id;
  }
  return null;
}

function assembledContext(s: Session): string {
  const prior: { id: string; line: string }[] = [];
  const assistantIndex: Record<string, number> = {};
  for (const m of s.messages) {
    if (m.type === "assistant") {
      if (assistantIndex[m.id] === undefined) {
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

function startLmStudioCall(s: Session, input: string): void {
  const needsFallbackContext =
    !s.previousResponseId && s.messages.some((m) => m.type === "assistant" || m.type === "tool_result");
  const body: Record<string, unknown> = {
    model: s.model,
    system_prompt: s.systemPrompt,
    input: needsFallbackContext ? assembledContext(s) : input,
    ...s.params,
  };
  if (s.previousResponseId) body.previous_response_id = s.previousResponseId;

  const started = startFetchStream({
    url: `${baseUrl()}/api/v1/chat`,
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!started.jobId) {
    append(s, "system", `LM Studio stream error: ${started.error || "missing jobId"}`);
    s.done = true;
    return;
  }
  s.stream = { jobId: started.jobId, messageId: nextId(s, "lmstudio-assistant"), content: "" };
  s.done = false;
}

function startNextIfIdle(s: Session): void {
  if (!s.stream && s.pendingInputs.length) {
    startLmStudioCall(s, s.pendingInputs.shift() || "");
  }
}

function finishAssistantMessage(s: Session, content: string, poll: StreamPoll): void {
  const responseId = extractResponseId(poll, content);
  if (responseId) s.previousResponseId = responseId;

  const entries = parseTrailingToolEntries(content);
  if (!entries.length) {
    s.done = true;
    return;
  }

  for (const entry of entries) {
    if (entry.error || !entry.call) {
      const formatted = JSON.stringify(
        { tool: "parse_error", error: entry.error || "invalid tool call", raw: entry.raw },
        null,
        2,
      );
      append(s, "tool_result", formatted);
      s.pendingInputs.push(`tool_result:\n${formatted}`);
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
    s.pendingInputs.push(`tool_result:\n${formatted}`);
  }
  startNextIfIdle(s);
}

function pollStream(s: Session): void {
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

function resolveSession(ctx: ChatBackendOpenSessionCtx): Session {
  const s = readSettings();
  const preset = resolvePreset(ctx.preset);
  const systemPrompt = ctx.systemPrompt || (preset && preset.systemPrompt) || "";
  const model = ctx.model || (preset && preset.model) || s.model || "";
  const params = { ...(s.params || {}), ...((preset && preset.params) || {}) };
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
  };
}

const plugin: ChatBackend = {
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
      done: s.done && !s.stream && s.pendingInputs.length === 0,
    };
  },

  closeSession(sid) {
    const s = sessions.get(sid);
    if (s && s.stream) host.fetchStreamClose(s.stream.jobId);
    sessions.delete(sid);
  },

  listModels(): Model[] {
    const res = fetchJson({ url: `${baseUrl()}/api/v1/models`, method: "GET" });
    if (res.error || (res.status && res.status >= 400)) return [];
    const data = parseJson<{ data?: { id?: unknown }[] }>(res.body || "{}", {});
    const rows = data.data || [];
    const models: Model[] = [];
    for (const r of rows) {
      if (r && typeof r.id === "string") models.push({ id: r.id, displayName: r.id });
    }
    return models;
  },

  listPresets(): PresetInfo[] {
    return presets().map((p) => ({ id: p.id, name: p.name, description: p.description }));
  },
};

export default plugin;
