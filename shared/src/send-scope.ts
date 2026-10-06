export type ScopeChat = { id: string; title: string };
export type SendScope = { mode: "all" } | { mode: "only"; chats: ScopeChat[] };
export type SendOrigin = "agent" | "view";
export type SendDecision = { allow: true } | { allow: false; reason: "chat-not-allowed"; message: string };

export const ALL_CHATS: SendScope = { mode: "all" };
const MAX_SCOPE_CHATS = 200;

function scopeChats(value: unknown, validId: (id: string) => boolean): ScopeChat[] | null {
  if (!Array.isArray(value) || value.length > MAX_SCOPE_CHATS) return null;
  const out: ScopeChat[] = [];
  for (const item of value) {
    const id = item && typeof item.id === "string" ? item.id : "";
    if (!validId(id)) return null;
    if (out.some((chat) => chat.id === id)) continue;
    out.push({ id, title: typeof item.title === "string" ? item.title.slice(0, 200) : "" });
  }
  return out;
}

// A missing file is the default "all chats"; a present but unreadable one fails closed to an empty allow-list.
export function parseSendScope(raw: string | null | undefined, validId: (id: string) => boolean): SendScope {
  if (raw === null || raw === undefined || raw === "") return ALL_CHATS;
  let value: any;
  try { value = JSON.parse(raw); } catch { return { mode: "only", chats: [] }; }
  if (value && value.mode === "all") return ALL_CHATS;
  const chats = value && value.mode === "only" ? scopeChats(value.chats, validId) : null;
  return { mode: "only", chats: chats || [] };
}

export function validateSendScope(value: any, validId: (id: string) => boolean): SendScope | { error: string } {
  if (value && value.mode === "all") return ALL_CHATS;
  if (!value || value.mode !== "only") return { error: "Choose a restriction mode: all or only." };
  const chats = scopeChats(value.chats, validId);
  if (!chats) return { error: `List up to ${MAX_SCOPE_CHATS} chats by their immutable ids.` };
  return { mode: "only", chats };
}

export function decideSend(scope: SendScope, chatId: string, origin: SendOrigin): SendDecision {
  if (origin === "view" || scope.mode === "all") return { allow: true };
  if (scope.chats.some((chat) => chat.id === chatId)) return { allow: true };
  const allowed = scope.chats.length ? scope.chats.map((chat) => chat.title || chat.id).join(", ") : "no chats";
  return {
    allow: false,
    reason: "chat-not-allowed",
    message: `chat-not-allowed: The owner's "Restrict agent sends" setting permits only these chats: ${allowed}. ${chatId} is not one of them. Ask the owner to add it in the plugin view (Restrict agent sends) or to switch the setting back to all chats.`,
  };
}

export type MatchableChat = { id: string; title: string; username?: string | null };
export type ChatMatch<T extends MatchableChat> = { match: T | null; ambiguous: boolean; candidates: T[] };

function fold(value: string): string {
  return value.toLowerCase().replace(/^@/, "").replace(/\s+/g, " ").trim();
}

export function matchChats<T extends MatchableChat>(chats: T[], query: string, limit = 20): ChatMatch<T> {
  const q = fold(query);
  if (!q) return { match: null, ambiguous: false, candidates: [] };
  const byId = chats.filter((chat) => chat.id.toLowerCase() === q);
  if (byId.length === 1) return { match: byId[0], ambiguous: false, candidates: byId };
  const tokens = q.split(" ");
  const hits = chats.filter((chat) => {
    const haystack = `${fold(chat.title)} ${fold(chat.username || "")}`;
    return tokens.every((token) => haystack.includes(token));
  });
  const exact = hits.filter((chat) => fold(chat.title) === q || (!!chat.username && fold(chat.username) === q));
  const match = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
  return { match, ambiguous: !match && hits.length > 1, candidates: hits.slice(0, limit) };
}
