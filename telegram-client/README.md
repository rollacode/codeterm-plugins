# Telegram Client

Telegram Client connects CodeTerm to the owner’s Telegram account through the pinned [`gotd/cli`](https://github.com/gotd/cli) v0.11.0 release. It supports account selection, chat listing, bounded recent history, resolved previews, and an owner-gated send path.

## Install the pinned helper

From the `codeterm-plugins` checkout, run:

```sh
node telegram-client/scripts/install-tg.cjs
```

The installer maps the current OS and architecture to a v0.11.0 release asset, checks the archive against the pinned SHA-256 digest, extracts only the `tg` executable, and writes it under `~/.codeterm/telegram-client/bin/`. It does not build source, invoke a shell installer, or install globally. Unsupported combinations and checksum failures are named and recorded for the plugin health view.

Supported release combinations are macOS amd64/arm64, Linux amd64/arm64/riscv64, and Windows amd64/arm64.

After that, the Orchestrator starts CodeTerm dev and confirms its health on port `7686`, then installs and discovers the plugin there:

```sh
curl -s http://127.0.0.1:7686/api/health
codeterm plugin install --from-dir /Users/rollacode/Developer/codeterm-plugins/telegram-client
codeterm plugin get telegram-client
```

## Sign in

For guided setup, use the plugin page header's **Configure with AI** button. The agent asks for an API ID and API hash created for your own Telegram application at [my.telegram.org](https://my.telegram.org), then stores each from stdin with `printf '%s' "<API_ID>" | codeterm plugin config telegram-client --secret api_id` and `printf '%s' "<API_HASH>" | codeterm plugin config telegram-client --secret api_hash`. These are secret fields; do not use `--set` for them, and the stored API hash is never returned in command output. Run `codeterm plugin telegram-client login`; the result includes `qrPayload` and `tgLink` so the agent can show a scannable QR and link in chat. Scan it in Telegram under **Settings → Devices → Link Desktop Device**. Poll `codeterm plugin telegram-client login-status`, then confirm with `health` and `accounts`. The Telegram Client view remains an alternative for entering credentials and scanning the QR. The view lists configured accounts and marks the currently selected sender; **Use sender** changes the default account used by agents. If the Telegram account uses two-step verification, the optional password field passes it to the login process through `TG_PASSWORD` and does not store it.

The release binary identifies itself as **Telegram Desktop (Windows)** in Telegram’s Devices list. This is the `gotd/cli` device profile, including on macOS. The plugin does not build a custom binary or inject credentials into build flags. It passes the owner’s API ID and hash to `tg init` or `tg accounts add` through `APP_ID` and `APP_HASH` in `ExecOpts.env`; neither value is an argument.

The YAML configuration `gotd.cli.yaml` is stored in the plugin-owned runtime directory. POSIX file and directory modes are used where the host supports them. Windows file modes do not represent ACLs; this plugin relies on the per-user plugin data directory and does not inspect or change its ACL. `tg` persists `app_hash` in that YAML file. The exact config path is declared in `credentials[]`, which revokes direct `host.fs` reads; the host credential reader accepts JSON only, so it cannot parse this YAML and substitute `app_hash` into a process. `tg` reads the config as its subprocess. The file remains plaintext on disk, so this is a residual exposure to the owner’s local account and backups. It is proportionate for this slice because `app_hash` identifies the Telegram application; it does not grant access to the owner’s account or replace the MTProto session. The plugin keeps the file outside the repository and shared `~/.config`, does not return it to agents or logs, and removes it on logout. The temporary QR login log is also kept inside the plugin runtime directory and removed after successful login or logout.

On macOS, `tg` stores the MTProto session in the login Keychain by default. Existing file sessions are migrated on first use; the plugin leaves `keychain` at its default enabled setting. On Linux, `tg` stores a dynamically named plaintext JSON session file beside the config, with POSIX mode `0600`. On Windows, `tg` stores a plaintext session file in the plugin runtime directory; this plugin does not inspect or set a Windows ACL, so it makes no ACL protection claim. The filename seed depends on the owner’s API ID, so it cannot be declared accurately in the static manifest. No guessed or wildcard session credential is declared. The plugin runtime can read files under its own declared runtime directory, including this session file. Health identifies non-macOS storage as `plugin-owned plaintext file`.

## Agent commands

| Verb | Behavior |
| --- | --- |
| `login` | Start QR login using credentials in the plugin secret store and return the QR payload and `tg://` authorization link. |
| `login-status` | Poll the active login and return any available QR payload and authorization link with completion state. |
| `accounts` | List account labels and session presence. |
| `use <account-id>` | Select a configured account label as the sender. |
| `chats` | List conversations using immutable numeric IDs such as `id:12345`; display labels are separate fields. |
| `history <chat-id> [n]` | Read up to 50 recent messages for a selected immutable ID, bounded by a 32 KiB serialized response. The default count and byte cap are in Settings. |
| `health` | Report install, account, and session-storage state, including whether the session is in Keychain or a file. |
| `logout` | Log out configured accounts where possible, remove local session and peer-cache files, remove the YAML config, and clear API credentials from the host secret store. |
| `preview <chat-id> <text>` | Resolve and return the sender account id and visible identity, destination id and label, exact text, and current policy state. It writes no attempt and issues no send. Display names are refused where an immutable id is required. |
| `send <chat-id> [--key <idempotency-key>] <text>` | Send only when the owner has explicitly enabled the Saved-Messages-only policy in the view. A policy is absent by default. |

Message bodies are returned as untrusted text. They are not interpreted as instructions, sent elsewhere, or exported to `codeterm mem`.

## Send gate and delivery records

The view starts with sending locked. The owner must preview a destination first. The view displays the exact resolved sender, immutable destination id, destination label, and message text. Only after that review can the owner explicitly enable the initial policy, which permits that sender's Telegram Saved Messages id only. The policy is persisted in `send-policy.json` inside this plugin's own runtime data directory. There is no implicit allow policy.

Before `tg send` starts, the plugin writes a `pending` record to `outbox.json` in the same plugin-owned directory. The record contains an idempotency key, resolved sender and destination, SHA-256 payload hash, state, timestamps, and send count; it does not store message text. A caller may provide `--key`; otherwise the default key uses the nonce from a fresh view preview and is bound to the resolved sender in the record. Reusing a key already in `sent` returns the saved result without another `tg send` command.

The ledger uses `pending`, `sent`, `rate_limited`, `failed`, and `unknown` states. A rate limit records the wait time Telegram returned and refuses an invocation made before its deadline. The owner or agent must invoke send again after the deadline; the plugin does not wait or retry on a timer. A definitive rejection is recorded as `failed` and can be retried only by a later explicit invocation. A lost response or interrupted pending attempt becomes `unknown` and that key is never retried automatically. Inspect Saved Messages before choosing whether to take any manual action.

Delivery guarantee: the local ledger prevents this plugin from issuing another send for a key already recorded as `sent`, and refuses automatic retry for `unknown`. The pinned `tg send` command returns a server `message_id` after confirmation but does not expose a stable caller-supplied MTProto random id for retries, so this plugin cannot use one to resolve a lost response. Telegram's MTProto send flow does not give this plugin an exactly-once delivery guarantee. If Telegram accepts a message but the confirmation is lost before `sent` is persisted, the outcome remains `unknown` and requires manual inspection.

Failures use named actionable states: `not-logged-in`, `reauth-needed`, `policy-not-set`, `destination-not-permitted`, `rate-limited`, `upstream-rejected`, and `unknown`. The same latest state is shown in the view and glance status.

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

The Orchestrator runs the source-only gates above after merging. The Worker does not run a real send. The owner reviews the resolved preview, explicitly enables Saved-Messages-only policy, authorizes the specific test, and verifies the one live message and one `sent` ledger record from the owner's own account.
