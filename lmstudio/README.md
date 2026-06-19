# LM Studio

A CodeTerm **chatBackend** plugin that turns a pane into an open agent shell
backed by a local [LM Studio](https://lmstudio.ai) model. The shell uses LM
Studio native v1 chat, streams partial tokens, shows the active system prompt as
the first message, and can run validated CodeTerm tool calls parsed by the host.

LM Studio's local server is the model backend; this plugin connects to it via
permission-gated host APIs.

## Setup

1. Open LM Studio, load a model, and start its server (Developer -> Start Server).
   The default endpoint is `http://localhost:1234`.
2. Configure the plugin if your server differs from the default. See
   [`config.yaml`](./config.yaml), which documents the default preset shape.
3. Open a chatBackend pane for this plugin, or spawn it as a shell when the host
   exposes chatBackend providers through `codeterm agent spawn`.

## Configuration

Config lives in [`config.yaml`](./config.yaml):

- `baseUrl`: server base URL, default `http://localhost:1234`.
- `model`: fallback model id; blank lets LM Studio use the loaded model.
- `defaultPreset`: preset id when the chosen model has no bound preset and the
  session does not request one explicitly.
- `presets`: array of `{ id, name, systemPrompt?, model?, params? }`. A preset
  with `model` binds to that exact model id.

Preset resolution at session init is: chosen model's bound preset, then
`ctx.preset`, then `defaultPreset`. A bound preset's `systemPrompt` and `params`
apply automatically for that model. If a preset has no `systemPrompt`, the
default preset prompt is used. For unbound models, `ctx.systemPrompt` can still
override the resolved preset prompt for that session. The prompt is emitted as
the first `system_prompt` message so the UI can render it as an observable card.

The plugin may only reach hosts in `plugin.json` -> `permissions.network.allow`
(defaults: `localhost:1234`, `127.0.0.1:1234`). Point `baseUrl` elsewhere and add
that `host:port` to the allowlist.

## How It Works

- `openSession` resolves the model-bound/requested/default preset and stores
  system prompt, model, params, and LM Studio stateful continuation id for the
  pane.
- `sendMessage` appends the user turn and starts a native `POST /api/v1/chat`
  streaming job through `host.fetchStream`.
- `pump` polls stream chunks, re-emits the growing assistant message with a
  stable id, passes completed assistant text to `host.toolcall.parse` with the
  curated schema, emits a structured `tool_call`, executes the selected host
  tool, appends `tool_result`, and continues until the parser returns `null`.
- LM Studio continuation uses `previous_response_id` from the previous
  `response_id`. If no continuation id is available, the plugin resends assembled
  visible context as `input`.
- `listModels` maps `GET /api/v1/models` into the model picker.

Tool rounds are capped at 8 per user turn.

The curated `exec` and `codeterm` tools run commands through `sh -lc`; the host
still gates that subprocess path through this plugin's manifest grant. The
manifest also lists `codeterm` in `subprocess.allow` for readability, but the
current implementation invokes it through `sh`, so that direct `codeterm` grant
is redundant.

## Develop

```sh
node scripts/build-plugin.mjs lmstudio
node lmstudio/plugin.test.cjs
npx tsc --noEmit
```
