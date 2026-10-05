import type { GlanceView, PluginModule, ViewNode } from "@codeterm/plugin-sdk";

const VERSION = "11.11.0";
const PACKAGE = "@pnp/cli-microsoft365";
const CLIENT_ID = "1fec8e78-bce4-4aaf-ab1b-5451cc387264";
const ROOT = "~/.local/share/codeterm-plugins/teams-client";
const MAX_COUNT = 50;
const MAX_BYTES = 32 * 1024;
const SEND_DISABLED = "The send path is not enabled in this slice.";
const PERSONAL_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const SRI = "sha512-GXdN3Cw4lOEFixVfI6YZlGM9OzAlMbjGItT8yMn8FznlG6+aWGNI6xjgNJRbigykeSE6YI3KRai+fijMt24DMg==";
const INTEGRITY_BY_TARGET: Record<string, string> = {
  "darwin/arm64": SRI,
  "darwin/x64": SRI,
  "linux/arm64": SRI,
  "linux/x64": SRI,
  "win32/arm64": SRI,
  "win32/x64": SRI,
};
const METADATA_READER = "const path=require('node:path');const {pathToFileURL}=require('node:url');const authFile=path.resolve(process.env.M365_RUNTIME,'node_modules/@pnp/cli-microsoft365/dist/Auth.js');import(pathToFileURL(authFile).href).then(async m=>{const a=m.default;await a.restoreAuth();const c=a.connection||{};const expiry=c.accessTokens&&c.accessTokens['https://graph.microsoft.com']&&c.accessTokens['https://graph.microsoft.com'].expiresOn;const all=await a.getAllConnections();const project=x=>({name:x.name||null,accountId:x.identityId||x.name||null,identityId:x.identityId||null,tenantId:x.identityTenantId||null,upn:x.identityName||null});process.stdout.write(JSON.stringify({active:c.active?project(c):null,expiresOn:expiry?String(expiry):null,connections:all.map(project)}));}).catch(()=>process.stdout.write(JSON.stringify({active:null,expiresOn:null,connections:[]})));";

type Paths = { root: string; home: string; runtime: string; binary: string; npmCache: string; msal: string; current: string; all: string };
type RunResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string; stderr: string; code?: number };
type Target = { platform: string; arch: string; node: string; npm: string; m365: string; integrity: string };
type StateResult = { state: string; message: string; accountId?: string | null; upn?: string | null; tenantId?: string | null; expiresOn?: string | null; accounts?: any[] };

const loginJobs: Record<string, boolean> = {};

function joinPath(...parts: string[]): string {
  return host.path.normalize(parts.join("/"));
}

function nativePath(path: string): string {
  return host.path.toNative(host.path.normalize(path));
}

function paths(): Paths | null {
  try {
    const expanded = host.fs.expandHome(ROOT);
    if (!expanded) return null;
    const root = host.path.normalize(expanded);
    const home = joinPath(root, "m365-home");
    const runtime = joinPath(root, "runtime/m365");
    return {
      root,
      home,
      runtime,
      binary: joinPath(runtime, "node_modules/.bin", binaryNamesForHost().m365),
      npmCache: joinPath(root, "npm-cache"),
      msal: joinPath(home, ".cli-m365-msal.json"),
      current: joinPath(home, ".cli-m365-connection.json"),
      all: joinPath(home, ".cli-m365-all-connections.json"),
    };
  } catch {
    return null;
  }
}

function hostPlatform(): string {
  if (host.path.isWindows) return "win32";
  try { return String(host.platform() || "").toLowerCase(); } catch { return ""; }
}

function binaryNames(platform: string): { node: string; npm: string; m365: string; icacls: string; whoami: string } {
  if (platform === "win32") return { node: "node.exe", npm: "npm.cmd", m365: "m365.cmd", icacls: "icacls.exe", whoami: "whoami.exe" };
  return { node: "node", npm: "npm", m365: "m365", icacls: "icacls.exe", whoami: "whoami.exe" };
}

function binaryNamesForHost(): { node: string; npm: string; m365: string; icacls: string; whoami: string } {
  return binaryNames(hostPlatform());
}

function resolveTarget(platform: string, arch: string): Target | { error: string; message: string } {
  const key = `${platform}/${arch}`;
  const integrity = INTEGRITY_BY_TARGET[key];
  if (!integrity) return { error: "unsupported-platform", message: `Pinned m365 ${VERSION} does not support ${key}. Supported targets are macOS, Linux, and Windows on x64 or arm64.` };
  const names = binaryNames(platform);
  return { platform, arch, node: names.node, npm: names.npm, m365: names.m365, integrity };
}

function envFor(p: Paths): Record<string, string> {
  const home = nativePath(p.home);
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: nativePath(joinPath(p.home, "AppData/Roaming")),
    LOCALAPPDATA: nativePath(joinPath(p.home, "AppData/Local")),
    XDG_CONFIG_HOME: nativePath(joinPath(p.home, ".config")),
    XDG_CACHE_HOME: nativePath(joinPath(p.home, ".cache")),
    NPM_CONFIG_CACHE: nativePath(p.npmCache),
    M365_RUNTIME: nativePath(p.runtime),
  };
}

function runProcess(bin: string, args: string[], env: Record<string, string>): RunResult {
  let started: { jobId?: string; error?: string };
  try { started = host.exec.start({ bin, args, env }); }
  catch (error) { return { ok: false, error: String(error), stderr: "" }; }
  if (!started.jobId) return { ok: false, error: started.error || `Could not start ${bin}.`, stderr: "" };
  let result: { done: boolean; code?: number; stdout?: string; stderr?: string; error?: string };
  try { result = host.awaitJob(started.jobId, (value) => value); }
  catch (error) { return { ok: false, error: String(error), stderr: "" }; }
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (result.error) return { ok: false, error: String(result.error), stderr, code: result.code };
  if (!result.done) return { ok: false, error: `${bin} did not finish.`, stderr, code: result.code };
  if (result.code !== 0) return { ok: false, error: stderr || stdout || `${bin} exited ${result.code}.`, stderr, code: result.code };
  return { ok: true, stdout, stderr };
}

function parseJson<T = any>(value: string): T | null {
  try { return JSON.parse(value) as T; } catch { return null; }
}

function runtimeInfo(p: Paths): { platform: string; arch: string; version: string; target: Target } | { state: string; message: string } {
  const platform = hostPlatform();
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    return { state: "unsupported-platform", message: `No pinned m365 runtime is available for ${platform || "this operating system"}. Supported targets are macOS, Linux, and Windows on x64 or arm64.` };
  }
  const names = binaryNames(platform);
  const probe = runProcess(names.node, ["-p", "process.platform+'/'+process.arch+'/'+process.versions.node"], envFor(p));
  if (!probe.ok) return { state: "not-installed", message: "Install Node.js 20 or later with npm, then return and sign in again." };
  const pieces = probe.stdout.trim().split("/");
  if (pieces.length !== 3) return { state: "install-failed", message: "Could not read the local Node.js platform and architecture." };
  const runtimePlatform = String(pieces[0]).toLowerCase();
  const actualPlatform = host.path.isWindows ? "win32" : runtimePlatform;
  const arch = String(pieces[1]).toLowerCase();
  const version = String(pieces[2]);
  if (runtimePlatform !== platform) return { state: "install-failed", message: `The local Node.js runtime reports ${runtimePlatform}, but CodeTerm reports ${platform}. Install a matching Node.js runtime and retry.` };
  const target = resolveTarget(actualPlatform, arch);
  if ("error" in target) return { state: target.error, message: target.message };
  const major = Number(version.split(".")[0]);
  if (!Number.isInteger(major) || major < 20) return { state: "not-installed", message: `Node.js ${version} is too old for the pinned m365 CLI. Install Node.js 20 or later and retry.` };
  return { platform: actualPlatform, arch, version, target };
}

function protectStorage(p: Paths): { error?: string; message?: string } {
  for (const dir of [p.root, p.home, p.runtime, p.npmCache]) {
    try { if (!host.fs.makeDirs(dir)) return { error: "storage-protection-failed", message: "Could not create the plugin-owned private runtime directory." }; }
    catch { return { error: "storage-protection-failed", message: "Could not create the plugin-owned private runtime directory." }; }
  }
  if (host.path.isWindows) {
    const names = binaryNamesForHost();
    const env = envFor(p);
    const who = runProcess(names.whoami, [], env);
    const principal = who.ok ? who.stdout.trim() : "";
    if (!principal || /[\r\n]/.test(principal)) return { error: "storage-protection-failed", message: "Could not identify the Windows account for the plugin cache ACL." };
    const grant = `${principal}:(OI)(CI)F`;
    const acl = runProcess(names.icacls, [nativePath(p.root), "/inheritance:r", "/grant:r", grant, "*S-1-5-18:(OI)(CI)F", "/T", "/C"], env);
    if (!acl.ok) return { error: "storage-protection-failed", message: "Could not restrict the plugin cache with a Windows ACL. No sign-in was started." };
    return {};
  }
  const env = envFor(p);
  for (const dir of [p.root, p.home, p.runtime, p.npmCache]) {
    const chmod = runProcess("chmod", ["700", nativePath(dir)], env);
    if (!chmod.ok) return { error: "storage-protection-failed", message: "Could not restrict the plugin runtime directory permissions. No sign-in was started." };
  }
  return {};
}

function protectCacheFiles(p: Paths): { error?: string; message?: string } {
  if (host.path.isWindows) return protectStorage(p);
  const env = envFor(p);
  for (const file of [p.msal, p.current, p.all]) {
    if (!host.fs.fileExists(file)) continue;
    const chmod = runProcess("chmod", ["600", nativePath(file)], env);
    if (!chmod.ok) return { error: "storage-protection-failed", message: "Could not restrict an m365 credential cache file." };
  }
  return {};
}

function installM365(): { state: string; message: string } {
  const p = paths();
  if (!p) return { state: "unsupported-platform", message: "The host home directory is unavailable." };
  const protectedState = protectStorage(p);
  if (protectedState.error) return { state: protectedState.error, message: protectedState.message || "Could not secure plugin storage." };
  const info = runtimeInfo(p);
  if ("state" in info) return { state: info.state, message: info.message };
  const npmVersion = runProcess(info.target.npm, ["--version"], envFor(p));
  if (!npmVersion.ok) return { state: "not-installed", message: "Node.js is available, but npm is not. Install npm with Node.js 20 or later, then retry Sign in." };
  const view = runProcess(info.target.npm, ["view", `${PACKAGE}@${VERSION}`, "dist.integrity", "--json"], envFor(p));
  if (!view.ok) return { state: "install-failed", message: "Could not verify the pinned m365 package. Check npm access and try again." };
  const published = parseJson<string>(view.stdout.trim()) || view.stdout.trim().replace(/^['"]|['"]$/g, "");
  if (published !== info.target.integrity) return { state: "install-failed", message: "The pinned m365 package checksum did not match the expected platform checksum; installation was refused." };
  const installed = runProcess(info.target.npm, ["install", "--prefix", nativePath(p.runtime), "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", `${PACKAGE}@${VERSION}`], envFor(p));
  if (!installed.ok) return { state: "install-failed", message: "The pinned m365 package could not be installed into its plugin-owned runtime path. Check npm access and retry." };
  const secured = protectStorage(p);
  if (secured.error) return { state: secured.error, message: secured.message || "Could not secure plugin storage." };
  if (!host.fs.fileExists(p.binary)) return { state: "install-failed", message: `m365 ${VERSION} installed without its ${info.target.m365} executable. Remove the plugin runtime directory and retry.` };
  const installedVersion = runProcess(nativePath(p.binary), ["--version"], envFor(p));
  if (!installedVersion.ok || installedVersion.stdout.trim() !== VERSION) return { state: "install-failed", message: `The installed m365 executable did not report the pinned version ${VERSION}. Remove the plugin runtime directory and retry.` };
  return { state: "installed-not-configured", message: `m365 ${VERSION} is installed for ${info.platform}/${info.arch}. Sign in with the browser to continue.` };
}

function targetState(): { state: string; message: string; paths?: Paths; target?: Target } {
  const p = paths();
  if (!p) return { state: "unsupported-platform", message: "The host home directory is unavailable." };
  const info = runtimeInfo(p);
  if ("state" in info) return { state: info.state, message: info.message, paths: p };
  return { state: "ready", message: "", paths: p, target: info.target };
}

function runM365(args: string[]): RunResult {
  const target = targetState();
  if (!target.paths) return { ok: false, error: target.message, stderr: "" };
  if (target.state !== "ready") return { ok: false, error: target.message, stderr: "" };
  const p = target.paths;
  if (!host.fs.fileExists(p.binary)) return { ok: false, error: "m365 is not installed. Click Sign in in the Teams Client view to install the pinned CLI.", stderr: "" };
  const secured = protectStorage(p);
  if (secured.error) return { ok: false, error: secured.message || "Could not secure the m365 runtime.", stderr: "" };
  const result = runProcess(nativePath(p.binary), args, envFor(p));
  const fileProtection = protectCacheFiles(p);
  if (fileProtection.error) return { ok: false, error: fileProtection.message || "Could not protect m365 cache files.", stderr: "" };
  return result;
}

function authState(text: string): { state: string; message: string } | null {
  const value = String(text || "");
  if (/AADSTS53003|conditional[ -]access|blocked by (?:your )?(?:organization|tenant) policy/i.test(value)) {
    return { state: "conditional-access-blocked", message: "Your organization's Conditional Access policy blocked this sign-in. Ask your IT administrator which browser sign-in policy applies, then try again." };
  }
  if (/AADSTS50076|AADSTS50079|multi[ -]?factor|\bMFA\b|additional authentication is required/i.test(value)) {
    return { state: "mfa-required", message: "Complete the MFA step in the Microsoft browser sign-in, then return to Teams Client and refresh status." };
  }
  if (/AADSTS65001|consent_required|consent (?:was )?not granted|admin consent/i.test(value)) {
    return { state: "consent-not-granted", message: "The requested Microsoft Graph consent is not recorded. If your tenant allows user consent, retry sign-in and approve the prompt; if it restricts user consent, ask a tenant administrator to approve the m365 app's requested permissions." };
  }
  if (/AADSTS50173|refresh token[^\n]*(?:revoked|invalidated)|(?:revoked|invalidated)[^\n]*refresh token/i.test(value)) {
    return { state: "refresh-token-revoked", message: "The Microsoft refresh token was revoked. Use Sign in to create a new browser session." };
  }
  if (/AADSTS700082|AADSTS700084|login has expired|access token expired|token has expired|expired refresh token/i.test(value)) {
    return { state: "token-expired", message: "The Microsoft token expired. Use Sign in to renew the browser session." };
  }
  if (/Can't open the default browser|could not open.*browser|browser instance/i.test(value)) {
    return { state: "browser-open-failed", message: "m365 could not open the default browser. Set a system default browser or start CodeTerm in a desktop session, then retry Sign in." };
  }
  return null;
}

function lifecycleMessage(state: string, detail?: string): string {
  const messages: Record<string, string> = {
    "not-installed": "Node.js 20 or later with npm is required, or the pinned m365 CLI is not installed. Click Sign in to install it, or install Node.js 20+ and npm first.",
    "unsupported-platform": detail || "This operating system and architecture are not supported by the pinned m365 CLI.",
    "install-failed": detail || "The pinned m365 CLI could not be verified or installed. Check npm access and retry Sign in.",
    "installed-not-configured": "The pinned m365 CLI is ready. Sign in with your work or school Microsoft account in the browser.",
    "logged-out": "You are signed out. Click Sign in to start a browser sign-in.",
    "logged-in": "Microsoft Teams is connected.",
    "reauth-needed": "The Microsoft session needs sign-in again. Click Sign in to open the browser.",
  };
  return messages[state] || detail || "Teams Client could not determine its current state.";
}

function credentialPublic(id: string, expectedFile: string, p: Paths): any | null {
  try {
    const manifest = host.manifest() as any;
    const entry = manifest && Array.isArray(manifest.credentials) ? manifest.credentials.find((item: any) => item && item.id === id) : null;
    if (!entry || typeof entry.file !== "string") return null;
    const declared = host.fs.expandHome(entry.file);
    if (!declared || !host.path.equal(declared, expectedFile)) return null;
    return parseJson(host.credentialPublic(id) || "");
  } catch {
    return null;
  }
}

function currentPublic(p: Paths): any | null {
  return credentialPublic("teams-m365-current-connection", p.current, p);
}

function metadataFromM365(p: Paths): any | null {
  const info = runtimeInfo(p);
  if ("state" in info) return null;
  const result = runProcess(info.target.node, ["-e", METADATA_READER], envFor(p));
  if (!result.ok) return null;
  const value = parseJson<any>(result.stdout);
  if (!value || !Array.isArray(value.connections)) return null;
  return value;
}

function accountRows(source: any[]): any[] {
  const rows = Array.isArray(source) ? source : [];
  const seen = new Set<string>();
  return rows.flatMap((raw: any) => {
    const id = String(raw && (raw.id || raw.name || raw.accountId) || "");
    const tenantId = String(raw && raw.tenantId || "");
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      accountId: String(raw && (raw.accountId || raw.identityId) || id),
      identityId: String(raw && raw.identityId || ""),
      tenantId: tenantId || null,
      upn: String(raw && (raw.upn || raw.connectedAs) || ""),
      active: !!(raw && raw.active),
      expiresOn: raw && typeof raw.expiresOn === "string" ? raw.expiresOn : null,
    }];
  });
}

function status(): StateResult {
  const target = targetState();
  if (target.state !== "ready" || !target.paths) return { state: target.state, message: lifecycleMessage(target.state, target.message), accounts: [] };
  const p = target.paths;
  if (!host.fs.fileExists(p.binary)) return { state: "not-installed", message: lifecycleMessage("not-installed"), accounts: [] };
  const protectedState = protectStorage(p);
  if (protectedState.error) return { state: "install-failed", message: protectedState.message || lifecycleMessage("install-failed"), accounts: [] };
  const run = runM365(["status", "--output", "json"]);
  if (!run.ok) {
    const reauth = authState(`${run.error}\n${run.stderr}`);
    if (reauth) return { ...reauth, accounts: [] };
    return { state: "reauth-needed", message: lifecycleMessage("reauth-needed"), accounts: [] };
  }
  const value = parseJson<any>(run.stdout.trim());
  if (!value || !value.connectionName) {
    const listed = runM365(["connection", "list", "--output", "json"]);
    const connections = listed.ok ? parseJson<any[]>(listed.stdout.trim()) : null;
    return connections && connections.length > 0
      ? { state: "logged-out", message: lifecycleMessage("logged-out"), accounts: accountRows(connections) }
      : { state: "installed-not-configured", message: lifecycleMessage("installed-not-configured"), accounts: [] };
  }
  const publicFields = currentPublic(p) || {};
  const metadata = metadataFromM365(p) || {};
  const active = metadata.active || {};
  const expiry = typeof metadata.expiresOn === "string" ? metadata.expiresOn : null;
  const accountId = String(publicFields.accountId || active.accountId || value.connectionName);
  const tenantId = String(publicFields.tenantId || active.tenantId || "");
  const upn = String(publicFields.upn || active.upn || value.connectedAs || "");
  return {
    state: "logged-in",
    message: lifecycleMessage("logged-in"),
    accountId,
    upn,
    tenantId: tenantId || null,
    expiresOn: expiry,
    accounts: [{ id: accountId, accountId, tenantId: tenantId || null, upn, active: true, expiresOn: expiry }],
  };
}

function statusView(): StateResult {
  const value = status();
  if (value.state === "logged-in" && value.upn && value.tenantId && value.expiresOn) {
    return { ...value, message: `Signed in as ${value.upn} in tenant ${value.tenantId}. Token expires ${value.expiresOn}.` };
  }
  if (value.state === "logged-in" && value.upn && value.tenantId) {
    return { ...value, message: `Signed in as ${value.upn} in tenant ${value.tenantId}. Token expiry is not available yet.` };
  }
  return value;
}

function jsonCommand(args: string[]): { data?: any; error?: string; reauth?: { state: string; message: string } } {
  const run = runM365(args.concat(["--output", "json"]));
  if (!run.ok) {
    const auth = authState(`${run.error}\n${run.stderr}`);
    return { error: auth ? auth.message : "The m365 command failed. Refresh status and try again.", reauth: auth || undefined };
  }
  const data = parseJson(run.stdout.trim());
  if (data === null) return { error: "m365 returned an unreadable JSON response." };
  return { data };
}

function agentAccounts(): { result: string } | { error: string } {
  const check = status();
  if (!["logged-in", "logged-out", "installed-not-configured"].includes(check.state)) return { error: check.message };
  const listed = jsonCommand(["connection", "list"]);
  if (listed.error) return { error: listed.error };
  const source = Array.isArray(listed.data) ? listed.data : [];
  const p = paths();
  const metadata = p ? metadataFromM365(p) : null;
  const connections = metadata && Array.isArray(metadata.connections) ? metadata.connections : [];
  const rows = source.flatMap((raw: any) => {
    if (!raw || typeof raw.name !== "string") return [];
    const detail = connections.find((item: any) => item && item.name === raw.name) || {};
    const accountId = String(detail.accountId || raw.name);
    return [{
      id: accountId,
      accountId,
      identityId: String(detail.identityId || ""),
      tenantId: detail.tenantId ? String(detail.tenantId) : null,
      upn: String(detail.upn || raw.connectedAs || ""),
      active: !!raw.active,
      expiresOn: raw.active && metadata && typeof metadata.expiresOn === "string" ? metadata.expiresOn : null,
    }];
  });
  return { result: JSON.stringify({ accounts: accountRows(rows) }) };
}

function useAccount(id: string): { result: string } | { error: string } {
  if (!id || id.length > 256 || /[\r\n\0]/.test(id)) return { error: "Usage: use <account-id>. Select an id from accounts; UPNs are not account ids." };
  const p = paths();
  if (!p) return { error: lifecycleMessage("unsupported-platform") };
  const listed = jsonCommand(["connection", "list"]);
  if (listed.error) return { error: listed.error };
  const source = Array.isArray(listed.data) ? listed.data : [];
  const metadata = metadataFromM365(p);
  const details = metadata && Array.isArray(metadata.connections) ? metadata.connections : [];
  const detail = details.find((raw: any) => raw && (raw.accountId === id || raw.identityId === id || raw.name === id));
  const selected = source.find((raw: any) => raw && raw.name === (detail && detail.name || id));
  if (!selected) return { error: "That account id is not configured. Select an id from accounts." };
  const result = jsonCommand(["connection", "use", "--name", selected.name]);
  if (result.error) return result.reauth ? { error: result.reauth.message } : { error: result.error };
  const current = currentPublic(p) || {};
  const metadata = metadataFromM365(p) || {};
  const active = metadata.active || {};
  return { result: JSON.stringify({ accountId: String(current.accountId || active.accountId || selected.name), tenantId: String(current.tenantId || active.tenantId || ""), upn: String(current.upn || active.upn || selected.connectedAs || "") }) };
}

function sendRefusal(): string {
  const p = paths();
  const publicFields = p ? currentPublic(p) || {} : {};
  const tenantId = String(publicFields.tenantId || "").toLowerCase();
  if (tenantId === PERSONAL_TENANT_ID) {
    return `${SEND_DISABLED} A personal Microsoft account is unsupported on POST /chats/{chat-id}/messages with delegated ChatMessage.Send; this does not mean personal accounts cannot use Teams generally.`;
  }
  return SEND_DISABLED;
}

function validChatId(value: string): boolean {
  return /^[A-Za-z0-9:._@-]{1,512}$/.test(value);
}

function agentChats(): { result: string } | { error: string } {
  const response = jsonCommand(["teams", "chat", "list"]);
  if (response.error) return { error: response.error };
  const source = Array.isArray(response.data) ? response.data : [];
  const chats = source.flatMap((raw: any) => {
    const id = typeof raw?.id === "string" ? raw.id : "";
    if (!validChatId(id)) return [];
    return [{
      id,
      topic: typeof raw.topic === "string" ? raw.topic : null,
      chatType: typeof raw.chatType === "string" ? raw.chatType : null,
      tenantId: typeof raw.tenantId === "string" ? raw.tenantId : null,
      lastUpdatedDateTime: typeof raw.lastUpdatedDateTime === "string" ? raw.lastUpdatedDateTime : null,
    }];
  });
  return { result: JSON.stringify({ chats }) };
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

function textFromHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function cutText(value: string, units: number): string {
  let end = Math.max(0, Math.min(value.length, units));
  if (end > 0 && end < value.length) {
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  }
  return value.slice(0, end);
}

function boundedHistory(chatId: string, source: any[], count: number, maxBytes: number): { chatId: string; messages: any[]; truncated: boolean } {
  const capCount = Math.max(1, Math.min(MAX_COUNT, Math.floor(count)));
  const capBytes = Math.max(1024, Math.min(MAX_BYTES, Math.floor(maxBytes)));
  const ordered = (Array.isArray(source) ? source : []).map((raw: any) => ({
    id: String(raw && raw.id || ""),
    createdDateTime: String(raw && raw.createdDateTime || ""),
    from: String(raw && (raw.from || raw.sender) || ""),
    content: textFromHtml(String(raw && (raw.content || raw.body?.content) || "")),
    untrusted: true,
  })).sort((a: any, b: any) => a.createdDateTime.localeCompare(b.createdDateTime)).slice(-capCount);
  const out: { chatId: string; messages: any[]; truncated: boolean } = { chatId, messages: [], truncated: false };
  for (let i = ordered.length - 1; i >= 0; i--) {
    const message = ordered[i];
    const candidate = [message, ...out.messages];
    if (utf8Bytes(JSON.stringify({ ...out, messages: candidate })) <= capBytes) {
      out.messages = candidate;
      continue;
    }
    out.truncated = true;
    if (out.messages.length > 0) break;
    let low = 0;
    let high = message.content.length;
    let best = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const clipped = { ...message, content: cutText(message.content, middle) };
      if (utf8Bytes(JSON.stringify({ ...out, messages: [clipped] })) <= capBytes) {
        best = clipped.content;
        low = middle + 1;
      } else high = middle - 1;
    }
    const clipped = { ...message, content: best };
    if (utf8Bytes(JSON.stringify({ ...out, messages: [clipped] })) <= capBytes) out.messages = [clipped];
    break;
  }
  if (utf8Bytes(JSON.stringify(out)) > capBytes) return { chatId, messages: [], truncated: true };
  return out;
}

function settings(): { historyCount: number; historyMaxBytes: number } {
  const value = parseJson<any>(host.settingsJson()) || {};
  const count = Number(value.historyCount);
  const bytes = Number(value.historyMaxBytes);
  return {
    historyCount: Number.isInteger(count) ? Math.max(1, Math.min(MAX_COUNT, count)) : 20,
    historyMaxBytes: Number.isInteger(bytes) ? Math.max(1024, Math.min(MAX_BYTES, bytes)) : MAX_BYTES,
  };
}

function agentHistory(args: string[]): { result: string } | { error: string } {
  if (args.length < 1 || args.length > 2 || !validChatId(args[0])) return { error: "Usage: history <immutable-chat-id> [n]. Select an id from chats; display names are not ids." };
  const configured = settings();
  let count = configured.historyCount;
  if (args.length === 2) {
    if (!/^[0-9]{1,3}$/.test(args[1]) || Number(args[1]) < 1) return { error: "History count must be an integer from 1 to 50." };
    count = Math.min(MAX_COUNT, Number(args[1]));
  }
  const listed = jsonCommand(["teams", "chat", "list"]);
  if (listed.error) return { error: listed.error };
  const chats = Array.isArray(listed.data) ? listed.data : [];
  if (!chats.some((chat: any) => chat && chat.id === args[0])) return { error: "That chat id is not in the current chat list. Use an immutable id returned by chats, not a display name." };
  const query = `sort_by(@, &createdDateTime)[-${count}:].{id:id,createdDateTime:createdDateTime,from:from.user.displayName,content:body.content}`;
  const history = jsonCommand(["teams", "chat", "message", "list", "--chatId", args[0], "--query", query]);
  if (history.error) return { error: history.error };
  const result = boundedHistory(args[0], Array.isArray(history.data) ? history.data : [], count, configured.historyMaxBytes);
  return { result: JSON.stringify(result) };
}

function logout(): { result: string } | { error: string } {
  const target = targetState();
  if (target.state !== "ready") return { error: lifecycleMessage(target.state, target.message) };
  const p = target.paths!;
  if (!host.fs.fileExists(p.binary)) return { result: "Logged out. No m365 runtime is installed." };
  const run = runM365(["logout"]);
  if (!run.ok) {
    const reauth = authState(`${run.error}\n${run.stderr}`);
    if (reauth) return { error: reauth.message };
    return { error: "m365 could not clear its plugin-owned session files. The files were kept so logout can be retried." };
  }
  for (const file of [p.msal, p.current, p.all]) {
    if (host.fs.fileExists(file) && !host.fs.removeFile(file)) return { error: "m365 logged out, but a plugin-owned cache file could not be removed. Retry logout." };
  }
  return { result: "Logged out. The plugin-owned m365 token and connection files were removed." };
}

function onAgentCommand(ctx: { sessionId: string; verb: string; args: string[] }): { result: string } | { error: string } {
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  switch (ctx.verb) {
    case "accounts": return agentAccounts();
    case "use": return args.length === 1 ? useAccount(args[0]) : { error: "Usage: use <account-id>." };
    case "chats": return agentChats();
    case "history": return agentHistory(args);
    case "health": return { result: JSON.stringify(statusView()) };
    case "logout": return logout();
    case "send":
      return { error: sendRefusal() };
    case "preview": return { error: SEND_DISABLED };
    default: return { error: `Unknown Teams Client verb: ${ctx.verb}` };
  }
}

function loginStart(): any {
  const p = paths();
  if (!p) return { error: lifecycleMessage("unsupported-platform") };
  const protectedState = protectStorage(p);
  if (protectedState.error) return { error: protectedState.message || lifecycleMessage("install-failed") };
  if (!host.fs.fileExists(p.binary)) {
    const installed = installM365();
    if (installed.state !== "installed-not-configured" && installed.state !== "logged-in") return { error: lifecycleMessage(installed.state, installed.message), state: installed.state };
  }
  const target = targetState();
  if (target.state !== "ready" || !target.paths) return { error: lifecycleMessage(target.state, target.message) };
  const args = ["login", "--authType", "browser", "--appId", CLIENT_ID, "--output", "json"];
  let started: { jobId?: string; error?: string };
  try { started = host.exec.start({ bin: nativePath(target.paths.binary), args, env: envFor(target.paths), detach: true }); }
  catch (error) { return { error: String(error), state: "install-failed" }; }
  if (!started.jobId) return { error: started.error || "m365 browser sign-in did not start.", state: "install-failed" };
  loginJobs[started.jobId] = true;
  return { jobId: started.jobId, state: "login-in-progress", message: "A browser should open for Microsoft sign-in. Complete the work or school sign-in, then click Check sign-in status." };
}

function loginPoll(jobId: string): any {
  if (!jobId || !loginJobs[jobId]) return { error: "Unknown Microsoft sign-in job." };
  let poll: { done: boolean; code?: number; stdout?: string; stderr?: string; error?: string };
  try { poll = host.exec.poll(jobId); }
  catch { return { error: "Could not read the Microsoft browser sign-in job." }; }
  if (!poll.done) return { done: false, state: "login-in-progress", message: "Complete the sign-in in the browser, then check status again." };
  delete loginJobs[jobId];
  const p = paths();
  if (!p) return { done: true, state: "unsupported-platform", error: lifecycleMessage("unsupported-platform") };
  const secured = protectCacheFiles(p);
  if (secured.error) return { done: true, state: "install-failed", error: secured.message || lifecycleMessage("install-failed") };
  if (poll.error || poll.code !== 0) {
    const reason = `${poll.error || ""}\n${poll.stderr || ""}\n${poll.stdout || ""}`;
    const auth = authState(reason);
    return { done: true, state: auth ? auth.state : "reauth-needed", error: auth ? auth.message : lifecycleMessage("reauth-needed") };
  }
  const current = statusView();
  if (current.state !== "logged-in") return { done: true, state: current.state, error: current.message };
  return { done: true, state: "logged-in", account: current, message: current.message };
}

function viewCall(method: string, args: any): unknown {
  const value = args || {};
  if (method === "status") return statusView();
  if (method === "loginStart") return loginStart();
  if (method === "loginPoll") return loginPoll(String(value.jobId || ""));
  if (method === "useAccount") return useAccount(String(value.id || ""));
  if (method === "logout") return logout();
  return { error: `Unknown Teams Client view method: ${method}` };
}

function renderGlance(): GlanceView {
  const p = paths();
  const current = p ? currentPublic(p) : null;
  const account = current || {};
  const installed = !!(p && host.fs.fileExists(p.binary));
  const connected = !!account.accountId;
  const nodes: ViewNode[] = [{ kind: "badge", label: connected ? "Connected" : installed ? "Sign-in needed" : "m365 not installed", tone: connected ? "ok" : installed ? "warn" : "muted" }];
  nodes.push({ kind: "text", text: connected ? `${account.upn || "Account resolved"} · ${account.tenantId || "tenant unavailable"}` : "Open Teams Client to check status or sign in.", style: { tone: "muted" } });
  return { title: "Teams Client", nodes };
}

const plugin: PluginModule = {
  onAgentCommand,
  renderGlance,
  viewCall: viewCall as PluginModule["viewCall"],
  __test_paths: paths,
  __test_platform: hostPlatform,
  __test_binaryNames: binaryNames,
  __test_resolveTarget: resolveTarget,
  __test_integrityByTarget: INTEGRITY_BY_TARGET,
  __test_envFor: envFor,
  __test_authState: authState,
  __test_personalTenantId: PERSONAL_TENANT_ID,
  __test_sendRefusal: sendRefusal,
  __test_lifecycleMessage: lifecycleMessage,
  __test_accountRows: accountRows,
  __test_validChatId: validChatId,
  __test_utf8Bytes: utf8Bytes,
  __test_boundedHistory: boundedHistory,
  __test_status: status,
  __test_jsonCommand: jsonCommand,
  __test_loginStart: loginStart,
  __test_loginPoll: loginPoll,
  __test_logout: logout,
  __test_installM365: installM365,
  __test_agentAccounts: agentAccounts,
  __test_agentChats: agentChats,
  __test_useAccount: useAccount,
  __test_agentHistory: agentHistory,
  __test_credentials: credentialPublic,
  __test_metadataReader: METADATA_READER,
};

export default plugin;
