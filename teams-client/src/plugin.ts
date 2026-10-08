import type { GlanceView, PluginModule, ViewNode } from "@codeterm/plugin-sdk";
import { decideSend, matchChats, parseSendScope, validateSendScope, type SendOrigin, type SendScope } from "../../shared/src/send-scope";
import {
  CHAT_CACHE_TTL_MS, EXO_HOME_DIR, EXO_MODULE, EXO_MODULE_SUM, EXO_PACKAGE, EXO_TOKEN_DIR, EXO_TOKEN_FILES,
  EXO_VERSION, GO_ARCHIVES, GO_DOWNLOAD_BASE, GO_VERSION, MAX_BYTES, MAX_COUNT, MAX_FILE_BYTES, ROOT, SEARCH_BUDGET_MS,
  SEARCH_CHAT_MESSAGES, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_CHATS, SEARCH_RECENT_MESSAGES, SIGN_IN_TTL_MS, TIMEOUTS,
} from "./constants";
import {
  classifyAuthFailure, fileSendFailure, findSentFileMessageId, findSentMessageId, historyRows, htmlMessage, mapChats, microsoftMessage,
  normalizeArch, parseByteCount, parseFileProbe, parseGoModDownload, parseJson, parseSha256, parseSignInLog, parseWhoami, personQuery,
  redact, searchMessages, searchTerms, sendFailure, sessionExpiry, sessionUsable,
  type Chat, type SearchHit, type SignInLog, type WhoAmI,
} from "./parse";

type Paths = {
  root: string; home: string; tokenDir: string; runtime: string; toolchain: string; goBinary: string; gopath: string; gocache: string;
  gomodcache: string; bin: string; binary: string; marker: string; noPath: string; loginLog: string; loginState: string;
  outbox: string; scope: string; chatCache: string;
};
type RunResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string; stdout: string; stderr: string; code?: number };
type Target = { platform: string; arch: string; archive: { file: string; sha256: string }; exe: string; tools: Tools };
type Tools = { curl: string; tar: string; hash: string[]; icacls: string; whoami: string; kill: string[]; powershell: string; wc: string; realpath: string };
type StateResult = { state: string; message: string; accountId?: string | null; upn?: string | null; user?: string | null; tenantId?: string | null; expiresOn?: string | null; signInUrl?: string; deviceCode?: string; accounts?: any[] };
type InstallStage = "download" | "extract" | "module" | "build";
type InstallJob = { stage: InstallStage; paths: Paths; target: Target };
type LoginRecord = { startedAt: number; pid?: number | null };

const installJobs: Record<string, InstallJob> = {};
let activeInstallJobId: string | null = null;
const storageProtectionCache: Record<string, { error?: string; message?: string }> = {};
const previewTokens: Record<string, any> = {};
let memoryChats: { identityKey: string; chats: Chat[]; at: number } | null = null;
let injectedClock: (() => number) | null = null;
let lastSendState: { state: string; message: string; updatedAt: number } | null = null;
let lastStatus: StateResult | null = null;
const CHAT_CACHE_SCHEMA = 2;

function now(): number {
  const value = injectedClock ? Number(injectedClock()) : Date.now();
  return Number.isFinite(value) ? value : Date.now();
}

function joinPath(...parts: string[]): string {
  return host.path.normalize(parts.join("/"));
}

function nativePath(path: string): string {
  return host.path.toNative(host.path.normalize(path));
}

function hostPlatform(): string {
  if (host.path.isWindows) return "win32";
  let value = "";
  try { value = String(host.platform() || "").toLowerCase(); } catch { }
  return value === "macos" ? "darwin" : value;
}

function exeName(platform: string, name: string): string {
  return platform === "win32" ? `${name}.exe` : name;
}

function paths(): Paths | null {
  try {
    const expanded = host.fs.expandHome(ROOT);
    if (!expanded) return null;
    const root = host.path.normalize(expanded);
    const home = joinPath(root, EXO_HOME_DIR);
    const runtime = joinPath(root, "runtime");
    const toolchain = joinPath(runtime, "toolchain");
    const platform = hostPlatform();
    return {
      root,
      home,
      tokenDir: joinPath(home, EXO_TOKEN_DIR),
      runtime,
      toolchain,
      goBinary: joinPath(toolchain, "go/bin", exeName(platform, "go")),
      gopath: joinPath(runtime, "gopath"),
      gocache: joinPath(runtime, "gocache"),
      gomodcache: joinPath(runtime, "gomodcache"),
      bin: joinPath(runtime, "bin"),
      binary: joinPath(runtime, "bin", exeName(platform, "exo-teams")),
      marker: joinPath(runtime, "install.json"),
      noPath: joinPath(runtime, "no-path"),
      loginLog: joinPath(root, "login.log"),
      loginState: joinPath(root, "login.json"),
      outbox: joinPath(root, "outbox.json"),
      scope: joinPath(root, "send-scope.json"),
      chatCache: joinPath(root, "chats.json"),
    };
  } catch {
    return null;
  }
}

// Windows tools come from System32 by path: a Git for Windows PATH puts GNU tar first, which reads "C:" as a remote host.
// certutil is avoided because its localized OEM-code-page header makes the host's UTF-8 stdout reader drop all output.
function toolsFor(platform: string, systemRoot = "C:/Windows"): Tools {
  const sys = (name: string) => nativePath(`${systemRoot}/System32/${name}`);
  const powershell = sys("WindowsPowerShell/v1.0/powershell.exe");
  if (platform === "win32") return { curl: sys("curl.exe"), tar: sys("tar.exe"), hash: [powershell, "-NoProfile", "-NonInteractive", "-Command", "(Get-FileHash -Algorithm SHA256 -LiteralPath $env:CT_HASH_FILE).Hash"], icacls: sys("icacls.exe"), whoami: sys("whoami.exe"), kill: [sys("taskkill.exe"), "/PID", "{pid}", "/T", "/F"], powershell, wc: "", realpath: "" };
  if (platform === "darwin") return { curl: "curl", tar: "tar", hash: ["shasum", "-a", "256", "{file}"], icacls: "", whoami: "", kill: ["kill", "{pid}"], powershell: "", wc: "wc", realpath: "realpath" };
  return { curl: "curl", tar: "tar", hash: ["sha256sum", "{file}"], icacls: "", whoami: "", kill: ["kill", "{pid}"], powershell: "", wc: "wc", realpath: "realpath" };
}

function resolveTarget(platform: string, arch: string, systemRoot?: string): Target | { state: string; message: string } {
  const archive = GO_ARCHIVES[`${platform}/${arch}`];
  if (!archive) return { state: "unsupported-platform", message: `exo-teams is built here with a pinned Go toolchain, which is pinned for macOS, Linux and Windows on x64 or arm64, not ${platform || "this system"}/${arch || "unknown"}.` };
  return { platform, arch, archive, exe: exeName(platform, "exo-teams"), tools: toolsFor(platform, systemRoot) };
}

function windowsRoot(): string | undefined {
  try {
    const value = String(host.envGet("SystemRoot") || host.envGet("windir") || "");
    return /^[A-Za-z]:[\\/][^\r\n"]*$/.test(value) ? host.path.normalize(value) : undefined;
  } catch { return undefined; }
}

let cachedTarget: Target | { state: string; message: string } | null = null;

function detectTarget(p: Paths): Target | { state: string; message: string } {
  if (cachedTarget) return cachedTarget;
  const platform = hostPlatform();
  let arch = "";
  if (platform === "win32") {
    try { arch = normalizeArch(String(host.envGet("PROCESSOR_ARCHITEW6432") || host.envGet("PROCESSOR_ARCHITECTURE") || "")); } catch { }
  } else {
    const probe = runProcess("uname", ["-m"], {}, TIMEOUTS.probe);
    arch = probe.ok ? normalizeArch(probe.stdout) : "";
  }
  cachedTarget = resolveTarget(platform, arch, windowsRoot());
  return cachedTarget;
}

function runProcess(bin: string, args: string[], env: Record<string, string>, timeoutMs: number): RunResult {
  let result: { code?: number; stdout?: string; stderr?: string; error?: string } | null;
  try { result = parseJson(host.exec(JSON.stringify({ bin, args, env, timeoutMs }))); }
  catch (error) { return { ok: false, error: String(error), stdout: "", stderr: "" }; }
  if (!result) return { ok: false, error: `${bin} returned an unreadable process result.`, stdout: "", stderr: "" };
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (result.error) return { ok: false, error: String(result.error), stdout, stderr, code: result.code };
  if (result.code !== 0) return { ok: false, error: stderr || stdout || `${bin} exited ${result.code}.`, stdout, stderr, code: result.code };
  return { ok: true, stdout, stderr };
}

// exo-teams keeps its tokens under the user home and opens a browser through PATH; both point into plugin storage.
function exoEnv(p: Paths): Record<string, string> {
  const home = nativePath(p.home);
  return { HOME: home, USERPROFILE: home, PATH: nativePath(p.noPath) };
}

function goEnv(p: Paths): Record<string, string> {
  const home = nativePath(p.home);
  return {
    HOME: home,
    USERPROFILE: home,
    GOPATH: nativePath(p.gopath),
    GOCACHE: nativePath(p.gocache),
    GOMODCACHE: nativePath(p.gomodcache),
    GOBIN: nativePath(p.bin),
    GOTOOLCHAIN: "local",
    GOENV: "off",
    GOTELEMETRY: "off",
    GOFLAGS: "-trimpath",
    CGO_ENABLED: "0",
    GOPROXY: "https://proxy.golang.org",
    GOSUMDB: "sum.golang.org",
    GONOSUMDB: "",
    GONOSUMCHECK: "",
    GOPRIVATE: "",
    GOINSECURE: "",
  };
}

// Restrict only the root, once: files created later inherit its ACL, and a recursive walk would outlast the exec bound.
function windowsAclCommands(root: string, principal: string): string[][] {
  return [[root, "/inheritance:r", "/grant:r", `${principal}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/C"]];
}

const ACL_MARKER = ".acl-restricted";

function protectStorage(p: Paths): { error?: string; message?: string } {
  if (storageProtectionCache[p.root]) return storageProtectionCache[p.root];
  const result = applyStorageProtection(p);
  if (!result.error) storageProtectionCache[p.root] = result;
  return result;
}

function applyStorageProtection(p: Paths): { error?: string; message?: string } {
  for (const dir of [p.root, p.home, p.tokenDir, p.runtime, p.noPath]) {
    try { if (!host.fs.makeDirs(dir)) return { error: "storage-protection-failed", message: "Could not create the plugin-owned private directory." }; }
    catch { return { error: "storage-protection-failed", message: "Could not create the plugin-owned private directory." }; }
  }
  if (host.path.isWindows) {
    const marker = joinPath(p.root, ACL_MARKER);
    if (host.fs.fileExists(marker)) return {};
    const tools = toolsFor("win32", windowsRoot());
    const who = runProcess(tools.whoami, [], {}, TIMEOUTS.probe);
    const principal = who.ok ? who.stdout.trim() : "";
    if (!principal || /[\r\n]/.test(principal)) return { error: "storage-protection-failed", message: "Could not identify the Windows account for the plugin storage ACL." };
    for (const args of windowsAclCommands(nativePath(p.root), principal)) {
      const acl = runProcess(tools.icacls, args, {}, TIMEOUTS.probe);
      if (!acl.ok) return { error: "storage-protection-failed", message: "Could not restrict the plugin storage with a Windows ACL. Nothing was started." };
    }
    host.fs.writeFile(marker, "1");
    return {};
  }
  for (const dir of [p.root, p.home, p.tokenDir]) {
    const chmod = runProcess("chmod", ["700", nativePath(dir)], {}, TIMEOUTS.probe);
    if (!chmod.ok) return { error: "storage-protection-failed", message: "Could not restrict the plugin storage permissions. Nothing was started." };
  }
  return {};
}

function installedMarker(p: Paths): boolean {
  const marker = host.fs.readJson(p.marker) as { module?: string; version?: string; sum?: string } | null;
  return !!marker && marker.module === EXO_MODULE && marker.version === EXO_VERSION && marker.sum === EXO_MODULE_SUM && host.fs.fileExists(p.binary);
}

function lifecycleMessage(state: string, detail?: string): string {
  const messages: Record<string, string> = {
    "not-installed": "The pinned exo-teams CLI is not installed yet. Run `codeterm plugin teams-client login` (or Sign in in the view): it downloads a pinned Go toolchain, verifies its SHA-256, builds exo-teams at a pinned commit verified against the Go checksum database, then shows a sign-in code.",
    "unsupported-platform": detail || "This operating system and architecture are not supported.",
    "install-failed": detail || "The pinned exo-teams CLI could not be downloaded, verified or built. Check network access and retry Sign in.",
    "install-in-progress": "The pinned exo-teams CLI is being installed. Keep polling login-status; the sign-in code follows.",
    "logged-out": "Not signed in to Teams. Run `codeterm plugin teams-client login` (or Sign in in the view) to get a sign-in code.",
    "logged-in": "Microsoft Teams is connected.",
    "awaiting-user": "Waiting for you to enter the code at the Microsoft sign-in page.",
  };
  return messages[state] || detail || "Teams Client could not determine its current state.";
}

function readLoginRecord(p: Paths): LoginRecord | null {
  const value = host.fs.readJson(p.loginState) as LoginRecord | null;
  return value && Number.isFinite(Number(value.startedAt)) ? value : null;
}

function readSignInLog(p: Paths): SignInLog {
  if (!host.fs.fileExists(p.loginLog)) return { state: "starting" };
  return parseSignInLog(String(host.fs.readFileTail(p.loginLog, 16384) || ""));
}

// A pending sign-in is one whose log has neither finished nor passed Microsoft's device-code lifetime.
function pendingSignIn(p: Paths): { record: LoginRecord; log: SignInLog } | null {
  const record = readLoginRecord(p);
  if (!record) return null;
  const log = readSignInLog(p);
  if (log.state === "signed-in" || log.state === "failed") return null;
  if (now() - record.startedAt > SIGN_IN_TTL_MS + 30_000) return null;
  return { record, log };
}

function endSignIn(p: Paths, kill: boolean): void {
  const record = readLoginRecord(p);
  if (kill && record && Number.isInteger(record.pid) && Number(record.pid) > 0) {
    const target = detectTarget(p);
    if (!("state" in target)) {
      const [bin, ...args] = target.tools.kill.map((part) => part === "{pid}" ? String(record.pid) : part);
      runProcess(bin, args, {}, TIMEOUTS.probe);
    }
  }
  try { host.fs.removeFile(p.loginState); } catch { }
}

function runExo(p: Paths, args: string[], timeoutMs: number): RunResult {
  const target = detectTarget(p);
  if ("state" in target) return { ok: false, error: target.message, stdout: "", stderr: "" };
  if (!installedMarker(p)) return { ok: false, error: lifecycleMessage("not-installed"), stdout: "", stderr: "" };
  const secured = protectStorage(p);
  if (secured.error) return { ok: false, error: secured.message || "Could not secure plugin storage.", stdout: "", stderr: "" };
  return runProcess(nativePath(p.binary), args, exoEnv(p), timeoutMs);
}

function failureText(run: RunResult): string {
  return run.ok ? "" : `${run.error}\n${run.stderr}\n${run.stdout}`;
}

function whoami(p: Paths): { who: WhoAmI } | { error: string } {
  const run = runExo(p, ["whoami", "--json"], TIMEOUTS.whoami);
  if (!run.ok) return { error: failureText(run) };
  const who = parseWhoami(run.stdout);
  return who ? { who } : { error: "exo-teams whoami returned unreadable output." };
}

function loggedIn(who: WhoAmI): StateResult {
  const upn = who.email || who.user;
  const expiresOn = sessionExpiry(who);
  return {
    state: "logged-in",
    message: upn ? `Signed in as ${who.user ? `${who.user} (${upn})` : upn}.` : lifecycleMessage("logged-in"),
    accountId: upn || "teams-account",
    upn: upn || null,
    user: who.user || null,
    tenantId: null,
    expiresOn,
    accounts: [{ id: upn || "teams-account", accountId: upn || "teams-account", tenantId: null, upn, active: true, expiresOn }],
  };
}

function status(): StateResult {
  const value = computeStatus();
  lastStatus = value;
  return value;
}

function computeStatus(): StateResult {
  const p = paths();
  if (!p) return { state: "unsupported-platform", message: "The host home directory is unavailable.", accounts: [] };
  const target = detectTarget(p);
  if ("state" in target) return { state: target.state, message: target.message, accounts: [] };
  if (activeInstallJobId) return { state: "install-in-progress", message: lifecycleMessage("install-in-progress"), accounts: [] };
  if (!installedMarker(p)) return { state: "not-installed", message: lifecycleMessage("not-installed"), accounts: [] };
  const pending = pendingSignIn(p);
  if (pending && pending.log.state === "awaiting-user") {
    return { state: "awaiting-user", message: `Open ${pending.log.signInUrl} and enter code ${pending.log.deviceCode}.`, signInUrl: pending.log.signInUrl, deviceCode: pending.log.deviceCode, accounts: [] };
  }
  // The token files are declared credentials, so the host hides them from fileExists; exo-teams itself says whether they exist.
  const first = whoami(p);
  if ("who" in first && sessionUsable(first.who)) return loggedIn(first.who);
  if ("error" in first) {
    const known = classifyAuthFailure(first.error);
    if (known && known.state !== "expired") return { state: known.state, message: known.message, accounts: [] };
  }
  const refreshed = runExo(p, ["auth", "--refresh"], TIMEOUTS.refresh);
  if (!refreshed.ok) {
    const known = classifyAuthFailure(failureText(refreshed));
    if (known && known.state !== "logged-out") return { state: known.state, message: known.message, accounts: [] };
    return { state: "expired", message: `The Teams session could not be renewed silently. Microsoft said: "${microsoftMessage(failureText(refreshed))}" Run login to sign in again.`, accounts: [] };
  }
  const second = whoami(p);
  if ("who" in second && sessionUsable(second.who)) return loggedIn(second.who);
  const detail = "error" in second ? ` ${microsoftMessage(second.error)}` : "";
  return { state: "expired", message: `The Teams session is not usable after a refresh.${detail} Run login to sign in again.`, accounts: [] };
}

type Sender = { id: string; accountId: string; tenantId: string; upn: string; user: string; identityKey: string };

function senderFrom(value: StateResult): Sender | null {
  const upn = String(value.upn || "");
  if (value.state !== "logged-in" || !upn) return null;
  return { id: upn, accountId: upn, tenantId: String(value.tenantId || ""), upn, user: String(value.user || ""), identityKey: JSON.stringify([upn.toLowerCase()]) };
}

function liveSender(): { sender: Sender } | { error: string } {
  const current = status();
  if (current.state === "expired" || current.state === "refused") return { error: `reauth-needed: ${current.state}. ${current.message}` };
  if (["logged-out", "awaiting-user", "not-installed"].includes(current.state)) return { error: failureMessage("not-logged-in") };
  if (current.state !== "logged-in") return { error: `upstream-rejected: ${current.message}` };
  const sender = senderFrom(current);
  return sender ? { sender } : { error: "upstream-rejected: The signed-in Teams account could not be resolved. Refresh Teams Client status." };
}

function previewSender(): { sender: Sender } | { error: string } {
  const sender = lastStatus ? senderFrom(lastStatus) : null;
  if (sender) return { sender };
  return liveSender();
}

function validChatId(value: string): boolean {
  return /^[A-Za-z0-9:._@-]{1,512}$/.test(value) && value.includes(":");
}

function readSendScope(): SendScope {
  const p = paths();
  if (!p) return parseSendScope(null, validChatId);
  let raw: string | null = null;
  try { raw = host.fs.fileExists(p.scope) ? (host.fs.readFile(p.scope) ?? "") : null; } catch { raw = ""; }
  return parseSendScope(raw, validChatId);
}

function setSendScope(args: any): { result: string } | { error: string } {
  const scope = validateSendScope(args, validChatId);
  if ("error" in scope) return { error: `${scope.error} The restriction was not changed.` };
  const p = paths();
  if (!p) return { error: "The Teams Client data directory is unavailable; the restriction was not changed." };
  try {
    if (!host.fs.makeDirs(p.root) || host.fs.writeFile(p.scope, JSON.stringify(scope)) !== true) {
      return { error: "Could not save the restriction; the previous setting still applies." };
    }
  } catch { return { error: "Could not save the restriction; the previous setting still applies." }; }
  return { result: JSON.stringify(readSendScope()) };
}

function chatList(sender: Sender, refresh = false): { chats: Chat[] } | { error: string } {
  const p = paths();
  if (!p) return { error: lifecycleMessage("unsupported-platform") };
  if (!refresh && memoryChats && memoryChats.identityKey === sender.identityKey && now() - memoryChats.at < CHAT_CACHE_TTL_MS) return { chats: memoryChats.chats };
  if (!refresh) {
    const cached = host.fs.readJson(p.chatCache) as { schema?: number; identityKey?: string; at?: number; chats?: Chat[] } | null;
    if (cached && cached.schema === CHAT_CACHE_SCHEMA && cached.identityKey === sender.identityKey && Array.isArray(cached.chats) && now() - Number(cached.at) < CHAT_CACHE_TTL_MS) {
      memoryChats = { identityKey: sender.identityKey, chats: cached.chats, at: Number(cached.at) };
      return { chats: cached.chats };
    }
  }
  const run = runExo(p, ["list-chats", "--json"], TIMEOUTS.chats);
  if (!run.ok) {
    const known = classifyAuthFailure(failureText(run));
    return { error: known ? `${known.state === "logged-out" ? "not-logged-in" : "reauth-needed"}: ${known.message}` : `upstream-rejected: exo-teams could not list chats. Microsoft said: "${microsoftMessage(failureText(run))}"` };
  }
  const source = parseJson<any[]>(run.stdout.trim());
  if (!Array.isArray(source)) return { error: "upstream-rejected: exo-teams returned an unreadable chat list." };
  const chats = mapChats(source, sender.user);
  memoryChats = { identityKey: sender.identityKey, chats, at: now() };
  try { host.fs.writeFile(p.chatCache, JSON.stringify({ schema: CHAT_CACHE_SCHEMA, identityKey: sender.identityKey, at: memoryChats.at, chats })); } catch { }
  return { chats };
}

function findChats(chats: Chat[], query: string, preferDirect: boolean) {
  const q = personQuery(query);
  if (preferDirect) {
    const direct = matchChats(chats.filter((chat) => chat.chatType === "oneOnOne"), q);
    if (direct.match || direct.ambiguous) return direct;
  }
  return matchChats(chats, q);
}

function agentChats(args: string[], preferDirect = false): { result: string } | { error: string } {
  const refresh = args.includes("--refresh");
  const query = args.filter((arg) => arg !== "--refresh").join(" ").trim();
  const resolved = liveSender();
  if ("error" in resolved) return resolved;
  const listed = chatList(resolved.sender, refresh);
  if ("error" in listed) return listed;
  if (!query) return { result: JSON.stringify({ chats: listed.chats }) };
  const found = findChats(listed.chats, query, preferDirect);
  const next = found.match
    ? `Send with: send ${found.match.id} --key <unique-key> <text>`
    : found.ambiguous
      ? "Several chats match. Show the candidates to the owner and ask which one, then use its id."
      : "No chat matches. Ask the owner for a more exact name, or use send-to <full name> to start a 1:1 chat.";
  return { result: JSON.stringify({ query, match: found.match, ambiguous: found.ambiguous, candidates: found.candidates, next }) };
}

function resolveDestination(id: string, sender: Sender): { destination: any } | { error: string } {
  if (!validChatId(id)) return { error: failureMessage("invalid-request", "Use an immutable chat id from `chats <name>`; chat names are not ids.") };
  let listed = chatList(sender);
  if ("error" in listed) return { error: listed.error };
  let chat = listed.chats.find((item) => item.id === id);
  if (!chat) {
    listed = chatList(sender, true);
    if ("error" in listed) return { error: listed.error };
    chat = listed.chats.find((item) => item.id === id);
  }
  if (!chat) return { error: failureMessage("chat-not-found", id) };
  return { destination: { id: chat.id, label: chat.title || chat.id, chatType: chat.chatType, members: chat.members } };
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
    from: String(raw && raw.from || ""),
    content: String(raw && raw.content || ""),
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

function readMessages(p: Paths, chatId: string, count: number): { messages: any[] } | { error: string } {
  const run = runExo(p, ["get-chat", chatId, "--json", "--count", String(Math.max(1, Math.min(200, count)))], TIMEOUTS.history);
  if (!run.ok) return { error: failureText(run) };
  const messages = parseJson<any[]>(run.stdout.trim());
  return Array.isArray(messages) ? { messages } : { error: "exo-teams returned unreadable messages." };
}

function agentHistory(args: string[]): { result: string } | { error: string } {
  if (args.length < 1 || args.length > 2 || !validChatId(args[0])) return { error: "Usage: history <immutable-chat-id> [n]. Select an id from chats; display names are not ids." };
  const configured = settings();
  let count = configured.historyCount;
  if (args.length === 2) {
    if (!/^[0-9]{1,3}$/.test(args[1]) || Number(args[1]) < 1) return { error: "History count must be an integer from 1 to 50." };
    count = Math.min(MAX_COUNT, Number(args[1]));
  }
  const resolved = liveSender();
  if ("error" in resolved) return resolved;
  const found = resolveDestination(args[0], resolved.sender);
  if ("error" in found) return found;
  const p = paths()!;
  const read = readMessages(p, args[0], count);
  if ("error" in read) return { error: `upstream-rejected: exo-teams could not read that chat. Microsoft said: "${microsoftMessage(read.error)}"` };
  return { result: JSON.stringify(boundedHistory(args[0], historyRows(read.messages), count, configured.historyMaxBytes)) };
}

let previewSequence = 0;
function previewCommand(args: string[], origin: SendOrigin = "agent"): { result: string } | { error: string } {
  if (args.length < 2 || !validChatId(args[0])) return { error: "Usage: preview <immutable-chat-id> <text>. Find the id with `chats <name>`; chat names are not accepted." };
  const text = args.slice(1).join(" ");
  if (!text.length) return { error: "invalid-request: Preview text must not be empty." };
  const resolved = previewSender();
  if ("error" in resolved) return resolved;
  const found = resolveDestination(args[0], resolved.sender);
  if ("error" in found) return found;
  const previewId = sha256Hex(`preview\u0000${now()}\u0000${++previewSequence}`);
  previewTokens[previewId] = { sender: resolved.sender, destination: found.destination, text, origin, previewNonce: previewId };
  const decision = decideSend(readSendScope(), found.destination.id, origin);
  return { result: JSON.stringify({
    previewId,
    idempotencyKey: previewId,
    sender: resolved.sender,
    tenant: { id: resolved.sender.tenantId },
    destination: found.destination,
    text,
    allowed: decision.allow,
    restriction: decision.allow ? null : decision.message,
  }) };
}

type AttemptState = "pending" | "sent" | "failed" | "unknown";
type SendFailure = "invalid-request" | "not-logged-in" | "reauth-needed" | "chat-not-found" | "chat-not-allowed" | "file-too-large" | "file-unreadable" | "upstream-rejected" | "unknown";
const SEND_FAILURES: SendFailure[] = ["invalid-request", "not-logged-in", "reauth-needed", "chat-not-found", "chat-not-allowed", "file-too-large", "file-unreadable", "upstream-rejected", "unknown"];
type Attempt = {
  idempotencyKey: string;
  sender: Sender;
  target?: string;
  destination: { id: string; label: string };
  payloadHash: string;
  state: AttemptState;
  createdAt: number;
  updatedAt: number;
  sendCount: number;
  failure?: SendFailure;
  failureCause?: string;
  failureMessage?: string;
  messageId?: string | null;
};
type Outbox = { schema: 2; attempts: Attempt[] };

function failureMessage(kind: SendFailure, detail?: any, cause?: string): string {
  switch (kind) {
    case "invalid-request": return `invalid-request: ${String(detail || "Usage: send <immutable-chat-id> [--key <idempotency-key>] <text>.")} Find the chat id with \`chats <name>\`, then send again.`;
    case "not-logged-in": return "not-logged-in: Sign in to Teams through `codeterm plugin teams-client login` (or Sign in in the view) before sending.";
    case "reauth-needed": return `reauth-needed: ${String(cause || "expired")}. ${String(detail || "The Teams session needs a new sign-in. Run login again.")}`;
    case "chat-not-found": return `chat-not-found: No chat of this account has id ${String(detail || "unavailable")}. Look it up with \`chats <name>\` and use an id from that result.`;
    case "chat-not-allowed": return String(detail || "chat-not-allowed: The owner's \"Restrict agent sends\" setting does not include this chat. Ask the owner to add it in the Teams Client view.");
    case "file-too-large": return `file-too-large: ${String(detail || "The file is over the limit.")} The limit is ${MAX_FILE_BYTES / (1024 * 1024)} MiB; nothing was uploaded or sent.`;
    case "file-unreadable": return `file-unreadable: ${String(detail || "The file could not be read.")} Give an absolute path to an existing, readable regular file; nothing was uploaded or sent.`;
    case "upstream-rejected": return `upstream-rejected:${String(detail || "the Teams chat service refused the operation")}. Correct the cause, then send again only if you still want delivery.`;
    case "unknown": return `unknown: ${String(detail || "Teams may have accepted this message but confirmation was lost.")} Do not retry this idempotency key and do not report it as delivered; inspect the chat and decide manually.`;
  }
  const exhaustive: never = kind;
  return exhaustive;
}

function loadOutbox(p: Paths): { ledger?: Outbox; error?: string } {
  try {
    if (!host.fs.fileExists(p.outbox)) return { ledger: { schema: 2, attempts: [] } };
    const value = parseJson<any>(host.fs.readFile(p.outbox) || "");
    if (value && value.schema === 1) return { ledger: { schema: 2, attempts: [] } };
    if (!value || value.schema !== 2 || !Array.isArray(value.attempts)) return { error: "the existing outbox ledger is unreadable" };
    const states: AttemptState[] = ["pending", "sent", "failed", "unknown"];
    const valid = value.attempts.every((item: any) => item && typeof item.idempotencyKey === "string" &&
      typeof item.payloadHash === "string" && /^[a-f0-9]{64}$/.test(item.payloadHash) && states.includes(item.state) &&
      item.sender && typeof item.sender.accountId === "string" && typeof item.sender.identityKey === "string" &&
      item.destination && validChatId(String(item.destination.id || "")) && typeof item.destination.label === "string" &&
      Number.isFinite(Number(item.createdAt)) && Number.isFinite(Number(item.updatedAt)) && Number.isInteger(item.sendCount) && item.sendCount >= 0);
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
  return SEND_FAILURES.includes(state) ? rememberSendFailure(state, message) : sendFailureResult("unknown", "The command result could not be classified safely. Inspect the Teams chat before retrying.");
}

function parseSendArgs(args: string[], target: (value: string) => boolean, usage: string): { target: string; text: string; key?: string } | { error: string } {
  if (args.length < 2 || !target(args[0])) return { error: failureMessage("invalid-request", usage) };
  let start = 1;
  let key: string | undefined;
  if (args[1] === "--key") {
    if (args.length < 4 || !/^[A-Za-z0-9._:-]{1,160}$/.test(args[2])) return { error: failureMessage("invalid-request", "--key needs a 1–160 character idempotency key ([A-Za-z0-9._:-]), followed by message text.") };
    key = args[2];
    start = 3;
  }
  const text = args.slice(start).join(" ");
  if (!text.trim().length) return { error: failureMessage("invalid-request", "Message text must not be empty.") };
  return { target: args[0], text, key };
}

function attemptResult(attempt: Attempt, extra: Record<string, unknown> = {}): { result: string } {
  lastSendState = { state: "sent", message: attempt.messageId ? `Teams accepted message ${attempt.messageId}.` : "Teams accepted the message; its id could not be read back.", updatedAt: now() };
  return { result: JSON.stringify({
    status: "sent",
    sender: attempt.sender,
    destination: attempt.destination,
    idempotencyKey: attempt.idempotencyKey,
    messageId: attempt.messageId || null,
    ...extra,
    ...(attempt.messageId ? {} : { messageIdNote: "exo-teams confirmed the send, but the message id was not found when the chat was read back. Check the chat before resending." }),
    deliveryGuarantee: "A sent idempotency key is never resent. An unconfirmed send stays unknown. This is not an exactly-once delivery guarantee.",
  }) };
}

function persistFailure(p: Paths, ledger: Outbox, attempt: Attempt, kind: SendFailure, detail?: string, cause?: string): { error: string } {
  attempt.failure = kind;
  attempt.failureCause = cause;
  attempt.failureMessage = failureMessage(kind, detail, cause);
  attempt.updatedAt = now();
  attempt.state = kind === "unknown" ? "unknown" : "failed";
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

function exoFailure(p: Paths, ledger: Outbox, attempt: Attempt, run: RunResult, classify: (text: string) => { kind: SendFailure; detail: string; cause?: string } = sendFailure): { error: string } {
  const failure = classify(failureText(run));
  return persistFailure(p, ledger, attempt, failure.kind, failure.detail, failure.cause);
}

type SendPlan = { kind: "chat"; chatId: string } | { kind: "person"; query: string };
type FileInfo = { path: string; name: string; size: number; sha256: string };
type Payload = { kind: "text"; text: string } | { kind: "file"; file: FileInfo; message: string };

function payloadHash(payload: Payload): string {
  return payload.kind === "text" ? sha256Hex(payload.text) : sha256Hex(`file\u0000${payload.file.name}\u0000${payload.file.sha256}\u0000${payload.message}`);
}

function fileSummary(payload: Payload): Record<string, unknown> {
  return payload.kind === "file" ? { file: { name: payload.file.name, bytes: payload.file.size } } : {};
}

// Delivery runs `send` or `send-file` for a known chat, or `new-dm` when a person has no 1:1 chat yet; each stays behind one ledger entry.
function deliver(origin: SendOrigin, plan: SendPlan, payload: Payload, explicitKey: string | undefined): { result: string } | { error: string } {
  const matchingPreview = plan.kind === "chat" && payload.kind === "text"
    ? Object.values(previewTokens).reverse().find((token: any) => token.destination.id === plan.chatId && token.text === payload.text)
    : null;
  let key = explicitKey || matchingPreview?.previewNonce;
  const p = paths();
  if (!p) return sendFailureResult("upstream-rejected", "the plugin-owned data directory is unavailable");
  const loaded = loadOutbox(p);
  if (!loaded.ledger) return sendFailureResult("upstream-rejected", loaded.error || "the outbox could not be read");
  const ledger = loaded.ledger;
  const hash = payloadHash(payload);
  const destinationKey = plan.kind === "chat" ? plan.chatId : `person:${sha256Hex(personQuery(plan.query).toLowerCase()).slice(0, 24)}`;
  let attempt = key ? ledger.attempts.find((item) => item.idempotencyKey === key) : undefined;
  if (attempt && (attempt.payloadHash !== hash || (attempt.target || attempt.destination.id) !== destinationKey)) {
    return sendFailureResult("invalid-request", "This idempotency key is already bound to a different chat, text or file; choose a new key only for an intentional new send.");
  }
  if (attempt && attempt.state === "sent") return attemptResult(attempt, fileSummary(payload));
  if (attempt && attempt.state === "unknown") return sendFailureResult("unknown");
  if (attempt && attempt.state === "pending") return persistFailure(p, ledger, attempt, "unknown", "a previous invocation ended before its send result was recorded");

  const resolved = liveSender();
  if ("error" in resolved) return rememberPrefixedFailure(resolved.error);
  if (attempt && attempt.sender.identityKey !== resolved.sender.identityKey) {
    return sendFailureResult("invalid-request", "This idempotency key belongs to another account; choose a new key only for an intentional new send.");
  }

  let destination: { id: string; label: string };
  let newDm = false;
  let person = "";
  if (plan.kind === "chat") {
    const found = resolveDestination(plan.chatId, resolved.sender);
    if ("error" in found) return rememberPrefixedFailure(found.error);
    destination = { id: found.destination.id, label: String(found.destination.label || found.destination.id) };
  } else {
    const listed = chatList(resolved.sender);
    if ("error" in listed) return rememberPrefixedFailure(listed.error);
    // A person is reached only through a 1:1 chat; new-dm's unique-roster thread returns the existing DM when there is one.
    const found = matchChats(listed.chats.filter((chat) => chat.chatType === "oneOnOne"), personQuery(plan.query));
    if (found.ambiguous) {
      return sendFailureResult("invalid-request", `Several chats match "${plan.query}": ${found.candidates.slice(0, 8).map((chat) => `${chat.title} (${chat.chatType}, ${chat.id})`).join("; ")}. Ask the owner which one and send to its id.`);
    }
    if (found.match) destination = { id: found.match.id, label: found.match.title };
    else if (payload.kind === "file") {
      return sendFailureResult("invalid-request", `No 1:1 chat with "${plan.query}" exists, and a file can only go to an existing chat. Start the chat with send-to <full name> <text> first, or send the file to a chat id.`);
    } else {
      if (personQuery(plan.query).split(/\s+/).filter(Boolean).length < 2) {
        return sendFailureResult("invalid-request", `No chat with "${plan.query}" exists. To start a new 1:1 chat, give the person's full name.`);
      }
      newDm = true;
      person = personQuery(plan.query);
      destination = { id: destinationKey, label: destinationKey };
    }
  }
  const decision = decideSend(readSendScope(), destination.id, origin);
  if (!decision.allow) return sendFailureResult("chat-not-allowed", decision.message);
  if (!key) key = sha256Hex(`send\u0000${now()}\u0000${++previewSequence}\u0000${destination.id}`).slice(0, 32);

  if (!attempt) {
    attempt = { idempotencyKey: key, sender: resolved.sender, target: destinationKey, destination, payloadHash: hash, state: "pending", createdAt: now(), updatedAt: now(), sendCount: 0 };
    ledger.attempts.push(attempt);
  }
  attempt.destination = destination;
  attempt.state = "pending";
  attempt.updatedAt = now();
  attempt.sendCount += 1;
  delete attempt.failure;
  delete attempt.failureCause;
  delete attempt.failureMessage;
  if (!persistOutbox(p, ledger)) return sendFailureResult("upstream-rejected", "the pending attempt could not be persisted; Teams was not contacted");

  const sentAfter = now() - 120_000;
  let chatId = destination.id;
  if (payload.kind === "file") {
    const message = payload.message ? ["--message", htmlMessage(payload.message)] : [];
    const run = runExo(p, ["send-file", chatId, "--file", nativePath(payload.file.path), ...message, "--json"], TIMEOUTS.sendFile);
    if (!run.ok) return exoFailure(p, ledger, attempt, run, fileSendFailure);
    const ok = parseJson<any>(run.stdout.trim());
    if (!ok || ok.ok !== true) return persistFailure(p, ledger, attempt, "unknown", "exo-teams exited cleanly but did not report the file as sent.");
  } else if (newDm) {
    const run = runExo(p, ["new-dm", person, htmlMessage(payload.text), "--json"], TIMEOUTS.send);
    if (!run.ok) return exoFailure(p, ledger, attempt, run);
    const created = parseJson<any>(run.stdout.trim());
    const createdId = created && typeof created.id === "string" ? created.id : "";
    const resolvedName = run.stderr.match(/found user:\s*(.+?)\s*(?:\(|$)/m)?.[1] || person;
    if (!validChatId(createdId)) return persistFailure(p, ledger, attempt, "unknown", "exo-teams reported the new chat as sent but returned no chat id.");
    chatId = createdId;
    attempt.destination = { id: createdId, label: resolvedName };
    memoryChats = null;
  } else {
    const run = runExo(p, ["send", chatId, htmlMessage(payload.text), "--json"], TIMEOUTS.send);
    if (!run.ok) return exoFailure(p, ledger, attempt, run);
    const ok = parseJson<any>(run.stdout.trim());
    if (!ok || ok.ok !== true) return persistFailure(p, ledger, attempt, "unknown", "exo-teams exited cleanly but did not report the send as accepted.");
  }
  attempt.state = "sent";
  attempt.updatedAt = now();
  const read = readMessages(p, chatId, 20);
  attempt.messageId = !("messages" in read) ? null : payload.kind === "file"
    ? findSentFileMessageId(read.messages, payload.file.name, resolved.sender.user, sentAfter)
    : findSentMessageId(read.messages, payload.text, resolved.sender.user, sentAfter);
  if (!persistOutbox(p, ledger)) return persistFailure(p, ledger, attempt, "unknown", "Teams accepted the message but the sent result could not be recorded.");
  return attemptResult(attempt, fileSummary(payload));
}

function sendCommand(origin: SendOrigin, args: string[]): { result: string } | { error: string } {
  const parsed = parseSendArgs(args, validChatId, "Usage: send <immutable-chat-id> [--key <idempotency-key>] <text>; chat names are not ids. Use send-to <person> for a person.");
  if ("error" in parsed) return rememberPrefixedFailure(parsed.error);
  return deliver(origin, { kind: "chat", chatId: parsed.target }, { kind: "text", text: parsed.text }, parsed.key);
}

function sendToCommand(args: string[]): { result: string } | { error: string } {
  const separator = args.indexOf("--");
  const rest = separator > 0 ? [args.slice(0, separator).join(" "), ...args.slice(separator + 1)] : args;
  const parsed = parseSendArgs(rest, (value) => !!value.trim() && value.length <= 200, "Usage: send-to <person name or email> [--key <idempotency-key>] <text>. Quote a multi-word name, or put -- after it.");
  if ("error" in parsed) return rememberPrefixedFailure(parsed.error);
  return deliver("agent", { kind: "person", query: parsed.target.trim() }, { kind: "text", text: parsed.text }, parsed.key);
}

const SEND_FILE_USAGE = "Usage: send-file <chat-id | person> <absolute path> [--message <text>] [--key <idempotency-key>]. Quote a multi-word name or a path with spaces.";

function absolutePath(value: string): boolean {
  return host.path.isWindows ? /^[A-Za-z]:[\\/]/.test(value) : value.startsWith("/");
}

function parseSendFileArgs(args: string[]): { target: string; path: string; message: string; key?: string } | { error: string } {
  const positional: string[] = [];
  const message: string[] = [];
  let key: string | undefined;
  let inMessage = false;
  let sawMessage = false;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === "--key") {
      if (key !== undefined || i + 1 >= args.length || !/^[A-Za-z0-9._:-]{1,160}$/.test(String(args[i + 1]))) return { error: failureMessage("invalid-request", "--key needs one 1–160 character idempotency key ([A-Za-z0-9._:-]).") };
      key = String(args[++i]);
      inMessage = false;
    } else if (arg === "--message") {
      if (sawMessage) return { error: failureMessage("invalid-request", "Give --message once.") };
      sawMessage = inMessage = true;
    } else if (inMessage) message.push(arg);
    else positional.push(arg);
  }
  const at = positional.findIndex((arg, index) => index > 0 && absolutePath(arg));
  if (at < 1) return { error: failureMessage("invalid-request", SEND_FILE_USAGE) };
  const target = positional.slice(0, at).join(" ").trim();
  const path = positional.slice(at).join(" ");
  if (!target || target.length > 200) return { error: failureMessage("invalid-request", SEND_FILE_USAGE) };
  if (path.length > 1024 || /[\u0000-\u001f]/.test(path)) return { error: failureMessage("invalid-request", "The file path must not contain control characters.") };
  return { target, path, message: message.join(" "), key };
}

function underRoot(path: string, root: string): boolean {
  const fold = (value: string) => {
    const normalized = host.path.normalize(value).replace(/\\/g, "/").replace(/\/+$/, "");
    return host.path.isWindows ? normalized.toLowerCase() : normalized;
  };
  const child = fold(path);
  const parent = fold(root);
  return child === parent || child.startsWith(`${parent}/`);
}

// Prints only ASCII key=value lines: the console code page would mangle a path, and contents never leave the probe.
const WINDOWS_FILE_PROBE = "$ErrorActionPreference='Stop'; try { $f = Get-Item -LiteralPath $env:CT_FILE -Force; if ($f.PSIsContainer) { 'kind=dir'; exit 0 }; 'size=' + $f.Length; 'link=' + [bool]($f.Attributes -band [IO.FileAttributes]::ReparsePoint); if ($f.Length -le [long]$env:CT_MAX_BYTES) { $s = [IO.File]::OpenRead($f.FullName); $s.Close(); 'sha256=' + (Get-FileHash -Algorithm SHA256 -LiteralPath $f.FullName).Hash } } catch { 'error=' + $_.Exception.GetType().Name }";

// A confined plugin cannot stat files outside its own directories, so size, readability and the content hash come from a subprocess.
function probeFile(p: Paths, target: Target, rawPath: string): { file: FileInfo } | { error: string } {
  let path = host.path.normalize(rawPath);
  const refuse = (kind: SendFailure, detail: string) => ({ error: failureMessage(kind, detail) });
  const ownData = "Files inside the Teams Client data directory are never sent.";
  if (/^[\\/]{2}/.test(rawPath)) return refuse("invalid-request", "Network paths are not accepted; give a local absolute path.");
  if (underRoot(path, p.root)) return refuse("invalid-request", ownData);
  let size: number;
  let sha256: string | null = null;
  if (target.platform === "win32") {
    const run = runProcess(target.tools.powershell, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_FILE_PROBE], { CT_FILE: nativePath(path), CT_MAX_BYTES: String(MAX_FILE_BYTES) }, TIMEOUTS.fileProbe);
    const probe = parseFileProbe(run.stdout);
    if (probe.state === "missing") return refuse("file-unreadable", "No file exists at that path.");
    if (probe.state === "directory") return refuse("file-unreadable", "That path is a directory.");
    if (probe.state === "denied") return refuse("file-unreadable", "This account may not read that file.");
    if (probe.state !== "file") return refuse("file-unreadable", "The file could not be opened for reading.");
    if (probe.link) return refuse("invalid-request", "That path is a link or junction; give the path of the file itself.");
    size = probe.size;
    sha256 = probe.sha256;
  } else {
    const real = runProcess(target.tools.realpath, [nativePath(path)], {}, TIMEOUTS.probe);
    const resolved = real.ok ? real.stdout.trim() : "";
    if (!resolved.startsWith("/") || /[\r\n]/.test(resolved)) return refuse("file-unreadable", "No readable file exists at that path.");
    path = host.path.normalize(resolved);
    const realRoot = runProcess(target.tools.realpath, [nativePath(p.root)], {}, TIMEOUTS.probe);
    if (underRoot(path, p.root) || (realRoot.ok && underRoot(path, realRoot.stdout.trim()))) return refuse("invalid-request", ownData);
    const count = runProcess(target.tools.wc, ["-c", nativePath(path)], {}, TIMEOUTS.fileProbe);
    const bytes = count.ok ? parseByteCount(count.stdout) : null;
    if (bytes === null) return refuse("file-unreadable", "The path is not a readable regular file.");
    size = bytes;
  }
  if (size > MAX_FILE_BYTES) return refuse("file-too-large", `The file is ${size} bytes.`);
  if (target.platform !== "win32") {
    const [bin, ...args] = target.tools.hash.map((part) => part === "{file}" ? nativePath(path) : part);
    const hashed = runProcess(bin, args, {}, TIMEOUTS.fileProbe);
    sha256 = hashed.ok ? parseSha256(hashed.stdout) : null;
  }
  if (!sha256) return refuse("file-unreadable", "The file could not be read to the end.");
  const name = path.split(/[\\/]/).pop() || "";
  if (!name) return refuse("invalid-request", "The path does not name a file.");
  return { file: { path, name, size, sha256 } };
}

function sendFileCommand(args: string[]): { result: string } | { error: string } {
  const parsed = parseSendFileArgs(args);
  if ("error" in parsed) return rememberPrefixedFailure(parsed.error);
  const p = paths();
  if (!p) return sendFailureResult("upstream-rejected", "the plugin-owned data directory is unavailable");
  const target = detectTarget(p);
  if ("state" in target) return sendFailureResult("upstream-rejected", target.message);
  const probed = probeFile(p, target, parsed.path);
  if ("error" in probed) return rememberPrefixedFailure(probed.error);
  const plan: SendPlan = validChatId(parsed.target) ? { kind: "chat", chatId: parsed.target } : { kind: "person", query: parsed.target };
  return deliver("agent", plan, { kind: "file", file: probed.file, message: parsed.message }, parsed.key);
}

const SEARCH_USAGE = "Usage: search-messages <query> [--chat <chat-id | name>] [--limit <1-50>]. Quote a multi-word chat name.";

function parseSearchArgs(args: string[]): { query: string; chat?: string; limit: number } | { error: string } {
  const words: string[] = [];
  let chat: string | undefined;
  let limit = SEARCH_DEFAULT_LIMIT;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === "--chat") {
      const value = String(args[i + 1] ?? "").trim();
      if (chat !== undefined || !value || value.length > 512) return { error: `invalid-request: ${SEARCH_USAGE}` };
      chat = value;
      i++;
    } else if (arg === "--limit") {
      const value = String(args[i + 1] ?? "");
      if (!/^[0-9]{1,2}$/.test(value) || Number(value) < 1 || Number(value) > MAX_COUNT) return { error: `invalid-request: --limit must be an integer from 1 to ${MAX_COUNT}.` };
      limit = Number(value);
      i++;
    } else words.push(arg);
  }
  const query = words.join(" ").trim();
  if (query.length < 2 || query.length > 200) return { error: `invalid-request: ${SEARCH_USAGE} The query needs 2 to 200 characters.` };
  return { query, chat, limit };
}

function searchScope(sender: Sender, chats: Chat[], wanted: string): { chat: Chat } | { error: string } {
  const exact = chats.find((item) => item.id === wanted);
  if (exact) return { chat: exact };
  if (validChatId(wanted)) {
    const fresh = chatList(sender, true);
    if ("error" in fresh) return fresh;
    const found = fresh.chats.find((item) => item.id === wanted);
    return found ? { chat: found } : { error: failureMessage("chat-not-found", wanted) };
  }
  const found = findChats(chats, wanted, true);
  if (found.ambiguous) return { error: `invalid-request: Several chats match "${wanted}": ${found.candidates.slice(0, 8).map((item) => `${item.title} (${item.chatType}, ${item.id})`).join("; ")}. Ask the owner which one and pass its id to --chat.` };
  return found.match ? { chat: found.match } : { error: `chat-not-found: No chat matches "${wanted}". Look it up with \`search <name>\` or \`chats <name>\`.` };
}

// exo-teams `search` queries Graph mail and drive items, not chat messages, so message text is matched in fetched chat history.
function searchMessagesCommand(args: string[]): { result: string } | { error: string } {
  const parsed = parseSearchArgs(args);
  if ("error" in parsed) return parsed;
  const resolved = liveSender();
  if ("error" in resolved) return resolved;
  const listed = chatList(resolved.sender);
  if ("error" in listed) return listed;
  let scope = listed.chats.slice(0, SEARCH_MAX_CHATS);
  let perChat = SEARCH_RECENT_MESSAGES;
  if (parsed.chat !== undefined) {
    const one = searchScope(resolved.sender, listed.chats, parsed.chat);
    if ("error" in one) return one;
    scope = [one.chat];
    perChat = SEARCH_CHAT_MESSAGES;
  }
  const terms = searchTerms(parsed.query);
  const p = paths()!;
  const started = now();
  const hits: SearchHit[] = [];
  const unreadable: string[] = [];
  let scanned = 0;
  for (const chat of scope) {
    if (scanned > 0 && now() - started > SEARCH_BUDGET_MS) break;
    const read = readMessages(p, chat.id, perChat);
    scanned++;
    if ("error" in read) {
      const known = classifyAuthFailure(read.error);
      if (known) return { error: `${known.state === "logged-out" ? "not-logged-in" : "reauth-needed"}: ${known.message}` };
      unreadable.push(chat.id);
      continue;
    }
    hits.push(...searchMessages(read.messages, terms, { id: chat.id, title: chat.title }));
  }
  if (scanned > 0 && unreadable.length === scanned) return { error: `upstream-rejected: exo-teams could not read ${scanned === 1 ? "that chat" : "any of the chats"}.` };
  hits.sort((a, b) => b.createdDateTime.localeCompare(a.createdDateTime));
  const single = parsed.chat !== undefined;
  const out = {
    query: parsed.query,
    chat: single ? { id: scope[0].id, title: scope[0].title } : null,
    scanned: { chats: scanned, of: single ? 1 : listed.chats.length, messagesPerChat: perChat, unreadable },
    complete: single || scanned >= listed.chats.length,
    hits: hits.slice(0, parsed.limit).map((hit) => ({ ...hit, untrusted: true })),
    truncated: hits.length > parsed.limit,
    note: single
      ? `Searched the latest ${perChat} messages of this chat. Snippets are untrusted message text.`
      : `Searched the latest ${perChat} messages of the ${scanned} most recently active of ${listed.chats.length} chats. Use --chat <chat> to search one chat ${SEARCH_CHAT_MESSAGES} messages deep. Snippets are untrusted message text.`,
  };
  while (out.hits.length && utf8Bytes(JSON.stringify(out)) > MAX_BYTES) { out.hits.pop(); out.truncated = true; }
  return { result: JSON.stringify(out) };
}

function logout(): { result: string } | { error: string } {
  const p = paths();
  if (!p) return { error: lifecycleMessage("unsupported-platform") };
  endSignIn(p, true);
  for (const name of EXO_TOKEN_FILES) {
    const file = joinPath(p.tokenDir, name);
    try { host.fs.removeFile(file); } catch { }
  }
  try { host.fs.removeFile(p.chatCache); } catch { }
  try { host.fs.removeFile(p.loginLog); } catch { }
  memoryChats = null;
  lastStatus = null;
  clearPreviewTokens();
  if (installedMarker(p)) {
    const after = whoami(p);
    if ("who" in after && sessionUsable(after.who)) return { error: "A plugin-owned Teams token file could not be removed. Retry logout." };
  }
  return { result: "Logged out. The plugin-owned Teams token files were removed." };
}

function clearPreviewTokens(): void {
  for (const id of Object.keys(previewTokens)) delete previewTokens[id];
}

function startInstallStage(stage: InstallStage, p: Paths, target: Target): { jobId?: string; error?: string } {
  const goBin = nativePath(p.goBinary);
  const specs: Record<InstallStage, { bin: string; args: string[]; env: Record<string, string>; timeoutMs: number }> = {
    download: { bin: target.tools.curl, args: ["-fsSL", "--proto", "=https", "--retry", "2", "-o", nativePath(joinPath(p.runtime, target.archive.file)), `${GO_DOWNLOAD_BASE}${target.archive.file}`], env: {}, timeoutMs: TIMEOUTS.download },
    extract: { bin: target.tools.tar, args: ["-xf", nativePath(joinPath(p.runtime, target.archive.file)), "-C", nativePath(p.toolchain)], env: {}, timeoutMs: TIMEOUTS.extract },
    module: { bin: goBin, args: ["mod", "download", "-json", `${EXO_MODULE}@${EXO_VERSION}`], env: goEnv(p), timeoutMs: TIMEOUTS.goModule },
    build: { bin: goBin, args: ["install", `${EXO_PACKAGE}@${EXO_VERSION}`], env: goEnv(p), timeoutMs: TIMEOUTS.goBuild },
  };
  const spec = specs[stage];
  if (stage === "extract" && !host.fs.makeDirs(p.toolchain)) return { error: "Could not create the private toolchain directory." };
  let started: { jobId?: string; error?: string };
  try { started = host.exec.start({ bin: spec.bin, args: spec.args, env: spec.env, timeoutMs: spec.timeoutMs }); }
  catch { return { error: `Could not start the ${stage} step.` }; }
  if (!started.jobId) return { error: started.error || `The ${stage} step did not start.` };
  installJobs[started.jobId] = { stage, paths: p, target };
  activeInstallJobId = started.jobId;
  return { jobId: started.jobId };
}

const STAGE_MESSAGES: Record<InstallStage, string> = {
  download: `Downloading the pinned Go toolchain ${GO_VERSION} into the plugin runtime.`,
  extract: "The Go toolchain checksum matched; extracting it.",
  module: "Fetching exo-teams at its pinned commit through the Go module proxy.",
  build: "The exo-teams module matched its pinned checksum; building it.",
};

function nextInstallStage(p: Paths, target: Target, from?: InstallStage): any {
  const order: InstallStage[] = ["download", "extract", "module", "build"];
  let index = from ? order.indexOf(from) + 1 : 0;
  if (!from && host.fs.fileExists(p.goBinary)) index = 2;
  if (index >= order.length) return null;
  const stage = order[index];
  const started = startInstallStage(stage, p, target);
  if (!started.jobId) return { done: true, state: "install-failed", error: lifecycleMessage("install-failed", started.error) };
  return { done: false, jobId: started.jobId, state: "install-in-progress", message: STAGE_MESSAGES[stage] };
}

function verifyArchive(p: Paths, target: Target): string | null {
  const file = nativePath(joinPath(p.runtime, target.archive.file));
  const [bin, ...args] = target.tools.hash.map((part) => part === "{file}" ? file : part);
  const run = runProcess(bin, args, { CT_HASH_FILE: file }, TIMEOUTS.hash);
  const digest = run.ok ? parseSha256(run.stdout) : null;
  if (digest === target.archive.sha256) return null;
  try { host.fs.removeFile(joinPath(p.runtime, target.archive.file)); } catch { }
  const observed = digest ? `got ${digest}` : `${bin} gave no digest: ${redact(run.ok ? run.stdout : `${run.error} ${run.stderr}`).trim().slice(0, 300)}`;
  return `The downloaded Go toolchain ${target.archive.file} did not match its pinned SHA-256 ${target.archive.sha256} (${observed}), so it was deleted and nothing was built.`;
}

function finishInstallStage(jobId: string, job: InstallJob, poll: { code?: number; stdout?: string; stderr?: string; error?: string }): any {
  delete installJobs[jobId];
  if (activeInstallJobId === jobId) activeInstallJobId = null;
  const { paths: p, target, stage } = job;
  if (poll.error || poll.code !== 0) {
    const detail = redact(String(poll.stderr || poll.error || "").trim().split(/\r?\n/).slice(-3).join(" ")).slice(0, 400);
    return { done: true, state: "install-failed", error: lifecycleMessage("install-failed", `The ${stage} step failed${detail ? `: ${detail}` : "."} Retry Sign in.`) };
  }
  if (stage === "download") {
    const mismatch = verifyArchive(p, target);
    if (mismatch) return { done: true, state: "install-failed", error: mismatch };
  }
  if (stage === "extract") {
    try { host.fs.removeFile(joinPath(p.runtime, target.archive.file)); } catch { }
    if (!host.fs.fileExists(p.goBinary)) return { done: true, state: "install-failed", error: lifecycleMessage("install-failed", "The Go toolchain archive did not contain the expected go binary.") };
  }
  if (stage === "module") {
    const module = parseGoModDownload(String(poll.stdout || ""));
    if (!module || module.error || module.version !== EXO_VERSION || module.sum !== EXO_MODULE_SUM) {
      return { done: true, state: "install-failed", error: `The exo-teams module did not match its pinned version ${EXO_VERSION} and checksum ${EXO_MODULE_SUM}, so it was not built.` };
    }
  }
  if (stage === "build") {
    if (!host.fs.fileExists(p.binary)) return { done: true, state: "install-failed", error: lifecycleMessage("install-failed", "go install finished without producing the exo-teams binary.") };
    host.fs.writeFile(p.marker, JSON.stringify({ module: EXO_MODULE, version: EXO_VERSION, sum: EXO_MODULE_SUM, go: GO_VERSION }));
    return startSignIn(p);
  }
  return nextInstallStage(p, target, stage);
}

function startSignIn(p: Paths): any {
  const pending = pendingSignIn(p);
  if (pending) return signInView(pending.log);
  endSignIn(p, true);
  try { host.fs.removeFile(p.loginLog); } catch { }
  let started: { jobId?: string; error?: string };
  try { started = host.exec.start({ bin: nativePath(p.binary), args: ["auth"], env: exoEnv(p), timeoutMs: SIGN_IN_TTL_MS + 60_000, detach: true, logFile: p.loginLog }); }
  catch { return { done: true, state: "sign-in-failed", error: "Could not start exo-teams sign-in." }; }
  if (!started.jobId) return { done: true, state: "sign-in-failed", error: started.error || "exo-teams sign-in did not start." };
  let pid: number | null = null;
  try {
    const poll = host.exec.poll(started.jobId) as any;
    const result = poll && typeof poll.stdout === "string" ? parseJson<any>(poll.stdout) : null;
    pid = Number.isInteger(poll?.pid) ? poll.pid : Number.isInteger(result?.pid) ? result.pid : null;
    if (poll && poll.done) host.exec.close(started.jobId);
  } catch { }
  host.fs.writeFile(p.loginState, JSON.stringify({ startedAt: now(), pid }));
  lastStatus = null;
  return signInView(readSignInLog(p));
}

function signInView(log: SignInLog): any {
  if (log.state === "awaiting-user") {
    return { done: false, state: "awaiting-user", signInUrl: log.signInUrl, deviceCode: log.deviceCode, message: `Open ${log.signInUrl} in your usual browser, enter code ${log.deviceCode}, and sign in with your work account. The code expires in 15 minutes.` };
  }
  return { done: false, state: "awaiting-user", message: "Microsoft is issuing a sign-in code. Poll login-status until it returns signInUrl and deviceCode." };
}

function loginStart(): any {
  const p = paths();
  if (!p) return { done: true, state: "unsupported-platform", error: lifecycleMessage("unsupported-platform") };
  if (activeInstallJobId) return loginPoll();
  const target = detectTarget(p);
  if ("state" in target) return { done: true, state: target.state, error: target.message };
  const secured = protectStorage(p);
  if (secured.error) return { done: true, state: secured.error, error: secured.message };
  if (!installedMarker(p)) return nextInstallStage(p, target);
  return startSignIn(p);
}

function loginPoll(): any {
  const p = paths();
  if (!p) return { done: true, state: "unsupported-platform", error: lifecycleMessage("unsupported-platform") };
  if (activeInstallJobId) {
    const jobId = activeInstallJobId;
    const job = installJobs[jobId];
    let poll: { done: boolean; code?: number; stdout?: string; stderr?: string; error?: string };
    try { poll = host.exec.poll(jobId); }
    catch { activeInstallJobId = null; return { done: true, state: "install-failed", error: "Could not read the install job." }; }
    if (!poll.done) return { done: false, jobId, state: "install-in-progress", message: STAGE_MESSAGES[job.stage] };
    try { host.exec.close(jobId); } catch { }
    return finishInstallStage(jobId, job, poll);
  }
  const record = readLoginRecord(p);
  if (!record) {
    const current = status();
    return { done: true, state: current.state, message: current.message };
  }
  const log = readSignInLog(p);
  if (log.state === "failed") {
    endSignIn(p, false);
    return { done: true, state: log.failure.state, error: log.failure.message };
  }
  if (log.state === "signed-in") {
    endSignIn(p, false);
    memoryChats = null;
    const current = status();
    return current.state === "logged-in"
      ? { done: true, state: "logged-in", message: current.message }
      : { done: true, state: current.state, error: current.message };
  }
  if (now() - record.startedAt > SIGN_IN_TTL_MS + 30_000) {
    endSignIn(p, true);
    return { done: true, state: "expired", error: "The sign-in code expired before the sign-in finished. Run login again for a fresh code." };
  }
  return signInView(log);
}

function agentLoginView(current: any): Record<string, unknown> {
  return {
    done: current.done === true,
    state: String(current.state || "awaiting-user"),
    signIn: current.deviceCode ? "device-code" : undefined,
    signInUrl: current.signInUrl,
    deviceCode: current.deviceCode,
    message: current.error || current.message,
    ...(current.error ? { error: current.error } : {}),
  };
}

function health(): Record<string, unknown> {
  return {
    ...status(),
    cli: { module: EXO_MODULE, version: EXO_VERSION, commit: "b9ebbf5", go: GO_VERSION },
    sendScope: readSendScope(),
    lastSend: lastSendState,
  };
}

function onAgentCommand(ctx: { sessionId: string; verb: string; args: string[] }): { result: string } | { error: string } {
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  switch (ctx.verb) {
    case "login": {
      if (args.length) return { error: "Usage: login." };
      const current = loginStart();
      if (current.error && current.done) return { error: current.error };
      return { result: JSON.stringify(agentLoginView(current)) };
    }
    case "login-status": {
      if (args.length) return { error: "Usage: login-status." };
      return { result: JSON.stringify(agentLoginView(loginPoll())) };
    }
    case "accounts": {
      const current = status();
      return { result: JSON.stringify({ state: current.state, accounts: current.accounts || [] }) };
    }
    case "use": return { error: "exo-teams keeps one signed-in Teams account. Run logout, then login with the other account." };
    case "chats": return agentChats(args);
    case "search": return args.length ? agentChats(args, true) : { error: "Usage: search <person name or email>." };
    case "history": return agentHistory(args);
    case "health": return { result: JSON.stringify(health()) };
    case "logout": return logout();
    case "send": return sendCommand("agent", args);
    case "send-to": return sendToCommand(args);
    case "send-file": return sendFileCommand(args);
    case "search-messages": return searchMessagesCommand(args);
    case "preview": return previewCommand(args, "agent");
    default: return { error: `Unknown Teams Client verb: ${ctx.verb}` };
  }
}

function viewCall(method: string, args: any): unknown {
  const value = args || {};
  if (method === "status") {
    const current = status();
    return { ...current, loginJobId: current.state === "awaiting-user" || activeInstallJobId ? "sign-in" : null };
  }
  if (method === "accounts") return { accounts: (lastStatus || status()).accounts || [] };
  if (method === "loginStart") return loginStart();
  if (method === "loginPoll") return loginPoll();
  if (method === "useAccount") return { error: "exo-teams keeps one signed-in Teams account. Sign out, then sign in with the other account." };
  if (method === "logout") return logout();
  if (method === "chats") return agentChats(String(value.query || "").trim() ? [String(value.query)] : []);
  if (method === "sendScope") return readSendScope();
  if (method === "setSendScope") return setSendScope(value);
  if (method === "preview") return previewCommand([String(value.chatId || ""), String(value.text || "")], "view");
  if (method === "send") return sendCommand("view", [String(value.chatId || ""), "--key", String(value.idempotencyKey || ""), String(value.text || "")]);
  return { error: `Unknown Teams Client view method: ${method}` };
}

function renderGlance(): GlanceView {
  const p = paths();
  const installed = !!(p && installedMarker(p));
  const current = lastStatus;
  const connected = current?.state === "logged-in";
  const nodes: ViewNode[] = [{ kind: "badge", label: connected ? "Connected" : installed ? "Sign-in needed" : "exo-teams not installed", tone: connected ? "ok" : installed ? "warn" : "muted" }];
  nodes.push({ kind: "text", text: connected ? `${current?.upn || "Account resolved"}` : "Open Teams Client to check status or sign in.", style: { tone: "muted" } });
  const scope = readSendScope();
  nodes.push({ kind: "text", text: scope.mode === "all" ? "Agent sends: any chat" : `Agent sends: ${scope.chats.length} allowed chat${scope.chats.length === 1 ? "" : "s"}`, style: { tone: scope.mode === "all" ? "muted" : "warn" } });
  if (lastSendState) nodes.push({ kind: "text", text: `Last send: ${lastSendState.state} · ${lastSendState.message}`, style: { tone: lastSendState.state === "sent" ? "ok" : "warn" } });
  return { title: "Teams Client", nodes };
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

const plugin: PluginModule = {
  onAgentCommand,
  renderGlance,
  viewCall: viewCall as PluginModule["viewCall"],
  __test_paths: paths,
  __test_setClock: (clock: (() => number) | null) => { injectedClock = clock; },
  __test_reset: () => {
    for (const id of Object.keys(installJobs)) delete installJobs[id];
    activeInstallJobId = null;
    cachedTarget = null;
    memoryChats = null;
    lastStatus = null;
    lastSendState = null;
    clearPreviewTokens();
    for (const key of Object.keys(storageProtectionCache)) delete storageProtectionCache[key];
  },
  __test_resolveTarget: resolveTarget,
  __test_windowsAclCommands: windowsAclCommands,
  __test_sha256Hex: sha256Hex,
  __test_boundedHistory: boundedHistory,
  __test_failureMessage: failureMessage,
};

export default plugin;
