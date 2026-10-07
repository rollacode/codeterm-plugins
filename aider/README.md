# Aider

Optional Aider CLI provider for Domios Chat UI, installed from the `codeterm-plugins` channel. Requires CodeTerm 1.12.4 or later and an `aider` executable on PATH (`pipx install aider-chat`).

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

Chat preserves fenced code, combines multiline user headings, hides thinking and tool chatter, and retains readable API errors. Applied edits, dry-run edit notices and commits appear as compact system rows after the answer. Permission prompts are reported only when the final nonempty screen line contains an unanswered question. Delta reads reconstruct context through `host.fs.readFileHead`, retaining stable byte-based identities across split turns. This reparses prior history on each delta; long sessions can cost more than line-oriented transcripts. No mutable parser state is shared between tabs or readers.

The `classifyTabState` hook reports Aider's fixed spinner/repo-map markers and response output after a submitted input as `working`, and active permission prompts as `clarifying_question`. At an idle composer it returns no verdict: the current SDK has no idle classifier variant and no cursor geometry, so core owns idle through the declared prompt-line composer capability. This hook supplies provider evidence; the current core reactor does not map a working verdict into the displayed live activity state. Chat's `Loading chat…` attachment state is also owned by core and overrides live activity in the footer.

Build and verify from the canonical checkout:

```bash
node scripts/build-plugin.mjs aider
node aider/plugin.test.cjs
npm run typecheck
npm run check:icons
```

Focused tests load the built QuickJS-compatible bundle with a mock host and use no network or sleeps.
