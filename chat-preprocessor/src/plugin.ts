// Chat Preprocessor plugin — CodeTerm outbound message stage (capability: chatPreprocessor).
//
// A `chatPreprocessor` is a compose/send-time stage in the outbound message
// pipeline (the slot it grabs is `match: "text"`). Before the agent sees a user
// turn, `chatPreprocess(ctx)` may rewrite the text — here, by folding in relevant
// context as a `<context>` block. Returning `null` means "passthrough, leave the
// message untouched" (disabled, no context found, or a backend error — we never
// drop the user's turn).
//
// Three pluggable context backends, chosen by `settings.backend`:
//   - "mem":    host.mem.search(ctx.text) over your CodeTerm memory.
//   - "groq":   ask a Groq model (host.fetch) to produce context for the turn.
//   - "worker": run a one-shot worker agent (host.worker.start/poll) to produce it.
//
// Authored in TypeScript against @codeterm/plugin-sdk and compiled to a
// QuickJS-compatible plugin.js by scripts/build-plugin.mjs. QuickJS is not a
// browser: no console, no fetch, no timers — everything goes through `host`.
//
// ── On sync vs async (the C2 contract this plugin is the proof of) ──
// `chatPreprocess` returns `{ text } | null` *synchronously* — not a Promise — and
// QuickJS has no event loop to drain mid-call (one synchronous `call_json`
// dispatch). So every host call this stage makes must return synchronously from
// the VM's view. Two backends already satisfy that today: `host.fetch` blocks the
// VM thread then returns (it bridges async via a joined blocking thread), and
// `host.mem.search` is sync at the host (F4: a direct `svc.mem.search()`). The SDK
// *types* `host.mem`/`host.worker` as `Promise`-returning for await-consistency
// with the genuinely-async `host.agent` siblings; the matching synchronous binds
// land in Track C2. Until then we code — and fake, in plugin.test.cjs — against the
// synchronous runtime views declared below.
import type { ChatPreprocessor } from "@codeterm/plugin-sdk";

type ComposeMode = "append" | "prepend";

interface PreprocessorSettings {
  enabled?: boolean;
  backend?: "mem" | "worker" | "groq";
  model?: string;
  composeMode?: ComposeMode;
}

// A single memory hit as host.mem.search returns it (see SDK HostMem).
interface MemHit {
  id: string;
  text: string;
  score: number;
}

// Synchronous runtime views of the host compute binds (see the file header note).
// Track C2 finalizes these; the SDK surfaces the same methods as Promise-returning
// for the async host.agent siblings, but the compose stage consumes them inline.
interface SyncMem {
  search(opts: { query: string; k?: number }): { hits: MemHit[] };
}
interface SyncWorker {
  start(opts: { task: string; timeoutMs?: number }): { jobId: string };
  poll(jobId: string): { done: boolean; report?: string; error?: string };
}

const mem = host.mem as unknown as SyncMem;
const worker = host.worker as unknown as SyncWorker;

const DEFAULT_BACKEND = "mem";
const DEFAULT_COMPOSE: ComposeMode = "append";
const DEFAULT_MEM_K = 3;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_DEFAULT_MODEL = "llama-3.1-8b-instant";
const GROQ_API_KEY_SECRET = "groqApiKey";
// Bound the worker poll loop so a stuck/never-finishing job can't wedge a send.
const WORKER_POLL_LIMIT = 60;

function settings(): PreprocessorSettings {
  try {
    return (JSON.parse(host.settingsJson()) as PreprocessorSettings) || {};
  } catch (e) {
    return {};
  }
}

// Wrap a non-empty context body in the <context> block we fold into the turn.
// Returns null for an empty/blank body so callers treat it as "no context".
function contextBlock(body: string): string | null {
  const trimmed = (body || "").trim();
  if (!trimmed.length) return null;
  return "<context>\n" + trimmed + "\n</context>";
}

// Fold a context block into the user's text per composeMode. A null/blank block
// means passthrough (return the original text unchanged).
function compose(text: string, block: string | null, mode: ComposeMode): string {
  if (!block) return text;
  return mode === "prepend" ? block + "\n\n" + text : text + "\n\n" + block;
}

// ── Backend: mem ── search CodeTerm memory, render the hits as a bullet list.
function memContext(query: string): string | null {
  let hits: MemHit[] = [];
  try {
    const res = mem.search({ query: query, k: DEFAULT_MEM_K });
    hits = (res && res.hits) || [];
  } catch (e) {
    return null;
  }
  if (!hits.length) return null;
  const body = hits.map((h) => "- " + h.text).join("\n");
  return contextBlock(body);
}

// ── Backend: groq ── ask a Groq model for context relevant to the turn.
function groqContext(query: string, model: string): string | null {
  const apiKey = host.secretGet(GROQ_API_KEY_SECRET);
  if (!apiKey) return null;

  let raw: string;
  try {
    raw = host.fetch(
      JSON.stringify({
        url: GROQ_URL,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({
          model: model && model.length ? model : GROQ_DEFAULT_MODEL,
          messages: [
            {
              role: "system",
              content:
                "You add brief, relevant background context for the user's message. " +
                "Reply with only the context (a few bullet points or sentences), no preamble. " +
                "If you have nothing useful to add, reply with an empty message.",
            },
            { role: "user", content: query },
          ],
          stream: false,
        }),
        timeoutMs: 30000,
      }),
    );
  } catch (e) {
    return null;
  }

  try {
    const res = JSON.parse(raw) as {
      error?: string;
      status?: number;
      body?: string;
    };
    if (res.error) return null;
    if (res.status && res.status >= 400) return null;
    const data = JSON.parse(res.body || "{}") as {
      choices?: { message?: { content?: unknown } }[];
    };
    const c = data.choices && data.choices[0] && data.choices[0].message;
    const content = c && typeof c.content === "string" ? c.content : "";
    return contextBlock(content);
  } catch (e) {
    return null;
  }
}

// ── Backend: worker ── run a one-shot worker agent to produce context. The job is
// async (job-id/poll), so we start it then poll synchronously to completion within
// a bounded loop; a never-finishing or failing job yields passthrough.
function workerContext(query: string): string | null {
  let jobId: string;
  try {
    const started = worker.start({
      task:
        "Provide brief, relevant background context for this user message. " +
        "Reply with only the context, no preamble:\n\n" +
        query,
    });
    jobId = started && started.jobId;
  } catch (e) {
    return null;
  }
  if (!jobId) return null;

  for (let i = 0; i < WORKER_POLL_LIMIT; i += 1) {
    let p: { done: boolean; report?: string; error?: string };
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

const plugin: ChatPreprocessor = {
  match: "text",

  chatPreprocess(ctx) {
    const s = settings();
    if (!s.enabled) return null; // disabled → passthrough

    const text = ctx.text;
    if (!text || !text.trim().length) return null; // nothing to augment

    const backend = s.backend || DEFAULT_BACKEND;
    const mode: ComposeMode = s.composeMode === "prepend" ? "prepend" : DEFAULT_COMPOSE;
    const model = s.model || "";

    let block: string | null = null;
    if (backend === "mem") {
      block = memContext(text);
    } else if (backend === "groq") {
      block = groqContext(text, model);
    } else if (backend === "worker") {
      block = workerContext(text);
    } else {
      return null; // unknown backend → passthrough rather than guess
    }

    if (!block) return null; // no context found / backend error → passthrough
    return { text: compose(text, block, mode) };
  },
};

export default plugin;
