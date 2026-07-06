# LM Studio

A CodeTerm **chatBackend** plugin that turns a pane into an open agent shell
backed by a local [LM Studio](https://lmstudio.ai) model. The shell uses LM
Studio native v1 chat, streams partial tokens, shows the active system prompt as
the first message, and can run validated CodeTerm tool calls parsed by the host.

LM Studio's local server is the model backend; this plugin connects to it via
permission-gated host APIs.

The plugin also supports **context engines** and **interaction modes**:

| Engine | Mode | Use |
|---|---|---|
| `chat` (default) | `interactive` | Today's rolling chat pane with optional bounded window |
| `machine` | `interactive` | State-machine queries: charter + state + user query → verdict JSON |
| `machine` | `watcher` | Read-only orchestration health watcher (host tick loop) |

## Setup

1. Open LM Studio, load a model, and start its server (Developer -> Start Server).
   The default endpoint is `http://localhost:1234`.
2. Configure the plugin if your server differs from the default. See
   [`config.yaml`](./config.yaml), which documents the default preset shape.
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

- `baseUrl`: server base URL, default `http://localhost:1234`.
- `model`: fallback model id; blank lets LM Studio use the loaded model.
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

The plugin may only reach hosts in `plugin.json` -> `permissions.network.allow`
(defaults: `localhost:1234`, `127.0.0.1:1234`). Point `baseUrl` elsewhere and add
that `host:port` to the allowlist.

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
