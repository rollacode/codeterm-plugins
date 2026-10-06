import type { ChatTurn, NativeToolCall, ToolPart } from "./types";

type Json = Record<string, unknown>;

/** Drops calls without a result and results without a call; both wire formats 400 on either. */
export function pairToolCalls(turns: ChatTurn[]): ChatTurn[] {
  const answered = new Set<string>();
  for (const t of turns) if (t.role === "tool" && t.toolCallId) answered.add(t.toolCallId);
  const out: ChatTurn[] = [];
  let open = new Set<string>();
  for (const t of turns) {
    if (t.role === "tool") {
      if (t.toolCallId && open.has(t.toolCallId)) out.push({ ...t });
      continue;
    }
    if (t.role === "assistant" && t.toolCalls && t.toolCalls.length) {
      const kept = t.toolCalls.filter((c) => answered.has(c.id));
      open = new Set(kept.map((c) => c.id));
      const turn: ChatTurn = { role: "assistant", content: t.content };
      if (kept.length) turn.toolCalls = kept;
      out.push(turn);
      continue;
    }
    if (t.role === "user") open = new Set();
    out.push({ ...t });
  }
  return out;
}

export function mergeToolParts(into: ToolPart[], parts: ToolPart[]): void {
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

export function finishToolCalls(parts: ToolPart[]): NativeToolCall[] {
  return parts
    .filter((x) => x.name)
    .sort((a, b) => a.index - b.index)
    .map((x) => ({ id: x.id || `call_${x.index}`, name: x.name as string, arguments: x.args.trim() || "{}" }));
}

export function openAiMessage(t: ChatTurn): Json {
  if (t.role === "tool") return { role: "tool", tool_call_id: t.toolCallId, content: t.content };
  if (t.role === "assistant" && t.toolCalls && t.toolCalls.length) {
    return {
      role: "assistant",
      content: t.content || null,
      tool_calls: t.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    };
  }
  return { role: t.role, content: t.content };
}

function parsedInput(raw: string): Json {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
  } catch {
    return {};
  }
}

export interface AnthropicWireMessage {
  role: "user" | "assistant";
  content: Json[];
}

/** Tool results ride as user tool_result blocks, placed before any text in that user message. */
export function anthropicMessages(turns: ChatTurn[]): AnthropicWireMessage[] {
  const out: AnthropicWireMessage[] = [];
  for (const t of turns) {
    const role = t.role === "assistant" ? "assistant" : "user";
    const blocks: Json[] = [];
    if (t.role === "tool") blocks.push({ type: "tool_result", tool_use_id: t.toolCallId, content: t.content });
    else if (t.content) blocks.push({ type: "text", text: t.content });
    for (const c of t.toolCalls || []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: parsedInput(c.arguments) });
    if (!blocks.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  return out;
}
