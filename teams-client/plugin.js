"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// teams-client/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);
var VERSION = "11.11.0";
var PACKAGE = "@pnp/cli-microsoft365";
var CLIENT_ID = "1fec8e78-bce4-4aaf-ab1b-5451cc387264";
var ROOT = "~/.local/share/codeterm-plugins/teams-client";
var INITIAL_SEND_POLICY_MODE = "single-chat";
var MAX_COUNT = 50;
var MAX_BYTES = 32 * 1024;
var PERSONAL_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
var SRI = "sha512-GXdN3Cw4lOEFixVfI6YZlGM9OzAlMbjGItT8yMn8FznlG6+aWGNI6xjgNJRbigykeSE6YI3KRai+fijMt24DMg==";
var INTEGRITY_BY_TARGET = {
  "darwin/arm64": SRI,
  "darwin/x64": SRI,
  "linux/arm64": SRI,
  "linux/x64": SRI,
  "win32/arm64": SRI,
  "win32/x64": SRI
};
var METADATA_READER = "const path=require('node:path');const {pathToFileURL}=require('node:url');const authFile=path.resolve(process.env.M365_RUNTIME,'node_modules/@pnp/cli-microsoft365/dist/Auth.js');import(pathToFileURL(authFile).href).then(async m=>{const a=m.default;await a.restoreAuth();const c=a.connection||{};const expiry=c.accessTokens&&c.accessTokens['https://graph.microsoft.com']&&c.accessTokens['https://graph.microsoft.com'].expiresOn;const all=await a.getAllConnections();const project=x=>({name:x.name||null,accountId:x.identityId||x.name||null,identityId:x.identityId||null,tenantId:x.identityTenantId||null,upn:x.identityName||null});process.stdout.write(JSON.stringify({active:c.active?project(c):null,expiresOn:expiry?String(expiry):null,connections:all.map(project)}));}).catch(()=>process.stdout.write(JSON.stringify({active:null,expiresOn:null,connections:[]})));";
var loginJobs = {};
var previewTokens = {};
var cachedChats = null;
var injectedClock = null;
var lastSendState = null;
function clearPreviewTokens() {
  for (const id of Object.keys(previewTokens)) delete previewTokens[id];
}
function joinPath(...parts) {
  return host.path.normalize(parts.join("/"));
}
function nativePath(path) {
  return host.path.toNative(host.path.normalize(path));
}
function paths() {
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
      policy: joinPath(root, "send-policy.json")
    };
  } catch {
    return null;
  }
}
function hostPlatform() {
  if (host.path.isWindows) return "win32";
  try {
    return String(host.platform() || "").toLowerCase();
  } catch {
    return "";
  }
}
function binaryNames(platform) {
  if (platform === "win32") return { node: "node.exe", npm: "npm.cmd", m365: "m365.cmd", icacls: "icacls.exe", whoami: "whoami.exe" };
  return { node: "node", npm: "npm", m365: "m365", icacls: "icacls.exe", whoami: "whoami.exe" };
}
function binaryNamesForHost() {
  return binaryNames(hostPlatform());
}
function resolveTarget(platform, arch) {
  const key = `${platform}/${arch}`;
  const integrity = INTEGRITY_BY_TARGET[key];
  if (!integrity) return { error: "unsupported-platform", message: `Pinned m365 ${VERSION} does not support ${key}. Supported targets are macOS, Linux, and Windows on x64 or arm64.` };
  const names = binaryNames(platform);
  return { platform, arch, node: names.node, npm: names.npm, m365: names.m365, integrity };
}
function envFor(p) {
  const home = nativePath(p.home);
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: nativePath(joinPath(p.home, "AppData/Roaming")),
    LOCALAPPDATA: nativePath(joinPath(p.home, "AppData/Local")),
    XDG_CONFIG_HOME: nativePath(joinPath(p.home, ".config")),
    XDG_CACHE_HOME: nativePath(joinPath(p.home, ".cache")),
    NPM_CONFIG_CACHE: nativePath(p.npmCache),
    M365_RUNTIME: nativePath(p.runtime)
  };
}
function runProcess(bin, args, env) {
  let started;
  try {
    started = host.exec.start({ bin, args, env });
  } catch (error) {
    return { ok: false, error: String(error), stderr: "" };
  }
  if (!started.jobId) return { ok: false, error: started.error || `Could not start ${bin}.`, stderr: "" };
  let result;
  try {
    result = host.awaitJob(started.jobId, (value) => value);
  } catch (error) {
    return { ok: false, error: String(error), stderr: "" };
  }
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (result.error) return { ok: false, error: String(result.error), stderr, code: result.code };
  if (!result.done) return { ok: false, error: `${bin} did not finish.`, stderr, code: result.code };
  if (result.code !== 0) return { ok: false, error: stderr || stdout || `${bin} exited ${result.code}.`, stderr, code: result.code };
  return { ok: true, stdout, stderr };
}
function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function runtimeInfo(p) {
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
function protectStorage(p) {
  for (const dir of [p.root, p.home, p.runtime, p.npmCache]) {
    try {
      if (!host.fs.makeDirs(dir)) return { error: "storage-protection-failed", message: "Could not create the plugin-owned private runtime directory." };
    } catch {
      return { error: "storage-protection-failed", message: "Could not create the plugin-owned private runtime directory." };
    }
  }
  if (host.path.isWindows) {
    const names = binaryNamesForHost();
    const env2 = envFor(p);
    const who = runProcess(names.whoami, [], env2);
    const principal = who.ok ? who.stdout.trim() : "";
    if (!principal || /[\r\n]/.test(principal)) return { error: "storage-protection-failed", message: "Could not identify the Windows account for the plugin cache ACL." };
    const grant = `${principal}:(OI)(CI)F`;
    const acl = runProcess(names.icacls, [nativePath(p.root), "/inheritance:r", "/grant:r", grant, "*S-1-5-18:(OI)(CI)F", "/T", "/C"], env2);
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
function protectCacheFiles(p) {
  if (host.path.isWindows) return protectStorage(p);
  const env = envFor(p);
  for (const file of [p.msal, p.current, p.all]) {
    if (!host.fs.fileExists(file)) continue;
    const chmod = runProcess("chmod", ["600", nativePath(file)], env);
    if (!chmod.ok) return { error: "storage-protection-failed", message: "Could not restrict an m365 credential cache file." };
  }
  return {};
}
function installM365() {
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
  const published = parseJson(view.stdout.trim()) || view.stdout.trim().replace(/^['"]|['"]$/g, "");
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
function targetState() {
  const p = paths();
  if (!p) return { state: "unsupported-platform", message: "The host home directory is unavailable." };
  const info = runtimeInfo(p);
  if ("state" in info) return { state: info.state, message: info.message, paths: p };
  return { state: "ready", message: "", paths: p, target: info.target };
}
function runM365(args) {
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
function authState(text) {
  const value = String(text || "");
  if (/AADSTS53003|conditional[ -]access|blocked by (?:your )?(?:organization|tenant) policy/i.test(value)) {
    return { state: "conditional-access-blocked", message: "Your organization's Conditional Access policy blocked this sign-in. Ask your IT administrator which browser sign-in policy applies, then click Sign in again." };
  }
  if (/AADSTS50076|AADSTS50079|multi[ -]?factor|\bMFA\b|additional authentication is required/i.test(value)) {
    return { state: "mfa-required", message: "Complete the MFA step in the Microsoft browser sign-in, then click Sign in again in Teams Client." };
  }
  if (/AADSTS65001|AADSTS65004|consent_required|consent[^\n]*(?:not granted|withdrawn|revoked|removed)|(?:withdrawn|revoked|removed)[^\n]*consent|admin consent/i.test(value)) {
    return { state: "consent-not-granted", message: "Microsoft Graph consent is missing or was withdrawn. If your tenant allows user consent, click Sign in again and review the consent prompt; otherwise ask a tenant administrator to approve the m365 app's requested permissions, then click Sign in again." };
  }
  if (/AADSTS50173|refresh token[^\n]*(?:revoked|invalidated)|(?:revoked|invalidated)[^\n]*refresh token/i.test(value)) {
    return { state: "refresh-token-revoked", message: "The Microsoft refresh token was revoked. Click Sign in again to create a new browser session." };
  }
  if (/AADSTS700082|AADSTS700084|login has expired|access token expired|token has expired|expired refresh token/i.test(value)) {
    return { state: "token-expired", message: "The Microsoft token expired. Click Sign in again to renew the browser session." };
  }
  if (/Can't open the default browser|could not open.*browser|browser instance/i.test(value)) {
    return { state: "browser-open-failed", message: "m365 could not open the default browser. Set a system default browser or start CodeTerm in a desktop session, then retry Sign in." };
  }
  return null;
}
function lifecycleMessage(state, detail) {
  const messages = {
    "not-installed": "Node.js 20 or later with npm is required, or the pinned m365 CLI is not installed. Click Sign in to install it, or install Node.js 20+ and npm first.",
    "unsupported-platform": detail || "This operating system and architecture are not supported by the pinned m365 CLI.",
    "install-failed": detail || "The pinned m365 CLI could not be verified or installed. Check npm access and retry Sign in.",
    "installed-not-configured": "The pinned m365 CLI is ready. Sign in with your work or school Microsoft account in the browser.",
    "logged-out": "You are signed out. Click Sign in to start a browser sign-in.",
    "logged-in": "Microsoft Teams is connected.",
    "reauth-needed": "The Microsoft session needs a new sign-in. Click Sign in again to open the browser."
  };
  return messages[state] || detail || "Teams Client could not determine its current state.";
}
function credentialPublic(id, expectedFile, p) {
  try {
    const manifest = host.manifest();
    const entry = manifest && Array.isArray(manifest.credentials) ? manifest.credentials.find((item) => item && item.id === id) : null;
    if (!entry || typeof entry.file !== "string") return null;
    const declared = host.fs.expandHome(entry.file);
    if (!declared || !host.path.equal(declared, expectedFile)) return null;
    return parseJson(host.credentialPublic(id) || "");
  } catch {
    return null;
  }
}
function currentPublic(p) {
  return credentialPublic("teams-m365-current-connection", p.current, p);
}
function now() {
  const value = injectedClock ? Number(injectedClock()) : Date.now();
  return Number.isFinite(value) ? value : Date.now();
}
function sha256Hex(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 55296 && code <= 56319 && i + 1 < text.length) {
      const low2 = text.charCodeAt(i + 1);
      if (low2 >= 56320 && low2 <= 57343) {
        code = 65536 + (code - 55296 << 10) + (low2 - 56320);
        i++;
      } else code = 65533;
    } else if (code >= 56320 && code <= 57343) code = 65533;
    if (code < 128) bytes.push(code);
    else if (code < 2048) bytes.push(192 | code >> 6, 128 | code & 63);
    else if (code < 65536) bytes.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
    else bytes.push(240 | code >> 18, 128 | code >> 12 & 63, 128 | code >> 6 & 63, 128 | code & 63);
  }
  const bitLength = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 4294967296);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push(high >>> shift & 255);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push(low >>> shift & 255);
  const constants = [
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ];
  const state = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225];
  const words = new Array(64);
  const rotate = (value, bits) => value >>> bits | value << 32 - bits;
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 4;
      words[i] = (bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ x >>> 3;
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ y >>> 10;
      words[i] = words[i - 16] + s0 + words[i - 7] + s1 >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = e & f ^ ~e & g;
      const t1 = h + sum1 + choice + constants[i] + words[i] >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = a & b ^ a & c ^ b & c;
      const t2 = sum0 + majority >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    state[0] = state[0] + a >>> 0;
    state[1] = state[1] + b >>> 0;
    state[2] = state[2] + c >>> 0;
    state[3] = state[3] + d >>> 0;
    state[4] = state[4] + e >>> 0;
    state[5] = state[5] + f >>> 0;
    state[6] = state[6] + g >>> 0;
    state[7] = state[7] + h >>> 0;
  }
  return state.map((value) => value.toString(16).padStart(8, "0")).join("");
}
function senderFromFields(fields) {
  const accountId = String(fields && fields.accountId || "");
  const tenantId = String(fields && fields.tenantId || "");
  const upn = String(fields && fields.upn || "");
  if (!accountId || !tenantId || !upn) return null;
  return { id: accountId, accountId, tenantId, upn, identityKey: JSON.stringify([accountId, tenantId]) };
}
function previewSender() {
  const p = paths();
  const sender = p ? senderFromFields(currentPublic(p)) : null;
  if (!sender) return { error: "not-logged-in: Sign in with the intended work or school account and confirm that its tenant is available before previewing." };
  return { sender };
}
function liveSender() {
  const current = status();
  const reauthStates = ["conditional-access-blocked", "mfa-required", "consent-not-granted", "refresh-token-revoked", "token-expired"];
  if (reauthStates.includes(current.state)) return { error: `reauth-needed: ${current.state}. ${current.message}` };
  if (current.state === "reauth-needed") return { error: `reauth-needed: session status needs attention. ${current.message} Review the tenant sign-in and click Sign in again.` };
  if (["logged-out", "installed-not-configured"].includes(current.state)) return { error: "not-logged-in: Sign in to Teams Client with the intended work or school account before sending." };
  if (current.state !== "logged-in") return { error: `upstream-rejected: ${current.message} Resolve the Teams Client prerequisite, then review the preview again before sending.` };
  const sender = senderFromFields(current);
  if (!sender) return { error: "upstream-rejected: The active account, UPN, and tenant could not all be resolved. Refresh Teams Client status before approving a send." };
  if (sender.tenantId.toLowerCase() === PERSONAL_TENANT_ID) {
    return { error: "upstream-rejected: Delegated Teams chat send requires a work or school tenant. Sign in with the intended work or school account, then preview again." };
  }
  return { sender };
}
function policySummary() {
  const p = paths();
  if (!p) return { configured: false, mode: null, senderAccountId: null, senderTenantId: null, allowedDestinations: [] };
  let policy = null;
  try {
    policy = parseJson(host.fs.readFile(p.policy) || "");
  } catch {
    policy = null;
  }
  const destinations = policy && Array.isArray(policy.allowedDestinations) ? policy.allowedDestinations : [];
  if (!policy || policy.approved !== true || policy.mode !== INITIAL_SEND_POLICY_MODE || typeof policy.senderAccountId !== "string" || !policy.senderAccountId || typeof policy.senderTenantId !== "string" || !policy.senderTenantId || destinations.length !== 1 || !destinations[0] || !validChatId(String(destinations[0].id || "")) || typeof destinations[0].label !== "string") {
    return { configured: false, mode: null, senderAccountId: null, senderTenantId: null, allowedDestinations: [] };
  }
  return {
    configured: true,
    mode: INITIAL_SEND_POLICY_MODE,
    senderAccountId: policy.senderAccountId,
    senderTenantId: policy.senderTenantId,
    allowedDestinations: [{ id: String(destinations[0].id), label: String(destinations[0].label) }],
    approvedAt: Number(policy.approvedAt) || null
  };
}
function resolveDestination(id, sender) {
  if (!validChatId(id)) return { error: "destination-not-permitted: Usage: preview <immutable-chat-id> <text>. Choose an id from chats; display labels are not ids." };
  if (!cachedChats || cachedChats.identityKey !== sender.identityKey) {
    return { error: "upstream-rejected: Refresh chats for this account and tenant, then preview an immutable chat id." };
  }
  const chat = cachedChats.chats.find((item) => item.id === id);
  if (!chat) return { error: `destination-not-permitted: Chat id ${id} was not in the resolved chat list for tenant ${sender.tenantId}. Refresh chats and choose a listed id.` };
  return { destination: { id: String(chat.id), label: String(chat.topic || chat.id) } };
}
var previewSequence = 0;
function previewCommand(args) {
  if (args.length < 2 || !validChatId(args[0])) return { error: "Usage: preview <immutable-chat-id> <text>. Choose an id from chats; display labels are not accepted." };
  const text = args.slice(1).join(" ");
  if (!text.length) return { error: "upstream-rejected: Preview text must not be empty." };
  const resolved = previewSender();
  if ("error" in resolved) return resolved;
  const found = resolveDestination(args[0], resolved.sender);
  if ("error" in found) return found;
  const idempotencyKey = sha256Hex(`${resolved.sender.identityKey}\0${found.destination.id}\0${text}`);
  const previewId = sha256Hex(`${resolved.sender.identityKey}\0${found.destination.id}\0${text}\0${++previewSequence}`);
  previewTokens[previewId] = { sender: resolved.sender, destination: found.destination, text };
  return { result: JSON.stringify({
    previewId,
    idempotencyKey,
    sender: resolved.sender,
    tenant: { id: resolved.sender.tenantId },
    destination: found.destination,
    text,
    policy: policySummary()
  }) };
}
function setSendPolicy(args) {
  if (!args || args.approveDestination !== true) return { error: "No send policy was changed. Review the full sender, tenant, destination, and text preview, then explicitly approve that single chat." };
  const preview = previewTokens[String(args.previewId || "")];
  if (!preview) return { error: "Preview is unavailable. Refresh chats and create a fresh preview before approving a destination." };
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
      approvedAt: now()
    }));
    if (saved !== true) return { error: "upstream-rejected: The single-chat policy could not be saved; no destination is enabled." };
  } catch {
    return { error: "upstream-rejected: The single-chat policy could not be saved; no destination is enabled." };
  }
  return { result: JSON.stringify(policySummary()) };
}
function metadataFromM365(p) {
  const info = runtimeInfo(p);
  if ("state" in info) return null;
  const result = runProcess(info.target.node, ["-e", METADATA_READER], envFor(p));
  if (!result.ok) return null;
  const value = parseJson(result.stdout);
  if (!value || !Array.isArray(value.connections)) return null;
  return value;
}
function accountRows(source) {
  const rows = Array.isArray(source) ? source : [];
  const seen = /* @__PURE__ */ new Set();
  return rows.flatMap((raw) => {
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
      expiresOn: raw && typeof raw.expiresOn === "string" ? raw.expiresOn : null
    }];
  });
}
function status() {
  const target = targetState();
  if (target.state !== "ready" || !target.paths) return { state: target.state, message: lifecycleMessage(target.state, target.message), accounts: [] };
  const p = target.paths;
  if (!host.fs.fileExists(p.binary)) return { state: "not-installed", message: lifecycleMessage("not-installed"), accounts: [] };
  const protectedState = protectStorage(p);
  if (protectedState.error) return { state: "install-failed", message: protectedState.message || lifecycleMessage("install-failed"), accounts: [] };
  const run = runM365(["status", "--output", "json"]);
  if (!run.ok) {
    const reauth = authState(`${run.error}
${run.stderr}`);
    if (reauth) return { ...reauth, accounts: [] };
    return { state: "reauth-needed", message: lifecycleMessage("reauth-needed"), accounts: [] };
  }
  const value = parseJson(run.stdout.trim());
  if (!value || !value.connectionName) {
    const listed = runM365(["connection", "list", "--output", "json"]);
    const connections = listed.ok ? parseJson(listed.stdout.trim()) : null;
    return connections && connections.length > 0 ? { state: "logged-out", message: lifecycleMessage("logged-out"), accounts: accountRows(connections) } : { state: "installed-not-configured", message: lifecycleMessage("installed-not-configured"), accounts: [] };
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
    accounts: [{ id: accountId, accountId, tenantId: tenantId || null, upn, active: true, expiresOn: expiry }]
  };
}
function statusView() {
  const value = status();
  if (value.state === "logged-in" && value.upn && value.tenantId && value.expiresOn) {
    return { ...value, message: `Signed in as ${value.upn} in tenant ${value.tenantId}. Token expires ${value.expiresOn}.` };
  }
  if (value.state === "logged-in" && value.upn && value.tenantId) {
    return { ...value, message: `Signed in as ${value.upn} in tenant ${value.tenantId}. Token expiry is not available yet.` };
  }
  return value;
}
function jsonCommand(args) {
  const run = runM365(args.concat(["--output", "json"]));
  if (!run.ok) {
    const auth = authState(`${run.error}
${run.stderr}`);
    return { error: auth ? auth.message : "The m365 command failed. Refresh status and try again.", reauth: auth || void 0 };
  }
  const data = parseJson(run.stdout.trim());
  if (data === null) return { error: "m365 returned an unreadable JSON response." };
  return { data };
}
function agentAccounts() {
  const check = status();
  if (!["logged-in", "logged-out", "installed-not-configured"].includes(check.state)) return { error: check.message };
  const listed = jsonCommand(["connection", "list"]);
  if (listed.error) return { error: listed.error };
  const source = Array.isArray(listed.data) ? listed.data : [];
  const p = paths();
  const metadata = p ? metadataFromM365(p) : null;
  const connections = metadata && Array.isArray(metadata.connections) ? metadata.connections : [];
  const rows = source.flatMap((raw) => {
    if (!raw || typeof raw.name !== "string") return [];
    const detail = connections.find((item) => item && item.name === raw.name) || {};
    const accountId = String(detail.accountId || raw.name);
    return [{
      id: accountId,
      accountId,
      identityId: String(detail.identityId || ""),
      tenantId: detail.tenantId ? String(detail.tenantId) : null,
      upn: String(detail.upn || raw.connectedAs || ""),
      active: !!raw.active,
      expiresOn: raw.active && metadata && typeof metadata.expiresOn === "string" ? metadata.expiresOn : null
    }];
  });
  return { result: JSON.stringify({ accounts: accountRows(rows) }) };
}
function useAccount(id) {
  if (!id || id.length > 256 || /[\r\n\0]/.test(id)) return { error: "Usage: use <account-id>. Select an id from accounts; UPNs are not account ids." };
  const p = paths();
  if (!p) return { error: lifecycleMessage("unsupported-platform") };
  const listed = jsonCommand(["connection", "list"]);
  if (listed.error) return { error: listed.error };
  const source = Array.isArray(listed.data) ? listed.data : [];
  const metadata = metadataFromM365(p);
  const details = metadata && Array.isArray(metadata.connections) ? metadata.connections : [];
  const detail = details.find((raw) => raw && (raw.accountId === id || raw.identityId === id || raw.name === id));
  const selected = source.find((raw) => raw && raw.name === (detail && detail.name || id));
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
function validChatId(value) {
  return /^[A-Za-z0-9:._@-]{1,512}$/.test(value);
}
function agentChats() {
  const response = jsonCommand(["teams", "chat", "list"]);
  if (response.error) return { error: response.error };
  const source = Array.isArray(response.data) ? response.data : [];
  const chats = source.flatMap((raw) => {
    const id = typeof raw?.id === "string" ? raw.id : "";
    if (!validChatId(id)) return [];
    return [{
      id,
      topic: typeof raw.topic === "string" ? raw.topic : null,
      chatType: typeof raw.chatType === "string" ? raw.chatType : null,
      tenantId: typeof raw.tenantId === "string" ? raw.tenantId : null,
      lastUpdatedDateTime: typeof raw.lastUpdatedDateTime === "string" ? raw.lastUpdatedDateTime : null
    }];
  });
  const sender = previewSender();
  cachedChats = "sender" in sender ? { identityKey: sender.sender.identityKey, chats } : null;
  return { result: JSON.stringify({ chats }) };
}
function utf8Bytes(value) {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 55296 && code <= 56319 && i + 1 < value.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
function textFromHtml(value) {
  return value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}
function cutText(value, units) {
  let end = Math.max(0, Math.min(value.length, units));
  if (end > 0 && end < value.length) {
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (last >= 55296 && last <= 56319 && next >= 56320 && next <= 57343) end--;
  }
  return value.slice(0, end);
}
function boundedHistory(chatId, source, count, maxBytes) {
  const capCount = Math.max(1, Math.min(MAX_COUNT, Math.floor(count)));
  const capBytes = Math.max(1024, Math.min(MAX_BYTES, Math.floor(maxBytes)));
  const ordered = (Array.isArray(source) ? source : []).map((raw) => ({
    id: String(raw && raw.id || ""),
    createdDateTime: String(raw && raw.createdDateTime || ""),
    from: String(raw && (raw.from || raw.sender) || ""),
    content: textFromHtml(String(raw && (raw.content || raw.body?.content) || "")),
    untrusted: true
  })).sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime)).slice(-capCount);
  const out = { chatId, messages: [], truncated: false };
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
      const clipped2 = { ...message, content: cutText(message.content, middle) };
      if (utf8Bytes(JSON.stringify({ ...out, messages: [clipped2] })) <= capBytes) {
        best = clipped2.content;
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
function settings() {
  const value = parseJson(host.settingsJson()) || {};
  const count = Number(value.historyCount);
  const bytes = Number(value.historyMaxBytes);
  return {
    historyCount: Number.isInteger(count) ? Math.max(1, Math.min(MAX_COUNT, count)) : 20,
    historyMaxBytes: Number.isInteger(bytes) ? Math.max(1024, Math.min(MAX_BYTES, bytes)) : MAX_BYTES
  };
}
function agentHistory(args) {
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
  if (!chats.some((chat) => chat && chat.id === args[0])) return { error: "That chat id is not in the current chat list. Use an immutable id returned by chats, not a display name." };
  const query = `sort_by(@, &createdDateTime)[-${count}:].{id:id,createdDateTime:createdDateTime,from:from.user.displayName,content:body.content}`;
  const history = jsonCommand(["teams", "chat", "message", "list", "--chatId", args[0], "--query", query]);
  if (history.error) return { error: history.error };
  const result = boundedHistory(args[0], Array.isArray(history.data) ? history.data : [], count, configured.historyMaxBytes);
  return { result: JSON.stringify(result) };
}
function failureMessage(kind, detail, cause) {
  switch (kind) {
    case "not-logged-in":
      return "not-logged-in: Open Teams Client, sign in with the intended work or school account, and confirm its tenant before sending.";
    case "reauth-needed":
      return `reauth-needed: ${String(cause || "reauth-needed")}. ${String(detail || "The Microsoft session needs a new sign-in. Click Sign in again and complete the tenant's required authentication step.")}`;
    case "policy-not-set":
      return "policy-not-set: Review the resolved account, tenant, destination, and exact text in Teams Client, then explicitly approve that single chat before sending.";
    case "destination-not-permitted":
      return `destination-not-permitted: Only the owner's approved immutable chat id is allowed (${String(detail || "no destination is approved")}). Select that exact chat or review a new preview before changing policy.`;
    case "rate-limited":
      return `rate-limited: Microsoft 365 throttled this operation. Review Teams Client status and the selected chat before deciding what to do.`;
    case "upstream-rejected":
      return `upstream-rejected: m365 refused the operation (${String(detail || "inspect the Microsoft 365 error and correct its cause")}). Correct the permission or request issue, then invoke send again only if you still want delivery.`;
    case "unknown":
      return `unknown: ${String(detail || "Microsoft 365 may have accepted this message but confirmation was lost.")} Do not retry this idempotency key; inspect the selected chat and decide manually.`;
  }
  const exhaustive = kind;
  return exhaustive;
}
function loadOutbox(p) {
  try {
    if (!host.fs.fileExists(p.outbox)) return { ledger: { schema: 1, attempts: [] } };
    const value = parseJson(host.fs.readFile(p.outbox) || "");
    if (!value || value.schema !== 1 || !Array.isArray(value.attempts)) return { error: "the existing outbox ledger is unreadable" };
    const states = ["pending", "sent", "rate_limited", "failed", "unknown"];
    const valid = value.attempts.every((item) => item && typeof item.idempotencyKey === "string" && typeof item.payloadHash === "string" && /^[a-f0-9]{64}$/.test(item.payloadHash) && states.includes(item.state) && item.sender && typeof item.sender.accountId === "string" && typeof item.sender.tenantId === "string" && typeof item.sender.identityKey === "string" && item.destination && validChatId(String(item.destination.id || "")) && typeof item.destination.label === "string" && Number.isFinite(Number(item.createdAt)) && Number.isFinite(Number(item.updatedAt)) && Number.isInteger(item.sendCount) && item.sendCount >= 0);
    if (!valid) return { error: "the existing outbox ledger contains an invalid or unrecognized attempt state" };
    return { ledger: value };
  } catch {
    return { error: "the existing outbox ledger could not be read" };
  }
}
function persistOutbox(p, ledger) {
  try {
    if (!host.fs.makeDirs(p.root)) return false;
    return host.fs.writeFile(p.outbox, JSON.stringify(ledger)) === true;
  } catch {
    return false;
  }
}
function rememberSendFailure(kind, message) {
  lastSendState = { state: kind, message, updatedAt: now() };
  return { error: message };
}
function sendFailureResult(kind, detail, cause) {
  return rememberSendFailure(kind, failureMessage(kind, detail, cause));
}
function rememberPrefixedFailure(message) {
  const state = message.slice(0, message.indexOf(":"));
  const allowed = ["not-logged-in", "reauth-needed", "policy-not-set", "destination-not-permitted", "rate-limited", "upstream-rejected", "unknown"];
  return allowed.includes(state) ? rememberSendFailure(state, message) : sendFailureResult("upstream-rejected", "The command input could not be resolved; review its immutable ids and text.");
}
function parseSendArgs(args) {
  if (args.length < 2 || !validChatId(args[0])) return { error: "destination-not-permitted: Usage: send <immutable-chat-id> [--key <idempotency-key>] <text>. Choose an id from chats; labels are not ids." };
  let start = 1;
  let key;
  if (args[1] === "--key") {
    if (args.length < 4 || !/^[A-Za-z0-9._:-]{1,160}$/.test(args[2])) return { error: "upstream-rejected: --key needs a 1\u2013160 character idempotency key, followed by message text." };
    key = args[2];
    start = 3;
  }
  const text = args.slice(start).join(" ");
  if (!text.length) return { error: "upstream-rejected: Message text must not be empty." };
  return { chatId: args[0], text, key };
}
function failureForUpstream(message) {
  const auth = authState(message);
  if (auth) return { kind: "reauth-needed", detail: auth.message, cause: auth.state };
  if (/not signed in|not logged in|no active connection|logged out|run m365 login/i.test(message)) return { kind: "not-logged-in" };
  if (/\b429\b|\b503\b|too many requests|throttl|service unavailable/i.test(message)) {
    return { kind: "unknown", detail: "m365 may have retried this throttled send internally and may have delivered the message." };
  }
  if (/timeout|timed out|deadline exceeded|connection reset|connection closed|unexpected EOF|\bEOF\b|broken pipe|lost response|context cancel+ed|terminated|signal|killed|did not finish|could not confirm|unconfirmed/i.test(message)) return { kind: "unknown" };
  const code = message.match(/\b(?:HTTP|status(?: code)?)\s*[:=]?\s*(4\d\d|5\d\d)\b/i);
  return { kind: "upstream-rejected", detail: code ? `HTTP ${code[1]}; inspect the Microsoft 365 permission or request detail, correct it, then review before retrying` : "m365 returned a definitive non-zero result; inspect Teams Client status and permissions before deciding whether to invoke again" };
}
function runTeamsSend(args) {
  const target = targetState();
  if (!target.paths) return { ok: false, error: target.message, stderr: "" };
  if (target.state !== "ready") return { ok: false, error: target.message, stderr: "" };
  const p = target.paths;
  if (!host.fs.fileExists(p.binary)) return { ok: false, error: "m365 is not installed. Open Teams Client and sign in to install the pinned CLI.", stderr: "" };
  const secured = protectStorage(p);
  if (secured.error) return { ok: false, error: secured.message || "Could not secure the m365 runtime.", stderr: "" };
  const securedCache = protectCacheFiles(p);
  if (securedCache.error) return { ok: false, error: securedCache.message || "Could not protect m365 cache files before send.", stderr: "" };
  let started;
  try {
    started = host.exec.start({ bin: nativePath(p.binary), args, env: envFor(p) });
  } catch (error) {
    return { ok: false, error: `Could not confirm m365 send process start: ${String(error)}`, stderr: "" };
  }
  if (!started || !started.jobId) return { ok: false, error: `Could not confirm m365 send process start: ${started && started.error || "no job id was returned"}`, stderr: "" };
  let result;
  try {
    result = host.awaitJob(started.jobId, (value) => value);
  } catch (error) {
    return { ok: false, error: `m365 send process outcome could not be confirmed: ${String(error)}`, stderr: "" };
  }
  if (!result || result.done !== true) return { ok: false, error: "m365 send process did not finish; delivery outcome is unknown.", stderr: "" };
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (result.error) return { ok: false, error: `m365 send process returned an unconfirmed result: ${String(result.error)}`, stderr, code: result.code };
  if (typeof result.code !== "number") return { ok: false, error: "m365 send process finished without an exit status; delivery outcome is unknown.", stderr };
  if (result.code !== 0) return { ok: false, error: stderr || stdout || `m365 exited ${result.code}`, stderr, code: result.code };
  return { ok: true, stdout, stderr };
}
function messageIdFromOutput(output) {
  const value = parseJson(output.trim());
  const data = value && (value.data || value);
  const id = data && (data.id || data.messageId);
  return id === void 0 || id === null ? void 0 : String(id);
}
function attemptResult(attempt) {
  lastSendState = { state: "sent", message: "m365 confirmed the message and the sent result is recorded in the Teams Client outbox.", updatedAt: now() };
  return { result: JSON.stringify({
    status: "sent",
    sender: attempt.sender,
    tenant: { id: attempt.sender.tenantId },
    destination: attempt.destination,
    idempotencyKey: attempt.idempotencyKey,
    graphMessageId: attempt.graphMessageId || null,
    deliveryGuarantee: "The plugin returns a recorded success for a sent idempotency key and never resends that key. m365 does not surface the Graph message id on success; ambiguous outcomes remain unknown. This is not an exactly-once delivery guarantee."
  }) };
}
function persistFailure(p, ledger, attempt, kind, detail, cause) {
  attempt.failure = kind;
  attempt.failureCause = cause;
  attempt.failureMessage = failureMessage(kind, detail, cause);
  attempt.updatedAt = now();
  delete attempt.retryAfter;
  if (kind === "unknown") {
    attempt.state = "unknown";
  } else {
    attempt.state = "failed";
  }
  if (!persistOutbox(p, ledger)) {
    attempt.state = "unknown";
    attempt.failure = "unknown";
    attempt.failureCause = void 0;
    attempt.failureMessage = failureMessage("unknown");
    persistOutbox(p, ledger);
    return rememberSendFailure("unknown", attempt.failureMessage);
  }
  return rememberSendFailure(kind, attempt.failureMessage);
}
function sendCommand(sessionId, args) {
  const parsed = parseSendArgs(args);
  if ("error" in parsed) return rememberPrefixedFailure(parsed.error);
  const policy = policySummary();
  if (!policy.configured) return sendFailureResult("policy-not-set");
  const permitted = policy.allowedDestinations.find((item) => item.id === parsed.chatId);
  if (!permitted) return sendFailureResult("destination-not-permitted", policy.allowedDestinations[0]?.id);
  const expectedIdentity = JSON.stringify([policy.senderAccountId, policy.senderTenantId]);
  const key = parsed.key || sha256Hex(`${expectedIdentity}\0${parsed.chatId}\0${parsed.text}`);
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
      sendCount: 0
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
  const run = runTeamsSend(["teams", "chat", "message", "send", "--chatId", parsed.chatId, "--message", parsed.text, "--output", "json"]);
  if (!run.ok) {
    const upstream = failureForUpstream(`${run.error}
${run.stderr}`);
    return persistFailure(p, ledger, attempt, upstream.kind, upstream.detail, upstream.cause);
  }
  attempt.graphMessageId = messageIdFromOutput(run.stdout);
  attempt.state = "sent";
  attempt.updatedAt = now();
  delete attempt.failure;
  delete attempt.failureCause;
  delete attempt.failureMessage;
  if (!persistOutbox(p, ledger)) return persistFailure(p, ledger, attempt, "unknown");
  return attemptResult(attempt);
}
function logout() {
  const target = targetState();
  if (target.state !== "ready") return { error: lifecycleMessage(target.state, target.message) };
  const p = target.paths;
  if (!host.fs.fileExists(p.binary)) {
    cachedChats = null;
    clearPreviewTokens();
    return { result: "Logged out. No m365 runtime is installed." };
  }
  const run = runM365(["logout"]);
  if (!run.ok) {
    const reauth = authState(`${run.error}
${run.stderr}`);
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
function onAgentCommand(ctx) {
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  switch (ctx.verb) {
    case "accounts":
      return agentAccounts();
    case "use":
      return args.length === 1 ? useAccount(args[0]) : { error: "Usage: use <account-id>." };
    case "chats":
      return agentChats();
    case "history":
      return agentHistory(args);
    case "health":
      return { result: JSON.stringify({ ...statusView(), sendPolicy: policySummary(), lastSend: lastSendState }) };
    case "logout":
      return logout();
    case "send":
      return sendCommand(ctx.sessionId, args);
    case "preview":
      return previewCommand(args);
    default:
      return { error: `Unknown Teams Client verb: ${ctx.verb}` };
  }
}
function loginStart() {
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
  let started;
  try {
    started = host.exec.start({ bin: nativePath(target.paths.binary), args, env: envFor(target.paths), detach: true });
  } catch (error) {
    return { error: String(error), state: "install-failed" };
  }
  if (!started.jobId) return { error: started.error || "m365 browser sign-in did not start.", state: "install-failed" };
  loginJobs[started.jobId] = true;
  return { jobId: started.jobId, state: "login-in-progress", message: "A browser should open for Microsoft sign-in. Complete the work or school sign-in, then click Check sign-in status." };
}
function loginPoll(jobId) {
  if (!jobId || !loginJobs[jobId]) return { error: "Unknown Microsoft sign-in job." };
  let poll;
  try {
    poll = host.exec.poll(jobId);
  } catch {
    return { error: "Could not read the Microsoft browser sign-in job." };
  }
  if (!poll.done) return { done: false, state: "login-in-progress", message: "Complete the sign-in in the browser, then check status again." };
  delete loginJobs[jobId];
  const p = paths();
  if (!p) return { done: true, state: "unsupported-platform", error: lifecycleMessage("unsupported-platform") };
  const secured = protectCacheFiles(p);
  if (secured.error) return { done: true, state: "install-failed", error: secured.message || lifecycleMessage("install-failed") };
  if (poll.error || poll.code !== 0) {
    const reason = `${poll.error || ""}
${poll.stderr || ""}
${poll.stdout || ""}`;
    const auth = authState(reason);
    return { done: true, state: auth ? auth.state : "reauth-needed", error: auth ? auth.message : lifecycleMessage("reauth-needed") };
  }
  const current = statusView();
  if (current.state !== "logged-in") return { done: true, state: current.state, error: current.message };
  return { done: true, state: "logged-in", account: current, message: current.message };
}
function viewCall(method, args) {
  const value = args || {};
  if (method === "status") return statusView();
  if (method === "loginStart") return loginStart();
  if (method === "loginPoll") return loginPoll(String(value.jobId || ""));
  if (method === "useAccount") return useAccount(String(value.id || ""));
  if (method === "logout") return logout();
  if (method === "chats") return agentChats();
  if (method === "policy") return policySummary();
  if (method === "preview") return previewCommand([String(value.chatId || ""), String(value.text || "")]);
  if (method === "approveSendPolicy") return setSendPolicy(value);
  if (method === "send") return sendCommand("teams-client-view", [String(value.chatId || ""), "--key", String(value.idempotencyKey || ""), String(value.text || "")]);
  return { error: `Unknown Teams Client view method: ${method}` };
}
function renderGlance() {
  const p = paths();
  const current = p ? currentPublic(p) : null;
  const account = current || {};
  const installed = !!(p && host.fs.fileExists(p.binary));
  const connected = !!account.accountId;
  const nodes = [{ kind: "badge", label: connected ? "Connected" : installed ? "Sign-in needed" : "m365 not installed", tone: connected ? "ok" : installed ? "warn" : "muted" }];
  nodes.push({ kind: "text", text: connected ? `${account.upn || "Account resolved"} \xB7 ${account.tenantId || "tenant unavailable"}` : "Open Teams Client to check status or sign in.", style: { tone: "muted" } });
  const policy = policySummary();
  nodes.push({ kind: "text", text: policy.configured ? `Send policy: one chat \xB7 ${policy.allowedDestinations[0].id} \xB7 tenant ${policy.senderTenantId}` : "Send policy: not approved", style: { tone: policy.configured ? "warn" : "muted" } });
  if (lastSendState) nodes.push({ kind: "text", text: `Last send: ${lastSendState.state} \xB7 ${lastSendState.message}`, style: { tone: lastSendState.state === "sent" ? "ok" : "warn" } });
  return { title: "Teams Client", nodes };
}
var plugin = {
  onAgentCommand,
  renderGlance,
  viewCall,
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
  __test_setClock: (clock) => {
    injectedClock = clock;
  },
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
  __test_metadataReader: METADATA_READER
};
var plugin_default = plugin;
