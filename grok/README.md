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

Sessions live under `~/.grok/sessions/<percent-encoded-cwd>/<uuid>/` (`summary.json`, `chat_history.jsonl`, `usage.json`). Live PIDs are in `~/.grok/active_sessions.json`. Models come from `~/.grok/models_cache.json` (or `grok models`) so the spawn list is whatever the CLI currently has, not only the manifest seed.

Build from a plugin worktree with `node scripts/build-plugin.mjs grok`, then run `node --test grok/plugin.test.cjs`. The SDK dependency must point to a CodeTerm checkout that exports `recordedTextDiff`. If bundling reports a missing `@codeterm/plugin-sdk` module or export, correct that worktree's SDK dependency before rebuilding; an older checkout cannot supply the current Grok parser dependency.
