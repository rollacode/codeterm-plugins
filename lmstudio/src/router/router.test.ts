import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicBody,
  anthropicUsage,
  applyAnthropicEvent,
  applyOpenAiEvent,
  authHeaders,
  cacheBreakpoints,
  chatRequest,
  classifyFetch,
  emptyDelta,
  formatUsage,
  modelsRequests,
  normalizeTurns,
  openAiBody,
  openAiUsage,
  redact,
  splitSse,
} from "./adapters";
import {
  apiRoot,
  coerceState,
  defaultProviderId,
  emptyState,
  hostOf,
  keyRequired,
  normalizeBaseUrl,
  normalizeKind,
  resolvePresets,
  resolveProviders,
  validatePreset,
  validateProvider,
} from "./config";
import { capabilityBadges, formatContext, groupAndSearch, matchScore, parseModelList } from "./models";
import { presetModelId, presetParams, qualifyModel, resolveModelTarget, splitModelId } from "./routing";
import { parseArgs } from "./verbs";
import type { ChatTurn, ProviderConfig } from "./types";

const provider = (over: Partial<ProviderConfig>): ProviderConfig => ({
  id: "p",
  name: "P",
  kind: "openai",
  baseUrl: "https://api.example.com/v1",
  apiKeySecret: "p_api_key",
  models: [],
  enabled: true,
  source: "user",
  ...over,
});

test("provider validation accepts a well-formed provider and defaults name and key slot", () => {
  const r = validateProvider({ id: "MiMo", kind: "openai-compatible", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1/" }, []);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.id, "mimo");
  assert.equal(r.value.kind, "openai");
  assert.equal(r.value.baseUrl, "https://token-plan-sgp.xiaomimimo.com/v1");
  assert.equal(r.value.apiKeySecret, "mimo_api_key");
  assert.equal(r.value.name, "mimo");
});

test("provider validation reports every bad field with a field name", () => {
  const r = validateProvider({ id: "Bad Id!", kind: "gopher", baseUrl: "ftp://x" }, []);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(r.errors.map((e) => e.field).sort(), ["baseUrl", "id", "kind"]);
});

test("provider validation refuses a taken id and a malformed key slot", () => {
  const taken = validateProvider({ id: "lmstudio", kind: "openai", baseUrl: "http://x:1" }, ["lmstudio"]);
  assert.equal(taken.ok, false);
  const slot = validateProvider({ id: "a", kind: "openai", baseUrl: "http://x:1", apiKeySecret: "has space" }, []);
  assert.equal(slot.ok, false);
});

test("static model ids parse from lists or comma strings without duplicates", () => {
  const r = validateProvider({ id: "a", kind: "anthropic", baseUrl: "https://x/anthropic", models: " m1, m2 ,m1,," }, []);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value.models, ["m1", "m2"]);
  const l = validateProvider({ id: "b", kind: "anthropic", baseUrl: "https://x/anthropic", models: ["m3", 4, "m3"] }, []);
  if (l.ok) assert.deepEqual(l.value.models, ["m3"]);
});

test("kind aliases normalize and unknown kinds are rejected", () => {
  assert.equal(normalizeKind("Anthropic-Compatible"), "anthropic");
  assert.equal(normalizeKind("lm-studio"), "lmstudio");
  assert.equal(normalizeKind("gemini"), null);
});

test("base URLs normalize and reject credentials, schemes and junk", () => {
  assert.equal(normalizeBaseUrl(" http://localhost:1234/ "), "http://localhost:1234");
  assert.equal(normalizeBaseUrl("https://user:pw@host/v1"), null);
  assert.equal(normalizeBaseUrl("file:///etc"), null);
  assert.equal(hostOf("https://Token-Plan-Sgp.xiaomimimo.com/anthropic"), "token-plan-sgp.xiaomimimo.com");
  assert.equal(hostOf("http://eight.ts.net:1234/x"), "eight.ts.net:1234");
});

test("api roots follow each SDK's base URL convention", () => {
  assert.equal(apiRoot({ kind: "openai", baseUrl: "http://localhost:11434" }), "http://localhost:11434/v1");
  assert.equal(apiRoot({ kind: "openai", baseUrl: "https://openrouter.ai/api/v1" }), "https://openrouter.ai/api/v1");
  assert.equal(apiRoot({ kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" }), "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(apiRoot({ kind: "anthropic", baseUrl: "https://api.anthropic.com" }), "https://api.anthropic.com/v1");
  assert.equal(apiRoot({ kind: "anthropic", baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic" }), "https://token-plan-sgp.xiaomimimo.com/anthropic/v1");
  assert.equal(apiRoot({ kind: "anthropic", baseUrl: "https://x.test/v1" }), "https://x.test/v1");
  assert.equal(apiRoot({ kind: "lmstudio", baseUrl: "http://localhost:1234/api/v1" }), "http://localhost:1234");
  assert.equal(apiRoot({ kind: "lmstudio", baseUrl: "http://localhost:1234/v1" }), "http://localhost:1234");
});

test("legacy settings migrate to an implicit LM Studio provider", () => {
  const { providers, issues } = resolveProviders({ baseUrl: "http://eight.ts.net:1234/" }, emptyState());
  assert.equal(issues.length, 0);
  assert.equal(providers.length, 1);
  assert.deepEqual(
    { id: providers[0].id, kind: providers[0].kind, baseUrl: providers[0].baseUrl, source: providers[0].source },
    { id: "lmstudio", kind: "lmstudio", baseUrl: "http://eight.ts.net:1234", source: "builtin" },
  );
  assert.equal(resolveProviders({}, emptyState()).providers[0].baseUrl, "http://localhost:1234");
});

test("declared and user providers merge; user entries cannot shadow declared ids; disabled applies", () => {
  const state = coerceState({
    providers: [
      { id: "openrouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1" },
      { id: "mimo", kind: "openai", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
    ],
    disabled: ["lmstudio"],
  });
  const { providers, issues } = resolveProviders({ providers: [{ id: "openrouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1" }] }, state);
  assert.deepEqual(providers.map((p) => `${p.id}:${p.source}:${p.enabled}`), ["lmstudio:builtin:false", "openrouter:config:true", "mimo:user:true"]);
  assert.equal(issues.length, 1);
  assert.equal(defaultProviderId({}, state, providers), "openrouter");
});

test("coerceState tolerates garbage", () => {
  assert.deepEqual(coerceState(null), emptyState());
  assert.deepEqual(coerceState({ providers: "x", presets: [1, null, {}], disabled: [1, "a"] }), { providers: [], presets: [{}], disabled: ["a"] });
});

test("keys are required for hosted APIs only", () => {
  assert.equal(keyRequired({ kind: "anthropic", baseUrl: "http://localhost:9" }), true);
  assert.equal(keyRequired({ kind: "lmstudio", baseUrl: "https://remote.example" }), false);
  assert.equal(keyRequired({ kind: "openai", baseUrl: "http://localhost:11434/v1" }), false);
  assert.equal(keyRequired({ kind: "openai", baseUrl: "http://192.168.1.5:8000/v1" }), false);
  assert.equal(keyRequired({ kind: "openai", baseUrl: "https://openrouter.ai/api/v1" }), true);
});

test("preset validation maps knobs and rejects out-of-range values", () => {
  const ok = validatePreset({ id: "fast", provider: "MiMo", model: "mimo-v2.6-flash", temperature: "0.2", maxTokens: 512 }, []);
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual([ok.value.provider, ok.value.temperature, ok.value.maxTokens, ok.value.name], ["mimo", 0.2, 512, "fast"]);
  const bad = validatePreset({ id: "x", temperature: 3, maxTokens: 1.5 }, []);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.errors.map((e) => e.field).sort(), ["maxTokens", "temperature"]);
});

test("presets resolve from config then user state with unique ids", () => {
  const presets = resolvePresets(
    { presets: [{ id: "codeterm", name: "CodeTerm", params: { temperature: 0.7 } }] },
    coerceState({ presets: [{ id: "codeterm", name: "dupe" }, { id: "mimo-fast", provider: "mimo", model: "mimo-v2.6-flash" }] }),
  );
  assert.deepEqual(presets.map((p) => `${p.id}:${p.source}`), ["codeterm:config", "mimo-fast:user"]);
});

test("model ids qualify outside the LM Studio namespace and split on the first separator", () => {
  assert.equal(qualifyModel("lmstudio", "qwen/qwen3-8b"), "qwen/qwen3-8b");
  assert.equal(qualifyModel("openrouter", "anthropic/claude-sonnet"), "openrouter::anthropic/claude-sonnet");
  assert.deepEqual(splitModelId("ollama::llama3:8b"), { providerId: "ollama", model: "llama3:8b" });
  assert.deepEqual(splitModelId("llama3:8b"), { providerId: null, model: "llama3:8b" });
});

test("request routing picks the provider from the id, the preset, or the bare namespace", () => {
  const providers = [provider({ id: "lmstudio", kind: "lmstudio", baseUrl: "http://localhost:1234" }), provider({ id: "mimo" }), provider({ id: "off", enabled: false })];
  assert.equal(resolveModelTarget("mimo::mimo-v2.6-pro", providers, "lmstudio").provider?.id, "mimo");
  assert.equal(resolveModelTarget("mimo::mimo-v2.6-pro", providers, "lmstudio").model, "mimo-v2.6-pro");
  assert.equal(resolveModelTarget("qwen", providers, "mimo").provider?.id, "lmstudio");
  assert.equal(resolveModelTarget("", providers, "lmstudio", "mimo").provider?.id, "mimo");
  assert.match(resolveModelTarget("nope::m", providers, "lmstudio").error || "", /unknown provider/);
  assert.match(resolveModelTarget("off::m", providers, "lmstudio").error || "", /disabled/);
  const noLm = [provider({ id: "mimo" }), provider({ id: "groq" })];
  assert.equal(resolveModelTarget("bare", noLm, "groq").provider?.id, "groq");
});

test("preset model ids and params resolve onto the wire", () => {
  assert.equal(presetModelId({ provider: "mimo", model: "mimo-v2.6-pro" }), "mimo::mimo-v2.6-pro");
  assert.equal(presetModelId({ provider: "lmstudio", model: "qwen" }), "qwen");
  assert.equal(presetModelId({ model: "groq::llama" }), "groq::llama");
  assert.deepEqual(presetParams({ id: "x", name: "x", source: "user", temperature: 0.3, maxTokens: 99, params: { top_p: 0.9 } }), { top_p: 0.9, temperature: 0.3, max_tokens: 99 });
});

test("model lists parse every supported shape with capabilities", () => {
  const openrouter = parseModelList("openrouter", {
    data: [
      { id: "anthropic/claude", name: "Claude", context_length: 200000, architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools", "reasoning"] },
      { id: "text-embedding-3", object: "model" },
    ],
  });
  assert.equal(openrouter.length, 1);
  assert.deepEqual(capabilityBadges(openrouter[0].capabilities), ["200k", "vision", "tools", "reasoning"]);

  const v0 = parseModelList("lmstudio", { data: [{ id: "qwen", type: "vlm", state: "loaded", max_context_length: 32768, capabilities: ["tool_use"] }, { id: "nomic-embed", type: "embeddings" }] });
  assert.deepEqual(v0.map((m) => [m.id, m.loaded, capabilityBadges(m.capabilities).join(" ")]), [["qwen", true, "33k vision tools"]]);

  const v1 = parseModelList("lmstudio", { models: [{ key: "llama", display_name: "Llama", loaded_instances: [] }, { bogus: true }] });
  assert.deepEqual(v1.map((m) => [m.id, m.displayName, m.loaded]), [["llama", "Llama", false]]);

  const anthropic = parseModelList("mimo", { data: [{ id: "mimo-v2.6-pro", display_name: "MiMo Pro", type: "model" }] });
  assert.equal(anthropic[0].displayName, "MiMo Pro");
  assert.deepEqual(parseModelList("x", "nope"), []);
  assert.equal(formatContext(1_048_576), "1M");
});

test("search ranks exact and prefix matches first and requires every token", () => {
  const models = parseModelList("mimo", { data: [{ id: "mimo-v2.6-flash" }, { id: "mimo-v2.6-pro" }, { id: "pro-mimo" }] });
  const sections = groupAndSearch([{ id: "mimo", name: "Xiaomi MiMo", kind: "openai" }, { id: "empty", name: "Empty", kind: "openai" }], models, "pro");
  assert.deepEqual(sections[0].models.map((m) => m.id), ["pro-mimo", "mimo-v2.6-pro"]);
  assert.equal(sections[0].total, 3);
  assert.deepEqual(sections[1].models, []);
  assert.equal(matchScore(models[0], "Xiaomi MiMo", "xiaomi flash") > 0, true);
  assert.equal(matchScore(models[0], "Xiaomi MiMo", "flash zzz"), 0);
  assert.deepEqual(groupAndSearch([{ id: "mimo", name: "M", kind: "openai" }], models, "  ")[0].models.length, 3);
});

test("Anthropic cache breakpoints sit on the system block and the turn before the newest user message", () => {
  const turns: ChatTurn[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  assert.deepEqual(cacheBreakpoints(true, turns), { system: true, messageIndex: 1 });
  assert.deepEqual(cacheBreakpoints(false, turns.slice(0, 1)), { system: false, messageIndex: -1 });
  assert.deepEqual(cacheBreakpoints(true, turns.slice(0, 2)), { system: true, messageIndex: -1 });

  const body = anthropicBody({ model: "m", system: "S", turns, params: { temperature: 0.1 } });
  const marked = JSON.stringify(body).split("cache_control").length - 1;
  assert.equal(marked, 2, "two breakpoints, under the API maximum of 4");
  const messages = body.messages as { content: { cache_control?: unknown }[] }[];
  assert.ok(messages[1].content[0].cache_control);
  assert.equal(messages[2].content[0].cache_control, undefined);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.temperature, 0.1);
});

test("turn normalization merges same-role neighbours and drops a leading assistant", () => {
  assert.deepEqual(
    normalizeTurns([
      { role: "assistant", content: "x" },
      { role: "user", content: "a" },
      { role: "user", content: "tool_result:\nok" },
      { role: "assistant", content: "" },
    ]),
    [{ role: "user", content: "a\n\ntool_result:\nok" }],
  );
});

test("request builders put keys only in headers and follow each wire format", () => {
  const anth = chatRequest(provider({ kind: "anthropic", baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic" }), "sk-secret", { model: "m", system: "", turns: [{ role: "user", content: "hi" }], params: {} });
  assert.equal(anth.url, "https://token-plan-sgp.xiaomimimo.com/anthropic/v1/messages");
  assert.equal(anth.headers["x-api-key"], "sk-secret");
  assert.equal(anth.headers["anthropic-version"], "2023-06-01");
  assert.ok(!(anth.body || "").includes("sk-secret"));

  const oai = chatRequest(provider({}), "sk-secret", { model: "m", system: "sys", turns: [{ role: "user", content: "hi" }], params: { max_tokens: 5 } });
  assert.equal(oai.url, "https://api.example.com/v1/chat/completions");
  assert.equal(oai.headers.authorization, "Bearer sk-secret");
  const body = openAiBody({ model: "m", system: "sys", turns: [{ role: "user", content: "hi" }], params: { max_tokens: 5 } });
  assert.deepEqual(body.messages, [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_tokens, 5);
  assert.deepEqual(authHeaders({ kind: "lmstudio" }, null), { "content-type": "application/json" });
  assert.deepEqual(modelsRequests(provider({ kind: "lmstudio", baseUrl: "http://h:1234" }), null).map((r) => r.url), ["http://h:1234/api/v0/models", "http://h:1234/api/v1/models", "http://h:1234/v1/models"]);
});

test("SSE splitting keeps a partial tail until flush", () => {
  const first = splitSse('event: message_start\ndata: {"a":1}\n\ndata: {"b"', false);
  assert.deepEqual(first.events, [{ event: "message_start", data: '{"a":1}' }]);
  assert.equal(first.rest, 'data: {"b"');
  assert.deepEqual(splitSse(first.rest + ":2}", true).events, [{ event: "", data: '{"b":2}' }]);
});

test("OpenAI stream events accumulate content, reasoning, usage and errors", () => {
  const acc = emptyDelta();
  applyOpenAiEvent(acc, { event: "", data: '{"id":"c1","choices":[{"delta":{"reasoning_content":"think "}}]}' });
  applyOpenAiEvent(acc, { event: "", data: '{"choices":[{"delta":{"content":"O"}}]}' });
  applyOpenAiEvent(acc, { event: "", data: '{"choices":[{"delta":{"content":"K"}}],"usage":{"prompt_tokens":1200,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":1024}}}' });
  applyOpenAiEvent(acc, { event: "", data: "[DONE]" });
  assert.deepEqual([acc.content, acc.reasoning, acc.responseId], ["OK", "think ", "c1"]);
  assert.deepEqual(acc.usage, { input: 1200, cachedInput: 1024, cacheWrite: 0, output: 2 });
  applyOpenAiEvent(acc, { event: "", data: '{"error":{"message":"rate limited"}}' });
  assert.equal(acc.error, "rate limited");
});

test("Anthropic stream events accumulate text and cache usage across message_start and message_delta", () => {
  const acc = emptyDelta();
  applyAnthropicEvent(acc, { event: "message_start", data: '{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":12,"cache_read_input_tokens":2048,"cache_creation_input_tokens":0,"output_tokens":1}}}' });
  applyAnthropicEvent(acc, { event: "content_block_delta", data: '{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}' });
  applyAnthropicEvent(acc, { event: "content_block_delta", data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}' });
  applyAnthropicEvent(acc, { event: "message_delta", data: '{"type":"message_delta","usage":{"output_tokens":3}}' });
  assert.deepEqual([acc.content, acc.reasoning, acc.responseId], ["OK", "hm", "msg_1"]);
  assert.deepEqual(acc.usage, { input: 2060, cachedInput: 2048, cacheWrite: 0, output: 3 });
  applyAnthropicEvent(acc, { event: "error", data: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' });
  assert.equal(acc.error, "Overloaded");
});

test("usage normalizes both formats and formats cached vs fresh input", () => {
  assert.deepEqual(anthropicUsage({ input_tokens: 10, cache_creation_input_tokens: 1500, cache_read_input_tokens: 0, output_tokens: 4 }), { input: 1510, cachedInput: 0, cacheWrite: 1500, output: 4 });
  assert.deepEqual(openAiUsage({ prompt_tokens: 100, completion_tokens: 3, prompt_cache_hit_tokens: 64 }), { input: 100, cachedInput: 64, cacheWrite: 0, output: 3 });
  assert.equal(openAiUsage({}), null);
  assert.equal(formatUsage({ input: 1200, cachedInput: 1024, cacheWrite: 0, output: 2 }), "1,200 in · 1,024 cached · 176 fresh · 2 out");
  assert.equal(formatUsage({ input: 50, cachedInput: 0, cacheWrite: 0, output: 9 }), "50 in · 9 out");
});

test("fetch failures classify into typed errors with an allow-host hint", () => {
  assert.equal(classifyFetch("https://a.b/v1/models", { status: 200, body: "{}" }), null);
  const denied = classifyFetch("https://token-plan-sgp.xiaomimimo.com/v1/models", { error: "fetch denied: token-plan-sgp.xiaomimimo.com" });
  assert.equal(denied?.kind, "denied");
  assert.match(denied?.message || "", /--allow-host token-plan-sgp\.xiaomimimo\.com/);
  assert.equal(classifyFetch("http://x/v1", { error: "request timed out" })?.kind, "timeout");
  assert.equal(classifyFetch("http://x/v1", { error: "connection refused" })?.kind, "unreachable");
  assert.equal(classifyFetch("http://x/v1", { status: 401, body: '{"error":{"message":"invalid x-api-key"}}' })?.kind, "auth");
  assert.equal(classifyFetch("http://x/v1", { status: 404, body: "" })?.kind, "not_found");
  assert.equal(classifyFetch("http://x/v1", { status: 500, body: "boom" })?.message, "HTTP 500: boom");
  assert.equal(
    classifyFetch("http://x/v1", { status: 404, body: "<html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1><hr>openresty</body></html>" })?.message,
    "Endpoint not found (HTTP 404): 404 Not Found openresty",
  );
});

test("redaction strips a key echoed back by a server", () => {
  assert.equal(redact("bad key sk-abc123 used", "sk-abc123"), "bad key [redacted] used");
  assert.equal(redact("text", null), "text");
});

test("agent verb args parse flags with values, equals and booleans", () => {
  assert.deepEqual(parseArgs(["mimo", "openai", "https://x/v1", "--name", "Xiaomi MiMo", "--key-slot=mimo_api_key", "--refresh"]), {
    positional: ["mimo", "openai", "https://x/v1"],
    flags: { name: "Xiaomi MiMo", "key-slot": "mimo_api_key", refresh: true },
  });
});
