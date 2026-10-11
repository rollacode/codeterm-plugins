import type { AgentTaskInput, AgentTaskResult, FetchResult } from "@codeterm/plugin-sdk";
import { resolve } from "./config";
import { request, response } from "./adapters";
import { claim, complete, load, recover, save, type History } from "./history";
import { execute } from "./runtime";
import type { NativeToolCall } from "./types";

interface Run { history: History; deadline: number; jobs: Set<string>; tokens: number; turns: number; cancelled: boolean }
const runs = new Map<string, Run>();

function finish(runId: string, result: AgentTaskResult): AgentTaskResult {
  const run = runs.get(runId)!;
  run.history.taskResult = result;
  try { save(run.history); } finally { runs.delete(runId); }
  return result;
}

export function abortAgentTask(runId: string): void {
  const run = runs.get(runId);
  if (!run) return;
  run.cancelled = true;
  for (const job of run.jobs) host.exec.close(job);
  recover(run.history);
  finish(runId, { status: "cancelled", output: null, error: "unfinished tool effects are unconfirmed" });
}

export function runAgentTask(input: AgentTaskInput): AgentTaskResult {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.runId) || !input.task || input.task.length > 32768 || input.input.length > 32768) throw new Error("invalid agent task");
  const selected = resolve(input.profile);
  const profile = { ...selected.profile, deny: [...selected.profile.deny, "report"], budgets: {
    tokens: Math.min(selected.profile.budgets.tokens, input.maxTokens),
    turns: Math.min(selected.profile.budgets.turns, input.maxTurns),
    deadlineMs: Math.min(selected.profile.budgets.deadlineMs, input.timeoutMs),
  } };
  for (const budget of Object.values(profile.budgets)) if (!Number.isInteger(budget) || budget <= 0) throw new Error("invalid task budget");
  const id = `task_${input.runId}`;
  const previous = load(id);
  if (previous) return previous.taskResult || { status: "failed", output: null, error: "existing task outcome unconfirmed; never replayed" };
  const history: History = { version: 1, id, profile, turns: [{ role: "user", content: input.task },
    ...(input.input ? [{ role: "user" as const, content: input.input }] : [])], ledger: {}, run: 1 };
  const run: Run = { history, deadline: host.unixNowMs() + profile.budgets.deadlineMs, jobs: new Set(), tokens: 0, turns: 0, cancelled: false };
  save(history);
  runs.set(input.runId, run);
  const fail = (e: unknown): AgentTaskResult => finish(input.runId, { status: "failed", output: null, error: String(e) });
  function result(call: NativeToolCall, raw: string): void {
    complete(history, call.id, raw);
    history.turns.push({ role: "tool", toolCallId: call.id, content: raw });
    save(history);
  }
  function calls(queue: NativeToolCall[]): AgentTaskResult {
    if (run.cancelled) return { status: "cancelled", output: null };
    if (host.unixNowMs() >= run.deadline) return finish(input.runId, { status: "deadline_exceeded", output: null, error: "task deadline exceeded" });
    const call = queue.shift();
    if (!call) return next();
    try {
      const old = claim(history, call.id, `${call.name}:${call.arguments}`);
      if (old !== null) { history.turns.push({ role: "tool", toolCallId: call.id, content: old }); save(history); return calls(queue); }
      save(history);
      let value: unknown;
      try { value = execute(profile, call.name, JSON.parse(call.arguments), run.deadline); }
      catch (e) { value = { error: String(e) }; }
      if (value && typeof value === "object" && "jobId" in value) {
        const job = String(value.jobId); run.jobs.add(job);
        return host.awaitJob(job, (value: unknown) => {
          run.jobs.delete(job);
          if (run.cancelled) return { status: "cancelled", output: null } as AgentTaskResult;
          try { result(call, JSON.stringify(value).slice(0, 32768)); return calls(queue); } catch (e) { return fail(e); }
        });
      }
      result(call, JSON.stringify(value).slice(0, 32768));
      return calls(queue);
    } catch (e) { return fail(e); }
  }
  function next(): AgentTaskResult {
    if (run.cancelled) return { status: "cancelled", output: null };
    if (host.unixNowMs() >= run.deadline) return finish(input.runId, { status: "deadline_exceeded", output: null, error: "task deadline exceeded" });
    if (++run.turns > profile.budgets.turns || run.tokens >= profile.budgets.tokens) return fail("task budget exhausted");
    try {
      const key = selected.endpoint.secret ? host.secretGet(selected.endpoint.secret) : null;
      if (selected.endpoint.secret && !key) throw new Error("endpoint secret unavailable");
      const opts = request(selected.endpoint, profile, history.turns, key, profile.budgets.tokens - run.tokens);
      opts.timeoutMs = Math.max(1, Math.min(opts.timeoutMs, run.deadline - host.unixNowMs()));
      const started = JSON.parse(host.fetchStart(JSON.stringify(opts))) as { jobId?: string; error?: string };
      if (!started.jobId) throw new Error(started.error || "request start failed");
      const job = started.jobId; run.jobs.add(job);
      return host.awaitJob(job, (value: FetchResult) => {
        run.jobs.delete(job);
        if (run.cancelled) return { status: "cancelled", output: null } as AgentTaskResult;
        try {
          if (host.unixNowMs() >= run.deadline) return finish(input.runId, { status: "deadline_exceeded", output: null, error: "task deadline exceeded" });
          if (value.error || !value.status || value.status < 200 || value.status >= 300) throw new Error(value.error || `endpoint HTTP ${value.status}`);
          const { turn, tokens } = response(value.body || ""); run.tokens += tokens;
          if (run.tokens > profile.budgets.tokens) throw new Error("task token budget exhausted");
          history.turns.push(turn); save(history);
          if (turn.toolCalls?.length) return calls([...turn.toolCalls]);
          let output: unknown = turn.content;
          try { output = JSON.parse(turn.content); } catch {}
          if (JSON.stringify(output).length > 60000) throw new Error("task output exceeds limit");
          return finish(input.runId, { status: "done", output });
        } catch (e) { return fail(e); }
      });
    } catch (e) { return fail(e); }
  }
  return next();
}
