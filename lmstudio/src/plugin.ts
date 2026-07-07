// LM Studio plugin — open agent shell (capability: chatBackend).
//
// The shell talks to LM Studio's native /api/v1/chat endpoint, streams via the
// host fetch-stream bridge, and runs the CodeTerm text-tool protocol itself.
import type {
  ChatBackend,
  ChatBackendOpenSessionCtx,
  ContextEngineConfig,
  ChatSessionInfo,
  FetchResult,
  Model,
  NormalizedChatMessage,
  PresetInfo,
  SessionMode,
  WatcherTickInput,
} from "@codeterm/plugin-sdk";
import { assembleChat, assembleMachine, type EngineMessage } from "@codeterm/chat-engine";
import watcherOrchestrationCharter from "../prompts/watcher-orchestration.md";

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
  charters?: Record<string, string>;
}

const CHARTER_REF_PREFIX = "charter:";

/** Shipped watcher charters (prompts/*.md bundled at build). */
const SHIPPED_CHARTERS: Record<string, string> = {
  "watcher-orchestration": watcherOrchestrationCharter.replace(/\s+$/, ""),
};

function resolveCharterRef(ref: string): { charter: string; error?: string } {
  if (!ref.startsWith(CHARTER_REF_PREFIX)) return { charter: ref };
  const id = ref.slice(CHARTER_REF_PREFIX.length).trim();
  if (!id) return { charter: "", error: "charter reference is missing an id" };
  const shipped = SHIPPED_CHARTERS[id];
  if (shipped) return { charter: shipped };
  const settings = readSettings();
  const raw = settings.charters;
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw[id] : undefined;
  if (typeof body === "string" && body.trim() && !body.trim().endsWith(".md")) {
    return { charter: body.trim() };
  }
  return { charter: "", error: `unknown charter id: ${id}` };
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
  mode: SessionMode;
  engine: ContextEngineConfig | null;
  charter: string;
  machineState: unknown;
  currentRun: "interactive" | "watcher";
  watcherTicks: number;
  watcherVerdictEmitted: boolean;
  watcherLastAssistant: string;
  model: string;
  params: Record<string, unknown>;
  previousResponseId: string | null;
  pendingInputs: string[];
  stream: StreamState | null;
  done: boolean;
  toolRounds: number;
  capReached: boolean;
  // How many times this turn the model emitted a tool-call-shaped block that the
  // host parser flagged `malformed`; each one injects a corrective retry note.
  // Capped at MAX_MALFORMED_RETRIES so a model that never recovers can't loop.
  malformedRetries: number;
  // Tool calls parsed from the finished assistant message, processed one at a
  // time across pumps (an async exec blocks the queue until its result lands).
  pendingTools: ToolParseEntry[] | null;
  // The async exec currently in flight (host.exec.start jobId), if any.
  pendingExec: PendingExec | null;
  // An in-flight prompt-authoring hand-off (R6): an agent pane is drafting a
  // tuned system prompt; drainAuthor polls its ticket across pumps and writes
  // the reply back via applyAuthoredPrompt. Null when no hand-off is active.
  pendingAuthor: PendingAuthor | null;
  charterError?: string;
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

interface PendingAuthor {
  ticket: string;
  agentSessionId: string;
  // The model the draft is being authored for, captured at hand-off time so a
  // mid-flight setModel can't misfile the result under the wrong model.
  model: string;
}

interface ParsedToolCall {
  status?: unknown;
  tool?: unknown;
  args?: unknown;
  span?: unknown;
  reason?: unknown;
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
const PROMPT_AUTHOR_WORKSPACE = "lmstudio-prompt-authoring";
const MAX_TOOL_ROUNDS = 8;
const MAX_MALFORMED_RETRIES = 2;
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

// Persist a draft as the authored prompt for `model` AND apply it to the live
// session so the change is visible immediately and on the model's next init.
// The single write path shared by authorSystemPrompt (direct) and drainAuthor
// (agent round-trip).
function applyAuthoredPrompt(s: Session, model: string, draft: string): void {
  if (!model) return;
  writeAuthoredPrompt(model, draft);
  s.systemPrompt = draft;
}

// The hand-off message an author agent receives: the target model + the current
// prompt + the user's optional tuning instruction. Small local models prefer
// short, concrete, example-led prompts, so we steer the author that way.
function buildAuthoringRequest(model: string, currentPrompt: string, instruction?: string): string {
  const ask = instruction && instruction.trim() ? `\n\nUser's tuning request: ${instruction.trim()}` : "";
  return (
    `You are tuning the system prompt for a local LM Studio chat model "${model}". ` +
    `Rewrite and improve the prompt below so it works well for that model — small local models ` +
    `learn best from short, concrete, example-led prompts. Preserve its intent and any tool-use rules. ` +
    `Reply with ONLY the new system prompt text: no preamble, no commentary, no code fences.` +
    ask +
    `\n\n--- CURRENT SYSTEM PROMPT ---\n${currentPrompt}`
  );
}

// An author agent may wrap its reply in a single code fence despite the
// instruction; unwrap a lone fenced block so the stored prompt is clean.
function stripPromptFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n?```$/);
  return (fenced ? fenced[1] : trimmed).trim();
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

// Mirrors the host's tri-state contract: "ok" carries entries to execute,
// "none" is a normal assistant message, "malformed" is a tool-call-shaped block
// that failed parse+repair and must be retried (never silently dropped).
type ParseStatus = "ok" | "none" | "malformed";

interface ParsedTools {
  entries: ToolParseEntry[];
  cleaned: string;
  status: ParseStatus;
  reason?: string;
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
// tri-state JSON string: {status:"ok",tool,args,span} for a validated call,
// {status:"none"} for plain prose, or {status:"malformed",reason} for a
// tool-call-shaped block that survived neither parse nor repair (-> retry, not
// drop). A parser throw is degraded to "none" so a single bad call never crashes
// the turn.
function parseToolEntries(text: string): ParsedTools {
  let raw = "";
  try {
    raw = host.toolcall.parse(text, TOOL_SCHEMA_JSON);
  } catch (e) {
    host.log("warn", `host.toolcall.parse failed: ${String(e)}`);
    return { entries: [], cleaned: text, status: "none" };
  }
  // Tolerate the legacy "null"/non-JSON shapes by degrading to "none".
  const parsed = parseJson<ParsedToolCall | null>(raw, null);
  if (!parsed || typeof parsed !== "object") return { entries: [], cleaned: text, status: "none" };

  if (parsed.status === "malformed") {
    const reason = typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "unparseable tool call";
    return { entries: [], cleaned: text, status: "malformed", reason };
  }
  if (parsed.status !== "ok" || typeof parsed.tool !== "string") {
    return { entries: [], cleaned: text, status: "none" };
  }
  const args = parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
    ? (parsed.args as Record<string, unknown>)
    : {};
  const span = parsedSpan(parsed, text);
  const cleaned = span ? stripSpans(text, [expandToolSpan(text, span)]) : text;
  return {
    entries: [{ call: { tool: parsed.tool, args } }],
    cleaned,
    status: "ok",
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

function messagesAsEngineHistory(s: Session): EngineMessage[] {
  const history: EngineMessage[] = [];
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

function requestInputFromMessages(messages: EngineMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
}

function startLmStudioCall(s: Session, input: string, opts?: { messages?: EngineMessage[]; watcher?: boolean }): void {
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
  let requestInput: unknown = input;
  if (opts?.messages) {
    requestInput = requestInputFromMessages(opts.messages);
  } else if (s.engine && s.engine.kind === "chat" && s.engine.window?.maxMessages !== undefined) {
    requestInput = requestInputFromMessages(assembleChat(messagesAsEngineHistory(s), s.engine.window));
  } else if (needsFallbackContext) {
    requestInput = assembledContext(s);
  }
  const body: Record<string, unknown> = {
    model: s.model,
    system_prompt: s.systemPrompt,
    input: requestInput,
    stream: true,
    ...s.params,
  };
  if (!opts?.messages && s.previousResponseId) body.previous_response_id = s.previousResponseId;

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
  s.currentRun = opts?.watcher || s.mode === "watcher" ? "watcher" : "interactive";
  s.done = false;
}

function startNextIfIdle(s: Session): void {
  if (!s.stream && s.pendingInputs.length) {
    const next = s.pendingInputs.shift() || "";
    const queued = parseJson<{ watcherMessages?: EngineMessage[]; machineMessages?: EngineMessage[] } | null>(next, null);
    if (queued && Array.isArray(queued.watcherMessages)) {
      startLmStudioCall(s, "", { messages: queued.watcherMessages, watcher: true });
    } else if (queued && Array.isArray(queued.machineMessages)) {
      startLmStudioCall(s, "", { messages: queued.machineMessages });
    } else {
      startLmStudioCall(s, next);
    }
  }
}

function finishAssistantMessage(
  s: Session,
  content: string,
  responseId: string | null,
  messageId: string,
): void {
  if (s.currentRun === "watcher") {
    finishLoopAssistantMessage(s, content, responseId, messageId);
    return;
  }

  if (responseId && !(s.engine && s.engine.kind === "machine")) s.previousResponseId = responseId;
  finishLoopAssistantMessage(s, content, responseId, messageId);
}

function finishLoopAssistantMessage(
  s: Session,
  content: string,
  responseId: string | null,
  messageId: string,
): void {
  if (s.currentRun === "watcher") {
    s.watcherLastAssistant = content;
    if (responseId) s.previousResponseId = responseId;
  }
  const { entries, cleaned, status, reason } = parseToolEntries(content);
  // A tool-call-shaped block that failed parse+repair: don't drop it silently
  // (the live Gemma bug — the model never learns and the reply never arrives).
  // Feed back a corrective note so the model resends a valid call, capping the
  // retries so a model that never recovers can't loop forever.
  if (status === "malformed") {
    if (s.malformedRetries < MAX_MALFORMED_RETRIES) {
      s.malformedRetries += 1;
      s.pendingInputs.push(
        `tool_result:\nERROR: your codeterm-tool JSON was invalid (${reason || "unparseable tool call"}). ` +
          "Resend a single valid JSON tool call, or answer in plain text if no tool is needed.",
      );
      // Leave s.done false: startNextIfIdle will start the retry continuation.
      return;
    }
    if (s.currentRun === "watcher") {
      append(s, "system", `Could not parse a valid tool call after ${MAX_MALFORMED_RETRIES} retries; ending this watcher tick.`);
      completeWatcherTick(s, content);
    } else {
      append(
        s,
        "system",
        `Could not parse a valid tool call after ${MAX_MALFORMED_RETRIES} retries; treating the reply as a normal message.`,
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

function watcherFallbackVerdict(): string {
  // No "state" key: the host keeps the previous state when a verdict omits it,
  // so a capped tick never wipes the machine's memory.
  return JSON.stringify({
    status: "attention",
    summary: "tool loop ended without a verdict",
    actions: [],
  });
}

function completeWatcherTick(s: Session, verdict: string | null): void {
  if (!s.watcherVerdictEmitted) {
    const text = verdict && verdict.trim() ? verdict : watcherFallbackVerdict();
    append(s, "watcher_verdict", text);
    s.watcherVerdictEmitted = true;
  }
  s.done = true;
}

function extractVerdictState(text: string, prior: unknown): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const raw = fenced ? fenced[1] : trimmed;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "state")) {
      return (parsed as { state?: unknown }).state;
    }
  } catch {
    // Keep prior state when the model returns prose or malformed JSON.
  }
  return prior;
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

// Poll the in-flight prompt-authoring hand-off (R6). Non-blocking: a not-done
// poll returns and we retry next pump. On completion we reap the author agent
// and write its drafted prompt back via the shared applyAuthoredPrompt path
// (so the model's next init picks it up); an error/empty reply is surfaced as a
// system message and changes nothing.
function drainAuthor(s: Session): void {
  if (!s.pendingAuthor) return;
  const pending = s.pendingAuthor;
  let poll: { done?: boolean; reply?: string; error?: string };
  try {
    poll = host.agent.poll(pending.ticket);
  } catch (e) {
    s.pendingAuthor = null;
    try {
      host.agent.reap(pending.agentSessionId);
    } catch {
      // Reaping is best-effort cleanup.
    }
    append(s, "system", `Prompt authoring failed: ${String(e)}`);
    s.done = true;
    return;
  }
  if (!poll || !poll.done) return; // still drafting — retry next pump
  s.pendingAuthor = null;
  try {
    host.agent.reap(pending.agentSessionId);
  } catch {
    // Reaping is best-effort cleanup.
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
  const mode: SessionMode = ctx.mode === "watcher" ? "watcher" : "interactive";
  const engine = ctx.engine && typeof ctx.engine === "object" ? ctx.engine : null;
  let charter = "";
  let charterError: string | undefined;
  if (engine && engine.kind === "machine") {
    const resolved = resolveCharterRef(engine.charter);
    charter = resolved.charter;
    charterError = resolved.error;
  }
  // A watcher spawned bare (no engine/charter) runs the shipped orchestration
  // health charter — the out-of-the-box "attach a watcher to my orchestrator".
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
    charterError,
  };
}

interface AuthoringResult {
  ok: boolean;
  error?: string;
}

const plugin: ChatBackend & {
  describeModelSwitch: (sessionId: string, targetModel: string) => ModelSwitchDescription;
  authorSystemPrompt: (sessionId: string, draft: string) => void;
  requestPromptAuthoring: (sessionId: string, instruction?: string) => AuthoringResult;
} = {
  openSession(ctx) {
    const sid = ctx.paneId;
    const s = resolveSession(ctx);
    if (s.charterError) {
      host.log("error", `openSession failed for ${sid}: ${s.charterError}`);
      return { error: s.charterError } as unknown as { sessionId: string };
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
    const tickInput = input as WatcherTickInput;
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
      done: s.done && !s.stream && !s.pendingExec && !s.pendingAuthor && s.pendingInputs.length === 0,
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
    applyAuthoredPrompt(s, s.model, draft);
  },

  // R6: hand the "tune this pane's system prompt for model X" task off to a
  // separate agent pane. Plugin-mediated end to end: we read THIS session's
  // model + current prompt, spawn an author agent (host.workspace/agent), send
  // it the request, and park `pendingAuthor`. pump → drainAuthor polls the
  // ticket across turns and writes the reply back via applyAuthoredPrompt, so
  // the user iteratively improves the per-model prompt without editing JSON.
  requestPromptAuthoring(sid: string, instruction?: string): AuthoringResult {
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
      task: `Help tune the system prompt for the local LM Studio model "${s.model}".`,
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
        // Reaping is best-effort cleanup.
      }
      append(s, "system", "Prompt authoring failed: could not send the request to the author agent.");
      return { ok: false, error: "send failed" };
    }

    s.pendingAuthor = { ticket, agentSessionId, model: s.model };
    s.done = false;
    append(s, "system", `Handing off system-prompt authoring for ${s.model} to an agent…`);
    return { ok: true };
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
