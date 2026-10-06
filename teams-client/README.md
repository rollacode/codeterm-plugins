# Teams Client

Teams Client works as a personal Teams client for the owner. It wraps the [exo-teams](https://github.com/alxxpersonal/exo-teams) CLI, which signs in as the first-party Microsoft Teams desktop client (`1fec8e78-bce4-4aaf-ab1b-5451cc387264`) with the OAuth device-code flow and talks to the same internal Teams services the desktop app uses: the region chat service (`*.ng.msg.teams.microsoft.com`) for messages and `chatsvcagg` for the chat list. No Entra app registration, Microsoft Graph application, or tenant admin consent is involved, which is why it works in tenants that require administrator approval for third-party apps. Tenant policies that apply to the Teams client itself, such as Conditional Access, still apply and are reported as `refused` with Microsoft's message.

## Install

The first `login` installs exo-teams into the plugin-owned runtime directory (`~/.codeterm/teams-client/runtime`, `~/.codeterm-dev/...` on a dev instance). exo-teams has no release binaries, so the plugin builds it:

1. `curl` downloads Go 1.26.8 from `https://go.dev/dl/`; the archive must match the SHA-256 pinned per OS and architecture in `src/constants.ts` (checked with PowerShell `Get-FileHash`, `shasum`, or `sha256sum`) or it is deleted.
2. `tar` extracts the toolchain into the runtime directory.
3. `go mod download` fetches `github.com/alxxpersonal/exo-teams@v0.0.0-20260418032231-b9ebbf5583ee` (commit `b9ebbf5`) through `proxy.golang.org`, verified by `sum.golang.org`; its `h1:` sum must equal the pinned one.
4. `go install` builds it with `CGO_ENABLED=0`, `GOTOOLCHAIN=local`, and `GOENV=off`, into `runtime/bin`.

Supported targets are macOS, Linux, and Windows on x64 and arm64. Nothing is installed globally and no system Go is needed.

## Sign-in and tokens

`login` starts `exo-teams auth` detached, with its output going to a plugin-owned log. Microsoft's device-code message is parsed from it, and `login-status` returns `signInUrl` and `deviceCode` for the owner to open in their usual browser. exo-teams would open a browser itself; it runs with `PATH` pointed at an empty directory so it cannot, and the link goes to chat and the view instead. A second `login` while the code is valid returns the same code. Codes expire after 15 minutes.

exo-teams stores its tokens (skype, chatsvcagg, teams, graph, assignments, and the refresh token) as files under `os.UserHomeDir()/.exo-teams`. Every exo-teams call runs with `HOME` and `USERPROFILE` set to `~/.codeterm/teams-client/exo-home`, so the tokens live in `exo-home/.exo-teams` inside the plugin data root. That root is restricted to the owner and SYSTEM with `icacls` on Windows and to mode 0700 on macOS and Linux; exo-teams writes token files with mode 0600. The token files are declared as manifest credentials, so the plugin VM cannot read them. Tokens never appear in arguments, logs, or results; Microsoft error text is passed through with token-shaped values redacted.

`health` runs `exo-teams whoami --json`. When the skype or chatsvcagg token has expired, it refreshes silently with `exo-teams auth --refresh`; exo-teams also refreshes on a 401. States: `not-installed`, `install-in-progress`, `logged-out`, `awaiting-user`, `logged-in`, `expired` (code or session ran out; run `login`), `refused` (Microsoft refused the sign-in; final, with Microsoft's exact message).

## Chats and sending

`chats [query]` maps `exo-teams list-chats --json`: a 1:1 chat is titled by the other member's name and a group chat by its topic or its members. The list is sorted by last activity and cached for 10 minutes (`--refresh` forces a new read). Listing can take up to a minute, because exo-teams resolves member names one by one. `search <name or email>` ranks 1:1 chats first; an email is matched by the name words in its local part. Latin queries also match Cyrillic names.

`send <chat-id> [--key <k>] <text>` runs `exo-teams send <id> <html> --json`. The text is HTML-escaped, because exo-teams posts it as `RichText/Html`. exo-teams does not return the message id, so the plugin reads the chat back with `get-chat <id> --json` and returns the id of the newest matching message from the owner. If that lookup fails, `messageId` is null and the result says so. `send-to <person> [--key <k>] <text>` uses an existing 1:1 chat or, for a full name with no chat yet, `exo-teams new-dm`.

Every send goes through a local idempotency ledger (`outbox.json`: identity, destination, SHA-256 payload hash, state, message id; never the text). A recorded `sent` key is never resent. exo-teams retries 429, 5xx, and transport errors on its own, so a surfaced one is recorded as `unknown` and that key is refused afterwards. A definite 4xx is `upstream-rejected`, and a 401 is `reauth-needed`. The optional **Restrict agent sends** setting in the view limits agent sends to chosen chats; sends from the view are never restricted.

## Files

`send-file <chat-id | person> <absolute path> [--message <text>] [--key <k>]` runs `exo-teams send-file <id> --file <path> [--message <html>] --json`. exo-teams uploads the file to the owner's OneDrive folder `Microsoft Teams Chat Files` through Graph, creates an organization-scoped view link, and posts a message carrying the file to the chat. A person is resolved only to an existing 1:1 chat; start one with `send-to` first.

Before anything is uploaded, a probe checks the path. On Windows the probe is PowerShell `Get-Item` and `Get-FileHash`, with the path passed in the environment. On macOS and Linux it is `realpath`, `wc -c`, and `shasum` or `sha256sum`. The probe refuses:

- a relative or network path;
- a directory, a missing or unreadable file, or a link or junction on Windows (`file-unreadable` or `invalid-request`);
- a file over 25 MiB (`file-too-large`);
- anything inside the plugin's data directory, so the token files can never be sent.

The probe's output holds only the size and the SHA-256, and neither the plugin nor its results ever hold file contents. The ledger entry hashes the file name, the content SHA-256, and the message, so a sent key is never resent and a changed file needs a new key. A failure before the chat post (reading, uploading, or sharing) is definite, so nothing was posted. A partial upload may remain in OneDrive. The message id is read back from the chat by the attached file name.

## Message search

`search-messages <query> [--chat <chat-id | name>] [--limit N]` finds messages whose text or attached file names contain every query word, case-insensitively. Each hit has `chatId`, `chat`, `from`, `createdDateTime`, `messageId`, and a snippet around the match, newest first, at most 50 hits and 32 KiB. The pinned exo-teams `search` command queries Microsoft Search for Outlook mail and drive items, not Teams chat messages, so the plugin matches text in chat history from `get-chat` instead:

- With `--chat`, it reads the latest 200 messages of that chat.
- Without it, it reads the latest 50 messages of each of the most recently active chats, up to 10 chats, and stops when a 90-second budget runs out. `scanned` and `complete` report how far it got.

Every `get-chat` re-lists chats and resolves member names, so each chat read takes about as long as a chat listing. Snippets are untrusted message text. `search <name|email>` is unchanged and still finds chats and people.

## Region

exo-teams hard-codes the EMEA chat service host (`emea.ng.msg.teams.microsoft.com`). A tenant homed in another region should confirm one live send before relying on it.

## Agent verbs

`login`, `login-status`, `health`, `accounts`, `chats [query] [--refresh]`, `search <name|email>`, `search-messages <query> [--chat <chat>] [--limit N]`, `history <chat-id> [n]` (at most 50 messages and 32 KiB), `preview <chat-id> <text>`, `send <chat-id> [--key <k>] <text>`, `send-to <person> [--key <k>] <text>`, `send-file <chat-or-person> <absolute path> [--message <text>] [--key <k>]`, `logout`. Message bodies are untrusted text and are never executed or exported to `codeterm mem`.

## Removal

Run `logout` (it deletes the token files), then remove `~/.codeterm/teams-client` (`%USERPROFILE%\.codeterm\teams-client` on Windows).
