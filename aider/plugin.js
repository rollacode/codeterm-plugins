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

// aider/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  MODE_PROMPT_RE: () => MODE_PROMPT_RE,
  default: () => plugin_default,
  deliverText: () => deliverText,
  extractBannerModel: () => extractBannerModel,
  lastNonEmptyLine: () => lastNonEmptyLine,
  parsePromptWithContext: () => parsePromptWithContext,
  pickTaggedBlockTag: () => pickTaggedBlockTag,
  promptSafeChoice: () => promptSafeChoice,
  wrapMultiline: () => wrapMultiline
});
module.exports = __toCommonJS(plugin_exports);

// aider/src/history.ts
function utf8Length(text) {
  let bytes = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
  }
  return bytes;
}
var ERROR_RE = /(?:\blitellm\.[\w.]*Error\b|\b(?:AuthenticationError|APIConnectionError|RateLimitError|BadRequestError|PermissionDeniedError|InternalServerError)\b|\b(?:Error|Exception):|\b(?:invalid|incorrect|missing) api key\b|\bEmpty response received from LLM\b)/i;
var CHANGE_NOTICE_RE = /^(?:Applied edit to .+|Did not apply edit to .+|Commit [0-9a-f]{7,40}(?: .*)?)$/i;
var NOISE_RE = /^(?:Aider v\d|Model:|Weak model:|Editor model:|Git repo:|Repo[ -]?[Mm]ap:|Tokens:|Added .+ to the chat|Use \/help|Cost:|Open documentation url|Add \.aider\* to \.gitignore|Please visit)/;
function parseAiderHistoryDelta(prefix, fromOffset = 0) {
  const messages = [];
  const state = { current: null };
  let offset = 0;
  let rowOffset = 0;
  let deltaLine = 0;
  let previousHeading = false;
  let fence = null;
  let thinkingTag = null;
  let errorContinuation = false;
  let modeCommandEcho = null;
  function flush() {
    if (!state.current) return;
    const text = state.current.lines.join("\n").trim();
    const echo = state.current.role === "user" && modeCommandEcho !== null && text === modeCommandEcho;
    if (text && text !== "<blank>") {
      modeCommandEcho = state.current.role === "user" && !echo ? /^\/(?:ask|code|architect|context)\s+([\s\S]+)$/.exec(text)?.[1] || null : null;
    }
    if (!echo && text && text !== "<blank>" && state.current.end > fromOffset) {
      messages.push({
        role: state.current.role,
        blocks: [{ kind: state.current.kind, data: { text } }],
        ts: null,
        uuid: `aider:${state.current.kind === "thinking" ? "thinking" : state.current.role}:${state.current.start}`,
        ...state.current.start >= fromOffset ? { recordIndex: state.current.line } : {}
      });
    }
    state.current = null;
  }
  function add(role, text, end, kind = "text") {
    if (state.current?.role !== role || state.current?.kind !== kind) {
      flush();
      state.current = { role, kind, lines: [], start: rowOffset, line: deltaLine, end };
    }
    state.current.lines.push(text);
    if (text.trim()) state.current.end = end;
  }
  const records = prefix.match(/[^\n]*\n|[^\n]+$/g) || [];
  for (const record of records) {
    const raw = record.replace(/\r?\n$/, "");
    const end = offset + utf8Length(record);
    rowOffset = offset;
    let line = raw;
    if (!fence) {
      while (line) {
        if (thinkingTag) {
          const close = `</${thinkingTag}>`;
          const at = line.indexOf(close);
          if (at < 0) {
            add("assistant", line, end, "thinking");
            line = "";
            break;
          }
          if (at > 0) add("assistant", line.slice(0, at), end, "thinking");
          flush();
          line = line.slice(at + close.length);
          thinkingTag = null;
          rowOffset = offset + utf8Length(raw.slice(0, raw.length - line.length));
        } else {
          const open = /<thinking-content-[^>]*>/.exec(line);
          if (!open) break;
          if (open.index > 0) add("assistant", line.slice(0, open.index), end);
          flush();
          rowOffset += utf8Length(line.slice(0, open.index));
          thinkingTag = open[0].slice(1, -1);
          add("assistant", "", end, "thinking");
          line = line.slice(open.index + open[0].length);
        }
      }
      if (thinkingTag && !raw.trim()) add("assistant", "", end, "thinking");
    }
    if (thinkingTag) {
      if (offset >= fromOffset) deltaLine++;
      offset = end;
      continue;
    }
    const heading = !fence && /^####(?: |$)/.test(line);
    if (!fence && /^# aider chat started at /.test(line)) {
      flush();
      previousHeading = false;
      errorContinuation = false;
    } else if (heading) {
      if (!previousHeading) flush();
      const body = line.slice(5).replace(/ {2}$/, "");
      if (body.trim() && body.trim() !== "<blank>") add("user", body, end);
      else if (!body.trim() && previousHeading && state.current?.role === "user") add("user", "", end);
      previousHeading = true;
      errorContinuation = false;
    } else {
      previousHeading = false;
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        add("assistant", line, end);
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) fence = null;
      } else if (marker) {
        fence = { char: marker[1][0], size: marker[1].length };
        add("assistant", line, end);
      } else if (/^> ?/.test(line)) {
        const body = line.replace(/^> ?/, "").replace(/ {2}$/, "");
        if (CHANGE_NOTICE_RE.test(body)) {
          add("system", body, end);
          errorContinuation = false;
        } else if (NOISE_RE.test(body) || !body.trim()) errorContinuation = false;
        else if (ERROR_RE.test(body) || errorContinuation) {
          add("assistant", body, end);
          errorContinuation = true;
        }
      } else if (NOISE_RE.test(line)) {
        errorContinuation = false;
      } else if (line.trim()) {
        add("assistant", line, end);
        errorContinuation = false;
      } else if (state.current?.role === "assistant") {
        add("assistant", "", end);
      }
    }
    if (offset >= fromOffset) deltaLine++;
    offset = end;
  }
  flush();
  return { messages };
}

// aider/src/modelTuning.ts
function modelLaunchArgs(args, model) {
  const output = [];
  let effort;
  let budget;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    const flag = arg.split("=", 1)[0];
    if (flag === "--map-tokens") throw new Error("Configure mapTokens on the selected Aider model instead of launch args.");
    if (flag !== "--reasoning-effort" && flag !== "--thinking-tokens") {
      output.push(arg);
      continue;
    }
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : String(args[++i] ?? "");
    if (!value || value.startsWith("-")) throw new Error(`${flag} requires a declared model option.`);
    if (flag === "--reasoning-effort") effort = value;
    else budget = value;
  }
  if (model.mapTokens !== void 0) output.push("--map-tokens", String(model.mapTokens));
  if (effort !== void 0 && budget !== void 0) throw new Error("Choose a reasoning level or thinking budget, not both.");
  if (effort !== void 0) {
    const level = model.reasoningEfforts.find((level2) => level2.id === effort);
    if (!level || !model.reasoningMode) throw new Error(`Aider model ${model.id} does not declare reasoning level ${effort}.`);
    if (model.reasoningMode === "budget") output.push("--thinking-tokens", String(level.thinkingTokens));
    else output.push("--reasoning-effort", level.id);
  } else if (budget !== void 0) {
    if (model.reasoningMode !== "budget" || !model.reasoningEfforts.some((level) => String(level.thinkingTokens) === budget)) {
      throw new Error(`Aider model ${model.id} does not declare thinking budget ${budget}.`);
    }
    output.push("--thinking-tokens", budget);
  }
  return output;
}

// aider/src/activity.ts
function hasAiderActivity(screen) {
  const lines = String(screen || "").split(/\r?\n/).map((line) => line.trim());
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]) last--;
  if (last < 0 || /^(?:[a-z]+)?>$/.test(lines[last])) return false;
  const tail = lines[last];
  if (/^[░█ #=]+Waiting for \S/.test(tail)) return true;
  if (/^(?:[░█ #=]+)?Updating repo map(?:\b|$)/.test(tail)) return true;
  for (let i = last; i >= 0; i--) {
    if (/^(?:[a-z]+)?>$/.test(lines[i])) return false;
    if (/^(?:[a-z]+)?>\s+\S/.test(lines[i])) return i < last;
  }
  return false;
}

// aider/src/replyRelay.ts
function byteSlice(text, start, end) {
  if (start < 0 || end < start) return null;
  let offset = 0;
  let result = "";
  let starts = start === 0;
  for (const char of text) {
    const next = offset + utf8Length(char);
    if (offset === start) starts = true;
    if (offset < start && next > start || offset < end && next > end) return null;
    if (offset >= start && next <= end) result += char;
    offset = next;
    if (offset === end) return starts ? result : null;
  }
  return offset === end && starts ? result : null;
}
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function readRelayEvidence(history, sidecar, sessionId, afterOffset) {
  const unavailable = (reason) => ({ unavailable: true, reason });
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !integer(afterOffset)) return null;
  if (sidecar === null) return unavailable("This session has no Domios Aider adapter_start record (plain mode or adapter unavailable).");
  const lines = sidecar.split("\n");
  lines.pop();
  let generation = null;
  let records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    if (!record || record.version !== 1 || record.sessionId !== sessionId || record.launchMarker !== sessionId || typeof record.processGeneration !== "string" || !record.processGeneration) return null;
    if (record.kind === "adapter_start") {
      if (record.aiderVersion !== "0.86.2") return unavailable("Unsupported Aider adapter version; install aider-chat==0.86.2.");
      generation = record.processGeneration;
      records = [];
    } else if (record.kind === "turn_complete") {
      if (!generation || record.processGeneration !== generation) return null;
      records.push(record);
    } else return null;
  }
  if (!generation) return unavailable("This session has no Domios Aider adapter_start record.");
  if (history === null) return null;
  const historyBytes = utf8Length(history);
  let sequence = 0;
  for (const record of records) {
    const { userRecordStart: user, responseRecordStart: start, responseRecordEnd: end, historyBytes: size, turnSequence: seq } = record;
    if (!integer(user) || !integer(start) || !integer(end) || !integer(size) || !integer(seq) || seq <= sequence || user >= start || start > end || end > size) return null;
    sequence = seq;
    if (size > historyBytes) return null;
    if (user < afterOffset) continue;
    if (user && byteSlice(history, user - 1, user) !== "\n") return null;
    const userSource = byteSlice(history, user, start);
    if (userSource === null || !userSource.startsWith("#### ")) return null;
    const userRow = parseAiderHistoryDelta(userSource).messages.find((row) => row.role === "user");
    if (!userRow || userRow.uuid !== "aider:user:0") return null;
    const identity = { userTurnId: `aider:${sessionId}:user:${user}`, userRecordStart: user, userText: userRow.blocks[0].data.text };
    if (record.complete === false && ["error", "cancelled", "reflection_limit"].includes(String(record.outcome))) {
      return { ...identity, complete: false, outcome: record.outcome };
    }
    if (record.complete !== true || record.outcome !== "answered" || start === end) return null;
    const response = byteSlice(history, start, end);
    if (response === null) return null;
    const rows = parseAiderHistoryDelta(response).messages;
    if (rows.some((row) => row.role === "user")) return null;
    const answer = rows.filter((row) => row.role === "assistant").flatMap((row) => row.blocks.filter((block) => block.kind === "text").map((block) => block.data.text)).join("\n\n").trim();
    if (!answer) return null;
    return { ...identity, complete: true, assistantTurnId: `aider:${sessionId}:${generation}:answer:${seq}:${start}`, answer };
  }
  return null;
}

// aider/src/endpoints.ts
var PROVIDER_ENV = {
  openai: { key: "OPENAI_API_KEY", base: "OPENAI_API_BASE" },
  anthropic: { key: "ANTHROPIC_API_KEY", base: "ANTHROPIC_API_BASE" },
  groq: { key: "GROQ_API_KEY", base: "GROQ_API_BASE" },
  openrouter: { key: "OPENROUTER_API_KEY", base: "OPENROUTER_API_BASE" }
};
function nonempty(value) {
  return typeof value === "string" ? value.trim() : "";
}
function tokenCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function modelEntries(value) {
  if (typeof value === "string") {
    if (value.trim().startsWith("[")) {
      try {
        value = JSON.parse(value);
      } catch {
        return [];
      }
    } else value = value.split(/\r?\n/);
  }
  if (!Array.isArray(value)) return [];
  const models = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of value) {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const id = nonempty(typeof raw === "string" ? raw : item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const model = { id, reasoningEfforts: [] };
    if (nonempty(item.displayName)) model.displayName = nonempty(item.displayName);
    if (tokenCount(item.mapTokens)) model.mapTokens = item.mapTokens;
    if (item.reasoningMode === "effort" || item.reasoningMode === "budget") {
      model.reasoningMode = item.reasoningMode;
      const levels = Array.isArray(item.reasoningEfforts) ? item.reasoningEfforts : [];
      const levelIds = /* @__PURE__ */ new Set();
      for (const level of levels) {
        if (!level || typeof level !== "object" || Array.isArray(level)) continue;
        const levelId = nonempty(level.id);
        if (!levelId || levelIds.has(levelId)) continue;
        if (model.reasoningMode === "budget" && !tokenCount(level.thinkingTokens)) continue;
        levelIds.add(levelId);
        model.reasoningEfforts.push({
          id: levelId,
          displayName: nonempty(level.displayName) || levelId,
          ...nonempty(level.description) ? { description: nonempty(level.description) } : {},
          ...model.reasoningMode === "budget" ? { thinkingTokens: level.thinkingTokens } : {}
        });
      }
      const defaultId = nonempty(item.defaultReasoningEffort);
      if (model.reasoningEfforts.some((level) => level.id === defaultId)) model.defaultReasoningEffort = defaultId;
    }
    models.push(model);
  }
  return models;
}
function configuredEndpoints(settings) {
  if (!Array.isArray(settings.endpoints)) return [];
  const endpoints = [];
  for (const value of settings.endpoints) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const name = nonempty(value.name);
    const kind = nonempty(value.kind).toLowerCase();
    const apiKeySecret = nonempty(value.apiKeySecret);
    const models = modelEntries(value.models).filter((model) => model.id.startsWith(`${kind}/`));
    if (!name || !Object.prototype.hasOwnProperty.call(PROVIDER_ENV, kind) || !apiKeySecret || !models.length) continue;
    endpoints.push({ name, kind, apiKeySecret, models, ...nonempty(value.apiBase) ? { apiBase: nonempty(value.apiBase) } : {} });
  }
  return endpoints;
}
function endpointModels(endpoints) {
  const ownership = /* @__PURE__ */ new Map();
  for (const endpoint of endpoints) for (const model of endpoint.models) ownership.set(model.id, (ownership.get(model.id) || 0) + 1);
  return endpoints.flatMap((endpoint) => endpoint.models.filter((model) => ownership.get(model.id) === 1).map((model) => ({
    id: model.id,
    displayName: model.displayName || model.id,
    group: endpoint.name,
    reasoningEfforts: model.reasoningEfforts.map(({ id, displayName, description }) => ({ id, displayName, ...description ? { description } : {} })),
    ...model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}
  })));
}
function selectedModel(params) {
  let model = null;
  const args = params.args || [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === "--model" || arg === "-m") {
      if (!args[i + 1] || String(args[i + 1]).startsWith("-")) throw new Error("Aider --model requires a configured model ID.");
      model = String(args[++i]);
    } else if (arg.startsWith("--model=")) {
      model = arg.slice(8);
      if (!model) throw new Error("Aider --model requires a configured model ID.");
    }
  }
  return model;
}
function launchEndpoint(endpoints, model) {
  const id = model ?? endpointModels(endpoints)[0]?.id;
  if (!id) throw new Error("Configure an Aider endpoint with a unique model ID before launching.");
  const owners = endpoints.filter((endpoint) => endpoint.models.some((model2) => model2.id === id));
  if (owners.length !== 1) throw new Error(owners.length ? `Aider model ${id} belongs to multiple endpoints. Configure each model ID once.` : `Aider model ${id} has no configured endpoint.`);
  return { endpoint: owners[0], model: id, entry: owners[0].models.find((model2) => model2.id === id) };
}

// aider/src/plugin.ts
var TITLE_RE = /aider/i;
var OUTPUT_MARKERS = ["aider", "Aider", "Aider Chat"];
var OUTPUT_SIGNALS = [
  "Model:",
  "Tokens:",
  "Repo Map:",
  "Run shell command",
  "Add file to the chat",
  "Create new file"
];
var TUI_FRAGMENTS = ["aider", "tokens sent"];
var PROMPT_QUESTION_RE = /^(Run shell commands?\?|Add file to the chat\?|Create new file[^\n]*\?|Add \.aider\* to \.gitignore \(recommended\)\?|Open documentation url for more info\?)\s*\(Y\)es\/\(N\)o(?:\/\(D\)on't ask again)?\s*(\[[^\]]*\])?\s*:?\s*$/;
var SHELL_COMMAND_QUESTION_RE = /^Run shell commands?\?\s*\(Y\)es\/\(N\)o\s*$/;
var GITIGNORE_QUESTION_RE = /^Add \.aider\* to \.gitignore \(recommended\)\?\s*\(Y\)es\/\(N\)o\s*(\[[^\]]*\])?\s*:?\s*$/;
var DOCS_URL_QUESTION_RE = /^Open documentation url for more info\?\s*\(Y\)es\/\(N\)o\/\(D\)on't ask again\s*(\[[^\]]*\])?\s*:?\s*$/;
var COMMAND_LINE_RE = /^[ \t]*[$>][ \t]+(\S[^\n]*)$/;
var MODE_PROMPT_RE = /^(?:[a-z]+)?>\s*$/;
var TAGGED_BLOCK_BASE = "domios";
function isMultiline(text) {
  return /\r?\n/.test(String(text || ""));
}
function pickTaggedBlockTag(text) {
  let tag = TAGGED_BLOCK_BASE;
  let suffix = 1;
  while (text.includes(`{${tag}`) || text.includes(`{/${tag}}`)) {
    tag = `${TAGGED_BLOCK_BASE}${suffix}`;
    suffix += 1;
  }
  return tag;
}
function wrapMultiline(text) {
  const body = String(text || "");
  const tag = pickTaggedBlockTag(body);
  return `{${tag}
${body}
${tag}}`;
}
function deliverText(text) {
  return isMultiline(text) ? wrapMultiline(text) : String(text || "");
}
function pluginSettings() {
  const raw = typeof host.settingsJson === "function" ? host.settingsJson() : null;
  if (!raw) return {};
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function withLaunchEnv(command, p, endpoint, startupDir) {
  const platform = host.platform();
  const quote = (v) => host.shell.quoteFor(v, platform);
  const isPowerShell = platform === "windows";
  const exports = [];
  exports.push(isPowerShell ? `$env:DOMIOS_AIDER_ADAPTER=${quote(startupDir ? "1" : "0")};` : `export DOMIOS_AIDER_ADAPTER=${quote(startupDir ? "1" : "0")};`);
  if (startupDir) {
    exports.push(isPowerShell ? `$env:PYTHONPATH=(@(${quote(startupDir)}) + @($env:PYTHONPATH -split ';' | Where-Object { $_ })) -join ';';` : `export PYTHONPATH=${quote(startupDir)}\${PYTHONPATH:+":$PYTHONPATH"};`);
  }
  const nonce = typeof p.launchMarker === "string" && p.launchMarker || typeof p.sessionId === "string" && p.sessionId || null;
  if (nonce) {
    exports.push(
      isPowerShell ? `$env:DOMIOS_AIDER_SESSION_ID=${quote(nonce)};` : `export DOMIOS_AIDER_SESSION_ID=${quote(nonce)};`
    );
  }
  const env = PROVIDER_ENV[endpoint.kind];
  if (endpoint.apiBase) {
    exports.push(isPowerShell ? `$env:${env.base}=${quote(endpoint.apiBase)};` : `export ${env.base}=${quote(endpoint.apiBase)};`);
  }
  exports.push(isPowerShell ? `$env:${env.key}=(codeterm mem secret get --name ${quote(endpoint.apiKeySecret)});` : `export ${env.key}="$(codeterm mem secret get --name ${quote(endpoint.apiKeySecret)})";`);
  if (exports.length === 0) return command;
  return `${exports.join(" ")} ${command}`;
}
function historyDir(cwd) {
  return `${String(cwd || "")}/.aider/history`;
}
function historyFilePath(cwd, sessionId) {
  return `${historyDir(cwd)}/${sessionId}.md`;
}
function historyFileEntries(cwd) {
  const fs = globalThis.host?.fs;
  if (!fs || typeof fs.readDir !== "function") return [];
  let entries;
  try {
    entries = fs.readDir(historyDir(cwd));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const raw of entries) {
    const entry = raw;
    if (!entry || typeof entry.name !== "string") continue;
    if (!entry.name.endsWith(".md")) continue;
    const id = entry.name.slice(0, -3);
    if (!id) continue;
    out.push({
      id,
      path: typeof entry.path === "string" && entry.path ? entry.path : historyFilePath(cwd, id),
      modifiedMs: typeof entry.modifiedMs === "number" ? entry.modifiedMs : null
    });
  }
  return out;
}
function lastNonEmptyLine(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}
function extractBannerModel(text) {
  const match = String(text || "").match(/Model:\s*([^\s]+)/);
  return match ? match[1] : null;
}
function extractPromptedCommands(screen) {
  const lines = String(screen || "").split(/\r?\n/);
  const commands = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(COMMAND_LINE_RE);
    if (match) commands.push(match[1].trim());
  }
  return commands;
}
function isCodetermOnlyCommandList(commands) {
  return commands.length > 0 && commands.every((command) => command.startsWith("codeterm "));
}
function isStartupDialog(question) {
  return GITIGNORE_QUESTION_RE.test(question) || DOCS_URL_QUESTION_RE.test(question);
}
function parsePromptWithContext(text) {
  const question = lastNonEmptyLine(String(text || ""));
  if (!PROMPT_QUESTION_RE.test(question)) return null;
  const options = [["Yes", "1"], ["No", "2"]];
  return { question, options };
}
function parsePrompt(text) {
  const prompt = parsePromptWithContext(text);
  return prompt && !isStartupDialog(prompt.question) ? prompt : null;
}
function promptSafeChoice(prompt, screen) {
  if (!prompt || !prompt.question) return null;
  if (GITIGNORE_QUESTION_RE.test(prompt.question)) return "1";
  if (DOCS_URL_QUESTION_RE.test(prompt.question)) return "3";
  if (!SHELL_COMMAND_QUESTION_RE.test(prompt.question)) return null;
  return isCodetermOnlyCommandList(extractPromptedCommands(screen)) ? "1" : null;
}
var plugin = {
  starterPromptText(_prompt) {
    return void 0;
  },
  detectFromTitle(title) {
    return TITLE_RE.test(String(title || ""));
  },
  detectFromOutput(text) {
    const t = String(text || "");
    let hasMarker = false;
    for (let i = 0; i < OUTPUT_MARKERS.length; i++) {
      if (t.indexOf(OUTPUT_MARKERS[i]) !== -1) {
        hasMarker = true;
        break;
      }
    }
    if (!hasMarker) return false;
    for (let j = 0; j < OUTPUT_SIGNALS.length; j++) {
      if (t.indexOf(OUTPUT_SIGNALS[j]) !== -1) return true;
    }
    return false;
  },
  classifyTabState(snapshot) {
    if (snapshot.agentType !== "aider") return null;
    const screen = String(snapshot.screenText || "");
    if (MODE_PROMPT_RE.test(lastNonEmptyLine(screen))) return null;
    const prompt = parsePrompt(screen);
    if (prompt) return { state: "clarifying_question", confidence: 1, data: { questions: [prompt.question] } };
    return hasAiderActivity(screen) ? { state: "working", confidence: 1 } : null;
  },
  screenHasTui(screen) {
    const text = String(screen || "");
    const lower = text.toLowerCase();
    let hasFragment = false;
    for (let i = 0; i < TUI_FRAGMENTS.length; i++) {
      if (lower.indexOf(TUI_FRAGMENTS[i]) !== -1) {
        hasFragment = true;
        break;
      }
    }
    const prompt = lastNonEmptyLine(text);
    if (!MODE_PROMPT_RE.test(prompt)) return false;
    if (/^[a-z]+>$/.test(prompt)) return true;
    return hasFragment && /aider/i.test(text);
  },
  isOutputNoise(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return true;
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (c !== "\u2500" && c !== "\u2501" && c !== "\u2550" && c !== "\u2588" && c !== "\u2580" && c !== " " && c !== "	" && c !== "\n" && c !== "\r") {
        return false;
      }
    }
    return true;
  },
  hasEventMarkers(chunk) {
    return parsePrompt(chunk) !== null || parsePromptWithContext(chunk) !== null;
  },
  detectEvents(text) {
    return parsePrompt(text) || parsePromptWithContext(text) ? ["permission_request"] : [];
  },
  discoverModels() {
    return endpointModels(configuredEndpoints(pluginSettings()));
  },
  modelGroupUsage() {
    return [];
  },
  updatePromptSafeChoice(prompt) {
    return promptSafeChoice(prompt, prompt.question);
  },
  parsePrompt,
  buildPromptResponse(optionIndex, _screen) {
    const ENTER = "DQ==";
    const YES = "WQ==";
    const NO = "Tg==";
    const DONT_ASK = "RA==";
    if (optionIndex === 2) return [DONT_ASK, ENTER];
    return [optionIndex === 0 ? YES : NO, ENTER];
  },
  buildLaunchCommand(params) {
    const p = params || {};
    const platform = host.platform();
    const quote = (v) => host.shell.quoteFor(v, platform);
    const isPowerShell = platform === "windows";
    const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : ".";
    const historyDirPath = `${cwd}/.aider/history`;
    const escapeDir = (value) => isPowerShell ? value.replace(/`/g, "``").replace(/"/g, '`"') : value.replace(/(["\\$`])/g, "\\$1");
    const dirQuoted = escapeDir(historyDirPath);
    const chatHistoryPath = isPowerShell ? `"${dirQuoted}/$($env:DOMIOS_AIDER_SESSION_ID).md"` : `"${dirQuoted}/\${DOMIOS_AIDER_SESSION_ID}.md"`;
    const inputHistoryPath = isPowerShell ? `"${dirQuoted}/$($env:DOMIOS_AIDER_SESSION_ID).input"` : `"${dirQuoted}/\${DOMIOS_AIDER_SESSION_ID}.input"`;
    const settings = pluginSettings();
    const requestedModel = selectedModel(p);
    const selected = launchEndpoint(configuredEndpoints(settings), requestedModel);
    let startupDir;
    if (settings.plainMode !== true) {
      startupDir = host.fs.expandHome("~/.codeterm/plugins/aider/startup") || void 0;
      if (!startupDir) throw new Error("Domios Aider adapter is missing. Reinstall the plugin or explicitly set plainMode=true.");
    }
    const parts = ["aider", ...modelLaunchArgs(p.args || [], selected.entry).map(quote)];
    if (p.toolLessInstructionsPath !== void 0 && p.toolLessInstructionsPath !== null) {
      const path = p.toolLessInstructionsPath;
      let readable = false;
      if (typeof path === "string" && path.trim()) {
        try {
          readable = host.fs.readFileHead(path, 1) !== null;
        } catch (_) {
        }
      }
      if (!readable) throw new Error("Domios tool-less instructions are unreadable. Retry the launch so Domios can recreate its instructions file.");
      parts.push("--read", quote(path));
    }
    if (p.skipPermissions) parts.push("--yes-always");
    if (!requestedModel) parts.push("--model", quote(selected.model));
    parts.push("--no-auto-commits", "--no-pretty", "--no-fancy-input", "--no-show-model-warnings", "--chat-language", "English");
    const instructions = `${cwd.replace(/[\\/]+$/, "")}/AGENTS.md`;
    try {
      if (host.fs.readFileHead(instructions, 1) !== null) {
        parts.push("--read", quote(instructions));
      }
    } catch (_) {
    }
    try {
      const primer = host.fs.expandHome("~/.codeterm/plugins/aider/domios-primer.md");
      if (primer && host.fs.readFileHead(primer, 1) !== null) {
        parts.push("--read", quote(primer));
      }
    } catch (_) {
    }
    const configPath = typeof settings.configPath === "string" && settings.configPath || typeof p.configPath === "string" && p.configPath || null;
    if (configPath) {
      parts.push("--config", quote(configPath));
    }
    const command = parts.join(" ");
    const historyFlags = [
      "--chat-history-file",
      chatHistoryPath,
      "--input-history-file",
      inputHistoryPath
    ].join(" ");
    const mkdir = isPowerShell ? `New-Item -ItemType Directory -Force -Path ${quote(historyDirPath)} | Out-Null;` : `mkdir -p ${quote(historyDirPath)};`;
    return withLaunchEnv(`${mkdir} ${command} ${historyFlags}`, p, selected.endpoint, startupDir);
  },
  buildResumeCommand(_sessionId, _skipPermissions) {
    return this.buildLaunchCommand({});
  },
  buildResumeCommandWithContext(params) {
    return this.buildLaunchCommand({ ...params, task: params.systemPrompt || void 0 });
  },
  launchOnboardingResponse(screen) {
    const prompt = parsePromptWithContext(String(screen || ""));
    if (!prompt) return null;
    const choice = promptSafeChoice(prompt, String(screen || ""));
    if (!choice) return null;
    const keys = this.buildPromptResponse(Number(choice) - 1, String(screen || ""));
    return { frameKey: prompt.question, step: keys[0] };
  },
  launchOnboardingSafeChoice(screen) {
    const prompt = parsePromptWithContext(String(screen || ""));
    return prompt ? promptSafeChoice(prompt, String(screen || "")) : null;
  },
  chatPreprocess(ctx) {
    if (ctx?.provider !== "aider") return null;
    const text = String(ctx?.text || "");
    const delivered = deliverText(text);
    return delivered === text ? null : { text: delivered };
  },
  detectSessionId(cwd, exclude, maxAgeMs) {
    const excluded = Array.isArray(exclude) ? exclude : exclude ? [exclude] : [];
    const limit = typeof maxAgeMs === "number" && maxAgeMs > 0 ? maxAgeMs : 0;
    const now = Date.now();
    let newest = null;
    for (const entry of historyFileEntries(cwd)) {
      if (excluded.indexOf(entry.id) !== -1) continue;
      if (limit > 0) {
        if (entry.modifiedMs === null) continue;
        if (now - entry.modifiedMs > limit) continue;
      }
      if (!newest) {
        newest = entry;
        continue;
      }
      const a = typeof entry.modifiedMs === "number" ? entry.modifiedMs : -1;
      const b = typeof newest.modifiedMs === "number" ? newest.modifiedMs : -1;
      if (a > b) newest = entry;
    }
    return newest ? newest.id : null;
  },
  detectLaunchSession(evidence) {
    const marker = evidence && typeof evidence.launchMarker === "string" ? evidence.launchMarker : "";
    if (!marker) return null;
    const cwd = evidence && typeof evidence.cwd === "string" ? evidence.cwd : "";
    if (!cwd) return null;
    return historyFileEntries(cwd).some((entry) => entry.id === marker) ? { sessionId: marker, source: "launch_marker" } : null;
  },
  enumerateSessions() {
    return [];
  },
  findSession(_sessionId) {
    return null;
  },
  sessionExists(cwd, sessionId) {
    if (!sessionId) return false;
    return historyFileEntries(cwd).some((entry) => entry.id === sessionId);
  },
  sessionCreatedMs(_cwd, _sessionId) {
    return null;
  },
  detectActiveSession(_cwd, _currentSid) {
    return null;
  },
  detectSessionModel(_cwd, _sessionId) {
    return null;
  },
  usageSources(_cwd, _sessionId) {
    return [];
  },
  sessionFilePath(cwd, sessionId) {
    if (!cwd || !sessionId) return null;
    return historyFilePath(cwd, sessionId);
  },
  sessionJsonlPath(cwd, sessionId) {
    if (!cwd || !sessionId) return null;
    return historyFilePath(cwd, sessionId);
  },
  readReplyRelayTurn(cwd, sessionId, afterOffset) {
    if (!cwd || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
    const path = historyFilePath(cwd, sessionId);
    try {
      return readRelayEvidence(host.fs.readFile(path), host.fs.readFile(`${path}.domios-turns.jsonl`), sessionId, afterOffset);
    } catch (_) {
      return { unavailable: true, reason: "Domios Aider completion evidence is unreadable." };
    }
  },
  parseSessionDelta(chunk, context) {
    const text = String(chunk || "");
    if (!context || context.from_offset === 0) return parseAiderHistoryDelta(text);
    const prefix = host.fs.readFileHead(context.session_key, context.from_offset + utf8Length(text));
    if (prefix === null) return { messages: [] };
    return parseAiderHistoryDelta(prefix, context.from_offset);
  },
  checkIntegration() {
    return {
      config_file_exists: false,
      plugin_file_exists: false,
      plugin_file_owned: false,
      plugin_file_current: false,
      plugin_installed: false
    };
  },
  installIntegration(_apiPort, _options) {
    return { ok: false, error: "aider has no integration to install" };
  },
  uninstallIntegration() {
    return { ok: true };
  },
  ensureIntegrationOnStartup(_apiPort) {
    return this.checkIntegration();
  }
};
var plugin_default = plugin;
