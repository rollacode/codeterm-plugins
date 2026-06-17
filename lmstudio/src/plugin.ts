// LM Studio plugin — CodeTerm chat transport (capability: chatBackend).
//
// A `chatBackend` plugin: it *is* a pane's chat source. You open a chatBackend
// pane and talk to a local LM Studio server via `codeterm send` — no terminal.
// LM Studio exposes an OpenAI-compatible HTTP API; this plugin connects to it
// over `host.fetch` (POST /v1/chat/completions, GET /v1/models). LM Studio's own
// server IS the backend (R7) — this plugin only connects to it.
//
// Authored in TypeScript against @codeterm/plugin-sdk and compiled to a
// QuickJS-compatible plugin.js by scripts/build-plugin.mjs. QuickJS is not a
// browser: no console, no fetch, no timers — everything goes through `host`.
import type {
  ChatBackend,
  FetchResult,
  Model,
  NormalizedChatMessage,
} from "@codeterm/plugin-sdk";

interface LmStudioSettings {
  baseUrl?: string;
  model?: string;
}

interface Session {
  // Full transcript as the normalized shape the host renders + flattens.
  messages: NormalizedChatMessage[];
  // Monotonic id source — stable ids let the client merge across polls.
  seq: number;
}

const DEFAULT_BASE_URL = "http://localhost:1234";

const sessions = new Map<string, Session>();

function settings(): LmStudioSettings {
  try {
    return (JSON.parse(host.settingsJson()) as LmStudioSettings) || {};
  } catch (e) {
    return {};
  }
}

function baseUrl(): string {
  const s = settings();
  const url = (s.baseUrl && s.baseUrl.length && s.baseUrl) || DEFAULT_BASE_URL;
  return url.replace(/\/+$/, "");
}

function model(): string {
  const s = settings();
  // LM Studio routes to whatever model is loaded when the field is blank, so an
  // empty model is a valid "use the loaded one" request.
  return s.model && s.model.length ? s.model : "";
}

function fetchJson(opts: {
  url: string;
  method: string;
  body?: string;
}): FetchResult {
  const raw = host.fetch(
    JSON.stringify({
      url: opts.url,
      method: opts.method,
      headers: { "content-type": "application/json" },
      body: opts.body,
      timeoutMs: 120000,
    }),
  );
  try {
    return JSON.parse(raw) as FetchResult;
  } catch (e) {
    return { error: "fetch returned non-JSON: " + e };
  }
}

function nextMessage(s: Session, type: string, content: string): NormalizedChatMessage {
  const id = "lmstudio-" + s.seq;
  s.seq += 1;
  return { id: id, type: type, content: content };
}

// Map the normalized transcript to OpenAI chat-completions `messages`. Our
// `type` ("user"/"assistant"/"system") is already the OpenAI `role`; the error
// notes we render as "system" are not replayed to the model.
function toChatMessages(messages: NormalizedChatMessage[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  for (const m of messages) {
    if (m.type === "user" || m.type === "assistant") {
      out.push({ role: m.type, content: m.content });
    }
  }
  return out;
}

const plugin: ChatBackend = {
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
        stream: false,
      }),
    });

    if (res.error) {
      s.messages.push(nextMessage(s, "system", "LM Studio error: " + res.error));
      return;
    }
    if (res.status && res.status >= 400) {
      s.messages.push(
        nextMessage(s, "system", "LM Studio HTTP " + res.status + ": " + (res.body || "")),
      );
      return;
    }

    let reply = "";
    try {
      const data = JSON.parse(res.body || "{}") as {
        choices?: { message?: { content?: unknown } }[];
      };
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
      cursor: String(s.messages.length),
    };
  },

  closeSession(sid) {
    sessions.delete(sid);
  },

  listModels(): Model[] {
    const res = fetchJson({ url: baseUrl() + "/v1/models", method: "GET" });
    if (res.error || (res.status && res.status >= 400)) return [];
    try {
      const data = JSON.parse(res.body || "{}") as { data?: { id?: unknown }[] };
      const rows = data.data || [];
      const models: Model[] = [];
      for (const r of rows) {
        if (r && typeof r.id === "string") {
          models.push({ id: r.id, displayName: r.id });
        }
      }
      return models;
    } catch (e) {
      return [];
    }
  },
};

export default plugin;
