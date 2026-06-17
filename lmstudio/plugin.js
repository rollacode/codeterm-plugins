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
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);
var DEFAULT_BASE_URL = "http://localhost:1234";
var sessions = /* @__PURE__ */ new Map();
function settings() {
  try {
    return JSON.parse(host.settingsJson()) || {};
  } catch (e) {
    return {};
  }
}
function baseUrl() {
  const s = settings();
  const url = s.baseUrl && s.baseUrl.length && s.baseUrl || DEFAULT_BASE_URL;
  return url.replace(/\/+$/, "");
}
function model() {
  const s = settings();
  return s.model && s.model.length ? s.model : "";
}
function fetchJson(opts) {
  const raw = host.fetch(
    JSON.stringify({
      url: opts.url,
      method: opts.method,
      headers: { "content-type": "application/json" },
      body: opts.body,
      timeoutMs: 12e4
    })
  );
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { error: "fetch returned non-JSON: " + e };
  }
}
function nextMessage(s, type, content) {
  const id = "lmstudio-" + s.seq;
  s.seq += 1;
  return { id, type, content };
}
function toChatMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.type === "user" || m.type === "assistant") {
      out.push({ role: m.type, content: m.content });
    }
  }
  return out;
}
var plugin = {
  openSession(ctx) {
    const sid = ctx.paneId;
    sessions.set(sid, { messages: [], seq: 0 });
    return { sessionId: sid };
  },
  sendMessage(sid, text) {
    const s = sessions.get(sid);
    if (!s) return;
    s.messages.push(nextMessage(s, "user", text));
    const res = fetchJson({
      url: baseUrl() + "/v1/chat/completions",
      method: "POST",
      body: JSON.stringify({
        model: model(),
        messages: toChatMessages(s.messages),
        stream: false
      })
    });
    if (res.error) {
      s.messages.push(nextMessage(s, "system", "LM Studio error: " + res.error));
      return;
    }
    if (res.status && res.status >= 400) {
      s.messages.push(
        nextMessage(s, "system", "LM Studio HTTP " + res.status + ": " + (res.body || ""))
      );
      return;
    }
    let reply = "";
    try {
      const data = JSON.parse(res.body || "{}");
      const c = data.choices && data.choices[0] && data.choices[0].message;
      reply = c && typeof c.content === "string" ? c.content : "";
    } catch (e) {
      s.messages.push(nextMessage(s, "system", "could not parse LM Studio response: " + e));
      return;
    }
    s.messages.push(nextMessage(s, "assistant", reply));
  },
  poll(sid, cursor) {
    const s = sessions.get(sid);
    if (!s) return { messages: [], cursor: cursor ?? null };
    const from = Number(cursor ?? 0) || 0;
    return {
      messages: s.messages.slice(from),
      cursor: String(s.messages.length)
    };
  },
  closeSession(sid) {
    sessions.delete(sid);
  },
  listModels() {
    const res = fetchJson({ url: baseUrl() + "/v1/models", method: "GET" });
    if (res.error || res.status && res.status >= 400) return [];
    try {
      const data = JSON.parse(res.body || "{}");
      const rows = data.data || [];
      const models = [];
      for (const r of rows) {
        if (r && typeof r.id === "string") {
          models.push({ id: r.id, displayName: r.id });
        }
      }
      return models;
    } catch (e) {
      return [];
    }
  }
};
var plugin_default = plugin;
