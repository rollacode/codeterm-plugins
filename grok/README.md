# Grok

Optional CodeTerm agent provider for the [xAI Grok CLI](https://x.ai/cli). Not a core plugin: install from the `codeterm-plugins` marketplace.

Install the CLI first:

```bash
# macOS / Linux
curl -fsSL https://x.ai/cli/install.sh | bash

# Windows
irm https://x.ai/cli/install.ps1 | iex
```

Then `grok login`. CodeTerm launches `grok --always-approve` so tool prompts do not block an agent tab.

Role and identity instructions append to Grok's own system prompt through the
declared `cli_flag` capability (`--rules`). In this host contract, launch
`task` contains the composed system instructions; `starterPrompt: no_starter`
opens an empty chat without submitting a turn. Startup handshakes are never
prepended to a task. Assigned work remains in the system instructions and only
the host-selected starter is passed after `--`. Resume reapplies instructions
with the same append-only behavior.

For Windows commands above 6,000 characters, the plugin writes the instructions
to a host-owned temporary Markdown agent definition and passes its path with
`--agent`. Explicit `promptMode: extend` retains Grok's base system template and
appends the body verbatim, avoiding Windows argument limits. See the official
[agent definition contract](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-agent/README.md).

Sessions live under `~/.grok/sessions/<percent-encoded-cwd>/<uuid>/` (`summary.json`, `chat_history.jsonl`, `usage.json`). Live PIDs are in `~/.grok/active_sessions.json`. Models come from `grok models`; the cache enriches only those live ids with metadata. When the CLI is unavailable, the host retains the manifest seed as an offline fallback and warns instead of refusing a requested model against a stale list.

Domios 1.14.2 pre-trusts the canonical launch cwd through the host-owned `directoryTrustRecord` declaration in `~/.grok/trusted_folders.toml`. Existing folder entries remain intact. Grok Build 1.0.50 exposes no `--trust` flag. The plugin also declares the directory prompt and its safe `y` choice for the authorized launch fallback.

Build from a plugin worktree with `node scripts/build-plugin.mjs grok`, then run `node --test grok/plugin.test.cjs`. The SDK dependency must point to a CodeTerm checkout that exports `recordedTextDiff`. If bundling reports a missing `@codeterm/plugin-sdk` module or export, correct that worktree's SDK dependency before rebuilding; an older checkout cannot supply the current Grok parser dependency.

Silent CLI updates check the official `@xai-official/grok` npm release catalogue, select the newest stable version in `cliCompatibility.supported`, and run `grok update --version <target>`. The supported range begins at the verified 1.0.50 CLI and stops before 1.1.0; unsupported newer releases never become update targets.
