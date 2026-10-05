# Teams Client

Teams Client uses the pinned `@pnp/cli-microsoft365` v11.11.0 package from a plugin-owned runtime directory and calls its delegated Teams commands. It never installs m365 globally. The package's npm tarball integrity is `sha512-GXdN3Cw4lOEFixVfI6YZlGM9OzAlMbjGItT8yMn8FznlG6+aWGNI6xjgNJRbigykeSE6YI3KRai+fijMt24DMg==`; the same platform-independent package checksum is checked for each supported OS and architecture. Node.js 20 or later and npm must be available. Supported targets are macOS, Linux, and Windows on x64 and arm64.

`osodevops/ms-teams-cli` remains a re-evaluation candidate for a later pass. It was v0.9.0 and too young for the owner's work account when this dependency choice was made.

The runtime and isolated m365 home are under the plugin-owned data root. On macOS and Linux they are `~/.local/share/codeterm-plugins/teams-client/runtime/m365` and `~/.local/share/codeterm-plugins/teams-client/m365-home`. On Windows they are `%USERPROFILE%\.local\share\codeterm-plugins\teams-client\runtime\m365` and `%USERPROFILE%\.local\share\codeterm-plugins\teams-client\m365-home`. Both `HOME` and `USERPROFILE` point to the isolated home on every CLI call, alongside platform-specific config-home variables. This keeps the plugin's sign-in, connections, and tokens separate from the owner's own m365 profile. POSIX directories are restricted to mode 0700 and cache files to 0600. Windows applies an owner and SYSTEM ACL with `icacls`; POSIX modes are not used as a Windows security claim. The resolver and package integrity map cover macOS, Linux, and Windows on x64 and arm64; the npm package is platform-independent, so the verified SRI is the same for all six supported target keys. Other OS/architecture pairs receive a named unsupported-target state.

The installed package source fixes its files under `os.homedir()`. These paths are under the isolated home shown above:

- macOS and Linux: `~/.local/share/codeterm-plugins/teams-client/m365-home/.cli-m365-msal.json`, `.cli-m365-connection.json`, and `.cli-m365-all-connections.json`.
- Windows: `%USERPROFILE%\.local\share\codeterm-plugins\teams-client\m365-home\.cli-m365-msal.json`, `.cli-m365-connection.json`, and `.cli-m365-all-connections.json`.

The pinned MSAL serializer uses named token-type maps and runtime-generated keys. The access-token part of its JSON shape is:

```json
{
  "AccessToken": {
    "<runtime-generated composite key>": {
      "clientId": "<client id>",
      "credentialType": "AccessToken",
      "environment": "<cloud host>",
      "homeAccountId": "<account id>",
      "realm": "<tenant id>",
      "tokenType": "Bearer",
      "target": "<scopes>",
      "secret": "[redacted]"
    }
  }
}
```

That composite key depends on client ID, credential type, environment, home account ID, realm, token type, and target, so no static dotted path reaches its `secret`; D5 resolves to (a). The connection cache separately stores a current connection object with `identityId`, `identityTenantId`, and `accessTokens["https://graph.microsoft.com"] = { expiresOn, accessToken }`. The all-connections cache is an array of connection objects. The dotted resolver cannot address the Graph resource key because its periods are path separators, or records in the all-connections array because it has no array indexing. This implementation therefore makes no direct Graph request and does not inject a bearer header; m365 owns all Graph reads. The three files are declared as credentials without secret mappings so the host denies plugin `readFile` access. `credentialPublic` exposes only `identityId` as the account id, UPN, and tenant id as separate fields. A pinned Node helper asks m365's own `Auth` module for account metadata and emits only expiry and non-secret identity fields; it never emits an access-token value.

The browser sign-in uses the owner's chosen Teams desktop/mobile client ID, `1fec8e78-bce4-4aaf-ab1b-5451cc387264`. [Microsoft Learn lists this ID for Teams desktop/mobile in its tab SSO pre-authorization guidance](https://learn.microsoft.com/en-us/microsoftteams/platform/tabs/how-to/authentication/tab-sso-register-aad); that page does not document using the ID as an arbitrary CLI OAuth client. m365 accepts `--appId` as a CLI option; the plugin creates no Entra app registration. If the tenant permits user consent, the owner can approve the m365 app's requested permissions in the browser; if the tenant restricts user consent, a tenant administrator must approve them. m365 delegates browser opening to the OS launcher on macOS, Linux, and Windows; if it reports that it cannot open the browser, the view asks for a system default browser or a desktop session rather than waiting silently. The owner must confirm the resolved account and tenant, whether a consent prompt appeared, and that the live cache contents match the source-verified paths and composite-key shape.

When a send slice is enabled, the Graph v1.0 `POST /chats/{chat-id}/messages` endpoint requires delegated `ChatMessage.Send` for a work/school account; broader delegated permissions include `Chat.ReadWrite` and `Group.ReadWrite.All`. A personal Microsoft account is unsupported for delegated `ChatMessage.Send` on that endpoint. `Teamwork.Migrate.All` is the Application-type permission for the import flow and requires the target chat to be in migration mode, so it is not a substitute for delegated send. Sending and preview are disabled here and return `{ error }`.

The owner chose the Teams desktop/mobile client ID and browser sign-in route, accepting its first-party client identity. No Entra app registration is created by this plugin.

Agent verbs are `accounts`, `use <account-id>`, `chats`, `history <chat-id> [n]`, `health`, and `logout`. The host grants `agent_commands` after installation. Chat IDs are immutable Graph IDs; history is bounded to 50 messages and 32 KiB. Message bodies are untrusted text and are never executed, routed as provenance, or exported to `codeterm mem`.

To reverse the setup, first use `logout` so m365 clears the token files. On macOS and Linux, run `npm uninstall --prefix "$HOME/.local/share/codeterm-plugins/teams-client/runtime/m365" @pnp/cli-microsoft365`, then remove the plugin-owned data root with `rm -rf "$HOME/.local/share/codeterm-plugins/teams-client"`. In PowerShell on Windows, run `npm uninstall --prefix "$env:USERPROFILE\.local\share\codeterm-plugins\teams-client\runtime\m365" @pnp/cli-microsoft365`, then remove that plugin-owned data root with `Remove-Item -Recurse -Force "$env:USERPROFILE\.local\share\codeterm-plugins\teams-client"`. These commands do not touch the owner's normal m365 profile.
