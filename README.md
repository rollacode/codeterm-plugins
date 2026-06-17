# CodeTerm Plugins

Marketplace plugin channel for [CodeTerm](https://github.com/rollacode/codeterm).
This channel is pre-registered out of the box — its plugins show up under
**Extensions → Marketplace** ready to install (nothing is installed by default).

- **git** — branch/working-tree status bubble, glance popover, and a full Git view
- **transcriber** — speech-to-text backend (local engine or mesh peer)
- **bitwarden** — secret backend via the `bw` CLI, glance + connection view

## Authoring

Plugins are written in TypeScript against the published, type-only
[`@codeterm/plugin-sdk`](https://www.npmjs.com/package/@codeterm/plugin-sdk).
Each `<id>/src/plugin.ts` is the logic half (runs in a confined QuickJS VM,
talks to the host only through the injected `host.*` API); `<id>/ui/src/` is the
optional view half (a React app rendered in the host's sandboxed iframe via
`window.ct`).

```bash
npm install
npm run build:all          # build git, bitwarden, transcriber
npm run build git          # build a single plugin
npm run typecheck          # tsc --noEmit across all plugin sources
npm test                   # plugin-side parser tests (via tsx)
```

`scripts/build-plugin.mjs` (esbuild) compiles each plugin in one pass:

- **logic** → `<id>/plugin.js`: CJS, `target: es2020`, `platform: neutral` so it
  loads in QuickJS (no `console`/`fetch`/timers — stay on `host.*`). The loader
  reads `module.exports.default`.
- **ui** (if `<id>/ui/src/main.tsx` exists) → a split, cacheable bundle:
  content-hashed `ui/app-<hash>.js` + a tiny `ui/index.html` that loads it. The
  `__CT_NONCE__` placeholders are swapped per-load by the host's view route.

## Channel

`channel.json` is the manifest CodeTerm reads when the channel is added. Keep
each entry's `version` in sync with the plugin's `plugin.json`. CodeTerm seeds
this channel automatically (register-only) from `github.com/rollacode/codeterm-plugins`.
