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

Local typechecking expects the canonical CodeTerm checkout beside this repository
at `../codeterm`, which supplies `packages/plugin-sdk` and `packages/chat-engine`.
If `tsc` cannot resolve either package, verify that sibling checkout and rerun
`npm ci`; stale installs created against the retired `../codeterm-canvas` path
must not be reused.

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

### Releasing a plugin

The production marketplace channel reads the repository's default `main`
branch. A plugin committed only to a feature or lane branch is not released.

1. Build the plugin with `node scripts/build-plugin.mjs <id>` and run its
   focused tests plus `npm run typecheck`.
2. Set the same new version in `<id>/package.json`, `<id>/plugin.json`, and the
   matching `channel.json` entry. Commit the generated logic and UI bundles.
3. Merge the reviewed lane into `main` with ancestry preserved, push `main`,
   and verify the remote default-branch SHA. Do not publish from a side branch.
4. Run `codeterm plugin channel refresh codeterm-plugins`, inspect
   `codeterm plugin channel diff codeterm-plugins`, then install or update the
   plugin. Verify the installed `.codeterm-install.json` and `plugin.json`
   report the new version and the `codeterm-plugins` channel source.
5. Delete an integrated lane only after its tip is proven to be an ancestor of
   `main`. Do not leave release branches as alternate marketplace heads.
