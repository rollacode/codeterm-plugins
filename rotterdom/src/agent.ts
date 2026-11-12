import { ioValue, ioEncoded, ioThen, type HostIoSteps, type HostIoResult } from "@codeterm/plugin-sdk";
import type { AgentTaskInput, AgentTaskResult, FetchResult } from "@codeterm/plugin-sdk";
import { resolve } from "./config";
import { endpointKey, request, response } from "./adapters";
import { claim, complete, load, recover, save, type History } from "./history";
import { execute } from "./runtime";
import type { NativeToolCall } from "./types";

interface Run { history: History; deadline: number; jobs: Set<string>; tokens: number; turns: number; cancelled: boolean }
const runs = new Map<string, Run>();

function* finish(runId: string, result: AgentTaskResult): HostIoSteps<AgentTaskResult> {
  const run = runs.get(runId)!;
  run.history.taskResult = result;
  try { (yield* save(run.history)); } finally { runs.delete(runId); }
  return result;
}

export function* abortAgentTask(runId: string): HostIoSteps<void> {
  const run = runs.get(runId);
  if (!run) return;
  run.cancelled = true;
  for (const job of run.jobs) (yield* ioValue<HostIoResult<"execClose">>({ op: "execClose", job: job }));
  recover(run.history);
  (yield* finish(runId, { status: "cancelled", output: null, error: "unfinished tool effects are unconfirmed" }));
}

export function* runAgentTask(input: AgentTaskInput): HostIoSteps<AgentTaskResult> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.runId) || !input.task || input.task.length > 32768 || input.input.length > 32768) throw new Error("invalid agent task");
  const selected = resolve(input.profile);
  const profile = { ...selected.profile, deny: [...selected.profile.deny, "report"], budgets: {
    tokens: Math.min(selected.profile.budgets.tokens, input.maxTokens),
    turns: Math.min(selected.profile.budgets.turns, input.maxTurns),
    deadlineMs: Math.min(selected.profile.budgets.deadlineMs, input.timeoutMs),
  } };
  for (const budget of Object.values(profile.budgets)) if (!Number.isInteger(budget) || budget <= 0) throw new Error("invalid task budget");
  const id = `task_${input.runId}`;
  const previous = (yield* load(id));
  if (previous) return previous.taskResult || { status: "failed", output: null, error: "existing task outcome unconfirmed; never replayed" };
  const history: History = { version: 1, id, profile, turns: [{ role: "user", content: input.task },
    ...(input.input ? [{ role: "user" as const, content: input.input }] : [])], ledger: {}, run: 1 };
  const run: Run = { history, deadline: host.unixNowMs() + profile.budgets.deadlineMs, jobs: new Set(), tokens: 0, turns: 0, cancelled: false };
  (yield* save(history));
  runs.set(input.runId, run);
  const fail = function* (e: unknown): HostIoSteps<AgentTaskResult> { return (yield* finish(input.runId, { status: "failed", output: null, error: String(e) })); };
  function* result(call: NativeToolCall, raw: string): HostIoSteps<void> {
    complete(history, call.id, raw);
    history.turns.push({ role: "tool", toolCallId: call.id, content: raw });
    (yield* save(history));
  }
  function* calls(queue: NativeToolCall[]): HostIoSteps<AgentTaskResult> {
    if (run.cancelled) return { status: "cancelled", output: null };
    if (host.unixNowMs() >= run.deadline) return (yield* finish(input.runId, { status: "deadline_exceeded", output: null, error: "task deadline exceeded" }));
    const call = queue.shift();
    if (!call) return (yield* next());
    try {
      const old = claim(history, call.id, `${call.name}:${call.arguments}`);
      if (old !== null) { history.turns.push({ role: "tool", toolCallId: call.id, content: old }); (yield* save(history)); return (yield* calls(queue)); }
      (yield* save(history));
      let value: unknown;
      try { value = (yield* execute(profile, call.name, JSON.parse(call.arguments), run.deadline)); }
      catch (e) { value = { error: String(e) }; }
      if (value && typeof value === "object" && "jobId" in value) {
        const job = String(value.jobId); run.jobs.add(job);
        return yield* ioThen(ioValue<unknown>({ op: "awaitJob", job }), function* (value: unknown): HostIoSteps<AgentTaskResult> {
          run.jobs.delete(job);
          if (run.cancelled) return { status: "cancelled", output: null } as AgentTaskResult;
          try { (yield* result(call, JSON.stringify(value).slice(0, 32768))); return (yield* calls(queue)); } catch (e) { return (yield* fail(e)); }
        });
      }
      (yield* result(call, JSON.stringify(value).slice(0, 32768)));
      return (yield* calls(queue));
    } catch (e) { return (yield* fail(e)); }
  }
  function* next(): HostIoSteps<AgentTaskResult> {
    if (run.cancelled) return { status: "cancelled", output: null };
    if (host.unixNowMs() >= run.deadline) return (yield* finish(input.runId, { status: "deadline_exceeded", output: null, error: "task deadline exceeded" }));
    if (++run.turns > profile.budgets.turns || run.tokens >= profile.budgets.tokens) return (yield* fail("task budget exhausted"));
    try {
      const key = (yield* endpointKey(selected.endpoint));
      const opts = (yield* request(selected.endpoint, profile, history.turns, key, profile.budgets.tokens - run.tokens));
      opts.timeoutMs = Math.max(1, Math.min(opts.timeoutMs, run.deadline - host.unixNowMs()));
      const started = JSON.parse((yield* ioEncoded(ioValue<HostIoResult<"fetchStart">>({ op: "fetchStart", options: opts })))) as { jobId?: string; error?: string };
      if (!started.jobId) throw new Error(started.error || "request start failed");
      const job = started.jobId; run.jobs.add(job);
      return yield* ioThen(ioValue<FetchResult>({ op: "awaitJob", job }), function* (value: FetchResult): HostIoSteps<AgentTaskResult> {
        run.jobs.delete(job);
        if (run.cancelled) return { status: "cancelled", output: null } as AgentTaskResult;
        try {
          if (host.unixNowMs() >= run.deadline) return (yield* finish(input.runId, { status: "deadline_exceeded", output: null, error: "task deadline exceeded" }));
          if (value.error || !value.status || value.status < 200 || value.status >= 300) throw new Error(value.error || `endpoint HTTP ${value.status}`);
          const { turn, tokens } = response(value.body || ""); run.tokens += tokens;
          if (run.tokens > profile.budgets.tokens) throw new Error("task token budget exhausted");
          history.turns.push(turn); (yield* save(history));
          if (turn.toolCalls?.length) return (yield* calls([...turn.toolCalls]));
          let output: AgentTaskResult["output"] = turn.content;
          try { output = JSON.parse(turn.content); } catch {}
          if (JSON.stringify(output).length > 60000) throw new Error("task output exceeds limit");
          return (yield* finish(input.runId, { status: "done", output }));
        } catch (e) { return (yield* fail(e)); }
      });
    } catch (e) { return (yield* fail(e)); }
  }
  return (yield* next());
}
