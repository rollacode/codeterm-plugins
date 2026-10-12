import type { NormalizedChatMessage } from "@codeterm/plugin-sdk";
import type { Endpoint, NativeToolCall, Profile } from "./types";
import { request, response } from "./adapters";
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
export function open(id: string, profile: Profile, endpoint: Endpoint, resume: boolean | "auto" = false): string {
  if (sessions.has(id)) throw new Error("session already open");
  const old = resume ? load(id) : null;
  if (resume === true && !old) throw new Error("persisted session not found");
  const history: History = old || { version: 1, id, profile, turns: [], ledger: {}, run: 0 };
  if (old && (old.profile.id !== profile.id || old.profile.root !== profile.root)) throw new Error("resume profile or root changed");
  history.profile = profile;
  const s: Session = { history, rows: [], endpoint, deadline: 0, tokens: 0, rounds: 0, done: true, calls: [] };
  restoredRows(s);
  save(history);
  sessions.set(id, s);
  return id;
}
function cancel(s: Session): void {
  if (s.request) host.fetch.streamClose(s.request.job);
  if (s.execution) host.exec.close(s.execution.job);
  s.request = undefined;
  s.execution = undefined;
  s.calls = [];
}
function stop(s: Session, reason: string): void {
  cancel(s);
  recover(s.history);
  row(s, "assistant", reason);
  s.done = true;
  save(s.history);
}
function startRequest(s: Session): void {
  if (host.unixNowMs() >= s.deadline) throw new Error("deadline budget exhausted");
  if (++s.rounds > s.history.profile.budgets.turns) throw new Error("turn budget exhausted");
  const remaining = s.history.profile.budgets.tokens - s.tokens;
  if (remaining <= 0) throw new Error("token budget exhausted");
  const key = s.endpoint.secret ? host.secretGet(s.endpoint.secret) : null;
  if (s.endpoint.secret && !key) throw new Error("endpoint secret unavailable");
  const opts = request(s.endpoint, s.history.profile, s.history.turns, key, remaining);
  opts.timeoutMs = Math.max(1, Math.min(opts.timeoutMs, s.deadline - host.unixNowMs()));
  const job = host.fetch.stream(opts);
  if (!job.jobId) throw new Error(job.error || "request start failed");
  s.request = { job: job.jobId, body: "" };
}
export function send(id: string, text: string): void {
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
  save(s.history);
  try { startRequest(s); } catch (e) { stop(s, String(e)); }
}
function result(s: Session, call: NativeToolCall, value: unknown): void {
  const raw = JSON.stringify(value).slice(0, 32768);
  complete(s.history, call.id, raw);
  s.history.turns.push({ role: "tool", toolCallId: call.id, content: raw });
  row(s, "tool_result", raw, { callId: call.id });
  save(s.history);
}
export function pump(id: string): void {
  const s = session(id);
  if (s.done) return;
  try {
    if (host.unixNowMs() >= s.deadline) throw new Error("deadline budget exhausted");
    if (s.request) {
      const current = s.request;
      const poll = host.fetch.streamPoll(current.job);
      current.body += (poll.chunks || []).join("");
      if (current.body.length > 2 * 1024 * 1024) throw new Error("response exceeds limit");
      if (!poll.done) return;
      host.fetch.streamClose(current.job);
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
      save(s.history);
      if (!s.calls.length) { s.done = true; return; }
    }
    if (s.execution) {
      const pending = s.execution;
      const polled = host.exec.poll(pending.job);
      if (!polled.done) return;
      host.exec.close(pending.job);
      s.execution = undefined;
      result(s, pending.call, polled);
    }
    const call = s.calls.shift();
    if (call) {
      const previous = claim(s.history, call.id, `${call.name}:${call.arguments}`);
      if (previous !== null) {
        s.history.turns.push({ role: "tool", toolCallId: call.id, content: previous });
        row(s, "tool_result", previous, { callId: call.id });
        save(s.history);
      } else {
        save(s.history);
        let value: unknown;
        try { value = execute(s.history.profile, call.name, JSON.parse(call.arguments), s.deadline); }
        catch (e) { value = { error: String(e) }; }
        if (value && typeof value === "object" && "jobId" in value) s.execution = { job: String(value.jobId), call };
        else result(s, call, value);
      }
      return;
    }
    if (!s.execution) startRequest(s);
  } catch (e) { stop(s, String(e)); }
}
export function poll(id: string, cursor?: string | null) {
  const s = session(id);
  const index = cursor == null ? 0 : Number(cursor);
  if (!Number.isInteger(index) || index < 0 || index > s.rows.length) throw new Error("invalid cursor");
  return { messages: s.rows.slice(index), cursor: String(s.rows.length), done: s.done };
}
export function close(id: string): void {
  const s = session(id);
  if (!s.done) stop(s, "Turn cancelled; uncertain calls will not replay.");
  sessions.delete(id);
}
export function info(id: string) { return { model: session(id).history.profile.model }; }
export function setModel(id: string, model: string): void {
  const s = session(id);
  if (!s.done) throw new Error("session is busy");
  if (!s.endpoint.models.includes(model)) throw new Error("model is not configured on this endpoint");
  s.history.profile = { ...s.history.profile, model };
  save(s.history);
}
export function historyTurns(id: string) { return transcriptTurns(session(id).rows, () => false); }
