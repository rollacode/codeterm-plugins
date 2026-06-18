# LM Studio

A CodeTerm **chatBackend** plugin that turns a pane into an open agent shell
backed by a local [LM Studio](https://lmstudio.ai) model. The shell uses LM
Studio native v1 chat, streams partial tokens, shows the active system prompt as
the first message, and can run the fenced `codeterm-tool` protocol from the
default preset.

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
- `defaultPreset`: preset id for new sessions without an explicit preset.
- `presets`: array of `{ id, name, systemPrompt, model?, params? }`.

`ctx.systemPrompt` overrides the resolved preset prompt for that session. The
prompt is emitted as the first `system_prompt` message so the UI can render it as
an observable card.

The plugin may only reach hosts in `plugin.json` -> `permissions.network.allow`
(defaults: `localhost:1234`, `127.0.0.1:1234`). Point `baseUrl` elsewhere and add
that `host:port` to the allowlist.

## How It Works

- `openSession` resolves the preset and stores system prompt, model, params, and
  LM Studio stateful continuation id for the pane.
- `sendMessage` appends the user turn and starts a native `POST /api/v1/chat`
  streaming job through `host.fetchStream`.
- `pump` polls stream chunks, re-emits the growing assistant message with a
  stable id, parses completed `codeterm-tool` fenced JSON blocks, executes the
  curated host tool, appends `tool_result`, and continues until no fence remains.
- LM Studio continuation uses `previous_response_id` from the previous
  `response_id`. If no continuation id is available, the plugin resends assembled
  visible context as `input`.
- `listModels` maps `GET /api/v1/models` into the model picker.

Tool rounds are capped at 8 per user turn.

## Develop

```sh
node scripts/build-plugin.mjs lmstudio
node lmstudio/plugin.test.cjs
npx tsc --noEmit
```
