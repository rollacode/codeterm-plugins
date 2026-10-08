export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;
export const SNIPPET_CHARS = 240;
export const FILE_DEFAULT_MIB = 50;
export const FILE_MAX_MIB = 2000;

export type FileFormat = "plain" | "html";
export type SendFileArgs = { chat: string; path: string; caption: string; key?: string; format: FileFormat };
export type SearchArgs = { query: string; chat?: string; limit: number };
export type PeerRef = { id: string; title: string; type: string; username: string | null };
export type SearchHit = {
  messageId: string;
  date: number | null;
  time: string | null;
  chat: PeerRef | null;
  sender: { id: string | null; name: string; username: string | null; self: boolean } | null;
  out: boolean;
  snippet: string;
};

export function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value) || value.startsWith("/");
}

export function baseName(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

export function parentDir(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return "";
  const parent = trimmed.slice(0, cut);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || trimmed.slice(0, 1);
}

const SEND_FILE_USAGE = "Usage: send-file <chat-id-or-name> <absolute-file-path> [--message <caption>] [--key <idempotency-key>] [--format plain|html]; quote a caption or path that contains spaces.";

export function parseSendFileArgs(args: string[]): SendFileArgs | { error: string } {
  if (args.length < 2) return { error: SEND_FILE_USAGE };
  const chat = String(args[0] || "").trim();
  const path = String(args[1] || "");
  if (!chat) return { error: SEND_FILE_USAGE };
  if (!isAbsolutePath(path)) return { error: `The file path must be absolute (for example C:\\Users\\me\\report.pdf or /home/me/report.pdf). ${SEND_FILE_USAGE}` };
  let caption: string | undefined;
  let key: string | undefined;
  let format: FileFormat | undefined;
  for (let i = 2; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!["--message", "--key", "--format"].includes(flag)) return { error: `Unexpected argument ${JSON.stringify(flag)}. ${SEND_FILE_USAGE}` };
    if (value === undefined) return { error: `${flag} needs a value. ${SEND_FILE_USAGE}` };
    if (flag === "--message" && caption === undefined) caption = value;
    else if (flag === "--key" && key === undefined) {
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) return { error: "--key needs one 1–160 character idempotency key ([A-Za-z0-9._:-])." };
      key = value;
    } else if (flag === "--format" && format === undefined) {
      if (value === "markdown") return { error: "The pinned tg v0.11.0 client has no native Markdown parse mode. Use --format html or plain; nothing was sent." };
      if (value !== "plain" && value !== "html") return { error: "--format needs one of plain, html." };
      format = value;
    } else return { error: `Unexpected argument ${JSON.stringify(flag)}. ${SEND_FILE_USAGE}` };
  }
  return { chat, path, caption: caption || "", key, format: format || "plain" };
}

const SEARCH_USAGE = "Usage: search-messages <query> [--chat <chat-id-or-name>] [--limit 1-50].";

export function parseSearchArgs(args: string[]): SearchArgs | { error: string } {
  const words: string[] = [];
  let chat: string | undefined;
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === "--") { words.push(...args.slice(i + 1).map(String)); break; }
    if (arg === "--chat" || arg === "--limit") {
      const value = args[i + 1];
      if (value === undefined || value === "") return { error: `${arg} needs a value. ${SEARCH_USAGE}` };
      if (arg === "--chat") {
        if (chat !== undefined) return { error: `--chat may be given once. ${SEARCH_USAGE}` };
        chat = String(value).trim();
      } else {
        if (limit !== undefined || !/^[0-9]{1,3}$/.test(String(value)) || Number(value) < 1 || Number(value) > SEARCH_MAX_LIMIT) {
          return { error: `--limit must be an integer from 1 to ${SEARCH_MAX_LIMIT}. ${SEARCH_USAGE}` };
        }
        limit = Number(value);
      }
      i++;
      continue;
    }
    words.push(arg);
  }
  const query = words.join(" ").trim();
  if (!query) return { error: `The search text must not be empty. ${SEARCH_USAGE}` };
  return { query, chat, limit: limit || SEARCH_DEFAULT_LIMIT };
}

export function uploadedMessageId(data: any): string | null {
  const files = data && Array.isArray(data.files) ? data.files : [];
  if (files.length !== 1) return null;
  const value = files[0] && files[0].message_id;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[0-9]{1,20}$/.test(value)) return value;
  return null;
}

export function peerRef(peer: any): PeerRef | null {
  if (!peer || (typeof peer.id !== "number" && typeof peer.id !== "string")) return null;
  const id = String(peer.id);
  if (!/^-?[0-9]{1,20}$/.test(id) || id === "0") return null;
  const username = String(peer.username || "").replace(/^@/, "");
  return { id: `id:${id}`, title: String(peer.name || peer.title || ""), type: String(peer.type || "unknown"), username: username ? `@${username}` : null };
}

export function snippet(text: string, query: string, max = SNIPPET_CHARS): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  const needle = query.toLowerCase().split(/\s+/).find((word) => word && lower.indexOf(word) >= 0);
  const at = needle ? lower.indexOf(needle) : 0;
  let start = Math.max(0, Math.min(at - Math.floor(max / 3), flat.length - max));
  let end = start + max;
  if (start > 0 && /[\udc00-\udfff]/.test(flat.charAt(start))) start++;
  if (end < flat.length && /[\ud800-\udbff]/.test(flat.charAt(end - 1))) end--;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

function senderOf(raw: any, chat: PeerRef | null): SearchHit["sender"] {
  const from = peerRef(raw && raw.from);
  if (from) return { id: from.id, name: from.title || from.username || from.id, username: from.username, self: false };
  if (raw && raw.out) return { id: null, name: "you", username: null, self: true };
  if (chat && chat.type === "user") return { id: chat.id, name: chat.title || chat.username || chat.id, username: chat.username, self: false };
  return null;
}

// Pinned tg reports one `peer` for a whole result: exact for a per-chat search, only the first hit's chat for --global.
export function searchHits(data: any, query: string, scope: "chat" | "global", chat: PeerRef | null): { hits: SearchHit[]; chatAttribution: "complete" | "partial" } {
  const messages = data && Array.isArray(data.messages) ? data.messages : [];
  const firstPeer = peerRef(data && data.peer);
  let complete = true;
  const hits = messages.flatMap((raw: any, index: number): SearchHit[] => {
    const id = raw && raw.id;
    if (!((typeof id === "number" && Number.isSafeInteger(id) && id > 0) || (typeof id === "string" && /^[0-9]{1,20}$/.test(id)))) return [];
    const own = peerRef(raw.peer);
    const hitChat = scope === "chat" ? chat : own || (index === 0 ? firstPeer : null);
    if (!hitChat) complete = false;
    const date = Number.isFinite(Number(raw.date)) && Number(raw.date) > 0 ? Number(raw.date) : null;
    const text = typeof raw.text === "string" ? raw.text : "";
    return [{
      messageId: String(id),
      date,
      time: date === null ? null : new Date(date * 1000).toISOString(),
      chat: hitChat,
      sender: senderOf(raw, hitChat),
      out: !!raw.out,
      snippet: text ? snippet(text, query) : raw.media ? `[${String(raw.media)}]` : "",
    }];
  });
  return { hits, chatAttribution: complete ? "complete" : "partial" };
}
