# Domios Router

A CodeTerm **chatBackend** that routes a chat pane to any registered model
provider: LM Studio, any OpenAI-compatible API (OpenRouter, Groq, Together,
DeepSeek, xAI, Mistral, Ollama, vLLM, LiteLLM, custom servers) and the
Anthropic Messages API. The plugin id stays `lmstudio` so existing installs,
grants and secrets carry over; with no router configuration it behaves exactly
like the LM Studio plugin it grew from.

The shell streams partial tokens, shows the active system prompt as the first
message, runs validated CodeTerm tool calls parsed by the host, and appends a
token-usage line (cached vs fresh input) after each reply.

## Router

| Kind | Models | Chat | Auth |
|---|---|---|---|
| `openai` | `GET {api}/models` | `POST {api}/chat/completions` (SSE) | `Authorization: Bearer` |
| `anthropic` | `GET {base}/v1/models` | `POST {base}/v1/messages` (SSE) | `x-api-key` + `anthropic-version` |
| `lmstudio` | `GET /api/v0/models` (load state), falls back to `/api/v1/models` | native `POST /api/v1/chat` | optional Bearer |

- **Providers** live in the Router view (Extensions → Domios Router) or come
  from agent verbs; `config.yaml` may also declare read-only `providers`.
  Each provider has `{id, name, kind, baseUrl, apiKeySecret, models?}`.
  `models` lists ids for APIs without a model listing (for example
  Xiaomi MiMo's Anthropic-compatible endpoint).
- **Model ids** are `provider::model`; bare ids belong to the LM Studio
  provider, so remembered models and preset bindings keep working.
- **Keys** live only in the plugin secret store. Paste one into the masked
  field on a provider card, or pipe it into a declared slot:

  ```sh
  printf %s "$KEY" | codeterm plugin config lmstudio --secret openrouter_api_key
  ```

  Declared slots: `lmstudio`, `openai`, `anthropic`, `openrouter`, `groq`,
  `together`, `deepseek`, `xai`, `mistral`, `gemini`, `mimo`, `litellm` and
  `custom1`–`custom4` (each `<name>_api_key`). Keys never enter
  `config.yaml`, the router state file, transcripts or logs.
- **Hosts**: the manifest allows localhost and the common cloud APIs. Any
  other host needs a grant:
  `codeterm plugin settings lmstudio --allow-host <host[:port]>`.
- **Presets** `{id, name, provider?, model?, temperature?, maxTokens?,
  systemPrompt?, params?}` pin a route and its knobs.
- **Prompt caching**: Anthropic requests mark the system block and the turn
  before the newest user message with `cache_control: {type: "ephemeral"}`;
  OpenAI-compatible providers cache automatically. Usage reports
  `cache_read_input_tokens` / `prompt_tokens_details.cached_tokens` as
  cached input. Turn the line off with `showUsage: false`.

Agent verbs (`codeterm plugin lmstudio <verb>`): `providers`,
`add-provider <id> <kind> <baseUrl> [--name N] [--key-slot S] [--models a,b]`,
`remove-provider <id>`, `test-provider <id>`, `set-default <id>`,
`models [provider] [query] [--refresh]`, `presets`,
`add-preset <id> <provider::model> [--temperature N] [--max-tokens N] [--system T]`,
`remove-preset <id>`.

## Setup

1. Open LM Studio, load a model, and start its server (Developer -> Start Server).
   The default endpoint is `http://localhost:1234`.
2. Set **Server address** in the plugin detail panel. It defaults to
   `http://localhost:1234`. For a remote server, CodeTerm 1.12.4 and later can
   grant its host with the second command below:

   ```sh
   codeterm plugin config lmstudio --set baseUrl=http://eight.tail0e459c.ts.net:1234
   codeterm plugin settings lmstudio --allow-host eight.tail0e459c.ts.net:1234
   ```

   The first command sets the endpoint used by both chat and decision requests;
   the second grants that host in CodeTerm. See [`config.yaml`](./config.yaml)
   for the available settings and default preset shape.
3. Open a chatBackend pane for this plugin, or spawn it as a shell when the host
   exposes chatBackend providers through `codeterm agent spawn`.

## Watcher mode (orchestration health)

Spawn a read-only watcher manager under an orchestrator:

```sh
codeterm agent spawn lmstudio --role Watcher --parent <orch-pane-id> \
  --charter charter:watcher-orchestration --interval 90s
```

- **Read-only:** `codeterm send` into a watcher pane is rejected; inputs come only from the host tick scheduler.
- **Charter:** immutable instruction fixed at spawn. Use `--charter <text>` or `--charter-file path.md`, or reference a shipped charter: `charter:watcher-orchestration` (body in [`prompts/watcher-orchestration.md`](./prompts/watcher-orchestration.md), bundled into `plugin.js` at build). `config.yaml` `charters` maps ids to prompt paths for documentation only.
- **Tick loop:** every `interval`, the host assembles an observation snapshot (orchestrator group, optional chat tails and agent reports) and calls `watcherTick`. The pane transcript shows a context card → model reply → verdict card.
- **Verdict contract:** the model responds with JSON only:

```json
{
  "status": "ok" | "attention" | "stalled",
  "summary": "one-line assessment",
  "state": { "...": "next state blob" },
  "actions": [{ "kind": "nudge", "pane": "<pane_id>", "message": "..." }]
}
```

The host parses verdicts tolerantly and executes allowed actions (`nudge`, `notify`, `report`) with guardrails. See the host docs (`docs/PLUGINS.md`, watcher spec) for the full contract.

## Configuration

Config lives in [`config.yaml`](./config.yaml):

- `baseUrl`: server address for chat and decision requests, default
  `http://localhost:1234`. A remote address can be a reachable Tailscale name;
  add its `host:port` in CodeTerm 1.12.4 and later with
  `codeterm plugin settings lmstudio --allow-host <host:port>`.
- `model`: fallback model id; blank lets LM Studio use the loaded model.
- `decision.model`: model id for decision requests; blank uses `model` or the first id from `GET /v1/models`. `decision.maxTokens` defaults to 64 (clamped to 8–128); `decision.timeoutMs` is capped at 30 seconds.
- `defaultPreset`: preset id when the chosen model has no bound preset and the
  session does not request one explicitly.
- `presets`: array of `{ id, name, systemPrompt?, model?, params? }`. A preset
  with `model` binds to that exact model id.
- `charters`: map of `{ id: prompts/<file>.md }` documenting shipped watcher charters (bodies bundled at build; inline string values override for custom ids).

Preset resolution at session init is: chosen model's bound preset, then
`ctx.preset`, then `defaultPreset`. A bound preset's `systemPrompt` and `params`
apply automatically for that model. If a preset has no `systemPrompt`, the
default preset prompt is used. For unbound models, `ctx.systemPrompt` can still
override the resolved preset prompt for that session. The prompt is emitted as
the first `system_prompt` message so the UI can render it as an observable card.

Watcher sessions emit the **charter** as the system-prompt card instead of a chat preset.

The manifest grants the local defaults (`localhost:1234`, `127.0.0.1:1234`).
On CodeTerm 1.12.4 and later, grant a remote endpoint's `host:port` with
`codeterm plugin settings lmstudio --allow-host <host:port>`. CodeTerm applies
that host grant to requests for both capabilities. An optional stored Supporter
token is automatically added as a bearer header on CodeTerm 1.12.4 and later;
the plugin never receives or logs it.

## How It Works

- `openSession` resolves the model-bound/requested/default preset and stores
  system prompt, model, params, and LM Studio stateful continuation id for the
  pane. Watcher sessions resolve `charter:<id>` references from `charters` in config.
- `sendMessage` appends the user turn and starts a native `POST /api/v1/chat`
  streaming job through `host.fetchStream`. Ignored on watcher panes (read-only).
- `watcherTick` (watcher only) enqueues a one-shot machine query via
  `assembleMachine(charter, state, tickInput)` — no transcript history growth.
- `pump` polls stream chunks, re-emits the growing assistant message with a
  stable id, passes completed assistant text to `host.toolcall.parse` with the
  curated schema (interactive chat only), emits a structured `tool_call`, executes the selected host
  tool, appends `tool_result`, and continues until the parser returns `null`.
  Watcher completions emit `watcher_verdict` instead of entering the tool loop.
- LM Studio continuation uses `previous_response_id` from the previous
  `response_id`. If no continuation id is available, the plugin resends assembled
  visible context as `input`. Watcher and machine-engine paths never chain
  `previous_response_id`.
- `listModels` lists every enabled provider's models, grouped per provider
  in the picker, cached 15 s for LM Studio and 10 min for remote APIs
  (failures for 60 s).

Tool rounds are capped at 8 per user turn.

The curated `exec` and `codeterm` tools run commands through `sh -lc`; the host
still gates that subprocess path through this plugin's manifest grant. The
manifest also lists `codeterm` in `subprocess.allow` for readability, but the
current implementation invokes it through `sh`, so that direct `codeterm` grant
is redundant.

## Decision model

The plugin also provides the `decisionModel` capability through LM Studio's
OpenAI-compatible `POST /v1/chat/completions` endpoint. `models()` reads loaded
ids from `GET /v1/models`; it does not bundle model ids. `decision.model` selects
a model explicitly, otherwise the general `model` setting or first loaded id is
used. A model selected by the host through `selectModel` takes precedence for
subsequent decision requests; `modelId` reports that selection, and `metadata`
reports the adapter name and configured server address. This selection is
independent of a chat pane's model and does not change `decision.model` in the
plugin configuration. The default `decision.maxTokens` is 64 so engines can
emit leading whitespace before their first answer token. The configured value
is clamped to 8–128 tokens.

When a response includes token `top_logprobs`, the adapter skips whitespace-only
generated tokens and derives noul and choice probabilities from the first content
token. Noul combines case and leading-space yes/no variants before normalizing.
If token logprobs are absent (as observed with LM Studio's MLX engine), the
adapter retries with a JSON-schema-constrained response. LM Studio documents the
OpenAI-compatible chat-completions payload and JSON-schema output support in its
[Chat Completions docs](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)
and [Structured Output docs](https://lmstudio.ai/docs/developer/openai-compat/structured-output).
In the owner's local probe, `logprobs: true` with `top_logprobs: 5` returned
`logprobs: null` for the loaded MLX models, while a JSON-schema enum was honored.
That path is approximate:
noul uses the model's 0–100 confidence for yes/no, while choice assigns that
confidence to the selected label and spreads the remainder evenly across the
other labels. After a model uses this path, its entry in `models()` is marked
`(approximate fallback)`. A missing candidate in a present logprob list remains a
parse error; the adapter does not invent a logprob.

For score fallback, the model returns one constrained numeric point in the
0–(number of levels − 1) range. The result's index-keyed probability map linearly
interpolates between adjacent levels to preserve that point estimate; it is not
a model confidence distribution, so `confidence` is null. This result is
approximate as well.

`decision.timeoutMs` is a per-request cap (default and maximum 30 seconds). The
current SDK `DecisionRequest` does not expose the host's remaining deadline, so
this cap cannot track that live deadline. The host also maps plugin exceptions to
a generic decision transport error, so the plugin's detailed parse-error text
may not reach callers.

## Develop

```sh
node scripts/build-plugin.mjs lmstudio
npx tsx lmstudio/plugin.test.cjs
npx tsx --test lmstudio/src/router/router.test.ts lmstudio/ui/src/view.test.tsx
npm run typecheck
npm run check:icons
```
