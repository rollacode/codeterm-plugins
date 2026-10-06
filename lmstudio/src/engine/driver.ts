import { splitSse } from "../router/adapters";
import { sessionPermission, type OcModelRef } from "./config";
import { applyEngineEvent, messagesToRows, newEngineView, type EngineUsage, type EngineView } from "./events";
import type { ChatRow } from "./parts";
import { authHeader, engineBase, engineLost, engineRequest } from "./server";

const STREAM_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const BUSY_GRACE_MS = 20000;

export interface EngineTab {
  tabId: string;
  model(): OcModelRef | null;
  system(): string;
  emit(row: ChatRow): void;
  note(text: string): void;
  usage(u: EngineUsage): void;
  persist(ocSessionId: string, root: string): void;
}

export interface EngineStream {
  jobId: string;
  buffer: string;
  connected: boolean;
}

export interface EngineSession {
  root: string | null;
  shell: boolean;
  ocSessionId: string | null;
  attached: boolean;
  view: EngineView | null;
  stream: EngineStream | null;
  queue: string[];
  inFlight: boolean;
  sawBusy: boolean;
  postedAt: number;
  turnStartMs: number;
  resync: boolean;
}

export function newEngineSession(root: string | null, shell: boolean, ocSessionId: string | null): EngineSession {
  return {
    root,
    shell,
    ocSessionId,
    attached: false,
    view: ocSessionId ? newEngineView(ocSessionId) : null,
    stream: null,
    queue: [],
    inFlight: false,
    sawBusy: false,
    postedAt: 0,
    turnStartMs: 0,
    resync: false,
  };
}

export function engineBusy(es: EngineSession): boolean {
  return es.inFlight || es.queue.length > 0;
}

function q(root: string): string {
  return `directory=${encodeURIComponent(root)}`;
}

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function failure(label: string, res: { status: number; body: string; error?: string }): string {
  if (res.error) return `${label}: ${res.error}`;
  const body = parse<Record<string, unknown>>(res.body, {});
  const data = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : {};
  const detail = typeof data.message === "string" ? data.message : typeof body.message === "string" ? body.message : "";
  return `${label}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`;
}

/** Creates the OpenCode session, or re-attaches a stored one and re-applies this tab's permission rules. */
function attach(es: EngineSession, tab: EngineTab): string | null {
  const root = es.root as string;
  const permission = sessionPermission(es.shell);
  if (es.ocSessionId) {
    const res = engineRequest("PATCH", `/session/${es.ocSessionId}?${q(root)}`, { permission });
    if (res.status === 200) {
      es.attached = true;
      return null;
    }
    if (res.status !== 404 && res.status !== 400) return failure("re-attach failed", res);
    tab.note("The stored OpenCode session is gone; starting a new one.");
    es.ocSessionId = null;
  }
  const res = engineRequest("POST", `/session?${q(root)}`, { title: `Domios Router ${tab.tabId}`, permission });
  const created = parse<{ id?: string }>(res.body, {});
  if (res.status !== 200 || typeof created.id !== "string") return failure("could not create an OpenCode session", res);
  es.ocSessionId = created.id;
  es.view = newEngineView(created.id);
  es.attached = true;
  tab.persist(created.id, root);
  return null;
}

function openStream(es: EngineSession): string | null {
  const base = engineBase();
  if (!base || !es.root) return "engine is not running";
  const raw = host.fetchStream(
    JSON.stringify({ url: `${base}/event?${q(es.root)}`, method: "GET", headers: { authorization: authHeader(), accept: "text/event-stream" }, timeoutMs: STREAM_TIMEOUT_MS }),
  );
  const started = parse<{ jobId?: string; error?: string }>(raw, { error: "fetchStream returned non-JSON" });
  if (!started.jobId) return started.error || "event stream did not start";
  es.stream = { jobId: started.jobId, buffer: "", connected: false };
  return null;
}

export function closeStream(es: EngineSession): void {
  if (es.stream) {
    try {
      host.fetchStreamClose(es.stream.jobId);
    } catch {
      // Already closed by the host.
    }
  }
  es.stream = null;
}

function finishTurn(es: EngineSession): void {
  es.inFlight = false;
  es.sawBusy = false;
  if (!es.queue.length) closeStream(es);
}

function reject(es: EngineSession, route: "permission" | "question", id: string): void {
  if (!es.root) return;
  if (route === "permission") engineRequest("POST", `/permission/${id}/reply?${q(es.root)}`, { reply: "reject" });
  else engineRequest("POST", `/question/${id}/reject?${q(es.root)}`);
}

function resync(es: EngineSession, tab: EngineTab): void {
  es.resync = false;
  if (!es.ocSessionId || !es.root || !es.view) return;
  const res = engineRequest("GET", `/session/${es.ocSessionId}/message?${q(es.root)}&limit=40`);
  if (res.status !== 200) return;
  for (const row of messagesToRows(es.view, parse<unknown[]>(res.body, []), es.turnStartMs - 1000)) tab.emit(row);
  const status = engineRequest("GET", `/session/status?${q(es.root)}`);
  const all = parse<Record<string, { type?: string }>>(status.body, {});
  const mine = all[es.ocSessionId];
  if (es.inFlight && (!mine || mine.type === "idle")) finishTurn(es);
  else if (es.inFlight) es.sawBusy = true;
}

function drainStream(es: EngineSession, tab: EngineTab): void {
  const stream = es.stream;
  if (!stream || !es.view) return;
  const poll = parse<{ chunks?: string[]; done?: boolean; status?: number; error?: string }>(host.fetchStreamPoll(stream.jobId), { done: true, error: "poll returned non-JSON" });
  if (Array.isArray(poll.chunks) && poll.chunks.length) stream.buffer += poll.chunks.join("");
  const { events, rest } = splitSse(stream.buffer, !!poll.done);
  stream.buffer = rest;
  for (const sse of events) {
    const ev = parse<Record<string, unknown> | null>(sse.data, null);
    if (!ev) continue;
    if (ev.type === "server.connected") {
      stream.connected = true;
      continue;
    }
    for (const effect of applyEngineEvent(es.view, ev, Date.now())) {
      if (effect.kind === "row") tab.emit(effect.row);
      else if (effect.kind === "usage") tab.usage(effect.usage);
      else if (effect.kind === "error") tab.note(effect.message);
      else if (effect.kind === "reject") reject(es, effect.route, effect.id);
      else if (effect.kind === "busy") es.sawBusy = true;
      else if (effect.kind === "idle" && es.inFlight && es.sawBusy) finishTurn(es);
    }
  }
  if (poll.done || poll.error || (poll.status && poll.status >= 400)) {
    closeStream(es);
    if (poll.status === 401) tab.note("The engine refused the Router's credentials; it will be restarted.");
    if (!poll.status || poll.status >= 500 || poll.error) engineLost();
    if (es.inFlight) es.resync = true;
  }
}

function postPrompt(es: EngineSession, tab: EngineTab): void {
  const model = tab.model();
  const text = es.queue.shift() as string;
  if (!model) {
    tab.note("Router error: no model is selected for this tab.");
    return;
  }
  const body: Record<string, unknown> = { model, parts: [{ type: "text", text }] };
  const system = tab.system();
  if (system) body.system = system;
  es.turnStartMs = Date.now();
  const res = engineRequest("POST", `/session/${es.ocSessionId}/prompt_async?${q(es.root as string)}`, body);
  if (res.status !== 204 && res.status !== 200) {
    tab.note(failure("OpenCode refused the message", res));
    if (!res.status) engineLost();
    return;
  }
  es.inFlight = true;
  es.sawBusy = false;
  es.postedAt = Date.now();
}

/** One non-blocking step once the engine is up; returns an error to show when the tab cannot proceed. */
export function engineStep(es: EngineSession, tab: EngineTab): string | null {
  if (!es.root) return "no root directory for this tab";
  if (!es.attached) {
    const err = attach(es, tab);
    if (err) return err;
  }
  if (!es.view && es.ocSessionId) es.view = newEngineView(es.ocSessionId);
  if (!es.stream && (es.inFlight || es.queue.length)) {
    const err = openStream(es);
    if (err) return `event stream: ${err}`;
  }
  if (es.resync && es.stream && es.stream.connected) resync(es, tab);
  drainStream(es, tab);
  if (es.stream && es.stream.connected && !es.inFlight && es.queue.length) postPrompt(es, tab);
  if (es.inFlight && !es.sawBusy && Date.now() - es.postedAt > BUSY_GRACE_MS) es.resync = true;
  return null;
}

export function engineAbort(es: EngineSession): void {
  if (es.ocSessionId && es.root && (es.inFlight || es.stream)) engineRequest("POST", `/session/${es.ocSessionId}/abort?${q(es.root)}`, undefined, 5000);
  es.queue = [];
  es.inFlight = false;
  es.sawBusy = false;
  es.resync = false;
  closeStream(es);
}
