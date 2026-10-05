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
var ROOT = "~/.codeterm/telegram-client";
var CONFIG_NAME = "gotd.cli.yaml";
var INITIAL_SEND_POLICY_MODE = "saved-messages-only";
var MAX_COUNT = 50;
var MAX_BYTES = 32 * 1024;
var loginJobs = {};
var loginPasswords = {};
var loginLaunchPending = {};
var loginLogPaths = {};
var activeLoginJobId = null;
var previewTokens = {};
var injectedClock = null;
var transientSendFailure = null;
function platformName() {
  try {
    return String(host.platform() || "").toLowerCase();
  } catch {
    return "";
  }
}
function binaryName() {
  return host.path.isWindows ? "tg.exe" : "tg";
}
function nativePath(value) {
  return host.path.toNative(host.path.normalize(value));
}
function childPath(root, name) {
  const child = nativePath(`${root}/${name}`);
  if (host.path.equal(child, root)) throw new Error("plugin data path resolved to its root");
  return child;
}
function paths() {
  try {
    const expanded = host.fs.expandHome(ROOT);
    const root = expanded ? nativePath(expanded) : "";
    if (!root) return null;
    return {
      root,
      binDir: childPath(root, "bin"),
      binary: childPath(childPath(root, "bin"), binaryName()),
      config: childPath(root, CONFIG_NAME),
      install: childPath(root, "install.json"),
      failure: childPath(root, "install-status.json"),
      outbox: childPath(root, "outbox.json"),
      policy: childPath(root, "send-policy.json")
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
function telegramLoginArtifacts(text) {
  const safe = redact(String(text || "")).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ");
  const match = safe.match(/tg:\/\/login\?token=[A-Za-z0-9_%=-]+/i);
  if (!match) return {};
  const link = match[0].replace(/[),.;]+$/, "");
  return { qrPayload: link, tgLink: link };
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
    const started = host.exec.start(opts);
    if (!started || !started.jobId && !started.error) return { error: "tg start returned no job identifier.", ambiguousStart: true };
    return started;
  } catch {
    return { error: "Could not confirm whether tg started.", ambiguousStart: true };
  }
}
function runTg(args, env) {
  const opts = options(args, env, { timeoutMs: 4500 });
  if (!opts) return { ok: false, error: "tg is not installed. Run node telegram-client/scripts/install-tg.cjs from the plugins checkout.", stderr: "" };
  const raw = host.exec(JSON.stringify(opts));
  const result = parseJson(raw);
  if (!result) return { ok: false, error: "tg returned an unreadable process result.", stderr: "" };
  const stdout = redact(result.stdout || "");
  const stderr = redact(result.stderr || "");
  if (result.error) return { ok: false, error: redact(result.error), stderr };
  if (result.code !== 0) return { ok: false, error: stderr || stdout || `tg exited ${result.code}`, stderr };
  return { ok: true, stdout, stderr };
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
function policySummary() {
  const p = paths();
  if (!p) return { configured: false, mode: null, allowedDestinations: [] };
  let policy = null;
  try {
    policy = host.fs.readJson(p.policy);
  } catch {
    policy = null;
  }
  if (!policy || policy.approved !== true || policy.mode !== INITIAL_SEND_POLICY_MODE || !/^[A-Za-z0-9_-]{1,64}$/.test(String(policy.senderAccountId || "")) || !validChatId(String(policy.savedMessagesId || ""))) {
    return { configured: false, mode: null, allowedDestinations: [] };
  }
  return {
    configured: true,
    mode: "saved-messages-only",
    senderAccountId: String(policy.senderAccountId || ""),
    allowedDestinations: [{ id: String(policy.savedMessagesId), label: "Saved Messages" }],
    approvedAt: Number(policy.approvedAt) || null
  };
}
function resolveSender() {
  const current = status();
  if (current.state === "reauth-needed") return { error: "reauth-needed: Open Telegram Client and complete QR login again before previewing or sending." };
  if (current.state === "logged-in" && current.currentAccount && !current.resolvedAccount) {
    return { error: "upstream-rejected: The signed-in sender could not be resolved from Telegram. Restore the connection and refresh status before sending." };
  }
  if (current.state !== "logged-in" || !current.currentAccount || !current.resolvedAccount) {
    return { error: "not-logged-in: Sign in to a Telegram account in Telegram Client, then preview the sender again." };
  }
  const identity = current.resolvedAccount;
  const telegramUserId = identity && Number.isSafeInteger(Number(identity.id)) ? String(Number(identity.id)) : "";
  if (!telegramUserId) return { error: "not-logged-in: Telegram did not resolve a numeric account identity. Refresh status or sign in again." };
  const name = [identity.first_name, identity.last_name].map((part) => String(part || "").trim()).filter(Boolean).join(" ");
  const username = String(identity.username || "").replace(/^@/, "");
  return { sender: {
    id: String(current.currentAccount),
    displayName: name || (username ? `@${username}` : `Telegram user ${telegramUserId}`),
    username: username ? `@${username}` : null,
    telegramUserId
  } };
}
function resolveDestination(id, sender) {
  if (!validChatId(id)) return { error: "Usage: preview <immutable-chat-id> <text>. Select an id such as id:12345 from chats; display names are not accepted." };
  if (id === `id:${sender.telegramUserId}`) {
    return { destination: { id, label: "Saved Messages" } };
  }
  const response = agentChats();
  if ("error" in response) return { error: `Could not resolve destination ${id}: ${response.error}` };
  const chats = parseJson(response.result).chats;
  const match = chats.find((chat) => chat.id === id);
  if (!match) return { error: `No Telegram chat has immutable id ${id}. Refresh chats and select an id from that list.` };
  return { destination: { id: String(match.id), label: String(match.title || match.id) } };
}
var previewSequence = 0;
function previewCommand(args, origin = "agent") {
  if (args.length < 2) return { error: "Usage: preview <immutable-chat-id> <text>." };
  if (!validChatId(args[0])) return { error: "Usage: preview <immutable-chat-id> <text>. Display names are not accepted; choose an id from chats." };
  const text = args.slice(1).join(" ");
  if (!text.length) return { error: "Preview text must not be empty." };
  const resolved = resolveSender();
  if ("error" in resolved) return { error: resolved.error };
  const destination = resolveDestination(args[0], resolved.sender);
  if ("error" in destination) return { error: destination.error };
  const previewId = sha256Hex(`preview\0${now()}\0${++previewSequence}`);
  previewTokens[previewId] = { sender: resolved.sender, destination: destination.destination, text, origin, previewNonce: previewId };
  return { result: JSON.stringify({
    previewId,
    sender: resolved.sender,
    destination: destination.destination,
    text,
    policy: policySummary()
  }) };
}
function failureMessage(kind, detail) {
  switch (kind) {
    case "not-logged-in":
      return "not-logged-in: Sign in to Telegram Client and confirm the sender account, then preview and send again.";
    case "reauth-needed":
      return "reauth-needed: Telegram authorization expired or was revoked. Complete QR login in Telegram Client before sending again.";
    case "policy-not-set":
      return "policy-not-set: Review the resolved sender and Saved Messages destination in Telegram Client, then explicitly enable the Saved-Messages-only policy.";
    case "destination-not-permitted":
      return `destination-not-permitted: This destination is outside the Saved-Messages-only policy. Its permitted immutable id is ${String(detail || "unavailable")}. Select that exact id or have the owner review a different policy.`;
    case "rate-limited":
      return `rate-limited: Telegram asked this account to wait until ${Number(detail) || 0}. Invoke send again after that deadline; the plugin will not wait or retry automatically.`;
    case "upstream-rejected":
      return `upstream-rejected: Telegram rejected the request or the local send prerequisite failed (${String(detail || "no further detail")}). Correct the reported issue, then invoke send again if you still want it delivered.`;
    case "unknown":
      return "unknown: Telegram may have accepted this message but the confirmation was lost. Do not retry this idempotency key; inspect Saved Messages and decide manually.";
  }
  return "upstream-rejected: The send failure state was not recognized. Inspect Telegram Client status before trying again.";
}
function setSendPolicy(args) {
  if (args.approveSavedMessagesOnly !== true) return { error: "No send policy was changed. Use the explicit Saved Messages only approval control after reviewing its preview." };
  const preview = previewTokens[String(args.previewId || "")];
  if (!preview || preview.origin !== "view") return { error: "Only a preview created in this view can enable a send policy. Review a fresh view preview first." };
  const expected = `id:${preview.sender.telegramUserId}`;
  if (preview.destination.id !== expected || preview.destination.label !== "Saved Messages") {
    return { error: "The initial send policy can permit only this sender's Saved Messages destination. Preview Saved Messages before approving it." };
  }
  const currentSender = resolveSender();
  if ("error" in currentSender || currentSender.sender.id !== preview.sender.id || currentSender.sender.telegramUserId !== preview.sender.telegramUserId) {
    return { error: "The resolved sender changed or is unavailable. Review a fresh Saved Messages preview before enabling the policy." };
  }
  const p = paths();
  if (!p) return { error: "Could not resolve the Telegram Client data directory; no send policy was written." };
  try {
    if (!host.fs.makeDirs(p.root)) return { error: "Could not create the Telegram Client data directory; no send policy was written." };
    const saved = host.fs.writeFile(p.policy, JSON.stringify({
      approved: true,
      mode: INITIAL_SEND_POLICY_MODE,
      savedMessagesId: preview.destination.id,
      senderAccountId: preview.sender.id,
      approvedAt: now()
    }));
    if (!saved) return { error: "Could not persist the send policy in Telegram Client data; no policy is enabled." };
  } catch {
    return { error: "Could not persist the send policy in Telegram Client data; no policy is enabled." };
  }
  return { result: JSON.stringify(policySummary()) };
}
function loadOutbox(p) {
  try {
    if (!host.fs.fileExists(p.outbox)) return { ledger: { schema: 1, attempts: [] } };
    const value = host.fs.readJson(p.outbox);
    if (!value || value.schema !== 1 || !Array.isArray(value.attempts)) return { error: "the existing outbox ledger is unreadable" };
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
  transientSendFailure = { state: kind, message, updatedAt: now() };
  return { error: message };
}
function sendFailureResult(kind, detail) {
  return rememberSendFailure(kind, failureMessage(kind, detail));
}
function rememberPrefixedFailure(message) {
  const state = message.slice(0, message.indexOf(":"));
  const allowed = ["not-logged-in", "reauth-needed", "policy-not-set", "destination-not-permitted", "rate-limited", "upstream-rejected", "unknown"];
  return allowed.indexOf(state) >= 0 ? rememberSendFailure(state, message) : rememberSendFailure("unknown", "The command result could not be classified safely. Inspect Telegram before retrying.");
}
function parseSendArgs(args) {
  if (args.length < 2 || !validChatId(args[0])) return { error: "destination-not-permitted: Usage: send <immutable-chat-id> [--key <idempotency-key>] <text>. Choose an id from chats; display names are not accepted." };
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
  if (authFailure(message)) return "reauth-needed";
  if (/not logged in|no active session|run tg login/i.test(message)) return "not-logged-in";
  if (waitSeconds(message) !== null) return "rate-limited";
  if (/MESSAGE_TOO_LONG|PEER_ID_INVALID|CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|USER_PRIVACY_RESTRICTED|CHAT_ADMIN_REQUIRED|WRITE_FORBIDDEN/i.test(message)) return "upstream-rejected";
  if (/exec denied|spawn .*?(?:ENOENT|EACCES)|binary .*?not found|not installed/i.test(message)) return "upstream-rejected";
  return "unknown";
}
function waitSeconds(message) {
  const match = message.match(/FLOOD_WAIT_(\d+)/i) || message.match(/wait of\s+(\d+)\s+seconds/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
function attemptResult(attempt) {
  transientSendFailure = null;
  return { result: JSON.stringify({
    status: "sent",
    sender: attempt.sender,
    destination: attempt.destination,
    idempotencyKey: attempt.idempotencyKey,
    telegramMessageId: attempt.telegramMessageId || null,
    deliveryGuarantee: "The local ledger prevents another send for a recorded sent key. Telegram does not provide an exactly-once delivery guarantee."
  }) };
}
function failAttempt(p, ledger, attempt, kind, detail) {
  attempt.failure = kind;
  attempt.failureMessage = failureMessage(kind, detail);
  attempt.updatedAt = now();
  if (kind === "rate-limited") {
    const seconds = waitSeconds(String(detail || ""));
    if (seconds === null) return failAttempt(p, ledger, attempt, "upstream-rejected", "Telegram returned a rate-limit message without a retry duration; check Telegram before retrying");
    attempt.state = "rate_limited";
    attempt.retryAfter = now() + seconds * 1e3;
    attempt.failureMessage = failureMessage(kind, attempt.retryAfter);
  } else if (kind === "unknown") {
    attempt.state = "unknown";
    delete attempt.retryAfter;
  } else {
    attempt.state = "failed";
    delete attempt.retryAfter;
  }
  persistOutbox(p, ledger);
  return rememberSendFailure(kind, attempt.failureMessage);
}
function recordedByCallerKey(key, chatId2, text) {
  const p = paths();
  if (!p) return sendFailureResult("upstream-rejected", "the plugin-owned data directory is unavailable");
  const loaded = loadOutbox(p);
  if (!loaded.ledger) return sendFailureResult("upstream-rejected", loaded.error);
  const attempt = loaded.ledger.attempts.find((item) => item.idempotencyKey === key);
  if (!attempt) return null;
  if (attempt.payloadHash !== sha256Hex(text) || attempt.destination.id !== chatId2) {
    return sendFailureResult("upstream-rejected", "this idempotency key is already bound to a different destination or payload; choose a new key");
  }
  if (attempt.state === "sent") return attemptResult(attempt);
  if (attempt.state === "unknown") return sendFailureResult("unknown");
  if (attempt.state === "pending") return failAttempt(p, loaded.ledger, attempt, "unknown", "a prior invocation ended while its send result was unrecorded");
  if (attempt.state === "rate_limited" && Number(attempt.retryAfter) > now()) return sendFailureResult("rate-limited", attempt.retryAfter);
  return null;
}
function sendCommand(sessionId, args) {
  const parsed = parseSendArgs(args);
  if ("error" in parsed) return rememberPrefixedFailure(parsed.error);
  const matchingPreview = Object.values(previewTokens).reverse().find((token) => token.sender.id === policySummary().senderAccountId && token.destination.id === parsed.chatId && token.text === parsed.text);
  const key = parsed.key || matchingPreview?.previewNonce;
  if (key) {
    const recorded = recordedByCallerKey(key, parsed.chatId, parsed.text);
    if (recorded) return recorded;
  }
  const policy = policySummary();
  if (!policy.configured) return sendFailureResult("policy-not-set");
  const resolved = resolveSender();
  if ("error" in resolved) return rememberPrefixedFailure(resolved.error);
  const found = resolveDestination(parsed.chatId, resolved.sender);
  if ("error" in found) return sendFailureResult("destination-not-permitted", policy.allowedDestinations[0] && policy.allowedDestinations[0].id);
  const permitted = policy.senderAccountId === resolved.sender.id && policy.allowedDestinations.some((entry) => entry.id === found.destination.id && found.destination.label === "Saved Messages");
  if (!permitted || found.destination.id !== `id:${resolved.sender.telegramUserId}`) return sendFailureResult("destination-not-permitted", policy.allowedDestinations[0] && policy.allowedDestinations[0].id);
  if (!key) return sendFailureResult("upstream-rejected", "create a fresh preview before sending without an explicit idempotency key");
  const payloadHash = sha256Hex(parsed.text);
  const p = paths();
  if (!p) return sendFailureResult("upstream-rejected", "the plugin-owned data directory is unavailable");
  const loaded = loadOutbox(p);
  if (!loaded.ledger) return sendFailureResult("upstream-rejected", loaded.error);
  const ledger = loaded.ledger;
  let attempt = ledger.attempts.find((item) => item.idempotencyKey === key);
  if (attempt && (attempt.payloadHash !== payloadHash || attempt.sender.id !== resolved.sender.id || attempt.destination.id !== found.destination.id)) {
    return sendFailureResult("upstream-rejected", "this idempotency key is already bound to a different sender, destination, or payload; choose a new key");
  }
  if (attempt && attempt.state === "sent") return attemptResult(attempt);
  if (attempt && attempt.state === "unknown") return sendFailureResult("unknown");
  if (attempt && attempt.state === "pending") {
    return failAttempt(p, ledger, attempt, "unknown", "a prior invocation ended while its send result was unrecorded");
  }
  if (attempt && attempt.state === "rate_limited" && Number(attempt.retryAfter) > now()) {
    return sendFailureResult("rate-limited", attempt.retryAfter);
  }
  if (!attempt) {
    attempt = {
      idempotencyKey: key,
      sender: resolved.sender,
      destination: found.destination,
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
  delete attempt.failureMessage;
  delete attempt.retryAfter;
  if (!persistOutbox(p, ledger)) return sendFailureResult("upstream-rejected", "the pending attempt could not be persisted; Telegram was not contacted");
  const opts = options(["--account", resolved.sender.id, "--output", "json", "send", "--", parsed.text], void 0, { timeoutMs: 5e3 });
  if (!opts) return failAttempt(p, ledger, attempt, "upstream-rejected", "tg binary is unavailable before send");
  return host.exec.async(opts, (result) => {
    const output = redact(result.stdout || "");
    const detail = redact(result.error || result.stderr || output).trim();
    if (result.error || typeof result.code !== "number" || result.code !== 0) return failAttempt(p, ledger, attempt, failureForUpstream(detail), detail);
    const response = parseJson(output.trim());
    if (!response || response.schema !== 1 || response.data === void 0) return failAttempt(p, ledger, attempt, "unknown");
    const message = response.data.message || response.data;
    const upstreamId = message && (message.id !== void 0 ? message.id : message.message_id);
    attempt.telegramMessageId = upstreamId === void 0 || upstreamId === null ? void 0 : String(upstreamId);
    attempt.state = "sent";
    attempt.updatedAt = now();
    delete attempt.failure;
    delete attempt.failureMessage;
    if (!persistOutbox(p, ledger)) return sendFailureResult("unknown");
    return attemptResult(attempt);
  });
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
  const platform = platformName();
  if (platform === "darwin" || platform === "mac" || platform === "macos") return { name: "macOS login Keychain", note: "tg keeps the session in the login Keychain by default." };
  if (host.path.isWindows) return { name: "plugin-owned plaintext file", note: "tg stores the session under this plugin data directory on Windows. This plugin does not inspect or set a Windows ACL, so it makes no ACL protection claim." };
  return { name: "plugin-owned plaintext file", note: "On POSIX hosts tg stores the session in a 0600 file under this plugin's private data directory." };
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
  const platform = platformName();
  const supportedPlatform = /^(darwin|mac|macos|linux)$/.test(platform) || host.path.isWindows;
  if (!supportedPlatform) {
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
function loginStart(args, fromAgent = false) {
  const p = paths();
  if (!p || !host.fs.fileExists(p.binary)) return { error: "tg is not installed. Run node telegram-client/scripts/install-tg.cjs from the plugins checkout." };
  if (activeLoginJobId && loginJobs[activeLoginJobId]) return { jobId: activeLoginJobId, state: "login-in-progress", message: "Telegram login is already running. Open the plugin view to view its QR and progress." };
  const apiId = String(fromAgent ? host.secretGet("api_id") || "" : args.apiId || "").trim();
  const apiHash = String(fromAgent ? host.secretGet("api_hash") || "" : args.apiHash || "").trim();
  const label = String(args.accountLabel || "default").trim();
  const twoFactorPassword = String(args.twoFactorPassword || "");
  if (!/^[0-9]{1,12}$/.test(apiId) || !/^[A-Fa-f0-9]{32}$/.test(apiHash)) return { error: "Enter your own numeric Telegram API ID and 32-character API hash." };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(label) || label === "all") return { error: "Account label must use letters, numbers, hyphens, or underscores." };
  if (!fromAgent && (!host.secretSet("api_id", apiId) || !host.secretSet("api_hash", apiHash))) return { error: "Could not store Telegram API credentials in the host secret store." };
  const setup = ensureAccount(label, apiId, apiHash);
  if (setup.error) return { error: setup.error };
  const logFile = childPath(p.root, `login-${label}.log`);
  try {
    host.fs.removeFile(logFile);
  } catch {
  }
  const job = startTg(["--account", label, "login", "--output", "json"], twoFactorPassword ? { TG_PASSWORD: twoFactorPassword } : {}, { detach: true, logFile });
  if (job.error || !job.jobId) return { error: job.error || "tg login did not start." };
  loginJobs[job.jobId] = label;
  activeLoginJobId = job.jobId;
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
      return { done: false, output: redact(partial), state: "login-in-progress", ...telegramLoginArtifacts(partial) };
    }
    try {
      host.exec.close(jobId);
    } catch {
    }
    delete loginLaunchPending[jobId];
    if (launch.error || launch.code !== 0) {
      delete loginJobs[jobId];
      delete loginPasswords[jobId];
      delete loginLogPaths[jobId];
      if (activeLoginJobId === jobId) activeLoginJobId = null;
      return { done: true, output: redact(launch.stderr || ""), error: redact(launch.error || launch.stderr || "tg login could not start."), state: "reauth-needed" };
    }
  }
  let output = host.fs.readFileTail(loginLogPaths[jobId], 8192) || "";
  const twoFactorPassword = loginPasswords[jobId] || "";
  if (twoFactorPassword) output = output.split(twoFactorPassword).join("[redacted]");
  output = redact(output);
  const label = loginJobs[jobId];
  const verified = jsonCommand(["--account", label, "whoami"]);
  const artifacts = telegramLoginArtifacts(output);
  if (verified.error) return { done: false, output, state: "login-in-progress", message: "Scan the QR, then refresh progress. Telegram session authorization is still pending.", ...artifacts };
  const selected = runTg(["accounts", "default", label]);
  if (!selected.ok) return { done: false, output, state: "login-in-progress", message: safeError(selected), ...artifacts };
  delete loginJobs[jobId];
  if (activeLoginJobId === jobId) activeLoginJobId = null;
  delete loginPasswords[jobId];
  delete loginLogPaths[jobId];
  try {
    host.fs.removeFile(childPath(p.root, `login-${label}.log`));
  } catch {
  }
  try {
    host.secretSet("configured_once", "true");
  } catch {
  }
  return { done: true, output, state: "logged-in", currentAccount: label, ...artifacts };
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
    case "login": {
      if (args.length) return { error: "Usage: login. Enter API credentials in the Telegram Client view first." };
      const started = loginStart({}, true);
      if (started.error) return { error: "Telegram login could not start. Check the Telegram Client view for details." };
      const current = loginPoll(started.jobId);
      if (current.error) return { error: "Telegram login status needs attention. Check the Telegram Client view for details." };
      return { result: JSON.stringify({
        state: String(current.state || started.state),
        jobId: started.jobId,
        qrPayload: current.qrPayload,
        tgLink: current.tgLink,
        message: current.qrPayload ? "Scan the QR payload or open the tg:// link from Telegram Settings \u2192 Devices \u2192 Link Desktop Device." : "Telegram login started. Poll login-status for the QR payload and tg:// link."
      }) };
    }
    case "login-status": {
      if (args.length) return { error: "Usage: login-status." };
      if (!activeLoginJobId) return { result: JSON.stringify({ state: status().state, done: true }) };
      const current = loginPoll(activeLoginJobId);
      if (current.error) return { error: "Telegram login status needs attention. Check the Telegram Client view for details." };
      return { result: JSON.stringify({
        done: current.done === true,
        state: String(current.state || "login-in-progress"),
        currentAccount: current.currentAccount,
        qrPayload: current.qrPayload,
        tgLink: current.tgLink,
        message: current.done ? "Telegram login status is complete." : current.qrPayload ? "Scan the QR payload or open the tg:// link from Telegram Settings \u2192 Devices \u2192 Link Desktop Device." : "Login is still pending; poll again for the QR payload and tg:// link."
      }) };
    }
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
      current.sendPolicy = policySummary();
      current.sendState = latestSendState();
      return { result: JSON.stringify(current) };
    }
    case "logout":
      return logout();
    case "send":
      return sendCommand(ctx.sessionId, args);
    case "preview":
      return previewCommand(args, "agent");
    default:
      return { error: `Unknown Telegram verb: ${ctx.verb}` };
  }
}
function latestSendState() {
  const p = paths();
  if (!p) return null;
  const loaded = loadOutbox(p);
  let persisted = null;
  if (loaded.ledger && loaded.ledger.attempts.length) {
    const attempt = loaded.ledger.attempts.reduce((latest, item) => Number(item.updatedAt) >= Number(latest.updatedAt) ? item : latest);
    persisted = {
      state: attempt.state,
      failure: attempt.failure || null,
      message: attempt.failureMessage || (attempt.state === "sent" ? "Telegram confirmed acceptance." : null),
      retryAfter: attempt.retryAfter || null,
      destination: attempt.destination,
      updatedAt: attempt.updatedAt
    };
  }
  if (transientSendFailure && (!persisted || transientSendFailure.updatedAt >= persisted.updatedAt)) {
    return { state: transientSendFailure.state, failure: transientSendFailure.state, message: transientSendFailure.message, retryAfter: null, destination: null, updatedAt: transientSendFailure.updatedAt };
  }
  return persisted;
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
  const policy = policySummary();
  nodes.push({ kind: "badge", label: policy.configured ? "Saved Messages send policy enabled" : "Sending locked: owner policy required", tone: policy.configured ? "ok" : "warn" });
  const latest = latestSendState();
  if (latest) {
    nodes.push({ kind: "badge", label: `Last send: ${latest.state}`, tone: latest.state === "sent" ? "ok" : "warn" });
    if (latest.message) nodes.push({ kind: "text", text: latest.message, style: { tone: "muted" } });
  }
  return { title: "Telegram Client", nodes };
}
function viewCall(method, args) {
  args = args || {};
  if (method === "status") {
    const current = status();
    current.loginJobId = activeLoginJobId;
    current.sendPolicy = policySummary();
    current.sendState = latestSendState();
    return current;
  }
  if (method === "preview") return previewCommand([String(args.chatId || ""), String(args.text || "")], "view");
  if (method === "setSendPolicy") return setSendPolicy(args);
  if (method === "send") {
    const request = [String(args.chatId || "")];
    if (args.idempotencyKey) request.push("--key", String(args.idempotencyKey));
    request.push(String(args.text || ""));
    const token = previewTokens[String(args.previewId || "")];
    if (!token || token.destination.id !== request[0] || token.text !== String(args.text || "")) {
      return rememberSendFailure("destination-not-permitted", "destination-not-permitted: This view has no matching resolved preview. Review the sender, immutable destination, and exact text again before sending.");
    }
    request.push("--key", token.previewNonce);
    return sendCommand("plugin-view", request);
  }
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
  __test_binaryName: binaryName,
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
  __test_agentHistory: agentHistory,
  __test_setClock: (clock) => {
    injectedClock = clock;
  },
  __test_sha256Hex: sha256Hex,
  __test_policySummary: policySummary,
  __test_latestSendState: latestSendState,
  __test_failureMessage: failureMessage,
  __test_failureForUpstream: failureForUpstream
};
var plugin_default = plugin;
