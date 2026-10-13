"use strict";
// latent-thinker chatBackend: bridges CodeTerm chat panes to the local
// latent-mem-lab server (python3 latent_loop.py serve --port 8765).
var BASE = "http://127.0.0.1:8765";
var sessions = new Map();

function fetchJson(url, method, body) {
  try {
    var raw = host.fetch(JSON.stringify({
      url: url, method: method || "GET",
      headers: { "content-type": "application/json" },
      body: body, timeoutMs: 15000,
    }));
    var res = JSON.parse(raw);
    if (res.error) return { error: String(res.error) };
    return JSON.parse(res.body || "{}");
  } catch (e) {
    return { error: String(e) };
  }
}

function append(s, type, content, id) {
  var msgId = id || "m" + s.seq++;
  for (var i = 0; i < s.messages.length; i++) {
    if (s.messages[i].id === msgId) {
      s.messages[i].content = content;
      return s.messages[i];
    }
  }
  var m = { id: msgId, type: type, content: content };
  s.messages.push(m);
  return m;
}

function ensure(sid) {
  var s = sessions.get(sid);
  if (!s) {
    s = { messages: [], seq: 1, job: null, cursor: 0, done: true, trace: "" };
    sessions.set(sid, s);
  }
  return s;
}

var KIND_LABEL = {
  thought: "💭 latent step",
  recall: "📚 recall",
  router: "🎛 router",
  silence: "🤫 silence",
  error: "❌ error",
};

var plugin = {
  openSession: function (ctx) {
    if (ctx && typeof ctx.systemPrompt === "string" && ctx.systemPrompt.trim()) {
      var error = new Error("Latent Thinker does not support system instructions. Its server accepts only user text; use a backend supporting session configuration.");
      error.code = "system_instructions_unsupported";
      throw error;
    }
    var sid = (ctx && (ctx.tabId || ctx.paneId || ctx.sessionId)) || ("s" + Date.now());
    try { host.log("info", "latent-thinker openSession ctx=" + JSON.stringify(ctx)); } catch (e) {}
    var s = { messages: [], seq: 1, job: null, cursor: 0, done: true, trace: "" };
    sessions.set(sid, s);
    var h = fetchJson(BASE + "/health");
    if (h.error || !h.ok) {
      append(s, "system",
        "latent-thinker server is not running.\nStart it first:\n" +
        "  cd ~/Developer/latent-mem-lab && python3 latent_loop.py serve --port 8765");
    } else {
      append(s, "system",
        "latent-thinker online · " + h.memories + " memories in bank · router " +
        (h.router ? "trained" : "absent") + " · thinker LoRA " + (h.lora ? "on" : "off"));
    }
    return { sessionId: sid };
  },

  sendMessage: function (sid, text) {
    var s = ensure(sid);
    // "+hint" while a job is thinking = inject into the running thought
    if (s.job && !s.done && text.charAt(0) === "+") {
      append(s, "user", text);
      var inj = fetchJson(BASE + "/inject", "POST",
        JSON.stringify({ job: s.job, text: text.slice(1).trim() }));
      if (inj.error) append(s, "system", "inject error: " + inj.error);
      return;
    }
    append(s, "user", text);
    // "?query" = archivist mode: latent memory search, answer is memory ids
    var payload = { text: text, thoughts: 6 };
    if (text.charAt(0) === "?") {
      payload = { text: text.slice(1).trim(), thoughts: 8, mode: "search" };
    }
    var r = fetchJson(BASE + "/chat", "POST", JSON.stringify(payload));
    if (r.error || !r.job) {
      append(s, "system", "server error: " + (r.error || "no job id"));
      s.done = true;
      return;
    }
    s.job = r.job;
    s.cursor = 0;
    s.done = false;
    s.trace = "";
    s.traceId = "m" + s.seq++;
    s.answerId = "m" + s.seq++;
  },

  pump: function (sid) {
    try { host.log("info", "latent-thinker pump " + sid); } catch (e) {}
    var s = ensure(sid);
    if (!s.job || s.done) return;
    var r = fetchJson(BASE + "/poll?job=" + s.job + "&cursor=" + s.cursor);
    if (r.error) {
      append(s, "system", "poll error: " + r.error);
      s.done = true;
      return;
    }
    var events = r.events || [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.kind === "answer") {
        append(s, "assistant", ev.text, s.answerId);
      } else if (ev.kind === "silence") {
        s.trace += (s.trace ? "\n" : "") + KIND_LABEL.silence + ": " + ev.text;
        append(s, "thinking", s.trace, s.traceId);
        append(s, "assistant", "…", s.answerId);
      } else {
        var label = KIND_LABEL[ev.kind] || ev.kind;
        s.trace += (s.trace ? "\n" : "") + label + ": " + ev.text;
        append(s, "thinking", s.trace, s.traceId);
      }
    }
    s.cursor = typeof r.cursor === "number" ? r.cursor : s.cursor + events.length;
    if (r.done) {
      s.done = true;
      s.job = null;
    }
  },

  poll: function (sid, cursor) {
    try { host.log("info", "latent-thinker poll " + sid + " cur=" + cursor); } catch (e) {}
    var s = ensure(sid);
    var from = Number(cursor || 0) || 0;
    var liveFrom = -1;
    if (!s.done) {
      for (var i = 0; i < s.messages.length; i++) {
        if (s.messages[i].id === s.traceId || s.messages[i].id === s.answerId) {
          liveFrom = i;
          break;
        }
      }
    }
    var next = liveFrom >= 0 ? liveFrom : s.messages.length;
    return {
      messages: s.messages.slice(from),
      cursor: String(next),
      done: s.done,
    };
  },

  closeSession: function (sid) {
    sessions.delete(sid);
  },

  listModels: function () {
    return [{ id: "latent-thinker", name: "Latent Thinker (Qwen2.5-1.5B + mem bank)" }];
  },
};

var plugin_exports = {};
plugin_exports.default = plugin;
module.exports = plugin_exports;
