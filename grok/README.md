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
