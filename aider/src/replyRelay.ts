import { parseAiderHistoryDelta, utf8Length } from "./history";

export type RelayEvidence = {
  userTurnId: string; userRecordStart: number; userText: string;
} & ({ complete: true; assistantTurnId: string; answer: string } |
     { complete: false; outcome: "error" | "cancelled" | "reflection_limit" });
export type RelayResult = RelayEvidence | { unavailable: true; reason: string } | null;

/** Slice only at UTF-8 boundaries, including Windows CRLF history bytes. */
export function byteSlice(text: string, start: number, end: number): string | null {
  if (start < 0 || end < start) return null;
  let offset = 0;
  let result = "";
  let starts = start === 0;
  for (const char of text) {
    const next = offset + utf8Length(char);
    if (offset === start) starts = true;
    if ((offset < start && next > start) || (offset < end && next > end)) return null;
    if (offset >= start && next <= end) result += char;
    offset = next;
    if (offset === end) return starts ? result : null;
  }
  return offset === end && starts ? result : null;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Only adapter-owned records prove completion; markdown never proves a turn end. */
export function readRelayEvidence(history: string | null, sidecar: string | null, sessionId: string, afterOffset: number): RelayResult {
  const unavailable = (reason: string): RelayResult => ({ unavailable: true, reason });
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !integer(afterOffset)) return null;
  if (sidecar === null) return unavailable("This session has no Domios Aider adapter_start record (plain mode or adapter unavailable).");
  const lines = sidecar.split("\n");
  lines.pop(); // An unterminated append is never authoritative.
  let generation: string | null = null;
  const generations = new Set<string>();
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { return null; }
    if (!record || record.version !== 1 || record.sessionId !== sessionId || record.launchMarker !== sessionId ||
        typeof record.processGeneration !== "string" || !record.processGeneration) return null;
    if (record.kind === "adapter_start") {
      if (record.aiderVersion !== "0.86.2") return unavailable("Unsupported Aider adapter version; install aider-chat==0.86.2.");
      // Aider can rebuild IO during startup before any turn. An idempotent
      // start is safe there, but a completed/older generation cannot restart.
      if (generations.has(record.processGeneration) && (record.processGeneration !== generation ||
        records.some(turn => turn.processGeneration === generation))) return null;
      generation = record.processGeneration;
      generations.add(generation);
    } else if (record.kind === "turn_complete") {
      if (!generation || record.processGeneration !== generation) return null;
      records.push(record);
    } else return null;
  }
  if (!generation) return unavailable("This session has no Domios Aider adapter_start record.");
  if (history === null) return null;
  const historyBytes = utf8Length(history);
  let sequence = 0;
  let recordGeneration: unknown = null;
  let previousHistoryBytes = 0;
  for (const record of records) {
    if (record.processGeneration !== recordGeneration) {
      recordGeneration = record.processGeneration;
      sequence = 0;
    }
    const { userRecordStart: user, responseRecordStart: start, responseRecordEnd: end, historyBytes: size, turnSequence: seq } = record;
    if (!integer(user) || !integer(start) || !integer(end) || !integer(size) || !integer(seq) || seq <= sequence ||
        user >= start || start > end || end > size || user < previousHistoryBytes) return null;
    sequence = seq;
    previousHistoryBytes = size;
    if (size > historyBytes) return null; // History/sidecar reads raced; retry on next event.
    if (user < afterOffset) continue;
    if (user && byteSlice(history, user - 1, user) !== "\n") return null;
    const userSource = byteSlice(history, user, start);
    if (userSource === null || !userSource.startsWith("#### ")) return null;
    const userRow = parseAiderHistoryDelta(userSource).messages.find(row => row.role === "user");
    if (!userRow || userRow.uuid !== "aider:user:0") return null;
    const identity = { userTurnId: `aider:${sessionId}:user:${user}`, userRecordStart: user, userText: userRow.blocks[0].data.text };
    if (record.complete === false && ["error", "cancelled", "reflection_limit"].includes(String(record.outcome))) {
      return { ...identity, complete: false, outcome: record.outcome as "error" | "cancelled" | "reflection_limit" };
    }
    if (record.complete !== true || record.outcome !== "answered" || start === end) return null;
    const response = byteSlice(history, start, end);
    if (response === null) return null;
    const rows = parseAiderHistoryDelta(response).messages;
    if (rows.some(row => row.role === "user")) return null;
    const answer = rows.filter(row => row.role === "assistant")
      .flatMap(row => row.blocks.filter(block => block.kind === "text").map(block => block.data.text)).join("\n\n").trim();
    if (!answer) return null;
    return { ...identity, complete: true, assistantTurnId: `aider:${sessionId}:${record.processGeneration}:answer:${seq}:${start}`, answer };
  }
  return null;
}
