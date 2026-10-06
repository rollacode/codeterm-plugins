import type { GlanceView, PluginModule, ViewNode } from "@codeterm/plugin-sdk";

const VERSION = "11.11.0";
const PACKAGE = "@pnp/cli-microsoft365";
const CLIENT_ID = "1fec8e78-bce4-4aaf-ab1b-5451cc387264";
const ROOT = "~/.codeterm/teams-client";
const INITIAL_SEND_POLICY_MODE = "single-chat";
const MAX_COUNT = 50;
const MAX_BYTES = 32 * 1024;
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

type Paths = { root: string; home: string; runtime: string; binary: string; npmCache: string; msal: string; current: string; all: string; outbox: string; policy: string };
type RunResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string; stderr: string; code?: number };
type Target = { platform: string; arch: string; node: string; npm: string; m365: string; integrity: string };
type StateResult = { state: string; message: string; accountId?: string | null; upn?: string | null; tenantId?: string | null; expiresOn?: string | null; accounts?: any[] };
type LoginAuthType = "browser" | "deviceCode";
// The pinned Teams client id is refused device-code grants (invalid_grant), so agents use the browser sign-in.
const AGENT_LOGIN_AUTH: LoginAuthType = "browser";
const BROWSER_SIGN_IN_MESSAGE = "A Microsoft sign-in page opened in the default browser. Sign in there with the work or school account, then poll login-status.";
type LoginJob = { stage: "pack" | "install" | "browser"; paths: Paths; target: Target; packagePath?: string; launchComplete?: boolean; authType: LoginAuthType; logFile?: string };

const loginJobs: Record<string, LoginJob> = {};
let activeLoginJobId: string | null = null;
const runtimeInfoCache: Record<string, ReturnType<typeof computeRuntimeInfo>> = {};
const storageProtectionCache: Record<string, { error?: string; message?: string }> = {};
const cacheProtectionCache: Record<string, { error?: string; message?: string }> = {};
const previewTokens: Record<string, any> = {};
let cachedChats: { identityKey: string; chats: any[] } | null = null;
let injectedClock: (() => number) | null = null;
let lastSendState: { state: string; message: string; updatedAt: number } | null = null;

function clearPreviewTokens(): void {
  for (const id of Object.keys(previewTokens)) delete previewTokens[id];
}

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
      outbox: joinPath(root, "outbox.json"),
      policy: joinPath(root, "send-policy.json"),
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
  let result: { code?: number; stdout?: string; stderr?: string; error?: string } | null;
  try { result = parseJson(host.exec(JSON.stringify({ bin, args, env, timeoutMs: 4500 }))); }
  catch (error) { return { ok: false, error: String(error), stderr: "" }; }
  if (!result) return { ok: false, error: `${bin} returned an unreadable process result.`, stderr: "" };
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (result.error) return { ok: false, error: String(result.error), stderr, code: result.code };
  if (result.code !== 0) return { ok: false, error: stderr || stdout || `${bin} exited ${result.code}.`, stderr, code: result.code };
  return { ok: true, stdout, stderr };
}

function parseJson<T = any>(value: string): T | null {
  try { return JSON.parse(value) as T; } catch { return null; }
}

function runtimeInfo(p: Paths): ReturnType<typeof computeRuntimeInfo> {
  if (runtimeInfoCache[p.root]) return runtimeInfoCache[p.root];
  const result = computeRuntimeInfo(p);
  runtimeInfoCache[p.root] = result;
  return result;
}

function computeRuntimeInfo(p: Paths): { platform: string; arch: string; version: string; target: Target } | { state: string; message: string } {
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
  if (storageProtectionCache[p.root]) return storageProtectionCache[p.root];
  const result = applyStorageProtection(p);
  storageProtectionCache[p.root] = result;
  return result;
}

// `m365 --version` prints a banner plus help and can take tens of seconds cold, so read the installed manifest.
function installedPackageVersion(p: Paths): string {
  const manifest = host.fs.readJson(joinPath(p.runtime, `node_modules/${PACKAGE}/package.json`)) as { name?: string; version?: string } | null;
  return manifest?.name === PACKAGE ? String(manifest.version || "") : "";
}

// Restrict only the root, once: `/T` with `/inheritance:r` empties existing files' ACLs, and any walk over
// the installed runtime takes far longer than the exec bound. Files created later inherit the root's ACL.
function windowsAclCommands(root: string, principal: string): string[][] {
  return [[root, "/inheritance:r", "/grant:r", `${principal}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/C"]];
}

const ACL_MARKER = ".acl-restricted";

function applyStorageProtection(p: Paths): { error?: string; message?: string } {
  for (const dir of [p.root, p.home, p.runtime, p.npmCache]) {
    try { if (!host.fs.makeDirs(dir)) return { error: "storage-protection-failed", message: "Could not create the plugin-owned private runtime directory." }; }
    catch { return { error: "storage-protection-failed", message: "Could not create the plugin-owned private runtime directory." }; }
  }
  if (host.path.isWindows) {
    const marker = joinPath(p.root, ACL_MARKER);
    if (host.fs.fileExists(marker)) return {};
    const names = binaryNamesForHost();
    const env = envFor(p);
    const who = runProcess(names.whoami, [], env);
    const principal = who.ok ? who.stdout.trim() : "";
    if (!principal || /[\r\n]/.test(principal)) return { error: "storage-protection-failed", message: "Could not identify the Windows account for the plugin cache ACL." };
    for (const args of windowsAclCommands(nativePath(p.root), principal)) {
      const acl = runProcess(names.icacls, args, env);
      if (!acl.ok) return { error: "storage-protection-failed", message: "Could not restrict the plugin cache with a Windows ACL. No sign-in was started." };
    }
    host.fs.writeFile(marker, "1");
    return {};
  }
  const env = envFor(p);
  for (const dir of [p.root, p.home, p.runtime, p.npmCache]) {
    const chmod = runProcess("chmod", ["700", nativePath(dir)], env);
    if (!chmod.ok) return { error: "storage-protection-failed", message: "Could not restrict the plugin runtime directory permissions. No sign-in was started." };
  }
  return {};
}

function protectCacheFiles(p: Paths, force = false): { error?: string; message?: string } {
  if (!force && cacheProtectionCache[p.root]) return cacheProtectionCache[p.root];
  const result = applyCacheFileProtection(p);
  cacheProtectionCache[p.root] = result;
  return result;
}

function applyCacheFileProtection(p: Paths): { error?: string; message?: string } {
  if (host.path.isWindows) return protectStorage(p);
  const env = envFor(p);
  for (const file of [p.msal, p.current, p.all]) {
    if (!host.fs.fileExists(file)) continue;
    const chmod = runProcess("chmod", ["600", nativePath(file)], env);
    if (!chmod.ok) return { error: "storage-protection-failed", message: "Could not restrict an m365 credential cache file." };
  }
  return {};
}

function startLoginProcess(p: Paths, target: Target, stage: LoginJob["stage"], args: string[], packagePath?: string, authType: LoginAuthType = "browser"): { jobId?: string; error?: string } {
  let started: { jobId?: string; error?: string };
  const bin = stage === "pack" || stage === "install" ? target.npm : nativePath(p.binary);
  const logFile = stage === "browser" ? joinPath(p.root, `login-${authType}.log`) : undefined;
  if (logFile) try { host.fs.removeFile(logFile); } catch { }
  // A detached job discards stdout, so only the long-lived browser sign-in detaches; npm stages must report their result.
  const detach = stage === "browser";
  try { started = host.exec.start({ bin, args, env: envFor(p), timeoutMs: 120000, detach, ...(logFile ? { logFile } : {}) }); }
  catch { return { error: `Could not start the m365 ${stage} step.` }; }
  if (!started.jobId) return { error: started.error || `The m365 ${stage} step did not start.` };
  loginJobs[started.jobId] = { stage, paths: p, target, packagePath, authType, logFile };
  activeLoginJobId = started.jobId;
  return { jobId: started.jobId };
}

function installM365(authType: LoginAuthType): { jobId?: string; state: string; message: string } {
  const p = paths();
  if (!p) return { state: "unsupported-platform", message: "The host home directory is unavailable." };
  delete runtimeInfoCache[p.root];
  const protectedState = protectStorage(p);
  if (protectedState.error) return { state: protectedState.error, message: protectedState.message || "Could not secure plugin storage." };
  const info = runtimeInfo(p);
  if ("state" in info) return { state: info.state, message: info.message };
  const npmVersion = runProcess(info.target.npm, ["--version"], envFor(p));
  if (!npmVersion.ok) return { state: "not-installed", message: "Node.js is available, but npm is not. Install npm with Node.js 20 or later, then retry Sign in." };
  const entries = host.fs.readDir(p.root) || [];
  for (const entry of entries) if (/^pnp-cli-microsoft365-\d+\.\d+\.\d+\.tgz$/i.test(entry.name)) host.fs.removeFile(entry.path);
  const packagePath = joinPath(p.root, `pnp-cli-microsoft365-${VERSION}.tgz`);
  const started = startLoginProcess(p, info.target, "pack", ["pack", `${PACKAGE}@${VERSION}`, "--pack-destination", nativePath(p.root), "--json"], packagePath, authType);
  if (!started.jobId) return { state: "install-failed", message: started.error || "Could not start npm pack." };
  return { jobId: started.jobId, state: "install-in-progress", message: "The pinned m365 package is being packed for local checksum verification before installation." };
}

function packageFromPackResult(p: Paths, target: Target, stdout: string): { path?: string; error?: string } {
  const packed = parseJson<any[]>(stdout);
  const packageInfo = Array.isArray(packed) ? packed[0] : null;
  const filename = String(packageInfo?.filename || "");
  if (packageInfo?.name !== PACKAGE || packageInfo?.version !== VERSION || !/^pnp-cli-microsoft365-\d+\.\d+\.\d+\.tgz$/.test(filename)) {
    return { error: "npm pack returned an unexpected package result." };
  }
  const packagePath = joinPath(p.root, filename);
  if (!host.fs.fileExists(packagePath)) return { error: "npm pack did not create the expected local tarball." };
  const script = "const fs=require('node:fs');const crypto=require('node:crypto');process.stdout.write('sha512-'+crypto.createHash('sha512').update(fs.readFileSync(process.argv[1])).digest('base64'));";
  const digest = runProcess(target.node, ["-e", script, nativePath(packagePath)], envFor(p));
  if (!digest.ok || digest.stdout.trim() !== target.integrity) {
    try { host.fs.removeFile(packagePath); } catch { }
    return { error: "The local m365 package checksum did not match the pinned SHA-512." };
  }
  return { path: packagePath };
}

function finishLoginJob(jobId: string, state: string, error?: string): any {
  const login = loginJobs[jobId];
  if (login?.packagePath) {
    try { host.fs.removeFile(login.packagePath); } catch { }
  }
  if (login?.logFile) {
    try { host.fs.removeFile(login.logFile); } catch { }
  }
  delete loginJobs[jobId];
  if (activeLoginJobId === jobId) activeLoginJobId = null;
  return { done: true, state, error, jobId };
}

function startBrowserLogin(p: Paths, target: Target, authType: LoginAuthType = "browser"): { jobId?: string; error?: string } {
  const args = ["login", "--authType", authType, "--appId", CLIENT_ID, "--output", "json"];
  return startLoginProcess(p, target, "browser", args, undefined, authType);
}

function signInLogFailure(text: string): { state: string; message: string } | null {
  const known = authState(text);
  if (known) return known;
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || "";
  return /^Error:/.test(last) ? { state: "sign-in-failed", message: `Microsoft sign-in failed: ${last.slice(6).trim()}` } : null;
}

function browserLogFailure(login: LoginJob): { state: string; message: string } | null {
  if (!login.logFile) return null;
  return signInLogFailure(String(host.fs.readFileTail(login.logFile, 8192) || ""));
}

function deviceSignInArtifacts(login: LoginJob): { signInUrl?: string; deviceCode?: string } {
  if (!login.logFile) return {};
  const raw = String(host.fs.readFileTail(login.logFile, 8192) || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ");
  const parsed = parseJson<any>(raw.trim());
  const urlMatch = raw.match(/https?:\/\/(?:aka\.ms|microsoft\.com)\/devicelogin\b[^\s<>"']*/i);
  const codeMatch = raw.match(/(?:enter|use)\s+(?:the\s+)?(?:login\s+)?(?:code\s+)?([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?|[A-Z0-9]{6,12})\b/i)
    || raw.match(/\b(?:device|user|sign-in|login)\s+code\s*[:=]?\s*([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?|[A-Z0-9]{6,12})\b/i);
  const candidateUrl = String(parsed?.signInUrl || parsed?.verificationUri || parsed?.verificationUrl || "");
  const candidateCode = String(parsed?.deviceCode || parsed?.userCode || "");
  const signInUrl = (urlMatch?.[0] || candidateUrl.match(/^https?:\/\/(?:aka\.ms|microsoft\.com)\/devicelogin\b[^\s<>"']*/i)?.[0])?.replace(/[),.;]+$/, "");
  const deviceCode = /^[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?$|^[A-Z0-9]{6,12}$/i.test(candidateCode) ? candidateCode : codeMatch?.[1];
  return signInUrl && deviceCode ? { signInUrl, deviceCode } : {};
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
  if (!host.fs.fileExists(p.binary)) return { ok: false, error: "m365 is not installed. Run `codeterm plugin teams-client login` (or Sign in in the view) to install the pinned CLI.", stderr: "" };
  const secured = protectStorage(p);
  if (secured.error) return { ok: false, error: secured.message || "Could not secure the m365 runtime.", stderr: "" };
  const result = runProcess(nativePath(p.binary), args, envFor(p));
  return result;
}

function authState(text: string): { state: string; message: string } | null {
  const value = String(text || "");
  if (/AADSTS53003|conditional[ -]access|blocked by (?:your )?(?:organization|tenant) policy/i.test(value)) {
    return { state: "conditional-access-blocked", message: "Your organization's Conditional Access policy blocked this sign-in. Ask your IT administrator which browser sign-in policy applies, then sign in again." };
  }
  if (/AADSTS50076|AADSTS50079|multi[ -]?factor|\bMFA\b|additional authentication is required/i.test(value)) {
    return { state: "mfa-required", message: "Complete the MFA step in the Microsoft browser sign-in, then sign in again." };
  }
  if (/AADSTS65001|AADSTS65004|consent_required|consent[^\n]*(?:not granted|withdrawn|revoked|removed)|(?:withdrawn|revoked|removed)[^\n]*consent|admin consent/i.test(value)) {
    return { state: "consent-not-granted", message: "Microsoft Graph consent is missing or was withdrawn. If your tenant allows user consent, sign in again and review the consent prompt; otherwise ask a tenant administrator to approve the m365 app's requested permissions, then sign in again." };
  }
  if (/AADSTS50173|refresh token[^\n]*(?:revoked|invalidated)|(?:revoked|invalidated)[^\n]*refresh token/i.test(value)) {
    return { state: "refresh-token-revoked", message: "The Microsoft refresh token was revoked. Sign in again to create a new browser session." };
  }
  if (/AADSTS700082|AADSTS700084|login has expired|access token expired|token has expired|expired refresh token/i.test(value)) {
    return { state: "token-expired", message: "The Microsoft token expired. Sign in again to renew the browser session." };
  }
  if (/can't open(?: the)? default browser|could not open.*browser|failed to (?:open|launch).*browser|browser instance/i.test(value)) {
    return { state: "browser-open-failed", message: "m365 could not open the default browser. Set a system default browser or start CodeTerm in a desktop session, then retry Sign in." };
  }
  return null;
}

function lifecycleMessage(state: string, detail?: string): string {
  const messages: Record<string, string> = {
    "not-installed": "Node.js 20 or later with npm is required, or the pinned m365 CLI is not installed. Run `codeterm plugin teams-client login` (or Sign in in the view) to install it, or install Node.js 20+ and npm first.",
    "unsupported-platform": detail || "This operating system and architecture are not supported by the pinned m365 CLI.",
    "install-failed": detail || "The pinned m365 CLI could not be verified or installed. Check npm access and retry Sign in.",
    "installed-not-configured": "The pinned m365 CLI is ready. Sign in with your work or school Microsoft account in the browser.",
    "logged-out": "You are signed out. Run `codeterm plugin teams-client login` (or Sign in in the view) to sign in.",
    "logged-in": "Microsoft Teams is connected.",
    "reauth-needed": "The Microsoft session needs a new sign-in. Sign in again with `codeterm plugin teams-client login` (or Sign in in the view).",
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

function now(): number {
  const value = injectedClock ? Number(injectedClock()) : Date.now();
  return Number.isFinite(value) ? value : Date.now();
}

function sha256Hex(text: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00); i++; }
      else code = 0xfffd;
    } else if (code >= 0xdc00 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 255);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 255);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Array<number>(64);
  const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 4;
      words[i] = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choice + constants[i] + words[i]) >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
  }
  return state.map((value) => value.toString(16).padStart(8, "0")).join("");
}

type Sender = { id: string; accountId: string; tenantId: string; upn: string; identityKey: string };

function senderFromFields(fields: any): Sender | null {
  const accountId = String(fields && fields.accountId || "");
  const tenantId = String(fields && fields.tenantId || "");
  const upn = String(fields && fields.upn || "");
  if (!accountId || !tenantId || !upn) return null;
  return { id: accountId, accountId, tenantId, upn, identityKey: JSON.stringify([accountId, tenantId]) };
}

function previewSender(): { sender: Sender } | { error: string } {
  const p = paths();
  const sender = p ? senderFromFields(currentPublic(p)) : null;
  if (!sender) return { error: "not-logged-in: Sign in with the intended work or school account and confirm that its tenant is available before previewing." };
  return { sender };
}

function liveSender(): { sender: Sender } | { error: string } {
  const current = status();
  const reauthStates = ["conditional-access-blocked", "mfa-required", "consent-not-granted", "refresh-token-revoked", "token-expired"];
  if (reauthStates.includes(current.state)) return { error: `reauth-needed: ${current.state}. ${current.message}` };
  if (current.state === "reauth-needed") return { error: `reauth-needed: session status needs attention. ${current.message} Review the tenant sign-in and sign in again.` };
  if (["logged-out", "installed-not-configured"].includes(current.state)) return { error: "not-logged-in: Sign in to Teams Client with the intended work or school account before sending." };
  if (current.state !== "logged-in") return { error: `upstream-rejected: ${current.message} Resolve the Teams Client prerequisite, then review the preview again before sending.` };
  const sender = senderFromFields(current);
  if (!sender) return { error: "upstream-rejected: The active account, UPN, and tenant could not all be resolved. Refresh Teams Client status before approving a send." };
  if (sender.tenantId.toLowerCase() === PERSONAL_TENANT_ID) {
    return { error: "upstream-rejected: Delegated Teams chat send requires a work or school tenant. Sign in with the intended work or school account, then preview again." };
  }
  return { sender };
}

function policySummary(): any {
  const p = paths();
  if (!p) return { configured: false, mode: null, senderAccountId: null, senderTenantId: null, allowedDestinations: [] };
  let policy: any = null;
  try { policy = parseJson<any>(host.fs.readFile(p.policy) || ""); } catch { policy = null; }
  const destinations = policy && Array.isArray(policy.allowedDestinations) ? policy.allowedDestinations : [];
  if (!policy || policy.approved !== true || policy.mode !== INITIAL_SEND_POLICY_MODE ||
    typeof policy.senderAccountId !== "string" || !policy.senderAccountId ||
    typeof policy.senderTenantId !== "string" || !policy.senderTenantId || destinations.length !== 1 ||
    !destinations[0] || !validChatId(String(destinations[0].id || "")) || typeof destinations[0].label !== "string") {
    return { configured: false, mode: null, senderAccountId: null, senderTenantId: null, allowedDestinations: [] };
  }
  return {
    configured: true,
    mode: INITIAL_SEND_POLICY_MODE,
    senderAccountId: policy.senderAccountId,
    senderTenantId: policy.senderTenantId,
    allowedDestinations: [{ id: String(destinations[0].id), label: String(destinations[0].label) }],
    approvedAt: Number(policy.approvedAt) || null,
  };
}

function resolveDestination(id: string, sender: Sender): { destination: any } | { error: string } {
  if (!validChatId(id)) return { error: "destination-not-permitted: Usage: preview <immutable-chat-id> <text>. Choose an id from chats; display labels are not ids." };
  if (!cachedChats || cachedChats.identityKey !== sender.identityKey) {
    return { error: "upstream-rejected: Refresh chats for this account and tenant, then preview an immutable chat id." };
  }
  const chat = cachedChats.chats.find((item: any) => item.id === id);
  if (!chat) return { error: `destination-not-permitted: Chat id ${id} was not in the resolved chat list for tenant ${sender.tenantId}. Refresh chats and choose a listed id.` };
  return { destination: { id: String(chat.id), label: String(chat.topic || chat.id) } };
}

let previewSequence = 0;
function previewCommand(args: string[], origin: "agent" | "view" = "agent"): { result: string } | { error: string } {
  if (args.length < 2 || !validChatId(args[0])) return { error: "Usage: preview <immutable-chat-id> <text>. Choose an id from chats; display labels are not accepted." };
  const text = args.slice(1).join(" ");
  if (!text.length) return { error: "upstream-rejected: Preview text must not be empty." };
  const resolved = previewSender();
  if ("error" in resolved) return resolved;
  const found = resolveDestination(args[0], resolved.sender);
  if ("error" in found) return found;
  const previewId = sha256Hex(`preview\u0000${now()}\u0000${++previewSequence}`);
  const idempotencyKey = previewId;
  previewTokens[previewId] = { sender: resolved.sender, destination: found.destination, text, origin, previewNonce: previewId };
  return { result: JSON.stringify({
    previewId,
    idempotencyKey,
    sender: resolved.sender,
    tenant: { id: resolved.sender.tenantId },
    destination: found.destination,
    text,
    policy: policySummary(),
  }) };
}

function setSendPolicy(args: any): any {
  if (!args || args.approveDestination !== true) return { error: "No send policy was changed. Review the full sender, tenant, destination, and text preview, then explicitly approve that single chat." };
  const preview = previewTokens[String(args.previewId || "")];
  if (!preview || preview.origin !== "view") return { error: "Only a preview created in this view can approve a destination. Refresh chats and create a fresh view preview." };
  const current = liveSender();
  if ("error" in current) return { error: current.error };
  if (current.sender.identityKey !== preview.sender.identityKey || current.sender.upn !== preview.sender.upn) {
    return { error: "destination-not-permitted: The signed-in account or tenant changed after preview. Confirm a fresh preview before approval." };
  }
  const p = paths();
  if (!p) return { error: "upstream-rejected: The Teams Client data directory is unavailable; no policy was written." };
  try {
    if (!host.fs.makeDirs(p.root)) return { error: "upstream-rejected: The Teams Client data directory could not be created; no policy was written." };
    const saved = host.fs.writeFile(p.policy, JSON.stringify({
      approved: true,
      mode: INITIAL_SEND_POLICY_MODE,
      senderAccountId: preview.sender.accountId,
      senderTenantId: preview.sender.tenantId,
      allowedDestinations: [{ id: preview.destination.id, label: preview.destination.label }],
      approvedAt: now(),
    }));
    if (saved !== true) return { error: "upstream-rejected: The single-chat policy could not be saved; no destination is enabled." };
  } catch { return { error: "upstream-rejected: The single-chat policy could not be saved; no destination is enabled." }; }
  return { result: JSON.stringify(policySummary()) };
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
  const refreshed = metadataFromM365(p) || {};
  const active = refreshed.active || {};
  cachedChats = null;
  clearPreviewTokens();
  return { result: JSON.stringify({ accountId: String(current.accountId || active.accountId || selected.name), tenantId: String(current.tenantId || active.tenantId || ""), upn: String(current.upn || active.upn || selected.connectedAs || "") }) };
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
  const sender = previewSender();
  cachedChats = "sender" in sender ? { identityKey: sender.sender.identityKey, chats } : null;
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
    content: String(raw && (raw.content || raw.body?.content) || ""),
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

type AttemptState = "pending" | "sent" | "rate_limited" | "failed" | "unknown";
type SendFailure = "not-logged-in" | "reauth-needed" | "policy-not-set" | "destination-not-permitted" | "rate-limited" | "upstream-rejected" | "unknown";
type Attempt = {
  idempotencyKey: string;
  sender: Sender;
  destination: { id: string; label: string };
  payloadHash: string;
  state: AttemptState;
  createdAt: number;
  updatedAt: number;
  sendCount: number;
  failure?: SendFailure;
  failureCause?: string;
  failureMessage?: string;
  graphMessageId?: string;
};
type Outbox = { schema: 1; attempts: Attempt[] };

function failureMessage(kind: SendFailure, detail?: any, cause?: string): string {
  switch (kind) {
    case "not-logged-in": return "not-logged-in: Sign in with the intended work or school account through `codeterm plugin teams-client login` (or Sign in in the view) and confirm its tenant before sending.";
    case "reauth-needed": return `reauth-needed: ${String(cause || "reauth-needed")}. ${String(detail || "The Microsoft session needs a new sign-in. Sign in again and complete the tenant's required authentication step.")}`;
    case "policy-not-set": return "policy-not-set: Review the resolved account, tenant, destination, and exact text in Teams Client, then explicitly approve that single chat before sending.";
    case "destination-not-permitted": return `destination-not-permitted: Only the owner's approved immutable chat id is allowed (${String(detail || "no destination is approved")}). Select that exact chat or review a new preview before changing policy.`;
    case "rate-limited": return `rate-limited: Microsoft 365 throttled this operation. Review Teams Client status and the selected chat before deciding what to do.`;
    case "upstream-rejected": return `upstream-rejected: m365 refused the operation (${String(detail || "inspect the Microsoft 365 error and correct its cause")}). Correct the permission or request issue, then invoke send again only if you still want delivery.`;
    case "unknown": return `unknown: ${String(detail || "Microsoft 365 may have accepted this message but confirmation was lost.")} Do not retry this idempotency key; inspect the selected chat and decide manually.`;
  }
  const exhaustive: never = kind;
  return exhaustive;
}

function loadOutbox(p: Paths): { ledger?: Outbox; error?: string } {
  try {
    if (!host.fs.fileExists(p.outbox)) return { ledger: { schema: 1, attempts: [] } };
    const value = parseJson<any>(host.fs.readFile(p.outbox) || "");
    if (!value || value.schema !== 1 || !Array.isArray(value.attempts)) return { error: "the existing outbox ledger is unreadable" };
    const states: AttemptState[] = ["pending", "sent", "rate_limited", "failed", "unknown"];
    const valid = value.attempts.every((item: any) => item && typeof item.idempotencyKey === "string" &&
      typeof item.payloadHash === "string" && /^[a-f0-9]{64}$/.test(item.payloadHash) && states.includes(item.state) &&
      item.sender && typeof item.sender.accountId === "string" && typeof item.sender.tenantId === "string" &&
      typeof item.sender.identityKey === "string" && item.destination && validChatId(String(item.destination.id || "")) &&
      typeof item.destination.label === "string" && Number.isFinite(Number(item.createdAt)) &&
      Number.isFinite(Number(item.updatedAt)) && Number.isInteger(item.sendCount) && item.sendCount >= 0);
    if (!valid) return { error: "the existing outbox ledger contains an invalid or unrecognized attempt state" };
    return { ledger: value as Outbox };
  } catch { return { error: "the existing outbox ledger could not be read" }; }
}

function persistOutbox(p: Paths, ledger: Outbox): boolean {
  try {
    if (!host.fs.makeDirs(p.root)) return false;
    return host.fs.writeFile(p.outbox, JSON.stringify(ledger)) === true;
  } catch { return false; }
}

function rememberSendFailure(kind: SendFailure, message: string): { error: string } {
  lastSendState = { state: kind, message, updatedAt: now() };
  return { error: message };
}

function sendFailureResult(kind: SendFailure, detail?: any, cause?: string): { error: string } {
  return rememberSendFailure(kind, failureMessage(kind, detail, cause));
}

function rememberPrefixedFailure(message: string): { error: string } {
  const state = message.slice(0, message.indexOf(":")) as SendFailure;
  const allowed: SendFailure[] = ["not-logged-in", "reauth-needed", "policy-not-set", "destination-not-permitted", "rate-limited", "upstream-rejected", "unknown"];
  return allowed.includes(state) ? rememberSendFailure(state, message) : sendFailureResult("unknown", "The command result could not be classified safely. Inspect the Teams chat before retrying.");
}

function parseSendArgs(args: string[]): { chatId: string; text: string; key?: string } | { error: string } {
  if (args.length < 2 || !validChatId(args[0])) return { error: "destination-not-permitted: Usage: send <immutable-chat-id> [--key <idempotency-key>] <text>. Choose an id from chats; labels are not ids." };
  let start = 1;
  let key: string | undefined;
  if (args[1] === "--key") {
    if (args.length < 4 || !/^[A-Za-z0-9._:-]{1,160}$/.test(args[2])) return { error: "upstream-rejected: --key needs a 1–160 character idempotency key, followed by message text." };
    key = args[2];
    start = 3;
  }
  const text = args.slice(start).join(" ");
  if (!text.length) return { error: "upstream-rejected: Message text must not be empty." };
  return { chatId: args[0], text, key };
}

function failureForUpstream(message: string): { kind: SendFailure; detail?: string; cause?: string } {
  const auth = authState(message);
  if (auth) return { kind: "reauth-needed", detail: auth.message, cause: auth.state };
  if (/not signed in|not logged in|no active connection|logged out|run m365 login/i.test(message)) return { kind: "not-logged-in" };
  // The pinned m365 CLI consumes Retry-After and retries 429/503 inside its
  // subprocess. If that process ultimately surfaces throttling, this caller
  // cannot know whether one of those internal requests already delivered.
  if (/\b429\b|\b503\b|too many requests|throttl|service unavailable/i.test(message)) {
    return { kind: "unknown", detail: "m365 may have retried this throttled send internally and may have delivered the message." };
  }
  if (/timeout|timed out|deadline exceeded|connection reset|connection closed|unexpected EOF|\bEOF\b|broken pipe|lost response|context cancel+ed|terminated|signal|killed|did not finish|could not confirm|unconfirmed/i.test(message)) return { kind: "unknown" };
  if (/\bHTTP\s+(?:400|401|403|404|413)\b/i.test(message)) return { kind: "upstream-rejected", detail: "Microsoft Graph definitively rejected this request before delivery" };
  if (/exec denied|spawn .*?(?:ENOENT|EACCES)|binary .*?not found|not installed|node .*?missing/i.test(message)) {
    return { kind: "upstream-rejected", detail: "the local send prerequisite failed before m365 could run" };
  }
  return { kind: "unknown", detail: "m365 returned an outcome that cannot prove whether the message was delivered." };
}

function runTeamsSend(args: string[], then: (run: RunResult) => unknown): any {
  const target = targetState();
  if (!target.paths) return then({ ok: false, error: target.message, stderr: "" });
  if (target.state !== "ready") return then({ ok: false, error: target.message, stderr: "" });
  const p = target.paths;
  if (!host.fs.fileExists(p.binary)) return then({ ok: false, error: "m365 is not installed. Run `codeterm plugin teams-client login` (or Sign in in the view) to install the pinned CLI.", stderr: "" });
  const secured = protectStorage(p);
  if (secured.error) return then({ ok: false, error: secured.message || "Could not secure the m365 runtime.", stderr: "" });
  return host.exec.async({ bin: nativePath(p.binary), args, env: envFor(p), timeoutMs: 5000 }, (result) => {
    const stdout = String(result.stdout || "");
    const stderr = String(result.stderr || "");
    if (result.error) return then({ ok: false, error: `m365 send process returned an unconfirmed result: ${String(result.error)}`, stderr, code: result.code });
    if (result.done !== true || typeof result.code !== "number") return then({ ok: false, error: "m365 send process outcome is unknown.", stderr });
    if (result.code !== 0) return then({ ok: false, error: stderr || stdout || `m365 exited ${result.code}`, stderr, code: result.code });
    return then({ ok: true, stdout, stderr });
  });
}

function messageIdFromOutput(output: string): string | undefined {
  const value = parseJson<any>(output.trim());
  const data = value && (value.data || value);
  const id = data && (data.id || data.messageId);
  return id === undefined || id === null ? undefined : String(id);
}

function attemptResult(attempt: Attempt): { result: string } {
  lastSendState = { state: "sent", message: "m365 confirmed the message and the sent result is recorded in the Teams Client outbox.", updatedAt: now() };
  return { result: JSON.stringify({
    status: "sent",
    sender: attempt.sender,
    tenant: { id: attempt.sender.tenantId },
    destination: attempt.destination,
    idempotencyKey: attempt.idempotencyKey,
    graphMessageId: attempt.graphMessageId || null,
    deliveryGuarantee: "The plugin returns a recorded success for a sent idempotency key and never resends that key. m365 does not surface the Graph message id on success; ambiguous outcomes remain unknown. This is not an exactly-once delivery guarantee.",
  }) };
}

function persistFailure(p: Paths, ledger: Outbox, attempt: Attempt, kind: SendFailure, detail?: string, cause?: string): { error: string } {
  attempt.failure = kind;
  attempt.failureCause = cause;
  attempt.failureMessage = failureMessage(kind, detail, cause);
  attempt.updatedAt = now();
  delete (attempt as any).retryAfter;
  if (kind === "unknown") {
    attempt.state = "unknown";
  } else {
    attempt.state = "failed";
  }
  if (!persistOutbox(p, ledger)) {
    attempt.state = "unknown";
    attempt.failure = "unknown";
    attempt.failureCause = undefined;
    attempt.failureMessage = failureMessage("unknown");
    persistOutbox(p, ledger);
    return rememberSendFailure("unknown", attempt.failureMessage);
  }
  return rememberSendFailure(kind, attempt.failureMessage);
}

function sendCommand(sessionId: string, args: string[]): { result: string } | { error: string } {
  const parsed = parseSendArgs(args);
  if ("error" in parsed) return rememberPrefixedFailure(parsed.error);
  const policy = policySummary();
  if (!policy.configured) return sendFailureResult("policy-not-set");
  const permitted = policy.allowedDestinations.find((item: any) => item.id === parsed.chatId);
  if (!permitted) return sendFailureResult("destination-not-permitted", policy.allowedDestinations[0]?.id);
  const expectedIdentity = JSON.stringify([policy.senderAccountId, policy.senderTenantId]);
  const matchingPreview = Object.values(previewTokens).reverse().find((token: any) =>
    token.sender.identityKey === expectedIdentity && token.destination.id === parsed.chatId && token.text === parsed.text);
  const key = parsed.key || matchingPreview?.previewNonce;
  if (!key) {
    const current = liveSender();
    if ("error" in current) return rememberPrefixedFailure(current.error);
    return sendFailureResult("upstream-rejected", "create a fresh preview before sending without an explicit idempotency key");
  }
  const p = paths();
  if (!p) return sendFailureResult("upstream-rejected", "the plugin-owned data directory is unavailable");
  const loaded = loadOutbox(p);
  if (!loaded.ledger) return sendFailureResult("upstream-rejected", loaded.error || "the outbox could not be read");
  const ledger = loaded.ledger;
  let attempt = ledger.attempts.find((item) => item.idempotencyKey === key);
  const payloadHash = sha256Hex(parsed.text);
  if (attempt && (attempt.payloadHash !== payloadHash || attempt.destination.id !== parsed.chatId || attempt.sender.identityKey !== expectedIdentity)) {
    return sendFailureResult("upstream-rejected", "this idempotency key is already bound to another tenant, sender, destination, or payload; choose a new key only for an intentional new send");
  }
  if (attempt && attempt.state === "sent") return attemptResult(attempt);
  if (attempt && attempt.state === "unknown") return sendFailureResult("unknown");
  if (attempt && attempt.state === "pending") return persistFailure(p, ledger, attempt, "unknown", "a previous invocation ended before its send result was recorded");
  // Older ledger entries in rate_limited are not safe to resume: the pinned
  // m365 CLI may already have retried the request internally.
  if (attempt && attempt.state === "rate_limited") return persistFailure(p, ledger, attempt, "unknown");

  const resolved = liveSender();
  if ("error" in resolved) return rememberPrefixedFailure(resolved.error);
  if (resolved.sender.accountId !== policy.senderAccountId || resolved.sender.tenantId !== policy.senderTenantId) {
    return sendFailureResult("destination-not-permitted", `${permitted.id} for the approved account and tenant; the active account or tenant changed`);
  }
  const destination = { id: parsed.chatId, label: String(permitted.label || permitted.id) };
  if (!attempt) {
    attempt = {
      idempotencyKey: key,
      sender: resolved.sender,
      destination,
      payloadHash,
      state: "pending",
      createdAt: now(),
      updatedAt: now(),
      sendCount: 0,
    };
    ledger.attempts.push(attempt);
  }
  attempt.state = "pending";
  attempt.updatedAt = now();
  attempt.sendCount += 1;
  delete attempt.failure;
  delete attempt.failureCause;
  delete attempt.failureMessage;
  if (!persistOutbox(p, ledger)) return sendFailureResult("upstream-rejected", "the pending attempt could not be persisted; m365 was not contacted");

  return runTeamsSend(["teams", "chat", "message", "send", "--chatId", parsed.chatId, "--message", parsed.text, "--output", "json"], (run) => {
    if (!run.ok) {
      const upstream = failureForUpstream(`${run.error}\n${run.stderr}`);
      return persistFailure(p, ledger, attempt!, upstream.kind, upstream.detail, upstream.cause);
    }
    attempt!.graphMessageId = messageIdFromOutput(run.stdout);
    attempt!.state = "sent";
    attempt!.updatedAt = now();
    delete attempt!.failure;
    delete attempt!.failureCause;
    delete attempt!.failureMessage;
    if (!persistOutbox(p, ledger)) return persistFailure(p, ledger, attempt!, "unknown");
    return attemptResult(attempt!);
  });
}

function logout(): { result: string } | { error: string } {
  const target = targetState();
  if (target.state !== "ready") return { error: lifecycleMessage(target.state, target.message) };
  const p = target.paths!;
  if (!host.fs.fileExists(p.binary)) {
    cachedChats = null;
    clearPreviewTokens();
    return { result: "Logged out. No m365 runtime is installed." };
  }
  const run = runM365(["logout"]);
  if (!run.ok) {
    const reauth = authState(`${run.error}\n${run.stderr}`);
    if (reauth) return { error: reauth.message };
    return { error: "m365 could not clear its plugin-owned session files. The files were kept so logout can be retried." };
  }
  for (const file of [p.msal, p.current, p.all]) {
    if (host.fs.fileExists(file) && !host.fs.removeFile(file)) return { error: "m365 logged out, but a plugin-owned cache file could not be removed. Retry logout." };
  }
  cachedChats = null;
  clearPreviewTokens();
  return { result: "Logged out. The plugin-owned m365 token and connection files were removed." };
}

function onAgentCommand(ctx: { sessionId: string; verb: string; args: string[] }): { result: string } | { error: string } {
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  switch (ctx.verb) {
    case "login": {
      if (args.length) return { error: "Usage: login." };
      const started = loginStart(AGENT_LOGIN_AUTH);
      if (started.error) return { error: started.error };
      const current = loginPoll(started.jobId);
      if (current.error) return { error: current.error };
      const signInUrl = current.signInUrl;
      const deviceCode = current.deviceCode;
      return { result: JSON.stringify({
        state: String(current.state || started.state || "login-in-progress"),
        jobId: current.jobId || started.jobId,
        signIn: signInUrl && deviceCode ? "device-code" : AGENT_LOGIN_AUTH,
        signInUrl,
        deviceCode,
        message: signInUrl && deviceCode ? `Open ${signInUrl} and enter code ${deviceCode}.` : String(current.state || started.state) === "login-in-progress" ? BROWSER_SIGN_IN_MESSAGE : "Microsoft sign-in is being prepared. Poll login-status; the sign-in page opens in the default browser when the runtime is ready.",
      }) };
    }
    case "login-status": {
      if (args.length) return { error: "Usage: login-status." };
      if (!activeLoginJobId) return { result: JSON.stringify({ state: statusView().state, done: true }) };
      const current = loginPoll(activeLoginJobId);
      return current.error ? { error: current.error } : { result: JSON.stringify({
        done: current.done === true,
        state: String(current.state || "login-in-progress"),
        jobId: current.jobId || activeLoginJobId,
        signIn: current.signInUrl && current.deviceCode ? "device-code" : AGENT_LOGIN_AUTH,
        signInUrl: current.signInUrl,
        deviceCode: current.deviceCode,
        message: current.signInUrl && current.deviceCode ? `Open ${current.signInUrl} and enter code ${current.deviceCode}.` : current.message,
      }) };
    }
    case "accounts": return agentAccounts();
    case "use": return args.length === 1 ? useAccount(args[0]) : { error: "Usage: use <account-id>." };
    case "chats": return agentChats();
    case "history": return agentHistory(args);
    case "health": return { result: JSON.stringify({ ...statusView(), sendPolicy: policySummary(), lastSend: lastSendState }) };
    case "logout": return logout();
    case "send": return sendCommand(ctx.sessionId, args);
    case "preview": return previewCommand(args, "agent");
    default: return { error: `Unknown Teams Client verb: ${ctx.verb}` };
  }
}

function loginStart(authType: LoginAuthType = "browser"): any {
  if (activeLoginJobId && loginJobs[activeLoginJobId]) {
    return { jobId: activeLoginJobId, state: "login-in-progress", message: "Microsoft sign-in is already running. Check its status instead of starting another login." };
  }
  const p = paths();
  if (!p) return { error: lifecycleMessage("unsupported-platform") };
  const protectedState = protectStorage(p);
  if (protectedState.error) return { error: protectedState.message || lifecycleMessage("install-failed") };
  if (!host.fs.fileExists(p.binary)) {
    const installed = installM365(authType);
    return installed.jobId
      ? { jobId: installed.jobId, state: installed.state, message: installed.message }
      : { error: lifecycleMessage(installed.state, installed.message), state: installed.state };
  }
  const target = targetState();
  if (target.state !== "ready" || !target.paths) return { error: lifecycleMessage(target.state, target.message) };
  const started = startBrowserLogin(target.paths, target.target!, authType);
  if (!started.jobId) return { error: started.error || "m365 browser sign-in did not start.", state: "install-failed" };
  return { jobId: started.jobId, state: "login-in-progress", message: "Complete Microsoft work or school sign-in in the browser, then check sign-in status." };
}

function loginPoll(jobId: string): any {
  const login = jobId ? loginJobs[jobId] : null;
  if (!login) return { error: "Unknown Microsoft sign-in job." };
  let poll: { done: boolean; code?: number; stdout?: string; stderr?: string; error?: string };
  if (login.stage === "browser" && login.launchComplete) {
    const failed = browserLogFailure(login);
    if (failed) return finishLoginJob(jobId, failed.state, failed.message);
    const current = statusView();
    const artifacts = deviceSignInArtifacts(login);
    if (current.state === "logged-in") {
      const secured = protectCacheFiles(login.paths, true);
      if (secured.error) return finishLoginJob(jobId, "install-failed", secured.message || lifecycleMessage("install-failed"));
      return { ...finishLoginJob(jobId, "logged-in"), ...artifacts };
    }
    return { done: false, jobId, state: "login-in-progress", message: "Finish sign-in in the browser or device flow, then check status again.", ...artifacts };
  }
  try { poll = host.exec.poll(jobId); }
  catch { return { error: "Could not read the Microsoft sign-in job." }; }
  const artifacts = deviceSignInArtifacts(login);
  if (!poll.done) return { done: false, jobId, state: "login-in-progress", message: login.stage === "browser" ? "Complete the sign-in, then check status again." : "The pinned m365 package setup is still running.", ...artifacts };
  try { host.exec.close(jobId); } catch { }
  if (poll.error || poll.code !== 0) {
    const reason = `${poll.error || ""}\n${poll.stderr || ""}\n${poll.stdout || ""}`;
    const auth = authState(reason);
    return finishLoginJob(jobId, auth ? auth.state : "install-failed", auth ? auth.message : lifecycleMessage("install-failed"));
  }
  if (login.stage === "pack") {
    const packed = packageFromPackResult(login.paths, login.target, String(poll.stdout || ""));
    if (!packed.path) return finishLoginJob(jobId, "install-failed", packed.error || lifecycleMessage("install-failed"));
    delete loginJobs[jobId];
    if (activeLoginJobId === jobId) activeLoginJobId = null;
    const install = startLoginProcess(login.paths, login.target, "install", [
      "install", nativePath(packed.path), "--prefix", nativePath(login.paths.runtime),
      "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact",
    ], packed.path, login.authType);
    if (!install.jobId) {
      try { host.fs.removeFile(packed.path); } catch { }
      return { done: true, state: "install-failed", error: install.error || lifecycleMessage("install-failed") };
    }
    return { done: false, jobId: install.jobId, state: "install-in-progress", message: "The local package checksum passed; npm is installing the verified tarball." };
  }
  if (login.stage === "install") {
    if (installedPackageVersion(login.paths) !== VERSION) {
      return finishLoginJob(jobId, "install-failed", lifecycleMessage("install-failed", "The installed m365 CLI version did not match the pinned release."));
    }
    if (login.packagePath) {
      try { host.fs.removeFile(login.packagePath); } catch { }
    }
    delete loginJobs[jobId];
    if (activeLoginJobId === jobId) activeLoginJobId = null;
    const browser = startBrowserLogin(login.paths, login.target, login.authType);
    if (!browser.jobId) return { done: true, state: "install-failed", error: browser.error || "m365 browser sign-in did not start." };
    return { done: false, jobId: browser.jobId, state: "login-in-progress", message: "The verified runtime is ready. Complete Microsoft work or school sign-in in the browser." };
  }
  login.launchComplete = true;
  const failed = browserLogFailure(login);
  if (failed) return finishLoginJob(jobId, failed.state, failed.message);
  const current = statusView();
  if (current.state !== "logged-in") return { done: false, jobId, state: "login-in-progress", message: "Finish sign-in in the browser or device flow, then check status again.", ...artifacts };
  const secured = protectCacheFiles(login.paths, true);
  if (secured.error) return finishLoginJob(jobId, "install-failed", secured.message || lifecycleMessage("install-failed"));
  return { ...finishLoginJob(jobId, "logged-in"), ...artifacts };
}

function viewCall(method: string, args: any): unknown {
  const value = args || {};
  if (method === "status") return { ...statusView(), loginJobId: activeLoginJobId };
  if (method === "loginStart") return loginStart();
  if (method === "loginPoll") return loginPoll(String(value.jobId || ""));
  if (method === "useAccount") return useAccount(String(value.id || ""));
  if (method === "logout") return logout();
  if (method === "chats") return agentChats();
  if (method === "policy") return policySummary();
  if (method === "preview") return previewCommand([String(value.chatId || ""), String(value.text || "")], "view");
  if (method === "approveSendPolicy") return setSendPolicy(value);
  if (method === "send") return sendCommand("teams-client-view", [String(value.chatId || ""), "--key", String(value.idempotencyKey || ""), String(value.text || "")]);
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
  const policy = policySummary();
  nodes.push({ kind: "text", text: policy.configured ? `Send policy: one chat · ${policy.allowedDestinations[0].id} · tenant ${policy.senderTenantId}` : "Send policy: not approved", style: { tone: policy.configured ? "warn" : "muted" } });
  if (lastSendState) nodes.push({ kind: "text", text: `Last send: ${lastSendState.state} · ${lastSendState.message}`, style: { tone: lastSendState.state === "sent" ? "ok" : "warn" } });
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
  __test_failureMessage: failureMessage,
  __test_failureForUpstream: failureForUpstream,
  __test_setClock: (clock: (() => number) | null) => { injectedClock = clock; },
  __test_policySummary: policySummary,
  __test_previewCommand: previewCommand,
  __test_setSendPolicy: setSendPolicy,
  __test_sendCommand: sendCommand,
  __test_agentChats: agentChats,
  __test_sha256Hex: sha256Hex,
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
  __test_useAccount: useAccount,
  __test_agentHistory: agentHistory,
  __test_credentials: credentialPublic,
  __test_windowsAclCommands: windowsAclCommands,
  __test_signInLogFailure: signInLogFailure,
  __test_metadataReader: METADATA_READER,
};

export default plugin;
