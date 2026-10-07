# Aider

Optional Aider CLI provider for Domios Chat UI, installed from the `codeterm-plugins` channel. Requires CodeTerm 1.12.4 or later and an `aider` executable on PATH (`pipx install aider-chat`).

In the plugin settings:

- `apiBase`: OpenAI-compatible API base URL, exported as `OPENAI_API_BASE`.
- `apiKeySecret`: name of a Domios secret containing the API key. The launch shell fetches it at runtime into `OPENAI_API_KEY`.
- `configPath`: optional Aider YAML configuration file, passed as `--config`.

For MiMo, set `apiBase` to `https://api.xiaomimimo.com/v1`, store your key in a Domios secret, set `apiKeySecret` to that secret's name, and choose `openai/mimo-v2.6-pro` in the spawn model picker. You can use `configPath` for additional Aider model settings. The model catalogue also accepts free-form Aider model IDs.

Each tab records history in `<cwd>/.aider/history/<CODETERM_SESSION_BINDING_NONCE>.md` with a separate `.input` file. Startup gitignore and documentation dialogs use the provider's onboarding capability. Readiness uses the prompt line and a 5000 ms input fallback.

Chat parses Aider's markdown transcript, preserving fenced code, combining multiline user headings, hiding thinking blocks and tool chatter, and retaining readable API errors. Delta reads reconstruct the prefix through `host.fs.readFileHead` so split turns retain their role and stable byte-based identity. This reparses the history prefix on each delta; very long sessions can cost more than line-oriented transcripts. No mutable parser state is shared between tabs or readers.

Build and verify from the canonical checkout:

```bash
node scripts/build-plugin.mjs aider
node aider/plugin.test.cjs
npm run typecheck
npm run check:icons
```

The focused tests load the built QuickJS-compatible bundle with a mock host; they use no network or sleeps.
