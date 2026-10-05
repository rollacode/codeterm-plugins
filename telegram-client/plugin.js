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

// telegram-client/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);
var VERSION = "0.11.0";
var ROOT = "~/.local/share/codeterm-plugins/telegram-client";
var CONFIG_NAME = "gotd.cli.yaml";
var MAX_COUNT = 50;
var MAX_BYTES = 32 * 1024;
var SEND_DISABLED = "The send path is not enabled in this slice.";
var loginJobs = {};
var loginPasswords = {};
var loginLaunchPending = {};
var loginLogPaths = {};
function platformName() {
  try {
    return String(host.platform() || "").toLowerCase();
  } catch {
    return "";
  }
}
function paths() {
  try {
    const root = host.fs.expandHome(ROOT);
    if (!root) return null;
    const windows = platformName().indexOf("win") >= 0;
    return {
      root,
      binDir: `${root}/bin`,
      binary: `${root}/bin/tg${windows ? ".exe" : ""}`,
      config: `${root}/${CONFIG_NAME}`,
      install: `${root}/install.json`,
      failure: `${root}/install-status.json`
    };
  } catch {
    return null;
  }
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function redact(text) {
  let out = text || "";
  for (const key of ["api_id", "api_hash"]) {
    let value = "";
    try {
      value = host.secretGet(key) || "";
    } catch {
      value = "";
    }
    if (value) out = out.split(value).join("[redacted]");
  }
  return out;
}
function safeError(run) {
  if (run.ok) return "";
  const detail = redact(run.error || run.stderr || "tg command failed").trim();
  return detail.slice(0, 600) || "tg command failed";
}
function options(args, env, extra) {
  const p = paths();
  if (!p || !host.fs.fileExists(p.binary)) return null;
  const full = ["--config", p.config].concat(args);
  return { bin: p.binary, args: full, env: env || {}, ...extra || {} };
}
function startTg(args, env, extra) {
  const opts = options(args, env, extra);
  if (!opts) return { error: "tg is not installed. Run node telegram-client/scripts/install-tg.cjs from the plugins checkout." };
  try {
    return host.exec.start(opts);
  } catch {
    return { error: "Could not start tg. Check the plugin runtime directory and installation." };
  }
}
function awaitStarted(job) {
  if (job.error || !job.jobId) return { ok: false, error: job.error || "tg did not start", stderr: "" };
  try {
    const result = host.awaitJob(job.jobId, (value) => value);
    const stdout = redact(result.stdout || "");
    const stderr = redact(result.stderr || "");
    if (result.error) return { ok: false, error: redact(result.error), stderr };
    if (result.code !== 0) return { ok: false, error: stderr || stdout || `tg exited ${result.code}`, stderr };
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, error: redact(String(error)), stderr: "" };
  }
}
function runTg(args, env) {
  return awaitStarted(startTg(args, env));
}
function jsonCommand(args) {
  const run = runTg(["--output", "json"].concat(args));
  if (!run.ok) return { error: safeError(run), stderr: run.stderr };
  const parsed = parseJson(run.stdout.trim());
  if (!parsed || parsed.schema !== 1 || parsed.data === void 0) {
    return { error: "tg returned an unreadable JSON response." };
  }
  return { data: parsed.data, stderr: run.stderr };
}
function settings() {
  let value = {};
  try {
    value = parseJson(host.settingsJson()) || {};
  } catch {
    value = {};
  }
  const count = Number(value.historyCount);
  const bytes = Number(value.historyMaxBytes);
  return {
    historyCount: Number.isInteger(count) ? Math.max(1, Math.min(MAX_COUNT, count)) : 20,
    historyMaxBytes: Number.isInteger(bytes) ? Math.max(1024, Math.min(MAX_BYTES, bytes)) : MAX_BYTES
  };
}
function utf8Bytes(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) bytes += 1;
    else if (c < 2048) bytes += 2;
    else if (c >= 55296 && c <= 56319 && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
function cutText(text, units) {
  let end = Math.max(0, Math.min(text.length, units));
  if (end > 0 && end < text.length) {
    const c = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (c >= 55296 && c <= 56319 && next >= 56320 && next <= 57343) end--;
  }
  return text.slice(0, end);
}
function boundedHistory(chatId2, source, count, maxBytes) {
  const out = { chatId: chatId2, messages: [], truncated: false };
  for (const raw of (Array.isArray(source) ? source : []).slice(-count)) {
    const msg = {
      id: Number.isFinite(Number(raw && raw.id)) ? Number(raw.id) : null,
      date: Number.isFinite(Number(raw && raw.date)) ? Number(raw.date) : null,
      out: !!(raw && raw.out)
    };
    if (raw && typeof raw.text === "string") msg.text = raw.text;
    if (raw && Number.isFinite(Number(raw.reply_to))) msg.replyTo = Number(raw.reply_to);
    const before = out.messages.length;
    out.messages.push(msg);
    let json2 = JSON.stringify(out);
    if (utf8Bytes(json2) <= maxBytes) continue;
    out.messages.pop();
    const text = typeof msg.text === "string" ? msg.text : "";
    let low = 0;
    let high = text.length;
    let best = "";
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = { ...msg, text: cutText(text, mid) };
      out.messages.push(candidate);
      json2 = JSON.stringify(out);
      out.messages.pop();
      if (utf8Bytes(json2) <= maxBytes) {
        best = candidate.text;
        low = mid + 1;
      } else high = mid - 1;
    }
    if (best || utf8Bytes(JSON.stringify({ ...out, messages: out.messages.concat([{ id: msg.id, date: msg.date, out: msg.out }]) })) <= maxBytes) {
      if (best) msg.text = best;
      else delete msg.text;
      out.messages.push(msg);
      out.truncated = true;
      if (before >= count) break;
      continue;
    }
    out.truncated = true;
    break;
  }
  const json = JSON.stringify(out);
  return { value: out, json: utf8Bytes(json) <= maxBytes ? json : JSON.stringify({ chatId: chatId2, messages: [], truncated: true }) };
}
function validChatId(value) {
  return /^id:-?[0-9]{1,20}$/.test(value);
}
function chatId(peer) {
  if (!peer || typeof peer.id !== "number" && typeof peer.id !== "string") return null;
  if (typeof peer.id === "number" && !Number.isSafeInteger(peer.id)) return null;
  const id = String(peer.id);
  return /^-?[0-9]{1,20}$/.test(id) ? `id:${id}` : null;
}
function agentAccounts() {
  const response = jsonCommand(["accounts"]);
  if (response.error) return { error: response.error };
  const accounts = Array.isArray(response.data.accounts) ? response.data.accounts : [];
  return { result: JSON.stringify({ accounts: accounts.map((a) => ({
    id: String(a.label || ""),
    label: String(a.label || ""),
    hasSession: !!a.has_session,
    current: !!a.default
  })) }) };
}
function accountLabels() {
  const response = jsonCommand(["accounts"]);
  if (response.error) return { labels: [], current: null, error: response.error };
  const accounts = Array.isArray(response.data.accounts) ? response.data.accounts : [];
  return {
    labels: accounts.map((a) => String(a.label || "")).filter(Boolean),
    current: (accounts.find((a) => a.default) || {}).label || null
  };
}
function useAccount(label) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(label) || label === "all") return { error: "Use a configured account label." };
  const current = accountLabels();
  if (current.error) return { error: current.error };
  if (current.labels.indexOf(label) < 0) return { error: "That account is not configured. Open the Telegram view to add it." };
  const run = runTg(["accounts", "default", label]);
  if (!run.ok) return { error: safeError(run) };
  return { result: JSON.stringify({ currentAccount: label }) };
}
function agentChats() {
  const response = jsonCommand(["chats", "list", "--limit", "100"]);
  if (response.error) return { error: response.error };
  const source = Array.isArray(response.data.chats) ? response.data.chats : [];
  const chats = source.flatMap((item) => {
    const id = chatId(item && item.peer);
    if (!id) return [];
    return [{ id, title: String(item.peer && (item.peer.label || item.peer.title) || ""), unread: Number(item.unread) || 0 }];
  });
  return { result: JSON.stringify({ chats }) };
}
function agentHistory(args) {
  if (args.length < 1 || args.length > 2 || !validChatId(args[0])) return { error: "Usage: history id:<numeric-chat-id> [count]. Select an id from chats." };
  const configured = settings();
  let count = configured.historyCount;
  if (args.length === 2) {
    if (!/^[0-9]+$/.test(args[1])) return { error: "History count must be an integer from 1 to 50." };
    count = Math.max(1, Math.min(MAX_COUNT, Number(args[1])));
  }
  const response = jsonCommand(["history", args[0], "--limit", String(count)]);
  if (response.error) return { error: response.error };
  const history = boundedHistory(args[0], response.data.messages, count, configured.historyMaxBytes);
  return { result: history.json };
}
function authFailure(message) {
  return /not authorized|auth_key_unregistered|session_revoked|session_expired|user_deactivated|authorization key/i.test(message);
}
function storageBackend() {
  if (/darwin|mac/i.test(platformName())) return { name: "macOS login Keychain", note: "tg keeps the session in the login Keychain by default." };
  return { name: "plugin-owned plaintext file", note: "This host stores the session as a 0600 file. The plugin runtime can read files in its own data directory." };
}
function failureState(p) {
  try {
    const value = host.fs.readJson(p.failure);
    if (value && typeof value.state === "string") return { state: value.state, message: String(value.message || "") };
  } catch {
  }
  return {};
}
function versionOlder(installed, required) {
  const parts = (value) => value.split(".").map((part) => Number(part));
  const left = parts(installed);
  const right = parts(required);
  if (left.some((part) => !Number.isFinite(part)) || right.some((part) => !Number.isFinite(part))) return false;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] || 0;
    const b = right[i] || 0;
    if (a !== b) return a < b;
  }
  return false;
}
function status() {
  const p = paths();
  if (!p) return { state: "unsupported-platform", message: "The host home directory is unavailable.", storage: storageBackend() };
  const storage = storageBackend();
  const failure = failureState(p);
  if (failure.state === "unsupported-platform" || failure.state === "checksum-mismatch") {
    return { state: failure.state, message: failure.message, storage, accounts: [], currentAccount: null };
  }
  if (!/darwin|mac|linux|win/i.test(platformName())) {
    return { state: "unsupported-platform", message: `No pinned tg release is available for ${platformName() || "this operating system"}.`, storage, accounts: [], currentAccount: null };
  }
  if (failure.state) return { state: "install-error", message: failure.message || "The pinned tg install did not complete.", storage, accounts: [], currentAccount: null };
  if (!host.fs.fileExists(p.binary)) {
    return { state: "not-installed", message: "Install the pinned tg release with node telegram-client/scripts/install-tg.cjs.", storage, accounts: [], currentAccount: null };
  }
  const install = host.fs.readJson(p.install);
  if (install && install.version && install.version !== VERSION) {
    const state = versionOlder(String(install.version), VERSION) ? "upgrade-available" : "install-error";
    const message = state === "upgrade-available" ? `tg ${VERSION} is pinned; installed metadata reports ${String(install.version)}. Run the installer to upgrade.` : `Installed tg ${String(install.version)} does not match pinned ${VERSION}. Reinstall the pinned release.`;
    return { state, message, storage, accounts: [], currentAccount: null };
  }
  if (host.secretGet("config_initialized") !== "true") {
    const wasConfigured = host.secretGet("configured_once") === "true";
    return {
      state: wasConfigured ? "logged-out" : "installed-but-not-configured",
      message: wasConfigured ? "Signed out. Enter your Telegram API ID and hash to sign in again." : "Enter your own Telegram API ID and hash, then start QR login.",
      storage,
      accounts: [],
      currentAccount: null
    };
  }
  const listed = accountLabels();
  if (listed.error) {
    const state = authFailure(listed.error) ? "reauth-needed" : "logged-out";
    const message = state === "reauth-needed" ? "Telegram needs authorization again. Start QR login in the view." : "Telegram account config could not be read. Re-enter your own API credentials in the view.";
    return { state, message, storage, accounts: [], currentAccount: null };
  }
  const result = jsonCommand(["whoami"]);
  const accounts = jsonCommand(["accounts"]);
  const accountRows = accounts.error ? [] : (Array.isArray(accounts.data.accounts) ? accounts.data.accounts : []).map((a) => ({
    id: String(a.label || ""),
    label: String(a.label || ""),
    hasSession: !!a.has_session,
    current: !!a.default
  }));
  const active = accountRows.find((a) => a.current) || null;
  if (result.error) {
    const hasSession = active && active.hasSession;
    const state = authFailure(result.error) ? "reauth-needed" : hasSession ? "logged-in" : "logged-out";
    const message = state === "reauth-needed" ? "The Telegram session expired or was revoked. Start QR login in the view." : state === "logged-out" ? "No signed-in Telegram session is selected. Start QR login in the view." : "A session is present, but Telegram could not be reached. Refresh status when the connection is available.";
    return { state, message, storage, accounts: accountRows, currentAccount: active && active.label, resolvedAccount: null };
  }
  return {
    state: active && active.hasSession ? "logged-in" : "logged-out",
    message: active && active.hasSession ? "Telegram account resolved." : "No signed-in sender is selected.",
    storage,
    accounts: accountRows,
    currentAccount: active && active.label,
    resolvedAccount: result.data
  };
}
function ensureAccount(label, apiId, apiHash) {
  const p = paths();
  if (!p) return { error: "The host home directory is unavailable." };
  if (!host.fs.fileExists(p.binDir)) return { error: "The plugin runtime directory is missing. Reinstall the pinned tg binary." };
  let configExists = false;
  try {
    configExists = host.secretGet("config_initialized") === "true";
  } catch {
    configExists = false;
  }
  if (!configExists) {
    const existing = jsonCommand(["accounts"]);
    if (!existing.error) {
      configExists = true;
      try {
        if (!host.secretSet("config_initialized", "true")) return { error: "Could not record Telegram config state in the host secret store." };
      } catch {
        return { error: "Could not record Telegram config state in the host secret store." };
      }
    } else if (!/no config at .*tg init first|run `tg init` first/i.test(existing.error)) {
      return { error: existing.error };
    }
  }
  if (!configExists) {
    const init = runTg(["init"], { APP_ID: apiId, APP_HASH: apiHash });
    if (!init.ok) return { error: safeError(init) };
    try {
      if (!host.secretSet("config_initialized", "true")) return { error: "tg created the config, but CodeTerm could not record its state. Retry login to recover." };
    } catch {
      return { error: "tg created the config, but CodeTerm could not record its state. Retry login to recover." };
    }
  }
  if (label !== "default") {
    const listed = accountLabels();
    if (listed.error) return { error: listed.error };
    if (listed.labels.indexOf(label) < 0) {
      const add = runTg(["accounts", "add", label], { APP_ID: apiId, APP_HASH: apiHash });
      if (!add.ok) return { error: safeError(add) };
    }
  }
  return {};
}
function loginStart(args) {
  const p = paths();
  if (!p || !host.fs.fileExists(p.binary)) return { error: "tg is not installed. Run node telegram-client/scripts/install-tg.cjs from the plugins checkout." };
  const apiId = String(args.apiId || "").trim();
  const apiHash = String(args.apiHash || "").trim();
  const label = String(args.accountLabel || "default").trim();
  const twoFactorPassword = String(args.twoFactorPassword || "");
  if (!/^[0-9]{1,12}$/.test(apiId) || !/^[A-Fa-f0-9]{32}$/.test(apiHash)) return { error: "Enter your own numeric Telegram API ID and 32-character API hash." };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(label) || label === "all") return { error: "Account label must use letters, numbers, hyphens, or underscores." };
  if (!host.secretSet("api_id", apiId) || !host.secretSet("api_hash", apiHash)) return { error: "Could not store Telegram API credentials in the host secret store." };
  const setup = ensureAccount(label, apiId, apiHash);
  if (setup.error) return { error: setup.error };
  const logFile = `${p.root}/login-${label}.log`;
  try {
    host.fs.removeFile(logFile);
  } catch {
  }
  const job = startTg(["--account", label, "login", "--output", "json"], twoFactorPassword ? { TG_PASSWORD: twoFactorPassword } : {}, { detach: true, logFile });
  if (job.error || !job.jobId) return { error: job.error || "tg login did not start." };
  loginJobs[job.jobId] = label;
  loginLaunchPending[job.jobId] = true;
  loginLogPaths[job.jobId] = logFile;
  if (twoFactorPassword) loginPasswords[job.jobId] = twoFactorPassword;
  return { jobId: job.jobId, accountLabel: label, state: "login-in-progress", message: "Login is running. Poll progress here and scan the QR shown below." };
}
function loginPoll(jobId) {
  if (!jobId || !loginJobs[jobId]) return { error: "Unknown login job." };
  const p = paths();
  if (!p) return { error: "The host home directory is unavailable." };
  if (loginLaunchPending[jobId]) {
    let launch;
    try {
      launch = host.exec.poll(jobId);
    } catch {
      return { error: "Could not read the login job." };
    }
    if (!launch.done) {
      let partial = host.fs.readFileTail(loginLogPaths[jobId], 8192) || "";
      const password = loginPasswords[jobId] || "";
      if (password) partial = partial.split(password).join("[redacted]");
      return { done: false, output: redact(partial), state: "login-in-progress" };
    }
    delete loginLaunchPending[jobId];
    if (launch.error || launch.code !== 0) {
      delete loginJobs[jobId];
      delete loginPasswords[jobId];
      delete loginLogPaths[jobId];
      return { done: true, output: redact(launch.stderr || ""), error: redact(launch.error || launch.stderr || "tg login could not start."), state: "reauth-needed" };
    }
  }
  let output = host.fs.readFileTail(loginLogPaths[jobId], 8192) || "";
  const twoFactorPassword = loginPasswords[jobId] || "";
  if (twoFactorPassword) output = output.split(twoFactorPassword).join("[redacted]");
  output = redact(output);
  const label = loginJobs[jobId];
  const verified = jsonCommand(["--account", label, "whoami"]);
  if (verified.error) return { done: false, output, state: "login-in-progress", message: "Scan the QR, then refresh progress. Telegram session authorization is still pending." };
  const selected = runTg(["accounts", "default", label]);
  if (!selected.ok) return { done: false, output, state: "login-in-progress", message: safeError(selected) };
  delete loginJobs[jobId];
  delete loginPasswords[jobId];
  delete loginLogPaths[jobId];
  try {
    host.fs.removeFile(`${p.root}/login-${label}.log`);
  } catch {
  }
  try {
    host.secretSet("configured_once", "true");
  } catch {
  }
  return { done: true, output, state: "logged-in", currentAccount: label };
}
function removeFiles(p) {
  const entries = host.fs.readDir(p.root) || [];
  for (const entry of entries) {
    if ((/^gotd\.(session|peers)\..+\.json$/.test(entry.name) || /^login-[A-Za-z0-9_-]+\.log$/.test(entry.name)) && host.fs.fileExists(entry.path)) {
      if (!host.fs.removeFile(entry.path) && host.fs.fileExists(entry.path)) return false;
    }
  }
  if (host.secretGet("config_initialized") === "true" && !host.fs.removeFile(p.config)) return false;
  return true;
}
function clearSecret(name) {
  return !host.secretGet(name) || host.secretDelete(name);
}
function logout() {
  const p = paths();
  if (!p) return { error: "The host home directory is unavailable." };
  if (host.secretGet("config_initialized") === "true") {
    if (!host.fs.fileExists(p.binary)) return { error: "tg is missing. Reinstall the pinned helper, then retry logout so the Keychain session can be removed." };
    const listed = accountLabels();
    if (listed.error) return { error: "Could not list configured accounts. The config and sessions were kept so logout can be retried." };
    for (const label of listed.labels.length ? listed.labels : ["default"]) {
      const removed = runTg(["--account", label, "logout"]);
      if (!removed.ok) return { error: `Could not verify local logout for account ${label}. The config was kept so logout can be retried.` };
    }
  }
  try {
    if (!removeFiles(p)) return { error: "Could not remove the local Telegram config and session files." };
  } catch {
    return { error: "Could not remove the local Telegram config and session files." };
  }
  try {
    const apiIdDeleted = clearSecret("api_id");
    const apiHashDeleted = clearSecret("api_hash");
    const configMarkerDeleted = clearSecret("config_initialized");
    const logoutMarkerSaved = host.secretSet("configured_once", "true");
    if (!apiIdDeleted || !apiHashDeleted || !configMarkerDeleted || !logoutMarkerSaved) return { error: "Local files were removed, but the host could not update all Telegram secret state." };
  } catch {
    return { error: "Local files were removed, but the host could not update all Telegram secret state." };
  }
  return { result: "Logged out. Telegram config and local session files were removed." };
}
function onAgentCommand(ctx) {
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  switch (ctx.verb) {
    case "accounts":
      return agentAccounts();
    case "use":
      return args.length === 1 ? useAccount(args[0]) : { error: "Usage: use <configured-account-id>." };
    case "chats":
      return agentChats();
    case "history":
      return agentHistory(args);
    case "health": {
      const current = status();
      delete current.resolvedAccount;
      return { result: JSON.stringify(current) };
    }
    case "logout":
      return logout();
    case "send":
    case "preview":
      return { error: SEND_DISABLED };
    default:
      return { error: `Unknown Telegram verb: ${ctx.verb}` };
  }
}
function renderGlance() {
  const p = paths();
  const nodes = [];
  if (!p || !host.fs.fileExists(p.binary)) {
    nodes.push({ kind: "badge", label: "tg not installed", tone: "warn" });
    nodes.push({ kind: "text", text: "Install the pinned release from the Telegram Client README.", style: { tone: "muted" } });
  } else if (host.secretGet("config_initialized") !== "true") {
    nodes.push({ kind: "badge", label: "Not signed in", tone: "warn" });
    nodes.push({ kind: "text", text: "Open Telegram Client to configure your account.", style: { tone: "muted" } });
  } else {
    nodes.push({ kind: "badge", label: "Configured", tone: "ok" });
    nodes.push({ kind: "text", text: storageBackend().name, style: { tone: "muted" } });
  }
  return { title: "Telegram Client", nodes };
}
function viewCall(method, args) {
  args = args || {};
  if (method === "status") return status();
  if (method === "loginStart") return loginStart(args);
  if (method === "loginPoll") return loginPoll(String(args.jobId || ""));
  if (method === "useAccount") return useAccount(String(args.id || ""));
  if (method === "logout") return logout();
  return { error: `Unknown Telegram view method: ${method}` };
}
var plugin = {
  onAgentCommand,
  renderGlance,
  viewCall,
  __test_paths: paths,
  __test_options: options,
  __test_utf8Bytes: utf8Bytes,
  __test_boundedHistory: boundedHistory,
  __test_validChatId: validChatId,
  __test_chatId: chatId,
  __test_storageBackend: storageBackend,
  __test_versionOlder: versionOlder,
  __test_status: status,
  __test_loginStart: loginStart,
  __test_loginPoll: loginPoll,
  __test_logout: logout,
  __test_agentHistory: agentHistory
};
var plugin_default = plugin;
