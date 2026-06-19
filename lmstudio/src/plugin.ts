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
  reasoningId: string;
  content: string;
  reasoning: string;
  buffer: string;
  responseId: string | null;
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
  // Tool calls parsed from the finished assistant message, processed one at a
  // time across pumps (an async exec blocks the queue until its result lands).
  pendingTools: ToolParseEntry[] | null;
  // The async exec currently in flight (host.exec.start jobId), if any.
  pendingExec: PendingExec | null;
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

interface PendingExec {
  call: ToolCall;
  jobId: string;
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
// The 6 curated tools — the only names we will ever execute. A native or fenced
// call to anything else is rejected (executeTool's default surfaces an error).
const CURATED_TOOLS = ["exec", "read_file", "write_file", "codeterm", "mem_search", "spawn_agent"];
// gemma-style native tool calls: a wrapper token (<|tool_call>, <tool_call|>,
// <|tool_call|>) plus a `call:NAME{args}` payload. We strip the wrapper tokens
// for display and parse the call:NAME{...} shape (args may be loose JS-object
// syntax: unquoted keys, single quotes).
const NATIVE_WRAPPER_RE = /<\s*\|?\s*(?:tool_call|tool▁call)\s*\|?\s*>/gi;
// The call header may be namespaced — gemma emits `call:exec`, `call:default_api:exec`,
// even `call:foo:bar:write_file`. Capture the whole colon-separated chain; the real
// tool name is its LAST segment (resolved + validated in collectNativeMatches).
const NATIVE_CALL_RE =
  /call\s*[:=]\s*((?:[A-Za-z_][A-Za-z0-9_]*\s*:\s*)*[A-Za-z_][A-Za-z0-9_]*)\s*(\{[\s\S]*?\})/g;
// Native arg aliases mapped to our curated arg names (gemma emits `command`).
const NATIVE_ARG_ALIASES: Record<string, Record<string, string>> = {
  exec: { command: "cmd" },
  codeterm: { command: "args", cmd: "args" },
};

// System prompts are not a valid ChatMessageKind — they ride on a type:'user'
// message wrapped in this CodeTerm marker (twin of chat-core's markSystemPrompt
// / buildMarker("system_prompt", [], body)). chatPrefixes detects the marker and
// renders the collapsible 'System prompt' card.
const SYSTEM_PROMPT_MARKER = "-=-codeterm:system_prompt-=-";
function markSystemPrompt(body: string): string {
  return SYSTEM_PROMPT_MARKER + body;
}

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

// UPSERT by id: a streaming assistant/reasoning message keeps a single stable
// id and grows across chunks. If an entry with that id already exists, replace
// its content in place; otherwise push. This makes per-chunk duplicates
// structurally impossible while keeping poll(sid, cursor) returning clean deltas.
function append(s: Session, type: string, content: string, id?: string): NormalizedChatMessage {
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

// Native /api/v1/chat requires a valid loaded model id; model:'' returns 404.
// Resolve the empty case by probing the model catalog and taking the first
// loaded instance's `key` (falling back to any listed model's `key`).
function resolveModelId(): string {
  const res = fetchJson({ url: `${baseUrl()}/api/v1/models`, method: "GET" });
  if (res.error || (res.status && res.status >= 400)) return "";
  const data = parseJson<{ models?: { key?: unknown; loaded_instances?: unknown[] }[] }>(res.body || "{}", {});
  const rows = Array.isArray(data.models) ? data.models : [];
  const loaded = rows.find(
    (r) => r && typeof r.key === "string" && Array.isArray(r.loaded_instances) && r.loaded_instances.length > 0,
  );
  if (loaded && typeof loaded.key === "string") return loaded.key;
  const first = rows.find((r) => r && typeof r.key === "string");
  return first && typeof first.key === "string" ? first.key : "";
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

// Build the `sh -lc` exec opts for an exec/codeterm tool call, or an error
// result if required args are missing. The command runs async (host.exec.start)
// so a multi-second tool exec never holds the shared VM lock.
function execShellCmd(call: ToolCall): { shellCmd?: string; error?: string } {
  if (call.tool === "exec") {
    const cmd = typeof call.args.cmd === "string" ? call.args.cmd : "";
    const cwd = typeof call.args.cwd === "string" ? call.args.cwd : undefined;
    if (!cmd) return { error: "exec requires args.cmd" };
    return { shellCmd: cwd && cwd.trim() ? `cd ${shellQuote(cwd)} && ${cmd}` : cmd };
  }
  const args = typeof call.args.args === "string" ? call.args.args : "";
  if (!args) return { error: "codeterm requires args.args" };
  return { shellCmd: `codeterm ${args}` };
}

interface ExecStartResult {
  jobId?: string;
  error?: string;
}

interface ExecPoll {
  done?: boolean;
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

function startExecJob(shellCmd: string): ExecStartResult {
  return parseJson<ExecStartResult>(
    host.execStart(JSON.stringify({ bin: "sh", args: ["-lc", shellCmd], timeoutMs: 120000 })),
    { error: "host.exec.start returned non-JSON" },
  );
}

function pollExecJob(jobId: string): ExecPoll {
  return parseJson<ExecPoll>(host.execPoll(jobId), { done: true, error: "host.exec.poll returned non-JSON" });
}

// Shape the terminal poll into the same `{code, stdout, stderr}` (+ optional
// error) object the old blocking exec returned, so tool_result rendering is
// byte-for-byte identical from the user's view.
function execResultFromPoll(poll: ExecPoll): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof poll.code === "number") result.code = poll.code;
  if (typeof poll.stdout === "string") result.stdout = poll.stdout;
  if (typeof poll.stderr === "string") result.stderr = poll.stderr;
  if (typeof poll.error === "string") result.error = poll.error;
  return result;
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

interface ToolMatch {
  start: number;
  end: number;
  entry: ToolParseEntry;
}

interface ParsedTools {
  entries: ToolParseEntry[];
  cleaned: string;
}

function collectFenceMatches(text: string): ToolMatch[] {
  const matches: ToolMatch[] = [];
  TOOL_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_FENCE_RE.exec(text)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length, entry: parseToolJson(match[1]) });
  }
  return matches;
}

// The trailing contiguous fence group: starting from the last fence, include any
// immediately preceding fences separated from it only by whitespace. Trailing
// prose AFTER the last fence is now allowed (relaxed from the old strictly-
// trailing guard) — gemma frequently appends a sentence after a real tool call.
// A fence separated from the trailing group by prose is treated as illustrative
// and not executed.
function trailingFenceGroup(text: string, matches: ToolMatch[]): ToolMatch[] {
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

// Parse a brace-delimited args object, tolerating loose JS-object syntax that
// native models emit (bare keys, single quotes) by coercing to JSON.
function parseLooseObject(raw: string): Record<string, unknown> | null {
  const attempt = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(raw);
  if (direct) return direct;
  const coerced = raw
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3')
    .replace(/'/g, '"');
  return attempt(coerced);
}

function applyArgAliases(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const aliases = NATIVE_ARG_ALIASES[tool];
  if (!aliases) return args;
  const out: Record<string, unknown> = { ...args };
  for (const from of Object.keys(aliases)) {
    const to = aliases[from];
    if (out[to] === undefined && out[from] !== undefined) out[to] = out[from];
  }
  return out;
}

// Recognize native model tool-call wrappers — at minimum gemma's
// `<|tool_call>call:NAME{args}<tool_call|>`. We only ever map to the curated
// tool set; unknown native names surface a clear error via executeTool.
function collectNativeMatches(text: string): ToolMatch[] {
  const matches: ToolMatch[] = [];
  NATIVE_CALL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NATIVE_CALL_RE.exec(text)) !== null) {
    // The tool name is the last colon-delimited segment of the header
    // (call:exec → exec; call:default_api:exec → exec; call:a:b:write_file → write_file).
    const tool = match[1].split(":").pop()!.trim();
    // Only the 6 curated tools ever execute. An unknown native name (any namespace)
    // is ignored entirely — no match, so the raw text simply stays in the bubble.
    if (!CURATED_TOOLS.includes(tool)) continue;
    let start = match.index;
    let end = match.index + match[0].length;
    // Swallow adjacent wrapper tokens so stripping leaves no `<|tool_call>` residue.
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

// Remove the given (executed) spans from the displayed text and tidy whitespace,
// so the user sees clean prose + the tool card instead of the raw call syntax.
function stripSpans(text: string, spans: { start: number; end: number }[]): string {
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

// Unified tool-call extraction. Prefer our fenced format (trailing contiguous
// group). If no fenced call is present, fall back to native model wrappers. A
// trailing, well-formed tool call ALWAYS executes — even if it happens to match
// the system-prompt example: the trailing-only / last-contiguous-group logic
// already excludes mid-explanation echoes, and a genuine trailing call (e.g. the
// 'codeterm pane list' that "list my panes" elicits) IS the user's intent.
function parseToolEntries(text: string): ParsedTools {
  const fenceTools = trailingFenceGroup(text, collectFenceMatches(text));
  if (fenceTools.length) {
    return { entries: fenceTools.map((m) => m.entry), cleaned: stripSpans(text, fenceTools) };
  }
  const nativeTools = collectNativeMatches(text);
  if (nativeTools.length) {
    return { entries: nativeTools.map((m) => m.entry), cleaned: stripSpans(text, nativeTools) };
  }
  return { entries: [], cleaned: text };
}

// Sync tools only. exec/codeterm are dispatched separately via the async
// host.exec.start/poll path (see advanceTools) so they never block the VM.
function executeTool(call: ToolCall): unknown {
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

// Native streaming is SSE: `event: <name>` + `data: {json}` blocks separated by
// blank lines. The answer is the message.* deltas; reasoning.* is the model's
// private thinking (surfaced separately, never mixed into the answer); chat.end
// carries the response_id used for previous_response_id continuation.
function consumeSseEvent(stream: StreamState, segment: string): void {
  if (!segment) return;
  let dataStr = "";
  for (const line of segment.split(/\r?\n/)) {
    if (line.indexOf("data:") !== 0) continue;
    let value = line.slice(5);
    if (value.charAt(0) === " ") value = value.slice(1);
    dataStr += value;
  }
  if (!dataStr) return;
  const data = parseJson<{ type?: unknown; content?: unknown; result?: { response_id?: unknown } } | null>(
    dataStr,
    null,
  );
  if (!data || typeof data !== "object") return;
  const type = typeof data.type === "string" ? data.type : "";
  if (type.indexOf("message.") === 0 && typeof data.content === "string") {
    stream.content += data.content;
  } else if (type.indexOf("reasoning.") === 0 && typeof data.content === "string") {
    stream.reasoning += data.content;
  } else if (type === "chat.end") {
    const rid = data.result && (data.result as { response_id?: unknown }).response_id;
    if (typeof rid === "string") stream.responseId = rid;
  }
}

// Drain complete SSE events from the buffer. Events are terminated by a blank
// line; an incomplete trailing event (a `data:` JSON split across chunk
// boundaries) is retained until the next chunk completes it. On `flush` the
// remaining buffer is treated as a final, possibly unterminated, event.
function parseSse(stream: StreamState, flush: boolean): void {
  const segments = stream.buffer.split(/\r?\n\r?\n/);
  // When not flushing, the final segment may be a partial event — keep it.
  stream.buffer = flush ? "" : segments.pop() ?? "";
  for (const seg of segments) consumeSseEvent(stream, seg);
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
      // The seeded system-prompt marker rides on a user message but is already
      // conveyed via body.system_prompt — don't duplicate it into the context.
      if (m.type === "user" && m.content.indexOf(SYSTEM_PROMPT_MARKER) === 0) continue;
      prior.push({ id: m.id, line: `${m.type}: ${m.content}` });
    }
  }
  return prior.map((m) => m.line).join("\n\n");
}

function startLmStudioCall(s: Session, input: string): void {
  if (!s.model) {
    const resolved = resolveModelId();
    if (!resolved) {
      append(s, "system", "LM Studio error: no model configured and none could be auto-resolved from /api/v1/models.");
      s.done = true;
      return;
    }
    s.model = resolved;
  }

  const needsFallbackContext =
    !s.previousResponseId && s.messages.some((m) => m.type === "assistant" || m.type === "tool_result");
  const body: Record<string, unknown> = {
    model: s.model,
    system_prompt: s.systemPrompt,
    input: needsFallbackContext ? assembledContext(s) : input,
    stream: true,
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
  s.stream = {
    jobId: started.jobId,
    messageId: nextId(s, "lmstudio-assistant"),
    reasoningId: nextId(s, "lmstudio-reasoning"),
    content: "",
    reasoning: "",
    buffer: "",
    responseId: null,
  };
  s.done = false;
}

function startNextIfIdle(s: Session): void {
  if (!s.stream && s.pendingInputs.length) {
    startLmStudioCall(s, s.pendingInputs.shift() || "");
  }
}

function finishAssistantMessage(
  s: Session,
  content: string,
  responseId: string | null,
  messageId: string,
): void {
  if (responseId) s.previousResponseId = responseId;

  const { entries, cleaned } = parseToolEntries(content);
  if (!entries.length) {
    s.done = true;
    return;
  }
  // Strip the executed tool-call syntax from the displayed assistant bubble so
  // the user sees clean prose + the tool card, not the raw fence/native wrapper.
  // A fence-only reply strips down to '' — drop that entry entirely rather than
  // leave a blank assistant bubble in the transcript.
  if (cleaned !== content) {
    if (cleaned.trim() === "") {
      const idx = s.messages.findIndex((m) => m.id === messageId);
      if (idx >= 0) s.messages.splice(idx, 1);
    } else {
      append(s, "assistant", cleaned, messageId);
    }
  }

  // Queue the calls; advanceTools runs them in order. An exec/codeterm call
  // starts an async job and parks the queue until drainExec sees it finish.
  s.pendingTools = entries.slice();
  advanceTools(s);
}

function emitToolResult(s: Session, call: ToolCall, result: unknown): void {
  const formatted = formatToolResult(call, result);
  append(s, "tool_result", formatted);
  s.pendingInputs.push(`tool_result:\n${formatted}`);
}

// Walk the pending tool queue. Sync tools run inline; exec/codeterm start an
// async job (host.exec.start) and return immediately, parking the queue on
// s.pendingExec until drainExec resumes it. The VM lock is therefore held only
// for the sub-ms start, never the command's full duration.
function advanceTools(s: Session): void {
  if (s.pendingExec) return;
  while (s.pendingTools && s.pendingTools.length) {
    const entry = s.pendingTools.shift() as ToolParseEntry;
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
      const started = startExecJob(shell.shellCmd as string);
      if (started.jobId) {
        s.pendingExec = { call, jobId: started.jobId };
        return; // park until drainExec sees the job finish
      }
      emitToolResult(s, call, { error: started.error || "host.exec.start failed" });
      continue;
    }
    emitToolResult(s, call, executeTool(call));
  }
  s.pendingTools = null;
}

// Poll the in-flight async exec(s). Non-blocking: a not-done poll returns and we
// retry on the next pump. On completion, emit the tool_result and let
// advanceTools resume the queue (which may start the next exec).
function drainExec(s: Session): void {
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
    stream.buffer += chunks.join("");
    parseSse(stream, false);
  }
  if (poll.done) parseSse(stream, true);

  // Surface reasoning as its own growing 'thinking' entry (a valid
  // ChatMessageKind rendered as a collapsed thinking block); never fold it into
  // the answer. The answer rides on type:'assistant'.
  if (stream.reasoning) append(s, "thinking", stream.reasoning, stream.reasoningId);
  if (stream.content) append(s, "assistant", stream.content, stream.messageId);

  if (poll.done) {
    host.fetchStreamClose(stream.jobId);
    s.stream = null;
    finishAssistantMessage(s, stream.content, stream.responseId, stream.messageId);
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
    pendingTools: null,
    pendingExec: null,
  };
}

const plugin: ChatBackend = {
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
    // While a stream is live, its assistant/thinking entries grow in place (see
    // append upsert). Pin the cursor at the lowest live entry's index so the
    // next poll re-reads the grown content instead of slicing past it.
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
      done: s.done && !s.stream && !s.pendingExec && s.pendingInputs.length === 0,
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
    // Native shape is { models: [{ key, display_name }] }; tolerate the
    // OpenAI-compatible { data: [{ id }] } shape as a fallback.
    const data = parseJson<{
      models?: { key?: unknown; display_name?: unknown }[];
      data?: { id?: unknown }[];
    }>(res.body || "{}", {});
    const models: Model[] = [];
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

  listPresets(): PresetInfo[] {
    return presets().map((p) => ({ id: p.id, name: p.name, description: p.description }));
  },
};

export default plugin;
