import { apiRoot, hostOf } from "./config";
import type {
  ChatRequest,
  ChatTurn,
  HttpRequest,
  ProviderConfig,
  RouterError,
  StreamDelta,
  ToolPart,
  Usage,
} from "./types";
import { anthropicTools, openAiTools } from "./toolspec";
import { anthropicMessages, openAiMessage, pairToolCalls } from "./toolwire";

export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;
export const DISCOVERY_TIMEOUT_MS = 8000;
export const CHAT_TIMEOUT_MS = 120000;

type Json = Record<string, unknown>;

export function authHeaders(provider: Pick<ProviderConfig, "kind">, key: string | null): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.kind === "anthropic") {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (key) headers["x-api-key"] = key;
  } else if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

/** Candidates tried in order; LM Studio's v0 listing carries load state, older servers only v1. */
export function modelsRequests(provider: ProviderConfig, key: string | null): HttpRequest[] {
  const root = apiRoot(provider);
  const headers = authHeaders(provider, key);
  const get = (url: string): HttpRequest => ({ url, method: "GET", headers, timeoutMs: DISCOVERY_TIMEOUT_MS });
  if (provider.kind === "lmstudio") return [get(`${root}/api/v0/models`), get(`${root}/api/v1/models`), get(`${root}/v1/models`)];
  return [get(`${root}/models`)];
}

/** Merges same-role neighbours; the Messages API needs strict user/assistant alternation starting with user. */
export function normalizeTurns(turns: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const t of pairToolCalls(turns)) {
    const calls = t.toolCalls && t.toolCalls.length ? t.toolCalls : undefined;
    if (!t.content && !calls && t.role !== "tool") continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role && t.role !== "tool" && !last.toolCalls) {
      last.content = last.content && t.content ? `${last.content}\n\n${t.content}` : last.content || t.content;
      if (calls) last.toolCalls = calls;
    } else {
      const turn: ChatTurn = { role: t.role, content: t.content };
      if (calls) turn.toolCalls = calls;
      if (t.toolCallId) turn.toolCallId = t.toolCallId;
      out.push(turn);
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

export interface CachePlan {
  system: boolean;
  messageIndex: number;
}

/** Breakpoints on the system block and on the last turn before the newest user message (2 of the API's 4). */
export function cacheBreakpoints(hasSystem: boolean, turns: { role: string }[]): CachePlan {
  let newestUser = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === "user") {
      newestUser = i;
      break;
    }
  }
  return { system: hasSystem, messageIndex: newestUser > 0 ? newestUser - 1 : -1 };
}

const EPHEMERAL = { type: "ephemeral" };

export function anthropicBody(req: ChatRequest): Json {
  const messages = anthropicMessages(normalizeTurns(req.turns));
  const plan = cacheBreakpoints(!!req.system, messages);
  const marked = messages[plan.messageIndex];
  if (marked) {
    const blocks = marked.content;
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL };
  }
  const { max_tokens: maxTokens, ...rest } = req.params;
  const body: Json = {
    ...rest,
    model: req.model,
    max_tokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
    stream: true,
  };
  if (req.system) body.system = [{ type: "text", text: req.system, cache_control: EPHEMERAL }];
  if (req.tools) {
    body.tools = anthropicTools();
    body.tool_choice = { type: "auto" };
  }
  return body;
}

export function openAiBody(req: ChatRequest): Json {
  const messages: Json[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const t of normalizeTurns(req.turns)) messages.push(openAiMessage(t));
  const body: Json = {
    ...req.params,
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools) {
    body.tools = openAiTools();
    body.tool_choice = "auto";
  }
  return body;
}

export function chatRequest(provider: ProviderConfig, key: string | null, req: ChatRequest): HttpRequest {
  const root = apiRoot(provider);
  const headers = authHeaders(provider, key);
  if (provider.kind === "anthropic") {
    return { url: `${root}/messages`, method: "POST", headers, body: JSON.stringify(anthropicBody(req)), timeoutMs: CHAT_TIMEOUT_MS };
  }
  return { url: `${root}/chat/completions`, method: "POST", headers, body: JSON.stringify(openAiBody(req)), timeoutMs: CHAT_TIMEOUT_MS };
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Splits complete SSE events off `buffer`; an unterminated tail stays in `rest` unless `flush`. */
export function splitSse(buffer: string, flush: boolean): { events: SseEvent[]; rest: string } {
  const segments = buffer.split(/\r?\n\r?\n/);
  const rest = flush ? "" : segments.pop() ?? "";
  const events: SseEvent[] = [];
  for (const seg of segments) {
    let event = "";
    let data = "";
    for (const line of seg.split(/\r?\n/)) {
      if (line.indexOf("event:") === 0) event = line.slice(6).trim();
      else if (line.indexOf("data:") === 0) {
        let v = line.slice(5);
        if (v.charAt(0) === " ") v = v.slice(1);
        data += data ? `\n${v}` : v;
      }
    }
    if (data || event) events.push({ event, data });
  }
  return { events, rest };
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export function emptyDelta(): StreamDelta {
  return { content: "", reasoning: "", usage: null, responseId: null, error: null, toolParts: [] };
}

/** OpenAI-style usage: prompt_tokens already includes cached tokens. */
export function openAiUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Json;
  const details = u.prompt_tokens_details && typeof u.prompt_tokens_details === "object" ? (u.prompt_tokens_details as Json) : {};
  const input = n(u.prompt_tokens) || n(u.input_tokens);
  const cached = n(details.cached_tokens) || n(u.prompt_cache_hit_tokens) || n(u.cached_tokens);
  const output = n(u.completion_tokens) || n(u.output_tokens);
  if (!input && !output) return null;
  return { input, cachedInput: Math.min(cached, input || cached), cacheWrite: 0, output };
}

/** Anthropic input_tokens excludes cache reads/writes; normalized input is the full prompt. */
export function anthropicUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Json;
  const read = n(u.cache_read_input_tokens);
  const write = n(u.cache_creation_input_tokens);
  const input = n(u.input_tokens) + read + write;
  const output = n(u.output_tokens);
  if (!input && !output) return null;
  return { input, cachedInput: read, cacheWrite: write, output };
}

export function mergeUsage(prev: Usage | null, next: Usage | null): Usage | null {
  if (!next) return prev;
  if (!prev) return next;
  return {
    input: next.input || prev.input,
    cachedInput: next.cachedInput || prev.cachedInput,
    cacheWrite: next.cacheWrite || prev.cacheWrite,
    output: next.output || prev.output,
  };
}

function errorMessage(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const o = raw as Json;
    if (typeof o.message === "string") return o.message;
    if (o.error) return errorMessage(o.error);
  }
  return null;
}

function openAiToolParts(calls: Json[]): ToolPart[] {
  return calls.map((call, i) => {
    const fn = call && typeof call.function === "object" && call.function ? (call.function as Json) : {};
    const part: ToolPart = { index: typeof call.index === "number" ? call.index : i, args: "" };
    if (typeof call.id === "string" && call.id) part.id = call.id;
    if (typeof fn.name === "string" && fn.name) part.name = fn.name;
    if (typeof fn.arguments === "string") part.args = fn.arguments;
    else if (fn.arguments && typeof fn.arguments === "object") part.args = JSON.stringify(fn.arguments);
    return part;
  });
}

function anthropicToolPart(index: number, block: Json): ToolPart {
  const input = block.input && typeof block.input === "object" && Object.keys(block.input as Json).length ? JSON.stringify(block.input) : "";
  return { index, id: String(block.id || ""), name: String(block.name || ""), args: input };
}

export function applyOpenAiEvent(acc: StreamDelta, ev: SseEvent): void {
  if (!ev.data || ev.data === "[DONE]") return;
  let data: Json;
  try {
    data = JSON.parse(ev.data) as Json;
  } catch {
    return;
  }
  if (data.error) {
    acc.error = errorMessage(data.error) || "stream error";
    return;
  }
  if (typeof data.id === "string" && !acc.responseId) acc.responseId = data.id;
  const choices = Array.isArray(data.choices) ? (data.choices as Json[]) : [];
  for (const c of choices) {
    const delta = c && typeof c.delta === "object" && c.delta ? (c.delta as Json) : c && typeof c.message === "object" && c.message ? (c.message as Json) : {};
    if (typeof delta.content === "string") acc.content += delta.content;
    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
    if (reasoning) acc.reasoning += reasoning;
    if (Array.isArray(delta.tool_calls)) acc.toolParts.push(...openAiToolParts(delta.tool_calls as Json[]));
  }
  acc.usage = mergeUsage(acc.usage, openAiUsage(data.usage));
}

export function applyAnthropicEvent(acc: StreamDelta, ev: SseEvent): void {
  if (!ev.data) return;
  let data: Json;
  try {
    data = JSON.parse(ev.data) as Json;
  } catch {
    return;
  }
  const type = typeof data.type === "string" ? data.type : ev.event;
  if (type === "error") {
    acc.error = errorMessage(data.error) || "stream error";
  } else if (type === "message_start" && data.message && typeof data.message === "object") {
    const message = data.message as Json;
    if (typeof message.id === "string") acc.responseId = message.id;
    acc.usage = mergeUsage(acc.usage, anthropicUsage(message.usage));
  } else if (type === "content_block_start" && data.content_block && typeof data.content_block === "object") {
    const block = data.content_block as Json;
    if (block.type === "tool_use") acc.toolParts.push(anthropicToolPart(Number(data.index) || 0, block));
  } else if (type === "content_block_delta" && data.delta && typeof data.delta === "object") {
    const delta = data.delta as Json;
    if (typeof delta.text === "string") acc.content += delta.text;
    else if (typeof delta.thinking === "string") acc.reasoning += delta.thinking;
    else if (typeof delta.partial_json === "string") acc.toolParts.push({ index: Number(data.index) || 0, args: delta.partial_json });
  } else if (type === "message_delta" && data.usage && typeof data.usage === "object") {
    const u = data.usage as Json;
    const prev = acc.usage || { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
    const read = n(u.cache_read_input_tokens) || prev.cachedInput;
    const write = n(u.cache_creation_input_tokens) || prev.cacheWrite;
    const input = n(u.input_tokens) ? n(u.input_tokens) + read + write : prev.input;
    acc.usage = { input, cachedInput: read, cacheWrite: write, output: n(u.output_tokens) || prev.output };
  }
}

/** A non-streaming JSON reply (some servers ignore `stream: true`). */
export function applyWholeBody(kind: ProviderConfig["kind"], acc: StreamDelta, body: string): boolean {
  let data: Json;
  try {
    data = JSON.parse(body) as Json;
  } catch {
    return false;
  }
  if (!data || typeof data !== "object") return false;
  if (kind === "anthropic" && Array.isArray(data.content)) {
    (data.content as Json[]).forEach((block, i) => {
      if (block && block.type === "text" && typeof block.text === "string") acc.content += block.text;
      if (block && block.type === "thinking" && typeof block.thinking === "string") acc.reasoning += block.thinking;
      if (block && block.type === "tool_use") acc.toolParts.push(anthropicToolPart(i, block));
    });
    if (typeof data.id === "string") acc.responseId = data.id;
    acc.usage = anthropicUsage(data.usage) || acc.usage;
    return true;
  }
  if (Array.isArray(data.choices)) {
    applyOpenAiEvent(acc, { event: "", data: body });
    return true;
  }
  return false;
}

export function groupDigits(value: number): string {
  const s = String(Math.round(value));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatUsage(u: Usage): string {
  const fresh = Math.max(0, u.input - u.cachedInput);
  const parts = [`${groupDigits(u.input)} in`];
  if (u.cachedInput || u.cacheWrite) {
    parts.push(`${groupDigits(u.cachedInput)} cached`, `${groupDigits(fresh)} fresh`);
    if (u.cacheWrite) parts.push(`${groupDigits(u.cacheWrite)} cache write`);
  }
  parts.push(`${groupDigits(u.output)} out`);
  return parts.join(" · ");
}

export interface FetchOutcome {
  status?: number;
  body?: string;
  error?: string;
}

function snippet(body: string | undefined): string {
  if (!body) return "";
  let text = body;
  try {
    text = errorMessage(JSON.parse(body)) || body;
  } catch {
    // Non-JSON bodies are shown as text.
  }
  if (/<\/?[a-z][^>]*>/i.test(text)) text = text.replace(/<title>[\s\S]*?<\/title>/i, "").replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

/** Typed failure for a finished request, or null on 2xx. Never echoes request headers. */
export function classifyFetch(url: string, res: FetchOutcome): RouterError | null {
  if (res.error) {
    const e = res.error;
    if (/denied/i.test(e)) {
      return { kind: "denied", message: `CodeTerm blocks ${hostOf(url)}. Grant it: codeterm plugin settings lmstudio --allow-host ${hostOf(url)}` };
    }
    if (/time(d)?\s*out|timeout|deadline/i.test(e)) return { kind: "timeout", message: `${hostOf(url)} did not answer in time.` };
    return { kind: "unreachable", message: `Cannot reach ${hostOf(url)}: ${snippet(e)}` };
  }
  const status = res.status || 0;
  if (status >= 200 && status < 300) return null;
  const detail = snippet(res.body);
  if (status === 401 || status === 403) return { kind: "auth", status, message: `Key rejected (HTTP ${status})${detail ? `: ${detail}` : ""}` };
  if (status === 404) return { kind: "not_found", status, message: `Endpoint not found (HTTP 404)${detail ? `: ${detail}` : ""}` };
  return { kind: "http", status, message: `HTTP ${status || "?"}${detail ? `: ${detail}` : ""}` };
}

/** Redacts anything that looks like the key from text bound for transcripts or logs. */
export function redact(text: string, key: string | null): string {
  if (!key || key.length < 4) return text;
  return text.split(key).join("[redacted]");
}
