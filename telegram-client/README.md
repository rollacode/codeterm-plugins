# Telegram Client

Telegram Client connects CodeTerm to the owner’s Telegram account through the pinned [`gotd/cli`](https://github.com/gotd/cli) v0.11.0 release. It supports account selection, chat listing, and bounded recent history. Sending and preview are refused in this slice.

## Install the pinned helper

From the `codeterm-plugins` checkout, run:

```sh
node telegram-client/scripts/install-tg.cjs
```

The installer maps the current OS and architecture to a v0.11.0 release asset, checks the archive against the pinned SHA-256 digest, extracts only the `tg` executable, and writes it under `~/.local/share/codeterm-plugins/telegram-client/bin/`. It does not build source, invoke a shell installer, or install globally. Unsupported combinations and checksum failures are named and recorded for the plugin health view.

Supported release combinations are macOS amd64/arm64, Linux amd64/arm64/riscv64, and Windows amd64/arm64.

After that, the Orchestrator installs and discovers the plugin on the CodeTerm dev daemon:

```sh
codeterm plugin install --from-dir /Users/rollacode/Developer/codeterm-plugins/telegram-client
codeterm plugin get telegram-client
```

## Sign in

Open the Telegram Client view. Enter an API ID and API hash created for your own Telegram application at [my.telegram.org](https://my.telegram.org), choose an account label, and confirm the device identity. The view starts QR login and shows the `tg` output when you press **Refresh login progress**. Scan the QR in Telegram under **Settings → Devices → Link Desktop Device**. The view lists configured accounts and marks the currently selected sender; **Use sender** changes the default account used by agents. If the Telegram account uses two-step verification, the optional password field passes it to the login process through `TG_PASSWORD` and does not store it.

The release binary identifies itself as **Telegram Desktop (Windows)** in Telegram’s Devices list. This is the `gotd/cli` device profile, including on macOS. The plugin does not build a custom binary or inject credentials into build flags. It passes the owner’s API ID and hash to `tg init` or `tg accounts add` through `APP_ID` and `APP_HASH` in `ExecOpts.env`; neither value is an argument.

The YAML configuration `gotd.cli.yaml` is stored at the plugin-owned runtime path with mode `0600`, and its parent directory is mode `0700`. `tg` persists `app_hash` in that YAML file. The exact config path is declared in `credentials[]`, which revokes direct `host.fs` reads; the host credential reader accepts JSON only, so it cannot parse this YAML and substitute `app_hash` into a process. `tg` reads the config as its subprocess. The file remains plaintext on disk, so this is a residual exposure to the owner’s local account and backups. It is proportionate for this slice because `app_hash` identifies the Telegram application; it does not grant access to the owner’s account or replace the MTProto session. The plugin keeps the file outside the repository and shared `~/.config`, does not return it to agents or logs, and removes it on logout. The temporary QR login log is also kept inside the mode-`0700` runtime directory and removed after successful login or logout.

On macOS, `tg` stores the MTProto session in the login Keychain by default. Existing file sessions are migrated on first use; the plugin leaves `keychain` at its default enabled setting. On other platforms, `tg` stores the session in a dynamically named plaintext JSON file beside the config, with mode `0600`. The filename seed depends on the owner’s API ID, so it cannot be declared accurately in the static manifest. No guessed or wildcard session credential is declared. The plugin runtime can read files under its own declared runtime directory, including this session file. This weaker non-macOS guarantee is accepted for the owner’s macOS target and is visible in `health` as `plugin-owned plaintext file`.

## Agent commands

| Verb | Behavior |
| --- | --- |
| `accounts` | List account labels and session presence. |
| `use <account-id>` | Select a configured account label as the sender. |
| `chats` | List conversations using immutable numeric IDs such as `id:12345`; display labels are separate fields. |
| `history <chat-id> [n]` | Read up to 50 recent messages for a selected immutable ID, bounded by a 32 KiB serialized response. The default count and byte cap are in Settings. |
| `health` | Report install, account, and session-storage state, including whether the session is in Keychain or a file. |
| `logout` | Log out configured accounts where possible, remove local session and peer-cache files, remove the YAML config, and clear API credentials from the host secret store. |
| `send` / `preview` | Return an error stating that the send path is not enabled in this slice. |

Message bodies are returned as untrusted text. They are not interpreted as instructions, sent elsewhere, or exported to `codeterm mem`.

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
git status --short
git -C /Users/rollacode/Developer/codeterm status --short
```

Install and discovery are run by the Orchestrator against dev (`7686`) only, after starting dev and confirming `curl -s http://127.0.0.1:7686/api/health`:

```sh
codeterm plugin install --from-dir /Users/rollacode/Developer/codeterm-plugins/telegram-client
codeterm plugin get telegram-client
```

The owner completes a real login, verifies the resolved account and one selected conversation against the Telegram client, then confirms logout removed the session and config. The Worker does not perform login or send messages.
