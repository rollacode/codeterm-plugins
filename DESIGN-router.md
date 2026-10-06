# Domios Router (evolves `lmstudio/`)

## What changes
LM Studio-only chat backend becomes a router over many providers. One `chatBackend`
session is bound to one route (provider + model + preset); the CodeTerm text-tool loop,
watcher mode, presets, authored prompts and the `decisionModel` capability stay as they are
(decision keeps targeting the LM Studio `baseUrl`).

## Library vs thin adapters (decided with evidence)
- Host fact: plugin methods must be synchronous; `__ct_invoke__` throws when a method returns a
  Promise (`codeterm-plugin/src/js_runtime/vm.rs`). Network is `host.fetch` / `host.fetchStream`
  job polling; there is no `fetch`, `Response`, streams, `TextDecoder`, timers or `URL`.
- Spike (esbuild cjs/neutral/es2020, run in QuickJS): Vercel AI SDK (`ai@7.0.128`,
  `@ai-sdk/openai-compatible@3.0.63`, `@ai-sdk/anthropic@4.0.72`) does not bundle (node
  `fs/path/os` via `@vercel/oidc`). With node stubs it bundles to 1.2 MB and throws at load:
  `ReferenceError: 'TransformStream' is not defined`. Its API is Promise-based anyway.
  `token.js@0.7.1` does not bundle (AWS SDK, `node:http2`).
- LiteLLM proxy and OpenRouter are optional upstreams. Each one exposes an OpenAI-compatible
  endpoint, so you register it as an `openai` provider with no extra code. LiteLLM injects
  `cache_control` and normalizes usage. OpenRouter routes Anthropic and Gemini and reports
  `prompt_tokens_details.cached_tokens`.
- Decision: write thin typed adapters behind one interface: `modelsRequest`, `parseModels`,
  `chatRequest`, `StreamParser` (SSE → content/reasoning/usage/responseId) and usage
  normalization.

| kind | models | chat | auth |
|---|---|---|---|
| `openai` | `GET {api}/models` | `POST {api}/chat/completions` SSE, `stream_options.include_usage` | `Authorization: Bearer` |
| `anthropic` | `GET {api}/models` | `POST {api}/messages` SSE, `max_tokens` required | `x-api-key`, `anthropic-version: 2023-06-01` |
| `lmstudio` | `GET /api/v0/models` (type, state, ctx, caps) → fallback `/api/v1/models` | native `POST /api/v1/chat` (stateful `previous_response_id`) | optional Bearer |

`openai` works out of the box for LM Studio's `/v1`, OpenRouter, Groq, Together, DeepSeek, xAI,
Mistral, Ollama (`:11434/v1`), vLLM, LiteLLM, MiMo, Gemini's OpenAI endpoint and any custom server.
Native Gemini needs its own adapter later; until then use OpenRouter or the Gemini OpenAI endpoint.
URL rule: for `openai`, append `/v1` only when the base has no path. For `anthropic`, append `/v1`
unless the base already ends with it (SDK convention: `https://api.anthropic.com`, `…/anthropic`).

## Data model
- Provider `{id, name, kind, baseUrl, apiKeySecret?, enabled?}`. `id` is `[a-z0-9-]{1,32}`.
  `apiKeySecret` names a secret in the plugin's own bucket and defaults to `<id>_api_key`.
- Preset `{id, name, provider?, model?, temperature?, maxTokens?, systemPrompt?, params?}`. This
  extends the existing preset shape, so old presets resolve exactly as before.
- Model ids: the `lmstudio` provider keeps bare ids. Every other provider uses `provider::model`,
  because `/` and `:` already appear inside model ids. Bare ids route to `lmstudio`, or to
  `defaultProvider` when it is absent, so `last-model.json`, authored prompts and preset bindings
  keep working. The picker shows models grouped per provider (`ModelInfo.group`) with badges
  (context, vision, tools) when the API reports them.
- Sources: you can declare providers and presets in `config.yaml`. Those are read-only in the view.
  The view and agent verbs add, edit and remove entries in a state file owned by the plugin,
  `~/.codeterm/plugins/lmstudio/router.json`, resolved with `host.fs.expandHome` so DEV stays in
  `~/.codeterm-dev`. The host gives plugins no API to write settings.

## Plugin id: keep `lmstudio`
Everything below is keyed by plugin id, and a plugin cannot read another plugin's bucket, so a new
`router` id would strand all of it:
- the install directory and `config.yaml`
- the secret bucket
- `grants.yaml`, including `--allow-host` grants
- `codeterm agent spawn lmstudio`
- the channel entry and the files under `last-model`

So the id stays `lmstudio` and `displayName` becomes "Domios Router". Migration happens on read:
legacy `baseUrl`/`model` become the implicit `lmstudio` provider. No step is needed from the user.

## Secrets
Keys live only in the plugin secret bucket:
- **View:** a masked field sends the key to `setProviderKey`, which calls `host.secretSet`. The
  call returns `{ok}` only.
- **Agents:** `printf %s KEY | codeterm plugin config lmstudio --secret <slot>`. The host accepts
  `--secret` only for schema-declared `api_key` fields, so the schema declares well-known slots
  (`openai_api_key`, `anthropic_api_key`, …, `custom1..4_api_key`) and a provider can point
  `apiKeySecret` at any slot.

Keys are never written to settings, `router.json`, transcripts, errors or logs. Status shows only
set/unset. Remote hosts still need `codeterm plugin settings lmstudio --allow-host host[:port]`,
because the allowlist is exact. The UI and verbs show that command when a fetch is denied.

## Prompt caching and usage
- **Anthropic:** add `cache_control: {type: "ephemeral"}` to the system block and to the last block
  before the newest user turn. That is 2 breakpoints, under the API maximum of 4. The pure
  function `cacheBreakpoints()` places them.
- **OpenAI-compatible:** caching is automatic on the provider side; the adapter sends nothing extra.
- **Usage:** both formats normalize to `{input, cachedInput, cacheWrite, output}`. Each reply
  appends a compact usage line (cached vs fresh input). There is no local response cache.

## Agent verbs (`agentVerbs`, `agent_commands`)
`providers`, `add-provider <id> <kind> <baseUrl> [name] [--key-slot S]`, `remove-provider <id>`,
`models [provider] [query]`, `presets`, `add-preset <id> <provider::model> [--temperature N]
[--max-tokens N] [--system TEXT]`, `remove-preset <id>`.

## Live check (Xiaomi MiMo token plan, built plugin.js with a real-HTTP host shim)
`openai` listed 8 models and `mimo-v2.6-pro` replied "OK". The `anthropic` endpoint
has no `/v1/models` (it returns 404), so providers accept `models: [...]` as a
fallback list. `mimo-v2.6-pro` replied "OK" over `/anthropic/v1/messages`. For a
4,015-token system prompt the second request reported `cache_read_input_tokens:
3968`; `cache_creation_input_tokens` is not reported.

