import { ioValue, type HostIoSteps } from "@codeterm/plugin-sdk";
import type { NormalizedChatMessage } from "@codeterm/plugin-sdk";
import type { Endpoint, NativeToolCall, Profile } from "./types";
import { endpointKey, request, response } from "./adapters";
import { claim, complete, load, recover, save, type History } from "./history";
import { execute } from "./runtime";
import { transcriptTurns, type TranscriptRow } from "./transcript";
interface Session {
  history: History;
  rows: (NormalizedChatMessage & TranscriptRow)[];
  endpoint: Endpoint;
  deadline: number;
  tokens: number;
  rounds: number;
  done: boolean;
  request?: { job: string; body: string };
  calls: NativeToolCall[];
  execution?: { job: string; call: NativeToolCall };
}
const sessions = new Map<string, Session>();
function row(s: Session, type: string, content: string, extra: { callId?: string; replyId?: string; toolName?: string; toolArgs?: string } = {}): void {
  s.rows.push({ id: `${s.history.id}-${s.rows.length}`, type, content, ...extra });
}
function restoredRows(s: Session): void {
  for (const turn of s.history.turns) {
    row(s, turn.role === "tool" ? "tool_result" : turn.role, turn.content, { callId: turn.toolCallId });
    const replyId = s.rows[s.rows.length - 1].id;
    for (const c of turn.toolCalls || []) row(s, "tool_call", c.arguments, { callId: c.id, toolName: c.name, toolArgs: c.arguments, replyId });
  }
}
function session(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new Error("session is not open");
  return s;
}
export function* open(id: string, profile: Profile, endpoint: Endpoint, resume: boolean | "auto" = false): HostIoSteps<string> {
  if (sessions.has(id)) throw new Error("session already open");
  const old = resume ? (yield* load(id)) : null;
  if (resume === true && !old) throw new Error("persisted session not found");
  const history: History = old || { version: 1, id, profile, turns: [], ledger: {}, run: 0 };
  if (old && (old.profile.id !== profile.id || old.profile.root !== profile.root)) throw new Error("resume profile or root changed");
  history.profile = profile;
  const s: Session = { history, rows: [], endpoint, deadline: 0, tokens: 0, rounds: 0, done: true, calls: [] };
  restoredRows(s);
  (yield* save(history));
  sessions.set(id, s);
  return id;
}
function* cancel(s: Session): HostIoSteps<void> {
  if (s.request) (yield* ioValue<void>({ op: "fetchStreamClose", job: s.request.job }));
  if (s.execution) (yield* ioValue<void>({ op: "execClose", job: s.execution.job }));
  s.request = undefined;
  s.execution = undefined;
  s.calls = [];
}
function* stop(s: Session, reason: string): HostIoSteps<void> {
  (yield* cancel(s));
  recover(s.history);
  row(s, "assistant", reason);
  s.done = true;
  (yield* save(s.history));
}
function* startRequest(s: Session): HostIoSteps<void> {
  if (host.unixNowMs() >= s.deadline) throw new Error("deadline budget exhausted");
  if (++s.rounds > s.history.profile.budgets.turns) throw new Error("turn budget exhausted");
  const remaining = s.history.profile.budgets.tokens - s.tokens;
  if (remaining <= 0) throw new Error("token budget exhausted");
  const key = (yield* endpointKey(s.endpoint));
  const opts = (yield* request(s.endpoint, s.history.profile, s.history.turns, key, remaining));
  opts.timeoutMs = Math.max(1, Math.min(opts.timeoutMs, s.deadline - host.unixNowMs()));
  const job = (yield* ioValue<ReturnType<typeof host.exec.start>>({ op: "fetchStreamStart", options: opts }));
  if (!job.jobId) throw new Error(job.error || "request start failed");
  s.request = { job: job.jobId, body: "" };
}
export function* send(id: string, text: string): HostIoSteps<void> {
  const s = session(id);
  if (!s.done) throw new Error("session is busy");
  if (!text || text.length > 32768) throw new Error("invalid message size");
  if (s.history.turns.length > 1000) throw new Error("history limit reached; open a new session");
  s.history.run++;
  s.history.turns.push({ role: "user", content: text });
  row(s, "user", text);
  s.deadline = host.unixNowMs() + s.history.profile.budgets.deadlineMs;
  s.rounds = 0;
  s.tokens = 0;
  s.done = false;
  (yield* save(s.history));
  try { (yield* startRequest(s)); } catch (e) { (yield* stop(s, String(e))); }
}
function* result(s: Session, call: NativeToolCall, value: unknown): HostIoSteps<void> {
  const raw = JSON.stringify(value).slice(0, 32768);
  complete(s.history, call.id, raw);
  s.history.turns.push({ role: "tool", toolCallId: call.id, content: raw });
  row(s, "tool_result", raw, { callId: call.id });
  (yield* save(s.history));
}
export function* pump(id: string): HostIoSteps<void> {
  const s = session(id);
  if (s.done) return;
  try {
    if (host.unixNowMs() >= s.deadline) throw new Error("deadline budget exhausted");
    if (s.request) {
      const current = s.request;
      const poll = (yield* ioValue<ReturnType<typeof host.fetch.streamPoll>>({ op: "fetchStreamPoll", job: current.job }));
      current.body += (poll.chunks || []).join("");
      if (current.body.length > 2 * 1024 * 1024) throw new Error("response exceeds limit");
      if (!poll.done) return;
      (yield* ioValue<void>({ op: "fetchStreamClose", job: current.job }));
      s.request = undefined;
      if (poll.error || !poll.status || poll.status < 200 || poll.status >= 300) throw new Error(poll.error || `endpoint HTTP ${poll.status || "unknown"}`);
      const { turn, tokens } = response(current.body);
      s.tokens += tokens;
      if (s.tokens > s.history.profile.budgets.tokens) throw new Error("token budget exhausted");
      s.history.turns.push(turn);
      row(s, "assistant", turn.content);
      const replyId = s.rows[s.rows.length - 1].id;
      s.calls = [...(turn.toolCalls || [])];
      for (const call of s.calls) row(s, "tool_call", call.arguments, { callId: call.id, toolName: call.name, toolArgs: call.arguments, replyId });
      (yield* save(s.history));
      if (!s.calls.length) { s.done = true; return; }
    }
    if (s.execution) {
      const pending = s.execution;
      const polled = (yield* ioValue<ReturnType<typeof host.exec.poll>>({ op: "execPoll", job: pending.job }));
      if (!polled.done) return;
      (yield* ioValue<void>({ op: "execClose", job: pending.job }));
      s.execution = undefined;
      (yield* result(s, pending.call, polled));
    }
    const call = s.calls.shift();
    if (call) {
      const previous = claim(s.history, call.id, `${call.name}:${call.arguments}`);
      if (previous !== null) {
        s.history.turns.push({ role: "tool", toolCallId: call.id, content: previous });
        row(s, "tool_result", previous, { callId: call.id });
        (yield* save(s.history));
      } else {
        (yield* save(s.history));
        let value: unknown;
        try { value = (yield* execute(s.history.profile, call.name, JSON.parse(call.arguments), s.deadline)); }
        catch (e) { value = { error: String(e) }; }
        if (value && typeof value === "object" && "jobId" in value) s.execution = { job: String(value.jobId), call };
        else (yield* result(s, call, value));
      }
      return;
    }
    if (!s.execution) (yield* startRequest(s));
  } catch (e) { (yield* stop(s, String(e))); }
}
export function poll(id: string, cursor?: string | null) {
  const s = session(id);
  const index = cursor == null ? 0 : Number(cursor);
  if (!Number.isInteger(index) || index < 0 || index > s.rows.length) throw new Error("invalid cursor");
  return { messages: s.rows.slice(index), cursor: String(s.rows.length), done: s.done };
}
export function* close(id: string): HostIoSteps<void> {
  const s = session(id);
  if (!s.done) (yield* stop(s, "Turn cancelled; uncertain calls will not replay."));
  sessions.delete(id);
}
export function info(id: string) { return { model: session(id).history.profile.model }; }
export function* setModel(id: string, model: string): HostIoSteps<void> {
  const s = session(id);
  if (!s.done) throw new Error("session is busy");
  if (!s.endpoint.models.includes(model)) throw new Error("model is not configured on this endpoint");
  s.history.profile = { ...s.history.profile, model };
  (yield* save(s.history));
}
export function historyTurns(id: string) { return transcriptTurns(session(id).rows, () => false); }
