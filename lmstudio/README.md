# LM Studio

A CodeTerm **chatBackend** plugin: it turns a pane into a chat with a local
[LM Studio](https://lmstudio.ai) model. There's no terminal — you `codeterm send`
a message into the pane and the model's reply appears in the chat view.

LM Studio's own local server **is** the backend; this plugin only *connects* to
it over LM Studio's OpenAI-compatible HTTP API (`POST /v1/chat/completions`,
`GET /v1/models`) via the permission-gated `host.fetch`.

## Setup

1. Open LM Studio, load a model, and start its server (Developer → Start Server).
   The default endpoint is `http://localhost:1234`.
2. Configure the plugin if your server differs from the default — see
   [`config.yaml`](./config.yaml), which documents every field inline. An agent
   can do this for you: "point LM Studio at `http://…`".
3. Open a chatBackend pane for this plugin and send it a message.

## Configuration

Config lives in [`config.yaml`](./config.yaml) (self-documenting, per the
plugin-config design): `baseUrl` (default `http://localhost:1234`) and `model`
(blank = use whatever model LM Studio currently has loaded). The host delivers it
to the plugin as JSON via `host.settingsJson()`.

> The plugin may only reach hosts in `plugin.json` → `permissions.network.allow`
> (defaults: `localhost:1234`, `127.0.0.1:1234`). Point `baseUrl` elsewhere → add
> that `host:port` to the allowlist.

## How it works

- `openSession` registers an in-memory transcript keyed by the pane id.
- `sendMessage` appends the user turn, replays the full conversation to
  `/v1/chat/completions`, and appends the assistant reply (errors surface as
  `system` messages so the transcript never silently stalls).
- `poll(sessionId, cursor)` returns only the messages after `cursor` and a new
  cursor (the message count) — the host merges these into the chat view.
- `listModels` maps `GET /v1/models` into the model picker.

## Develop

```sh
npm run build lmstudio        # esbuild src/plugin.ts → plugin.js (QuickJS-safe)
npx tsx lmstudio/plugin.test.cjs   # unit tests (fake host.fetch)
```
