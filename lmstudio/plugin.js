"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lmstudio/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  default: () => plugin_default,
  describeModelSwitch: () => describeModelSwitch
});
module.exports = __toCommonJS(plugin_exports);

// ../codeterm/packages/chat-engine/src/index.ts
var VERDICT_CONTRACT = [
  "Respond ONLY with a JSON object of this exact shape (no markdown fences, no surrounding prose):",
  "{",
  '  "status": "ok" | "attention" | "stalled",',
  '  "summary": "<one-line assessment>",',
  '  "state": <updated state object>,',
  '  "actions": [{ "kind": "nudge" | "notify" | "report", "tab": "<optional Tab id>", "message": "<text>" }]',
  "}"
].join("\n");
function assembleChat(history, window) {
  const maxMessages = window?.maxMessages;
  if (maxMessages === void 0) {
    return history;
  }
  const leadingSystem = history[0]?.role === "system" ? history[0] : void 0;
  const nonSystem = history.filter((m) => m.role !== "system");
  const tail = nonSystem.slice(-maxMessages);
  return leadingSystem ? [leadingSystem, ...tail] : tail;
}
function assembleMachine(charter, state, input) {
  return [
    {
      role: "system",
      content: `${charter}

${VERDICT_CONTRACT}`
    },
    {
      role: "user",
      content: JSON.stringify({ state, input })
    }
  ];
}

// lmstudio/src/decision.ts
var DEFAULT_BASE_URL = "http://localhost:1234";
var DEFAULT_TIMEOUT_MS = 3e4;
var DEFAULT_MAX_TOKENS = 64;
var MAX_TOP_LOGPROBS = 20;
var CONSTRAINED_CHOICE_BATCH_SIZE = 12;
var MAX_CONSTRAINED_CHOICE_LABELS = 36;
var defaultLoadedModel = "";
var selectedModel = "";
var approximateModels = /* @__PURE__ */ new Set();
function settings() {
  try {
    const parsed = JSON.parse(host.settingsJson() || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function apiUrl(path) {
  const configured = settings().baseUrl;
  const base = typeof configured === "string" && configured.trim() ? configured.trim().replace(/\/+$/, "") : DEFAULT_BASE_URL;
  return `${base.endsWith("/v1") ? base : `${base}/v1`}${path}`;
}
function maxTokens() {
  const configured = settings().decision?.maxTokens;
  return typeof configured === "number" && Number.isInteger(configured) && configured > 0 ? Math.max(8, Math.min(configured, 128)) : DEFAULT_MAX_TOKENS;
}
function timeoutMs() {
  const configured = settings().decision?.timeoutMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? Math.min(Math.ceil(configured), DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}
function useTokenLogprobs(model) {
  const configured = settings().decision?.logprobsMode;
  if (configured === "constrained") return false;
  if (configured === "logprobs") return true;
  return !/(?:^|[-_/.])mlx(?:$|[-_/.])/i.test(model);
}
function parseModelList(response) {
  if (response.error || typeof response.status === "number" && response.status >= 400 || !response.body) {
    return [];
  }
  try {
    const parsed = JSON.parse(response.body);
    if (!Array.isArray(parsed.data)) return [];
    const models = [];
    for (const row of parsed.data) {
      if (!row || typeof row !== "object") continue;
      const item = row;
      if (typeof item.id !== "string" || !item.id) continue;
      const name = typeof item.name === "string" ? item.name : item.id;
      models.push({
        id: item.id,
        display_name: approximateModels.has(item.id) ? `${name} (approximate fallback)` : name
      });
    }
    defaultLoadedModel = models.length ? models[0].id : "";
    return models;
  } catch {
    return [];
  }
}
function requestModelList(then) {
  return host.fetch.async(
    {
      url: apiUrl("/models"),
      method: "GET",
      headers: { accept: "application/json" },
      timeoutMs: timeoutMs()
    },
    (response) => then(parseModelList(response))
  );
}
function modelList() {
  return requestModelList((models) => models);
}
function configuredModel() {
  const config = settings();
  const decisionModel2 = config.decision?.model;
  if (typeof decisionModel2 === "string" && decisionModel2.trim()) return decisionModel2.trim();
  if (typeof config.model === "string" && config.model.trim()) return config.model.trim();
  return "";
}
function withSelectedModel(then) {
  if (selectedModel) return then(selectedModel);
  const config = settings();
  const decisionModel2 = config.decision?.model;
  if (typeof decisionModel2 === "string" && decisionModel2.trim()) return then(decisionModel2.trim());
  if (typeof config.model === "string" && config.model.trim()) return then(config.model.trim());
  if (defaultLoadedModel) return then(defaultLoadedModel);
  return requestModelList((models) => {
    if (!models.length) throw new Error("LM Studio decision model unavailable: load a model or set decision.model");
    defaultLoadedModel = models[0].id;
    return then(defaultLoadedModel);
  });
}
function stateText(request) {
  return JSON.stringify(request.state);
}
function normalizeToken(token) {
  return token.replace(/^\s+/, "").toLowerCase();
}
function firstTextWord(label) {
  return normalizeToken(label).split(/\s+/, 1)[0] || "";
}
function hasSharedFirstTokenPrefix(labels) {
  const seen = /* @__PURE__ */ new Set();
  for (const label of labels) {
    const firstCharacter = Array.from(firstTextWord(label))[0];
    if (firstCharacter && seen.has(firstCharacter)) return true;
    if (firstCharacter) seen.add(firstCharacter);
  }
  return false;
}
function parseFailure(message) {
  throw new Error(`decision parse error: ${message}`);
}
function firstContentLogprobs(completion) {
  const content = completion.choices?.[0]?.logprobs?.content;
  if (!Array.isArray(content)) return null;
  const firstAnswerToken = content.find(
    (entry) => typeof entry.token === "string" && entry.token.trim().length > 0
  );
  if (!firstAnswerToken || !Array.isArray(firstAnswerToken.top_logprobs)) return null;
  return firstAnswerToken.top_logprobs.filter(
    (entry) => !!entry && typeof entry.token === "string" && Number.isFinite(entry.logprob)
  );
}
function probabilitiesFromGroups(groups) {
  const entries = Array.from(groups.entries());
  const allLogs = entries.flatMap(([, values]) => values);
  if (!allLogs.length || entries.some(([, values]) => !values.length)) {
    return parseFailure("candidate tokens are absent from top_logprobs");
  }
  const maxLog = Math.max(...allLogs);
  const weights = entries.map(([label, values]) => ({
    label,
    weight: values.reduce((sum, logprob) => sum + Math.exp(logprob - maxLog), 0)
  }));
  const total = weights.reduce((sum, item) => sum + item.weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) return parseFailure("candidate logprobs are invalid");
  const probabilities = {};
  for (const item of weights) probabilities[item.label] = item.weight / total;
  return probabilities;
}
function answerChoice(probabilities) {
  const labels = Object.keys(probabilities);
  if (!labels.length) return parseFailure("no candidate probabilities");
  let choice = labels[0];
  for (const label of labels.slice(1)) {
    if (probabilities[label] > probabilities[choice]) choice = label;
  }
  return { choice, confidence: probabilities[choice] };
}
function messages(system, user) {
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}
function requestCompletion(model, conversation, topLogprobs, then, responseFormat) {
  const outputLimit = responseFormat ? Math.max(32, maxTokens()) : maxTokens();
  const body = {
    model,
    messages: conversation,
    temperature: 0,
    max_tokens: outputLimit,
    stream: false
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
      timeoutMs: timeoutMs()
    },
    (result) => {
      if (result.error) throw new Error(`LM Studio decision request failed: ${result.error}`);
      if (typeof result.status === "number" && result.status >= 400) {
        throw new Error(`LM Studio decision request failed: HTTP ${result.status}`);
      }
      if (!result.body) return parseFailure("LM Studio returned an empty completion");
      let completion;
      try {
        completion = JSON.parse(result.body);
      } catch {
        return parseFailure("LM Studio returned invalid JSON");
      }
      return then(completion);
    }
  );
}
function parseStructuredContent(completion) {
  const raw = completion.choices?.[0]?.message?.content;
  if (typeof raw !== "string") return parseFailure("constrained response has no JSON content");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return parseFailure("constrained response is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parseFailure("constrained response is not a JSON object");
  }
  return parsed;
}
function integerConfidence(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    return parseFailure("constrained confidence is outside the integer range 0-100");
  }
  return value / 100;
}
function noulFallback(model, conversation) {
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "decision_noul",
      strict: true,
      schema: {
        type: "object",
        properties: {
          answer: { type: "string", enum: ["yes", "no"] },
          confidence: { type: "integer", minimum: 0, maximum: 100 }
        },
        required: ["answer", "confidence"],
        additionalProperties: false
      }
    }
  };
  return requestCompletion(
    model,
    messages(
      "Return JSON with answer yes or no and confidence as an integer from 0 to 100. Confidence is your certainty that the chosen answer is correct.",
      conversation[1].content
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
        p: parsed.answer === "yes" ? confidence : 1 - confidence
      };
    },
    responseFormat
  );
}
function noul(request) {
  const question = request.question;
  if (question.type !== "noul") return parseFailure("expected a noul question");
  const criteria = question.criteria;
  const conversation = messages(
    "Answer the yes/no decision with exactly one token: yes or no. Do not explain.",
    `${request.instructions}

State and decision context:
${stateText(request)}

` + (criteria ? `A yes means: ${criteria.true}
A no means: ${criteria.false}
` : "Answer yes when the stated condition is satisfied; otherwise answer no.\n") + "Answer yes or no."
  );
  return withSelectedModel((model) => {
    if (!useTokenLogprobs(model)) return noulFallback(model, conversation);
    return requestCompletion(model, conversation, 5, (completion) => {
      const entries = firstContentLogprobs(completion);
      if (!entries) return noulFallback(model, conversation);
      const groups = /* @__PURE__ */ new Map([["yes", []], ["no", []]]);
      for (const entry of entries) {
        const token = normalizeToken(entry.token);
        if (token === "yes" || token === "no") groups.get(token).push(entry.logprob);
      }
      const probabilities = probabilitiesFromGroups(groups);
      return { type: "noul", p: probabilities.yes };
    });
  });
}
function optionRecord(request) {
  if (request.question.type === "choice") return request.question.options;
  if (request.question.type === "score") {
    const indexed = {};
    request.question.levels.forEach((level, index) => {
      indexed[String(index)] = level;
    });
    return indexed;
  }
  return parseFailure("expected a choice or score question");
}
function choicePrompt(request, options) {
  return `${request.instructions}

State and decision context:
${stateText(request)}

Choose exactly one option. The option key is the answer; use its first token as your answer.
` + JSON.stringify(options);
}
function confidenceProbabilities(choice, labels, confidence) {
  if (labels.length === 1) return { [choice]: 1 };
  const chosenProbability = confidence;
  const otherProbability = (1 - confidence) / (labels.length - 1);
  const probabilities = {};
  for (const label of labels) probabilities[label] = label === choice ? chosenProbability : otherProbability;
  return probabilities;
}
function constrainedChoice(request, options, model) {
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
          confidence: { type: "integer", minimum: 0, maximum: 100 }
        },
        required: ["choice", "confidence"],
        additionalProperties: false
      }
    }
  };
  return requestCompletion(
    model,
    messages(
      "Return JSON with one supplied choice and confidence as an integer from 0 to 100. Confidence is your certainty that the selected choice is correct.",
      choicePrompt(request, options)
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
        confidence: labels.length === 1 ? 1 : confidence
      };
    },
    responseFormat
  );
}
function constrainedChoiceScoreFormat(keys) {
  const scoreProperties = {};
  for (const key of keys) {
    scoreProperties[key] = { type: "integer", minimum: 0, maximum: 100 };
  }
  return {
    type: "json_schema",
    json_schema: {
      name: "decision_choice_batch_scores",
      strict: true,
      schema: {
        type: "object",
        properties: {
          scores: {
            type: "object",
            properties: scoreProperties,
            required: keys,
            additionalProperties: false
          }
        },
        required: ["scores"],
        additionalProperties: false
      }
    }
  };
}
function constrainedChoiceBatches(request, options, model) {
  const labels = Object.keys(options);
  if (labels.length > MAX_CONSTRAINED_CHOICE_LABELS) {
    return parseFailure(`constrained choice supports at most ${MAX_CONSTRAINED_CHOICE_LABELS} labels`);
  }
  const scores = {};
  const allOptions = labels.map((label) => ({ label, description: options[label] }));
  const requestBatch = (offset) => {
    if (offset >= labels.length) {
      const total = labels.reduce((sum, label) => sum + scores[label], 0);
      if (!(total > 0)) return parseFailure("constrained candidate scores contain no positive mass");
      const probabilities = {};
      for (const label of labels) probabilities[label] = scores[label] / total;
      const selected = answerChoice(probabilities);
      approximateModels.add(model);
      return {
        type: "choice",
        choice: selected.choice,
        probabilities,
        confidence: selected.confidence
      };
    }
    const batchLabels = labels.slice(offset, offset + CONSTRAINED_CHOICE_BATCH_SIZE);
    const scoreKeys = batchLabels.map((_, index) => `s${index}`);
    const batch = batchLabels.map((label, index) => ({
      key: scoreKeys[index],
      label,
      description: options[label]
    }));
    const user = `${request.instructions}

State and decision context:
${stateText(request)}

Evaluate the complete candidate set below using one consistent absolute 0-100 relevance scale. Return an independent integer score for every key in score_batch. Do not normalize scores within a batch.
Complete candidate set: ${JSON.stringify(allOptions)}
score_batch: ${JSON.stringify(batch)}`;
    return requestCompletion(
      model,
      messages("Return JSON with an integer score from 0 to 100 for each requested candidate key.", user),
      null,
      (completion) => {
        const parsed = parseStructuredContent(completion);
        const batchScores = parsed.scores;
        if (!batchScores || typeof batchScores !== "object" || Array.isArray(batchScores)) {
          return parseFailure("constrained choice batch has no scores object");
        }
        const values = batchScores;
        for (let index = 0; index < batchLabels.length; index += 1) {
          const key = scoreKeys[index];
          const value = values[key];
          if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
            return parseFailure(`constrained candidate score ${key} is outside the integer range 0-100`);
          }
          scores[batchLabels[index]] = value;
        }
        return requestBatch(offset + batchLabels.length);
      },
      constrainedChoiceScoreFormat(scoreKeys)
    );
  };
  return requestBatch(0);
}
function constrainedChoiceFallback(request, options, model) {
  return Object.keys(options).length > CONSTRAINED_CHOICE_BATCH_SIZE ? constrainedChoiceBatches(request, options, model) : constrainedChoice(request, options, model);
}
function choiceProbabilitiesFromLogs(labels, entries) {
  const groups = new Map(labels.map((label) => [label, []]));
  for (const entry of entries) {
    const token = normalizeToken(entry.token);
    if (!token) continue;
    const matches = labels.filter((label) => normalizeToken(label).startsWith(token));
    if (matches.length > 1) return parseFailure("shared candidate token prefixes");
    if (matches.length === 1) groups.get(matches[0]).push(entry.logprob);
  }
  return probabilitiesFromGroups(groups);
}
function choose(request, options) {
  const labels = Object.keys(options);
  if (!labels.length || labels.some((label) => !label.trim())) {
    return parseFailure("choice options must include non-empty labels");
  }
  if (labels.length > MAX_CONSTRAINED_CHOICE_LABELS) {
    return parseFailure(`choice supports at most ${MAX_CONSTRAINED_CHOICE_LABELS} labels`);
  }
  return withSelectedModel((model) => {
    if (!useTokenLogprobs(model) || labels.length > MAX_TOP_LOGPROBS) {
      return constrainedChoiceFallback(request, options, model);
    }
    if (hasSharedFirstTokenPrefix(labels)) return constrainedChoiceFallback(request, options, model);
    const count = Math.min(MAX_TOP_LOGPROBS, Math.max(5, labels.length * 3));
    return requestCompletion(
      model,
      messages(
        "Answer with the first token of exactly one supplied option key. Do not explain.",
        choicePrompt(request, options)
      ),
      count,
      (completion) => {
        const entries = firstContentLogprobs(completion);
        if (!entries) return constrainedChoiceFallback(request, options, model);
        let probabilities;
        try {
          probabilities = choiceProbabilitiesFromLogs(labels, entries);
        } catch (error) {
          if (String(error && error.message || error).includes("shared candidate token prefixes")) {
            return constrainedChoiceFallback(request, options, model);
          }
          throw error;
        }
        const selected = answerChoice(probabilities);
        return {
          type: "choice",
          choice: selected.choice,
          probabilities,
          confidence: selected.confidence
        };
      }
    );
  });
}
function pointScoreProbabilities(score2) {
  const low = Math.floor(score2);
  const high = Math.ceil(score2);
  if (low === high) return { [String(low)]: 1 };
  return { [String(low)]: high - score2, [String(high)]: score2 - low };
}
function constrainedScore(request, model) {
  if (request.question.type !== "score") return parseFailure("expected a score question");
  const levels = request.question.levels;
  const maximum = levels.length - 1;
  const scorePrompt = `${request.instructions}

State and decision context:
${stateText(request)}

Return one numeric score for these ordered levels. Each level's index is its score:
` + JSON.stringify(levels.map((level, index) => ({ index, level })));
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "decision_score",
      strict: true,
      schema: {
        type: "object",
        properties: { score: { type: "number", minimum: 0, maximum } },
        required: ["score"],
        additionalProperties: false
      }
    }
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
        confidence: null
      };
    },
    responseFormat
  );
}
function score(request) {
  if (request.question.type !== "score") return parseFailure("expected a score question");
  const levels = request.question.levels;
  if (!levels.length) return parseFailure("score levels are empty");
  const options = optionRecord(request);
  const labels = Object.keys(options);
  return withSelectedModel((model) => {
    if (!useTokenLogprobs(model) || labels.length > MAX_TOP_LOGPROBS) return constrainedScore(request, model);
    if (hasSharedFirstTokenPrefix(labels)) return constrainedScore(request, model);
    const count = Math.min(MAX_TOP_LOGPROBS, Math.max(5, labels.length * 3));
    return requestCompletion(
      model,
      messages(
        "Answer with the first token of exactly one supplied option key. Do not explain.",
        choicePrompt(request, options)
      ),
      count,
      (completion) => {
        const entries = firstContentLogprobs(completion);
        if (!entries) return constrainedScore(request, model);
        let probabilities;
        try {
          probabilities = choiceProbabilitiesFromLogs(labels, entries);
        } catch (error) {
          if (String(error && error.message || error).includes("shared candidate token prefixes")) {
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
          confidence: selected.confidence
        };
      }
    );
  });
}
var decisionModel = {
  decide(request) {
    switch (request.question.type) {
      case "noul":
        return noul(request);
      case "choice":
        return choose(request, request.question.options);
      case "score":
        return score(request);
      default:
        return parseFailure("unsupported decision question");
    }
  },
  models: modelList,
  modelId: () => selectedModel || configuredModel() || defaultLoadedModel || null,
  selectModel(id) {
    if (!id) return false;
    selectedModel = id;
    return true;
  },
  metadata: () => ({ display_name: "LM Studio", server_address: apiUrl("").replace(/\/v1$/, "") }),
  primitives: () => ({ choice: true, noul: true, score: true })
};
var decision_default = decisionModel;

// lmstudio/src/tools.ts
var TOOL_SCHEMA_JSON = JSON.stringify({
  tools: [
    { name: "exec", args: ["cmd"], optional: ["cwd"] },
    { name: "read_file", args: ["path"], optional: [] },
    { name: "write_file", args: ["path", "content"], optional: [] },
    { name: "codeterm", args: ["args"], optional: [] },
    { name: "mem_search", args: ["query"], optional: [] },
    { name: "spawn_agent", args: ["provider", "task"], optional: ["workspace"] }
  ],
  aliases: { command: "cmd", file: "path", filepath: "path" }
});
var FENCE_RE = /```[^\r\n`]*\r?\n[\s\S]*?```/g;
var TOOL_WRAPPER_RE = /<\s*\|?\/?\s*(?:tool_call|tool▁call)\s*\|?\s*>/gi;
function createToolRuntime(host2, parseJson3) {
  function shellQuote(s2) {
    return `'${String(s2).replace(/'/g, `'\\''`)}'`;
  }
  function execShellCmd2(call) {
    if (call.tool === "exec") {
      const cmd = typeof call.args.cmd === "string" ? call.args.cmd : "";
      const cwd = typeof call.args.cwd === "string" ? call.args.cwd : void 0;
      if (!cmd) return { error: "exec requires args.cmd" };
      return { shellCmd: cwd && cwd.trim() ? `cd ${shellQuote(cwd)} && ${cmd}` : cmd };
    }
    const args = typeof call.args.args === "string" ? call.args.args : "";
    if (!args) return { error: "codeterm requires args.args" };
    return { shellCmd: `codeterm ${args}` };
  }
  function startExecJob2(shellCmd) {
    return parseJson3(
      host2.execStart(JSON.stringify({ bin: "sh", args: ["-lc", shellCmd], timeoutMs: 12e4 })),
      { error: "host.exec.start returned non-JSON" }
    );
  }
  function pollExecJob2(jobId) {
    return parseJson3(host2.execPoll(jobId), { done: true, error: "host.exec.poll returned non-JSON" });
  }
  function execResultFromPoll2(poll) {
    const result = {};
    if (typeof poll.code === "number") result.code = poll.code;
    if (typeof poll.stdout === "string") result.stdout = poll.stdout;
    if (typeof poll.stderr === "string") result.stderr = poll.stderr;
    if (typeof poll.error === "string") result.error = poll.error;
    return result;
  }
  function formatToolResult2(call, result) {
    return JSON.stringify({ tool: call.tool, args: call.args, result }, null, 2);
  }
  function stripSpans(text, spans) {
    if (!spans.length) return text;
    const ordered = [...spans].sort((a, b) => a.start - b.start);
    let out = "";
    let cursor = 0;
    for (const s2 of ordered) {
      if (s2.start < cursor) continue;
      out += text.slice(cursor, s2.start);
      cursor = s2.end;
    }
    out += text.slice(cursor);
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }
  function expandToolSpan(text, span) {
    FENCE_RE.lastIndex = 0;
    let match;
    while ((match = FENCE_RE.exec(text)) !== null) {
      const start2 = match.index;
      const end2 = match.index + match[0].length;
      if (span.start >= start2 && span.end <= end2) return { start: start2, end: end2 };
    }
    let start = span.start;
    let end = span.end;
    const before = text.slice(0, start);
    TOOL_WRAPPER_RE.lastIndex = 0;
    let wrapper;
    let lastBefore = null;
    while ((wrapper = TOOL_WRAPPER_RE.exec(before)) !== null) lastBefore = wrapper;
    if (lastBefore && before.slice(lastBefore.index + lastBefore[0].length).trim() === "") start = lastBefore.index;
    const after = text.slice(end);
    const afterWrapper = after.match(/^\s*<\s*\|?\/?\s*(?:tool_call|tool▁call)\s*\|?\s*>/i);
    if (afterWrapper) end += afterWrapper[0].length;
    return { start, end };
  }
  function parsedSpan(parsed, text) {
    if (!Array.isArray(parsed.span) || parsed.span.length !== 2) return null;
    const start = typeof parsed.span[0] === "number" ? parsed.span[0] : -1;
    const end = typeof parsed.span[1] === "number" ? parsed.span[1] : -1;
    if (start < 0 || end < start || end > text.length) return null;
    return { start, end };
  }
  function parseToolEntries2(text) {
    let raw = "";
    try {
      raw = host2.toolcall.parse(text, TOOL_SCHEMA_JSON);
    } catch (e) {
      host2.log("warn", `host.toolcall.parse failed: ${String(e)}`);
      return { entries: [], cleaned: text, status: "none" };
    }
    const parsed = parseJson3(raw, null);
    if (!parsed || typeof parsed !== "object") return { entries: [], cleaned: text, status: "none" };
    if (parsed.status === "malformed") {
      const reason = typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "unparseable tool call";
      return { entries: [], cleaned: text, status: "malformed", reason };
    }
    if (parsed.status !== "ok" || typeof parsed.tool !== "string") {
      return { entries: [], cleaned: text, status: "none" };
    }
    const args = parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args) ? parsed.args : {};
    const span = parsedSpan(parsed, text);
    const cleaned = span ? stripSpans(text, [expandToolSpan(text, span)]) : text;
    return {
      entries: [{ call: { tool: parsed.tool, args } }],
      cleaned,
      status: "ok"
    };
  }
  function toolContent2(call) {
    if (call.tool === "exec" && typeof call.args.cmd === "string") return call.args.cmd;
    if (call.tool === "codeterm" && typeof call.args.args === "string") return `codeterm ${call.args.args}`;
    return JSON.stringify(call.args);
  }
  function executeTool2(call) {
    switch (call.tool) {
      case "read_file": {
        const path = typeof call.args.path === "string" ? call.args.path : "";
        if (!path) return { error: "read_file requires args.path" };
        return { content: host2.readFile(path) };
      }
      case "write_file": {
        const path = typeof call.args.path === "string" ? call.args.path : "";
        const content = typeof call.args.content === "string" ? call.args.content : "";
        if (!path) return { error: "write_file requires args.path" };
        return { ok: host2.writeFile(path, content) };
      }
      case "mem_search": {
        const query = typeof call.args.query === "string" ? call.args.query : "";
        if (!query) return { error: "mem_search requires args.query" };
        const maybeHost = host2;
        if (typeof maybeHost.mem === "function") {
          return parseJson3(maybeHost.mem(JSON.stringify({ query })), { error: "host.mem returned non-JSON" });
        }
        return maybeHost.mem && maybeHost.mem.search ? maybeHost.mem.search({ query, k: 5 }) : { error: "host.mem.search unavailable" };
      }
      case "spawn_agent": {
        const provider = typeof call.args.provider === "string" ? call.args.provider : "";
        const task = typeof call.args.task === "string" ? call.args.task : "";
        const workspace = typeof call.args.workspace === "string" ? call.args.workspace : "default";
        if (!provider || !task) return { error: "spawn_agent requires args.provider and args.task" };
        const maybeHost = host2;
        if (maybeHost.agent && maybeHost.agent.spawn) {
          return maybeHost.agent.spawn(workspace, { backend: { provider }, task });
        }
        if (maybeHost.worker && maybeHost.worker.start) {
          return maybeHost.worker.start(JSON.stringify({ provider, task, workspace }));
        }
        return { error: "host.agent.spawn unavailable" };
      }
      default:
        return { error: `unknown tool: ${call.tool}` };
    }
  }
  return {
    execShellCmd: execShellCmd2,
    startExecJob: startExecJob2,
    pollExecJob: pollExecJob2,
    execResultFromPoll: execResultFromPoll2,
    formatToolResult: formatToolResult2,
    parseToolEntries: parseToolEntries2,
    toolContent: toolContent2,
    executeTool: executeTool2
  };
}

// lmstudio/prompts/watcher-orchestration.md
var watcher_orchestration_default = '# Orchestration health watcher\n\nYou observe a **read-only snapshot** of an orchestration group (orchestrator + its managers and workers). Decide whether work is **progressing** or **stalled**. When stalled, you may request a **nudge** to the stuck pane.\n\nYou may investigate with tools when observations are insufficient, then you must finish with **ONLY the verdict JSON** as the final assistant message (no markdown fences, no prose before or after, and no tool block in the final message).\n\n## Tools\n\n**Tool discipline:** call at most ONE tool per tick, only when the snapshot is\ninsufficient. After a `tool_result` arrives, your NEXT message MUST be the\nverdict JSON \u2014 never another tool call for the same question.\n\n\nWhen the snapshot is ambiguous or missing key evidence, use at most the tools needed to clarify it. Available curated tools:\n\n- `exec`: run a shell command.\n- `read_file`: read a file.\n- `write_file`: write a file.\n- `codeterm`: run a CodeTerm command, such as `codeterm plan get` or `codeterm tab status --tab <id>`.\n- `mem_search`: search memory.\n- `spawn_agent`: start an agent only if explicitly needed for investigation.\n\nTool calls use fenced `codeterm-tool` JSON blocks. After each tool result, continue reasoning internally and either call another needed tool or finish with the verdict JSON. Use tools for facts you cannot infer reliably from `observations`, for example checking a pane\'s status or the current plan. Do not include a tool block in the final verdict message.\n\n## Input you receive each tick\n\nThe user message is JSON: `{ "state": <your prior state>, "input": { "tick", "nowMs", "state", "observations" } }`.\n\n`observations` is the host-assembled snapshot. Typical shape:\n\n```json\n{\n  "orchestrator_id": "abc123",\n  "panes": [\n    {\n      "pane_id": "abc123",\n      "title": "Orchestrator",\n      "role": "Orchestrator",\n      "status": "Working",\n      "last_activity_ms": 1700000000000\n    },\n    {\n      "pane_id": "def456",\n      "title": "Worker Alpha",\n      "role": "Worker",\n      "role_profile": null,\n      "status": "Working",\n      "last_activity_ms": 1700000005000,\n      "chatTail": [\n        { "id": "m1", "kind": "user", "content": "finish the task" },\n        { "id": "m2", "kind": "assistant", "content": "working on it\u2026" }\n      ]\n    }\n  ],\n  "reports": [\n    {\n      "id": "r1",\n      "from_pane_id": "def456",\n      "from_title": "Worker Alpha",\n      "message": "Completed step 1",\n      "timestamp": 1700000006000,\n      "status": "Done"\n    }\n  ]\n}\n```\n\nFields you care about on each pane:\n\n| Field | Meaning |\n|---|---|\n| `pane_id` | Target for nudge actions |\n| `title` | Human label |\n| `role` | `Orchestrator`, `Manager`, or `Worker` (may be absent) |\n| `role_profile` | Manager specialization (`planner`, `watcher`, \u2026) or null |\n| `status` | `Working`, `Waiting`, `Idle`, `Dead`, or `Unknown` |\n| `last_activity_ms` | Host clock when the pane last did something meaningful |\n| `chatTail` | Optional: last N parsed chat messages as `{id, kind, content}` objects |\n\nTop-level `orchestrator_id` identifies the orchestrator; the orchestrator also appears as a row in `panes[]`. `reports` is optional (when observation config enables it).\n\n## Progressing vs stalled\n\n**Progressing (`status: "ok"`)** \u2014 recent activity and forward motion:\n\n- `last_activity_ms` on key panes is within ~3 minutes of `nowMs`, **or**\n- worker/manager `status` values are advancing (e.g. `Waiting` \u2192 `Working`, `Working` with fresh `chatTail`), **or**\n- new agent reports arrive at the orchestrator with concrete progress.\n\n**Attention (`status: "attention"`)** \u2014 ambiguous or early warning:\n\n- activity is slowing but not clearly stuck yet, **or**\n- you lack enough data to judge (empty snapshot, missing tails).\n\n**Stalled (`status: "stalled"`)** \u2014 the group needs a kick:\n\n- no meaningful activity on workers for ~5+ minutes while tasks should be active, **or**\n- a worker sits on the same status with no `chatTail` movement, **or**\n- the orchestrator is `Idle` while workers are `Waiting`/`Idle` with no progress, **or**\n- unread reports pile up at the orchestrator with no follow-up.\n\nWhen stalled, emit **at most one nudge** to the most stuck pane. Nudges must be:\n\n- **Short** (1\u20132 sentences)\n- **Evidence-based** (cite what you saw: idle time, status, last `chatTail` line)\n- **Addressed to that pane** (use its `pane_id` in the action)\n\nDo not nudge watchers or the orchestrator unless the orchestrator itself is clearly idle with pending work.\n\n## State\n\nUse `state` to remember lightweight notes across ticks (e.g. `{ "last_nudged": { "def456": 1700000000000 } }`). Keep it small.\n\n## Worked example 1 \u2014 progressing (ok)\n\nObservation (abbreviated):\n\n```json\n{\n  "tick": 2,\n  "nowMs": 1700000120000,\n  "observations": {\n    "orchestrator_id": "o1",\n    "panes": [\n      { "pane_id": "o1", "title": "Orch", "role": "Orchestrator", "status": "Working", "last_activity_ms": 1700000110000 },\n      { "pane_id": "w1", "title": "Worker", "role": "Worker", "role_profile": null, "status": "Working", "last_activity_ms": 1700000118000 }\n    ],\n    "reports": [\n      { "id": "r1", "from_pane_id": "w1", "from_title": "Worker", "message": "Implemented tests", "timestamp": 1700000119000, "status": "Partial" }\n    ]\n  }\n}\n```\n\nYour verdict:\n\n```json\n{"status":"ok","summary":"Worker active in last minute with a progress report.","state":{"seen_ticks":2},"actions":[]}\n```\n\n## Worked example 2 \u2014 stalled worker (one nudge)\n\nObservation (abbreviated):\n\n```json\n{\n  "tick": 5,\n  "nowMs": 1700000420000,\n  "observations": {\n    "orchestrator_id": "o1",\n    "panes": [\n      { "pane_id": "o1", "title": "Orch", "role": "Orchestrator", "status": "Idle", "last_activity_ms": 1700000200000 },\n      {\n        "pane_id": "w1",\n        "title": "Worker",\n        "role": "Worker",\n        "role_profile": null,\n        "status": "Waiting",\n        "last_activity_ms": 1700000000000,\n        "chatTail": [\n          { "id": "m1", "kind": "user", "content": "run the tests" },\n          { "id": "m2", "kind": "assistant", "content": "I\'ll get to it\u2026" }\n        ]\n      }\n    ]\n  }\n}\n```\n\nWorker `w1` has been silent ~7 minutes (`nowMs - last_activity_ms` = 420000 ms) with `status: Waiting` and no new `chatTail`.\n\nYour verdict:\n\n```json\n{"status":"stalled","summary":"Worker w1 Waiting with no activity for 7+ minutes.","state":{"seen_ticks":5,"last_nudged":{"w1":1700000420000}},"actions":[{"kind":"nudge","pane":"w1","message":"Stalled ~7m on \'run the tests\' \u2014 status Waiting, no new chat since \'I\'ll get to it\u2026\'. Please run tests and report STATUS."}]}\n```\n\n## Worked example 3 \u2014 investigate with a codeterm tool, then verdict\n\nObservation (abbreviated):\n\n```json\n{\n  "tick": 8,\n  "nowMs": 1700000600000,\n  "observations": {\n    "orchestrator_id": "o1",\n    "panes": [\n      { "pane_id": "o1", "title": "Orch", "role": "Orchestrator", "status": "Working", "last_activity_ms": 1700000580000 },\n      { "pane_id": "w1", "title": "Worker", "role": "Worker", "status": "Unknown", "last_activity_ms": 1700000200000 }\n    ]\n  }\n}\n```\n\nThe worker looks stale, but `status: Unknown` and missing `chatTail` are insufficient evidence. First check the pane:\n\n```codeterm-tool\n{"tool":"codeterm","args":{"args":"tab status --tab w1"}}\n```\n\nTool result (abbreviated): `{"status":"Working","last_activity_ms":1700000590000,"prompt":"running focused tests"}`\n\nYour final message:\n\n```json\n{"status":"ok","summary":"Worker w1 is active after status check and is running focused tests.","state":{"seen_ticks":8},"actions":[]}\n```\n';

// lmstudio/src/router/config.ts
var LMSTUDIO_PROVIDER_ID = "lmstudio";
var DEFAULT_LMSTUDIO_URL = "http://localhost:1234";
var KEY_SLOTS = [
  "lmstudio_api_key",
  "openai_api_key",
  "anthropic_api_key",
  "openrouter_api_key",
  "groq_api_key",
  "together_api_key",
  "deepseek_api_key",
  "xai_api_key",
  "mistral_api_key",
  "gemini_api_key",
  "mimo_api_key",
  "litellm_api_key",
  "custom1_api_key",
  "custom2_api_key",
  "custom3_api_key",
  "custom4_api_key"
];
var PROVIDER_KINDS_INFO = [
  { kind: "openai", label: "OpenAI-compatible", hint: "/models + /chat/completions \u2014 OpenRouter, Groq, Together, DeepSeek, xAI, Mistral, Ollama, vLLM, LiteLLM, custom" },
  { kind: "anthropic", label: "Anthropic Messages", hint: "/v1/models + /v1/messages with x-api-key" },
  { kind: "lmstudio", label: "LM Studio native", hint: "/api/v0/models with load state + stateful /api/v1/chat" }
];
var PROVIDER_TEMPLATES = [
  { id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "openai", name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
  { id: "groq", name: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "together", name: "Together", kind: "openai", baseUrl: "https://api.together.xyz/v1" },
  { id: "deepseek", name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { id: "xai", name: "xAI", kind: "openai", baseUrl: "https://api.x.ai/v1" },
  { id: "mistral", name: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1" },
  { id: "gemini", name: "Gemini (OpenAI endpoint)", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "ollama", name: "Ollama", kind: "openai", baseUrl: "http://localhost:11434/v1" },
  { id: "litellm", name: "LiteLLM proxy", kind: "openai", baseUrl: "http://localhost:4000/v1" }
];
var ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
var SECRET_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function coerceState(raw) {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const list = (v) => Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
  const state = {
    providers: list(obj.providers),
    presets: list(obj.presets),
    disabled: Array.isArray(obj.disabled) ? obj.disabled.filter((x) => typeof x === "string") : []
  };
  if (typeof obj.defaultProvider === "string" && obj.defaultProvider) state.defaultProvider = obj.defaultProvider;
  return state;
}
function normalizeKind(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "openai" || v === "openai-compatible" || v === "openai_compatible" || v === "oai") return "openai";
  if (v === "anthropic" || v === "anthropic-compatible" || v === "claude") return "anthropic";
  if (v === "lmstudio" || v === "lm-studio" || v === "lmstudio-native") return "lmstudio";
  return null;
}
function defaultKeySlot(id) {
  return `${id}_api_key`;
}
function isDeclaredKeySlot(slot) {
  return KEY_SLOTS.includes(slot);
}
function parseUrl(raw) {
  const m = raw.match(/^(https?):\/\/([^/?#\s@]+)(\/[^?#\s]*)?$/i);
  if (!m) return null;
  return { scheme: m[1].toLowerCase(), authority: m[2], path: (m[3] || "").replace(/\/+$/, "") };
}
function normalizeBaseUrl(raw) {
  if (typeof raw !== "string") return null;
  const parsed = parseUrl(raw.trim());
  if (!parsed) return null;
  return `${parsed.scheme}://${parsed.authority}${parsed.path}`;
}
function hostOf(url) {
  const parsed = parseUrl(url);
  return parsed ? parsed.authority.toLowerCase() : "";
}
function apiRoot(provider) {
  const parsed = parseUrl(provider.baseUrl);
  if (!parsed) return provider.baseUrl.replace(/\/+$/, "");
  const origin = `${parsed.scheme}://${parsed.authority}`;
  if (provider.kind === "lmstudio") return origin + parsed.path.replace(/\/(api\/)?v\d+$/, "");
  if (provider.kind === "anthropic") return /\/v1$/.test(parsed.path) ? origin + parsed.path : `${origin}${parsed.path}/v1`;
  return parsed.path ? origin + parsed.path : `${origin}/v1`;
}
function str(v) {
  return typeof v === "string" ? v.trim() : "";
}
function parseModelIds(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [];
  const out = [];
  for (const item of list) {
    const id = typeof item === "string" ? item.trim() : "";
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
function finiteNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return void 0;
}
function validateProvider(input, takenIds, source = "user") {
  const errors = [];
  const id = str(input.id).toLowerCase();
  if (!ID_RE.test(id)) errors.push({ field: "id", message: "Use 1-32 lowercase letters, digits or dashes." });
  else if (takenIds.includes(id)) errors.push({ field: "id", message: `A provider named ${id} already exists.` });
  const kind = normalizeKind(input.kind);
  if (!kind) errors.push({ field: "kind", message: "Kind must be openai, anthropic or lmstudio." });
  const baseUrl2 = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl2) errors.push({ field: "baseUrl", message: "Enter an http(s) URL such as https://api.example.com/v1." });
  const secretRaw = str(input.apiKeySecret);
  const apiKeySecret = secretRaw || defaultKeySlot(id);
  if (secretRaw && !SECRET_RE.test(apiKeySecret)) errors.push({ field: "apiKeySecret", message: "Key slot may use letters, digits, _ . -" });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id,
      name: str(input.name) || id,
      kind,
      baseUrl: baseUrl2,
      apiKeySecret,
      models: parseModelIds(input.models),
      enabled: input.enabled !== false,
      source
    }
  };
}
function validatePreset(input, takenIds, source = "user") {
  const errors = [];
  const id = str(input.id);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(id)) errors.push({ field: "id", message: "Use 1-48 letters, digits, _ . -" });
  else if (takenIds.includes(id)) errors.push({ field: "id", message: `A preset named ${id} already exists.` });
  const temperature = finiteNumber(input.temperature);
  if (input.temperature !== void 0 && input.temperature !== "" && (temperature === void 0 || temperature < 0 || temperature > 2)) {
    errors.push({ field: "temperature", message: "Temperature must be between 0 and 2." });
  }
  const maxTokens2 = finiteNumber(input.maxTokens);
  if (input.maxTokens !== void 0 && input.maxTokens !== "" && (maxTokens2 === void 0 || maxTokens2 < 1 || !Number.isInteger(maxTokens2))) {
    errors.push({ field: "maxTokens", message: "Max tokens must be a positive whole number." });
  }
  if (input.params !== void 0 && (typeof input.params !== "object" || input.params === null || Array.isArray(input.params))) {
    errors.push({ field: "params", message: "params must be an object." });
  }
  if (errors.length) return { ok: false, errors };
  const preset = { id, name: str(input.name) || id, source };
  const description = str(input.description);
  if (description) preset.description = description;
  const provider = str(input.provider).toLowerCase();
  if (provider) preset.provider = provider;
  const model = str(input.model);
  if (model) preset.model = model;
  if (temperature !== void 0) preset.temperature = temperature;
  if (maxTokens2 !== void 0) preset.maxTokens = maxTokens2;
  if (typeof input.systemPrompt === "string") preset.systemPrompt = input.systemPrompt;
  if (input.params && typeof input.params === "object") preset.params = { ...input.params };
  return { ok: true, value: preset };
}
function builtinLmStudio(settings2) {
  return {
    id: LMSTUDIO_PROVIDER_ID,
    name: "LM Studio",
    kind: "lmstudio",
    baseUrl: normalizeBaseUrl(settings2.baseUrl) || DEFAULT_LMSTUDIO_URL,
    apiKeySecret: defaultKeySlot(LMSTUDIO_PROVIDER_ID),
    models: [],
    enabled: true,
    source: "builtin"
  };
}
function resolveProviders(settings2, state) {
  const issues = [];
  const providers = [];
  const declared = Array.isArray(settings2.providers) ? settings2.providers : [];
  const declaresLmStudio = declared.some((p2) => p2 && str(p2.id).toLowerCase() === LMSTUDIO_PROVIDER_ID);
  if (!declaresLmStudio) providers.push(builtinLmStudio(settings2));
  const add = (input, source) => {
    const result = validateProvider(input, providers.map((p2) => p2.id), source);
    if (result.ok) providers.push(result.value);
    else issues.push(`provider ${str(input && input.id) || "?"}: ${result.errors.map((e) => e.message).join(" ")}`);
  };
  for (const input of declared) add(input, "config");
  for (const input of state.providers) add(input, "user");
  for (const p2 of providers) if (state.disabled.includes(p2.id)) p2.enabled = false;
  return { providers, issues };
}
function resolvePresets(settings2, state) {
  const presets2 = [];
  const add = (input, source) => {
    const result = validatePreset(input, presets2.map((p2) => p2.id), source);
    if (result.ok) presets2.push(result.value);
  };
  if (Array.isArray(settings2.presets)) {
    for (const p2 of settings2.presets) if (p2) add(p2, "config");
  }
  for (const p2 of state.presets) add(p2, "user");
  return presets2;
}
function defaultProviderId(settings2, state, providers) {
  const wanted = [state.defaultProvider, str(settings2.defaultProvider), LMSTUDIO_PROVIDER_ID];
  for (const id of wanted) {
    if (id && providers.some((p2) => p2.id === id && p2.enabled)) return id;
  }
  const first = providers.find((p2) => p2.enabled);
  return first ? first.id : LMSTUDIO_PROVIDER_ID;
}
function keyRequired(provider) {
  if (provider.kind === "anthropic") return true;
  if (provider.kind === "lmstudio") return false;
  const host2 = hostOf(provider.baseUrl).replace(/:\d+$/, "");
  return !(host2 === "localhost" || host2 === "127.0.0.1" || host2 === "[::1]" || /\.(local|ts\.net)$/.test(host2) || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host2));
}

// lmstudio/src/router/toolspec.ts
var p = (name, description, required = true) => ({ name, description, required });
var TOOL_SPECS = [
  { name: "exec", description: "Run a shell command and return its exit code, stdout and stderr.", params: [p("cmd", "Shell command line."), p("cwd", "Working directory.", false)] },
  { name: "codeterm", description: "Run the Domios CLI: `codeterm <args>`.", params: [p("args", "Arguments after `codeterm`, e.g. `tab list`.")] },
  { name: "read_file", description: "Read a text file.", params: [p("path", "File path.")] },
  { name: "write_file", description: "Write a text file, replacing its content.", params: [p("path", "File path."), p("content", "Full file content.")] },
  { name: "mem_search", description: "Search Domios memory.", params: [p("query", "Search query.")] },
  { name: "spawn_agent", description: "Spawn an agent tab with a task.", params: [p("provider", "Agent provider id."), p("task", "Task text."), p("workspace", "Workspace id.", false)] }
];
function toolSpec(name) {
  return TOOL_SPECS.find((t) => t.name === name);
}
function jsonSchema(spec) {
  const properties = {};
  for (const param of spec.params) properties[param.name] = { type: "string", description: param.description };
  return { type: "object", properties, required: spec.params.filter((x) => x.required).map((x) => x.name) };
}
function openAiTools() {
  return TOOL_SPECS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: jsonSchema(t) } }));
}
function anthropicTools() {
  return TOOL_SPECS.map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t) }));
}
function checkToolArgs(name, raw) {
  const spec = toolSpec(name);
  if (!spec) return { ok: false, error: `unknown tool: ${name}. Declared tools: ${TOOL_SPECS.map((t) => t.name).join(", ")}` };
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const args = {};
  for (const param of spec.params) {
    const value = input[param.name];
    if (typeof value === "string") args[param.name] = value;
    else if (typeof value === "number" || typeof value === "boolean") args[param.name] = String(value);
  }
  const missing = spec.params.filter((x) => x.required && !args[x.name]).map((x) => x.name);
  if (missing.length) return { ok: false, error: `${name} requires ${missing.join(", ")}` };
  return { ok: true, args };
}

// lmstudio/src/router/toolwire.ts
function pairToolCalls(turns) {
  const answered = /* @__PURE__ */ new Set();
  for (const t of turns) if (t.role === "tool" && t.toolCallId) answered.add(t.toolCallId);
  const out = [];
  let open = /* @__PURE__ */ new Set();
  for (const t of turns) {
    if (t.role === "tool") {
      if (t.toolCallId && open.has(t.toolCallId)) out.push({ ...t });
      continue;
    }
    if (t.role === "assistant" && t.toolCalls && t.toolCalls.length) {
      const kept = t.toolCalls.filter((c) => answered.has(c.id));
      open = new Set(kept.map((c) => c.id));
      const turn = { role: "assistant", content: t.content };
      if (kept.length) turn.toolCalls = kept;
      out.push(turn);
      continue;
    }
    if (t.role === "user") open = /* @__PURE__ */ new Set();
    out.push({ ...t });
  }
  return out;
}
function mergeToolParts(into, parts) {
  for (const part of parts) {
    const slot = into.find((x) => x.index === part.index);
    if (!slot) {
      into.push({ ...part });
      continue;
    }
    if (part.id) slot.id = part.id;
    if (part.name) slot.name = part.name;
    slot.args += part.args;
  }
}
function finishToolCalls(parts) {
  return parts.filter((x) => x.name).sort((a, b) => a.index - b.index).map((x) => ({ id: x.id || `call_${x.index}`, name: x.name, arguments: x.args.trim() || "{}" }));
}
function openAiMessage(t) {
  if (t.role === "tool") return { role: "tool", tool_call_id: t.toolCallId, content: t.content };
  if (t.role === "assistant" && t.toolCalls && t.toolCalls.length) {
    return {
      role: "assistant",
      content: t.content || null,
      tool_calls: t.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }))
    };
  }
  return { role: t.role, content: t.content };
}
function parsedInput(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function anthropicMessages(turns) {
  const out = [];
  for (const t of turns) {
    const role = t.role === "assistant" ? "assistant" : "user";
    const blocks = [];
    if (t.role === "tool") blocks.push({ type: "tool_result", tool_use_id: t.toolCallId, content: t.content });
    else if (t.content) blocks.push({ type: "text", text: t.content });
    for (const c of t.toolCalls || []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: parsedInput(c.arguments) });
    if (!blocks.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  return out;
}

// lmstudio/src/router/adapters.ts
var ANTHROPIC_VERSION = "2023-06-01";
var ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;
var DISCOVERY_TIMEOUT_MS = 8e3;
var CHAT_TIMEOUT_MS = 12e4;
function authHeaders(provider, key) {
  const headers = { "content-type": "application/json" };
  if (provider.kind === "anthropic") {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (key) headers["x-api-key"] = key;
  } else if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}
function modelsRequests(provider, key) {
  const root = apiRoot(provider);
  const headers = authHeaders(provider, key);
  const get = (url) => ({ url, method: "GET", headers, timeoutMs: DISCOVERY_TIMEOUT_MS });
  if (provider.kind === "lmstudio") return [get(`${root}/api/v0/models`), get(`${root}/api/v1/models`), get(`${root}/v1/models`)];
  return [get(`${root}/models`)];
}
function normalizeTurns(turns) {
  const out = [];
  for (const t of pairToolCalls(turns)) {
    const calls = t.toolCalls && t.toolCalls.length ? t.toolCalls : void 0;
    if (!t.content && !calls && t.role !== "tool") continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role && t.role !== "tool" && !last.toolCalls) {
      last.content = last.content && t.content ? `${last.content}

${t.content}` : last.content || t.content;
      if (calls) last.toolCalls = calls;
    } else {
      const turn = { role: t.role, content: t.content };
      if (calls) turn.toolCalls = calls;
      if (t.toolCallId) turn.toolCallId = t.toolCallId;
      out.push(turn);
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}
function cacheBreakpoints(hasSystem, turns) {
  let newestUser = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === "user") {
      newestUser = i;
      break;
    }
  }
  return { system: hasSystem, messageIndex: newestUser > 0 ? newestUser - 1 : -1 };
}
var EPHEMERAL = { type: "ephemeral" };
function anthropicBody(req) {
  const messages2 = anthropicMessages(normalizeTurns(req.turns));
  const plan = cacheBreakpoints(!!req.system, messages2);
  const marked = messages2[plan.messageIndex];
  if (marked) {
    const blocks = marked.content;
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL };
  }
  const { max_tokens: maxTokens2, ...rest } = req.params;
  const body = {
    ...rest,
    model: req.model,
    max_tokens: typeof maxTokens2 === "number" && maxTokens2 > 0 ? maxTokens2 : ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: messages2,
    stream: true
  };
  if (req.system) body.system = [{ type: "text", text: req.system, cache_control: EPHEMERAL }];
  if (req.tools) {
    body.tools = anthropicTools();
    body.tool_choice = { type: "auto" };
  }
  return body;
}
function openAiBody(req) {
  const messages2 = [];
  if (req.system) messages2.push({ role: "system", content: req.system });
  for (const t of normalizeTurns(req.turns)) messages2.push(openAiMessage(t));
  const body = {
    ...req.params,
    model: req.model,
    messages: messages2,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (req.tools) {
    body.tools = openAiTools();
    body.tool_choice = "auto";
  }
  return body;
}
function chatRequest(provider, key, req) {
  const root = apiRoot(provider);
  const headers = authHeaders(provider, key);
  if (provider.kind === "anthropic") {
    return { url: `${root}/messages`, method: "POST", headers, body: JSON.stringify(anthropicBody(req)), timeoutMs: CHAT_TIMEOUT_MS };
  }
  return { url: `${root}/chat/completions`, method: "POST", headers, body: JSON.stringify(openAiBody(req)), timeoutMs: CHAT_TIMEOUT_MS };
}
function splitSse(buffer, flush) {
  const segments = buffer.split(/\r?\n\r?\n/);
  const rest = flush ? "" : segments.pop() ?? "";
  const events = [];
  for (const seg of segments) {
    let event = "";
    let data = "";
    for (const line of seg.split(/\r?\n/)) {
      if (line.indexOf("event:") === 0) event = line.slice(6).trim();
      else if (line.indexOf("data:") === 0) {
        let v = line.slice(5);
        if (v.charAt(0) === " ") v = v.slice(1);
        data += data ? `
${v}` : v;
      }
    }
    if (data || event) events.push({ event, data });
  }
  return { events, rest };
}
function n(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
function emptyDelta() {
  return { content: "", reasoning: "", usage: null, responseId: null, error: null, toolParts: [] };
}
function openAiUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const u = raw;
  const details = u.prompt_tokens_details && typeof u.prompt_tokens_details === "object" ? u.prompt_tokens_details : {};
  const input = n(u.prompt_tokens) || n(u.input_tokens);
  const cached = n(details.cached_tokens) || n(u.prompt_cache_hit_tokens) || n(u.cached_tokens);
  const output = n(u.completion_tokens) || n(u.output_tokens);
  if (!input && !output) return null;
  return { input, cachedInput: Math.min(cached, input || cached), cacheWrite: 0, output };
}
function anthropicUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const u = raw;
  const read = n(u.cache_read_input_tokens);
  const write = n(u.cache_creation_input_tokens);
  const input = n(u.input_tokens) + read + write;
  const output = n(u.output_tokens);
  if (!input && !output) return null;
  return { input, cachedInput: read, cacheWrite: write, output };
}
function mergeUsage(prev, next) {
  if (!next) return prev;
  if (!prev) return next;
  return {
    input: next.input || prev.input,
    cachedInput: next.cachedInput || prev.cachedInput,
    cacheWrite: next.cacheWrite || prev.cacheWrite,
    output: next.output || prev.output
  };
}
function errorMessage(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const o = raw;
    if (typeof o.message === "string") return o.message;
    if (o.error) return errorMessage(o.error);
  }
  return null;
}
function openAiToolParts(calls) {
  return calls.map((call, i) => {
    const fn = call && typeof call.function === "object" && call.function ? call.function : {};
    const part = { index: typeof call.index === "number" ? call.index : i, args: "" };
    if (typeof call.id === "string" && call.id) part.id = call.id;
    if (typeof fn.name === "string" && fn.name) part.name = fn.name;
    if (typeof fn.arguments === "string") part.args = fn.arguments;
    else if (fn.arguments && typeof fn.arguments === "object") part.args = JSON.stringify(fn.arguments);
    return part;
  });
}
function anthropicToolPart(index, block) {
  const input = block.input && typeof block.input === "object" && Object.keys(block.input).length ? JSON.stringify(block.input) : "";
  return { index, id: String(block.id || ""), name: String(block.name || ""), args: input };
}
function applyOpenAiEvent(acc, ev) {
  if (!ev.data || ev.data === "[DONE]") return;
  let data;
  try {
    data = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (data.error) {
    acc.error = errorMessage(data.error) || "stream error";
    return;
  }
  if (typeof data.id === "string" && !acc.responseId) acc.responseId = data.id;
  const choices = Array.isArray(data.choices) ? data.choices : [];
  for (const c of choices) {
    const delta = c && typeof c.delta === "object" && c.delta ? c.delta : c && typeof c.message === "object" && c.message ? c.message : {};
    if (typeof delta.content === "string") acc.content += delta.content;
    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
    if (reasoning) acc.reasoning += reasoning;
    if (Array.isArray(delta.tool_calls)) acc.toolParts.push(...openAiToolParts(delta.tool_calls));
  }
  acc.usage = mergeUsage(acc.usage, openAiUsage(data.usage));
}
function applyAnthropicEvent(acc, ev) {
  if (!ev.data) return;
  let data;
  try {
    data = JSON.parse(ev.data);
  } catch {
    return;
  }
  const type = typeof data.type === "string" ? data.type : ev.event;
  if (type === "error") {
    acc.error = errorMessage(data.error) || "stream error";
  } else if (type === "message_start" && data.message && typeof data.message === "object") {
    const message = data.message;
    if (typeof message.id === "string") acc.responseId = message.id;
    acc.usage = mergeUsage(acc.usage, anthropicUsage(message.usage));
  } else if (type === "content_block_start" && data.content_block && typeof data.content_block === "object") {
    const block = data.content_block;
    if (block.type === "tool_use") acc.toolParts.push(anthropicToolPart(Number(data.index) || 0, block));
  } else if (type === "content_block_delta" && data.delta && typeof data.delta === "object") {
    const delta = data.delta;
    if (typeof delta.text === "string") acc.content += delta.text;
    else if (typeof delta.thinking === "string") acc.reasoning += delta.thinking;
    else if (typeof delta.partial_json === "string") acc.toolParts.push({ index: Number(data.index) || 0, args: delta.partial_json });
  } else if (type === "message_delta" && data.usage && typeof data.usage === "object") {
    const u = data.usage;
    const prev = acc.usage || { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
    const read = n(u.cache_read_input_tokens) || prev.cachedInput;
    const write = n(u.cache_creation_input_tokens) || prev.cacheWrite;
    const input = n(u.input_tokens) ? n(u.input_tokens) + read + write : prev.input;
    acc.usage = { input, cachedInput: read, cacheWrite: write, output: n(u.output_tokens) || prev.output };
  }
}
function applyWholeBody(kind, acc, body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return false;
  }
  if (!data || typeof data !== "object") return false;
  if (kind === "anthropic" && Array.isArray(data.content)) {
    data.content.forEach((block, i) => {
      if (block && block.type === "text" && typeof block.text === "string") acc.content += block.text;
      if (block && block.type === "thinking" && typeof block.thinking === "string") acc.reasoning += block.thinking;
      if (block && block.type === "tool_use") acc.toolParts.push(anthropicToolPart(i, block));
    });
    if (typeof data.id === "string") acc.responseId = data.id;
    acc.usage = anthropicUsage(data.usage) || acc.usage;
    return true;
  }
  if (Array.isArray(data.choices)) {
    applyOpenAiEvent(acc, { event: "", data: body });
    return true;
  }
  return false;
}
function groupDigits(value) {
  const s2 = String(Math.round(value));
  return s2.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function formatUsage(u) {
  const fresh = Math.max(0, u.input - u.cachedInput);
  const parts = [`${groupDigits(u.input)} in`];
  if (u.cachedInput || u.cacheWrite) {
    parts.push(`${groupDigits(u.cachedInput)} cached`, `${groupDigits(fresh)} fresh`);
    if (u.cacheWrite) parts.push(`${groupDigits(u.cacheWrite)} cache write`);
  }
  parts.push(`${groupDigits(u.output)} out`);
  return parts.join(" \xB7 ");
}
function snippet(body) {
  if (!body) return "";
  let text = body;
  try {
    text = errorMessage(JSON.parse(body)) || body;
  } catch {
  }
  if (/<\/?[a-z][^>]*>/i.test(text)) text = text.replace(/<title>[\s\S]*?<\/title>/i, "").replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 197)}\u2026` : text;
}
function classifyFetch(url, res) {
  if (res.error) {
    const e = res.error;
    if (/denied/i.test(e)) {
      return { kind: "denied", message: `CodeTerm blocks ${hostOf(url)}. Grant it: codeterm plugin settings lmstudio --allow-host ${hostOf(url)}` };
    }
    if (/time(d)?\s*out|timeout|deadline/i.test(e)) return { kind: "timeout", message: `${hostOf(url)} did not answer in time.` };
    return { kind: "unreachable", message: `Cannot reach ${hostOf(url)}: ${snippet(e)}` };
  }
  const status = res.status || 0;
  if (status >= 200 && status < 300) return null;
  const detail = snippet(res.body);
  if (status === 401 || status === 403) return { kind: "auth", status, message: `Key rejected (HTTP ${status})${detail ? `: ${detail}` : ""}` };
  if (status === 404) return { kind: "not_found", status, message: `Endpoint not found (HTTP 404)${detail ? `: ${detail}` : ""}` };
  return { kind: "http", status, message: `HTTP ${status || "?"}${detail ? `: ${detail}` : ""}` };
}
function redact(text, key) {
  if (!key || key.length < 4) return text;
  return text.split(key).join("[redacted]");
}

// lmstudio/src/router/models.ts
function rows(body) {
  if (Array.isArray(body)) return body.filter((r) => !!r && typeof r === "object");
  if (!body || typeof body !== "object") return [];
  const obj = body;
  for (const key of ["data", "models"]) {
    const list = obj[key];
    if (Array.isArray(list)) return list.filter((r) => !!r && typeof r === "object");
  }
  return [];
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : void 0;
}
function strList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.toLowerCase()) : [];
}
function capabilities(row) {
  const caps = {};
  const topProvider = row.top_provider && typeof row.top_provider === "object" ? row.top_provider : {};
  const ctx = num(row.context_length) ?? num(row.context_window) ?? num(row.max_context_length) ?? num(row.max_input_tokens) ?? num(topProvider.context_length);
  if (ctx) caps.contextLength = ctx;
  const arch = row.architecture && typeof row.architecture === "object" ? row.architecture : {};
  const inputModalities = strList(arch.input_modalities).concat(strList(row.input_modalities), strList(row.modalities));
  const capObj = row.capabilities && typeof row.capabilities === "object" && !Array.isArray(row.capabilities) ? row.capabilities : null;
  const capList = strList(row.capabilities);
  const params = strList(row.supported_parameters);
  if (inputModalities.includes("image") || row.type === "vlm" || row.vision === true || capObj && (capObj.vision === true || capObj.image_input === true) || capList.includes("vision")) caps.vision = true;
  if (params.includes("tools") || params.includes("tool_choice") || capList.includes("tool_use") || capList.includes("tools") || row.trained_for_tool_use === true || capObj && (capObj.function_calling === true || capObj.tool_use === true || capObj.tools === true)) caps.tools = true;
  if (params.includes("reasoning") || params.includes("include_reasoning") || capList.includes("reasoning") || capObj && (capObj.reasoning === true || capObj.thinking === true)) {
    caps.reasoning = true;
  }
  return caps;
}
function isEmbedding(row, id) {
  return row.type === "embeddings" || row.type === "embedding" || /(^|[-_/])embed/i.test(id);
}
function parseModelList2(providerId, body) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const row of rows(body)) {
    const id = typeof row.id === "string" ? row.id : typeof row.key === "string" ? row.key : "";
    if (!id || seen.has(id) || isEmbedding(row, id)) continue;
    seen.add(id);
    const displayName = typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : typeof row.name === "string" && row.name.trim() ? row.name.trim() : id;
    const model = { providerId, id, displayName, capabilities: capabilities(row) };
    if (row.state === "loaded" || Array.isArray(row.loaded_instances) && row.loaded_instances.length > 0) model.loaded = true;
    else if (row.state === "not-loaded" || Array.isArray(row.loaded_instances)) model.loaded = false;
    out.push(model);
  }
  return out;
}
function formatContext(tokens) {
  if (tokens >= 1e6) return `${+(tokens / 1e6).toFixed(tokens % 1e6 ? 1 : 0)}M`;
  if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}k`;
  return String(tokens);
}
function capabilityBadges(caps) {
  const out = [];
  if (caps.contextLength) out.push(formatContext(caps.contextLength));
  if (caps.vision) out.push("vision");
  if (caps.tools) out.push("tools");
  if (caps.reasoning) out.push("reasoning");
  return out;
}
function fold(s2) {
  return s2.toLowerCase();
}
function matchScore(model, providerName, query) {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return 1;
  const id = fold(model.id);
  const name = fold(model.displayName);
  const hay = `${id} ${name} ${fold(providerName)} ${fold(model.providerId)} ${capabilityBadges(model.capabilities).join(" ")}`;
  let score2 = 0;
  for (const t of tokens) {
    if (!hay.includes(t)) return 0;
    if (id === t || name === t) score2 += 100;
    else if (id.startsWith(t) || name.startsWith(t) || id.includes(`/${t}`)) score2 += 40;
    else if (id.includes(t) || name.includes(t)) score2 += 20;
    else score2 += 5;
  }
  return score2;
}
function groupAndSearch(providers, models, query) {
  const q = query.trim();
  return providers.map((provider) => {
    const own = models.filter((m) => m.providerId === provider.id);
    if (!q) return { provider, models: own, total: own.length };
    const ranked = own.map((m, i) => ({ m, i, s: matchScore(m, provider.name, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.m);
    return { provider, models: ranked, total: own.length };
  });
}

// lmstudio/src/router/routing.ts
var MODEL_SEPARATOR = "::";
function qualifyModel(providerId, model) {
  if (!model) return "";
  return providerId === LMSTUDIO_PROVIDER_ID ? model : `${providerId}${MODEL_SEPARATOR}${model}`;
}
function splitModelId(raw) {
  const value = raw.trim();
  const at = value.indexOf(MODEL_SEPARATOR);
  if (at <= 0) return { providerId: null, model: value };
  return { providerId: value.slice(0, at).toLowerCase(), model: value.slice(at + MODEL_SEPARATOR.length) };
}
function bareProvider(providers, defaultProvider) {
  return providers.find((p2) => p2.id === LMSTUDIO_PROVIDER_ID && p2.enabled) || providers.find((p2) => p2.id === defaultProvider && p2.enabled) || providers.find((p2) => p2.enabled) || null;
}
function resolveModelTarget(raw, providers, defaultProvider, presetProvider) {
  const { providerId, model } = splitModelId(raw);
  if (providerId) {
    const provider2 = providers.find((p2) => p2.id === providerId) || null;
    if (!provider2) return { provider: null, model, error: `unknown provider "${providerId}"` };
    if (!provider2.enabled) return { provider: null, model, error: `provider "${providerId}" is disabled` };
    return { provider: provider2, model };
  }
  if (presetProvider) {
    const provider2 = providers.find((p2) => p2.id === presetProvider) || null;
    if (!provider2) return { provider: null, model, error: `unknown provider "${presetProvider}"` };
    if (!provider2.enabled) return { provider: null, model, error: `provider "${presetProvider}" is disabled` };
    return { provider: provider2, model };
  }
  const provider = bareProvider(providers, defaultProvider);
  return provider ? { provider, model } : { provider: null, model, error: "no enabled provider" };
}
function presetModelId(preset) {
  const model = (preset.model || "").trim();
  if (!model) return "";
  if (splitModelId(model).providerId) return model;
  return preset.provider ? qualifyModel(preset.provider, model) : model;
}
function presetParams(preset) {
  if (!preset) return {};
  const params = { ...preset.params || {} };
  if (preset.temperature !== void 0) params.temperature = preset.temperature;
  if (preset.maxTokens !== void 0) params.max_tokens = preset.maxTokens;
  return params;
}

// lmstudio/src/router/store.ts
var STATE_REL = ".codeterm/plugins/lmstudio/router.json";
var MODEL_CACHE_REL = ".codeterm/plugins/lmstudio/router-models.json";
var REMOTE_MODEL_TTL_MS = 10 * 60 * 1e3;
var LOCAL_MODEL_TTL_MS = 15 * 1e3;
var FAILURE_TTL_MS = 60 * 1e3;
function configuredModels(provider) {
  return provider.models.map((id) => ({ providerId: provider.id, id, displayName: id, capabilities: {} }));
}
var memCache = null;
function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function dataPath(rel) {
  try {
    const viaFs = host.fs && typeof host.fs.expandHome === "function" ? host.fs.expandHome(`~/${rel}`) : null;
    if (viaFs) return viaFs;
    const viaHost = typeof host.expandHome === "function" ? host.expandHome(`~/${rel}`) : null;
    if (viaHost) return viaHost;
    const home = typeof host.homeDir === "function" ? host.homeDir() : null;
    return home ? `${home.replace(/\/+$/, "")}/${rel}` : null;
  } catch {
    return null;
  }
}
function writeJsonFile(rel, value) {
  const path = dataPath(rel);
  if (!path) return false;
  try {
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (slash > 0 && typeof host.makeDirs === "function") host.makeDirs(path.slice(0, slash));
    const text = JSON.stringify(value, null, 2);
    return typeof host.writeFileAtomic === "function" ? host.writeFileAtomic(path, text) : host.writeFile(path, text);
  } catch {
    return false;
  }
}
function readJsonFile(rel) {
  const path = dataPath(rel);
  if (!path) return null;
  try {
    return parseJson(host.readFile(path), null);
  } catch {
    return null;
  }
}
function readSettings() {
  const raw = parseJson(host.settingsJson ? host.settingsJson() : "{}", {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}
function readState() {
  return coerceState(readJsonFile(STATE_REL));
}
function writeState(state) {
  return writeJsonFile(STATE_REL, state);
}
function snapshot() {
  const settings2 = readSettings();
  const state = readState();
  const { providers, issues } = resolveProviders(settings2, state);
  return {
    settings: settings2,
    state,
    providers,
    presets: resolvePresets(settings2, state),
    defaultProvider: defaultProviderId(settings2, state, providers),
    issues
  };
}
function secretsAvailable() {
  return typeof host.secretGet === "function";
}
function getKey(provider) {
  if (!secretsAvailable()) return null;
  try {
    const value = host.secretGet(provider.apiKeySecret);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}
function hasKey(provider) {
  return !!getKey(provider);
}
function setKey(slot, value) {
  if (typeof host.secretSet !== "function") return false;
  try {
    return host.secretSet(slot, value);
  } catch {
    return false;
  }
}
function deleteKey(slot) {
  if (typeof host.secretDelete !== "function") return false;
  try {
    return host.secretDelete(slot);
  } catch {
    return false;
  }
}
function fetchSync(req) {
  try {
    return parseJson(host.fetch(JSON.stringify(req)), { error: "fetch returned non-JSON" });
  } catch (e) {
    return { error: String(e) };
  }
}
function cache() {
  if (!memCache) {
    const stored = readJsonFile(MODEL_CACHE_REL);
    memCache = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  }
  return memCache;
}
function persistCache() {
  const entries = cache();
  const durable = {};
  for (const id of Object.keys(entries)) if (!entries[id].error) durable[id] = entries[id];
  writeJsonFile(MODEL_CACHE_REL, durable);
}
function invalidateModels(providerId) {
  delete cache()[providerId];
}
function resetModelCache() {
  memCache = {};
}
function cachedModels(provider) {
  const entry = cache()[provider.id];
  return entry && entry.baseUrl === provider.baseUrl ? entry : null;
}
function ttl(provider) {
  return provider.kind === "lmstudio" ? LOCAL_MODEL_TTL_MS : REMOTE_MODEL_TTL_MS;
}
function now() {
  try {
    return typeof host.unixNowMs === "function" ? host.unixNowMs() : Date.now();
  } catch {
    return Date.now();
  }
}
function discoverModels(provider, opts) {
  const existing = cachedModels(provider);
  const reusable = existing && !(existing.error && existing.error.kind === "key_missing");
  if (!opts?.force && existing && reusable && now() - existing.at < (existing.error ? FAILURE_TTL_MS : ttl(provider))) return existing;
  const key = getKey(provider);
  let entry;
  if (!key && keyRequired(provider)) {
    entry = {
      at: now(),
      baseUrl: provider.baseUrl,
      models: existing ? existing.models : [],
      error: { kind: "key_missing", message: `No API key in slot ${provider.apiKeySecret}.` }
    };
  } else {
    entry = { at: now(), baseUrl: provider.baseUrl, models: [], error: { kind: "unreachable", message: "no model endpoint answered" } };
    for (const req of modelsRequests(provider, key)) {
      const res = fetchSync(req);
      const failure = classifyFetch(req.url, res);
      if (failure) {
        entry.error = failure;
        if (failure.kind === "not_found") continue;
        break;
      }
      const body = parseJson(res.body, void 0);
      if (body === void 0) {
        entry.error = { kind: "parse", message: "The model list was not JSON." };
        continue;
      }
      entry.models = parseModelList2(provider.id, body);
      entry.error = null;
      break;
    }
    if (entry.error && entry.error.kind === "not_found" && provider.models.length) {
      entry.models = configuredModels(provider);
      entry.error = null;
      entry.configured = true;
    } else if (entry.error && existing) entry.models = existing.models;
  }
  cache()[provider.id] = entry;
  persistCache();
  return entry;
}
function statusFromEntry(provider, entry) {
  if (!provider.enabled) return { state: "disabled", message: "Disabled", modelCount: entry ? entry.models.length : 0, checkedAt: entry ? entry.at : null };
  if (!entry) {
    if (keyRequired(provider) && !hasKey(provider)) return { state: "key_missing", message: `No API key in slot ${provider.apiKeySecret}.`, modelCount: 0, checkedAt: null };
    return { state: "unchecked", message: "Not checked yet", modelCount: 0, checkedAt: null };
  }
  const count = entry.models.length;
  if (!entry.error) {
    const message = entry.configured ? `No model listing here; using ${count} configured model${count === 1 ? "" : "s"}` : `${count} model${count === 1 ? "" : "s"}`;
    return { state: "connected", message, modelCount: count, checkedAt: entry.at };
  }
  const kind = entry.error.kind;
  const state = kind === "key_missing" ? "key_missing" : kind === "auth" ? "auth" : kind === "denied" ? "denied" : kind === "unreachable" || kind === "timeout" ? "unreachable" : "error";
  return { state, message: entry.error.message, modelCount: count, checkedAt: entry.at };
}

// lmstudio/src/router/manage.ts
function fail(error, fieldErrors) {
  return fieldErrors ? { ok: false, error, fieldErrors } : { ok: false, error };
}
function providerView(p2, defaultProvider) {
  return {
    id: p2.id,
    name: p2.name,
    kind: p2.kind,
    baseUrl: p2.baseUrl,
    host: hostOf(p2.baseUrl),
    apiKeySecret: p2.apiKeySecret,
    models: p2.models,
    keySlotDeclared: isDeclaredKeySlot(p2.apiKeySecret),
    hasKey: hasKey(p2),
    enabled: p2.enabled,
    source: p2.source,
    isDefault: p2.id === defaultProvider,
    status: statusFromEntry(p2, cachedModels(p2))
  };
}
function listProviders() {
  const snap = snapshot();
  return {
    providers: snap.providers.map((p2) => providerView(p2, snap.defaultProvider)),
    defaultProvider: snap.defaultProvider,
    issues: snap.issues
  };
}
function stripUserProvider(input) {
  const out = { id: input.id, name: input.name, kind: input.kind, baseUrl: input.baseUrl };
  if (input.apiKeySecret) out.apiKeySecret = input.apiKeySecret;
  if (Array.isArray(input.models) && input.models.length) out.models = input.models;
  return out;
}
function addProvider(input) {
  const snap = snapshot();
  const result = validateProvider(input, snap.providers.map((p3) => p3.id));
  if (!result.ok) return fail(result.errors.map((e) => e.message).join(" "), result.errors);
  const p2 = result.value;
  snap.state.providers.push(stripUserProvider({ id: p2.id, name: p2.name, kind: p2.kind, baseUrl: p2.baseUrl, apiKeySecret: p2.apiKeySecret, models: p2.models }));
  if (!writeState(snap.state)) return fail("Could not save the provider list.");
  return { ok: true, provider: providerView(p2, snap.defaultProvider) };
}
function updateProvider(id, input) {
  const snap = snapshot();
  const existing = snap.providers.find((p3) => p3.id === id);
  if (!existing) return fail(`Unknown provider ${id}.`);
  if (existing.source !== "user") return fail(`${existing.name} is defined in config.yaml; edit it there.`);
  const merged = { ...existing, ...input, id };
  const result = validateProvider(merged, snap.providers.filter((p3) => p3.id !== id).map((p3) => p3.id));
  if (!result.ok) return fail(result.errors.map((e) => e.message).join(" "), result.errors);
  const p2 = result.value;
  snap.state.providers = snap.state.providers.map(
    (raw) => String(raw.id || "").toLowerCase() === id ? stripUserProvider({ id, name: p2.name, kind: p2.kind, baseUrl: p2.baseUrl, apiKeySecret: p2.apiKeySecret, models: p2.models }) : raw
  );
  if (!writeState(snap.state)) return fail("Could not save the provider list.");
  invalidateModels(id);
  return { ok: true, provider: providerView({ ...p2, enabled: existing.enabled }, snap.defaultProvider) };
}
function removeProvider(id) {
  const snap = snapshot();
  const existing = snap.providers.find((p2) => p2.id === id);
  if (!existing) return fail(`Unknown provider ${id}.`);
  if (existing.source !== "user") return fail(`${existing.name} is ${existing.source === "builtin" ? "built in; disable it instead" : "defined in config.yaml"}.`);
  snap.state.providers = snap.state.providers.filter((raw) => String(raw.id || "").toLowerCase() !== id);
  snap.state.disabled = snap.state.disabled.filter((d) => d !== id);
  snap.state.presets = snap.state.presets.filter((raw) => String(raw.provider || "").toLowerCase() !== id);
  if (snap.state.defaultProvider === id) delete snap.state.defaultProvider;
  if (!writeState(snap.state)) return fail("Could not save the provider list.");
  return { ok: true };
}
function setProviderEnabled(id, enabled) {
  const snap = snapshot();
  if (!snap.providers.some((p2) => p2.id === id)) return fail(`Unknown provider ${id}.`);
  const others = snap.state.disabled.filter((d) => d !== id);
  snap.state.disabled = enabled ? others : others.concat(id);
  return writeState(snap.state) ? { ok: true } : fail("Could not save the provider list.");
}
function setDefaultProvider(id) {
  const snap = snapshot();
  if (!snap.providers.some((p2) => p2.id === id && p2.enabled)) return fail(`Unknown or disabled provider ${id}.`);
  snap.state.defaultProvider = id;
  return writeState(snap.state) ? { ok: true } : fail("Could not save the provider list.");
}
function setProviderKey(id, key) {
  const snap = snapshot();
  const p2 = snap.providers.find((x) => x.id === id);
  if (!p2) return fail(`Unknown provider ${id}.`);
  const value = typeof key === "string" ? key.trim() : "";
  if (!value) return fail("Paste a key first.");
  if (/\s/.test(value)) return fail("A key cannot contain spaces or line breaks.");
  if (!setKey(p2.apiKeySecret, value)) return fail("The plugin secret store is unavailable (grant the secrets permission).");
  for (const other of snap.providers) if (other.apiKeySecret === p2.apiKeySecret) invalidateModels(other.id);
  return { ok: true };
}
function clearProviderKey(id) {
  const snap = snapshot();
  const p2 = snap.providers.find((x) => x.id === id);
  if (!p2) return fail(`Unknown provider ${id}.`);
  deleteKey(p2.apiKeySecret);
  for (const other of snap.providers) if (other.apiKeySecret === p2.apiKeySecret) invalidateModels(other.id);
  return { ok: true };
}
function testProvider(id) {
  const snap = snapshot();
  const p2 = snap.providers.find((x) => x.id === id);
  if (!p2) return fail(`Unknown provider ${id}.`);
  discoverModels(p2, { force: true });
  return { ok: true, provider: providerView(p2, snap.defaultProvider) };
}
function modelView(m) {
  const view = {
    id: qualifyModel(m.providerId, m.id),
    model: m.id,
    displayName: m.displayName,
    providerId: m.providerId,
    badges: capabilityBadges(m.capabilities)
  };
  if (m.loaded !== void 0) view.loaded = m.loaded;
  return view;
}
function modelSections(opts) {
  const snap = snapshot();
  const targets = snap.providers.filter((p2) => p2.enabled && (!opts.provider || p2.id === opts.provider));
  const all = [];
  const statuses = {};
  for (const p2 of targets) {
    const entry = discoverModels(p2, { force: !!opts.refresh });
    all.push(...entry.models);
    statuses[p2.id] = statusFromEntry(p2, entry);
  }
  return groupAndSearch(targets, all, opts.query || "").map((s2) => ({
    providerId: s2.provider.id,
    providerName: s2.provider.name,
    kind: s2.provider.kind,
    total: s2.total,
    models: s2.models.map(modelView),
    status: statuses[s2.provider.id]
  }));
}
function listPresetViews() {
  return snapshot().presets;
}
function savePreset(input, opts) {
  const snap = snapshot();
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const existing = snap.presets.find((p2) => p2.id === id);
  if (existing && existing.source !== "user") return fail(`Preset ${id} is defined in config.yaml; edit it there.`);
  if (existing && !opts?.replace) return fail(`A preset named ${id} already exists.`, [{ field: "id", message: `A preset named ${id} already exists.` }]);
  const taken = snap.presets.filter((p2) => p2.id !== id).map((p2) => p2.id);
  const result = validatePreset(input, taken);
  if (!result.ok) return fail(result.errors.map((e) => e.message).join(" "), result.errors);
  const preset = result.value;
  if (preset.provider && !snap.providers.some((p2) => p2.id === preset.provider)) {
    return fail(`Unknown provider ${preset.provider}.`, [{ field: "provider", message: `Unknown provider ${preset.provider}.` }]);
  }
  const { source: _source, ...stored } = preset;
  void _source;
  snap.state.presets = snap.state.presets.filter((raw) => raw.id !== id).concat(stored);
  if (!writeState(snap.state)) return fail("Could not save presets.");
  return { ok: true, preset };
}
function removePreset(id) {
  const snap = snapshot();
  const existing = snap.presets.find((p2) => p2.id === id);
  if (!existing) return fail(`Unknown preset ${id}.`);
  if (existing.source !== "user") return fail(`Preset ${id} is defined in config.yaml.`);
  snap.state.presets = snap.state.presets.filter((raw) => raw.id !== id);
  return writeState(snap.state) ? { ok: true } : fail("Could not save presets.");
}

// lmstudio/src/router/verbs.ts
var AGENT_VERBS = [
  "providers",
  "add-provider <id> <openai|anthropic|lmstudio> <baseUrl> [--name NAME] [--key-slot SLOT] [--models id1,id2]",
  "remove-provider <id>",
  "test-provider <id>",
  "set-default <provider>",
  "models [provider] [query] [--refresh]",
  "presets",
  "add-preset <id> <provider::model> [--name NAME] [--temperature N] [--max-tokens N] [--system TEXT]",
  "remove-preset <id>"
];
var PLUGIN_ID = "lmstudio";
function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.indexOf("--") === 0 && a.length > 2) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < args.length && args[i + 1].indexOf("--") !== 0) flags[a.slice(2)] = args[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}
function flag(p2, name) {
  const v = p2.flags[name];
  return typeof v === "string" ? v : void 0;
}
function keyCommand(slot) {
  return `printf %s "$API_KEY" | codeterm plugin config ${PLUGIN_ID} --secret ${slot}`;
}
function allowHostCommand(host2) {
  return `codeterm plugin settings ${PLUGIN_ID} --allow-host ${host2}`;
}
function nextSteps(p2) {
  const steps = [];
  if (!p2.hasKey && keyRequired(p2)) {
    steps.push(
      p2.keySlotDeclared ? `store the key (never in argv history): ${keyCommand(p2.apiKeySecret)}` : `slot ${p2.apiKeySecret} is not declared for --secret; re-add with --key-slot one of ${KEY_SLOTS.join(", ")} or paste the key in the Router view`
    );
  }
  if (p2.status.state !== "connected" && keyRequired(p2)) steps.push(`if CodeTerm blocks the host: ${allowHostCommand(hostOf(p2.baseUrl))}`);
  return steps;
}
function providerLine(p2) {
  const key = keyRequired(p2) || p2.hasKey ? ` key=${p2.apiKeySecret}:${p2.hasKey ? "set" : "unset"}` : "";
  const flags = [p2.isDefault ? "default" : "", p2.enabled ? "" : "disabled", p2.source !== "user" ? p2.source : ""].filter(Boolean).join(",");
  return `${p2.id}	${p2.kind}	${p2.status.state}	${p2.baseUrl}${key}${flags ? `	[${flags}]` : ""}`;
}
function err(message) {
  return { error: message };
}
function runAgentVerb(verb, args) {
  const p2 = parseArgs(args || []);
  switch (verb) {
    case "providers": {
      const { providers, issues } = listProviders();
      const lines = providers.map(providerLine);
      if (issues.length) lines.push("", "config issues:", ...issues.map((i) => `- ${i}`));
      return { result: lines.join("\n") || "no providers" };
    }
    case "add-provider": {
      const [id, kind, baseUrl2] = p2.positional;
      if (!id || !kind || !baseUrl2) return err(`usage: ${AGENT_VERBS[1]}`);
      const res = addProvider({ id, kind, baseUrl: baseUrl2, name: flag(p2, "name") || p2.positional.slice(3).join(" ") || void 0, apiKeySecret: flag(p2, "key-slot"), models: flag(p2, "models") });
      if (!res.ok) return err(res.error);
      return { result: [`added ${providerLine(res.provider)}`, ...nextSteps(res.provider)].join("\n") };
    }
    case "remove-provider": {
      const id = p2.positional[0];
      if (!id) return err("usage: remove-provider <id>");
      const res = removeProvider(id.toLowerCase());
      return res.ok ? { result: `removed ${id} (its key stays in the secret bucket until cleared)` } : err(res.error);
    }
    case "test-provider": {
      const id = p2.positional[0];
      if (!id) return err("usage: test-provider <id>");
      const res = testProvider(id.toLowerCase());
      if (!res.ok) return err(res.error);
      return { result: [`${res.provider.id}: ${res.provider.status.state} \u2014 ${res.provider.status.message}`, ...nextSteps(res.provider)].join("\n") };
    }
    case "set-default": {
      const id = p2.positional[0];
      if (!id) return err("usage: set-default <provider>");
      const res = setDefaultProvider(id.toLowerCase());
      return res.ok ? { result: `default provider: ${id}` } : err(res.error);
    }
    case "models": {
      const known = listProviders().providers.map((x) => x.id);
      const first = (p2.positional[0] || "").toLowerCase();
      const provider = known.includes(first) ? first : void 0;
      const query = (provider ? p2.positional.slice(1) : p2.positional).join(" ");
      const sections = modelSections({ provider, query, refresh: p2.flags.refresh === true });
      const lines = [];
      for (const s2 of sections) {
        lines.push(`## ${s2.providerName} (${s2.providerId}) \u2014 ${s2.models.length}/${s2.total}${s2.status.state === "connected" ? "" : ` \xB7 ${s2.status.state}: ${s2.status.message}`}`);
        for (const m of s2.models) lines.push(`${m.id}${m.badges.length ? `	${m.badges.join(" ")}` : ""}${m.loaded ? "	loaded" : ""}`);
      }
      return { result: lines.join("\n") || "no providers enabled" };
    }
    case "presets": {
      const lines = listPresetViews().map((x) => {
        const knobs = [x.temperature !== void 0 ? `t=${x.temperature}` : "", x.maxTokens !== void 0 ? `max=${x.maxTokens}` : ""].filter(Boolean).join(" ");
        const model = x.model ? x.provider && !splitModelId(x.model).providerId ? `${x.provider}::${x.model}` : x.model : x.provider ? `${x.provider}::(default)` : "(any)";
        return `${x.id}	${x.name}	${model}${knobs ? `	${knobs}` : ""}${x.source !== "user" ? `	[${x.source}]` : ""}`;
      });
      return { result: lines.join("\n") || "no presets" };
    }
    case "add-preset": {
      const [id, model] = p2.positional;
      if (!id) return err(`usage: ${AGENT_VERBS[7]}`);
      const split = splitModelId(model || "");
      const res = savePreset(
        {
          id,
          name: flag(p2, "name"),
          provider: split.providerId || flag(p2, "provider"),
          model: split.model || void 0,
          temperature: flag(p2, "temperature"),
          maxTokens: flag(p2, "max-tokens"),
          systemPrompt: flag(p2, "system")
        },
        { replace: p2.flags.replace === true }
      );
      return res.ok ? { result: `saved preset ${res.preset.id}` } : err(res.error);
    }
    case "remove-preset": {
      const id = p2.positional[0];
      if (!id) return err("usage: remove-preset <id>");
      const res = removePreset(id);
      return res.ok ? { result: `removed preset ${id}` } : err(res.error);
    }
    default:
      return err(`unknown verb "${verb}". Verbs: ${AGENT_VERBS.join(" | ")}`);
  }
}

// lmstudio/src/router/view.ts
function s(v) {
  return typeof v === "string" ? v : "";
}
function viewCall(method, raw) {
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  switch (method) {
    case "overview": {
      const { providers, defaultProvider, issues } = listProviders();
      return {
        providers,
        defaultProvider,
        issues,
        presets: listPresetViews(),
        kinds: PROVIDER_KINDS_INFO,
        templates: PROVIDER_TEMPLATES,
        keySlots: KEY_SLOTS,
        commands: Object.fromEntries(providers.map((p2) => [p2.id, { key: keyCommand(p2.apiKeySecret), allowHost: allowHostCommand(p2.host) }]))
      };
    }
    case "models":
      return { sections: modelSections({ provider: s(args.provider) || void 0, query: s(args.query), refresh: args.refresh === true }) };
    case "addProvider":
      return addProvider(args.provider || {});
    case "updateProvider":
      return updateProvider(s(args.id), args.provider || {});
    case "removeProvider":
      return removeProvider(s(args.id));
    case "setProviderEnabled":
      return setProviderEnabled(s(args.id), args.enabled !== false);
    case "setDefaultProvider":
      return setDefaultProvider(s(args.id));
    case "setProviderKey":
      return setProviderKey(s(args.id), args.key);
    case "clearProviderKey":
      return clearProviderKey(s(args.id));
    case "testProvider":
      return testProvider(s(args.id));
    case "savePreset":
      return savePreset(args.preset || {}, { replace: args.replace === true });
    case "removePreset":
      return removePreset(s(args.id));
    default:
      return { ok: false, error: `unknown view method ${method}` };
  }
}

// lmstudio/src/router/lmstudioNative.ts
function n2(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
function nested(obj, key) {
  const v = obj[key];
  return v && typeof v === "object" ? v : {};
}
function nativeStatsUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const stats = raw;
  const input = n2(stats.input_tokens) || n2(stats.prompt_tokens);
  const output = n2(stats.total_output_tokens) || n2(stats.output_tokens) || n2(stats.completion_tokens);
  if (!input && !output) return null;
  const cached = n2(stats.cached_input_tokens) || n2(stats.cached_tokens) || n2(stats.cache_read_input_tokens) || n2(nested(stats, "prompt_tokens_details").cached_tokens) || n2(nested(stats, "input_tokens_details").cached_tokens);
  return { input, cachedInput: Math.min(cached, input || cached), cacheWrite: n2(stats.cache_creation_input_tokens), output };
}
function applyNativeEvent(acc, ev) {
  if (!ev.data) return;
  let data;
  try {
    data = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (!data || typeof data !== "object") return;
  const type = typeof data.type === "string" ? data.type : "";
  if (type.indexOf("message.") === 0 && typeof data.content === "string") acc.content += data.content;
  else if (type.indexOf("reasoning.") === 0 && typeof data.content === "string") acc.reasoning += data.content;
  else if (type === "chat.end") {
    const result = nested(data, "result");
    if (typeof result.response_id === "string") acc.responseId = result.response_id;
    acc.usage = nativeStatsUsage(result.stats) || acc.usage;
  }
}

// lmstudio/src/router/textcalls.ts
var OPEN_RE = /<tool_call\s*>/gi;
var CLOSE_RE = /<\/tool_call\s*>/i;
function edgeTrim(value) {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}
function firstIndex(text, from, patterns) {
  let best = text.length;
  for (const re of patterns) {
    const m = re.exec(text.slice(from));
    if (m && from + m.index < best) best = from + m.index;
  }
  return best;
}
function parseXmlBody(body) {
  const fn = /<function=([^>\s]+)\s*>/i.exec(body);
  if (!fn) return { error: "tool_call without <function=NAME>" };
  const args = {};
  const paramRe = /<parameter=([^>\s]+)\s*>/gi;
  paramRe.lastIndex = fn.index + fn[0].length;
  let m;
  while ((m = paramRe.exec(body)) !== null) {
    const start = m.index + m[0].length;
    const end = firstIndex(body, start, [/<\/parameter\s*>/i, /<parameter=/i, /<\/function\s*>/i]);
    args[m[1]] = edgeTrim(body.slice(start, end));
    paramRe.lastIndex = end;
  }
  return { tool: fn[1], args };
}
function parseJsonBody(body) {
  const end = body.lastIndexOf("}");
  let data;
  try {
    data = JSON.parse(body.slice(body.indexOf("{"), end + 1));
  } catch {
    return { error: "tool_call JSON does not parse" };
  }
  const fn = data.function && typeof data.function === "object" ? data.function : data;
  const name = typeof fn.name === "string" ? fn.name : typeof fn.tool === "string" ? fn.tool : "";
  if (!name) return { error: "tool_call JSON has no name" };
  let args = fn.arguments !== void 0 ? fn.arguments : fn.args;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return { error: `${name} arguments are not JSON` };
    }
  }
  return { tool: name, args };
}
function parseTextToolCalls(text) {
  const opens = [];
  OPEN_RE.lastIndex = 0;
  let m;
  while ((m = OPEN_RE.exec(text)) !== null) opens.push({ start: m.index, bodyStart: m.index + m[0].length });
  if (!opens.length) return { status: "none", calls: [], cleaned: text };
  const calls = [];
  const errors = [];
  const spans = [];
  opens.forEach((open, i) => {
    const limit = i + 1 < opens.length ? opens[i + 1].start : text.length;
    const segment = text.slice(open.bodyStart, limit);
    const close = CLOSE_RE.exec(segment);
    const body = close ? segment.slice(0, close.index) : segment;
    spans.push([open.start, close ? open.bodyStart + close.index + close[0].length : limit]);
    const raw = body.trim().charAt(0) === "{" ? parseJsonBody(body) : parseXmlBody(body);
    if ("error" in raw) {
      errors.push(raw.error);
      return;
    }
    const checked = checkToolArgs(raw.tool, raw.args);
    if (checked.ok) calls.push({ tool: raw.tool, args: checked.args });
    else errors.push(checked.error);
  });
  let cleaned = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    cleaned += text.slice(cursor, start);
    cursor = end;
  }
  cleaned = (cleaned + text.slice(cursor)).replace(/\n{3,}/g, "\n\n").trim();
  if (errors.length) return { status: "malformed", calls: [], cleaned: text, reason: errors.join("; ") };
  return { status: "ok", calls, cleaned };
}

// lmstudio/src/router/transcript.ts
function transcriptTurns(rows2, skipUser) {
  const turns = [];
  let reply = null;
  for (const m of rows2) {
    if (m.type === "user") {
      if (skipUser(m.content)) continue;
      turns.push({ role: "user", content: m.content });
      reply = null;
    } else if (m.type === "assistant") {
      const turn = { role: "assistant", content: m.content };
      turns.push(turn);
      reply = { id: m.id, turn };
    } else if (m.type === "tool_call" && typeof m.callId === "string" && typeof m.toolName === "string") {
      const call = { id: m.callId, name: m.toolName, arguments: typeof m.toolArgs === "string" ? m.toolArgs : "{}" };
      const replyId = typeof m.replyId === "string" ? m.replyId : "";
      if (!reply || reply.id !== replyId) {
        const turn = { role: "assistant", content: "" };
        turns.push(turn);
        reply = { id: replyId, turn };
      }
      reply.turn.toolCalls = [...reply.turn.toolCalls || [], call];
    } else if (m.type === "tool_result") {
      if (typeof m.callId === "string") turns.push({ role: "tool", content: m.content, toolCallId: m.callId });
      else {
        turns.push({ role: "user", content: `tool_result:
${m.content}` });
        reply = null;
      }
    }
  }
  return turns;
}

// lmstudio/src/router/context.ts
var DOMIOS_CONTEXT = [
  "You run inside Domios, a terminal multiplexer where AI agents work, as the Domios Router chat agent.",
  "Act through your tools. When you say you will check or do something, make that tool call in the same reply.",
  "The Domios CLI is `codeterm`; call it with the `codeterm` tool (args without the leading `codeterm`) or `exec`.",
  '- Tabs: `codeterm tab list`, `codeterm tab new --title NAME`, `codeterm send "text" --tab ID`.',
  '- Agents: `codeterm agent spawn PROVIDER --model ID --task "..."`; providers from `codeterm agent providers`, model ids from `codeterm agent models PROVIDER`.',
  "- Reference: `codeterm COMMAND --help` and `codeterm docs` (then `codeterm docs NAME`).",
  'Messages from other tabs arrive as <domios from="tab" tab="ID" ...>BODY</domios>; answer with `codeterm send "reply" --tab ID` (add `--mesh PEER` when mesh="PEER").'
].join("\n");
function withDomiosContext(prompt) {
  return prompt.trim() ? `${DOMIOS_CONTEXT}

${prompt}` : DOMIOS_CONTEXT;
}

// lmstudio/src/router/activity.ts
function activityOf(i) {
  if (i.toolsRunning || i.streaming && i.answering) return "working";
  if (i.streaming || i.queued) return "thinking";
  return "idle";
}
function activityLine(model, activity) {
  if (activity === "idle") return "";
  return ["Domios Router", model, activity === "thinking" ? "Thinking" : "Working"].filter(Boolean).join(" \xB7 ");
}

// lmstudio/src/plugin.ts
var CHARTER_REF_PREFIX = "charter:";
var SHIPPED_CHARTERS = {
  "watcher-orchestration": watcher_orchestration_default.replace(/\s+$/, "")
};
function resolveCharterRef(ref) {
  if (!ref.startsWith(CHARTER_REF_PREFIX)) return { charter: ref };
  const id = ref.slice(CHARTER_REF_PREFIX.length).trim();
  if (!id) return { charter: "", error: "charter reference is missing an id" };
  const shipped = SHIPPED_CHARTERS[id];
  if (shipped) return { charter: shipped };
  const settings2 = readSettings2();
  const raw = settings2.charters;
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw[id] : void 0;
  if (typeof body === "string" && body.trim() && !body.trim().endsWith(".md")) {
    return { charter: body.trim() };
  }
  return { charter: "", error: `unknown charter id: ${id}` };
}
var DEFAULT_BASE_URL2 = "http://localhost:1234";
var LAST_MODEL_PATH = ".codeterm/plugins/lmstudio/last-model.json";
var AUTHORED_PROMPTS_PATH = ".codeterm/plugins/lmstudio/authored-prompts.json";
var PROMPT_AUTHOR_WORKSPACE = "lmstudio-prompt-authoring";
var MAX_TOOL_ROUNDS = 8;
var MAX_MALFORMED_RETRIES = 2;
var SYSTEM_PROMPT_MARKER = "-=-codeterm:system_prompt-=-";
function markSystemPrompt(body) {
  return SYSTEM_PROMPT_MARKER + body;
}
var sessions = /* @__PURE__ */ new Map();
var {
  execShellCmd,
  startExecJob,
  pollExecJob,
  execResultFromPoll,
  formatToolResult,
  parseToolEntries,
  toolContent,
  executeTool
} = createToolRuntime(host, parseJson2);
function readSettings2() {
  try {
    const raw = JSON.parse(host.settingsJson() || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
function cleanModel(model) {
  return typeof model === "string" ? model.trim() : "";
}
function lastModelFilePath() {
  try {
    const home = typeof host.homeDir === "function" ? host.homeDir() : null;
    if (!home) return null;
    return `${home.replace(/\/+$/, "")}/${LAST_MODEL_PATH}`;
  } catch {
    return null;
  }
}
function readLastModel() {
  try {
    const path = lastModelFilePath();
    if (!path) return "";
    const raw = host.readFile(path);
    if (!raw) return "";
    const state = JSON.parse(raw);
    return cleanModel(state && state.lastModel);
  } catch {
    return "";
  }
}
function rememberLastModel(model) {
  const lastModel = cleanModel(model);
  if (!lastModel) return;
  try {
    const path = lastModelFilePath();
    if (!path) return;
    const slash = path.lastIndexOf("/");
    if (slash > 0 && typeof host.makeDirs === "function") host.makeDirs(path.slice(0, slash));
    host.writeFile(path, JSON.stringify({ lastModel }));
  } catch {
  }
}
function authoredPromptsFilePath() {
  try {
    const home = typeof host.homeDir === "function" ? host.homeDir() : null;
    if (!home) return null;
    return `${home.replace(/\/+$/, "")}/${AUTHORED_PROMPTS_PATH}`;
  } catch {
    return null;
  }
}
function readAuthoredPrompts() {
  try {
    const path = authoredPromptsFilePath();
    if (!path) return {};
    const raw = host.readFile(path);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}
function writeAuthoredPrompt(model, draft) {
  try {
    const path = authoredPromptsFilePath();
    if (!path) return;
    const current = readAuthoredPrompts();
    current[model] = draft;
    const slash = path.lastIndexOf("/");
    if (slash > 0 && typeof host.makeDirs === "function") host.makeDirs(path.slice(0, slash));
    host.writeFile(path, JSON.stringify(current));
  } catch {
  }
}
function applyAuthoredPrompt(s2, model, draft) {
  if (!model) return;
  writeAuthoredPrompt(model, draft);
  s2.systemPrompt = draft;
}
function buildAuthoringRequest(model, currentPrompt, instruction) {
  const ask = instruction && instruction.trim() ? `

User's tuning request: ${instruction.trim()}` : "";
  return `You are tuning the system prompt for a local LM Studio chat model "${model}". Rewrite and improve the prompt below so it works well for that model \u2014 small local models learn best from short, concrete, example-led prompts. Preserve its intent and any tool-use rules. Reply with ONLY the new system prompt text: no preamble, no commentary, no code fences.` + ask + `

--- CURRENT SYSTEM PROMPT ---
${currentPrompt}`;
}
function stripPromptFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n?```$/);
  return (fenced ? fenced[1] : trimmed).trim();
}
function describeSwitchMessage(targetModel) {
  return `Switching to ${targetModel} will unload the current one (VRAM). Continue?`;
}
function describeModelSwitch(sessionId, targetModel) {
  const target = cleanModel(targetModel);
  if (!target) return { needsConfirm: false, message: "" };
  const s2 = sessions.get(sessionId);
  const active = s2 ? sessionModelId(s2) : "";
  if (!s2 || active === target) return { needsConfirm: false, message: "" };
  return { needsConfirm: true, message: describeSwitchMessage(target) };
}
function baseUrl() {
  const s2 = readSettings2();
  const url = s2.baseUrl && s2.baseUrl.trim() ? s2.baseUrl.trim() : DEFAULT_BASE_URL2;
  return url.replace(/\/+$/, "");
}
function presets() {
  return snapshot().presets.map((p2) => {
    const preset = { id: p2.id, name: p2.name, model: presetModelId(p2), params: presetParams(p2) };
    if (p2.description) preset.description = p2.description;
    if (p2.systemPrompt !== void 0) preset.systemPrompt = p2.systemPrompt;
    return preset;
  });
}
function presetById(all, id) {
  if (!id) return null;
  return all.find((p2) => p2.id === id) || null;
}
function defaultPreset(all) {
  if (!all.length) return null;
  const s2 = readSettings2();
  return presetById(all, s2.defaultPreset) || all[0];
}
function presetBoundToModel(all, modelId) {
  if (!modelId) return null;
  return all.find((p2) => typeof p2.model === "string" && p2.model.trim() === modelId) || null;
}
function resolvePreset(id, modelId) {
  const all = presets();
  if (!all.length) return null;
  return presetBoundToModel(all, modelId || "") || presetById(all, id) || defaultPreset(all);
}
function defaultSystemPrompt(all) {
  const p2 = defaultPreset(all);
  return p2 && typeof p2.systemPrompt === "string" ? p2.systemPrompt : "";
}
function nextId(s2, prefix = "lmstudio") {
  const id = `${prefix}-${s2.seq}`;
  s2.seq += 1;
  return id;
}
function append(s2, type, content, id, extras) {
  const msgId = id || nextId(s2);
  const existing = s2.messages.find((m) => m.id === msgId);
  if (existing) {
    existing.content = content;
    if (extras) Object.assign(existing, extras);
    return existing;
  }
  const msg = { id: msgId, type, content, ...extras || {} };
  s2.messages.push(msg);
  return msg;
}
function parseJson2(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function fetchJson(opts) {
  const raw = host.fetch(
    JSON.stringify({
      url: opts.url,
      method: opts.method,
      headers: opts.headers || { "content-type": "application/json" },
      body: opts.body,
      timeoutMs: 12e4
    })
  );
  return parseJson2(raw, { error: "fetch returned non-JSON" });
}
function lmStudioHeaders(provider) {
  return provider ? authHeaders(provider, getKey(provider)) : { "content-type": "application/json" };
}
function lmStudioRoot(provider) {
  return provider ? apiRoot(provider) : baseUrl();
}
function resolveRemoteModelId(provider) {
  const entry = discoverModels(provider);
  return entry.models.length ? entry.models[0].id : "";
}
function resolveModelId(provider) {
  if (provider && provider.kind !== "lmstudio") return resolveRemoteModelId(provider);
  const res = fetchJson({ url: `${lmStudioRoot(provider)}/api/v1/models`, method: "GET", headers: lmStudioHeaders(provider) });
  if (res.error || res.status && res.status >= 400) return "";
  const data = parseJson2(res.body || "{}", {});
  const rows2 = Array.isArray(data.models) ? data.models : [];
  const loaded = rows2.find(
    (r) => r && typeof r.key === "string" && Array.isArray(r.loaded_instances) && r.loaded_instances.length > 0
  );
  if (loaded && typeof loaded.key === "string") return loaded.key;
  const first = rows2.find((r) => r && typeof r.key === "string");
  return first && typeof first.key === "string" ? first.key : "";
}
function startFetchStream(opts) {
  return parseJson2(
    host.fetchStream(
      JSON.stringify({
        url: opts.url,
        method: opts.method,
        headers: opts.headers || { "content-type": "application/json" },
        body: opts.body,
        timeoutMs: opts.timeoutMs || 12e4
      })
    ),
    { error: "fetchStream returned non-JSON" }
  );
}
function errorTextFromBody(raw) {
  if (!raw) return "";
  const parsed = parseJson2(raw, null);
  if (parsed && typeof parsed === "object") {
    const obj = parsed;
    const error = obj.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const nested2 = error;
      if (typeof nested2.message === "string") return nested2.message;
      if (typeof nested2.error === "string") return nested2.error;
    }
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.detail === "string") return obj.detail;
  }
  return raw;
}
function isVramLoadFailure(text) {
  return /(vram|insufficient|not enough|out of memory|failed to load|could not load|couldn't load)/i.test(text);
}
function vramLoadFailureMessage(model) {
  return `couldn't load ${model}: not enough VRAM \u2014 unload a model in LM Studio or pick a smaller one`;
}
function pollFetchStream(jobId) {
  return parseJson2(host.fetchStreamPoll(jobId), {
    chunks: [],
    done: true,
    error: "fetchStreamPoll returned non-JSON"
  });
}
function emitToolCall(s2, entry) {
  const call = entry.call;
  const toolId = nextId(s2, `lmstudio-tool-${call.tool}`);
  const toolArgs = JSON.stringify(call.args);
  const extras = {
    toolName: call.tool,
    toolInput: call.args,
    toolArgs,
    toolId,
    collapsed: true,
    provider: "lmstudio"
  };
  if (entry.callId) Object.assign(extras, { callId: entry.callId, replyId: entry.replyId || "" });
  append(s2, "tool_call", toolContent(call), toolId, extras);
  return toolId;
}
function emitToolResult(s2, call, result, toolId, callId) {
  const formatted = formatToolResult(call, result);
  const extras = { toolId, toolResult: formatted, collapsed: true, provider: "lmstudio" };
  if (callId) extras.callId = callId;
  append(s2, "tool_result", formatted, void 0, extras);
  s2.roundResults.push(formatted);
}
function requestSystem(s2) {
  if (s2.mode === "watcher" || s2.engine && s2.engine.kind === "machine") return s2.systemPrompt;
  return withDomiosContext(s2.systemPrompt);
}
function routesNatively(s2) {
  return !!s2.provider && s2.provider.kind !== "lmstudio" && s2.currentRun !== "watcher" && s2.mode !== "watcher";
}
function queueContinuation(s2) {
  const results = s2.roundResults;
  s2.roundResults = [];
  if (!results.length) return;
  const stateless = !!s2.provider && s2.provider.kind !== "lmstudio" && s2.currentRun !== "watcher";
  s2.pendingInputs.push(stateless ? "" : results.map((r) => `tool_result:
${r}`).join("\n\n"));
}
function promptVariantForModel(modelId, generalPrompt) {
  void modelId;
  return generalPrompt;
}
function systemPromptForModel(generalPrompt, modelId) {
  if (!modelId) return generalPrompt;
  return promptVariantForModel(modelId, generalPrompt);
}
function consumeRouterEvents(stream, flush) {
  const { events, rest } = splitSse(stream.buffer, flush);
  stream.buffer = rest;
  const acc = emptyDelta();
  for (const ev of events) {
    if (stream.kind === "anthropic") applyAnthropicEvent(acc, ev);
    else if (stream.kind === "lmstudio") applyNativeEvent(acc, ev);
    else applyOpenAiEvent(acc, ev);
  }
  stream.content += acc.content;
  stream.reasoning += acc.reasoning;
  if (acc.responseId && !stream.responseId) stream.responseId = acc.responseId;
  if (acc.error) stream.error = acc.error;
  stream.usage = mergeUsage(stream.usage, acc.usage);
  mergeToolParts(stream.toolParts, acc.toolParts);
}
function assembledContext(s2) {
  const prior = [];
  const assistantIndex = {};
  for (const m of s2.messages) {
    if (m.type === "assistant") {
      if (assistantIndex[m.id] === void 0) {
        assistantIndex[m.id] = prior.length;
        prior.push({ id: m.id, line: `assistant: ${m.content}` });
      } else {
        prior[assistantIndex[m.id]].line = `assistant: ${m.content}`;
      }
    } else if (m.type === "user" || m.type === "tool_result") {
      if (m.type === "user" && m.content.indexOf(SYSTEM_PROMPT_MARKER) === 0) continue;
      prior.push({ id: m.id, line: `${m.type}: ${m.content}` });
    }
  }
  return prior.map((m) => m.line).join("\n\n");
}
function messagesAsEngineHistory(s2) {
  const history = [];
  if (s2.systemPrompt) history.push({ role: "system", content: s2.systemPrompt });
  for (const m of s2.messages) {
    if (m.type === "user") {
      if (m.content.indexOf(SYSTEM_PROMPT_MARKER) === 0) continue;
      history.push({ role: "user", content: m.content });
    } else if (m.type === "assistant") {
      history.push({ role: "assistant", content: m.content });
    }
  }
  return history;
}
function requestInputFromMessages(messages2) {
  return messages2.map((m) => `${m.role}: ${m.content}`).join("\n\n");
}
function sessionModelId(s2) {
  return qualifyModel(s2.provider ? s2.provider.id : LMSTUDIO_PROVIDER_ID, s2.model);
}
function providerLabel(s2) {
  return s2.provider && s2.provider.id !== LMSTUDIO_PROVIDER_ID ? s2.provider.name : "LM Studio";
}
function routerTurns(s2, input) {
  const turns = transcriptTurns(s2.messages, (content) => content.indexOf(SYSTEM_PROMPT_MARKER) === 0);
  const last = turns[turns.length - 1];
  if (input && !(last && last.role === "user" && last.content === input)) turns.push({ role: "user", content: input });
  return turns;
}
function engineToRouter(messages2) {
  const system = [];
  const turns = [];
  for (const m of messages2) {
    if (m.role === "system") system.push(m.content);
    else turns.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  return { system: system.join("\n\n"), turns };
}
function startRouterCall(s2, provider, input, opts) {
  let system = requestSystem(s2);
  let turns;
  if (opts?.messages) {
    const converted = engineToRouter(opts.messages);
    system = converted.system;
    turns = converted.turns;
  } else if (s2.engine && s2.engine.kind === "chat" && s2.engine.window?.maxMessages !== void 0) {
    turns = engineToRouter(assembleChat(messagesAsEngineHistory(s2), s2.engine.window)).turns;
  } else {
    turns = routerTurns(s2, input);
  }
  const key = getKey(provider);
  const tools = !opts?.watcher && s2.mode !== "watcher";
  const req = chatRequest(provider, key, { model: s2.model, system, turns, params: s2.params, tools });
  const started = startFetchStream({ url: req.url, method: req.method, headers: req.headers, body: req.body || "", timeoutMs: req.timeoutMs });
  if (!started.jobId) {
    append(s2, "system", `${provider.name} stream error: ${redact(started.error || "missing jobId", key)}`);
    s2.done = true;
    return;
  }
  beginStream(s2, started.jobId, provider.kind, opts?.watcher);
}
function beginStream(s2, jobId, kind, watcher) {
  s2.stream = {
    jobId,
    messageId: nextId(s2, "lmstudio-assistant"),
    reasoningId: nextId(s2, "lmstudio-reasoning"),
    content: "",
    reasoning: "",
    buffer: "",
    responseId: null,
    kind,
    usage: null,
    error: null,
    toolParts: []
  };
  s2.currentRun = watcher || s2.mode === "watcher" ? "watcher" : "interactive";
  s2.done = false;
}
function startLmStudioCall(s2, input, opts) {
  if (s2.routeError) {
    append(s2, "system", `Router error: ${s2.routeError}`);
    s2.done = true;
    return;
  }
  if (!s2.model) {
    const resolved = resolveModelId(s2.provider);
    if (!resolved) {
      const where = s2.provider && s2.provider.kind !== "lmstudio" ? `${s2.provider.name} /models` : "/api/v1/models";
      append(s2, "system", `${providerLabel(s2)} error: no model configured and none could be auto-resolved from ${where}.`);
      s2.done = true;
      return;
    }
    s2.model = resolved;
    rememberLastModel(sessionModelId(s2));
  }
  if (s2.provider && s2.provider.kind !== "lmstudio") {
    startRouterCall(s2, s2.provider, input, opts);
    return;
  }
  const needsFallbackContext = !s2.previousResponseId && s2.messages.some((m) => m.type === "assistant" || m.type === "tool_result");
  let requestInput = input;
  if (opts?.messages) {
    requestInput = requestInputFromMessages(opts.messages);
  } else if (s2.engine && s2.engine.kind === "chat" && s2.engine.window?.maxMessages !== void 0) {
    requestInput = requestInputFromMessages(assembleChat(messagesAsEngineHistory(s2), s2.engine.window));
  } else if (needsFallbackContext) {
    requestInput = assembledContext(s2);
  }
  const body = {
    model: s2.model,
    system_prompt: opts?.messages ? s2.systemPrompt : requestSystem(s2),
    input: requestInput,
    stream: true,
    ...s2.params
  };
  if (!opts?.messages && s2.previousResponseId) body.previous_response_id = s2.previousResponseId;
  if (typeof body.max_tokens === "number" && body.max_output_tokens === void 0) body.max_output_tokens = body.max_tokens;
  const started = startFetchStream({
    url: `${lmStudioRoot(s2.provider)}/api/v1/chat`,
    method: "POST",
    headers: lmStudioHeaders(s2.provider),
    body: JSON.stringify(body)
  });
  if (!started.jobId) {
    const err2 = started.error || "missing jobId";
    append(s2, "system", isVramLoadFailure(err2) ? vramLoadFailureMessage(s2.model) : `LM Studio stream error: ${err2}`);
    s2.done = true;
    return;
  }
  beginStream(s2, started.jobId, "lmstudio", opts?.watcher);
}
function startNextIfIdle(s2) {
  if (!s2.stream && !s2.pendingExec && !s2.pendingTools && s2.pendingInputs.length) {
    const next = s2.pendingInputs.shift() || "";
    const queued = parseJson2(next, null);
    if (queued && Array.isArray(queued.watcherMessages)) {
      startLmStudioCall(s2, "", { messages: queued.watcherMessages, watcher: true });
    } else if (queued && Array.isArray(queued.machineMessages)) {
      startLmStudioCall(s2, "", { messages: queued.machineMessages });
    } else {
      startLmStudioCall(s2, next);
    }
  }
}
function finishAssistantMessage(s2, content, responseId, messageId, nativeCalls) {
  if (s2.currentRun !== "watcher" && responseId && !(s2.engine && s2.engine.kind === "machine")) s2.previousResponseId = responseId;
  finishLoopAssistantMessage(s2, content, responseId, messageId, nativeCalls);
}
function nativeEntry(call, replyId) {
  let raw = {};
  try {
    raw = JSON.parse(call.arguments);
  } catch {
    return { call: { tool: call.name, args: {} }, callId: call.id, replyId, error: `${call.name} arguments are not valid JSON` };
  }
  const checked = checkToolArgs(call.name, raw);
  if (checked.ok) return { call: { tool: call.name, args: checked.args }, callId: call.id, replyId };
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { call: { tool: call.name, args }, callId: call.id, replyId, error: checked.error };
}
function toolEntries(s2, content, messageId, nativeCalls) {
  if (nativeCalls.length) return { entries: nativeCalls.map((c) => nativeEntry(c, messageId)), cleaned: content, status: "ok", reason: void 0 };
  const text = parseTextToolCalls(content);
  if (text.status === "none") return parseToolEntries(content);
  const native = routesNatively(s2);
  const entries = text.calls.map((call) => {
    const entry = { call: { tool: call.tool, args: call.args } };
    if (native) Object.assign(entry, { callId: nextId(s2, "call"), replyId: messageId });
    return entry;
  });
  return { entries, cleaned: text.cleaned, status: text.status, reason: text.reason };
}
function finishLoopAssistantMessage(s2, content, responseId, messageId, nativeCalls) {
  if (s2.currentRun === "watcher") {
    s2.watcherLastAssistant = content;
    if (responseId) s2.previousResponseId = responseId;
  }
  const { entries, cleaned, status, reason } = toolEntries(s2, content, messageId, nativeCalls);
  if (status === "malformed") {
    if (s2.malformedRetries < MAX_MALFORMED_RETRIES) {
      s2.malformedRetries += 1;
      s2.pendingInputs.push(
        `tool_result:
ERROR: your tool call was invalid (${reason || "unparseable tool call"}). Resend a single valid tool call, or answer in plain text if no tool is needed.`
      );
      return;
    }
    if (s2.currentRun === "watcher") {
      append(s2, "system", `Could not parse a valid tool call after ${MAX_MALFORMED_RETRIES} retries; ending this watcher tick.`);
      completeWatcherTick(s2, content);
    } else {
      append(
        s2,
        "system",
        `Could not parse a valid tool call after ${MAX_MALFORMED_RETRIES} retries; treating the reply as a normal message.`
      );
      s2.done = true;
    }
    return;
  }
  if (!entries.length) {
    if (s2.currentRun === "watcher") completeWatcherTick(s2, content);
    else {
      if (s2.engine && s2.engine.kind === "machine") s2.machineState = extractVerdictState(content, s2.machineState);
      s2.done = true;
    }
    return;
  }
  if (cleaned !== content) {
    if (cleaned.trim() === "") {
      const idx = s2.messages.findIndex((m) => m.id === messageId);
      if (idx >= 0) s2.messages.splice(idx, 1);
    } else {
      append(s2, "assistant", cleaned, messageId);
    }
  }
  s2.pendingTools = entries.slice();
  advanceTools(s2);
}
function watcherFallbackVerdict() {
  return JSON.stringify({
    status: "attention",
    summary: "tool loop ended without a verdict",
    actions: []
  });
}
function completeWatcherTick(s2, verdict) {
  if (!s2.watcherVerdictEmitted) {
    const text = verdict && verdict.trim() ? verdict : watcherFallbackVerdict();
    append(s2, "watcher_verdict", text);
    s2.watcherVerdictEmitted = true;
  }
  s2.done = true;
}
function extractVerdictState(text, prior) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const raw = fenced ? fenced[1] : trimmed;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "state")) {
      return parsed.state;
    }
  } catch {
  }
  return prior;
}
function advanceTools(s2) {
  if (s2.pendingExec) return;
  while (s2.pendingTools && s2.pendingTools.length) {
    const entry = s2.pendingTools.shift();
    const call = entry.call;
    if (s2.toolRounds >= MAX_TOOL_ROUNDS) {
      s2.pendingInputs = [];
      s2.pendingTools = null;
      s2.roundResults = [];
      if (!s2.capReached) {
        append(s2, "system", `Tool round cap (${MAX_TOOL_ROUNDS}) reached; stopping this turn.`);
        s2.capReached = true;
      }
      if (s2.currentRun === "watcher") completeWatcherTick(s2, null);
      else s2.done = true;
      return;
    }
    s2.toolRounds += 1;
    const toolId = emitToolCall(s2, entry);
    if (entry.error) {
      emitToolResult(s2, call, { error: entry.error }, toolId, entry.callId);
      continue;
    }
    if (call.tool === "exec" || call.tool === "codeterm") {
      const shell = execShellCmd(call);
      if (shell.error) {
        emitToolResult(s2, call, { error: shell.error }, toolId, entry.callId);
        continue;
      }
      const started = startExecJob(shell.shellCmd);
      if (started.jobId) {
        s2.pendingExec = { call, jobId: started.jobId, toolId, callId: entry.callId };
        return;
      }
      emitToolResult(s2, call, { error: started.error || "host.exec.start failed" }, toolId, entry.callId);
      continue;
    }
    emitToolResult(s2, call, executeTool(call), toolId, entry.callId);
  }
  s2.pendingTools = null;
  queueContinuation(s2);
}
function drainExec(s2) {
  while (s2.pendingExec) {
    const poll = pollExecJob(s2.pendingExec.jobId);
    if (!poll.done) return;
    const finished = s2.pendingExec;
    host.execClose(finished.jobId);
    s2.pendingExec = null;
    emitToolResult(s2, finished.call, execResultFromPoll(poll), finished.toolId, finished.callId);
    advanceTools(s2);
  }
}
function drainAuthor(s2) {
  if (!s2.pendingAuthor) return;
  const pending = s2.pendingAuthor;
  let poll;
  try {
    poll = host.agent.poll(pending.ticket);
  } catch (e) {
    s2.pendingAuthor = null;
    try {
      host.agent.reap(pending.agentSessionId);
    } catch {
    }
    append(s2, "system", `Prompt authoring failed: ${String(e)}`);
    s2.done = true;
    return;
  }
  if (!poll || !poll.done) return;
  s2.pendingAuthor = null;
  try {
    host.agent.reap(pending.agentSessionId);
  } catch {
  }
  const reply = typeof poll.reply === "string" ? poll.reply : "";
  if (poll.error || !reply.trim()) {
    append(s2, "system", `Prompt authoring failed: ${poll.error || "the author agent returned no prompt"}.`);
    s2.done = true;
    return;
  }
  applyAuthoredPrompt(s2, pending.model, stripPromptFence(reply));
  append(s2, "system", `Updated the system prompt for ${pending.model} from the author agent.`);
  s2.done = true;
}
function pollStream(s2) {
  if (!s2.stream) return;
  const stream = s2.stream;
  const poll = pollFetchStream(stream.jobId);
  if (stream.kind !== "lmstudio") {
    pollRouterStream(s2, stream, poll);
    return;
  }
  if (poll.error) {
    append(s2, "system", isVramLoadFailure(poll.error) ? vramLoadFailureMessage(s2.model) : `LM Studio stream error: ${poll.error}`);
    host.fetchStreamClose(stream.jobId);
    s2.stream = null;
    s2.done = true;
    return;
  }
  if (poll.status && poll.status >= 400) {
    const err2 = errorTextFromBody(poll.body);
    append(
      s2,
      "system",
      isVramLoadFailure(err2) ? vramLoadFailureMessage(s2.model) : `LM Studio HTTP ${poll.status}`
    );
    host.fetchStreamClose(stream.jobId);
    s2.stream = null;
    s2.done = true;
    return;
  }
  const chunks = Array.isArray(poll.chunks) ? poll.chunks : [];
  if (chunks.length) stream.buffer += chunks.join("");
  consumeRouterEvents(stream, !!poll.done);
  publishStream(s2, stream, !!poll.done);
}
function failStream(s2, stream, message) {
  if (stream.content) append(s2, "assistant", stream.content, stream.messageId);
  append(s2, "system", message);
  host.fetchStreamClose(stream.jobId);
  s2.stream = null;
  if (s2.currentRun === "watcher") completeWatcherTick(s2, null);
  else s2.done = true;
}
function pollRouterStream(s2, stream, poll) {
  const name = s2.provider ? s2.provider.name : "Provider";
  const key = s2.provider ? getKey(s2.provider) : null;
  if (poll.error) {
    failStream(s2, stream, `${name} stream error: ${redact(poll.error, key)}`);
    return;
  }
  if (poll.status && poll.status >= 400) {
    const detail = redact(errorTextFromBody(poll.body || (poll.chunks || []).join("")), key).slice(0, 300);
    const hint = poll.status === 401 || poll.status === 403 ? " \u2014 check the API key for this provider" : "";
    failStream(s2, stream, `${name} HTTP ${poll.status}${detail ? `: ${detail}` : ""}${hint}`);
    return;
  }
  const chunks = Array.isArray(poll.chunks) ? poll.chunks : [];
  if (chunks.length) stream.buffer += chunks.join("");
  const looksSse = /(^|\n)(data|event):/.test(stream.buffer);
  if (looksSse || !poll.done) consumeRouterEvents(stream, !!poll.done);
  if (poll.done && !looksSse && stream.buffer.trim()) {
    const acc = emptyDelta();
    if (applyWholeBody(stream.kind, acc, stream.buffer)) {
      stream.content += acc.content;
      stream.reasoning += acc.reasoning;
      if (acc.usage) stream.usage = acc.usage;
    }
    stream.buffer = "";
  }
  if (stream.error) {
    failStream(s2, stream, `${name} error: ${redact(stream.error, key)}`);
    return;
  }
  publishStream(s2, stream, !!poll.done);
}
function emitUsage(s2, usage, messageId) {
  if (!usage || s2.currentRun === "watcher") return;
  const target = s2.messages.find((m) => m.id === messageId);
  if (target) target.usage = usage;
  if (readSettings2().showUsage === false) return;
  append(s2, "system", `${sessionModelId(s2)} \xB7 ${formatUsage(usage)}`, void 0, { usage, collapsed: true });
}
function publishStream(s2, stream, done) {
  if (stream.reasoning) append(s2, "thinking", stream.reasoning, stream.reasoningId);
  if (stream.content) append(s2, "assistant", stream.content, stream.messageId);
  if (done) {
    host.fetchStreamClose(stream.jobId);
    s2.stream = null;
    emitUsage(s2, stream.usage, stream.messageId);
    finishAssistantMessage(s2, stream.content, stream.kind === "lmstudio" ? stream.responseId : null, stream.messageId, finishToolCalls(stream.toolParts));
  }
}
function resolveSession(ctx) {
  const s2 = readSettings2();
  const allPresets = presets();
  const explicitModel = cleanModel(ctx.model);
  const requestedPreset = presetById(allPresets, ctx.preset);
  const presetModel = explicitModel ? "" : cleanModel(requestedPreset && requestedPreset.model);
  const persistedModel = explicitModel || presetModel ? "" : readLastModel();
  const chosenModel = explicitModel || presetModel || persistedModel || cleanModel(s2.model);
  const boundPreset = presetBoundToModel(allPresets, chosenModel);
  const preset = boundPreset || resolvePreset(ctx.preset, chosenModel);
  const model = chosenModel || cleanModel(preset && preset.model);
  const router = snapshot();
  const routerPreset = preset ? router.presets.find((p2) => p2.id === preset.id) : void 0;
  const target = resolveModelTarget(model, router.providers, router.defaultProvider, model ? void 0 : routerPreset && routerPreset.provider);
  const presetSystemPrompt = preset && typeof preset.systemPrompt === "string" ? preset.systemPrompt : "";
  const generalSystemPrompt = (boundPreset ? presetSystemPrompt || defaultSystemPrompt(allPresets) : ctx.systemPrompt || presetSystemPrompt) || defaultSystemPrompt(allPresets) || "";
  const authoredPrompts = readAuthoredPrompts();
  const systemPrompt = model && authoredPrompts[model] || systemPromptForModel(generalSystemPrompt, model);
  const params = { ...s2.params || {}, ...preset && preset.params || {} };
  const mode = ctx.mode === "watcher" ? "watcher" : "interactive";
  const engine = ctx.engine && typeof ctx.engine === "object" ? ctx.engine : null;
  let charter = "";
  let charterError;
  if (engine && engine.kind === "machine") {
    const resolved = resolveCharterRef(engine.charter);
    charter = resolved.charter;
    charterError = resolved.error;
  }
  if (mode === "watcher" && !charter && !charterError) {
    charter = SHIPPED_CHARTERS["watcher-orchestration"] ?? "";
    if (!charter) charterError = "no charter provided and no shipped default";
  }
  const effectiveSystemPrompt = mode === "watcher" ? "" : systemPrompt;
  return {
    messages: [],
    seq: 0,
    systemPrompt: effectiveSystemPrompt,
    mode,
    engine,
    charter,
    machineState: {},
    currentRun: "interactive",
    watcherTicks: 0,
    watcherVerdictEmitted: false,
    watcherLastAssistant: "",
    model: target.model,
    provider: target.provider,
    routeError: target.error || null,
    params,
    previousResponseId: null,
    pendingInputs: [],
    stream: null,
    done: true,
    toolRounds: 0,
    capReached: false,
    malformedRetries: 0,
    pendingTools: null,
    pendingExec: null,
    roundResults: [],
    pendingAuthor: null,
    charterError
  };
}
var plugin = {
  openSession(ctx) {
    const sid = ctx.tabId;
    const s2 = resolveSession(ctx);
    if (s2.charterError) {
      host.log("error", `openSession failed for ${sid}: ${s2.charterError}`);
      return { error: s2.charterError };
    }
    if (s2.mode === "watcher") {
      if (s2.charter) append(s2, "user", markSystemPrompt(s2.charter), "system-prompt");
    } else if (s2.systemPrompt) {
      append(s2, "user", markSystemPrompt(s2.systemPrompt), "system-prompt");
    }
    sessions.set(sid, s2);
    rememberLastModel(sessionModelId(s2));
    return { sessionId: sid };
  },
  sendMessage(sid, text) {
    const s2 = sessions.get(sid);
    if (!s2) return;
    if (s2.mode === "watcher") {
      host.log("warn", `sendMessage ignored for watcher session ${sid}`);
      return;
    }
    append(s2, "user", text);
    s2.toolRounds = 0;
    s2.capReached = false;
    s2.malformedRetries = 0;
    s2.done = false;
    if (s2.engine && s2.engine.kind === "machine") {
      const messages2 = assembleMachine(s2.charter, s2.machineState, { query: text });
      s2.pendingInputs.push(JSON.stringify({ machineMessages: messages2 }));
    } else {
      s2.pendingInputs.push(text);
    }
    startNextIfIdle(s2);
  },
  watcherTick(sid, input) {
    const s2 = sessions.get(sid);
    if (!s2 || s2.mode !== "watcher") return;
    const tickInput = input;
    const messages2 = assembleMachine(s2.charter, tickInput.state, tickInput);
    s2.watcherTicks += 1;
    append(s2, "context_request", JSON.stringify(messages2));
    s2.currentRun = "watcher";
    s2.previousResponseId = null;
    s2.pendingInputs = [];
    s2.pendingTools = null;
    s2.pendingExec = null;
    s2.roundResults = [];
    s2.stream = null;
    s2.toolRounds = 0;
    s2.capReached = false;
    s2.malformedRetries = 0;
    s2.watcherVerdictEmitted = false;
    s2.watcherLastAssistant = "";
    s2.done = false;
    s2.pendingInputs.push(JSON.stringify({ watcherMessages: messages2 }));
    startNextIfIdle(s2);
  },
  pump(sid) {
    const s2 = sessions.get(sid);
    if (!s2) return;
    pollStream(s2);
    drainExec(s2);
    drainAuthor(s2);
    startNextIfIdle(s2);
  },
  poll(sid, cursor) {
    const s2 = sessions.get(sid);
    if (!s2) return { messages: [], cursor: cursor ?? "0", done: true };
    const from = Number(cursor ?? 0) || 0;
    let liveFrom = -1;
    if (s2.stream) {
      for (let i = 0; i < s2.messages.length; i += 1) {
        if (s2.messages[i].id === s2.stream.messageId || s2.messages[i].id === s2.stream.reasoningId) {
          liveFrom = i;
          break;
        }
      }
    }
    const nextCursor = liveFrom >= 0 ? liveFrom : s2.messages.length;
    const done = s2.done && !s2.stream && !s2.pendingExec && !s2.pendingAuthor && s2.pendingInputs.length === 0;
    const state = activityOf({
      streaming: !!s2.stream,
      answering: !!s2.stream && !!s2.stream.content,
      toolsRunning: !!s2.pendingExec || !!s2.pendingTools,
      queued: !done
    });
    const result = {
      messages: s2.messages.slice(from),
      cursor: String(nextCursor),
      done,
      activity: { state, statusLine: activityLine(sessionModelId(s2), state) }
    };
    return result;
  },
  cancel(sid) {
    const s2 = sessions.get(sid);
    if (!s2) return;
    const busy = !!s2.stream || !!s2.pendingExec || !!s2.pendingTools || s2.pendingInputs.length > 0;
    if (s2.stream) {
      host.fetchStreamClose(s2.stream.jobId);
      if (s2.stream.content) append(s2, "assistant", s2.stream.content, s2.stream.messageId);
      s2.stream = null;
    }
    if (s2.pendingExec) {
      host.execClose(s2.pendingExec.jobId);
      emitToolResult(s2, s2.pendingExec.call, { error: "cancelled" }, s2.pendingExec.toolId, s2.pendingExec.callId);
      s2.pendingExec = null;
    }
    s2.pendingTools = null;
    s2.pendingInputs = [];
    s2.roundResults = [];
    if (busy) append(s2, "system", "Stopped.");
    if (s2.currentRun === "watcher") completeWatcherTick(s2, null);
    else s2.done = true;
  },
  closeSession(sid) {
    const s2 = sessions.get(sid);
    if (s2 && s2.stream) host.fetchStreamClose(s2.stream.jobId);
    if (s2 && s2.pendingExec) host.execClose(s2.pendingExec.jobId);
    sessions.delete(sid);
  },
  listModels() {
    const router = snapshot();
    const models = [];
    for (const provider of router.providers) {
      if (!provider.enabled) continue;
      const entry = discoverModels(provider);
      for (const m of entry.models) {
        const badges = capabilityBadges(m.capabilities);
        const info = { id: qualifyModel(provider.id, m.id), displayName: m.displayName, group: provider.name };
        if (m.loaded) info.badge = "loaded";
        else if (badges.length) info.badge = badges[0];
        if (badges.length) info.description = badges.join(" \xB7 ");
        models.push(info);
      }
    }
    return models;
  },
  listPresets() {
    return presets().map((p2) => ({ id: p2.id, name: p2.name, description: p2.description }));
  },
  sessionInfo(sid) {
    const s2 = sessions.get(sid);
    return { model: s2 ? sessionModelId(s2) || void 0 : void 0, systemPrompt: s2 ? s2.systemPrompt : void 0 };
  },
  describeModelSwitch,
  authorSystemPrompt(sid, draft) {
    const s2 = sessions.get(sid);
    if (!s2 || !s2.model) return;
    applyAuthoredPrompt(s2, sessionModelId(s2), draft);
  },
  // R6: hand the "tune this pane's system prompt for model X" task off to a
  // separate agent pane. Plugin-mediated end to end: we read THIS session's
  // model + current prompt, spawn an author agent (host.workspace/agent), send
  // it the request, and park `pendingAuthor`. pump → drainAuthor polls the
  // ticket across turns and writes the reply back via applyAuthoredPrompt, so
  // the user iteratively improves the per-model prompt without editing JSON.
  requestPromptAuthoring(sid, instruction) {
    const s2 = sessions.get(sid);
    if (!s2 || !s2.model) return { ok: false, error: "no active session or model to author for" };
    if (s2.pendingAuthor) return { ok: false, error: "prompt authoring already in progress" };
    let workspaceId = "";
    try {
      workspaceId = host.workspace.ensure({ name: PROMPT_AUTHOR_WORKSPACE }).workspaceId;
    } catch (e) {
      append(s2, "system", `Prompt authoring unavailable: ${String(e)}`);
      return { ok: false, error: String(e) };
    }
    if (!workspaceId) {
      append(s2, "system", "Prompt authoring failed: could not open an authoring workspace.");
      return { ok: false, error: "no workspace" };
    }
    const spawned = host.agent.spawn(workspaceId, {
      task: `Help tune the system prompt for the ${providerLabel(s2)} model "${sessionModelId(s2)}".`
    });
    const agentSessionId = spawned && spawned.sessionId;
    if (!agentSessionId) {
      append(s2, "system", "Prompt authoring failed: could not spawn an author agent.");
      return { ok: false, error: "spawn failed" };
    }
    const sent = host.agent.send(agentSessionId, buildAuthoringRequest(sessionModelId(s2), s2.systemPrompt, instruction));
    const ticket = sent && sent.ticket;
    if (!ticket) {
      try {
        host.agent.reap(agentSessionId);
      } catch {
      }
      append(s2, "system", "Prompt authoring failed: could not send the request to the author agent.");
      return { ok: false, error: "send failed" };
    }
    s2.pendingAuthor = { ticket, agentSessionId, model: sessionModelId(s2) };
    s2.done = false;
    append(s2, "system", `Handing off system-prompt authoring for ${sessionModelId(s2)} to an agent\u2026`);
    return { ok: true };
  },
  setModel(sid, model) {
    const s2 = sessions.get(sid);
    if (!s2 || typeof model !== "string" || !model.trim()) return;
    const router = snapshot();
    const target = resolveModelTarget(model, router.providers, router.defaultProvider);
    if (!target.provider || !target.model) {
      append(s2, "system", `Router error: ${target.error || `cannot route ${model}`}`);
      return;
    }
    if (s2.provider && s2.provider.id === target.provider.id && s2.model === target.model) return;
    s2.provider = target.provider;
    s2.model = target.model;
    s2.routeError = null;
    rememberLastModel(sessionModelId(s2));
    s2.previousResponseId = null;
  }
};
function onAgentCommand(ctx) {
  try {
    return runAgentVerb(ctx.verb, Array.isArray(ctx.args) ? ctx.args : []);
  } catch (e) {
    return { error: `router verb failed: ${String(e)}` };
  }
}
var plugin_default = {
  ...plugin,
  ...decision_default,
  viewCall,
  onAgentCommand,
  __test_resetRouter: resetModelCache,
  __test_domiosContext: DOMIOS_CONTEXT
};
