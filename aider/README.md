# Aider

Optional Aider CLI provider for Domios Chat UI, installed from the `codeterm-plugins` channel. Requires CodeTerm 1.12.4 or later and an `aider` executable on PATH. The installer and updater prefer `uv tool install --force aider-chat==0.86.2`, with `pipx install --force aider-chat==0.86.2` as the alternative. They never upgrade past the supported version.

By default, Domios launches Aider through the bundled Python adapter, pinned to exactly `aider-chat==0.86.2` with runtime symbol/signature checks. It resolves the interpreter from the selected PATH entry point, preserving its virtual environment. Supported launchers: POSIX Python shebangs, pip/distlib and uv shell trampolines (including uv relative paths); Windows uv embedded shebang/PE resources and pip/pipx distlib PE + shebang + ZIP. Unknown launchers or versions refuse launch with a diagnostic. Reinstall the pinned version, or explicitly enable **Plain Aider** (`plainMode: true`) to bypass the adapter. There is no automatic fallback.

Aider remains tool-less in both modes: it cannot run Domios tools. Agent-spawned tool-less tabs are managed by Domios. Only adapter sessions support automatic replies to the sending tab. The adapter writes an `adapter_start` record, then one authoritative outcome after the outermost turn and all file-add reflections, including nested `/ask` and architect/editor coders. Completion records go to `<history>.domios-turns.jsonl`, separate from Chat history. History and sidecar ranges use UTF-8 bytes; the adapter refuses other history encodings. Errors, cancellation, and exhausted reflection limits produce a non-success outcome, never a partial answer relayed as success. Plain sessions report relay unavailable explicitly.

Configure **Endpoints** in the plugin settings. Each endpoint has a name (shown as the model group), provider kind, optional API base URL, Domios API key secret name, and model IDs. Store the API key in Domios Secrets; settings contain only its name. Keep `configPath` for an optional Aider YAML file passed as `--config`.

The model list comes entirely from these endpoints. An empty configuration shows no models and refuses launch with an actionable error. Model IDs must carry their Aider/LiteLLM provider prefix, such as `openai/` or `anthropic/`. Each ID must belong to exactly one endpoint; ambiguous IDs are hidden and cannot launch. If no model is selected explicitly, the first unique configured model is used.

The current settings editor accepts model IDs one per line or as a JSON array of strings in the **Model IDs** text area. Native settings arrays are also accepted. Supported kinds are `openai`, `anthropic`, `groq`, and `openrouter`; an unsupported kind is omitted from the catalogue.

For example, the normalized settings are:

```json
{
  "configPath": "",
  "endpoints": [
    {
      "name": "MiMo",
      "kind": "openai",
      "apiBase": "https://api.xiaomimimo.com/v1",
      "apiKeySecret": "mimo-api-key",
      "models": [{"id": "openai/mimo-v2.6-pro", "mapTokens": 8192}]
    },
    {
      "name": "OpenAI",
      "kind": "openai",
      "apiKeySecret": "openai-api-key",
      "models": ["openai/gpt-5.4-mini"]
    },
    {
      "name": "Anthropic",
      "kind": "anthropic",
      "apiKeySecret": "anthropic-api-key",
      "models": ["anthropic/claude-sonnet-4-6"]
    }
  ]
}
```

Model entries can be plain IDs or objects with per-model tuning. The MiMo example sets `mapTokens` to 8192, a suggested starting value for a large-context model. Any nonnegative integer is accepted; `0` disables the repo map. Omitting `mapTokens` leaves Aider's own default in effect. No model-name heuristic applies a map size automatically.

Declare reasoning only when the model and endpoint accept the corresponding [Aider reasoning flags](https://aider.chat/docs/config/reasoning.html). The MiMo example leaves reasoning undeclared; it does not assume that every OpenAI-compatible endpoint implements effort or token-budget controls. An effort-style declaration looks like:

```json
{
  "id": "openai/your-effort-model",
  "mapTokens": 8192,
  "reasoningMode": "effort",
  "reasoningEfforts": [
    {"id": "low", "displayName": "Low"},
    {"id": "high", "displayName": "High"}
  ],
  "defaultReasoningEffort": "low"
}
```

For a budget-style model, bind the same selector labels to explicit thinking budgets:

```json
{
  "id": "anthropic/your-budget-model",
  "reasoningMode": "budget",
  "reasoningEfforts": [
    {"id": "low", "displayName": "Low", "thinkingTokens": 4096},
    {"id": "high", "displayName": "High", "thinkingTokens": 16384}
  ]
}
```

Replace these example IDs with the exact model IDs your endpoint supports. The per-model catalogue supplies Domios's normal reasoning selector. Core passes the chosen ID through the manifest's launch argument format; the plugin consumes it and emits `--reasoning-effort <id>` for `effort` models or `--thinking-tokens <budget>` for `budget` models. `thinkingTokens` must be a nonnegative integer (`0` can declare an off choice). `defaultReasoningEffort` optionally sets the selector default and must name a declared level. Labels and optional level `description` fields are shown in the picker. A model without a reasoning declaration has no selector. No chosen level means no reasoning flag; an undeclared level or budget is refused instead of sent to Aider. A map size or reasoning declaration on one model never applies to another selected model.

Use the IDs enabled for your API account. For MiMo, add the first endpoint and select its model. For direct OpenAI or Anthropic, add the corresponding endpoint and leave API base empty to use the provider default. To migrate from the former `apiBase` / `apiKeySecret` settings, copy those values into an endpoint, add its model IDs, and select its model. Legacy top-level API settings no longer drive launch.

The selected model determines which endpoint supplies credentials. The shell fetches the key at runtime with `codeterm mem secret get --name`; no secret value enters the launch command or CLI arguments. The plugin exports only that endpoint's provider variables:

| Kind | Key variable | Optional base variable |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | `OPENAI_API_BASE` |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_API_BASE` |
| `groq` | `GROQ_API_KEY` | `GROQ_API_BASE` |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_API_BASE` |

These names follow [LiteLLM's provider dispatch](https://github.com/BerriAI/litellm/blob/main/litellm/main.py) and [OpenRouter configuration](https://github.com/BerriAI/litellm-docs/blob/main/docs/providers/openrouter.md). Use `configPath` for additional Aider settings. Provider changes through Aider's terminal `/model` command do not rerun launch credential selection; open a new tab with the intended model to change endpoints.

Each tab records history in `<cwd>/.aider/history/<CODETERM_SESSION_BINDING_NONCE>.md` with a separate `.input` file. Full access adds `--yes-always`. Startup gitignore and documentation dialogs use the provider's onboarding capability. Readiness uses the prompt line and a 5000 ms input fallback.

When the launch directory contains a readable `AGENTS.md`, the plugin passes it through Aider's `--read` flag. Project instructions stay in read-only context; missing instructions do not block launch. This checks only the launch directory, without walking ancestors or scanning the repository. The repo map exposes symbols rather than complete file contents: ask Aider to name exact paths it needs, and use full access if you want Aider's own add-file confirmations answered automatically. Large repositories benefit from an explicit per-model map budget such as 8192. Aider writes completed answers to its history file, so Chat may lag terminal streaming until the answer completes.

Every launch also passes the installed plugin's `domios-primer.md` through `--read` when readable. Its short rules explain the reduced Aider tab role, messages from other tabs, automatic answer routing and file addition, and evidence-based reviews. The path resolves through the SDK's instance-aware home expansion, including DEV installations; a missing or unreadable primer does not block launch.

For exploration, send `/ask <question>` as a single Chat message. This uses Aider's read-only question mode for that turn, avoiding its edit-format instructions during review. Mention only files needed now: Aider's automatic file addition also recognizes paths in speculative future-work lists, then immediately continues the same turn with those files. Ask it to trace callers and consumers before claiming a runtime consequence; missing TypeScript fields alone do not prove data loss. Use `/code <request>` for edits or configure Aider's `chat-mode` in the optional config file.

Chat preserves fenced code, combines multiline user headings, renders reasoning in the host's collapsed thinking rows, hides routine tool chatter, and retains readable API errors. Applied edits, dry-run edit notices and commits appear as compact system rows after the answer. Permission prompts are reported only when the final nonempty screen line contains an unanswered question. Delta reads reconstruct context through `host.fs.readFileHead`, retaining stable byte-based identities across split turns. This reparses prior history on each delta; long sessions can cost more than line-oriented transcripts. No mutable parser state is shared between tabs or readers.

The `classifyTabState` hook reports Aider's fixed spinner/repo-map markers and response output after a submitted input as `working`, and active permission prompts as `clarifying_question`. At an idle composer it returns no verdict: the current SDK has no idle classifier variant and no cursor geometry, so core owns idle through the declared prompt-line composer capability. This hook supplies provider evidence; the current core reactor does not map a working verdict into the displayed live activity state. Chat's `Loading chat…` attachment state is also owned by core and overrides live activity in the footer.

Build and verify from the canonical checkout:

```bash
node scripts/build-plugin.mjs aider
node aider/plugin.test.cjs
npm run typecheck
npm run check:icons
```

Focused tests load the built QuickJS-compatible bundle with a mock host and use no network or sleeps.
