import assert from "node:assert/strict";
import test from "node:test";
import {
  basePermission,
  buildEngineConfig,
  compactionSettings,
  configFingerprint,
  COMPACTION_DEFAULTS,
  engineKeyEnv,
  keyEnvName,
  ocModelRef,
  ocModelString,
  sessionPermission,
} from "./config";
import { applyEngineEvent, errorText, messagesToRows, newEngineView, rowId } from "./events";
import { canonicalToolFields, partToChatMsg } from "./parts";
import { base64Ascii, LAUNCH_SCRIPT, scanLaunchLog } from "./server";
import type { ProviderConfig, RouterModel } from "../router/types";

const provider = (over: Partial<ProviderConfig>): ProviderConfig => ({
  id: "mimo",
  name: "Xiaomi MiMo",
  kind: "openai",
  baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
  apiKeySecret: "mimo_api_key",
  models: [],
  enabled: true,
  source: "user",
  ...over,
});

const model = (id: string, contextLength?: number): RouterModel => ({ providerId: "mimo", id, displayName: id.toUpperCase(), capabilities: { contextLength } });

test("compaction settings default to 70% of the window, the session model and 6 verbatim turns", () => {
  assert.deepEqual(compactionSettings({}), COMPACTION_DEFAULTS);
  assert.deepEqual(COMPACTION_DEFAULTS, { thresholdPct: 70, model: null, keepTurns: 6 });
  assert.deepEqual(compactionSettings({ compactThreshold: "85", compactModel: " mimo::mimo-v2-flash ", compactKeepTurns: 3 }), {
    thresholdPct: 85,
    model: "mimo::mimo-v2-flash",
    keepTurns: 3,
  });
  assert.deepEqual(compactionSettings({ compactThreshold: 500, compactKeepTurns: -2, compactModel: "" }), { thresholdPct: 95, model: null, keepTurns: 0 });
  assert.equal(compactionSettings({ compactThreshold: "lots" }).thresholdPct, 70, "garbage falls back to the default");
});

test("each router kind becomes an OpenCode provider with the key referenced by env name only", () => {
  const providers = [
    { provider: provider({}), models: [model("mimo-v2.6-pro", 262144)], extraModels: ["mimo-v2.6-pro"], hasKey: true },
    { provider: provider({ id: "claude", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKeySecret: "anthropic_api_key" }), models: [], extraModels: ["claude-sonnet-4-5"], hasKey: true },
    { provider: provider({ id: "lmstudio", name: "LM Studio", kind: "lmstudio", baseUrl: "http://localhost:1234", apiKeySecret: "lmstudio_api_key" }), models: [], extraModels: ["qwen3-coder"], hasKey: false },
  ];
  const cfg = buildEngineConfig({ providers, compaction: COMPACTION_DEFAULTS, defaultProvider: "lmstudio" }) as Record<string, any>;
  assert.deepEqual(cfg.enabled_providers, ["router-mimo", "router-claude", "router-lmstudio"], "only router providers load");
  assert.equal(cfg.provider["router-mimo"].npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.provider["router-mimo"].options.baseURL, "https://token-plan-sgp.xiaomimimo.com/v1");
  assert.equal(cfg.provider["router-mimo"].options.apiKey, "{env:ROUTER_KEY_MIMO}");
  assert.equal(cfg.provider["router-claude"].npm, "@ai-sdk/anthropic");
  assert.equal(cfg.provider["router-claude"].options.baseURL, "https://api.anthropic.com/v1");
  assert.equal(cfg.provider["router-lmstudio"].npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.provider["router-lmstudio"].options.baseURL, "http://localhost:1234/v1", "LM Studio through its OpenAI-compatible /v1");
  assert.equal(cfg.provider["router-lmstudio"].options.apiKey, undefined, "no key reference without a key");
  assert.deepEqual(cfg.provider["router-mimo"].models["mimo-v2.6-pro"].limit, { context: 262144, input: 183500, output: 8192 });
  assert.equal(cfg.provider["router-claude"].models["claude-sonnet-4-5"].limit.context, 128000, "unknown windows get the default");
  assert.deepEqual(cfg.compaction, { auto: true, reserved: 0, tail_turns: 6 });
  assert.equal(cfg.autoupdate, false);
  assert.equal(cfg.share, "disabled");
  assert.equal(cfg.agent, undefined, "the session model summarizes by default");
});

test("a named summarizer becomes the compaction agent model when its provider is declared", () => {
  const providers = [{ provider: provider({}), models: [], extraModels: ["mimo-v2.6-pro", "mimo-v2-flash"], hasKey: true }];
  const cfg = buildEngineConfig({ providers, compaction: { thresholdPct: 50, model: "mimo::mimo-v2-flash", keepTurns: 2 }, defaultProvider: "lmstudio" }) as Record<string, any>;
  assert.deepEqual(cfg.agent, { compaction: { model: "router-mimo/mimo-v2-flash" } });
  assert.equal(cfg.provider["router-mimo"].models["mimo-v2-flash"].limit.input, 64000, "threshold applies per model window");
  const orphan = buildEngineConfig({ providers, compaction: { thresholdPct: 50, model: "nowhere::x", keepTurns: 2 }, defaultProvider: "lmstudio" }) as Record<string, any>;
  assert.equal(orphan.agent, undefined, "an undeclared summarizer provider is dropped instead of breaking compaction");
});

test("model refs map router ids to OpenCode provider/model ids", () => {
  assert.deepEqual(ocModelRef("mimo", "mimo-v2.6-pro"), { providerID: "router-mimo", modelID: "mimo-v2.6-pro" });
  assert.equal(ocModelString("mimo::mimo-v2.6-pro", "lmstudio"), "router-mimo/mimo-v2.6-pro");
  assert.equal(ocModelString("qwen/qwen3-coder", "lmstudio"), "router-lmstudio/qwen/qwen3-coder", "bare ids belong to the default provider");
  assert.equal(keyEnvName("custom-1"), "ROUTER_KEY_CUSTOM_1");
});

test("keys travel as env values, and the fingerprint changes with a key without containing it", () => {
  const env = engineKeyEnv([{ provider: provider({}), key: "tp-secret-1" }, { provider: provider({ id: "lmstudio" }), key: null }]);
  assert.deepEqual(env, { ROUTER_KEY_MIMO: "tp-secret-1" });
  const md5 = (s: string) => String(s.length) + s.split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16);
  const a = configFingerprint("{}", env, md5);
  const b = configFingerprint("{}", { ROUTER_KEY_MIMO: "tp-secret-2" }, md5);
  assert.notEqual(a, b);
  assert.ok(!a.includes("tp-secret-1"));
});

test("permissions never ask: confinement denies outside paths and env files, shell off denies bash", () => {
  const base = basePermission() as Record<string, unknown>;
  assert.equal(base.external_directory, "deny");
  assert.equal(base.question, "deny");
  assert.equal(base.doom_loop, "deny");
  assert.ok(!JSON.stringify(base).includes('"ask"'), "no ask anywhere in the base rules");
  const on = sessionPermission(true);
  const off = sessionPermission(false);
  assert.ok(on.some((r) => r.permission === "external_directory" && r.pattern === "*" && r.action === "deny"));
  assert.ok(!on.some((r) => r.permission === "bash"), "shell on keeps bash");
  assert.deepEqual(off.filter((r) => r.permission === "bash"), [{ permission: "bash", pattern: "*", action: "deny" }]);
  assert.ok(on.concat(off).every((r) => r.action === "allow" || r.action === "deny"));
});

test("an OpenCode edit part renders as an edit row with the diff pair", () => {
  const row = partToChatMsg(
    {
      type: "tool",
      tool: "edit",
      callID: "call_1",
      state: { status: "completed", input: { filePath: "hello.txt", oldString: "line two", newString: "line 2" }, output: "Edit applied successfully." },
    },
    "assistant",
    "oc-prt_1",
    5,
  ) as Record<string, unknown>;
  assert.equal(row.type, "tool_call");
  assert.equal(row.toolName, "edit");
  assert.equal(row.toolKind, "edit");
  assert.deepEqual(row.toolEdits, [{ path: "hello.txt", old: "line two", new: "line 2" }]);
  assert.deepEqual(row.toolInput, { filePath: "hello.txt", oldString: "line two", newString: "line 2" });
  assert.equal(row.toolResult, "Edit applied successfully.");
});

test("a refused tool call keeps its error visible on the row", () => {
  const row = partToChatMsg(
    { type: "tool", tool: "read", state: { status: "error", input: { filePath: "../x" }, error: "The user has specified a rule which prevents you from using this specific tool call." } },
    "assistant",
    "oc-prt_2",
    1,
  ) as Record<string, unknown>;
  assert.equal(row.toolError, true);
  assert.match(String(row.toolResult), /prevents you/);
});

test("write and multiedit map to edit diffs", () => {
  assert.deepEqual(canonicalToolFields("write", { filePath: "new.ts", content: "export {}\n" }).edits, [{ path: "new.ts", old: "", new: "export {}\n" }]);
  assert.deepEqual(canonicalToolFields("multiedit", { filePath: "a.ts", edits: [{ oldString: "a", newString: "b" }, { oldString: "c", newString: "d" }] }).edits, [
    { path: "a.ts", old: "a", new: "b" },
    { path: "a.ts", old: "c", new: "d" },
  ]);
  assert.equal(canonicalToolFields("bash", { command: "ls" }).kind, "command");
});

const S = "ses_1";
const ev = (type: string, properties: Record<string, unknown>) => ({ id: "evt_x", type, properties: { sessionID: S, ...properties } });

test("the event stream folds into rows: deltas grow text, user parts are skipped, other sessions are ignored", () => {
  const view = newEngineView(S);
  assert.deepEqual(applyEngineEvent(view, ev("message.updated", { info: { id: "msg_u", role: "user", time: { created: 1 } } }), 1), []);
  assert.deepEqual(applyEngineEvent(view, ev("message.part.updated", { part: { id: "prt_u", messageID: "msg_u", type: "text", text: "hi" }, time: 1 }), 1), [], "the tab already shows the user's text");
  applyEngineEvent(view, ev("message.updated", { info: { id: "msg_a", role: "assistant", time: { created: 2 } } }), 2);
  const first = applyEngineEvent(view, ev("message.part.updated", { part: { id: "prt_t", messageID: "msg_a", type: "text", text: "Hel" }, time: 3 }), 3);
  assert.equal(first.length, 1);
  const grown = applyEngineEvent(view, ev("message.part.delta", { messageID: "msg_a", partID: "prt_t", field: "text", delta: "lo" }), 4);
  assert.deepEqual(grown.map((e) => (e.kind === "row" ? [e.row.id, e.row.type, e.row.content] : e.kind)), [[rowId("prt_t"), "assistant", "Hello"]]);
  const other = applyEngineEvent(view, { type: "message.part.updated", properties: { sessionID: "ses_child", part: { id: "prt_c", messageID: "m", type: "text", text: "sub" } } }, 5);
  assert.deepEqual(other, [], "subagent sessions do not leak into the tab");
});

test("a delta that arrives before its part is kept until the part shows up", () => {
  const view = newEngineView(S);
  applyEngineEvent(view, ev("message.part.delta", { messageID: "msg_a", partID: "prt_r", field: "text", delta: "Plan the edit." }), 1);
  const out = applyEngineEvent(view, ev("message.part.updated", { part: { id: "prt_r", messageID: "msg_a", type: "reasoning", text: "", time: { start: 1 } } }), 2);
  assert.deepEqual(out.map((e) => (e.kind === "row" ? [e.row.type, e.row.content] : e.kind)), [["thinking", "Plan the edit."]]);
});

test("status, usage, errors and approval requests become effects", () => {
  const view = newEngineView(S);
  assert.deepEqual(applyEngineEvent(view, ev("session.status", { status: { type: "busy" } }), 1), [{ kind: "busy" }]);
  assert.deepEqual(applyEngineEvent(view, ev("session.idle", {}), 1), [{ kind: "idle" }]);
  const usage = applyEngineEvent(view, ev("message.updated", { info: { id: "msg_a", role: "assistant", time: { created: 1, completed: 2 }, tokens: { input: 100, output: 7, reasoning: 0, cache: { read: 900, write: 0 } } } }), 2);
  assert.deepEqual(usage, [{ kind: "usage", usage: { messageID: "msg_a", input: 1000, cachedInput: 900, cacheWrite: 0, output: 7 } }]);
  assert.deepEqual(applyEngineEvent(view, ev("message.updated", { info: { id: "msg_a", role: "assistant", time: { created: 1, completed: 2 }, tokens: { input: 100, output: 7, reasoning: 0, cache: { read: 900, write: 0 } } } }), 3), [], "usage once per message");
  const err = applyEngineEvent(view, ev("session.error", { error: { name: "ProviderAuthError", data: { message: "bad key" } } }), 4);
  assert.deepEqual(err, [{ kind: "error", message: "ProviderAuthError: bad key" }]);
  assert.deepEqual(applyEngineEvent(view, ev("session.error", { error: { name: "MessageAbortedError", data: {} } }), 5), [], "Stop is reported by the tab, not as an error");
  assert.deepEqual(applyEngineEvent(view, ev("permission.asked", { id: "per_1", permission: "external_directory", patterns: [], metadata: {}, always: [] }), 6), [
    { kind: "reject", route: "permission", id: "per_1" },
  ]);
  assert.deepEqual(applyEngineEvent(view, ev("question.asked", { id: "que_1", questions: [] }), 6), [{ kind: "reject", route: "question", id: "que_1" }]);
  assert.equal(errorText({ name: "APIError", data: { message: "429" } }), "APIError: 429");
});

test("compaction shows a divider and the summary as a compact-summary row", () => {
  const view = newEngineView(S);
  applyEngineEvent(view, ev("message.updated", { info: { id: "msg_c", role: "user", time: { created: 1 } } }), 1);
  const marker = applyEngineEvent(view, ev("message.part.updated", { part: { id: "prt_k", messageID: "msg_c", type: "compaction", auto: true } }), 1);
  assert.equal(marker.length, 1);
  const row = marker[0].kind === "row" ? marker[0].row : null;
  assert.deepEqual(row && [row.type, row.timelineMarker], ["system", { kind: "context_compaction" }]);
  applyEngineEvent(view, ev("message.updated", { info: { id: "msg_s", role: "assistant", summary: true, mode: "compaction", time: { created: 2 } } }), 2);
  const summary = applyEngineEvent(view, ev("message.part.updated", { part: { id: "prt_s", messageID: "msg_s", type: "text", text: "Goal: add f()." } }), 2);
  const srow = summary[0].kind === "row" ? summary[0].row : null;
  assert.deepEqual(srow && [srow.type, srow.systemSubtype, srow.content], ["system", "compact_summary", "Goal: add f()."]);
});

test("resync rebuilds the current turn's rows from the message list", () => {
  const view = newEngineView(S);
  const rows = messagesToRows(
    view,
    [
      { info: { id: "msg_old", role: "assistant", time: { created: 10 } }, parts: [{ id: "prt_old", messageID: "msg_old", type: "text", text: "old" }] },
      { info: { id: "msg_u", role: "user", time: { created: 100 } }, parts: [{ id: "prt_u", messageID: "msg_u", type: "text", text: "do it" }] },
      { info: { id: "msg_a", role: "assistant", time: { created: 101 } }, parts: [{ id: "prt_a", messageID: "msg_a", type: "text", text: "done" }] },
    ],
    100,
  );
  assert.deepEqual(rows.map((r) => [r.id, r.type, r.content]), [[rowId("prt_a"), "assistant", "done"]]);
});

test("readiness comes from the server's listening line; launcher failures are recognised", () => {
  assert.deepEqual(scanLaunchLog("router-engine: launching 1.18.34\nopencode server listening on http://127.0.0.1:4096\n"), { port: 4096 });
  assert.deepEqual(scanLaunchLog("router-engine: opencode not found on PATH\n"), { failure: "opencode not found on PATH" });
  assert.deepEqual(scanLaunchLog(""), {});
  assert.ok(!/OPENCODE_SERVER_PASSWORD|ROUTER_KEY/.test(LAUNCH_SCRIPT), "no secret is named or spliced into the command text");
});

test("basic auth header encoding", () => {
  assert.equal(base64Ascii("opencode:pw123"), "b3BlbmNvZGU6cHcxMjM=");
  assert.equal(base64Ascii("ab"), "YWI=");
  assert.equal(base64Ascii("a"), "YQ==");
});
