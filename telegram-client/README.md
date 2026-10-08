# Telegram Client

Telegram Client connects CodeTerm to the owner’s Telegram account through the pinned [`gotd/cli`](https://github.com/gotd/cli) v0.11.0 release. It supports account selection, chat listing, bounded recent history, message text search, resolved previews, and an owner-gated path for sending messages and files.

## Install the pinned helper

The plugin keeps everything in one runtime directory: the host's per-instance plugin data directory, `~/.codeterm/telegram-client` on a production install and `~/.codeterm-dev/telegram-client` (or `~/.codeterm-dev-<name>/telegram-client`) on a dev instance. `codeterm plugin telegram-client health` reports it as `runtimeDir`; while tg is missing it also returns the exact `installCommand`:

```sh
node "<data dir>/plugins/telegram-client/scripts/install-tg.cjs" --root "<runtimeDir>"
```

Run from an installed plugin bundle, the installer derives the same root without `--root`; from a source checkout, `--root` is required. It maps the current OS and architecture to a v0.11.0 release asset, checks the archive against the pinned SHA-256 digest, extracts only the `tg` executable, and writes it under `<runtimeDir>/bin/`. It does not build source, invoke a shell installer, or install globally. Unsupported combinations and checksum failures are named and recorded for the plugin health view.

Supported release combinations are macOS amd64/arm64, Linux amd64/arm64/riscv64, and Windows amd64/arm64.

## Sign in

Use the plugin page header's **Configure with AI** button. The helper agent works in its chat: it installs the pinned helper with the `installCommand` from `health` when needed, asks you in chat for an API ID and API hash created for your own Telegram application at [my.telegram.org](https://my.telegram.org), and stores each from stdin with `printf '%s' "<API_ID>" | codeterm plugin config telegram-client --secret api_id` and `printf '%s' "<API_HASH>" | codeterm plugin config telegram-client --secret api_hash`. These are secret fields; `--set` is not used for them, and the stored API hash is never returned in command output. `codeterm plugin telegram-client login` returns `qrSvg`, a QR image the plugin generates locally from `qrPayload` without any network call, plus `tgLink`; the agent renders the QR in chat and prints the link. Scan it in Telegram under **Settings → Devices → Link Desktop Device**. The agent polls `login-status` (re-rendering a rotated QR) and confirms with `health` and `accounts`. If the account has two-step verification, `login-status` returns state `password-required` with `next: ask-password`; the agent asks for the cloud password in chat and submits it with `printf '%s' '<PASSWORD>' | codeterm plugin config telegram-client --secret login_password && codeterm plugin telegram-client login-password`. That verb reads the one-shot secret, deletes it at once, and passes it to tg only through `TG_PASSWORD`; it never appears in arguments, logs, or files. A password typed in chat stays in the provider's session history, so the private alternative is the Telegram Client view, which shows a masked field for the same step and never stores it. Any other prompt tg stops on after the QR is reported as `input-required` with its `step`. The view reflects setup done by the agent: runtime installed, API ID set, API hash stored (never their values), and the signed-in account with a masked phone number. The view lists configured accounts and marks the currently selected sender; **Use sender** changes the default account used by agents.

The release binary identifies itself as **Telegram Desktop (Windows)** in Telegram’s Devices list. This is the `gotd/cli` device profile, including on macOS. The plugin does not build a custom binary or inject credentials into build flags. It passes the owner’s API ID and hash to `tg init` or `tg accounts add` through `APP_ID` and `APP_HASH` in `ExecOpts.env`; neither value is an argument.

The YAML configuration `gotd.cli.yaml` is stored in the plugin-owned runtime directory. POSIX file and directory modes are used where the host supports them. Windows file modes do not represent ACLs; this plugin relies on the per-user plugin data directory and does not inspect or change its ACL. `tg` persists `app_hash` in that YAML file. The exact config path is declared in `credentials[]`, which revokes direct `host.fs` reads; the host credential reader accepts JSON only, so it cannot parse this YAML and substitute `app_hash` into a process. `tg` reads the config as its subprocess. The file remains plaintext on disk, so this is a residual exposure to the owner’s local account and backups. It is proportionate for this slice because `app_hash` identifies the Telegram application; it does not grant access to the owner’s account or replace the MTProto session. The plugin keeps the file outside the repository and shared `~/.config`, does not return it to agents or logs, and removes it on logout. The temporary QR login log is also kept inside the plugin runtime directory and removed after successful login or logout. Running `login` again while a QR login is pending cancels it: the plugin closes the pending job through the host job API, deletes its log, and starts a fresh login with a new QR, so a stale QR is never shown. Each login job writes its own `login-<label>.<id>.log`. On hosts whose job close does not stop the process, the cancelled `tg` can keep waiting until it exits on its own; it can no longer surface a QR. The login job carries a 15-minute timeout so a host that waits on detached jobs does not stop it early.

On macOS, `tg` stores the MTProto session in the login Keychain by default. Existing file sessions are migrated on first use; the plugin leaves `keychain` at its default enabled setting. On Linux, `tg` stores a dynamically named plaintext JSON session file beside the config, with POSIX mode `0600`. On Windows, `tg` stores a plaintext session file in the plugin runtime directory; this plugin does not inspect or set a Windows ACL, so it makes no ACL protection claim. The filename seed depends on the owner’s API ID, so it cannot be declared accurately in the static manifest. No guessed or wildcard session credential is declared. The plugin runtime can read files under its own declared runtime directory, including this session file. Health identifies non-macOS storage as `plugin-owned plaintext file`.

## Agent commands

| Verb | Behavior |
| --- | --- |
| `login` | Start QR login using credentials in the plugin secret store and return `qrSvg`, `qrPayload`, and the `tg://` authorization link. |
| `login-status` | Poll the active login and return any available `qrSvg`, QR payload, and authorization link with completion state. |
| `login-password` | Submit the two-step verification password from the one-shot `login_password` secret (stdin only), then continue the login. |
| `accounts` | List account labels and session presence. |
| `use <account-id>` | Select a configured account label as the sender. |
| `chats [query]` | List the 100 most recent conversations (users, groups, channels) with immutable ids such as `id:12345`, title, type, and @username. With a query (name or @username), return the single `match`, or `ambiguous: true` with `candidates` when several chats fit. |
| `history <chat-id> [n]` | Read up to 50 recent messages for a selected immutable ID, bounded by a 32 KiB serialized response. The default count and byte cap are in Settings. |
| `health` | Report install, account, and session-storage state, including whether the session is in Keychain or a file. |
| `logout` | Log out configured accounts where possible, remove local session and peer-cache files, remove the YAML config, and clear API credentials from the host secret store. |
| `preview <chat-id> <text>` | Optional dry run: resolve the sender, the recipient (title, type, @username), and the exact text, and say whether the owner's restriction would allow it. It writes no attempt and issues no send. |
| `send <chat-id> [--key <idempotency-key>] [--format plain|html|markdown] [--] <text>` | Send to any chat the signed-in account can write to and return the Telegram server `telegramMessageId`. The sender's own id sends to Saved Messages. |
| `send-file <chat-id-or-name> <absolute-file-path> [--message <caption>] [--key <idempotency-key>] [--format plain|html]` | Upload one file into an existing chat with an optional caption and return `telegramMessageId`, or `status: uploading` while a longer upload runs. `me` targets Saved Messages. |
| `send-file-status <key>` | Read back a file send: `uploading`, `sent` with `telegramMessageId`, or its named failure. |
| `search-messages <query> [--chat <chat-id-or-name>] [--limit N]` | Search message text with Telegram's server-side search, across all chats or in one chat. Each hit has `chat`, `sender`, `time` (ISO), `date`, `snippet`, `messageId`, and `out`. `chats [query]` stays the chat and person lookup. |

`send-to` is an alias of `send`. Plain is the default and preserves literal tags and Markdown characters. Put flags before the body; `--` starts a literal body that begins with a flag.

```sh
codeterm plugin telegram-client send id:12345 --key html-greeting-1 --format html -- '<b>Аня, привет! 👋</b> <i>Тестируем HTML-оформление через Domios.</i>'
```

HTML uses the pinned client's native `tg send --html` parser; the plugin never computes entity offsets. Parse failures return `invalid-markup:` followed by the client's exact error and are recorded as failed. Validation follows that parser: unsupported tags are ignored and unclosed tags can be tolerated. The pinned v0.11.0 client has no Markdown parse mode, so `--format markdown` returns `invalid-request` before invoking tg and sends nothing. Native Markdown and stricter malformed-markup validation require an upstream client change. A retry key is bound to the format as well as the chat and text; changing format requires a new key.

## Files

`send-file` uploads through the pinned client's `tg upload --peer <id> [--message=<caption>] [--html] -- <path>`, the same command the client documents for sending a file to a chat; the plugin never reads the file into its own process beyond a one-byte readability probe, and never logs or stores its contents, name in the ledger, or caption. The chat argument may be an immutable id, a name or @username that matches exactly one of the 100 most recent dialogs, or `me`; an ambiguous name returns the candidates and uploads nothing.

Before any upload or ledger write the plugin checks the path is absolute, is one regular file (a directory is refused because `tg upload` would send every file under it), is not empty, is no larger than **Maximum file size** (`fileMaxMiB`, default 50 MiB, up to Telegram's 2000 MiB), and can be opened. Failures are `invalid-request`, `file-not-found`, `file-too-large`, or `file-unreadable`. A plugin installed as a user drop-in in a production CodeTerm may only inspect its own folders, so a file elsewhere is reported as `file-not-found` there; a dev instance and first-party plugins are not confined.

A file send uses the same restriction, ledger, and idempotency rules as `send`. The key binds the chat argument, path, caption, and format; the ledger records `kind: "file"` and the byte size. The host bounds a plugin's awaited process at five seconds, so the upload runs as a background `tg` job with a timeout scaled to the file size (60 s plus 1 s per 256 KiB, at most 30 minutes). If it finishes at once, `send-file` returns `sent`; otherwise it returns `status: uploading` and `send-file-status <key>` (or re-running `send-file` with the same key) reads the result back. `health` and the view also record a finished upload. If the plugin reloads while an upload is running, or the result is not read within five minutes of completion, the attempt becomes `unknown` and is never re-uploaded automatically.

## Message search

`search-messages` maps to the pinned client's `tg search`: with `--chat` it is `messages.search` in that chat (`tg search --limit N -- <id> <query>`), and without it `messages.searchGlobal` (`tg search --global --limit N -- <query>`). Results are capped at 50 hits and a 32 KiB response with `truncated: true` when cut, and each snippet is at most 240 characters around the first matching word.

The pinned v0.11.0 global search output carries one `peer` for the whole result, taken from the first hit, and per-hit `from` only; it does not say which chat each other hit is in. Global results therefore set `chatAttribution: "partial"`: the first hit has its chat and the rest have `chat: null`, with the sender where Telegram reports one. A `--chat` search attributes every hit. Full global attribution needs an upstream change that adds each message's `peer_id` to `tg search --global` JSON (one field on its message item, set from the message's own peer) and a pin bump; the plugin already reads a per-hit `peer` when present.

Message bodies are returned as untrusted text. They are not interpreted as instructions, sent elsewhere, or exported to `codeterm mem`.

## Sending and delivery records

Sending works like a normal Telegram client acting for the owner: the agent resolves a chat with `chats <name>`, then sends to its immutable id. No setup or approval is needed.

The view has an optional **Restrict agent sends** setting, off by default. With "Only these chats" selected, an agent `send` to any chat outside the list returns `chat-not-allowed` naming the setting; sends the owner makes from the view are never restricted. The setting lives in `send-scope.json` in the plugin data directory and can only be changed from the view. A missing file means all chats; a file that cannot be read restricts the agent to no chats until the owner saves the setting again.

Before `tg send` starts, the plugin writes a `pending` record to `outbox.json` in the same plugin-owned directory. The record contains an idempotency key, resolved sender and destination, SHA-256 payload hash, state, timestamps, and send count; it does not store message text. A caller should provide `--key`; otherwise the key is the nonce of a matching earlier preview, or a fresh key that is returned in the result. Reusing a key already in `sent` returns the saved result without another `tg send` command.

The ledger uses `pending`, `sent`, `rate_limited`, `failed`, and `unknown` states. A rate limit records the wait time Telegram returned and refuses an invocation made before its deadline. The owner or agent must invoke send again after the deadline; the plugin does not wait or retry on a timer. A definitive rejection is recorded as `failed` and can be retried only by a later explicit invocation. A lost response or interrupted pending attempt becomes `unknown` and that key is never retried automatically. Inspect the chat before choosing whether to take any manual action.

Delivery guarantee: the local ledger prevents this plugin from issuing another send for a key already recorded as `sent`, and refuses automatic retry for `unknown`. The pinned `tg send` command returns a server `message_id` after confirmation but does not expose a stable caller-supplied MTProto random id for retries, so this plugin cannot use one to resolve a lost response. Telegram's MTProto send flow does not give this plugin an exactly-once delivery guarantee. If Telegram accepts a message but the confirmation is lost before `sent` is persisted, or `tg` reports success without a server message id, the outcome remains `unknown` and requires manual inspection.

Failures use named actionable states: `invalid-request`, `not-logged-in`, `reauth-needed`, `chat-not-found`, `chat-not-allowed`, `rate-limited`, `upstream-rejected`, and `unknown`. The same latest state is shown in the view and glance status.

Lifecycle states have direct next steps: `not-installed` runs the installer; `unsupported-platform` identifies the missing release; `checksum-mismatch` refuses the archive; `installed-but-not-configured` opens the sign-in form; `logged-out` asks for a new sign-in; `logged-in` shows the resolved account; `reauth-needed` asks the owner to sign in again; and `upgrade-available` points to the pinned installer.

## Source-only QA handoff

The Worker authors source and tests only. The Orchestrator runs these in the canonical checkout after merge, one project gate at a time:

```sh
npx tsc --noEmit
node scripts/build-plugin.mjs telegram-client
codeterm plugin validate /Users/rollacode/Developer/codeterm-plugins/telegram-client
npx tsx telegram-client/plugin.test.cjs
npm test
wc -l telegram-client/src/*.ts telegram-client/ui/src/*.tsx
grep -rnE 'setTimeout|sleep\(|thread::sleep' telegram-client/src telegram-client/ui/src telegram-client/plugin.test.cjs
git status --short
git -C /Users/rollacode/Developer/codeterm status --short
```

Install and discovery are run by the Orchestrator against dev (`7686`) only, after starting dev and confirming `curl -s http://127.0.0.1:7686/api/health`:

```sh
codeterm plugin install --from-dir /Users/rollacode/Developer/codeterm-plugins/telegram-client
codeterm plugin get telegram-client
```

The Orchestrator runs the source-only gates above after merging. The Worker does not run a real send. The owner authorizes the specific live test and verifies the one live message and one `sent` ledger record from the owner's own account.
