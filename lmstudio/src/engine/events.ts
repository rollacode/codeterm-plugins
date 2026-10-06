import { partToChatMsg, type ChatRow, type OpencodePart } from "./parts";

export interface EngineView {
  sessionID: string;
  roles: Record<string, string>;
  summaries: Record<string, boolean>;
  parts: Record<string, OpencodePart>;
  pendingDeltas: Record<string, string>;
  usageDone: Record<string, boolean>;
  lastError: string;
}

export interface EngineUsage {
  messageID: string;
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export type EngineEffect =
  | { kind: "row"; row: ChatRow }
  | { kind: "busy" }
  | { kind: "idle" }
  | { kind: "error"; message: string }
  | { kind: "usage"; usage: EngineUsage }
  | { kind: "reject"; route: "permission" | "question"; id: string };

export function newEngineView(sessionID: string): EngineView {
  return { sessionID, roles: {}, summaries: {}, parts: {}, pendingDeltas: {}, usageDone: {}, lastError: "" };
}

export function rowId(partId: string): string {
  return `oc-${partId}`;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** `{name, data: {message}}` errors from OpenCode, as one readable line. */
export function errorText(raw: unknown): string {
  const e = obj(raw);
  const data = obj(e.data);
  const name = typeof e.name === "string" ? e.name : "Error";
  const message = typeof data.message === "string" ? data.message : typeof e.message === "string" ? e.message : "";
  return message ? `${name}: ${message}` : name;
}

function isAborted(raw: unknown): boolean {
  return obj(raw).name === "MessageAbortedError";
}

function partRow(view: EngineView, part: OpencodePart, tsMs: number): ChatRow | null {
  const id = typeof part.id === "string" ? part.id : "";
  const messageID = typeof part.messageID === "string" ? part.messageID : "";
  if (!id) return null;
  if (part.type === "compaction") {
    return { id: rowId(id), type: "system", content: "Context compacted", timelineMarker: { kind: "context_compaction" }, auto: part.auto === true };
  }
  const role = view.roles[messageID] || "assistant";
  // The tab already shows what the user typed; OpenCode's copy of it would duplicate the bubble.
  if (role === "user") return null;
  const row = partToChatMsg(part, role, rowId(id), tsMs);
  if (row && view.summaries[messageID] && part.type === "text") {
    return { id: row.id, type: "system", content: row.content, systemSubtype: "compact_summary" };
  }
  return row;
}

function usageOf(info: Json): EngineUsage | null {
  const tokens = obj(info.tokens);
  const cache = obj(tokens.cache);
  const input = num(tokens.input);
  const output = num(tokens.output);
  if (!input && !output) return null;
  const read = num(cache.read);
  const write = num(cache.write);
  return { messageID: String(info.id), input: input + read + write, cachedInput: read, cacheWrite: write, output };
}

function onMessageUpdated(view: EngineView, info: Json, out: EngineEffect[]): void {
  const id = typeof info.id === "string" ? info.id : "";
  if (!id) return;
  const role = typeof info.role === "string" ? info.role : "assistant";
  view.roles[id] = role;
  if (role !== "assistant") return;
  if (info.summary === true || info.mode === "compaction" || info.agent === "compaction") view.summaries[id] = true;
  const time = obj(info.time);
  if (time.completed && !view.usageDone[id] && !view.summaries[id]) {
    const usage = usageOf(info);
    if (usage) {
      view.usageDone[id] = true;
      out.push({ kind: "usage", usage });
    }
  }
}

function onError(view: EngineView, raw: unknown, out: EngineEffect[]): void {
  if (isAborted(raw)) return;
  const text = errorText(raw);
  if (text === view.lastError) return;
  view.lastError = text;
  out.push({ kind: "error", message: text });
}

/** Folds one `/event` payload into the view; events of other sessions (subagents included) are ignored. */
export function applyEngineEvent(view: EngineView, ev: Json, nowMs: number): EngineEffect[] {
  const out: EngineEffect[] = [];
  const type = typeof ev.type === "string" ? ev.type : "";
  const p = obj(ev.properties);
  if (p.sessionID !== undefined && p.sessionID !== view.sessionID) return out;
  switch (type) {
    case "message.updated":
      onMessageUpdated(view, obj(p.info), out);
      break;
    case "message.part.updated": {
      const part = obj(p.part) as OpencodePart;
      if (typeof part.id !== "string") break;
      const pending = view.pendingDeltas[part.id];
      if (pending !== undefined) {
        delete view.pendingDeltas[part.id];
        if ((part.text || "").length < pending.length) part.text = pending;
      }
      view.parts[part.id] = part;
      const row = partRow(view, part, num(p.time) || nowMs);
      if (row) out.push({ kind: "row", row });
      break;
    }
    case "message.part.delta": {
      const partID = typeof p.partID === "string" ? p.partID : "";
      const delta = typeof p.delta === "string" ? p.delta : "";
      if (!partID || p.field !== "text" || !delta) break;
      const known = view.parts[partID];
      if (!known) {
        view.pendingDeltas[partID] = (view.pendingDeltas[partID] || "") + delta;
        break;
      }
      known.text = (known.text || "") + delta;
      const row = partRow(view, known, nowMs);
      if (row) out.push({ kind: "row", row });
      break;
    }
    case "session.status": {
      const status = obj(p.status).type;
      if (status === "busy" || status === "retry") out.push({ kind: "busy" });
      else if (status === "idle") out.push({ kind: "idle" });
      break;
    }
    case "session.idle":
      out.push({ kind: "idle" });
      break;
    case "session.error":
      onError(view, p.error, out);
      break;
    case "permission.asked":
    case "permission.v2.asked":
      if (typeof p.id === "string") out.push({ kind: "reject", route: "permission", id: p.id });
      break;
    case "question.asked":
    case "question.v2.asked":
      if (typeof p.id === "string") out.push({ kind: "reject", route: "question", id: p.id });
      break;
    default:
      break;
  }
  return out;
}

/** `GET /session/:id/message` entries as rows; used to resync after a dropped event stream. */
export function messagesToRows(view: EngineView, entries: unknown[], sinceMs: number): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const raw of entries) {
    const entry = obj(raw);
    const info = obj(entry.info);
    const created = num(obj(info.time).created);
    const sink: EngineEffect[] = [];
    onMessageUpdated(view, info, sink);
    if (created < sinceMs) continue;
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    for (const part of parts) {
      const typed = obj(part) as OpencodePart;
      if (typeof typed.id !== "string") continue;
      view.parts[typed.id] = typed;
      const row = partRow(view, typed, created);
      if (row) rows.push(row);
    }
  }
  return rows;
}
