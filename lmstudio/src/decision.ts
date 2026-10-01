import type {
  DecisionAnswer,
  DecisionModelCapability,
  DecisionModelInfo,
  DecisionRequest,
} from "@codeterm/plugin-sdk";

interface DecisionSettings {
  baseUrl?: unknown;
  model?: unknown;
  decision?: {
    model?: unknown;
    maxTokens?: unknown;
    timeoutMs?: unknown;
  };
}

interface TokenLogprob {
  token: string;
  logprob: number;
}

interface Completion {
  choices?: {
    logprobs?: {
      content?: { top_logprobs?: TokenLogprob[] }[];
    } | null;
    message?: { content?: unknown };
  }[];
}

const DEFAULT_BASE_URL = "http://localhost:1234";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 1;
const MAX_TOP_LOGPROBS = 20;
let defaultLoadedModel = "";

function settings(): DecisionSettings {
  try {
    const parsed = JSON.parse(host.settingsJson() || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as DecisionSettings
      : {};
  } catch {
    return {};
  }
}

function apiUrl(path: string): string {
  const configured = settings().baseUrl;
  const base = typeof configured === "string" && configured.trim()
    ? configured.trim().replace(/\/+$/, "")
    : DEFAULT_BASE_URL;
  return `${base.endsWith("/v1") ? base : `${base}/v1`}${path}`;
}

function maxTokens(): number {
  const configured = settings().decision?.maxTokens;
  return typeof configured === "number" && Number.isInteger(configured) && configured > 0
    ? Math.min(configured, 32)
    : DEFAULT_MAX_TOKENS;
}

function timeoutMs(): number {
  // The current DecisionRequest SDK shape omits the caller's remaining deadline.
  // This bounds the network wait; it is not a substitute for that live budget.
  const configured = settings().decision?.timeoutMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.min(Math.ceil(configured), DEFAULT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

function modelList(): DecisionModelInfo[] {
  const result = host.fetch.async(
    {
      url: apiUrl("/models"),
      method: "GET",
      headers: { accept: "application/json" },
      timeoutMs: timeoutMs(),
    },
    (response) => response,
  );
  if (result.error || (typeof result.status === "number" && result.status >= 400) || !result.body) {
    return [];
  }

  try {
    const parsed = JSON.parse(result.body) as { data?: unknown };
    if (!Array.isArray(parsed.data)) return [];
    const models: DecisionModelInfo[] = [];
    for (const row of parsed.data) {
      if (!row || typeof row !== "object") continue;
      const item = row as { id?: unknown; name?: unknown };
      if (typeof item.id !== "string" || !item.id) continue;
      models.push({ id: item.id, display_name: typeof item.name === "string" ? item.name : item.id });
    }
    defaultLoadedModel = models.length ? models[0].id : "";
    return models;
  } catch {
    return [];
  }
}

function selectedModel(): string {
  const config = settings();
  const decisionModel = config.decision?.model;
  if (typeof decisionModel === "string" && decisionModel.trim()) return decisionModel.trim();
  if (typeof config.model === "string" && config.model.trim()) return config.model.trim();
  if (defaultLoadedModel) return defaultLoadedModel;
  const loaded = modelList();
  if (loaded.length) return loaded[0].id;
  throw new Error("LM Studio decision model unavailable: set decision.model or load a model");
}

function stateText(request: DecisionRequest): string {
  return JSON.stringify(request.state);
}

function normalizeToken(token: string): string {
  return token.replace(/^\s+/, "").toLowerCase();
}

function firstTextWord(label: string): string {
  return normalizeToken(label).split(/\s+/, 1)[0] || "";
}

function hasSharedLeadingWord(labels: string[]): boolean {
  const seen = new Set<string>();
  for (const label of labels) {
    const word = firstTextWord(label);
    if (word && seen.has(word)) return true;
    if (word) seen.add(word);
  }
  return false;
}

function parseFailure(message: string): never {
  throw new Error(`decision parse error: ${message}`);
}

function logprobEntries(completion: Completion): TokenLogprob[] {
  const first = completion.choices?.[0]?.logprobs?.content?.[0];
  if (!first || !Array.isArray(first.top_logprobs)) return [];
  return first.top_logprobs.filter((entry): entry is TokenLogprob =>
    !!entry && typeof entry.token === "string" && Number.isFinite(entry.logprob),
  );
}

function probabilitiesFromGroups(groups: Map<string, number[]>): Record<string, number> {
  const entries = Array.from(groups.entries());
  const allLogs = entries.flatMap(([, values]) => values);
  if (!allLogs.length || entries.some(([, values]) => !values.length)) {
    return parseFailure("candidate tokens are absent from top_logprobs");
  }
  const maxLog = Math.max(...allLogs);
  const weights = entries.map(([label, values]) => ({
    label,
    weight: values.reduce((sum, logprob) => sum + Math.exp(logprob - maxLog), 0),
  }));
  const total = weights.reduce((sum, item) => sum + item.weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) return parseFailure("candidate logprobs are invalid");
  const probabilities: Record<string, number> = {};
  for (const item of weights) probabilities[item.label] = item.weight / total;
  return probabilities;
}

function answerChoice(probabilities: Record<string, number>): {
  choice: string;
  confidence: number;
} {
  const labels = Object.keys(probabilities);
  if (!labels.length) return parseFailure("no candidate probabilities");
  let choice = labels[0];
  for (const label of labels.slice(1)) {
    if (probabilities[label] > probabilities[choice]) choice = label;
  }
  return { choice, confidence: probabilities[choice] };
}

function messages(system: string, user: string): { role: string; content: string }[] {
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function requestCompletion(
  model: string,
  conversation: { role: string; content: string }[],
  topLogprobs: number | null,
  responseFormat?: Record<string, unknown>,
): Completion {
  const outputLimit = responseFormat ? Math.max(16, maxTokens()) : maxTokens();
  const body: Record<string, unknown> = {
    model,
    messages: conversation,
    temperature: 0,
    max_tokens: outputLimit,
    stream: false,
  };
  if (topLogprobs !== null) {
    body.logprobs = true;
    body.top_logprobs = topLogprobs;
  }
  if (responseFormat) body.response_format = responseFormat;

  return host.fetch.async(
    {
      url: apiUrl("/chat/completions"),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: timeoutMs(),
    },
    (result) => {
      if (result.error) throw new Error(`LM Studio decision request failed: ${result.error}`);
      if (typeof result.status === "number" && result.status >= 400) {
        throw new Error(`LM Studio decision request failed: HTTP ${result.status}`);
      }
      if (!result.body) return parseFailure("LM Studio returned an empty completion");
      try {
        return JSON.parse(result.body) as Completion;
      } catch {
        return parseFailure("LM Studio returned invalid JSON");
      }
    },
  );
}

function noul(request: DecisionRequest): DecisionAnswer {
  const question = request.question;
  if (question.type !== "noul") return parseFailure("expected a noul question");
  const criteria = question.criteria;
  const conversation = messages(
    "Answer the yes/no decision with exactly one token: yes or no. Do not explain.",
    `${request.instructions}\n\nState and decision context:\n${stateText(request)}\n\n` +
      (criteria
        ? `A yes means: ${criteria.true}\nA no means: ${criteria.false}\n`
        : "Answer yes when the stated condition is satisfied; otherwise answer no.\n") +
      "Answer yes or no.",
  );
  const completion = requestCompletion(selectedModel(), conversation, 5);
  const groups = new Map<string, number[]>([["yes", []], ["no", []]]);
  for (const entry of logprobEntries(completion)) {
    const token = normalizeToken(entry.token);
    if (token === "yes" || token === "no") groups.get(token)!.push(entry.logprob);
  }
  const probabilities = probabilitiesFromGroups(groups);
  return { type: "noul", p: probabilities.yes };
}

function optionRecord(request: DecisionRequest): Record<string, string> {
  if (request.question.type === "choice") return request.question.options;
  if (request.question.type === "score") {
    const indexed: Record<string, string> = {};
    request.question.levels.forEach((level, index) => { indexed[String(index)] = level; });
    return indexed;
  }
  return parseFailure("expected a choice or score question");
}

function choicePrompt(request: DecisionRequest, options: Record<string, string>): string {
  return `${request.instructions}\n\nState and decision context:\n${stateText(request)}\n\n` +
    "Choose exactly one option. The option key is the answer; use its first token as your answer.\n" +
    JSON.stringify(options);
}

function constrainedChoice(
  request: DecisionRequest,
  options: Record<string, string>,
): DecisionAnswer {
  const labels = Object.keys(options);
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "decision_choice",
      strict: true,
      schema: {
        type: "object",
        properties: { choice: { type: "string", enum: labels } },
        required: ["choice"],
        additionalProperties: false,
      },
    },
  };
  const completion = requestCompletion(
    selectedModel(),
    messages("Return one valid JSON object with the selected choice only.", choicePrompt(request, options)),
    null,
    responseFormat,
  );
  const raw = completion.choices?.[0]?.message?.content;
  if (typeof raw !== "string") return parseFailure("constrained response has no choice content");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return parseFailure("constrained response is invalid JSON");
  }
  const choice = parsed && typeof parsed === "object"
    ? (parsed as { choice?: unknown }).choice
    : undefined;
  if (typeof choice !== "string" || !Object.prototype.hasOwnProperty.call(options, choice)) {
    return parseFailure("constrained response is not one of the supplied labels");
  }
  return {
    type: "choice",
    choice,
    probabilities: { [choice]: 1 },
    confidence: null,
  };
}

function choose(request: DecisionRequest, options: Record<string, string>): DecisionAnswer {
  const labels = Object.keys(options);
  if (!labels.length || labels.some((label) => !label.trim())) {
    return parseFailure("choice options must include non-empty labels");
  }
  if (hasSharedLeadingWord(labels)) return constrainedChoice(request, options);

  const count = Math.min(MAX_TOP_LOGPROBS, Math.max(5, labels.length * 3));
  const completion = requestCompletion(
    selectedModel(),
    messages(
      "Answer with the first token of exactly one supplied option key. Do not explain.",
      choicePrompt(request, options),
    ),
    count,
  );
  const entries = logprobEntries(completion);
  const groups = new Map<string, number[]>(labels.map((label) => [label, []]));
  for (const entry of entries) {
    const token = normalizeToken(entry.token);
    if (!token) continue;
    const matches = labels.filter((label) => normalizeToken(label).startsWith(token));
    if (matches.length > 1) return constrainedChoice(request, options);
    if (matches.length === 1) groups.get(matches[0])!.push(entry.logprob);
  }
  const probabilities = probabilitiesFromGroups(groups);
  const selected = answerChoice(probabilities);
  return {
    type: "choice",
    choice: selected.choice,
    probabilities,
    confidence: selected.confidence,
  };
}

function score(request: DecisionRequest): DecisionAnswer {
  if (request.question.type !== "score") return parseFailure("expected a score question");
  if (!request.question.levels.length) return parseFailure("score levels are empty");
  const answer = choose(request, optionRecord(request)) as Extract<DecisionAnswer, { type: "choice" }>;
  const probabilities: Record<string, number> = {};
  let expectedScore = 0;
  for (const [index, probability] of Object.entries(answer.probabilities)) {
    probabilities[index] = probability;
    expectedScore += Number(index) * probability;
  }
  return {
    type: "score",
    score: expectedScore,
    probabilities,
    confidence: answer.confidence,
  };
}

const decisionModel: DecisionModelCapability = {
  decide(request) {
    switch (request.question.type) {
      case "noul": return noul(request);
      case "choice": return choose(request, request.question.options);
      case "score": return score(request);
      default: return parseFailure("unsupported decision question");
    }
  },
  models: modelList,
  primitives: () => ({ choice: true, noul: true, score: true }),
};

export default decisionModel;
