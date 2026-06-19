// LM Studio plugin — open agent shell (capability: chatBackend).
//
// The shell talks to LM Studio's native /api/v1/chat endpoint, streams via the
// host fetch-stream bridge, and runs the CodeTerm text-tool protocol itself.
import type {
  ChatBackend,
  ChatBackendOpenSessionCtx,
  ChatSessionInfo,
  FetchResult,
  Model,
  NormalizedChatMessage,
  PresetInfo,
} from "@codeterm/plugin-sdk";

interface Preset {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
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

interface LastModelState {
  lastModel?: unknown;
}

interface ModelSwitchDescription {
  needsConfirm: boolean;
  message: string;
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
  toolId?: string;
}

interface ToolParseEntry {
  call: ToolCall;
}

interface ParsedToolCall {
  tool?: unknown;
  args?: unknown;
  span?: unknown;
}

interface StreamPoll {
  chunks?: string[];
  done?: boolean;
  status?: number;
  error?: string;
  body?: string;
}

const DEFAULT_BASE_URL = "http://localhost:1234";
const LAST_MODEL_PATH = ".codeterm/plugins/lmstudio/last-model.json";
const AUTHORED_PROMPTS_PATH = ".codeterm/plugins/lmstudio/authored-prompts.json";
const MAX_TOOL_ROUNDS = 8;
const TOOL_SCHEMA_JSON = JSON.stringify({
  tools: [
    { name: "exec", args: ["cmd"], optional: ["cwd"] },
    { name: "read_file", args: ["path"], optional: [] },
    { name: "write_file", args: ["path", "content"], optional: [] },
    { name: "codeterm", args: ["args"], optional: [] },
    { name: "mem_search", args: ["query"], optional: [] },
    { name: "spawn_agent", args: ["provider", "task"], optional: ["workspace"] },
  ],
  aliases: { command: "cmd", file: "path", filepath: "path" },
});
const FENCE_RE = /```[^\r\n`]*\r?\n[\s\S]*?```/g;
const TOOL_WRAPPER_RE = /<\s*\|?\/?\s*(?:tool_call|tool▁call)\s*\|?\s*>/gi;

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

function cleanModel(model?: unknown): string {
  return typeof model === "string" ? model.trim() : "";
}

function lastModelFilePath(): string | null {
  try {
    const home = typeof host.homeDir === "function" ? host.homeDir() : null;
    if (!home) return null;
    return `${home.replace(/\/+$/, "")}/${LAST_MODEL_PATH}`;
  } catch {
    return null;
  }
}

function readLastModel(): string {
  try {
    const path = lastModelFilePath();
    if (!path) return "";
    const raw = host.readFile(path);
    if (!raw) return "";
    const state = JSON.parse(raw) as LastModelState;
    return cleanModel(state && state.lastModel);
  } catch {
    return "";
  }
}

function rememberLastModel(model: string): void {
  const lastModel = cleanModel(model);
  if (!lastModel) return;
  try {
    const path = lastModelFilePath();
    if (!path) return;
    const slash = path.lastIndexOf("/");
    if (slash > 0 && typeof host.makeDirs === "function") host.makeDirs(path.slice(0, slash));
    host.writeFile(path, JSON.stringify({ lastModel }));
  } catch {
    // Best-effort persistence must never break chat.
  }
}

function authoredPromptsFilePath(): string | null {
  try {
    const home = typeof host.homeDir === "function" ? host.homeDir() : null;
    if (!home) return null;
    return `${home.replace(/\/+$/, "")}/${AUTHORED_PROMPTS_PATH}`;
  } catch {
    return null;
  }
}

function readAuthoredPrompts(): Record<string, string> {
  try {
    const path = authoredPromptsFilePath();
    if (!path) return {};
    const raw = host.readFile(path);
    if (!raw) return {};
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data as Record<string, string>;
  } catch {
    return {};
  }
}

function writeAuthoredPrompt(model: string, draft: string): void {
  try {
    const path = authoredPromptsFilePath();
    if (!path) return;
    const current = readAuthoredPrompts();
    current[model] = draft;
    const slash = path.lastIndexOf("/");
    if (slash > 0 && typeof host.makeDirs === "function") host.makeDirs(path.slice(0, slash));
    host.writeFile(path, JSON.stringify(current));
  } catch {
    // Best-effort persistence must never break chat.
  }
}

function describeSwitchMessage(targetModel: string): string {
  return `Switching to ${targetModel} will unload the current one (VRAM). Continue?`;
}

export function describeModelSwitch(sessionId: string, targetModel: string): ModelSwitchDescription {
  const target = cleanModel(targetModel);
  if (!target) return { needsConfirm: false, message: "" };
  const s = sessions.get(sessionId);
  const active = cleanModel(s && s.model);
  if (!s || active === target) return { needsConfirm: false, message: "" };
  return { needsConfirm: true, message: describeSwitchMessage(target) };
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
      (p.systemPrompt === undefined || typeof p.systemPrompt === "string"),
  );
}

function presetById(all: Preset[], id?: string): Preset | null {
  if (!id) return null;
  return all.find((p) => p.id === id) || null;
}

function defaultPreset(all: Preset[]): Preset | null {
  if (!all.length) return null;
  const s = readSettings();
  return presetById(all, s.defaultPreset) || all[0];
}

function presetBoundToModel(all: Preset[], modelId: string): Preset | null {
  if (!modelId) return null;
  return all.find((p) => typeof p.model === "string" && p.model.trim() === modelId) || null;
}

function resolvePreset(id?: string, modelId?: string): Preset | null {
  const all = presets();
  if (!all.length) return null;
  return presetBoundToModel(all, modelId || "") || presetById(all, id) || defaultPreset(all);
}

function defaultSystemPrompt(all: Preset[]): string {
  const p = defaultPreset(all);
  return p && typeof p.systemPrompt === "string" ? p.systemPrompt : "";
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
function append(
  s: Session,
  type: string,
  content: string,
  id?: string,
  extras?: Record<string, unknown>,
): NormalizedChatMessage {
  const msgId = id || nextId(s);
  const existing = s.messages.find((m) => m.id === msgId);
  if (existing) {
    existing.content = content;
    if (extras) Object.assign(existing as unknown as Record<string, unknown>, extras);
    return existing;
  }
  const msg = { id: msgId, type, content, ...(extras || {}) } as NormalizedChatMessage;
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

function errorTextFromBody(raw?: string): string {
  if (!raw) return "";
  const parsed = parseJson<unknown>(raw, null);
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const error = obj.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const nested = error as Record<string, unknown>;
      if (typeof nested.message === "string") return nested.message;
      if (typeof nested.error === "string") return nested.error;
    }
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.detail === "string") return obj.detail;
  }
  return raw;
}

function isVramLoadFailure(text: string): boolean {
  return /(vram|insufficient|not enough|out of memory|failed to load|could not load|couldn't load)/i.test(text);
}

function vramLoadFailureMessage(model: string): string {
  return `couldn't load ${model}: not enough VRAM — unload a model in LM Studio or pick a smaller one`;
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

interface ParsedTools {
  entries: ToolParseEntry[];
  cleaned: string;
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

function expandToolSpan(text: string, span: { start: number; end: number }): { start: number; end: number } {
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (span.start >= start && span.end <= end) return { start, end };
  }

  let start = span.start;
  let end = span.end;
  const before = text.slice(0, start);
  TOOL_WRAPPER_RE.lastIndex = 0;
  let wrapper: RegExpExecArray | null;
  let lastBefore: RegExpExecArray | null = null;
  while ((wrapper = TOOL_WRAPPER_RE.exec(before)) !== null) lastBefore = wrapper;
  if (lastBefore && before.slice(lastBefore.index + lastBefore[0].length).trim() === "") start = lastBefore.index;

  const after = text.slice(end);
  const afterWrapper = after.match(/^\s*<\s*\|?\/?\s*(?:tool_call|tool▁call)\s*\|?\s*>/i);
  if (afterWrapper) end += afterWrapper[0].length;
  return { start, end };
}

function parsedSpan(parsed: ParsedToolCall, text: string): { start: number; end: number } | null {
  if (!Array.isArray(parsed.span) || parsed.span.length !== 2) return null;
  const start = typeof parsed.span[0] === "number" ? parsed.span[0] : -1;
  const end = typeof parsed.span[1] === "number" ? parsed.span[1] : -1;
  if (start < 0 || end < start || end > text.length) return null;
  return { start, end };
}

// Delegate extraction/repair/validation to the host's Rust parser. It returns a
// single validated call or "null"; invalid or unknown tool syntax is normal text.
function parseToolEntries(text: string): ParsedTools {
  let raw = "null";
  try {
    raw = host.toolcall.parse(text, TOOL_SCHEMA_JSON);
  } catch (e) {
    host.log("warn", `host.toolcall.parse failed: ${String(e)}`);
    return { entries: [], cleaned: text };
  }
  if (raw === "null") return { entries: [], cleaned: text };
  const parsed = parseJson<ParsedToolCall | null>(raw, null);
  if (!parsed || typeof parsed.tool !== "string") return { entries: [], cleaned: text };
  const args = parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
    ? (parsed.args as Record<string, unknown>)
    : {};
  const span = parsedSpan(parsed, text);
  const cleaned = span ? stripSpans(text, [expandToolSpan(text, span)]) : text;
  return {
    entries: [{ call: { tool: parsed.tool, args } }],
    cleaned,
  };
}

function toolContent(call: ToolCall): string {
  if (call.tool === "exec" && typeof call.args.cmd === "string") return call.args.cmd;
  if (call.tool === "codeterm" && typeof call.args.args === "string") return `codeterm ${call.args.args}`;
  return JSON.stringify(call.args);
}

function emitToolCall(s: Session, call: ToolCall): string {
  const toolId = nextId(s, `lmstudio-tool-${call.tool}`);
  const toolArgs = JSON.stringify(call.args);
  append(s, "tool_call", toolContent(call), toolId, {
    toolName: call.tool,
    toolInput: call.args,
    toolArgs,
    toolId,
    collapsed: true,
    provider: "lmstudio",
  });
  return toolId;
}

function emitToolResult(s: Session, call: ToolCall, result: unknown, toolId?: string): void {
  const formatted = formatToolResult(call, result);
  append(s, "tool_result", formatted, undefined, {
    toolId,
    toolResult: formatted,
    collapsed: true,
    provider: "lmstudio",
  });
  s.pendingInputs.push(`tool_result:\n${formatted}`);
}

function promptVariantForModel(modelId: string, generalPrompt: string): string {
  void modelId;
  return generalPrompt;
}

function systemPromptForModel(generalPrompt: string, modelId: string): string {
  if (!modelId) return generalPrompt;
  return promptVariantForModel(modelId, generalPrompt);
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
    rememberLastModel(resolved);
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

// Walk the pending tool queue. Sync tools run inline; exec/codeterm start an
// async job (host.exec.start) and return immediately, parking the queue on
// s.pendingExec until drainExec resumes it. The VM lock is therefore held only
// for the sub-ms start, never the command's full duration.
function advanceTools(s: Session): void {
  if (s.pendingExec) return;
  while (s.pendingTools && s.pendingTools.length) {
    const entry = s.pendingTools.shift() as ToolParseEntry;
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
      const started = startExecJob(shell.shellCmd as string);
      if (started.jobId) {
        s.pendingExec = { call, jobId: started.jobId, toolId };
        return; // park until drainExec sees the job finish
      }
      emitToolResult(s, call, { error: started.error || "host.exec.start failed" }, toolId);
      continue;
    }
    emitToolResult(s, call, executeTool(call), toolId);
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
    emitToolResult(s, finished.call, execResultFromPoll(poll), finished.toolId);
    advanceTools(s);
  }
}

function pollStream(s: Session): void {
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
      isVramLoadFailure(err) ? vramLoadFailureMessage(s.model) : `LM Studio HTTP ${poll.status}`,
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
  const generalSystemPrompt =
    (boundPreset ? presetSystemPrompt || defaultSystemPrompt(allPresets) : ctx.systemPrompt || presetSystemPrompt) ||
    defaultSystemPrompt(allPresets) ||
    "";
  const authoredPrompts = readAuthoredPrompts();
  const systemPrompt = (model && authoredPrompts[model]) || systemPromptForModel(generalSystemPrompt, model);
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

const plugin: ChatBackend & {
  describeModelSwitch: (sessionId: string, targetModel: string) => ModelSwitchDescription;
  authorSystemPrompt: (sessionId: string, draft: string) => void;
} = {
  openSession(ctx) {
    const sid = ctx.paneId;
    const s = resolveSession(ctx);
    if (s.systemPrompt) append(s, "user", markSystemPrompt(s.systemPrompt), "system-prompt");
    sessions.set(sid, s);
    rememberLastModel(s.model);
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

  sessionInfo(sid): ChatSessionInfo & { systemPrompt?: string } {
    const s = sessions.get(sid);
    return { model: s ? s.model : undefined, systemPrompt: s ? s.systemPrompt : undefined };
  },

  describeModelSwitch,

  authorSystemPrompt(sid: string, draft: string): void {
    const s = sessions.get(sid);
    if (!s || !s.model) return;
    writeAuthoredPrompt(s.model, draft);
    s.systemPrompt = draft;
  },

  setModel(sid, model) {
    const s = sessions.get(sid);
    if (!s || typeof model !== "string" || !model) return;
    if (s.model === model) return;
    s.model = model;
    rememberLastModel(model);
    // The previous_response_id chains to the OLD model's server-side state; a
    // different model can't continue it. Reset so the next turn re-seeds context
    // (assembledContext) under the new model instead of 400-ing on a stale id.
    s.previousResponseId = null;
  },
};

export default plugin;
