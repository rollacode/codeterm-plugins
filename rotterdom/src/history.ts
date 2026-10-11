import type { ChatTurn, Profile } from "./types";
export interface CallRecord { signature: string; state: "claimed" | "completed"; result?: string }
export interface History {
  version: 1;
  id: string;
  profile: Profile;
  turns: ChatTurn[];
  ledger: Record<string, CallRecord>;
  run: number;
  taskResult?: { status: "done" | "failed" | "cancelled" | "deadline_exceeded"; output: unknown; error?: string };
}
export function claim(history: History, id: string, signature: string): string | null {
  const old = history.ledger[id];
  if (old) {
    if (old.signature !== signature) return JSON.stringify({ error: "call id reused with different arguments" });
    return old.state === "completed" ? old.result! : JSON.stringify({ error: "call outcome unconfirmed; never replayed" });
  }
  history.ledger[id] = { signature, state: "claimed" };
  return null;
}
export function complete(history: History, id: string, result: string): void {
  history.ledger[id] = { ...history.ledger[id], state: "completed", result };
}
export function recover(history: History): void {
  const answered = new Set(history.turns.filter(t => t.role === "tool").map(t => t.toolCallId));
  for (const turn of [...history.turns]) for (const call of turn.toolCalls || []) {
    if (answered.has(call.id)) continue;
    const result = history.ledger[call.id];
    history.turns.push({ role: "tool", toolCallId: call.id,
      content: result?.state === "completed" ? result.result! : JSON.stringify({ error: "call outcome unconfirmed; never replayed" }) });
    answered.add(call.id);
  }
}
function path(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new Error("invalid session id");
  const dir = host.fs.expandHome("~/.codeterm/rotterdom");
  if (!dir || !host.makeDirs(dir)) throw new Error("history directory unavailable");
  return `${dir}/session-${id}.json`;
}
export function save(history: History): void {
  if (!host.writeFileAtomic(path(history.id), JSON.stringify(history))) throw new Error("history persistence failed; execution stopped");
}
export function load(id: string): History | null {
  const raw = host.readFile(path(id));
  if (raw === null) return null;
  const h = JSON.parse(raw) as History;
  if (h.version !== 1 || h.id !== id || !Array.isArray(h.turns) || !h.ledger || !h.profile) throw new Error("invalid persisted history");
  recover(h);
  return h;
}
