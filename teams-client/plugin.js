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

// shared/src/send-scope.ts
var ALL_CHATS = { mode: "all" };
var MAX_SCOPE_CHATS = 200;
function scopeChats(value, validId) {
  if (!Array.isArray(value) || value.length > MAX_SCOPE_CHATS) return null;
  const out = [];
  for (const item of value) {
    const id = item && typeof item.id === "string" ? item.id : "";
    if (!validId(id)) return null;
    if (out.some((chat) => chat.id === id)) continue;
    out.push({ id, title: typeof item.title === "string" ? item.title.slice(0, 200) : "" });
  }
  return out;
}
function parseSendScope(raw, validId) {
  if (raw === null || raw === void 0 || raw === "") return ALL_CHATS;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { mode: "only", chats: [] };
  }
  if (value && value.mode === "all") return ALL_CHATS;
  const chats = value && value.mode === "only" ? scopeChats(value.chats, validId) : null;
  return { mode: "only", chats: chats || [] };
}
function validateSendScope(value, validId) {
  if (value && value.mode === "all") return ALL_CHATS;
  if (!value || value.mode !== "only") return { error: "Choose a restriction mode: all or only." };
  const chats = scopeChats(value.chats, validId);
  if (!chats) return { error: `List up to ${MAX_SCOPE_CHATS} chats by their immutable ids.` };
  return { mode: "only", chats };
}
function decideSend(scope, chatId, origin) {
  if (origin === "view" || scope.mode === "all") return { allow: true };
  if (scope.chats.some((chat) => chat.id === chatId)) return { allow: true };
  const allowed = scope.chats.length ? scope.chats.map((chat) => chat.title || chat.id).join(", ") : "no chats";
  return {
    allow: false,
    reason: "chat-not-allowed",
    message: `chat-not-allowed: The owner's "Restrict agent sends" setting permits only these chats: ${allowed}. ${chatId} is not one of them. Ask the owner to add it in the plugin view (Restrict agent sends) or to switch the setting back to all chats.`
  };
}
var CYRILLIC = {
  \u0430: "a",
  \u0431: "b",
  \u0432: "v",
  \u0433: "g",
  \u0434: "d",
  \u0435: "e",
  \u0451: "e",
  \u0436: "zh",
  \u0437: "z",
  \u0438: "i",
  \u0439: "y",
  \u043A: "k",
  \u043B: "l",
  \u043C: "m",
  \u043D: "n",
  \u043E: "o",
  \u043F: "p",
  \u0440: "r",
  \u0441: "s",
  \u0442: "t",
  \u0443: "u",
  \u0444: "f",
  \u0445: "kh",
  \u0446: "ts",
  \u0447: "ch",
  \u0448: "sh",
  \u0449: "shch",
  \u044A: "",
  \u044B: "y",
  \u044C: "",
  \u044D: "e",
  \u044E: "yu",
  \u044F: "ya",
  \u0456: "i",
  \u0457: "yi",
  \u0454: "ye",
  \u0491: "g"
};
function words(value) {
  const latin = Array.from(value.toLowerCase().normalize("NFC")).map((ch) => CYRILLIC[ch] ?? ch).join("");
  return latin.normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
}
function matchChats(chats, query, limit = 20) {
  const raw = query.trim().toLowerCase();
  const tokens = words(raw);
  if (!tokens.length) return { match: null, ambiguous: false, candidates: [] };
  const byId = chats.filter((chat) => chat.id.toLowerCase() === raw);
  if (byId.length === 1) return { match: byId[0], ambiguous: false, candidates: byId };
  const hits = chats.filter((chat) => {
    const haystack = words(`${chat.title} ${chat.username || ""}`);
    return tokens.every((token) => haystack.some((word) => word.startsWith(token)));
  });
  const key = tokens.join(" ");
  const exact = hits.filter((chat) => words(chat.title).join(" ") === key || !!chat.username && words(chat.username).join(" ") === key);
  const match = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
  return { match, ambiguous: !match && hits.length > 1, candidates: hits.slice(0, limit) };
}

// teams-client/src/plugin.ts
var VERSION = "11.11.0";
var PACKAGE = "@pnp/cli-microsoft365";
var DEFAULT_APP_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
var APP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var ROOT = "~/.codeterm/teams-client";
var GRAPH = "https://graph.microsoft.com/v1.0";
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
var LOOPBACK_REFUSED = ["wrong-client-redirect", "loopback-unavailable"];
var SIGN_IN_TTL_MS = 10 * 60 * 1e3;
var SIGN_IN_MARKER = "codeterm-signin:";
var PREPARING_SIGN_IN_MESSAGE = "The Microsoft sign-in link is being prepared. Poll login-status until it returns signInUrl.";
var PREPARING_CODE_MESSAGE = "The Microsoft sign-in code is being prepared. Poll login-status until it returns signInUrl and deviceCode.";
var SIGN_IN_WRAPPER = "const fs=require('node:fs');const path=require('node:path');const {pathToFileURL}=require('node:url');const [lease,nonce,ttl,...cli]=process.argv.slice(1);const say=s=>process.stderr.write('" + SIGN_IN_MARKER + " '+s+'\\n');const owned=()=>{try{return fs.readFileSync(lease,'utf8').trim()===nonce}catch{return false}};const stop=(s,c)=>{say(s);process.exit(c)};if(!owned())stop('cancelled',3);setInterval(()=>{if(!owned())stop('cancelled',3)},1000).unref();setTimeout(()=>stop('expired',4),Number(ttl)||600000).unref();process.env.CLIMICROSOFT365_NOUPDATE='1';const dist=path.resolve(process.env.M365_RUNTIME,'node_modules/@pnp/cli-microsoft365/dist');const load=f=>import(pathToFileURL(path.join(dist,f)).href);load('utils/browserUtil.js').then(async m=>{m.browserUtil.open=async url=>say('url '+url);process.argv=[process.argv[0],path.join(dist,'index.js'),...cli];await load('index.js')}).catch(e=>{process.stderr.write('Error: '+String(e&&e.message||e).split('\\n')[0]+'\\n');process.exit(1)});";
var loginJobs = {};
var activeLoginJobId = null;
var runtimeInfoCache = {};
var storageProtectionCache = {};
var cacheProtectionCache = {};
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
      scope: joinPath(root, "send-scope.json")
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
  let result;
  try {
    result = parseJson(host.exec(JSON.stringify({ bin, args, env, timeoutMs: 4500 })));
  } catch (error) {
    return { ok: false, error: String(error), stderr: "" };
  }
  if (!result) return { ok: false, error: `${bin} returned an unreadable process result.`, stderr: "" };
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (result.error) return { ok: false, error: String(result.error), stderr, code: result.code };
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
  if (runtimeInfoCache[p.root]) return runtimeInfoCache[p.root];
  const result = computeRuntimeInfo(p);
  runtimeInfoCache[p.root] = result;
  return result;
}
function computeRuntimeInfo(p) {
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
  if (storageProtectionCache[p.root]) return storageProtectionCache[p.root];
  const result = applyStorageProtection(p);
  storageProtectionCache[p.root] = result;
  return result;
}
function installedPackageVersion(p) {
  const manifest = host.fs.readJson(joinPath(p.runtime, `node_modules/${PACKAGE}/package.json`));
  return manifest?.name === PACKAGE ? String(manifest.version || "") : "";
}
function windowsAclCommands(root, principal) {
  return [[root, "/inheritance:r", "/grant:r", `${principal}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/C"]];
}
var ACL_MARKER = ".acl-restricted";
function applyStorageProtection(p) {
  for (const dir of [p.root, p.home, p.runtime, p.npmCache]) {
    try {
      if (!host.fs.makeDirs(dir)) return { error: "storage-protection-failed", message: "Could not create the plugin-owned private runtime directory." };
    } catch {
      return { error: "storage-protection-failed", message: "Could not create the plugin-owned private runtime directory." };
    }
  }
  if (host.path.isWindows) {
    const marker = joinPath(p.root, ACL_MARKER);
    if (host.fs.fileExists(marker)) return {};
    const names = binaryNamesForHost();
    const env2 = envFor(p);
    const who = runProcess(names.whoami, [], env2);
    const principal = who.ok ? who.stdout.trim() : "";
    if (!principal || /[\r\n]/.test(principal)) return { error: "storage-protection-failed", message: "Could not identify the Windows account for the plugin cache ACL." };
    for (const args of windowsAclCommands(nativePath(p.root), principal)) {
      const acl = runProcess(names.icacls, args, env2);
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
function protectCacheFiles(p, force = false) {
  if (!force && cacheProtectionCache[p.root]) return cacheProtectionCache[p.root];
  const result = applyCacheFileProtection(p);
  cacheProtectionCache[p.root] = result;
  return result;
}
function applyCacheFileProtection(p) {
  if (host.path.isWindows) return protectStorage(p);
  const env = envFor(p);
  for (const file of [p.msal, p.current, p.all]) {
    if (!host.fs.fileExists(file)) continue;
    const chmod = runProcess("chmod", ["600", nativePath(file)], env);
    if (!chmod.ok) return { error: "storage-protection-failed", message: "Could not restrict an m365 credential cache file." };
  }
  return {};
}
function startLoginProcess(p, target, stage, args, packagePath, authType = "browser", leaseFile, appId = configuredAppId()) {
  let started;
  const bin = stage === "pack" || stage === "install" ? target.npm : target.node;
  const logFile = stage === "browser" ? joinPath(p.root, `login-${authType}.log`) : void 0;
  if (logFile) try {
    host.fs.removeFile(logFile);
  } catch {
  }
  const detach = stage === "browser";
  try {
    started = host.exec.start({ bin, args, env: envFor(p), timeoutMs: 12e4, detach, ...logFile ? { logFile } : {} });
  } catch {
    return { error: `Could not start the m365 ${stage} step.` };
  }
  if (!started.jobId) return { error: started.error || `The m365 ${stage} step did not start.` };
  loginJobs[started.jobId] = { stage, paths: p, target, packagePath, authType, appId, logFile, leaseFile, startedAt: stage === "browser" ? now() : void 0 };
  activeLoginJobId = started.jobId;
  return { jobId: started.jobId };
}
function leasePath(p) {
  return joinPath(p.root, "login.lease");
}
function cancelPendingSignIn() {
  const jobId = activeLoginJobId;
  const login = jobId ? loginJobs[jobId] : null;
  const p = login?.paths || paths();
  if (p) try {
    host.fs.removeFile(leasePath(p));
  } catch {
  }
  if (!jobId || !login || login.stage !== "browser") return false;
  try {
    host.exec.close(jobId);
  } catch {
  }
  finishLoginJob(jobId, "sign-in-cancelled");
  return true;
}
function installM365(authType) {
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
function packageFromPackResult(p, target, stdout) {
  const packed = parseJson(stdout);
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
    try {
      host.fs.removeFile(packagePath);
    } catch {
    }
    return { error: "The local m365 package checksum did not match the pinned SHA-512." };
  }
  return { path: packagePath };
}
function finishLoginJob(jobId, state, error) {
  const login = loginJobs[jobId];
  if (login?.packagePath) {
    try {
      host.fs.removeFile(login.packagePath);
    } catch {
    }
  }
  if (login?.logFile) {
    try {
      host.fs.removeFile(login.logFile);
    } catch {
    }
  }
  delete loginJobs[jobId];
  if (activeLoginJobId === jobId) activeLoginJobId = null;
  return { done: true, state, error, jobId };
}
function startBrowserLogin(p, target, authType = "browser") {
  const lease = leasePath(p);
  const nonce = `${now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  if (!host.fs.writeFile(lease, nonce)) return { error: "Could not prepare the Microsoft sign-in lease file." };
  const appId = configuredAppId();
  const args = ["-e", SIGN_IN_WRAPPER, nativePath(lease), nonce, String(SIGN_IN_TTL_MS), "login", "--authType", authType, "--appId", appId, "--output", "json"];
  return startLoginProcess(p, target, "browser", args, void 0, authType, lease, appId);
}
function signInLogFailure(text, appId) {
  const known = authState(text, appId);
  if (known) return known;
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || "";
  return /^Error:/.test(last) ? { state: "sign-in-failed", message: `Microsoft sign-in failed: ${last.slice(6).trim()}` } : null;
}
var AUTHORIZE_URL = /^https:\/\/login\.(?:microsoftonline\.(?:com|us)|chinacloudapi\.cn|partner\.microsoftonline\.cn)\/[\w.-]+\/oauth2\/(?:v2\.0\/)?authorize\?\S*redirect_uri=http:\/\/localhost:\d+\S*$/;
var DEVICE_LOGIN_URL = /https?:\/\/(?:aka\.ms|microsoft\.com)\/devicelogin\b[^\s<>"']*/i;
var USER_CODE = /^[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?$|^[A-Z0-9]{6,12}$/i;
function parseSignInLog(text, appId) {
  const raw = String(text || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const markers = lines.filter((line) => line.startsWith(SIGN_IN_MARKER)).map((line) => line.slice(SIGN_IN_MARKER.length).trim());
  if (markers.includes("cancelled")) return { state: "cancelled" };
  if (markers.includes("expired")) return { state: "expired" };
  const failure = signInLogFailure(lines.filter((line) => !line.startsWith(SIGN_IN_MARKER)).join("\n"), appId);
  if (failure) return { state: "failed", failure };
  const browserUrl = markers.filter((marker) => marker.startsWith("url ")).map((marker) => marker.slice(4).trim()).reverse().find((url) => AUTHORIZE_URL.test(url));
  if (browserUrl) return { state: "awaiting-browser", signInUrl: browserUrl };
  const parsed = parseJson(raw.trim());
  const codeMatch = raw.match(/(?:enter|use)\s+(?:the\s+)?(?:login\s+)?(?:code\s+)?([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?|[A-Z0-9]{6,12})\b/i) || raw.match(/\b(?:device|user|sign-in|login)\s+code\s*[:=]?\s*([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?|[A-Z0-9]{6,12})\b/i);
  const candidateUrl = String(parsed?.signInUrl || parsed?.verificationUri || parsed?.verificationUrl || "");
  const candidateCode = String(parsed?.deviceCode || parsed?.userCode || "");
  const signInUrl = (raw.match(DEVICE_LOGIN_URL)?.[0] || candidateUrl.match(DEVICE_LOGIN_URL)?.[0])?.replace(/[),.;]+$/, "");
  const deviceCode = USER_CODE.test(candidateCode) ? candidateCode : codeMatch?.[1];
  return signInUrl && deviceCode ? { state: "awaiting-device-code", signInUrl, deviceCode } : { state: "starting" };
}
function readSignInLog(login) {
  return login.logFile ? parseSignInLog(String(host.fs.readFileTail(login.logFile, 8192) || ""), login.appId) : { state: "starting" };
}
function signInArtifacts(log) {
  if (log.state === "awaiting-browser") return { signInUrl: log.signInUrl };
  if (log.state === "awaiting-device-code") return { signInUrl: log.signInUrl, deviceCode: log.deviceCode };
  return {};
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
  if (!host.fs.fileExists(p.binary)) return { ok: false, error: "m365 is not installed. Run `codeterm plugin teams-client login` (or Sign in in the view) to install the pinned CLI.", stderr: "" };
  const secured = protectStorage(p);
  if (secured.error) return { ok: false, error: secured.message || "Could not secure the m365 runtime.", stderr: "" };
  const result = runProcess(nativePath(p.binary), args, envFor(p));
  return result;
}
function upstreamLine(text, pattern) {
  const line = String(text || "").split(/\r?\n/).map((item) => item.trim()).find((item) => pattern.test(item)) || "";
  return line.replace(/eyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g, "[redacted]").replace(/\b((?:code|access_token|refresh_token|id_token|client_secret)=)[^&\s"']+/gi, "$1[redacted]").replace(/^Error:\s*/, "").slice(0, 400);
}
function quoted(line) {
  return line ? ` Microsoft said: "${line}"` : "";
}
var REDIRECT_REFUSED = /AADSTS50011|AADSTS500113|redirect_uri_mismatch|redirect URI[^\n]*does not match|reply (?:url|address)[^\n]*(?:does not match|not registered)/i;
var CONSENT_REQUIRED = /AADSTS65001|AADSTS65004|AADSTS90094|AADSTS90095|consent_required|consent[^\n]*(?:not granted|withdrawn|revoked|removed)|(?:withdrawn|revoked|removed)[^\n]*consent|admin(?:istrator)? (?:consent|approval)|has not consented|Missing scope permissions|API requires one of/i;
var LOOPBACK_UNAVAILABLE = /listen (?:EADDRINUSE|EACCES|EADDRNOTAVAIL)|EADDRINUSE[^\n]*(?:127\.0\.0\.1|localhost|::1)/i;
function authState(text, appId) {
  const value = String(text || "");
  if (REDIRECT_REFUSED.test(value)) {
    return { state: "wrong-client-redirect", message: `Microsoft refused the localhost sign-in link because app id ${appId || "in use"} has no http://localhost redirect registered.${quoted(upstreamLine(value, REDIRECT_REFUSED))} Run login --device-code, or set Sign-in app id to ${DEFAULT_APP_ID} (Microsoft Graph Command Line Tools) in Teams Client settings and sign in again.` };
  }
  if (CONSENT_REQUIRED.test(value)) {
    return { state: "consent-required", message: `Microsoft Graph consent is missing for app id ${appId || DEFAULT_APP_ID}.${quoted(upstreamLine(value, CONSENT_REQUIRED))} A tenant administrator must approve the delegated permissions Chat.ReadWrite and ChatMessage.Send for that app once (for example Connect-MgGraph -Scopes Chat.ReadWrite,ChatMessage.Send with Consent on behalf of your organization), then sign in again.` };
  }
  if (LOOPBACK_UNAVAILABLE.test(value)) {
    return { state: "loopback-unavailable", message: `m365 could not open its localhost sign-in listener.${quoted(upstreamLine(value, LOOPBACK_UNAVAILABLE))} Run login --device-code to sign in with a code instead.` };
  }
  if (/AADSTS53003|conditional[ -]access|blocked by (?:your )?(?:organization|tenant) policy/i.test(value)) {
    return { state: "conditional-access-blocked", message: "Your organization's Conditional Access policy blocked this sign-in. Ask your IT administrator which browser sign-in policy applies, then sign in again." };
  }
  if (/AADSTS50076|AADSTS50079|multi[ -]?factor|\bMFA\b|additional authentication is required/i.test(value)) {
    return { state: "mfa-required", message: "Complete the MFA step in the Microsoft browser sign-in, then sign in again." };
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
function lifecycleMessage(state, detail) {
  const messages = {
    "not-installed": "Node.js 20 or later with npm is required, or the pinned m365 CLI is not installed. Run `codeterm plugin teams-client login` (or Sign in in the view) to install it, or install Node.js 20+ and npm first.",
    "unsupported-platform": detail || "This operating system and architecture are not supported by the pinned m365 CLI.",
    "install-failed": detail || "The pinned m365 CLI could not be verified or installed. Check npm access and retry Sign in.",
    "installed-not-configured": "The pinned m365 CLI is ready. Sign in with your work or school Microsoft account in the browser.",
    "logged-out": "You are signed out. Run `codeterm plugin teams-client login` (or Sign in in the view) to sign in.",
    "logged-in": "Microsoft Teams is connected.",
    "reauth-needed": "The Microsoft session needs a new sign-in. Sign in again with `codeterm plugin teams-client login` (or Sign in in the view).",
    "status-unavailable": "m365 did not answer in time, so the sign-in state is unknown. Refresh in a moment; sign in again only if this keeps happening."
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
  const words2 = new Array(64);
  const rotate = (value, bits) => value >>> bits | value << 32 - bits;
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 4;
      words2[i] = (bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = words2[i - 15];
      const y = words2[i - 2];
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ x >>> 3;
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ y >>> 10;
      words2[i] = words2[i - 16] + s0 + words2[i - 7] + s1 >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = e & f ^ ~e & g;
      const t1 = h + sum1 + choice + constants[i] + words2[i] >>> 0;
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
  const reauthStates = ["conditional-access-blocked", "mfa-required", "consent-required", "wrong-client-redirect", "refresh-token-revoked", "token-expired"];
  if (reauthStates.includes(current.state)) return { error: `reauth-needed: ${current.state}. ${current.message}` };
  if (current.state === "reauth-needed") return { error: `reauth-needed: session status needs attention. ${current.message} Review the tenant sign-in and sign in again.` };
  if (["logged-out", "installed-not-configured"].includes(current.state)) return { error: "not-logged-in: Sign in to Teams Client with the intended work or school account before sending." };
  if (current.state !== "logged-in") return { error: `upstream-rejected: ${current.message} Resolve the Teams Client prerequisite, then review the preview again before sending.` };
  const sender = senderFromFields(current);
  if (!sender) return { error: "upstream-rejected: The active account, UPN, and tenant could not all be resolved. Refresh Teams Client status before sending." };
  if (sender.tenantId.toLowerCase() === PERSONAL_TENANT_ID) {
    return { error: "upstream-rejected: Delegated Teams chat send requires a work or school tenant. Sign in with the intended work or school account, then preview again." };
  }
  return { sender };
}
function readSendScope() {
  const p = paths();
  if (!p) return parseSendScope(null, validChatId);
  let raw = null;
  try {
    raw = host.fs.fileExists(p.scope) ? host.fs.readFile(p.scope) ?? "" : null;
  } catch {
    raw = "";
  }
  return parseSendScope(raw, validChatId);
}
function setSendScope(args) {
  const scope = validateSendScope(args, validChatId);
  if ("error" in scope) return { error: `${scope.error} The restriction was not changed.` };
  const p = paths();
  if (!p) return { error: "The Teams Client data directory is unavailable; the restriction was not changed." };
  try {
    if (!host.fs.makeDirs(p.root) || host.fs.writeFile(p.scope, JSON.stringify(scope)) !== true) {
      return { error: "Could not save the restriction; the previous setting still applies." };
    }
  } catch {
    return { error: "Could not save the restriction; the previous setting still applies." };
  }
  return { result: JSON.stringify(readSendScope()) };
}
function resolveDestination(id, sender) {
  if (!validChatId(id)) return { error: failureMessage("invalid-request", "Use an immutable chat id from `chats <name>`; chat names are not ids.") };
  let chat = cachedChats && cachedChats.identityKey === sender.identityKey ? cachedChats.chats.find((item) => item.id === id) : null;
  if (!chat) {
    const listed = chatList(sender);
    if ("error" in listed) return { error: `upstream-rejected: Could not list chats to resolve ${id} (${listed.error}).` };
    chat = listed.chats.find((item) => item.id === id);
  }
  if (!chat) return { error: failureMessage("chat-not-found", id) };
  return { destination: { id: String(chat.id), label: String(chat.title || chat.id), chatType: chat.chatType, members: chat.members } };
}
var previewSequence = 0;
function previewCommand(args, origin = "agent") {
  if (args.length < 2 || !validChatId(args[0])) return { error: "Usage: preview <immutable-chat-id> <text>. Find the id with `chats <name>`; chat names are not accepted." };
  const text = args.slice(1).join(" ");
  if (!text.length) return { error: "invalid-request: Preview text must not be empty." };
  const resolved = previewSender();
  if ("error" in resolved) return resolved;
  const found = resolveDestination(args[0], resolved.sender);
  if ("error" in found) return found;
  const previewId = sha256Hex(`preview\0${now()}\0${++previewSequence}`);
  const idempotencyKey = previewId;
  previewTokens[previewId] = { sender: resolved.sender, destination: found.destination, text, origin, previewNonce: previewId };
  const decision = decideSend(readSendScope(), found.destination.id, origin);
  return { result: JSON.stringify({
    previewId,
    idempotencyKey,
    sender: resolved.sender,
    tenant: { id: resolved.sender.tenantId },
    destination: found.destination,
    text,
    allowed: decision.allow,
    restriction: decision.allow ? null : decision.message
  }) };
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
${run.stderr}`, configuredAppId());
    if (reauth) return { ...reauth, accounts: [] };
    if (/timed out after \d+ms/i.test(run.error)) return { state: "status-unavailable", message: lifecycleMessage("status-unavailable"), accounts: [] };
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
function jsonCommand(args, appId = configuredAppId()) {
  const run = runM365(args.concat(["--output", "json"]));
  if (!run.ok) {
    const auth = authState(`${run.error}
${run.stderr}`, appId);
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
function chatList(sender) {
  const response = jsonCommand(["request", "--url", `${GRAPH}/me/chats?$expand=members&$top=50`]);
  if (response.error) return { error: response.error };
  const source = Array.isArray(response.data?.value) ? response.data.value : Array.isArray(response.data) ? response.data : [];
  const selfId = sender ? sender.accountId.toLowerCase() : "";
  const selfUpn = sender ? sender.upn.toLowerCase() : "";
  const chats = source.flatMap((raw) => {
    const id = typeof raw?.id === "string" ? raw.id : "";
    if (!validChatId(id)) return [];
    const others = (Array.isArray(raw.members) ? raw.members : []).filter((member) => member && String(member.userId || "").toLowerCase() !== selfId && String(member.email || "").toLowerCase() !== selfUpn);
    const members = others.map((member) => String(member.displayName || member.email || "")).filter(Boolean);
    const emails = others.map((member) => String(member.email || "")).filter(Boolean);
    const topic = typeof raw.topic === "string" && raw.topic ? raw.topic : null;
    return [{
      id,
      title: topic || members.join(", ") || (typeof raw.chatType === "string" ? raw.chatType : id),
      topic,
      chatType: typeof raw.chatType === "string" ? raw.chatType : null,
      members,
      username: emails.length ? emails.join(" ") : null,
      lastUpdatedDateTime: typeof raw.lastUpdatedDateTime === "string" ? raw.lastUpdatedDateTime : null
    }];
  });
  if (sender) cachedChats = { identityKey: sender.identityKey, chats };
  return { chats };
}
function agentChats(args = []) {
  const sender = previewSender();
  const listed = chatList("sender" in sender ? sender.sender : null);
  if ("error" in listed) return { error: listed.error };
  const query = args.join(" ").trim();
  if (!query) return { result: JSON.stringify({ chats: listed.chats }) };
  const found = matchChats(listed.chats, query);
  const next = found.match ? `Send with: send ${found.match.id} --key <unique-key> <text>` : found.ambiguous ? "Several chats match. Show the candidates to the owner and ask which one, then use its id." : "No chat among the 50 listed matches. Ask the owner for a more exact name or email.";
  return { result: JSON.stringify({ query, match: found.match, ambiguous: found.ambiguous, candidates: found.candidates, next }) };
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
    content: String(raw && (raw.content || raw.body?.content) || ""),
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
  const appId = String(value.appId || "").trim();
  return {
    historyCount: Number.isInteger(count) ? Math.max(1, Math.min(MAX_COUNT, count)) : 20,
    historyMaxBytes: Number.isInteger(bytes) ? Math.max(1024, Math.min(MAX_BYTES, bytes)) : MAX_BYTES,
    appId: APP_ID_PATTERN.test(appId) ? appId.toLowerCase() : DEFAULT_APP_ID
  };
}
function configuredAppId() {
  try {
    return settings().appId;
  } catch {
    return DEFAULT_APP_ID;
  }
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
var SEND_FAILURES = ["invalid-request", "not-logged-in", "reauth-needed", "chat-not-found", "chat-not-allowed", "rate-limited", "upstream-rejected", "unknown"];
function failureMessage(kind, detail, cause) {
  switch (kind) {
    case "invalid-request":
      return `invalid-request: ${String(detail || "Usage: send <immutable-chat-id> [--key <idempotency-key>] <text>.")} Find the chat id with \`chats <name>\`, then send again.`;
    case "not-logged-in":
      return "not-logged-in: Sign in with the intended work or school account through `codeterm plugin teams-client login` (or Sign in in the view) and confirm its tenant before sending.";
    case "reauth-needed":
      return `reauth-needed: ${String(cause || "reauth-needed")}. ${String(detail || "The Microsoft session needs a new sign-in. Sign in again and complete the tenant's required authentication step.")}`;
    case "chat-not-found":
      return `chat-not-found: No chat among this account's 50 listed chats has id ${String(detail || "unavailable")}. Look it up with \`chats <name>\` and use an id from that result.`;
    case "chat-not-allowed":
      return String(detail || `chat-not-allowed: The owner's "Restrict agent sends" setting does not include this chat. Ask the owner to add it in the Teams Client view.`);
    case "rate-limited":
      return `rate-limited: Microsoft 365 throttled this operation. Review Teams Client status and the selected chat before deciding what to do.`;
    case "upstream-rejected":
      return `upstream-rejected: m365 refused the operation (${String(detail || "inspect the Microsoft 365 error and correct its cause")}). Correct the permission or request issue, then invoke send again only if you still want delivery.`;
    case "unknown":
      return `unknown: ${String(detail || "Microsoft 365 may have accepted this message but confirmation was lost.")} Do not retry this idempotency key and do not report it as delivered; inspect the selected chat and decide manually.`;
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
  return SEND_FAILURES.includes(state) ? rememberSendFailure(state, message) : sendFailureResult("unknown", "The command result could not be classified safely. Inspect the Teams chat before retrying.");
}
function parseSendArgs(args) {
  if (args.length < 2 || !validChatId(args[0])) return { error: failureMessage("invalid-request", "Usage: send <immutable-chat-id> [--key <idempotency-key>] <text>; chat names are not ids.") };
  let start = 1;
  let key;
  if (args[1] === "--key") {
    if (args.length < 4 || !/^[A-Za-z0-9._:-]{1,160}$/.test(args[2])) return { error: failureMessage("invalid-request", "--key needs a 1\u2013160 character idempotency key ([A-Za-z0-9._:-]), followed by message text.") };
    key = args[2];
    start = 3;
  }
  const text = args.slice(start).join(" ");
  if (!text.length) return { error: failureMessage("invalid-request", "Message text must not be empty.") };
  return { chatId: args[0], text, key };
}
function failureForUpstream(message) {
  const auth = authState(message, configuredAppId());
  if (auth) return { kind: "reauth-needed", detail: auth.message, cause: auth.state };
  if (/not signed in|not logged in|no active connection|logged out|run m365 login/i.test(message)) return { kind: "not-logged-in" };
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
function runTeamsSend(args, then) {
  const target = targetState();
  if (!target.paths) return then({ ok: false, error: target.message, stderr: "" });
  if (target.state !== "ready") return then({ ok: false, error: target.message, stderr: "" });
  const p = target.paths;
  if (!host.fs.fileExists(p.binary)) return then({ ok: false, error: "m365 is not installed. Run `codeterm plugin teams-client login` (or Sign in in the view) to install the pinned CLI.", stderr: "" });
  const secured = protectStorage(p);
  if (secured.error) return then({ ok: false, error: secured.message || "Could not secure the m365 runtime.", stderr: "" });
  return host.exec.async({ bin: nativePath(p.binary), args, env: envFor(p), timeoutMs: 5e3 }, (result) => {
    const stdout = String(result.stdout || "");
    const stderr = String(result.stderr || "");
    if (result.error) return then({ ok: false, error: `m365 send process returned an unconfirmed result: ${String(result.error)}`, stderr, code: result.code });
    if (result.done !== true || typeof result.code !== "number") return then({ ok: false, error: "m365 send process outcome is unknown.", stderr });
    if (result.code !== 0) return then({ ok: false, error: stderr || stdout || `m365 exited ${result.code}`, stderr, code: result.code });
    return then({ ok: true, stdout, stderr });
  });
}
function messageIdFromOutput(output) {
  const value = parseJson(output.trim());
  const data = value && (value.data || value);
  const id = data && (data.id || data.messageId);
  return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : typeof id === "number" && Number.isSafeInteger(id) ? String(id) : void 0;
}
function attemptResult(attempt) {
  lastSendState = { state: "sent", message: "Microsoft Graph returned the message id and the sent result is recorded in the Teams Client outbox.", updatedAt: now() };
  return { result: JSON.stringify({
    status: "sent",
    sender: attempt.sender,
    tenant: { id: attempt.sender.tenantId },
    destination: attempt.destination,
    idempotencyKey: attempt.idempotencyKey,
    graphMessageId: attempt.graphMessageId || null,
    deliveryGuarantee: "The plugin returns a recorded success for a sent idempotency key and never resends that key. A send without a Graph message id stays unknown. This is not an exactly-once delivery guarantee."
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
function writeSendBody(p, key, text) {
  const file = joinPath(p.root, `send-body-${sha256Hex(key).slice(0, 16)}.json`);
  try {
    if (!host.fs.makeDirs(p.root)) return null;
    return host.fs.writeFile(file, JSON.stringify({ body: { contentType: "text", content: text } })) === true ? file : null;
  } catch {
    return null;
  }
}
function sendCommand(origin, args) {
  const parsed = parseSendArgs(args);
  if ("error" in parsed) return rememberPrefixedFailure(parsed.error);
  const matchingPreview = Object.values(previewTokens).reverse().find((token) => token.destination.id === parsed.chatId && token.text === parsed.text);
  let key = parsed.key || matchingPreview?.previewNonce;
  const p = paths();
  if (!p) return sendFailureResult("upstream-rejected", "the plugin-owned data directory is unavailable");
  const loaded = loadOutbox(p);
  if (!loaded.ledger) return sendFailureResult("upstream-rejected", loaded.error || "the outbox could not be read");
  const ledger = loaded.ledger;
  const payloadHash = sha256Hex(parsed.text);
  let attempt = key ? ledger.attempts.find((item) => item.idempotencyKey === key) : void 0;
  if (attempt && (attempt.payloadHash !== payloadHash || attempt.destination.id !== parsed.chatId)) {
    return sendFailureResult("invalid-request", "This idempotency key is already bound to a different chat or text; choose a new key only for an intentional new send.");
  }
  if (attempt && attempt.state === "sent") return attemptResult(attempt);
  if (attempt && attempt.state === "unknown") return sendFailureResult("unknown");
  if (attempt && attempt.state === "pending") return persistFailure(p, ledger, attempt, "unknown", "a previous invocation ended before its send result was recorded");
  if (attempt && attempt.state === "rate_limited") return persistFailure(p, ledger, attempt, "unknown");
  const resolved = liveSender();
  if ("error" in resolved) return rememberPrefixedFailure(resolved.error);
  if (attempt && attempt.sender.identityKey !== resolved.sender.identityKey) {
    return sendFailureResult("invalid-request", "This idempotency key belongs to another account or tenant; choose a new key only for an intentional new send.");
  }
  const found = resolveDestination(parsed.chatId, resolved.sender);
  if ("error" in found) return rememberPrefixedFailure(found.error);
  const decision = decideSend(readSendScope(), found.destination.id, origin);
  if (!decision.allow) return sendFailureResult("chat-not-allowed", decision.message);
  if (!key) key = sha256Hex(`send\0${now()}\0${++previewSequence}\0${parsed.chatId}`).slice(0, 32);
  const destination = { id: found.destination.id, label: String(found.destination.label || found.destination.id) };
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
  const bodyFile = writeSendBody(p, key, parsed.text);
  if (!bodyFile) return persistFailure(p, ledger, attempt, "upstream-rejected", "the message body could not be staged in the plugin data directory; m365 was not contacted");
  const url = `${GRAPH}/chats/${parsed.chatId}/messages`;
  return runTeamsSend(["request", "--url", url, "--method", "post", "--content-type", "application/json", "--body", `@${nativePath(bodyFile)}`, "--output", "json"], (run) => {
    try {
      host.fs.removeFile(bodyFile);
    } catch {
    }
    if (!run.ok) {
      const upstream = failureForUpstream(`${run.error}
${run.stderr}`);
      return persistFailure(p, ledger, attempt, upstream.kind, upstream.detail, upstream.cause);
    }
    const graphMessageId = messageIdFromOutput(run.stdout);
    if (!graphMessageId) return persistFailure(p, ledger, attempt, "unknown", "m365 exited cleanly but Microsoft Graph returned no message id, so delivery is not confirmed.");
    attempt.graphMessageId = graphMessageId;
    attempt.state = "sent";
    attempt.updatedAt = now();
    delete attempt.failure;
    delete attempt.failureCause;
    delete attempt.failureMessage;
    if (!persistOutbox(p, ledger)) return persistFailure(p, ledger, attempt, "unknown");
    return attemptResult(attempt);
  });
}
function logout() {
  const target = targetState();
  if (target.state !== "ready") return { error: lifecycleMessage(target.state, target.message) };
  const p = target.paths;
  cancelPendingSignIn();
  if (!host.fs.fileExists(p.binary)) {
    cachedChats = null;
    clearPreviewTokens();
    return { result: "Logged out. No m365 runtime is installed." };
  }
  const run = runM365(["logout"]);
  if (!run.ok) {
    const reauth = authState(`${run.error}
${run.stderr}`, configuredAppId());
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
    case "login": {
      if (args.length > 1 || args.length === 1 && args[0] !== "--device-code") return { error: "Usage: login [--device-code]." };
      const started = loginStart(args.length ? "deviceCode" : "browser");
      if (started.error) return { error: started.error };
      const current = loginPoll(started.jobId);
      if (current.error && !current.done) return { error: current.error };
      return { result: JSON.stringify(agentLoginView(current, started.jobId)) };
    }
    case "login-status": {
      if (args.length) return { error: "Usage: login-status." };
      if (!activeLoginJobId) return { result: JSON.stringify({ state: statusView().state, done: true }) };
      const jobId = activeLoginJobId;
      const current = loginPoll(jobId);
      if (current.error && !current.done) return { error: current.error };
      return { result: JSON.stringify(agentLoginView(current, jobId)) };
    }
    case "accounts":
      return agentAccounts();
    case "use":
      return args.length === 1 ? useAccount(args[0]) : { error: "Usage: use <account-id>." };
    case "chats":
      return agentChats(args);
    case "history":
      return agentHistory(args);
    case "health":
      return { result: JSON.stringify({ ...statusView(), appId: configuredAppId(), sendScope: readSendScope(), lastSend: lastSendState }) };
    case "logout":
      return logout();
    case "send":
      return sendCommand("agent", args);
    case "preview":
      return previewCommand(args, "agent");
    default:
      return { error: `Unknown Teams Client verb: ${ctx.verb}` };
  }
}
function agentLoginView(current, fallbackJobId) {
  const signIn = current.deviceCode ? "device-code" : current.signInUrl ? "link" : void 0;
  return {
    done: current.done === true,
    state: String(current.state || "login-in-progress"),
    jobId: current.jobId || fallbackJobId,
    appId: current.appId || configuredAppId(),
    signIn,
    signInUrl: current.signInUrl,
    deviceCode: current.deviceCode,
    message: current.error || current.message,
    ...current.fallbackFrom ? { fallbackFrom: current.fallbackFrom } : {},
    ...current.error ? { error: current.error } : {}
  };
}
function loginStart(authType = "browser") {
  const running = activeLoginJobId ? loginJobs[activeLoginJobId] : null;
  if (activeLoginJobId && running && running.stage !== "browser") {
    return { jobId: activeLoginJobId, state: "install-in-progress", message: "The pinned m365 runtime is still installing. Poll login-status; the sign-in link follows when it is ready." };
  }
  const p = paths();
  if (!p) return { error: lifecycleMessage("unsupported-platform") };
  const protectedState = protectStorage(p);
  if (protectedState.error) return { error: protectedState.message || lifecycleMessage("install-failed") };
  cancelPendingSignIn();
  if (!host.fs.fileExists(p.binary)) {
    const installed = installM365(authType);
    return installed.jobId ? { jobId: installed.jobId, state: installed.state, message: installed.message } : { error: lifecycleMessage(installed.state, installed.message), state: installed.state };
  }
  const target = targetState();
  if (target.state !== "ready" || !target.paths) return { error: lifecycleMessage(target.state, target.message) };
  const started = startBrowserLogin(target.paths, target.target, authType);
  if (!started.jobId) return { error: started.error || "m365 browser sign-in did not start.", state: "install-failed" };
  return { jobId: started.jobId, state: "login-in-progress", message: PREPARING_SIGN_IN_MESSAGE };
}
function signInPending(jobId, log, login) {
  const artifacts = signInArtifacts(log);
  const context = { appId: login?.appId, ...login?.fallbackFrom ? { fallbackFrom: login.fallbackFrom } : {} };
  const fallback = login?.fallbackFrom ? "The localhost link was refused, so this sign-in uses a code instead. " : "";
  if (artifacts.deviceCode) return { done: false, jobId, state: "waiting-for-sign-in", ...context, ...artifacts, message: `${fallback}Open ${artifacts.signInUrl} and enter code ${artifacts.deviceCode}.` };
  if (artifacts.signInUrl) return { done: false, jobId, state: "waiting-for-sign-in", ...context, ...artifacts, message: "Open the sign-in link in your usual browser on this computer and sign in with your Microsoft 365 work or school account. The link expires in 10 minutes; run login again for a fresh one." };
  return { done: false, jobId, state: "login-in-progress", ...context, message: login?.authType === "deviceCode" ? `${fallback}${PREPARING_CODE_MESSAGE}` : PREPARING_SIGN_IN_MESSAGE };
}
function fallBackToDeviceCode(jobId, login, failure) {
  try {
    host.exec.close(jobId);
  } catch {
  }
  finishLoginJob(jobId, failure.state);
  const started = startBrowserLogin(login.paths, login.target, "deviceCode");
  if (!started.jobId) return { done: true, state: failure.state, error: failure.message };
  const next = loginJobs[started.jobId];
  next.fallbackFrom = failure.state;
  return signInPending(started.jobId, { state: "starting" }, next);
}
function missingChatConsent(login) {
  const probe = jsonCommand(["request", "--url", `${GRAPH}/me/chats?$top=1`], login.appId);
  return probe.reauth?.state === "consent-required" ? probe.reauth : null;
}
function pollSignIn(jobId, login) {
  const log = readSignInLog(login);
  if (log.state === "failed") {
    if (login.authType === "browser" && LOOPBACK_REFUSED.includes(log.failure.state)) return fallBackToDeviceCode(jobId, login, log.failure);
    return finishLoginJob(jobId, log.failure.state, log.failure.message);
  }
  const current = statusView();
  if (current.state === "logged-in" && log.state !== "cancelled") {
    const secured = protectCacheFiles(login.paths, true);
    if (secured.error) return finishLoginJob(jobId, "install-failed", secured.message || lifecycleMessage("install-failed"));
    const consent = missingChatConsent(login);
    if (consent) return finishLoginJob(jobId, consent.state, consent.message);
    return finishLoginJob(jobId, "logged-in");
  }
  if (log.state === "cancelled") return finishLoginJob(jobId, "sign-in-cancelled", "This sign-in was replaced or cancelled. Run login again for a fresh link.");
  if (log.state === "expired" || now() - (login.startedAt || 0) > SIGN_IN_TTL_MS + 3e4) {
    if (login.leaseFile) try {
      host.fs.removeFile(login.leaseFile);
    } catch {
    }
    return finishLoginJob(jobId, "sign-in-expired", "The sign-in link expired. Run login again for a fresh link.");
  }
  return signInPending(jobId, log, login);
}
function loginPoll(jobId) {
  const login = jobId ? loginJobs[jobId] : null;
  if (!login) return { error: "Unknown Microsoft sign-in job." };
  if (login.stage === "browser" && login.launchComplete) return pollSignIn(jobId, login);
  let poll;
  try {
    poll = host.exec.poll(jobId);
  } catch {
    return { error: "Could not read the Microsoft sign-in job." };
  }
  if (!poll.done) return login.stage === "browser" ? signInPending(jobId, readSignInLog(login), login) : { done: false, jobId, state: "install-in-progress", message: "The pinned m365 package setup is still running." };
  try {
    host.exec.close(jobId);
  } catch {
  }
  if (poll.error || poll.code !== 0) {
    const reason = `${poll.error || ""}
${poll.stderr || ""}
${poll.stdout || ""}`;
    const auth = authState(reason, login.appId);
    return finishLoginJob(jobId, auth ? auth.state : "install-failed", auth ? auth.message : lifecycleMessage("install-failed"));
  }
  if (login.stage === "pack") {
    const packed = packageFromPackResult(login.paths, login.target, String(poll.stdout || ""));
    if (!packed.path) return finishLoginJob(jobId, "install-failed", packed.error || lifecycleMessage("install-failed"));
    delete loginJobs[jobId];
    if (activeLoginJobId === jobId) activeLoginJobId = null;
    const install = startLoginProcess(login.paths, login.target, "install", [
      "install",
      nativePath(packed.path),
      "--prefix",
      nativePath(login.paths.runtime),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact"
    ], packed.path, login.authType);
    if (!install.jobId) {
      try {
        host.fs.removeFile(packed.path);
      } catch {
      }
      return { done: true, state: "install-failed", error: install.error || lifecycleMessage("install-failed") };
    }
    return { done: false, jobId: install.jobId, state: "install-in-progress", message: "The local package checksum passed; npm is installing the verified tarball." };
  }
  if (login.stage === "install") {
    if (installedPackageVersion(login.paths) !== VERSION) {
      return finishLoginJob(jobId, "install-failed", lifecycleMessage("install-failed", "The installed m365 CLI version did not match the pinned release."));
    }
    if (login.packagePath) {
      try {
        host.fs.removeFile(login.packagePath);
      } catch {
      }
    }
    delete loginJobs[jobId];
    if (activeLoginJobId === jobId) activeLoginJobId = null;
    const browser = startBrowserLogin(login.paths, login.target, login.authType);
    if (!browser.jobId) return { done: true, state: "install-failed", error: browser.error || "m365 browser sign-in did not start." };
    return { done: false, jobId: browser.jobId, state: "login-in-progress", message: PREPARING_SIGN_IN_MESSAGE };
  }
  login.launchComplete = true;
  return pollSignIn(jobId, login);
}
function viewCall(method, args) {
  const value = args || {};
  if (method === "status") return { ...statusView(), appId: configuredAppId(), loginJobId: activeLoginJobId };
  if (method === "loginStart") return loginStart(value.authType === "deviceCode" ? "deviceCode" : "browser");
  if (method === "loginPoll") return loginPoll(String(value.jobId || ""));
  if (method === "useAccount") return useAccount(String(value.id || ""));
  if (method === "logout") return logout();
  if (method === "chats") return agentChats(String(value.query || "").trim() ? [String(value.query)] : []);
  if (method === "sendScope") return readSendScope();
  if (method === "setSendScope") return setSendScope(value);
  if (method === "preview") return previewCommand([String(value.chatId || ""), String(value.text || "")], "view");
  if (method === "send") return sendCommand("view", [String(value.chatId || ""), "--key", String(value.idempotencyKey || ""), String(value.text || "")]);
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
  const scope = readSendScope();
  nodes.push({ kind: "text", text: scope.mode === "all" ? "Agent sends: any chat" : `Agent sends: ${scope.chats.length} allowed chat${scope.chats.length === 1 ? "" : "s"}`, style: { tone: scope.mode === "all" ? "muted" : "warn" } });
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
  __test_readSendScope: readSendScope,
  __test_previewCommand: previewCommand,
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
  __test_parseSignInLog: parseSignInLog,
  __test_signInTtlMs: SIGN_IN_TTL_MS,
  __test_signInWrapper: SIGN_IN_WRAPPER,
  __test_defaultAppId: DEFAULT_APP_ID,
  __test_metadataReader: METADATA_READER
};
var plugin_default = plugin;
