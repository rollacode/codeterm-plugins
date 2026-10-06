import { DEVICE_LOGIN_URL } from "./constants";

export type AuthState = "logged-out" | "awaiting-user" | "logged-in" | "expired" | "refused";
export type AuthOutcome = { state: AuthState | "sign-in-failed"; message: string };

export type SignInLog =
  | { state: "starting" }
  | { state: "awaiting-user"; signInUrl: string; deviceCode: string }
  | { state: "signed-in" }
  | { state: "failed"; failure: AuthOutcome };

export type Chat = {
  id: string;
  title: string;
  topic: string | null;
  chatType: "oneOnOne" | "group" | "meeting";
  members: string[];
  username: string | null;
  lastActivity: string | null;
};

export type WhoAmI = { user: string; email: string; tokens: { name: string; valid: boolean; expiry: string }[] };

export type SendFailureKind = "not-logged-in" | "reauth-needed" | "upstream-rejected" | "unknown";

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const USER_CODE = /(?:enter|use)\s+(?:the\s+)?(?:login\s+)?(?:code\s+)?([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?|[A-Z0-9]{6,12})\b/i;

export function redact(text: string): string {
  return String(text || "")
    .replace(/eyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g, "[redacted]")
    .replace(/\b((?:code|device_code|access_token|refresh_token|id_token|client_secret|skypetoken)["']?\s*[=:]\s*["']?)[^&\s"',}]+/gi, "$1[redacted]")
    .replace(/\b(Bearer|skypetoken=)\s*[\w.~+/=-]{16,}/gi, "$1 [redacted]");
}

// Microsoft's own wording: the token endpoint's error_description, else the AADSTS line, else the CLI's last Error line.
export function microsoftMessage(text: string): string {
  const raw = String(text || "").replace(ANSI, " ");
  const described = raw.match(/"error_description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (described) {
    let value = described[1];
    try { value = JSON.parse(`"${described[1]}"`); } catch { }
    return redact(value.split(/\r?\n/)[0].trim()).slice(0, 500);
  }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const aadsts = lines.find((line) => /AADSTS\d+/.test(line));
  const errorLine = [...lines].reverse().find((line) => /^Error:/.test(line));
  const chosen = aadsts || errorLine || lines[lines.length - 1] || "";
  return redact(chosen.replace(/^Error:\s*/, "")).slice(0, 500);
}

function quoted(text: string): string {
  const message = microsoftMessage(text);
  return message ? ` Microsoft said: "${message}"` : "";
}

export function classifyAuthFailure(text: string): AuthOutcome | null {
  const value = String(text || "");
  if (/AADSTS65001|AADSTS65004|AADSTS90094|AADSTS90095|consent_required|admin(?:istrator)? (?:consent|approval)|need admin approval/i.test(value)) {
    return { state: "refused", message: `Microsoft refused the Teams client sign-in and asked for administrator approval.${quoted(value)} This sign-in uses the Teams desktop client, so the tenant is blocking that client itself; sign-in cannot continue without the tenant's change.` };
  }
  if (/AADSTS53003|AADSTS53000|AADSTS50105|AADSTS50020|AADSTS700016|conditional[ -]access|authorization was declined|authorization_declined|access_denied/i.test(value)) {
    return { state: "refused", message: `Microsoft refused the sign-in.${quoted(value)}` };
  }
  if (/device code expired|expired_token|timed out waiting for authentication|AADSTS70020/i.test(value)) {
    return { state: "expired", message: `The sign-in code expired before the sign-in finished.${quoted(value)} Run login again for a fresh code.` };
  }
  if (/invalid_grant|interaction_required|AADSTS70008|AADSTS700082|AADSTS700084|AADSTS50173|AADSTS50076|AADSTS50078|AADSTS50079|AADSTS50132|AADSTS50133|no refresh token|tokens expired and no refresh token|auto-refresh failed|refresh failed/i.test(value)) {
    return { state: "expired", message: `The Teams session expired and could not be renewed silently.${quoted(value)} Run login to sign in again.` };
  }
  if (/loading tokens: reading (?:skype|chatsvcagg|teams) token/i.test(value)) {
    return { state: "logged-out", message: "Not signed in to Teams. Run login to get a sign-in code." };
  }
  return null;
}

export function parseSignInLog(text: string): SignInLog {
  const raw = String(text || "").replace(ANSI, " ");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.some((line) => /^tokens saved to\b/i.test(line))) return { state: "signed-in" };
  const last = lines[lines.length - 1] || "";
  if (/^Error:/.test(last)) {
    const known = classifyAuthFailure(raw);
    return { state: "failed", failure: known && known.state !== "logged-out" ? known : { state: "sign-in-failed", message: `Microsoft sign-in failed.${quoted(raw)}` } };
  }
  const signInUrl = raw.match(DEVICE_LOGIN_URL)?.[0]?.replace(/[),.;]+$/, "");
  const deviceCode = raw.match(USER_CODE)?.[1];
  return signInUrl && deviceCode ? { state: "awaiting-user", signInUrl, deviceCode } : { state: "starting" };
}

export function parseJson<T = any>(value: string): T | null {
  try { return JSON.parse(value) as T; } catch { return null; }
}

export function parseWhoami(stdout: string): WhoAmI | null {
  const value = parseJson<any>(String(stdout || "").trim());
  if (!value || !Array.isArray(value.tokens)) return null;
  return {
    user: String(value.user || ""),
    email: String(value.email || ""),
    tokens: value.tokens.filter((item: any) => item && typeof item.name === "string").map((item: any) => ({ name: item.name, valid: item.valid === true, expiry: String(item.expiry || "") })),
  };
}

// skype carries messaging and chatsvcagg the chat list; the other audiences are optional for this plugin.
export function sessionUsable(who: WhoAmI): boolean {
  return ["skype", "chatsvcagg"].every((name) => who.tokens.some((token) => token.name === name && token.valid));
}

export function sessionExpiry(who: WhoAmI): string | null {
  const skype = who.tokens.find((token) => token.name === "skype");
  return skype && skype.valid && skype.expiry ? skype.expiry : null;
}

function sameName(a: string, b: string): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function lastActivity(raw: any): string | null {
  const message = raw && raw.lastMessage;
  const value = message && (message.originalarrivaltime || message.composetime) || (typeof raw?.createdAt === "string" ? raw.createdAt : "");
  return typeof value === "string" && value ? value : null;
}

export function mapChats(source: any, selfName: string): Chat[] {
  const rows = Array.isArray(source) ? source : [];
  const chats = rows.flatMap((raw: any): Chat[] => {
    const id = typeof raw?.id === "string" ? raw.id : "";
    if (!/^[A-Za-z0-9:._@-]{1,512}$/.test(id) || raw.hidden === true) return [];
    const members = (Array.isArray(raw.members) ? raw.members : [])
      .map((member: any) => String(member && member.friendlyName || "").trim())
      .filter((name: string) => name && !sameName(name, selfName));
    const topic = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : null;
    const chatType = raw.isOneOnOne === true ? "oneOnOne" : String(raw.chatType || "").toLowerCase() === "meeting" ? "meeting" : "group";
    const title = topic || members.join(", ") || (chatType === "oneOnOne" ? "Direct chat" : "Group chat");
    return [{ id, title, topic, chatType, members, username: null, lastActivity: lastActivity(raw) }];
  });
  return chats.sort((a, b) => String(b.lastActivity || "").localeCompare(String(a.lastActivity || "")));
}

// Chat members carry names, not addresses, so an email is matched by the name words of its local part.
export function personQuery(query: string): string {
  const value = String(query || "").trim();
  const email = value.match(/^([^@\s]+)@[^@\s]+\.[^@\s]+$/);
  return email ? email[1].split(/[._+-]+/).filter(Boolean).join(" ") : value;
}

export function htmlMessage(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r\n|\r|\n/g, "<br>");
}

export function plainText(html: string): string {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function arrivalMs(message: any): number {
  const value = Date.parse(String(message?.originalarrivaltime || message?.composetime || ""));
  return Number.isFinite(value) ? value : NaN;
}

export function findSentMessageId(messages: any, text: string, selfName: string, sentAfterMs: number): string | null {
  const wanted = normalizeText(text);
  const rows = (Array.isArray(messages) ? messages : []).filter((message: any) =>
    message && typeof message.id === "string" && message.id &&
    normalizeText(plainText(String(message.content || ""))) === wanted &&
    (!selfName || !message.imdisplayname || sameName(String(message.imdisplayname), selfName)) &&
    !(arrivalMs(message) < sentAfterMs));
  rows.sort((a: any, b: any) => (arrivalMs(b) || 0) - (arrivalMs(a) || 0));
  return rows.length ? String(rows[0].id) : null;
}

export function historyRows(messages: any): { id: string; createdDateTime: string; from: string; content: string }[] {
  return (Array.isArray(messages) ? messages : [])
    .filter((message: any) => message && /^(?:Text|RichText)/i.test(String(message.messagetype || "")))
    .map((message: any) => ({
      id: String(message.id || ""),
      createdDateTime: String(message.originalarrivaltime || message.composetime || ""),
      from: String(message.imdisplayname || ""),
      content: plainText(String(message.content || "")),
    }));
}

export function sendFailure(text: string): { kind: SendFailureKind; detail: string; cause?: string } {
  const value = String(text || "");
  const auth = classifyAuthFailure(value);
  if (auth && auth.state === "logged-out") return { kind: "not-logged-in", detail: auth.message };
  if (auth) return { kind: "reauth-needed", detail: auth.message, cause: auth.state };
  // exo-teams retries 429, 5xx and transport errors itself, so a surfaced one may follow a delivered attempt.
  if (/returned status (?:429|5\d\d)|too many requests|timed out|timeout|deadline exceeded|connection reset|EOF|context canceled|executing POST/i.test(value)) {
    return { kind: "unknown", detail: `exo-teams could not confirm delivery.${quoted(value)}` };
  }
  if (/returned status 401/.test(value)) return { kind: "reauth-needed", detail: `Teams refused the session token.${quoted(value)} Run login to sign in again.`, cause: "expired" };
  if (/returned status (?:400|403|404|409|413)/.test(value)) {
    return { kind: "upstream-rejected", detail: `the Teams chat service rejected the message before delivery.${quoted(value)}` };
  }
  return { kind: "unknown", detail: `exo-teams returned an outcome that does not prove delivery.${quoted(value)}` };
}

export function parseSha256(stdout: string): string | null {
  // Older certutil prints the digest as space-separated byte pairs.
  const line = String(stdout || "").split(/\r?\n/).map((item) => item.trim()).find((item) => /^(?:[0-9a-f]{2} ?){32}(?:\s|$)/i.test(item) || /\b[0-9a-f]{64}\b/i.test(item));
  const match = line ? line.replace(/(?<=\b[0-9a-f]{2}) (?=[0-9a-f]{2}\b)/gi, "").match(/\b[0-9a-f]{64}\b/i) : null;
  return match ? match[0].toLowerCase() : null;
}

export function parseGoModDownload(stdout: string): { version: string; sum: string; error: string } | null {
  const value = parseJson<any>(String(stdout || "").trim());
  if (!value || typeof value !== "object") return null;
  return { version: String(value.Version || ""), sum: String(value.Sum || ""), error: String(value.Error || "") };
}

export function normalizeArch(value: string): string {
  const arch = String(value || "").trim().toLowerCase();
  if (arch === "x86_64" || arch === "amd64" || arch === "x64") return "x64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  return arch;
}
