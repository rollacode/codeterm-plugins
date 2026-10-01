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

interface FetchResponse {
  status?: number;
  body?: string;
  error?: string;
}

interface Completion {
  choices?: {
    logprobs?: {
      content?: { token?: string; top_logprobs?: TokenLogprob[] | null }[];
    } | null;
    message?: { content?: unknown };
  }[];
}

const DEFAULT_BASE_URL = "http://localhost:1234";
const DEFAULT_TIMEOUT_MS = 30_000;
// Some engines emit leading whitespace/newline tokens before the first answer token.
const DEFAULT_MAX_TOKENS = 64;
const MAX_TOP_LOGPROBS = 20;
let defaultLoadedModel = "";
const approximateModels = new Set<string>();

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
    ? Math.max(8, Math.min(configured, 128))
    : DEFAULT_MAX_TOKENS;
}

function timeoutMs(): number {
  // DecisionRequest currently omits the caller's remaining deadline. This is a
  // configurable per-request cap, not the host's live remaining deadline.
  const configured = settings().decision?.timeoutMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.min(Math.ceil(configured), DEFAULT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

function parseModelList(response: FetchResponse): DecisionModelInfo[] {
  if (response.error || (typeof response.status === "number" && response.status >= 400) || !response.body) {
    return [];
  }

  try {
    const parsed = JSON.parse(response.body) as { data?: unknown };
    if (!Array.isArray(parsed.data)) return [];
    const models: DecisionModelInfo[] = [];
    for (const row of parsed.data) {
      if (!row || typeof row !== "object") continue;
      const item = row as { id?: unknown; name?: unknown };
      if (typeof item.id !== "string" || !item.id) continue;
      const name = typeof item.name === "string" ? item.name : item.id;
      models.push({
        id: item.id,
        display_name: approximateModels.has(item.id) ? `${name} (approximate fallback)` : name,
      });
    }
    defaultLoadedModel = models.length ? models[0].id : "";
    return models;
  } catch {
    return [];
  }
}

function requestModelList<T>(then: (models: DecisionModelInfo[]) => T): T {
  return host.fetch.async(
    {
      url: apiUrl("/models"),
      method: "GET",
      headers: { accept: "application/json" },
      timeoutMs: timeoutMs(),
    },
    (response) => then(parseModelList(response)),
  );
}

function modelList(): DecisionModelInfo[] {
  return requestModelList((models) => models);
}

function withSelectedModel<T>(then: (model: string) => T): T {
  const config = settings();
  const decisionModel = config.decision?.model;
  if (typeof decisionModel === "string" && decisionModel.trim()) return then(decisionModel.trim());
  if (typeof config.model === "string" && config.model.trim()) return then(config.model.trim());
  if (defaultLoadedModel) return then(defaultLoadedModel);
  return requestModelList((models) => {
    if (!models.length) throw new Error("LM Studio decision model unavailable: load a model or set decision.model");
    defaultLoadedModel = models[0].id;
    return then(defaultLoadedModel);
  });
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

function hasSharedFirstTokenPrefix(labels: string[]): boolean {
  const seen = new Set<string>();
  for (const label of labels) {
    const firstCharacter = Array.from(firstTextWord(label))[0];
    // We do not know the model tokenizer before the request. A shared initial
    // character is therefore treated conservatively as a possible shared token.
    if (firstCharacter && seen.has(firstCharacter)) return true;
    if (firstCharacter) seen.add(firstCharacter);
  }
  return false;
}

function parseFailure(message: string): never {
  throw new Error(`decision parse error: ${message}`);
}

function firstContentLogprobs(completion: Completion): TokenLogprob[] | null {
  const content = completion.choices?.[0]?.logprobs?.content;
  if (!Array.isArray(content)) return null;
  // Ignore whitespace-only tokens (LM Studio engines can emit newlines first).
  const firstAnswerToken = content.find((entry) =>
    typeof entry.token === "string" && entry.token.trim().length > 0,
  );
  if (!firstAnswerToken || !Array.isArray(firstAnswerToken.top_logprobs)) return null;
  return firstAnswerToken.top_logprobs.filter((entry): entry is TokenLogprob =>
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

function requestCompletion<T>(
  model: string,
  conversation: { role: string; content: string }[],
  topLogprobs: number | null,
  then: (completion: Completion) => T,
  responseFormat?: Record<string, unknown>,
): T {
  const outputLimit = responseFormat ? Math.max(32, maxTokens()) : maxTokens();
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
      let completion: Completion;
      try {
        completion = JSON.parse(result.body) as Completion;
      } catch {
        return parseFailure("LM Studio returned invalid JSON");
      }
      return then(completion);
    },
  );
}

function parseStructuredContent(completion: Completion): Record<string, unknown> {
  const raw = completion.choices?.[0]?.message?.content;
  if (typeof raw !== "string") return parseFailure("constrained response has no JSON content");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return parseFailure("constrained response is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parseFailure("constrained response is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function integerConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    return parseFailure("constrained confidence is outside the integer range 0-100");
  }
  return value / 100;
}

function noulFallback(
  model: string,
  conversation: { role: string; content: string }[],
): DecisionAnswer {
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "decision_noul",
      strict: true,
      schema: {
        type: "object",
        properties: {
          answer: { type: "string", enum: ["yes", "no"] },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
        },
        required: ["answer", "confidence"],
        additionalProperties: false,
      },
    },
  };
  return requestCompletion(
    model,
    messages(
      "Return JSON with answer yes or no and confidence as an integer from 0 to 100. " +
        "Confidence is your certainty that the chosen answer is correct.",
      conversation[1].content,
    ),
    null,
    (completion) => {
      const parsed = parseStructuredContent(completion);
      if (parsed.answer !== "yes" && parsed.answer !== "no") {
        return parseFailure("constrained response is not yes or no");
      }
      const confidence = integerConfidence(parsed.confidence);
      approximateModels.add(model);
      return {
        type: "noul",
        p: parsed.answer === "yes" ? confidence : 1 - confidence,
      };
    },
    responseFormat,
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
  return withSelectedModel((model) => requestCompletion(model, conversation, 5, (completion) => {
    const entries = firstContentLogprobs(completion);
    if (!entries) return noulFallback(model, conversation);

    const groups = new Map<string, number[]>([["yes", []], ["no", []]]);
    for (const entry of entries) {
      const token = normalizeToken(entry.token);
      if (token === "yes" || token === "no") groups.get(token)!.push(entry.logprob);
    }
    const probabilities = probabilitiesFromGroups(groups);
    return { type: "noul", p: probabilities.yes };
  }));
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

function confidenceProbabilities(choice: string, labels: string[], confidence: number): Record<string, number> {
  if (labels.length === 1) return { [choice]: 1 };
  const chosenProbability = confidence;
  const otherProbability = (1 - confidence) / (labels.length - 1);
  const probabilities: Record<string, number> = {};
  for (const label of labels) probabilities[label] = label === choice ? chosenProbability : otherProbability;
  return probabilities;
}

function constrainedChoice(
  request: DecisionRequest,
  options: Record<string, string>,
  model: string,
): DecisionAnswer {
  const labels = Object.keys(options);
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "decision_choice",
      strict: true,
      schema: {
        type: "object",
        properties: {
          choice: { type: "string", enum: labels },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
        },
        required: ["choice", "confidence"],
        additionalProperties: false,
      },
    },
  };
  return requestCompletion(
    model,
    messages(
      "Return JSON with one supplied choice and confidence as an integer from 0 to 100. " +
        "Confidence is your certainty that the selected choice is correct.",
      choicePrompt(request, options),
    ),
    null,
    (completion) => {
      const parsed = parseStructuredContent(completion);
      const choice = parsed.choice;
      if (typeof choice !== "string" || !Object.prototype.hasOwnProperty.call(options, choice)) {
        return parseFailure("constrained response is not one of the supplied labels");
      }
      const confidence = integerConfidence(parsed.confidence);
      approximateModels.add(model);
      return {
        type: "choice",
        choice,
        probabilities: confidenceProbabilities(choice, labels, confidence),
        confidence: labels.length === 1 ? 1 : confidence,
      };
    },
    responseFormat,
  );
}

function choiceProbabilitiesFromLogs(labels: string[], entries: TokenLogprob[]): Record<string, number> {
  const groups = new Map<string, number[]>(labels.map((label) => [label, []]));
  for (const entry of entries) {
    const token = normalizeToken(entry.token);
    if (!token) continue;
    const matches = labels.filter((label) => normalizeToken(label).startsWith(token));
    if (matches.length > 1) return parseFailure("shared candidate token prefixes");
    if (matches.length === 1) groups.get(matches[0])!.push(entry.logprob);
  }
  return probabilitiesFromGroups(groups);
}

function choose(request: DecisionRequest, options: Record<string, string>): DecisionAnswer {
  const labels = Object.keys(options);
  if (!labels.length || labels.some((label) => !label.trim())) {
    return parseFailure("choice options must include non-empty labels");
  }
  return withSelectedModel((model) => {
    if (hasSharedFirstTokenPrefix(labels)) return constrainedChoice(request, options, model);

    const count = Math.min(MAX_TOP_LOGPROBS, Math.max(5, labels.length * 3));
    return requestCompletion(
      model,
      messages(
        "Answer with the first token of exactly one supplied option key. Do not explain.",
        choicePrompt(request, options),
      ),
      count,
      (completion) => {
        const entries = firstContentLogprobs(completion);
        if (!entries) return constrainedChoice(request, options, model);

        let probabilities: Record<string, number>;
        try {
          probabilities = choiceProbabilitiesFromLogs(labels, entries);
        } catch (error) {
          if (String(error && (error as Error).message || error).includes("shared candidate token prefixes")) {
            return constrainedChoice(request, options, model);
          }
          throw error;
        }
        const selected = answerChoice(probabilities);
        return {
          type: "choice",
          choice: selected.choice,
          probabilities,
          confidence: selected.confidence,
        };
      },
    );
  });
}

function pointScoreProbabilities(score: number): Record<string, number> {
  const low = Math.floor(score);
  const high = Math.ceil(score);
  if (low === high) return { [String(low)]: 1 };
  return { [String(low)]: high - score, [String(high)]: score - low };
}

function constrainedScore(
  request: DecisionRequest,
  model: string,
): DecisionAnswer {
  if (request.question.type !== "score") return parseFailure("expected a score question");
  const levels = request.question.levels;
  const maximum = levels.length - 1;
  const scorePrompt = `${request.instructions}\n\nState and decision context:\n${stateText(request)}\n\n` +
    "Return one numeric score for these ordered levels. Each level's index is its score:\n" +
    JSON.stringify(levels.map((level, index) => ({ index, level })));
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "decision_score",
      strict: true,
      schema: {
        type: "object",
        properties: { score: { type: "number", minimum: 0, maximum } },
        required: ["score"],
        additionalProperties: false,
      },
    },
  };
  return requestCompletion(
    model,
    messages("Return JSON with a numeric score in the declared range.", scorePrompt),
    null,
    (completion) => {
      const parsed = parseStructuredContent(completion);
      const scoreValue = parsed.score;
      if (typeof scoreValue !== "number" || !Number.isFinite(scoreValue) || scoreValue < 0 || scoreValue > maximum) {
        return parseFailure("constrained score is outside the declared range");
      }
      approximateModels.add(model);
      return {
        type: "score",
        score: scoreValue,
        probabilities: pointScoreProbabilities(scoreValue),
        confidence: null,
      };
    },
    responseFormat,
  );
}

function score(request: DecisionRequest): DecisionAnswer {
  if (request.question.type !== "score") return parseFailure("expected a score question");
  const levels = request.question.levels;
  if (!levels.length) return parseFailure("score levels are empty");
  const options = optionRecord(request);
  const labels = Object.keys(options);
  return withSelectedModel((model) => {
    if (hasSharedFirstTokenPrefix(labels)) return constrainedScore(request, model);

    const count = Math.min(MAX_TOP_LOGPROBS, Math.max(5, labels.length * 3));
    return requestCompletion(
      model,
      messages(
        "Answer with the first token of exactly one supplied option key. Do not explain.",
        choicePrompt(request, options),
      ),
      count,
      (completion) => {
        const entries = firstContentLogprobs(completion);
        if (!entries) return constrainedScore(request, model);

        let probabilities: Record<string, number>;
        try {
          probabilities = choiceProbabilitiesFromLogs(labels, entries);
        } catch (error) {
          if (String(error && (error as Error).message || error).includes("shared candidate token prefixes")) {
            return constrainedScore(request, model);
          }
          throw error;
        }
        let expectedScore = 0;
        for (const [index, probability] of Object.entries(probabilities)) {
          expectedScore += Number(index) * probability;
        }
        const selected = answerChoice(probabilities);
        return {
          type: "score",
          score: expectedScore,
          probabilities,
          confidence: selected.confidence,
        };
      },
    );
  });
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
