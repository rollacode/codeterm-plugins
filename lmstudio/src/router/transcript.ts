import type { ChatTurn } from "./types";

export interface TranscriptRow {
  id: string;
  type: string;
  content: string;
  callId?: unknown;
  replyId?: unknown;
  toolName?: unknown;
  toolArgs?: unknown;
}

/** Rebuilds wire turns from the visible transcript; rows with a callId replay as native tool calls/results. */
export function transcriptTurns(rows: TranscriptRow[], skipUser: (content: string) => boolean): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let reply: { id: string; turn: ChatTurn } | null = null;
  for (const m of rows) {
    if (m.type === "user") {
      if (skipUser(m.content)) continue;
      turns.push({ role: "user", content: m.content });
      reply = null;
    } else if (m.type === "assistant") {
      const turn: ChatTurn = { role: "assistant", content: m.content };
      turns.push(turn);
      reply = { id: m.id, turn };
    } else if (m.type === "tool_call" && typeof m.callId === "string" && typeof m.toolName === "string") {
      const call = { id: m.callId, name: m.toolName, arguments: typeof m.toolArgs === "string" ? m.toolArgs : "{}" };
      const replyId = typeof m.replyId === "string" ? m.replyId : "";
      if (!reply || reply.id !== replyId) {
        const turn: ChatTurn = { role: "assistant", content: "" };
        turns.push(turn);
        reply = { id: replyId, turn };
      }
      reply.turn.toolCalls = [...(reply.turn.toolCalls || []), call];
    } else if (m.type === "tool_result") {
      if (typeof m.callId === "string") turns.push({ role: "tool", content: m.content, toolCallId: m.callId });
      else {
        turns.push({ role: "user", content: `tool_result:\n${m.content}` });
        reply = null;
      }
    }
  }
  return turns;
}
