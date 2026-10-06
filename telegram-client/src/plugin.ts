import type { GlanceView, PluginModule, ViewNode } from "@codeterm/plugin-sdk";
import { qrSvg } from "./qr";
import { classifyLoginOutput, loginStateForStep, maskPhone, nextLoginAction, type LoginStep } from "./login-steps";
import { decideSend, matchChats, parseSendScope, validateSendScope, type SendOrigin, type SendScope } from "../../shared/src/send-scope";

const VERSION = "0.11.0";
const ROOT = "~/.codeterm/telegram-client";
const BUNDLE = "~/.codeterm/plugins/telegram-client";
const CONFIG_NAME = "gotd.cli.yaml";
const SCAN_MESSAGE = "Render qrSvg in chat as a scannable QR and show tgLink as text. Scan it in Telegram Settings → Devices → Link Desktop Device, then poll login-status and follow its `next` field.";
const MAX_COUNT = 50;
const MAX_BYTES = 32 * 1024;
const loginJobs: Record<string, string> = {};
const loginPasswords: Record<string, string> = {};
const loginLaunchPending: Record<string, boolean> = {};
const loginLogPaths: Record<string, string> = {};
let activeLoginJobId: string | null = null;
const previewTokens: Record<string, any> = {};
let injectedClock: (() => number) | null = null;
let transientSendFailure: { state: string; message: string; updatedAt: number } | null = null;

type RunResult = { ok: true; stdout: string; stderr: string; raw: string } | { ok: false; error: string; stderr: string };
type TgJob = { jobId?: string; error?: string; ambiguousStart?: boolean };
type PollResult = { done: boolean; code?: number; stdout?: string; stderr?: string; error?: string };
type Paths = { root: string; binDir: string; binary: string; config: string; install: string; failure: string; outbox: string; scope: string };

function platformName(): string {
  try { return String(host.platform() || "").toLowerCase(); } catch { return ""; }
}

function binaryName(): string {
  return host.path.isWindows ? "tg.exe" : "tg";
}

function nativePath(value: string): string {
  return host.path.toNative(host.path.normalize(value));
}

function childPath(root: string, name: string): string {
  const child = nativePath(`${root}/${name}`);
  if (host.path.equal(child, root)) throw new Error("plugin data path resolved to its root");
  return child;
}

function paths(): Paths | null {
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
      scope: childPath(root, "send-scope.json"),
    };
  } catch { return null; }
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

function redact(text: string): string {
  let out = text || "";
  for (const key of ["api_id", "api_hash"]) {
    let value = "";
    try { value = host.secretGet(key) || ""; } catch { value = ""; }
    if (value) out = out.split(value).join("[redacted]");
  }
  return out;
}

// Redacting raw stdout would corrupt JSON wherever the numeric api_id appears, so JSON is redacted after parsing.
function redactDeep(value: any): any {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (!value || typeof value !== "object") return value;
  const out: any = {};
  for (const key of Object.keys(value)) if (key !== "app_id" && key !== "app_hash") out[key] = redactDeep(value[key]);
  return out;
}

function telegramLoginArtifacts(text: string): { qrPayload?: string; tgLink?: string; qrSvg?: string } {
  const safe = redact(String(text || "")).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ");
  const match = safe.match(/tg:\/\/login\?token=[A-Za-z0-9_%=-]+/i);
  if (!match) return {};
  const link = match[0].replace(/[),.;]+$/, "");
  let svg: string | undefined;
  try { svg = qrSvg(link); } catch { svg = undefined; }
  return { qrPayload: link, tgLink: link, qrSvg: svg };
}

// The login runs detached, so tg's exit is visible only as its final `tg: <error>` log line.
function loginFailure(output: string): string | null {
  const outcome = classifyLoginOutput(output);
  return outcome.phase === "failed" ? outcome.failure : null;
}

function rejectedCredentials(failure: string): boolean {
  return /\b(API_ID_INVALID|API_HASH_INVALID|API_ID_PUBLISHED_FLOOD)\b/.test(failure);
}

function loginFailureMessage(failure: string): string {
  return rejectedCredentials(failure)
    ? `Telegram rejected the API ID and hash (${failure.match(/API_[A-Z_]+/)?.[0]}). Check them at https://my.telegram.org, store the corrected values with --secret api_id and --secret api_hash, then run login again.`
    : `tg login failed: ${failure}`;
}

function resetRejectedConfig(p: Paths, label: string): void {
  const entries = host.fs.readDir(p.root) || [];
  const prefix = new RegExp(`^gotd\\.(session|peers)\\.${label}\\.`);
  for (const entry of entries) if (prefix.test(entry.name)) host.fs.removeFile(entry.path);
  host.fs.removeFile(p.config);
  try { host.secretDelete("config_initialized"); } catch { }
}

function installCommand(p: Paths): string {
  let bundle: string | null = null;
  try { bundle = host.fs.expandHome(BUNDLE); } catch { bundle = null; }
  const script = bundle ? childPath(childPath(nativePath(bundle), "scripts"), "install-tg.cjs") : "telegram-client/scripts/install-tg.cjs";
  return `node "${script}" --root "${p.root}"`;
}

function notInstalledMessage(p: Paths | null): string {
  if (!p) return "The host home directory is unavailable.";
  return `tg is not installed in ${p.root}. Install the pinned release with: ${installCommand(p)}`;
}

function safeError(run: RunResult): string {
  if (run.ok) return "";
  const detail = redact(run.error || run.stderr || "tg command failed").trim();
  return detail.slice(0, 600) || "tg command failed";
}

function options(args: string[], env?: Record<string, string>, extra?: Record<string, unknown>): Record<string, unknown> | null {
  const p = paths();
  if (!p || !host.fs.fileExists(p.binary)) return null;
  const full = ["--config", p.config].concat(args);
  return { bin: p.binary, args: full, env: env || {}, ...(extra || {}) };
}

function startTg(args: string[], env?: Record<string, string>, extra?: Record<string, unknown>): TgJob {
  const opts = options(args, env, extra);
  if (!opts) return { error: notInstalledMessage(paths()) };
  try {
    const started = host.exec.start(opts as any) as TgJob;
    if (!started || (!started.jobId && !started.error)) return { error: "tg start returned no job identifier.", ambiguousStart: true };
    return started;
  } catch { return { error: "Could not confirm whether tg started.", ambiguousStart: true }; }
}

function runTg(args: string[], env?: Record<string, string>): RunResult {
  const opts = options(args, env, { timeoutMs: 4500 });
  if (!opts) return { ok: false, error: notInstalledMessage(paths()), stderr: "" };
  const raw = host.exec(JSON.stringify(opts));
  const result = parseJson(raw) as PollResult | null;
  if (!result) return { ok: false, error: "tg returned an unreadable process result.", stderr: "" };
  const stdout = redact(result.stdout || "");
  const stderr = redact(result.stderr || "");
  if (result.error) return { ok: false, error: redact(result.error), stderr };
  if (result.code !== 0) return { ok: false, error: stderr || stdout || `tg exited ${result.code}`, stderr };
  return { ok: true, stdout, stderr, raw: String(result.stdout || "") };
}

function jsonCommand(args: string[]): { data?: any; error?: string; stderr?: string } {
  const run = runTg(["--output", "json"].concat(args));
  if (!run.ok) return { error: safeError(run), stderr: run.stderr };
  const parsed = parseJson(run.raw.trim());
  if (!parsed || parsed.schema !== 1 || parsed.data === undefined) {
    return { error: "tg returned an unreadable JSON response." };
  }
  return { data: redactDeep(parsed.data), stderr: run.stderr };
}

function settings(): { historyCount: number; historyMaxBytes: number } {
  let value: any = {};
  try { value = parseJson(host.settingsJson()) || {}; } catch { value = {}; }
  const count = Number(value.historyCount);
  const bytes = Number(value.historyMaxBytes);
  return {
    historyCount: Number.isInteger(count) ? Math.max(1, Math.min(MAX_COUNT, count)) : 20,
    historyMaxBytes: Number.isInteger(bytes) ? Math.max(1024, Math.min(MAX_BYTES, bytes)) : MAX_BYTES,
  };
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
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

function cutText(text: string, units: number): string {
  let end = Math.max(0, Math.min(text.length, units));
  if (end > 0 && end < text.length) {
    const c = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  }
  return text.slice(0, end);
}

function boundedHistory(chatId: string, source: any[], count: number, maxBytes: number): { value: any; json: string } {
  const out: any = { chatId, messages: [], truncated: false };
  for (const raw of (Array.isArray(source) ? source : []).slice(-count)) {
    const msg: any = {
      id: Number.isFinite(Number(raw && raw.id)) ? Number(raw.id) : null,
      date: Number.isFinite(Number(raw && raw.date)) ? Number(raw.date) : null,
      out: !!(raw && raw.out),
    };
    if (raw && typeof raw.text === "string") msg.text = raw.text;
    if (raw && Number.isFinite(Number(raw.reply_to))) msg.replyTo = Number(raw.reply_to);
    const before = out.messages.length;
    out.messages.push(msg);
    let json = JSON.stringify(out);
    if (utf8Bytes(json) <= maxBytes) continue;
    out.messages.pop();
    const text = typeof msg.text === "string" ? msg.text : "";
    let low = 0;
    let high = text.length;
    let best = "";
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = { ...msg, text: cutText(text, mid) };
      out.messages.push(candidate);
      json = JSON.stringify(out);
      out.messages.pop();
      if (utf8Bytes(json) <= maxBytes) {
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
  return { value: out, json: utf8Bytes(json) <= maxBytes ? json : JSON.stringify({ chatId, messages: [], truncated: true }) };
}

function validChatId(value: string): boolean {
  return /^id:-?[0-9]{1,20}$/.test(value);
}

function chatId(peer: any): string | null {
  if (!peer || (typeof peer.id !== "number" && typeof peer.id !== "string")) return null;
  if (typeof peer.id === "number" && !Number.isSafeInteger(peer.id)) return null;
  const id = String(peer.id);
  return /^-?[0-9]{1,20}$/.test(id) ? `id:${id}` : null;
}

function agentAccounts(): { result: string } | { error: string } {
  const response = jsonCommand(["accounts"]);
  if (response.error) return { error: response.error };
  const accounts = Array.isArray(response.data.accounts) ? response.data.accounts : [];
  return { result: JSON.stringify({ accounts: accounts.map((a: any) => ({
    id: String(a.label || ""),
    label: String(a.label || ""),
    hasSession: !!a.has_session,
    current: !!a.default,
  })) }) };
}

function accountLabels(): { labels: string[]; current: string | null; error?: string } {
  const response = jsonCommand(["accounts"]);
  if (response.error) return { labels: [], current: null, error: response.error };
  const accounts = Array.isArray(response.data.accounts) ? response.data.accounts : [];
  return {
    labels: accounts.map((a: any) => String(a.label || "")).filter(Boolean),
    current: (accounts.find((a: any) => a.default) || {}).label || null,
  };
}

function useAccount(label: string): { result: string } | { error: string } {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(label) || label === "all") return { error: "Use a configured account label." };
  const current = accountLabels();
  if (current.error) return { error: current.error };
  if (current.labels.indexOf(label) < 0) return { error: "That account is not configured. Open the Telegram view to add it." };
  const run = runTg(["accounts", "default", label]);
  if (!run.ok) return { error: safeError(run) };
  return { result: JSON.stringify({ currentAccount: label }) };
}

type Chat = { id: string; title: string; type: string; username: string | null; unread: number; phone?: string | null };

function chatList(): { chats: Chat[] } | { error: string } {
  const response = jsonCommand(["chats", "list", "--limit", "100"]);
  if (response.error) return { error: response.error };
  const source = Array.isArray(response.data.chats) ? response.data.chats : [];
  const chats = source.flatMap((item: any): Chat[] => {
    const peer = item && item.peer;
    const id = chatId(peer);
    if (!id) return [];
    const username = String(peer.username || "").replace(/^@/, "");
    const chat: Chat = {
      id,
      title: String(peer.name || peer.label || peer.title || ""),
      type: String(peer.type || "unknown"),
      username: username ? `@${username}` : null,
      unread: Number(item.unread) || 0,
    };
    if (peer.phone) chat.phone = maskPhone(peer.phone);
    return [chat];
  });
  return { chats };
}

function agentChats(args: string[] = []): { result: string } | { error: string } {
  const listed = chatList();
  if ("error" in listed) return { error: listed.error };
  const query = args.join(" ").trim();
  if (!query) return { result: JSON.stringify({ chats: listed.chats }) };
  const found = matchChats(listed.chats, query);
  const next = found.match
    ? `Send with: send ${found.match.id} --key <unique-key> <text>`
    : found.ambiguous
      ? "Several chats match. Show the candidates to the owner and ask which one, then use its id."
      : "No chat in the 100 most recent dialogs matches. Ask the owner for a more exact name or @username.";
  return { result: JSON.stringify({ query, match: found.match, ambiguous: found.ambiguous, candidates: found.candidates, next }) };
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
  if (!p) return { error: "Could not resolve the Telegram Client data directory; the restriction was not changed." };
  try {
    if (!host.fs.makeDirs(p.root) || host.fs.writeFile(p.scope, JSON.stringify(scope)) !== true) {
      return { error: "Could not save the restriction; the previous setting still applies." };
    }
  } catch { return { error: "Could not save the restriction; the previous setting still applies." }; }
  return { result: JSON.stringify(readSendScope()) };
}

function resolveSender(): { sender: any } | { error: string } {
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
  const name = [identity.first_name, identity.last_name].map((part: any) => String(part || "").trim()).filter(Boolean).join(" ");
  const username = String(identity.username || "").replace(/^@/, "");
  return { sender: {
    id: String(current.currentAccount),
    displayName: name || (username ? `@${username}` : `Telegram user ${telegramUserId}`),
    username: username ? `@${username}` : null,
    telegramUserId,
  } };
}

function resolveDestination(id: string, sender: any): { destination: any } | { error: string } {
  if (!validChatId(id)) return { error: "invalid-request: Use an immutable chat id such as id:12345 from `chats <name>`; display names are not accepted here." };
  if (id === `id:${sender.telegramUserId}`) return { destination: { id, label: "Saved Messages", type: "self", savedMessages: true } };
  const listed = chatList();
  if ("error" in listed) return { error: `upstream-rejected: Could not list chats to resolve ${id} (${listed.error}).` };
  const match = listed.chats.find((chat) => chat.id === id);
  if (!match) return { error: failureMessage("chat-not-found", id) };
  const destination: any = { id: match.id, label: match.title || match.id, type: match.type, username: match.username };
  if (match.phone) destination.phone = match.phone;
  return { destination };
}

let previewSequence = 0;
function previewCommand(args: string[], origin: SendOrigin = "agent"): { result: string } | { error: string } {
  if (args.length < 2) return { error: "Usage: preview <immutable-chat-id> <text>." };
  if (!validChatId(args[0])) return { error: "Usage: preview <immutable-chat-id> <text>. Display names are not accepted; find the id with `chats <name>`." };
  const text = args.slice(1).join(" ");
  if (!text.length) return { error: "Preview text must not be empty." };
  const resolved = resolveSender();
  if ("error" in resolved) return { error: resolved.error };
  const destination = resolveDestination(args[0], resolved.sender);
  if ("error" in destination) return { error: destination.error };
  const previewId = sha256Hex(`preview\u0000${now()}\u0000${++previewSequence}`);
  previewTokens[previewId] = { sender: resolved.sender, destination: destination.destination, text, origin, previewNonce: previewId };
  const decision = decideSend(readSendScope(), destination.destination.id, origin);
  return { result: JSON.stringify({
    previewId,
    sender: resolved.sender,
    destination: destination.destination,
    text,
    allowed: decision.allow,
    restriction: decision.allow ? null : decision.message,
  }) };
}

type AttemptState = "pending" | "sent" | "rate_limited" | "failed" | "unknown";
type SendFailure = "invalid-request" | "not-logged-in" | "reauth-needed" | "chat-not-found" | "chat-not-allowed" | "rate-limited" | "upstream-rejected" | "unknown";
const SEND_FAILURES: SendFailure[] = ["invalid-request", "not-logged-in", "reauth-needed", "chat-not-found", "chat-not-allowed", "rate-limited", "upstream-rejected", "unknown"];
type Attempt = {
  idempotencyKey: string;
  sender: any;
  destination: any;
  payloadHash: string;
  state: AttemptState;
  createdAt: number;
  updatedAt: number;
  sendCount: number;
  failure?: SendFailure;
  failureMessage?: string;
  retryAfter?: number;
  telegramMessageId?: string;
};
type Outbox = { schema: 1; attempts: Attempt[] };

function failureMessage(kind: SendFailure, detail?: any): string {
  switch (kind) {
    case "invalid-request": return `invalid-request: ${String(detail || "Usage: send <immutable-chat-id> [--key <idempotency-key>] <text>.")} Find the chat id with \`chats <name>\`, then send again.`;
    case "not-logged-in": return "not-logged-in: Sign in to Telegram Client and confirm the sender account, then send again.";
    case "reauth-needed": return "reauth-needed: Telegram authorization expired or was revoked. Complete QR login in Telegram Client before sending again.";
    case "chat-not-found": return `chat-not-found: No chat among this account's 100 most recent dialogs has id ${String(detail || "unavailable")}. Look it up with \`chats <name>\` and use an id from that result.`;
    case "chat-not-allowed": return String(detail || "chat-not-allowed: The owner's \"Restrict agent sends\" setting does not include this chat. Ask the owner to add it in the Telegram Client view.");
    case "rate-limited": return `rate-limited: Telegram asked this account to wait until ${Number(detail) || 0}. Invoke send again after that deadline; the plugin will not wait or retry automatically.`;
    case "upstream-rejected": return `upstream-rejected: Telegram rejected the request or the local send prerequisite failed (${String(detail || "no further detail")}). Correct the reported issue, then invoke send again if you still want it delivered.`;
    case "unknown": return "unknown: Telegram may have accepted this message but the confirmation was lost. Do not retry this idempotency key and do not report it as delivered; check the chat and decide manually.";
  }
  return "upstream-rejected: The send failure state was not recognized. Inspect Telegram Client status before trying again.";
}

function loadOutbox(p: Paths): { ledger?: Outbox; error?: string } {
  try {
    if (!host.fs.fileExists(p.outbox)) return { ledger: { schema: 1, attempts: [] } };
    const value = host.fs.readJson(p.outbox) as any;
    if (!value || value.schema !== 1 || !Array.isArray(value.attempts)) return { error: "the existing outbox ledger is unreadable" };
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
  transientSendFailure = { state: kind, message, updatedAt: now() };
  return { error: message };
}

function sendFailureResult(kind: SendFailure, detail?: any): { error: string } {
  return rememberSendFailure(kind, failureMessage(kind, detail));
}

function rememberPrefixedFailure(message: string): { error: string } {
  const state = message.slice(0, message.indexOf(":")) as SendFailure;
  return SEND_FAILURES.indexOf(state) >= 0 ? rememberSendFailure(state, message) : rememberSendFailure("unknown", "The command result could not be classified safely. Inspect Telegram before retrying.");
}

function parseSendArgs(args: string[]): { chatId: string; text: string; key?: string } | { error: string } {
  if (args.length < 2 || !validChatId(args[0])) return { error: failureMessage("invalid-request", "Usage: send <immutable-chat-id> [--key <idempotency-key>] <text>; display names are not accepted.") };
  let start = 1;
  let key: string | undefined;
  if (args[1] === "--key") {
    if (args.length < 4 || !/^[A-Za-z0-9._:-]{1,160}$/.test(args[2])) return { error: failureMessage("invalid-request", "--key needs a 1–160 character idempotency key ([A-Za-z0-9._:-]), followed by message text.") };
    key = args[2];
    start = 3;
  }
  const text = args.slice(start).join(" ");
  if (!text.length) return { error: failureMessage("invalid-request", "Message text must not be empty.") };
  return { chatId: args[0], text, key };
}

function failureForUpstream(message: string): SendFailure {
  if (authFailure(message)) return "reauth-needed";
  if (/not logged in|no active session|run tg login/i.test(message)) return "not-logged-in";
  if (waitSeconds(message) !== null) return "rate-limited";
  if (/MESSAGE_TOO_LONG|PEER_ID_INVALID|CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|USER_PRIVACY_RESTRICTED|CHAT_ADMIN_REQUIRED|WRITE_FORBIDDEN|USER_IS_BLOCKED|INPUT_USER_DEACTIVATED/i.test(message)) return "upstream-rejected";
  if (/exec denied|spawn .*?(?:ENOENT|EACCES)|binary .*?not found|not installed/i.test(message)) return "upstream-rejected";
  return "unknown";
}

function waitSeconds(message: string): number | null {
  const match = message.match(/FLOOD_WAIT_(\d+)/i) || message.match(/wait of\s+(\d+)\s+seconds/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function attemptResult(attempt: Attempt): { result: string } {
  transientSendFailure = null;
  return { result: JSON.stringify({
    status: "sent",
    sender: attempt.sender,
    destination: attempt.destination,
    idempotencyKey: attempt.idempotencyKey,
    telegramMessageId: attempt.telegramMessageId || null,
    deliveryGuarantee: "The local ledger prevents another send for a recorded sent key. Telegram does not provide an exactly-once delivery guarantee.",
  }) };
}

function failAttempt(p: Paths, ledger: Outbox, attempt: Attempt, kind: SendFailure, detail?: any): { error: string } {
  attempt.failure = kind;
  attempt.failureMessage = failureMessage(kind, detail);
  attempt.updatedAt = now();
  if (kind === "rate-limited") {
    const seconds = waitSeconds(String(detail || ""));
    if (seconds === null) return failAttempt(p, ledger, attempt, "upstream-rejected", "Telegram returned a rate-limit message without a retry duration; check Telegram before retrying");
    attempt.state = "rate_limited";
    attempt.retryAfter = now() + seconds * 1000;
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

function recordedByCallerKey(key: string, chatId: string, text: string): { result: string } | { error: string } | null {
  const p = paths();
  if (!p) return sendFailureResult("upstream-rejected", "the plugin-owned data directory is unavailable");
  const loaded = loadOutbox(p);
  if (!loaded.ledger) return sendFailureResult("upstream-rejected", loaded.error);
  const attempt = loaded.ledger.attempts.find((item) => item.idempotencyKey === key);
  if (!attempt) return null;
  if (attempt.payloadHash !== sha256Hex(text) || attempt.destination.id !== chatId) {
    return sendFailureResult("invalid-request", "This idempotency key is already bound to a different chat or text; choose a new key.");
  }
  if (attempt.state === "sent") return attemptResult(attempt);
  if (attempt.state === "unknown") return sendFailureResult("unknown");
  if (attempt.state === "pending") return failAttempt(p, loaded.ledger, attempt, "unknown", "a prior invocation ended while its send result was unrecorded");
  if (attempt.state === "rate_limited" && Number(attempt.retryAfter) > now()) return sendFailureResult("rate-limited", attempt.retryAfter);
  return null;
}

function serverMessageId(data: any): string | null {
  const nested = data && typeof data.message === "object" ? data.message : null;
  for (const value of [data && data.message_id, nested && nested.id, nested && nested.message_id, data && data.id]) {
    if ((typeof value === "number" && Number.isSafeInteger(value) && value > 0) || (typeof value === "string" && /^[0-9]{1,20}$/.test(value))) return String(value);
  }
  return null;
}

function sendCommand(origin: SendOrigin, args: string[]): { result: string } | { error: string } {
  const parsed = parseSendArgs(args);
  if ("error" in parsed) return rememberPrefixedFailure(parsed.error);
  const matchingPreview = Object.values(previewTokens).reverse().find((token: any) => token.destination.id === parsed.chatId && token.text === parsed.text);
  let key = parsed.key || matchingPreview?.previewNonce;
  if (key) {
    const recorded = recordedByCallerKey(key, parsed.chatId, parsed.text);
    if (recorded) return recorded;
  }
  const resolved = resolveSender();
  if ("error" in resolved) return rememberPrefixedFailure(resolved.error);
  const found = resolveDestination(parsed.chatId, resolved.sender);
  if ("error" in found) return rememberPrefixedFailure(found.error);
  const decision = decideSend(readSendScope(), found.destination.id, origin);
  if (!decision.allow) return sendFailureResult("chat-not-allowed", decision.message);
  if (!key) key = sha256Hex(`send\u0000${now()}\u0000${++previewSequence}\u0000${parsed.chatId}`).slice(0, 32);

  const payloadHash = sha256Hex(parsed.text);
  const p = paths();
  if (!p) return sendFailureResult("upstream-rejected", "the plugin-owned data directory is unavailable");
  const loaded = loadOutbox(p);
  if (!loaded.ledger) return sendFailureResult("upstream-rejected", loaded.error);
  const ledger = loaded.ledger;
  let attempt = ledger.attempts.find((item) => item.idempotencyKey === key);
  if (attempt && (attempt.payloadHash !== payloadHash || attempt.sender.id !== resolved.sender.id || attempt.destination.id !== found.destination.id)) {
    return sendFailureResult("invalid-request", "This idempotency key is already bound to a different sender, chat, or text; choose a new key.");
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
      sendCount: 0,
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

  const peer = found.destination.savedMessages ? [] : ["--peer", found.destination.id];
  const opts = options(["--account", resolved.sender.id, "--output", "json", "send", ...peer, "--", parsed.text], undefined, { timeoutMs: 5000 });
  if (!opts) return failAttempt(p, ledger, attempt, "upstream-rejected", "tg binary is unavailable before send");
  return host.exec.async(opts as any, (result: PollResult) => {
    const output = redact(result.stdout || "");
    const detail = redact(result.error || result.stderr || output).trim();
    if (result.error || typeof result.code !== "number" || result.code !== 0) return failAttempt(p, ledger, attempt!, failureForUpstream(detail), detail);
    const response = parseJson(output.trim());
    if (!response || response.schema !== 1 || response.data === undefined) return failAttempt(p, ledger, attempt!, "unknown");
    const upstreamId = serverMessageId(response.data);
    if (upstreamId === null) return failAttempt(p, ledger, attempt!, "unknown");
    attempt!.telegramMessageId = upstreamId;
    attempt!.state = "sent";
    attempt!.updatedAt = now();
    delete attempt!.failure;
    delete attempt!.failureMessage;
    if (!persistOutbox(p, ledger)) return sendFailureResult("unknown");
    return attemptResult(attempt!);
  });
}

function agentHistory(args: string[]): { result: string } | { error: string } {
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

function authFailure(message: string): boolean {
  return /not authorized|auth_key_unregistered|session_revoked|session_expired|user_deactivated|authorization key/i.test(message);
}

function storageBackend(): { name: string; note: string } {
  const platform = platformName();
  if (platform === "darwin" || platform === "mac" || platform === "macos") return { name: "macOS login Keychain", note: "tg keeps the session in the login Keychain by default." };
  if (host.path.isWindows) return { name: "plugin-owned plaintext file", note: "tg stores the session under this plugin data directory on Windows. This plugin does not inspect or set a Windows ACL, so it makes no ACL protection claim." };
  return { name: "plugin-owned plaintext file", note: "On POSIX hosts tg stores the session in a 0600 file under this plugin's private data directory." };
}

function failureState(p: Paths): { state?: string; message?: string } {
  try {
    const value = host.fs.readJson(p.failure) as any;
    if (value && typeof value.state === "string") return { state: value.state, message: String(value.message || "") };
  } catch { }
  return {};
}

function versionOlder(installed: string, required: string): boolean {
  const parts = (value: string) => value.split(".").map((part) => Number(part));
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

function status(): any {
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
    return { state: "not-installed", message: notInstalledMessage(p), installCommand: installCommand(p), storage, accounts: [], currentAccount: null };
  }
  const install = host.fs.readJson(p.install) as any;
  if (install && install.version && install.version !== VERSION) {
    const state = versionOlder(String(install.version), VERSION) ? "upgrade-available" : "install-error";
    const message = state === "upgrade-available"
      ? `tg ${VERSION} is pinned; installed metadata reports ${String(install.version)}. Run the installer to upgrade.`
      : `Installed tg ${String(install.version)} does not match pinned ${VERSION}. Reinstall the pinned release.`;
    return { state, message, storage, accounts: [], currentAccount: null };
  }
  if (host.secretGet("config_initialized") !== "true") {
    const wasConfigured = host.secretGet("configured_once") === "true";
    return {
      state: wasConfigured ? "logged-out" : "installed-but-not-configured",
      message: wasConfigured ? "Signed out. Store your Telegram API ID and hash again, then start QR login." : "Store your own Telegram API ID and hash (secrets api_id and api_hash), then start QR login.",
      storage, accounts: [], currentAccount: null,
    };
  }
  const listed = accountLabels();
  if (listed.error) {
    const state = authFailure(listed.error) ? "reauth-needed" : "logged-out";
    const message = state === "reauth-needed"
      ? "Telegram needs authorization again. Start QR login again."
      : "Telegram account config could not be read. Store your own API credentials again, then start QR login.";
    return { state, message, storage, accounts: [], currentAccount: null };
  }
  const result = jsonCommand(["whoami"]);
  const accounts = jsonCommand(["accounts"]);
  const accountRows = accounts.error ? [] : (Array.isArray(accounts.data.accounts) ? accounts.data.accounts : []).map((a: any) => ({
    id: String(a.label || ""), label: String(a.label || ""), hasSession: !!a.has_session, current: !!a.default,
  }));
  const active = accountRows.find((a: any) => a.current) || null;
  if (result.error || !(active && active.hasSession)) {
    const pending = pendingLoginStep();
    if (pending) {
      return { state: loginStateForStep(pending.step), message: stepMessage(pending.step), loginStep: pending.step, storage, accounts: accountRows, currentAccount: active && active.label, resolvedAccount: null };
    }
  }
  if (result.error) {
    const hasSession = active && active.hasSession;
    const state = authFailure(result.error) ? "reauth-needed" : (hasSession ? "logged-in" : "logged-out");
    const message = state === "reauth-needed"
      ? "The Telegram session expired or was revoked. Start QR login again."
      : state === "logged-out"
        ? "No signed-in Telegram session is selected. Start QR login."
        : "A session is present, but Telegram could not be reached. Refresh status when the connection is available.";
    return { state, message, storage, accounts: accountRows, currentAccount: active && active.label, resolvedAccount: null };
  }
  return {
    state: active && active.hasSession ? "logged-in" : "logged-out",
    message: active && active.hasSession ? "Telegram account resolved." : "No signed-in sender is selected.",
    storage,
    accounts: accountRows,
    currentAccount: active && active.label,
    resolvedAccount: result.data,
  };
}

function ensureAccount(label: string, apiId: string, apiHash: string): { error?: string } {
  const p = paths();
  if (!p) return { error: "The host home directory is unavailable." };
  if (!host.fs.fileExists(p.binDir)) return { error: notInstalledMessage(p) };
  let configExists = false;
  try { configExists = host.secretGet("config_initialized") === "true"; } catch { configExists = false; }
  if (!configExists) {
    const existing = jsonCommand(["accounts"]);
    if (!existing.error) {
      configExists = true;
      try { if (!host.secretSet("config_initialized", "true")) return { error: "Could not record Telegram config state in the host secret store." }; }
      catch { return { error: "Could not record Telegram config state in the host secret store." }; }
    } else if (!/no config at .*tg init first|run `tg init` first/i.test(existing.error)) {
      return { error: existing.error };
    }
  }
  if (!configExists) {
    const init = runTg(["init"], { APP_ID: apiId, APP_HASH: apiHash });
    if (!init.ok) return { error: safeError(init) };
    try { if (!host.secretSet("config_initialized", "true")) return { error: "tg created the config, but CodeTerm could not record its state. Retry login to recover." }; }
    catch { return { error: "tg created the config, but CodeTerm could not record its state. Retry login to recover." }; }
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

function loginStart(args: any, fromAgent = false): any {
  const p = paths();
  if (!p || !host.fs.fileExists(p.binary)) return { error: notInstalledMessage(p) };
  if (activeLoginJobId && loginJobs[activeLoginJobId]) return { jobId: activeLoginJobId, state: "login-in-progress", message: "Telegram login is already running. Poll its progress for the QR." };
  const useStored = fromAgent || (!String(args.apiId || "").trim() && !String(args.apiHash || "").trim());
  const apiId = String(useStored ? host.secretGet("api_id") || "" : args.apiId || "").trim();
  const apiHash = String(useStored ? host.secretGet("api_hash") || "" : args.apiHash || "").trim();
  const label = String(args.accountLabel || "default").trim();
  const twoFactorPassword = String(args.twoFactorPassword || "");
  if (!/^[0-9]{1,12}$/.test(apiId) || !/^[A-Fa-f0-9]{32}$/.test(apiHash)) {
    if (!fromAgent) return { error: useStored ? "No valid Telegram API ID and hash are stored yet. Enter your own numeric Telegram API ID and 32-character API hash." : "Enter your own numeric Telegram API ID and 32-character API hash." };
    const stored = apiId || apiHash ? "The stored Telegram API ID or hash is malformed (expected a numeric API ID and a 32-character hex API hash)." : "No Telegram API ID and hash are stored.";
    return { error: `${stored} Store them from stdin: printf '%s' "<API_ID>" | codeterm plugin config telegram-client --secret api_id, then the same for api_hash.` };
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(label) || label === "all") return { error: "Account label must use letters, numbers, hyphens, or underscores." };
  if (!useStored && (!host.secretSet("api_id", apiId) || !host.secretSet("api_hash", apiHash))) return { error: "Could not store Telegram API credentials in the host secret store." };
  const setup = ensureAccount(label, apiId, apiHash);
  if (setup.error) return { error: setup.error };
  const logFile = childPath(p.root, `login-${label}.log`);
  try { host.fs.removeFile(logFile); } catch { }
  const job = startTg(["--account", label, "login", "--output", "json"], twoFactorPassword ? { TG_PASSWORD: twoFactorPassword } : {}, { detach: true, logFile });
  if (job.error || !job.jobId) return { error: job.error || "tg login did not start." };
  loginJobs[job.jobId] = label;
  activeLoginJobId = job.jobId;
  loginLaunchPending[job.jobId] = true;
  loginLogPaths[job.jobId] = logFile;
  if (twoFactorPassword) loginPasswords[job.jobId] = twoFactorPassword;
  return { jobId: job.jobId, accountLabel: label, state: "login-in-progress", message: "Login is running. Poll progress here and scan the QR shown below." };
}

const PASSWORD_SUBMIT = "printf '%s' '<password>' | codeterm plugin config telegram-client --secret login_password && codeterm plugin telegram-client login-password";

function stepMessage(step: LoginStep): string {
  if (step.kind === "password") {
    return `${step.retry ? "Telegram rejected that two-step verification password. " : "Telegram needs this account's two-step verification (cloud) password to finish the QR sign-in. "}Ask the user for it in chat and submit it from stdin only: ${PASSWORD_SUBMIT}. Never pass it as an argument and never repeat it back. A password typed in chat stays in the provider's session history, so offer the Telegram Client view's password field as the private alternative. Then poll login-status.`;
  }
  return `Telegram asked for one more sign-in step (${step.prompt}). The pinned tg release cannot accept it outside an interactive terminal, so tell the user, then start login again or finish in the Telegram Client view.`;
}

function forgetLoginJob(jobId: string): void {
  delete loginJobs[jobId];
  delete loginPasswords[jobId];
  delete loginLogPaths[jobId];
  delete loginLaunchPending[jobId];
  if (activeLoginJobId === jobId) activeLoginJobId = null;
}

// The waiting step outlives the exited tg process and a plugin reload: its login log stays on disk.
function pendingLoginStep(): { label: string; step: LoginStep } | null {
  const p = paths();
  if (!p) return null;
  let entries: Array<{ name: string; path: string }> = [];
  try { entries = host.fs.readDir(p.root) || []; } catch { return null; }
  const running = activeLoginJobId ? loginJobs[activeLoginJobId] : null;
  for (const entry of entries) {
    const match = /^login-([A-Za-z0-9_-]{1,64})\.log$/.exec(entry.name);
    if (!match || match[1] === running) continue;
    const outcome = classifyLoginOutput(host.fs.readFileTail(entry.path, 8192) || "");
    if (outcome.phase === "input-required") return { label: match[1], step: outcome.step };
  }
  return null;
}

function stepResult(step: LoginStep, label: string, output?: string): any {
  return { done: false, output, state: loginStateForStep(step), step, accountLabel: label, message: stepMessage(step) };
}

function takeOneShotSecret(name: string): string {
  let value = "";
  try { value = host.secretGet(name) || ""; } catch { value = ""; }
  try { if (value) host.secretDelete(name); } catch { }
  return value;
}

function submitLoginPassword(password: string): any {
  if (!password) return { error: `No password was received. Pipe it on stdin, never as an argument: ${PASSWORD_SUBMIT}` };
  if (activeLoginJobId && loginJobs[activeLoginJobId]) {
    return { error: "Telegram login is still running and has not asked for a password. Poll login-status and submit the password when it reports password-required." };
  }
  const pending = pendingLoginStep();
  if (pending && pending.step.kind !== "password") return { error: `Telegram is waiting for a different step (${pending.step.prompt}), not a password.` };
  const label = pending ? pending.label : "default";
  const started = loginStart({ accountLabel: label, twoFactorPassword: password }, true);
  if (started.error) return { error: started.error };
  const current = loginPoll(started.jobId);
  return { ...current, jobId: started.jobId };
}

function loginPoll(jobId: string): any {
  if (!jobId || !loginJobs[jobId]) return { error: "Unknown login job." };
  const p = paths();
  if (!p) return { error: "The host home directory is unavailable." };
  if (loginLaunchPending[jobId]) {
    let launch: PollResult;
    try { launch = host.exec.poll(jobId) as PollResult; }
    catch { return { error: "Could not read the login job." }; }
    if (!launch.done) {
      let partial = host.fs.readFileTail(loginLogPaths[jobId], 8192) || "";
      const password = loginPasswords[jobId] || "";
      if (password) partial = partial.split(password).join("[redacted]");
      return { done: false, output: redact(partial), state: "login-in-progress", ...telegramLoginArtifacts(partial) };
    }
    try { host.exec.close(jobId); } catch { }
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
  const outcome = classifyLoginOutput(output);
  if (outcome.phase === "input-required") {
    forgetLoginJob(jobId);
    return stepResult(outcome.step, label, output);
  }
  if (outcome.phase === "failed") {
    forgetLoginJob(jobId);
    if (rejectedCredentials(outcome.failure)) resetRejectedConfig(p, label);
    return { done: true, output, state: "logged-out", error: loginFailureMessage(outcome.failure), credentialsRejected: rejectedCredentials(outcome.failure) };
  }
  const verified = jsonCommand(["--account", label, "whoami"]);
  const artifacts = telegramLoginArtifacts(output);
  if (verified.error) return { done: false, output, state: "login-in-progress", message: "Scan the QR, then refresh progress. Telegram session authorization is still pending.", ...artifacts };
  const selected = runTg(["accounts", "default", label]);
  if (!selected.ok) return { done: false, output, state: "login-in-progress", message: safeError(selected), ...artifacts };
  delete loginJobs[jobId];
  if (activeLoginJobId === jobId) activeLoginJobId = null;
  delete loginPasswords[jobId];
  delete loginLogPaths[jobId];
  try { host.fs.removeFile(childPath(p.root, `login-${label}.log`)); } catch { }
  try { host.secretSet("configured_once", "true"); } catch { }
  return { done: true, output, state: "logged-in", currentAccount: label, ...artifacts };
}

function removeFiles(p: Paths): boolean {
  const entries = host.fs.readDir(p.root) || [];
  for (const entry of entries) {
    if ((/^gotd\.(session|peers)\..+\.json$/.test(entry.name) || /^login-[A-Za-z0-9_-]+\.log$/.test(entry.name)) && host.fs.fileExists(entry.path)) {
      if (!host.fs.removeFile(entry.path) && host.fs.fileExists(entry.path)) return false;
    }
  }
  const initialized = host.secretGet("config_initialized") === "true";
  if (!host.fs.removeFile(p.config) && initialized) return false;
  return true;
}

function clearSecret(name: string): boolean {
  return !host.secretGet(name) || host.secretDelete(name);
}

function logout(): { result: string } | { error: string } {
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
  } catch { return { error: "Could not remove the local Telegram config and session files." }; }
  try {
    const apiIdDeleted = clearSecret("api_id");
    const apiHashDeleted = clearSecret("api_hash");
    const configMarkerDeleted = clearSecret("config_initialized");
    const logoutMarkerSaved = host.secretSet("configured_once", "true");
    if (!apiIdDeleted || !apiHashDeleted || !configMarkerDeleted || !logoutMarkerSaved) return { error: "Local files were removed, but the host could not update all Telegram secret state." };
  } catch { return { error: "Local files were removed, but the host could not update all Telegram secret state." }; }
  return { result: "Logged out. Telegram config and local session files were removed." };
}

function onAgentCommand(ctx: { sessionId: string; verb: string; args: string[] }): { result: string } | { error: string } {
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  switch (ctx.verb) {
    case "login": {
      if (args.length) return { error: "Usage: login. It takes no arguments; store api_id and api_hash with --secret first." };
      const started = loginStart({}, true);
      if (started.error) return { error: `Telegram login could not start: ${started.error}` };
      const current = loginPoll(started.jobId);
      if (current.error) return { error: `Telegram login needs attention: ${current.error}` };
      return { result: JSON.stringify(agentLoginView({ ...current, state: current.state || started.state }, started.jobId)) };
    }
    case "login-status": {
      if (args.length) return { error: "Usage: login-status." };
      if (!activeLoginJobId) {
        const pending = pendingLoginStep();
        if (pending) return { result: JSON.stringify(agentLoginView(stepResult(pending.step, pending.label))) };
        const state = status().state;
        return { result: JSON.stringify({ state, done: true, next: nextLoginAction({ state }) }) };
      }
      const jobId = activeLoginJobId;
      const current = loginPoll(jobId);
      if (current.error) return { error: `Telegram login needs attention: ${current.error}` };
      return { result: JSON.stringify(agentLoginView(current, jobId)) };
    }
    case "login-password": {
      if (args.length) return { error: `Usage: login-password. It takes no arguments; the password travels only on stdin: ${PASSWORD_SUBMIT}` };
      const submitted = submitLoginPassword(takeOneShotSecret("login_password"));
      if (submitted.error) return { error: `Telegram password was not submitted: ${submitted.error}` };
      return { result: JSON.stringify(agentLoginView(submitted, submitted.jobId)) };
    }
    case "accounts": return agentAccounts();
    case "use": return args.length === 1 ? useAccount(args[0]) : { error: "Usage: use <configured-account-id>." };
    case "chats": return agentChats(args);
    case "history": return agentHistory(args);
    case "health": {
      const current = status();
      current.setup = setupSummary();
      current.account = accountSummary(current);
      delete current.resolvedAccount;
      current.runtimeDir = paths()?.root || null;
      current.sendScope = readSendScope();
      current.sendState = latestSendState();
      return { result: JSON.stringify(current) };
    }
    case "logout": return logout();
    case "send": return sendCommand("agent", args);
    case "preview": return previewCommand(args, "agent");
    default: return { error: `Unknown Telegram verb: ${ctx.verb}` };
  }
}

function agentLoginView(current: any, jobId?: string): any {
  const step: LoginStep | null = current.step || null;
  const qr = !current.done && !step && !!current.qrPayload;
  return {
    done: current.done === true,
    state: String(current.state || "login-in-progress"),
    next: nextLoginAction({ state: current.state, qr, step, credentialsRejected: current.credentialsRejected }),
    jobId,
    currentAccount: current.currentAccount,
    passwordRequired: step ? step.kind === "password" : undefined,
    step: step ? { kind: step.kind, prompt: step.prompt, hint: step.hint, retry: step.retry } : undefined,
    qrPayload: qr ? current.qrPayload : undefined,
    tgLink: qr ? current.tgLink : undefined,
    qrSvg: qr ? current.qrSvg : undefined,
    message: step ? stepMessage(step) : current.done ? "Telegram login status is complete." : qr ? SCAN_MESSAGE : "Login is still pending; poll login-status again for the QR and tg:// link.",
  };
}

function setupSummary(): { runtimeInstalled: boolean; apiIdSet: boolean; apiHashStored: boolean } {
  const p = paths();
  const stored = (name: string) => { try { return !!host.secretGet(name); } catch { return false; } };
  let runtimeInstalled = false;
  try { runtimeInstalled = !!p && host.fs.fileExists(p.binary); } catch { runtimeInstalled = false; }
  return { runtimeInstalled, apiIdSet: stored("api_id"), apiHashStored: stored("api_hash") };
}

function accountSummary(current: any): { label: string; name: string | null; username: string | null; phone: string | null; resolved: boolean } | null {
  if (!current || !current.currentAccount) return null;
  const identity = current.resolvedAccount || null;
  const name = identity ? [identity.first_name, identity.last_name].map((part: any) => String(part || "").trim()).filter(Boolean).join(" ") : "";
  const username = identity && identity.username ? `@${String(identity.username).replace(/^@/, "")}` : null;
  return { label: String(current.currentAccount), name: name || null, username, phone: identity ? maskPhone(identity.phone) : null, resolved: !!identity };
}

function latestSendState(): any {
  const p = paths();
  if (!p) return null;
  const loaded = loadOutbox(p);
  let persisted: any = null;
  if (loaded.ledger && loaded.ledger.attempts.length) {
    const attempt = loaded.ledger.attempts.reduce((latest, item) => Number(item.updatedAt) >= Number(latest.updatedAt) ? item : latest);
    persisted = {
      state: attempt.state,
      failure: attempt.failure || null,
      message: attempt.failureMessage || (attempt.state === "sent" ? "Telegram confirmed acceptance." : null),
      retryAfter: attempt.retryAfter || null,
      destination: attempt.destination,
      updatedAt: attempt.updatedAt,
    };
  }
  if (transientSendFailure && (!persisted || transientSendFailure.updatedAt >= persisted.updatedAt)) {
    return { state: transientSendFailure.state, failure: transientSendFailure.state, message: transientSendFailure.message, retryAfter: null, destination: null, updatedAt: transientSendFailure.updatedAt };
  }
  return persisted;
}

function renderGlance(): GlanceView {
  const p = paths();
  const nodes: ViewNode[] = [];
  if (!p || !host.fs.fileExists(p.binary)) {
    nodes.push({ kind: "badge", label: "tg not installed", tone: "warn" });
    nodes.push({ kind: "text", text: "Use Configure with AI to install the pinned release and sign in.", style: { tone: "muted" } });
  } else if (host.secretGet("config_initialized") !== "true") {
    nodes.push({ kind: "badge", label: "Not signed in", tone: "warn" });
    nodes.push({ kind: "text", text: "Use Configure with AI or the Telegram Client view to sign in.", style: { tone: "muted" } });
  } else if (pendingLoginStep()) {
    nodes.push({ kind: "badge", label: "Sign-in needs one more step", tone: "warn" });
    nodes.push({ kind: "text", text: "Open the Telegram Client view or ask the agent to finish signing in.", style: { tone: "muted" } });
  } else {
    nodes.push({ kind: "badge", label: "Configured", tone: "ok" });
    nodes.push({ kind: "text", text: storageBackend().name, style: { tone: "muted" } });
  }
  const scope = readSendScope();
  nodes.push({ kind: "badge", label: scope.mode === "all" ? "Agent sends: any chat" : `Agent sends: ${scope.chats.length} allowed chat${scope.chats.length === 1 ? "" : "s"}`, tone: scope.mode === "all" ? "ok" : "warn" });
  const latest = latestSendState();
  if (latest) {
    nodes.push({ kind: "badge", label: `Last send: ${latest.state}`, tone: latest.state === "sent" ? "ok" : "warn" });
    if (latest.message) nodes.push({ kind: "text", text: latest.message, style: { tone: "muted" } });
  }
  return { title: "Telegram Client", nodes };
}

function viewCall(method: string, args: any): unknown {
  args = args || {};
  if (method === "status") {
    const current = status();
    current.setup = setupSummary();
    current.account = accountSummary(current);
    delete current.resolvedAccount;
    current.loginJobId = activeLoginJobId;
    current.sendScope = readSendScope();
    current.sendState = latestSendState();
    return current;
  }
  if (method === "preview") return previewCommand([String(args.chatId || ""), String(args.text || "")], "view");
  if (method === "chats") return agentChats(String(args.query || "").trim() ? [String(args.query)] : []);
  if (method === "setSendScope") return setSendScope(args);
  if (method === "send") {
    const chat = String(args.chatId || "");
    const text = String(args.text || "");
    const token = previewTokens[String(args.previewId || "")];
    if (!token || token.destination.id !== chat || token.text !== text) {
      return rememberSendFailure("invalid-request", "invalid-request: This view has no matching preview for that chat and text. Preview again before sending.");
    }
    return sendCommand("view", [chat, "--key", String(args.idempotencyKey || token.previewNonce), text]);
  }

  if (method === "loginStart") return loginStart(args);
  if (method === "loginPoll") return loginPoll(String(args.jobId || ""));
  if (method === "loginPassword") return submitLoginPassword(String(args.password || ""));
  if (method === "useAccount") return useAccount(String(args.id || ""));
  if (method === "logout") return logout();
  return { error: `Unknown Telegram view method: ${method}` };
}

const plugin: PluginModule = {
  onAgentCommand,
  renderGlance,
  viewCall: viewCall as PluginModule["viewCall"],
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
  __test_loginFailure: loginFailure,
  __test_pendingLoginStep: pendingLoginStep,
  __test_resetLoginJobs: () => { for (const jobId of Object.keys(loginJobs)) forgetLoginJob(jobId); activeLoginJobId = null; },
  __test_setupSummary: setupSummary,
  __test_accountSummary: accountSummary,
  __test_loginFailureMessage: loginFailureMessage,
  __test_logout: logout,
  __test_agentHistory: agentHistory,
  __test_setClock: (clock: (() => number) | null) => { injectedClock = clock; },
  __test_sha256Hex: sha256Hex,
  __test_readSendScope: readSendScope,
  __test_serverMessageId: serverMessageId,
  __test_latestSendState: latestSendState,
  __test_failureMessage: failureMessage,
  __test_failureForUpstream: failureForUpstream,
};

export default plugin;
