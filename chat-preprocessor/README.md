# Chat Preprocessor

An outbound **message stage** for CodeTerm (capability: `chatPreprocessor`,
`match: "text"`). Before the agent sees a user turn, this plugin folds relevant
**context** into the message as a `<context>` block — so the agent answers with
your memory, project notes, or model-supplied background already in view.

It is the proof of CodeTerm's host-API base (Track C): a plugin reads the
outbound text, calls `host.*` to gather context, and rewrites the turn — or
returns `null` to pass it through untouched.

## How it works

`chatPreprocess(ctx)` runs synchronously on each user turn. It reads its config,
picks a backend, gathers a context block, and composes it with your text. If the
plugin is disabled, the turn is empty, no context is found, or a backend errors,
it returns `null` and your message is sent exactly as typed.

## Backends

Pick one with `backend:` in `config.yaml`:

| backend  | source                                   | needs                          |
|----------|------------------------------------------|--------------------------------|
| `mem`    | `host.mem.search` over CodeTerm memory   | nothing (default)              |
| `groq`   | a Groq model via `host.fetch`            | `groqApiKey` secret + network  |
| `worker` | a one-shot worker agent (`host.worker`)  | nothing                        |

## Compose modes

- `append` (default) — your text, then the `<context>` block underneath.
- `prepend` — the `<context>` block first, then your text.

## Configuration

Everything is in the self-documenting [`config.yaml`](./config.yaml) —
`enabled`, `backend`, `model`, `composeMode`. The Groq API key is a **secret**
(stored under `groqApiKey`, never in the YAML):

```
codeterm plugin config chat-preprocessor --set enabled=true --set backend=mem
codeterm plugin config chat-preprocessor --set groqApiKey=gsk_...   # groq only
```

## Development

```
npm run build           # from the repo root: builds src/plugin.ts → plugin.js
npx tsx chat-preprocessor/plugin.test.cjs   # unit tests (fake host)
```

The unit tests exercise the pure compose logic against a **fake `host`**
(`host.mem` / `host.worker` / `host.fetch` / `host.secretGet`) — no live host is
needed. The real synchronous `host.mem`/`host.worker` binds land with Track C2;
live integration is verified in Track V.
