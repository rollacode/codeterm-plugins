// LM Studio plugin — open agent shell and decisionModel capabilities.
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
import decisionModel from "./decision";
import { createToolRuntime, type ToolCall, type PendingExec, type ToolParseEntry } from "./tools";
import watcherOrchestrationCharter from "../prompts/watcher-orchestration.md";
import {
  applyAnthropicEvent,
  applyOpenAiEvent,
  applyWholeBody,
  authHeaders,
  chatRequest,
  emptyDelta,
  formatUsage,
  mergeUsage,
  redact,
  splitSse,
} from "./router/adapters";
import { apiRoot, LMSTUDIO_PROVIDER_ID } from "./router/config";
import { capabilityBadges } from "./router/models";
import { presetModelId, presetParams, qualifyModel, reroute, resolveModelTarget, type RouteRequest } from "./router/routing";
import { discoverModels, getKey, resetModelCache, snapshot } from "./router/store";
import { runAgentVerb } from "./router/verbs";
import { viewCall } from "./router/view";
import { applyNativeEvent } from "./router/lmstudioNative";
import { readDataFile, writeDataFile } from "./router/datafiles";
import { forgetSession, savedSession, saveSession, type SavedSession } from "./router/sessionstore";
import { parseTextToolCalls } from "./router/textcalls";
import { checkToolArgs } from "./router/toolspec";
import { finishToolCalls, mergeToolParts } from "./router/toolwire";
import { transcriptTurns } from "./router/transcript";
import { DOMIOS_CONTEXT, withDomiosContext } from "./router/context";
import { activityLine, activityOf } from "./router/activity";
import type { ChatTurn, NativeToolCall, ProviderConfig, StreamDelta, ToolPart, Usage } from "./router/types";
import { engineContext } from "./router/context";
import { shellFlag } from "./router/config";
import { cachedModels } from "./router/store";
import { instanceBinDir, toolShell } from "./router/instanceCli";
import { buildEngineConfig, compactionSettings, configFingerprint, engineKeyEnv, ocModelRef, type EngineProvider } from "./engine/config";
import { closeStream, engineAbort, engineBusy, engineStep, newEngineSession, type EngineSession, type EngineTab } from "./engine/driver";
import { engineError, engineVersionNote, ensureEngine, resetEngineForTests, retryEngine, setWanted } from "./engine/server";
import { splitModelId } from "./router/routing";

interface Preset {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  params?: Record<string, unknown>;
  root?: string;
  shell?: boolean;
}

interface LmStudioSettings {
  engine?: string;
  root?: string;
  shell?: unknown;
  compactThreshold?: unknown;
  compactModel?: unknown;
  compactKeepTurns?: unknown;
  showUsage?: boolean;
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
  kind: ProviderConfig["kind"];
  usage: Usage | null;
  error: string | null;
  toolParts: ToolPart[];
}

interface Session {
  tabId: string;
  messages: NormalizedChatMessage[];
  seq: number;
  // Scopes message ids to this session object; a session revived after a plugin reload must not reuse ids the host already stored.
  epoch: string;
  // A revived session answers its first poll from 0: the host's cursor belongs to the previous VM.
  cursorReset: boolean;
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
  provider: ProviderConfig | null;
  // What the session asked for; re-resolved against the live registry before every request.
  route: RouteRequest;
  routeError: string | null;
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
  // Formatted results of the current tool round, sent back as one continuation once the round drains.
  roundResults: string[];
  // An in-flight prompt-authoring hand-off (R6): an agent pane is drafting a
  // tuned system prompt; drainAuthor polls its ticket across pumps and writes
  // the reply back via applyAuthoredPrompt. Null when no hand-off is active.
  pendingAuthor: PendingAuthor | null;
  charterError?: string;
  presetId?: string;
  // Set when OpenCode runs this tab's turns; the relay fields above stay idle then.
  es: EngineSession | null;
  rootSetting: string;
  engineNoted: boolean;
}

interface PendingAuthor {
  ticket: string;
  agentSessionId: string;
  // The model the draft is being authored for, captured at hand-off time so a
  // mid-flight setModel can't misfile the result under the wrong model.
  model: string;
}

interface StreamPoll {
  chunks?: string[];
  done?: boolean;
  status?: number;
  error?: string;
  body?: string;
}

const DEFAULT_BASE_URL = "http://localhost:1234";
const LAST_MODEL_FILE = "last-model.json";
const AUTHORED_PROMPTS_FILE = "authored-prompts.json";
const PROMPT_AUTHOR_WORKSPACE = "lmstudio-prompt-authoring";
const MAX_TOOL_ROUNDS = 8;
const MAX_MALFORMED_RETRIES = 2;
// System prompts are not a valid ChatMessageKind — they ride on a type:'user'
// message wrapped in this CodeTerm marker (twin of chat-core's markSystemPrompt
// / buildMarker("system_prompt", [], body)). chatPrefixes detects the marker and
// renders the collapsible 'System prompt' card.
const SYSTEM_PROMPT_MARKER = "-=-codeterm:system_prompt-=-";
function markSystemPrompt(body: string): string {
  return SYSTEM_PROMPT_MARKER + body;
}

const sessions = new Map<string, Session>();
const {
  execShellCmd, startExecJob, pollExecJob, execResultFromPoll,
  formatToolResult, parseToolEntries, toolContent, executeTool,
} = createToolRuntime(host, parseJson);

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

function readLastModel(): string {
  const state = parseJson<LastModelState | null>(readDataFile(LAST_MODEL_FILE) || "", null);
  return cleanModel(state && state.lastModel);
}

function rememberLastModel(model: string): void {
  const lastModel = cleanModel(model);
  if (lastModel) writeDataFile(LAST_MODEL_FILE, JSON.stringify({ lastModel }));
}

function readAuthoredPrompts(): Record<string, string> {
  const data = parseJson<unknown>(readDataFile(AUTHORED_PROMPTS_FILE) || "", null);
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, string>) : {};
}

function writeAuthoredPrompt(model: string, draft: string): void {
  const current = readAuthoredPrompts();
  current[model] = draft;
  writeDataFile(AUTHORED_PROMPTS_FILE, JSON.stringify(current));
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
  const active = s ? sessionModelId(s) : "";
  if (!s || active === target) return { needsConfirm: false, message: "" };
  return { needsConfirm: true, message: describeSwitchMessage(target) };
}

function baseUrl(): string {
  const s = readSettings();
  const url = s.baseUrl && s.baseUrl.trim() ? s.baseUrl.trim() : DEFAULT_BASE_URL;
  return url.replace(/\/+$/, "");
}

function presets(): Preset[] {
  return snapshot().presets.map((p) => {
    const preset: Preset = { id: p.id, name: p.name, model: presetModelId(p), params: presetParams(p) };
    if (p.description) preset.description = p.description;
    if (p.systemPrompt !== undefined) preset.systemPrompt = p.systemPrompt;
    if (p.root) preset.root = p.root;
    if (p.shell !== undefined) preset.shell = p.shell;
    return preset;
  });
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

function sessionEpoch(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function nextId(s: Session, prefix = "lmstudio"): string {
  const id = `${prefix}-${s.epoch}-${s.seq}`;
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
  headers?: Record<string, string>;
}): FetchResult {
  const raw = host.fetch(
    JSON.stringify({
      url: opts.url,
      method: opts.method,
      headers: opts.headers || { "content-type": "application/json" },
      body: opts.body,
      timeoutMs: 120000,
    }),
  );
  return parseJson<FetchResult>(raw, { error: "fetch returned non-JSON" });
}

function lmStudioHeaders(provider: ProviderConfig | null): Record<string, string> {
  return provider ? authHeaders(provider, getKey(provider)) : { "content-type": "application/json" };
}

function lmStudioRoot(provider: ProviderConfig | null): string {
  return provider ? apiRoot(provider) : baseUrl();
}

// Hosted APIs need an explicit model; take the first one the provider lists.
function resolveRemoteModelId(provider: ProviderConfig): string {
  const entry = discoverModels(provider);
  return entry.models.length ? entry.models[0].id : "";
}

// Native /api/v1/chat requires a valid loaded model id; model:'' returns 404.
// Resolve the empty case by probing the model catalog and taking the first
// loaded instance's `key` (falling back to any listed model's `key`).
function resolveModelId(provider: ProviderConfig | null): string {
  if (provider && provider.kind !== "lmstudio") return resolveRemoteModelId(provider);
  const res = fetchJson({ url: `${lmStudioRoot(provider)}/api/v1/models`, method: "GET", headers: lmStudioHeaders(provider) });
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
  headers?: Record<string, string>;
  timeoutMs?: number;
}): { jobId?: string; error?: string } {
  return parseJson<{ jobId?: string; error?: string }>(
    host.fetchStream(
      JSON.stringify({
        url: opts.url,
        method: opts.method,
        headers: opts.headers || { "content-type": "application/json" },
        body: opts.body,
        timeoutMs: opts.timeoutMs || 120000,
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

function emitToolCall(s: Session, entry: ToolParseEntry): string {
  const call = entry.call;
  const toolId = nextId(s, `lmstudio-tool-${call.tool}`);
  const toolArgs = JSON.stringify(call.args);
  const extras: Record<string, unknown> = {
    toolName: call.tool,
    toolInput: call.args,
    toolArgs,
    toolId,
    collapsed: true,
    provider: "lmstudio",
  };
  if (entry.callId) Object.assign(extras, { callId: entry.callId, replyId: entry.replyId || "" });
  append(s, "tool_call", toolContent(call), toolId, extras);
  return toolId;
}

function emitToolResult(s: Session, call: ToolCall, result: unknown, toolId?: string, callId?: string): void {
  const formatted = formatToolResult(call, result);
  const extras: Record<string, unknown> = { toolId, toolResult: formatted, collapsed: true, provider: "lmstudio" };
  if (callId) extras.callId = callId;
  append(s, "tool_result", formatted, undefined, extras);
  s.roundResults.push(formatted);
}

// The host does not reopen live sessions when the plugin VM reloads; revive one from its saved route.
function sessionFor(sid: string): Session | undefined {
  const live = sessions.get(sid);
  if (live) return live;
  const saved = savedSession(sid);
  if (!saved) return undefined;
  const s = resolveSession({ tabId: sid, model: saved.model, preset: saved.preset } as unknown as ChatBackendOpenSessionCtx, saved);
  if (s.charterError) return undefined;
  s.cursorReset = true;
  if (s.es && s.es.ocSessionId) append(s, "system", "Router reloaded: this tab's OpenCode session keeps the conversation.");
  else append(s, "system", "Router reloaded: earlier turns of this tab are no longer in the model's context.");
  sessions.set(sid, s);
  return s;
}

function refreshRoute(s: Session): void {
  const router = snapshot();
  const target = reroute(s.route, { providerId: s.provider ? s.provider.id : null, model: s.model }, router.providers, router.defaultProvider);
  if (!target.provider) {
    s.routeError = target.error || "no enabled provider";
    return;
  }
  if (!s.provider || s.provider.id !== target.provider.id || s.model !== target.model) s.previousResponseId = null;
  s.provider = target.provider;
  s.model = target.model;
  s.routeError = null;
}

function reportedModel(s: Session): string {
  return s.provider ? sessionModelId(s) : s.route.raw;
}

function requestSystem(s: Session): string {
  if (s.mode === "watcher" || (s.engine && s.engine.kind === "machine")) return s.systemPrompt;
  return withDomiosContext(s.systemPrompt);
}

function routesNatively(s: Session): boolean {
  return !!s.provider && s.provider.kind !== "lmstudio" && s.currentRun !== "watcher" && s.mode !== "watcher";
}

// Stateless routes rebuild the whole transcript (results included); LM Studio chains on previous_response_id and needs them as input.
function queueContinuation(s: Session): void {
  const results = s.roundResults;
  s.roundResults = [];
  if (!results.length) return;
  const stateless = !!s.provider && s.provider.kind !== "lmstudio" && s.currentRun !== "watcher";
  s.pendingInputs.push(stateless ? "" : results.map((r) => `tool_result:\n${r}`).join("\n\n"));
}

function promptVariantForModel(modelId: string, generalPrompt: string): string {
  void modelId;
  return generalPrompt;
}

function systemPromptForModel(generalPrompt: string, modelId: string): string {
  if (!modelId) return generalPrompt;
  return promptVariantForModel(modelId, generalPrompt);
}

function consumeRouterEvents(stream: StreamState, flush: boolean): void {
  const { events, rest } = splitSse(stream.buffer, flush);
  stream.buffer = rest;
  const acc: StreamDelta = emptyDelta();
  for (const ev of events) {
    if (stream.kind === "anthropic") applyAnthropicEvent(acc, ev);
    else if (stream.kind === "lmstudio") applyNativeEvent(acc, ev);
    else applyOpenAiEvent(acc, ev);
  }
  stream.content += acc.content;
  stream.reasoning += acc.reasoning;
  if (acc.responseId && !stream.responseId) stream.responseId = acc.responseId;
  if (acc.error) stream.error = acc.error;
  stream.usage = mergeUsage(stream.usage, acc.usage);
  mergeToolParts(stream.toolParts, acc.toolParts);
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

function sessionModelId(s: Session): string {
  return qualifyModel(s.provider ? s.provider.id : LMSTUDIO_PROVIDER_ID, s.model);
}

function providerLabel(s: Session): string {
  return s.provider && s.provider.id !== LMSTUDIO_PROVIDER_ID ? s.provider.name : "LM Studio";
}

// Stateless APIs get the whole visible conversation each turn.
function routerTurns(s: Session, input: string): ChatTurn[] {
  const turns = transcriptTurns(s.messages, (content) => content.indexOf(SYSTEM_PROMPT_MARKER) === 0);
  const last = turns[turns.length - 1];
  if (input && !(last && last.role === "user" && last.content === input)) turns.push({ role: "user", content: input });
  return turns;
}

function engineToRouter(messages: EngineMessage[]): { system: string; turns: ChatTurn[] } {
  const system: string[] = [];
  const turns: ChatTurn[] = [];
  for (const m of messages) {
    if (m.role === "system") system.push(m.content);
    else turns.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  return { system: system.join("\n\n"), turns };
}

function startRouterCall(s: Session, provider: ProviderConfig, input: string, opts?: { messages?: EngineMessage[]; watcher?: boolean }): void {
  let system = requestSystem(s);
  let turns: ChatTurn[];
  if (opts?.messages) {
    const converted = engineToRouter(opts.messages);
    system = converted.system;
    turns = converted.turns;
  } else if (s.engine && s.engine.kind === "chat" && s.engine.window?.maxMessages !== undefined) {
    turns = engineToRouter(assembleChat(messagesAsEngineHistory(s), s.engine.window)).turns;
  } else {
    turns = routerTurns(s, input);
  }
  const key = getKey(provider);
  const tools = !opts?.watcher && s.mode !== "watcher";
  const req = chatRequest(provider, key, { model: s.model, system, turns, params: s.params, tools });
  const started = startFetchStream({ url: req.url, method: req.method, headers: req.headers, body: req.body || "", timeoutMs: req.timeoutMs });
  if (!started.jobId) {
    append(s, "system", `${provider.name} stream error: ${redact(started.error || "missing jobId", key)}`);
    s.done = true;
    return;
  }
  beginStream(s, started.jobId, provider.kind, opts?.watcher);
}

function beginStream(s: Session, jobId: string, kind: ProviderConfig["kind"], watcher?: boolean): void {
  s.stream = {
    jobId,
    messageId: nextId(s, "lmstudio-assistant"),
    reasoningId: nextId(s, "lmstudio-reasoning"),
    content: "",
    reasoning: "",
    buffer: "",
    responseId: null,
    kind,
    usage: null,
    error: null,
    toolParts: [],
  };
  s.currentRun = watcher || s.mode === "watcher" ? "watcher" : "interactive";
  s.done = false;
}

function startLmStudioCall(s: Session, input: string, opts?: { messages?: EngineMessage[]; watcher?: boolean }): void {
  refreshRoute(s);
  if (s.routeError) {
    append(s, "system", `Router error: ${s.routeError}`);
    s.done = true;
    return;
  }
  if (!s.model) {
    const resolved = resolveModelId(s.provider);
    if (!resolved) {
      const where = s.provider && s.provider.kind !== "lmstudio" ? `${s.provider.name} /models` : "/api/v1/models";
      append(s, "system", `${providerLabel(s)} error: no model configured and none could be auto-resolved from ${where}.`);
      s.done = true;
      return;
    }
    s.model = resolved;
    rememberLastModel(sessionModelId(s));
  }
  if (s.provider && s.provider.kind !== "lmstudio") {
    startRouterCall(s, s.provider, input, opts);
    return;
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
    system_prompt: opts?.messages ? s.systemPrompt : requestSystem(s),
    input: requestInput,
    stream: true,
    ...s.params,
  };
  if (!opts?.messages && s.previousResponseId) body.previous_response_id = s.previousResponseId;
  if (typeof body.max_tokens === "number" && body.max_output_tokens === undefined) body.max_output_tokens = body.max_tokens;

  const started = startFetchStream({
    url: `${lmStudioRoot(s.provider)}/api/v1/chat`,
    method: "POST",
    headers: lmStudioHeaders(s.provider),
    body: JSON.stringify(body),
  });
  if (!started.jobId) {
    const err = started.error || "missing jobId";
    append(s, "system", isVramLoadFailure(err) ? vramLoadFailureMessage(s.model) : `LM Studio stream error: ${err}`);
    s.done = true;
    return;
  }
  beginStream(s, started.jobId, "lmstudio", opts?.watcher);
}

function startNextIfIdle(s: Session): void {
  if (!s.stream && !s.pendingExec && !s.pendingTools && s.pendingInputs.length) {
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
  nativeCalls: NativeToolCall[],
): void {
  if (s.currentRun !== "watcher" && responseId && !(s.engine && s.engine.kind === "machine")) s.previousResponseId = responseId;
  finishLoopAssistantMessage(s, content, responseId, messageId, nativeCalls);
}

function nativeEntry(call: NativeToolCall, replyId: string): ToolParseEntry {
  let raw: unknown = {};
  try {
    raw = JSON.parse(call.arguments);
  } catch {
    return { call: { tool: call.name, args: {} }, callId: call.id, replyId, error: `${call.name} arguments are not valid JSON` };
  }
  const checked = checkToolArgs(call.name, raw);
  if (checked.ok) return { call: { tool: call.name, args: checked.args }, callId: call.id, replyId };
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { call: { tool: call.name, args }, callId: call.id, replyId, error: checked.error };
}

// Native calls win; then Qwen/Hermes text forms; then the host parser for fenced codeterm-tool JSON.
function toolEntries(s: Session, content: string, messageId: string, nativeCalls: NativeToolCall[]) {
  if (nativeCalls.length) return { entries: nativeCalls.map((c) => nativeEntry(c, messageId)), cleaned: content, status: "ok" as const, reason: undefined };
  const text = parseTextToolCalls(content);
  if (text.status === "none") return parseToolEntries(content);
  const native = routesNatively(s);
  const entries: ToolParseEntry[] = text.calls.map((call) => {
    const entry: ToolParseEntry = { call: { tool: call.tool, args: call.args } };
    if (native) Object.assign(entry, { callId: nextId(s, "call"), replyId: messageId });
    return entry;
  });
  return { entries, cleaned: text.cleaned, status: text.status, reason: text.reason };
}

function finishLoopAssistantMessage(
  s: Session,
  content: string,
  responseId: string | null,
  messageId: string,
  nativeCalls: NativeToolCall[],
): void {
  if (s.currentRun === "watcher") {
    s.watcherLastAssistant = content;
    if (responseId) s.previousResponseId = responseId;
  }
  const { entries, cleaned, status, reason } = toolEntries(s, content, messageId, nativeCalls);
  // A tool-call-shaped block that failed parse+repair: don't drop it silently
  // (the live Gemma bug — the model never learns and the reply never arrives).
  // Feed back a corrective note so the model resends a valid call, capping the
  // retries so a model that never recovers can't loop forever.
  if (status === "malformed") {
    if (s.malformedRetries < MAX_MALFORMED_RETRIES) {
      s.malformedRetries += 1;
      s.pendingInputs.push(
        `tool_result:\nERROR: your tool call was invalid (${reason || "unparseable tool call"}). ` +
          "Resend a single valid tool call, or answer in plain text if no tool is needed.",
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
      s.roundResults = [];
      if (!s.capReached) {
        append(s, "system", `Tool round cap (${MAX_TOOL_ROUNDS}) reached; stopping this turn.`);
        s.capReached = true;
      }
      if (s.currentRun === "watcher") completeWatcherTick(s, null);
      else s.done = true;
      return;
    }
    s.toolRounds += 1;
    const toolId = emitToolCall(s, entry);
    if (entry.error) {
      emitToolResult(s, call, { error: entry.error }, toolId, entry.callId);
      continue;
    }
    if (call.tool === "exec" || call.tool === "codeterm") {
      const shell = execShellCmd(call);
      if (shell.error) {
        emitToolResult(s, call, { error: shell.error }, toolId, entry.callId);
        continue;
      }
      const started = startExecJob(shell.shellCmd as string, s.tabId);
      if (started.jobId) {
        s.pendingExec = { call, jobId: started.jobId, toolId, callId: entry.callId };
        return; // park until drainExec sees the job finish
      }
      emitToolResult(s, call, { error: started.error || "host.exec.start failed" }, toolId, entry.callId);
      continue;
    }
    emitToolResult(s, call, executeTool(call), toolId, entry.callId);
  }
  s.pendingTools = null;
  queueContinuation(s);
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
    emitToolResult(s, finished.call, execResultFromPoll(poll), finished.toolId, finished.callId);
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
  if (stream.kind !== "lmstudio") {
    pollRouterStream(s, stream, poll);
    return;
  }
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
  if (chunks.length) stream.buffer += chunks.join("");
  consumeRouterEvents(stream, !!poll.done);
  publishStream(s, stream, !!poll.done);
}

function failStream(s: Session, stream: StreamState, message: string): void {
  if (stream.content) append(s, "assistant", stream.content, stream.messageId);
  append(s, "system", message);
  host.fetchStreamClose(stream.jobId);
  s.stream = null;
  if (s.currentRun === "watcher") completeWatcherTick(s, null);
  else s.done = true;
}

function pollRouterStream(s: Session, stream: StreamState, poll: StreamPoll): void {
  const name = s.provider ? s.provider.name : "Provider";
  const key = s.provider ? getKey(s.provider) : null;
  if (poll.error) {
    failStream(s, stream, `${name} stream error: ${redact(poll.error, key)}`);
    return;
  }
  if (poll.status && poll.status >= 400) {
    const detail = redact(errorTextFromBody(poll.body || (poll.chunks || []).join("")), key).slice(0, 300);
    const hint = poll.status === 401 || poll.status === 403 ? " — check the API key for this provider" : "";
    failStream(s, stream, `${name} HTTP ${poll.status}${detail ? `: ${detail}` : ""}${hint}`);
    return;
  }
  const chunks = Array.isArray(poll.chunks) ? poll.chunks : [];
  if (chunks.length) stream.buffer += chunks.join("");
  const looksSse = /(^|\n)(data|event):/.test(stream.buffer);
  if (looksSse || !poll.done) consumeRouterEvents(stream, !!poll.done);
  if (poll.done && !looksSse && stream.buffer.trim()) {
    const acc = emptyDelta();
    if (applyWholeBody(stream.kind, acc, stream.buffer)) {
      stream.content += acc.content;
      stream.reasoning += acc.reasoning;
      if (acc.usage) stream.usage = acc.usage;
    }
    stream.buffer = "";
  }
  if (stream.error) {
    failStream(s, stream, `${name} error: ${redact(stream.error, key)}`);
    return;
  }
  publishStream(s, stream, !!poll.done);
}

function emitUsage(s: Session, usage: Usage | null, messageId: string): void {
  if (!usage || s.currentRun === "watcher") return;
  const target = s.messages.find((m) => m.id === messageId);
  if (target) (target as unknown as Record<string, unknown>).usage = usage;
  if (readSettings().showUsage === false) return;
  append(s, "system", `${sessionModelId(s)} · ${formatUsage(usage)}`, undefined, { usage, collapsed: true });
}

function publishStream(s: Session, stream: StreamState, done: boolean): void {

  // Surface reasoning as its own growing 'thinking' entry (a valid
  // ChatMessageKind rendered as a collapsed thinking block); never fold it into
  // the answer. The answer rides on type:'assistant'.
  if (stream.reasoning) append(s, "thinking", stream.reasoning, stream.reasoningId);
  if (stream.content) append(s, "assistant", stream.content, stream.messageId);

  if (done) {
    host.fetchStreamClose(stream.jobId);
    s.stream = null;
    emitUsage(s, stream.usage, stream.messageId);
    finishAssistantMessage(s, stream.content, stream.kind === "lmstudio" ? stream.responseId : null, stream.messageId, finishToolCalls(stream.toolParts));
  }
}

function cfgString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function resolveSession(ctx: ChatBackendOpenSessionCtx, saved?: SavedSession | null): Session {
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
  const router = snapshot();
  const routerPreset = preset ? router.presets.find((p) => p.id === preset.id) : undefined;
  const target = resolveModelTarget(model, router.providers, router.defaultProvider, model ? undefined : routerPreset && routerPreset.provider);
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
  const cfg = ctx.config && typeof ctx.config === "object" && !Array.isArray(ctx.config) ? (ctx.config as Record<string, unknown>) : {};
  const useEngine = mode !== "watcher" && !(engine && engine.kind === "machine") && cfgString(s.engine) !== "relay";
  const shell = shellFlag(cfg.shell) ?? (preset && preset.shell) ?? shellFlag(s.shell) ?? true;
  const rootSetting = (saved && saved.root) || cfgString(cfg.root) || (preset && preset.root) || cfgString(s.root);
  return {
    tabId: ctx.tabId,
    messages: [],
    seq: 0,
    epoch: sessionEpoch(),
    cursorReset: false,
    systemPrompt: effectiveSystemPrompt,
    mode,
    engine,
    charter,
    machineState: {},
    currentRun: "interactive",
    watcherTicks: 0,
    watcherVerdictEmitted: false,
    watcherLastAssistant: "",
    model: target.model,
    provider: target.provider,
    route: { raw: model, presetProvider: model ? undefined : routerPreset && routerPreset.provider },
    routeError: target.error || null,
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
    roundResults: [],
    pendingAuthor: null,
    charterError,
    presetId: ctx.preset,
    es: useEngine ? newEngineSession(null, shell, (saved && saved.engineSession) || null) : null,
    rootSetting,
    engineNoted: false,
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function isAbsolute(p: string): boolean {
  return /^([A-Za-z]:[\\/]|\/)/.test(p);
}

/** The tab's own cwd from the instance CLI; the host does not put it in the open ctx. */
function tabCwd(tabId: string): string {
  const cmd = toolShell(`codeterm tab inspect ${shellQuote(tabId)} --json`, instanceBinDir());
  const res = parseJson<{ code?: number; stdout?: string }>(host.exec(JSON.stringify({ bin: "sh", args: ["-lc", cmd], timeoutMs: 10000 })), {});
  const rows = parseJson<unknown>(res.stdout || "", null);
  const row = Array.isArray(rows) ? rows[0] : rows;
  const cwd = row && typeof row === "object" ? (row as Record<string, unknown>).cwd : undefined;
  return typeof cwd === "string" ? cwd.trim() : "";
}

function resolveRoot(s: Session): { root?: string; error?: string } {
  const configured = s.rootSetting;
  const root = configured || tabCwd(s.tabId);
  if (!root) return { error: "Router error: this tab has no working directory; set `root` for the session or preset." };
  if (!isAbsolute(root)) return { error: `Router error: root must be an absolute path, got ${root}.` };
  if (!host.fileExists(root)) return { error: `Router error: root ${root} does not exist.` };
  return { root };
}

function engineSessions(): Session[] {
  const out: Session[] = [];
  sessions.forEach((x) => {
    if (x.es) out.push(x);
  });
  return out;
}

/** Declares only the providers and models live tabs use, so catalogue refreshes do not restart the engine. */
function wantEngine(): void {
  const router = snapshot();
  const settings = readSettings() as Record<string, unknown>;
  const compaction = compactionSettings(settings);
  const used: Record<string, string[]> = {};
  const add = (providerId: string, model: string) => {
    if (!providerId || !model) return;
    used[providerId] = used[providerId] || [];
    if (used[providerId].indexOf(model) < 0) used[providerId].push(model);
  };
  for (const x of engineSessions()) if (x.provider && x.model) add(x.provider.id, x.model);
  if (compaction.model) {
    const split = splitModelId(compaction.model);
    add(split.providerId || router.defaultProvider, split.model);
  }
  const providers: EngineProvider[] = [];
  const keyed: { provider: ProviderConfig; key: string | null }[] = [];
  for (const provider of router.providers) {
    if (!provider.enabled || !used[provider.id]) continue;
    const key = getKey(provider);
    const cached = cachedModels(provider);
    const models = (cached ? cached.models : []).filter((m) => used[provider.id].indexOf(m.id) >= 0);
    providers.push({ provider, models, extraModels: used[provider.id], hasKey: !!key });
    keyed.push({ provider, key });
  }
  const configJson = JSON.stringify(buildEngineConfig({ providers, compaction, defaultProvider: router.defaultProvider }));
  const keyEnv = engineKeyEnv(keyed);
  const md5 = typeof host.md5 === "function" ? (t: string) => host.md5(t) : fnv;
  setWanted({ configJson, keyEnv, fingerprint: configFingerprint(configJson, keyEnv, md5) });
}

function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function engineTab(s: Session): EngineTab {
  return {
    tabId: s.tabId,
    model: () => (s.provider && s.model ? ocModelRef(s.provider.id, s.model) : null),
    system: () => {
      const own = s.systemPrompt.trim();
      const ctx = engineContext(!!s.es && s.es.shell);
      return own ? `${ctx}\n\n${own}` : ctx;
    },
    emit: (row) => {
      const { id, type, content, ...extras } = row;
      append(s, type, content, id, { ...extras, provider: "lmstudio" });
    },
    note: (text) => append(s, "system", text),
    usage: (u) => {
      if (readSettings().showUsage === false) return;
      append(s, "system", `${sessionModelId(s)} · ${formatUsage(u)}`, `oc-usage-${u.messageID}`, { usage: u, collapsed: true });
    },
    persist: (ocSessionId, root) => saveSession(s.tabId, { model: reportedModel(s), preset: s.presetId, engineSession: ocSessionId, root }),
  };
}

function dropEngineTurn(s: Session, message: string): void {
  if (s.es) engineAbort(s.es);
  append(s, "system", message);
  s.done = true;
}

function engineAdvance(s: Session): void {
  const es = s.es as EngineSession;
  if (!engineBusy(es)) {
    s.done = true;
    return;
  }
  if (!es.root) {
    refreshRoute(s);
    if (s.routeError) return dropEngineTurn(s, `Router error: ${s.routeError}`);
    if (!s.model && s.provider) {
      s.model = resolveModelId(s.provider);
      if (!s.model) return dropEngineTurn(s, `${providerLabel(s)} error: no model configured and none could be auto-resolved.`);
      rememberLastModel(sessionModelId(s));
    }
    const r = resolveRoot(s);
    if (r.error) return dropEngineTurn(s, r.error);
    es.root = r.root as string;
  }
  const anyRunning = engineSessions().some((x) => !!x.es && x.es.inFlight);
  const phase = ensureEngine(anyRunning);
  if (phase === "failed") return dropEngineTurn(s, `Router engine error: ${engineError() || "OpenCode is unavailable"}`);
  if (phase !== "up") {
    s.done = false;
    return;
  }
  if (!s.engineNoted) {
    s.engineNoted = true;
    const note = engineVersionNote();
    if (note) append(s, "system", note);
  }
  const err = engineStep(es, engineTab(s));
  if (err) return dropEngineTurn(s, `Router engine error: ${err}`);
  s.done = !engineBusy(es);
}

interface AuthoringResult {
  ok: boolean;
  error?: string;
}

const plugin: ChatBackend & {
  describeModelSwitch: (sessionId: string, targetModel: string) => ModelSwitchDescription;
  authorSystemPrompt: (sessionId: string, draft: string) => void;
  requestPromptAuthoring: (sessionId: string, instruction?: string) => AuthoringResult;
  cancel: (sessionId: string) => void;
} = {
  openSession(ctx) {
    const sid = ctx.tabId;
    // A restored tab reopens under the same id; its OpenCode session still holds the conversation.
    const prior = savedSession(sid);
    const s = resolveSession(ctx, prior && prior.engineSession ? prior : null);
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
    rememberLastModel(sessionModelId(s));
    if (s.mode !== "watcher") saveSession(sid, { model: reportedModel(s), preset: ctx.preset, root: s.rootSetting || undefined });
    return { sessionId: sid };
  },

  sendMessage(sid, text) {
    const s = sessionFor(sid);
    if (!s) return;
    if (s.mode === "watcher") {
      host.log("warn", `sendMessage ignored for watcher session ${sid}`);
      return;
    }
    append(s, "user", text);
    if (s.es) {
      refreshRoute(s);
      s.es.queue.push(text);
      s.done = false;
      retryEngine();
      wantEngine();
      engineAdvance(s);
      return;
    }
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
    s.roundResults = [];
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
    if (s.es) {
      engineAdvance(s);
      return;
    }
    pollStream(s);
    drainExec(s);
    drainAuthor(s);
    startNextIfIdle(s);
  },

  poll(sid, cursor) {
    const s = sessions.get(sid);
    if (!s) return { messages: [], cursor: cursor ?? "0", done: true };
    const from = s.cursorReset ? 0 : Number(cursor ?? 0) || 0;
    s.cursorReset = false;
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
    const done = s.done && !s.stream && !s.pendingExec && !s.pendingAuthor && s.pendingInputs.length === 0;
    const state = activityOf({
      streaming: !!s.stream,
      answering: (!!s.stream && !!s.stream.content) || (!!s.es && s.es.inFlight),
      toolsRunning: !!s.pendingExec || !!s.pendingTools,
      queued: !done,
    });
    const result = {
      messages: s.messages.slice(from),
      cursor: String(nextCursor),
      done,
      activity: { state, statusLine: activityLine(sessionModelId(s), state) },
    };
    return result;
  },

  cancel(sid: string): void {
    const s = sessions.get(sid);
    if (!s) return;
    if (s.es) {
      const running = engineBusy(s.es);
      engineAbort(s.es);
      if (running) append(s, "system", "Stopped.");
      s.done = true;
      return;
    }
    const busy = !!s.stream || !!s.pendingExec || !!s.pendingTools || s.pendingInputs.length > 0;
    if (s.stream) {
      host.fetchStreamClose(s.stream.jobId);
      if (s.stream.content) append(s, "assistant", s.stream.content, s.stream.messageId);
      s.stream = null;
    }
    if (s.pendingExec) {
      host.execClose(s.pendingExec.jobId);
      emitToolResult(s, s.pendingExec.call, { error: "cancelled" }, s.pendingExec.toolId, s.pendingExec.callId);
      s.pendingExec = null;
    }
    s.pendingTools = null;
    s.pendingInputs = [];
    s.roundResults = [];
    if (busy) append(s, "system", "Stopped.");
    if (s.currentRun === "watcher") completeWatcherTick(s, null);
    else s.done = true;
  },

  closeSession(sid) {
    forgetSession(sid);
    const s = sessions.get(sid);
    if (s && s.stream) host.fetchStreamClose(s.stream.jobId);
    if (s && s.pendingExec) host.execClose(s.pendingExec.jobId);
    if (s && s.es) closeStream(s.es);
    sessions.delete(sid);
  },

  listModels(): Model[] {
    const router = snapshot();
    const models: Model[] = [];
    for (const provider of router.providers) {
      if (!provider.enabled) continue;
      const entry = discoverModels(provider);
      for (const m of entry.models) {
        const badges = capabilityBadges(m.capabilities);
        const info: Model = { id: qualifyModel(provider.id, m.id), displayName: m.displayName, group: provider.name };
        if (m.loaded) info.badge = "loaded";
        else if (badges.length) info.badge = badges[0];
        if (badges.length) info.description = badges.join(" · ");
        models.push(info);
      }
    }
    return models;
  },

  listPresets(): PresetInfo[] {
    return presets().map((p) => ({ id: p.id, name: p.name, description: p.description }));
  },

  sessionInfo(sid): ChatSessionInfo & { systemPrompt?: string } {
    const s = sessions.get(sid);
    if (s) refreshRoute(s);
    return { model: s ? reportedModel(s) || undefined : undefined, systemPrompt: s ? s.systemPrompt : undefined };
  },

  describeModelSwitch,

  authorSystemPrompt(sid: string, draft: string): void {
    const s = sessions.get(sid);
    if (!s || !s.model) return;
    applyAuthoredPrompt(s, sessionModelId(s), draft);
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
      task: `Help tune the system prompt for the ${providerLabel(s)} model "${sessionModelId(s)}".`,
    });
    const agentSessionId = spawned && spawned.sessionId;
    if (!agentSessionId) {
      append(s, "system", "Prompt authoring failed: could not spawn an author agent.");
      return { ok: false, error: "spawn failed" };
    }

    const sent = host.agent.send(agentSessionId, buildAuthoringRequest(sessionModelId(s), s.systemPrompt, instruction));
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

    s.pendingAuthor = { ticket, agentSessionId, model: sessionModelId(s) };
    s.done = false;
    append(s, "system", `Handing off system-prompt authoring for ${sessionModelId(s)} to an agent…`);
    return { ok: true };
  },

  setModel(sid, model) {
    const s = sessions.get(sid);
    if (!s || typeof model !== "string" || !model.trim()) return;
    const router = snapshot();
    const target = resolveModelTarget(model, router.providers, router.defaultProvider);
    if (!target.provider || !target.model) {
      append(s, "system", `Router error: ${target.error || `cannot route ${model}`}`);
      return;
    }
    s.route = { raw: model.trim() };
    saveSession(sid, { model: model.trim() });
    if (s.provider && s.provider.id === target.provider.id && s.model === target.model) return;
    s.provider = target.provider;
    s.model = target.model;
    s.routeError = null;
    rememberLastModel(sessionModelId(s));
    // The previous_response_id chains to the OLD model's server-side state; a
    // different model can't continue it. Reset so the next turn re-seeds context
    // (assembledContext) under the new model instead of 400-ing on a stale id.
    s.previousResponseId = null;
  },
};

function onAgentCommand(ctx: { verb: string; args: string[] }): { result: string } | { error: string } {
  try {
    return runAgentVerb(ctx.verb, Array.isArray(ctx.args) ? ctx.args : []);
  } catch (e) {
    return { error: `router verb failed: ${String(e)}` };
  }
}

export default {
  ...plugin,
  ...decisionModel,
  viewCall,
  onAgentCommand,
  __test_resetRouter: () => {
    resetModelCache();
    resetEngineForTests();
  },
  __test_domiosContext: DOMIOS_CONTEXT,
};
