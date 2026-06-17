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

// chat-preprocessor/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);
var mem = host.mem;
var worker = host.worker;
var DEFAULT_BACKEND = "mem";
var DEFAULT_COMPOSE = "append";
var DEFAULT_MEM_K = 3;
var GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
var GROQ_DEFAULT_MODEL = "llama-3.1-8b-instant";
var GROQ_API_KEY_SECRET = "groqApiKey";
var WORKER_POLL_LIMIT = 60;
function settings() {
  try {
    return JSON.parse(host.settingsJson()) || {};
  } catch (e) {
    return {};
  }
}
function contextBlock(body) {
  const trimmed = (body || "").trim();
  if (!trimmed.length) return null;
  return "<context>\n" + trimmed + "\n</context>";
}
function compose(text, block, mode) {
  if (!block) return text;
  return mode === "prepend" ? block + "\n\n" + text : text + "\n\n" + block;
}
function memContext(query) {
  let hits = [];
  try {
    const res = mem.search({ query, k: DEFAULT_MEM_K });
    hits = res && res.hits || [];
  } catch (e) {
    return null;
  }
  if (!hits.length) return null;
  const body = hits.map((h) => "- " + h.text).join("\n");
  return contextBlock(body);
}
function groqContext(query, model) {
  const apiKey = host.secretGet(GROQ_API_KEY_SECRET);
  if (!apiKey) return null;
  let raw;
  try {
    raw = host.fetch(
      JSON.stringify({
        url: GROQ_URL,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + apiKey
        },
        body: JSON.stringify({
          model: model && model.length ? model : GROQ_DEFAULT_MODEL,
          messages: [
            {
              role: "system",
              content: "You add brief, relevant background context for the user's message. Reply with only the context (a few bullet points or sentences), no preamble. If you have nothing useful to add, reply with an empty message."
            },
            { role: "user", content: query }
          ],
          stream: false
        }),
        timeoutMs: 3e4
      })
    );
  } catch (e) {
    return null;
  }
  try {
    const res = JSON.parse(raw);
    if (res.error) return null;
    if (res.status && res.status >= 400) return null;
    const data = JSON.parse(res.body || "{}");
    const c = data.choices && data.choices[0] && data.choices[0].message;
    const content = c && typeof c.content === "string" ? c.content : "";
    return contextBlock(content);
  } catch (e) {
    return null;
  }
}
function workerContext(query) {
  let jobId;
  try {
    const started = worker.start({
      task: "Provide brief, relevant background context for this user message. Reply with only the context, no preamble:\n\n" + query
    });
    jobId = started && started.jobId;
  } catch (e) {
    return null;
  }
  if (!jobId) return null;
  for (let i = 0; i < WORKER_POLL_LIMIT; i += 1) {
    let p;
    try {
      p = worker.poll(jobId);
    } catch (e) {
      return null;
    }
    if (!p) return null;
    if (p.done) {
      if (p.error) return null;
      return contextBlock(p.report || "");
    }
  }
  return null;
}
var plugin = {
  match: "text",
  chatPreprocess(ctx) {
    const s = settings();
    if (!s.enabled) return null;
    const text = ctx.text;
    if (!text || !text.trim().length) return null;
    const backend = s.backend || DEFAULT_BACKEND;
    const mode = s.composeMode === "prepend" ? "prepend" : DEFAULT_COMPOSE;
    const model = s.model || "";
    let block = null;
    if (backend === "mem") {
      block = memContext(text);
    } else if (backend === "groq") {
      block = groqContext(text, model);
    } else if (backend === "worker") {
      block = workerContext(text);
    } else {
      return null;
    }
    if (!block) return null;
    return { text: compose(text, block, mode) };
  }
};
var plugin_default = plugin;
