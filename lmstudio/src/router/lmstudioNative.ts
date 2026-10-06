import type { SseEvent } from "./adapters";
import type { StreamDelta, Usage } from "./types";

type Json = Record<string, unknown>;

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function nested(obj: Json, key: string): Json {
  const v = obj[key];
  return v && typeof v === "object" ? (v as Json) : {};
}

/** LM Studio native `chat.end` stats; cache fields are read in every shape servers report them. */
export function nativeStatsUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const stats = raw as Json;
  const input = n(stats.input_tokens) || n(stats.prompt_tokens);
  const output = n(stats.total_output_tokens) || n(stats.output_tokens) || n(stats.completion_tokens);
  if (!input && !output) return null;
  const cached =
    n(stats.cached_input_tokens) ||
    n(stats.cached_tokens) ||
    n(stats.cache_read_input_tokens) ||
    n(nested(stats, "prompt_tokens_details").cached_tokens) ||
    n(nested(stats, "input_tokens_details").cached_tokens);
  return { input, cachedInput: Math.min(cached, input || cached), cacheWrite: n(stats.cache_creation_input_tokens), output };
}

/** Native /api/v1/chat SSE: message.* is the answer, reasoning.* the thinking, chat.end the response id and stats. */
export function applyNativeEvent(acc: StreamDelta, ev: SseEvent): void {
  if (!ev.data) return;
  let data: Json;
  try {
    data = JSON.parse(ev.data) as Json;
  } catch {
    return;
  }
  if (!data || typeof data !== "object") return;
  const type = typeof data.type === "string" ? data.type : "";
  if (type.indexOf("message.") === 0 && typeof data.content === "string") acc.content += data.content;
  else if (type.indexOf("reasoning.") === 0 && typeof data.content === "string") acc.reasoning += data.content;
  else if (type === "chat.end") {
    const result = nested(data, "result");
    if (typeof result.response_id === "string") acc.responseId = result.response_id;
    acc.usage = nativeStatsUsage(result.stats) || acc.usage;
  }
}
