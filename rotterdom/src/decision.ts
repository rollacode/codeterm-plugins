import type { DecisionAnswer, DecisionFailure, DecisionModelCapability, DecisionQuestion, DecisionQuestionsRequest, DecisionRequest, DecisionResponse, FetchResult } from "@codeterm/plugin-sdk";
import { settings } from "./config";
import { endpointKey, endpointRequest, request } from "./adapters";
import type { Endpoint, Profile } from "./types";

let selectedModel = "";
const probability = { type: "number", minimum: 0, maximum: 1 };
function object(properties: Record<string, unknown>) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
function schema(question: DecisionQuestion): Record<string, unknown> {
  const type = { type: "string", enum: [question.type] };
  if (question.type === "noul") return object({ type, p: probability });
  const labels = question.type === "choice" ? Object.keys(question.options) : question.levels.map((_, i) => String(i));
  if (!labels.length) throw new Error("empty decision options");
  return object({ type, ...(question.type === "choice" ? { choice: { type: "string", enum: labels } }
    : { score: { type: "number", minimum: 0, maximum: labels.length - 1 } }),
    probabilities: object(Object.fromEntries(labels.map(key => [key, probability]))), confidence: { type: ["number", "null"], minimum: 0, maximum: 1 } });
}
function validProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function answer(question: DecisionQuestion, value: unknown): DecisionAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid decision answer");
  const a = value as DecisionAnswer;
  if (a.type !== question.type) throw new Error("wrong decision primitive");
  if (a.type === "noul") {
    if (!validProbability(a.p)) throw new Error("invalid noul probability");
    return a;
  }
  const labels = question.type === "choice" ? Object.keys(question.options) : question.type === "score" ? question.levels.map((_, i) => String(i)) : [];
  const probs = a.probabilities;
  if (!probs || typeof probs !== "object" || Array.isArray(probs) || Object.keys(probs).length !== labels.length
    || !labels.every(key => Object.prototype.hasOwnProperty.call(probs, key) && validProbability(probs[key]))
    || Math.abs(Object.values(probs).reduce((sum, p) => sum + p, 0) - 1) > 0.000001
    || (a.confidence !== null && !validProbability(a.confidence))) throw new Error("invalid decision probabilities");
  if (a.type === "choice" && !labels.includes(a.choice)) throw new Error("unknown decision choice");
  if (a.type === "score" && (!Number.isFinite(a.score) || a.score < 0 || a.score > labels.length - 1)) throw new Error("invalid decision score");
  return a;
}
function config(): { endpoint: Endpoint; profile: Profile } {
  const s = settings();
  const p = s.profiles.find(p => p.id === (s.decision?.profile || s.defaultProfile));
  const endpoint = s.endpoints.find(e => e.id === p?.endpoint);
  if (!p || !endpoint) throw new Error("decision profile unavailable");
  if (!Number.isInteger(p.budgets?.deadlineMs) || p.budgets.deadlineMs <= 0 || p.budgets.deadlineMs > 3600000
    || !Number.isInteger(p.budgets?.tokens) || p.budgets.tokens <= 0 || p.budgets.tokens > 1000000) throw new Error("invalid decision budget");
  return { endpoint, profile: { ...p, model: selectedModel || p.model } };
}
function models() {
  try {
    const { endpoint, profile } = config();
    return host.fetch.async({ ...endpointRequest(endpoint, "/models", endpointKey(endpoint)), method: "GET", timeoutMs: Math.min(30000, profile.budgets.deadlineMs) }, result => {
      if (result.error || !result.status || result.status < 200 || result.status >= 300) return [];
      try {
        const data = JSON.parse(result.body || "{}") as { data?: { id?: unknown; name?: unknown }[] };
        const seen = new Set<string>();
        return Array.isArray(data.data) ? data.data.flatMap(item => {
          if (!item || typeof item.id !== "string" || !item.id || seen.has(item.id)) return [];
          seen.add(item.id);
          return [{ id: item.id, display_name: typeof item.name === "string" ? item.name : item.id }];
        }) : [];
      } catch { return []; }
    });
  } catch { return []; }
}
function run<T>(state: unknown, questions: Record<string, { instructions: string; question: DecisionQuestion }>, remainingMs: number | undefined, batch: boolean, decode: (value: unknown, completion: Record<string, unknown>) => T): T | DecisionFailure {
  if (remainingMs !== undefined && (!Number.isFinite(remainingMs) || remainingMs < 1)) return { error: "timeout" };
  let selected: ReturnType<typeof config>;
  let key: string | null;
  try { selected = config(); key = endpointKey(selected.endpoint); } catch { return { error: "unavailable" }; }
  if (!selected.profile.model) return { error: "unavailable" };
  const deadline = host.unixNowMs() + Math.min(remainingMs ?? 30000, selected.profile.budgets.deadlineMs);
  let responseSchema: Record<string, unknown>;
  try {
    const properties = Object.fromEntries(Object.entries(questions).map(([name, spec]) => [name, schema(spec.question)]));
    if (!Object.keys(properties).length) throw new Error("empty questions");
    responseSchema = batch ? object({ answers: object(properties) }) : properties.single as Record<string, unknown>;
  } catch { return { error: "invalid_response" }; }
  try {
    const profile = { ...selected.profile, params: { temperature: 0 }, systemPrompt: "Return only JSON matching the supplied schema. Evaluate each question using the shared state. Probabilities must sum to one; confidence is your estimated certainty, or null when unknown." };
    const opts = request(selected.endpoint, profile, [{ role: "user", content: JSON.stringify({ state, questions }) }], key, Math.min(4096, profile.budgets.tokens), false);
    const body = JSON.parse(opts.body) as Record<string, unknown>;
    body.response_format = { type: "json_schema", json_schema: { name: "domios_decision", strict: true, schema: responseSchema } };
    opts.body = JSON.stringify(body);
    opts.timeoutMs = Math.floor(deadline - host.unixNowMs());
    if (opts.timeoutMs < 1) return { error: "timeout" };
    return host.fetch.async(opts, (result: FetchResult): T | DecisionFailure => {
      if (host.unixNowMs() >= deadline || /timeout|timed out|deadline/i.test(result.error || "")) return { error: "timeout" };
      if (result.error || !result.status || result.status < 200 || result.status >= 300) return { error: "transport" };
      try {
        const completion = JSON.parse(result.body || "{}");
        const message = completion.choices?.[0]?.message;
        if (completion.error || typeof message?.content !== "string" || message.tool_calls?.length
          || completion.choices?.[0]?.finish_reason === "length") throw new Error("invalid decision completion");
        return decode(JSON.parse(message.content), completion);
      } catch { return { error: "invalid_response" }; }
    });
  } catch { return { error: "transport" }; }
}
const decisionModel: DecisionModelCapability = {
  supportsCalibratedChoiceConfidence: () => false,
  supportsQuestionBatch: () => true,
  primitives: () => ({ choice: true, noul: true, score: true }),
  models,
  modelId() { try { return config().profile.model || null; } catch { return null; } },
  selectModel(id) { if (!id) return false; selectedModel = id; return true; },
  metadata() { try { return { display_name: "Rotterdom", server_address: config().endpoint.baseUrl }; } catch { return { display_name: "Rotterdom" }; } },
  decide(input: DecisionRequest, remainingMs?: number) {
    return run(input.state, { single: { instructions: input.instructions, question: input.question } }, remainingMs, false, value => answer(input.question, value));
  },
  decideQuestions(input: DecisionQuestionsRequest, remainingMs?: number) {
    return run(input.state, input.questions, remainingMs, true, (value, completion): DecisionResponse => {
      const answers = (value as { answers?: Record<string, unknown> })?.answers;
      if (!answers || Object.keys(answers).length !== Object.keys(input.questions).length) throw new Error("invalid answer set");
      const decoded = Object.fromEntries(Object.entries(input.questions).map(([name, spec]) => [name, answer(spec.question, answers[name])]));
      const usage = completion.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
      const tokens = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
      return { answers: decoded, usage: tokens(usage?.prompt_tokens) && tokens(usage?.completion_tokens)
        ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens } : null };
    });
  },
};
export default decisionModel;
