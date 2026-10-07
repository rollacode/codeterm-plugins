/** Pure parser for Aider's markdown history. Positions are UTF-8 byte offsets. */
export interface HistoryRow {
  role: "user" | "assistant" | "system";
  blocks: Array<{ kind: "text" | "thinking"; data: { text: string } }>;
  ts: number | null;
  uuid: string;
  recordIndex?: number;
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const ERROR_RE = /(?:\blitellm\.[\w.]*Error\b|\b(?:AuthenticationError|APIConnectionError|RateLimitError|BadRequestError|PermissionDeniedError|InternalServerError)\b|\b(?:Error|Exception):|\b(?:invalid|incorrect|missing) api key\b|\bEmpty response received from LLM\b)/i;
// Aider tool_output persists these notices as blockquoted history lines.
const CHANGE_NOTICE_RE = /^(?:Applied edit to .+|Did not apply edit to .+|Commit [0-9a-f]{7,40}(?: .*)?)$/i;
const NOISE_RE = /^(?:Aider v\d|Model:|Weak model:|Editor model:|Git repo:|Repo[ -]?[Mm]ap:|Tokens:|Added .+ to the chat|Use \/help|Cost:|Open documentation url|Add \.aider\* to \.gitignore|Please visit)/;

/** `prefix` ends at the host's complete-line delta boundary. Older row content
 * is used only as context; rows are emitted when their visible content grew
 * after `fromOffset`. Stable UUIDs let the host merge split rows in place. */
export function parseAiderHistoryDelta(prefix: string, fromOffset = 0): { messages: HistoryRow[] } {
  const messages: HistoryRow[] = [];
  const state: { current: { role: "user" | "assistant" | "system"; kind: "text" | "thinking"; lines: string[]; start: number; line: number; end: number } | null } = { current: null };
  let offset = 0;
  let rowOffset = 0;
  let deltaLine = 0;
  let previousHeading = false;
  let fence: { char: string; size: number } | null = null;
  let thinkingTag: string | null = null;
  let errorContinuation = false;

  function flush() {
    if (!state.current) return;
    const text = state.current.lines.join("\n").trim();
    if (text && text !== "<blank>" && state.current.end > fromOffset) {
      messages.push({
        role: state.current.role,
        blocks: [{ kind: state.current.kind, data: { text } }],
        ts: null,
        uuid: `aider:${state.current.kind === "thinking" ? "thinking" : state.current.role}:${state.current.start}`,
        ...(state.current.start >= fromOffset ? { recordIndex: state.current.line } : {}),
      });
    }
    state.current = null;
  }

  function add(role: "user" | "assistant" | "system", text: string, end: number, kind: "text" | "thinking" = "text") {
    if (state.current?.role !== role || state.current?.kind !== kind) {
      flush();
      state.current = { role, kind, lines: [], start: rowOffset, line: deltaLine, end };
    }
    state.current!.lines.push(text);
    if (text.trim()) state.current!.end = end;
  }

  // Keep delimiters to calculate exact offsets for CRLF and Unicode histories.
  const records = prefix.match(/[^\n]*\n|[^\n]+$/g) || [];
  for (const record of records) {
    const raw = record.replace(/\r?\n$/, "");
    const end = offset + utf8Length(record);
    rowOffset = offset;
    let line = raw;
    if (!fence) {
      // Thinking uses the host's existing collapsed reasoning renderer. Keep
      // it separate from answer text, including across complete-line tails.
      while (line) {
        if (thinkingTag) {
          const close = `</${thinkingTag}>`;
          const at = line.indexOf(close);
          if (at < 0) {
            add("assistant", line, end, "thinking");
            line = "";
            break;
          }
          if (at > 0) add("assistant", line.slice(0, at), end, "thinking");
          flush();
          line = line.slice(at + close.length);
          thinkingTag = null;
          rowOffset = offset + utf8Length(raw.slice(0, raw.length - line.length));
        } else {
          const open = /<thinking-content-[^>]*>/.exec(line);
          if (!open) break;
          if (open.index > 0) add("assistant", line.slice(0, open.index), end);
          flush();
          rowOffset += utf8Length(line.slice(0, open.index));
          thinkingTag = open[0].slice(1, -1);
          add("assistant", "", end, "thinking");
          line = line.slice(open.index + open[0].length);
        }
      }
      if (thinkingTag && !raw.trim()) add("assistant", "", end, "thinking");
    }
    if (thinkingTag) {
      if (offset >= fromOffset) deltaLine++;
      offset = end;
      continue;
    }
    const heading = !fence && /^####(?: |$)/.test(line);
    if (!fence && /^# aider chat started at /.test(line)) {
      flush();
      previousHeading = false;
      errorContinuation = false;
    } else if (heading) {
      if (!previousHeading) flush();
      const body = line.slice(5).replace(/ {2}$/, "");
      if (body.trim() && body.trim() !== "<blank>") add("user", body, end);
      else if (!body.trim() && previousHeading && state.current?.role === "user") add("user", "", end);
      previousHeading = true;
      errorContinuation = false;
    } else {
      previousHeading = false;
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        add("assistant", line, end);
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) fence = null;
      } else if (marker) {
        fence = { char: marker[1][0], size: marker[1].length };
        add("assistant", line, end);
      } else if (/^> ?/.test(line)) {
        const body = line.replace(/^> ?/, "").replace(/ {2}$/, "");
        if (CHANGE_NOTICE_RE.test(body)) {
          add("system", body, end);
          errorContinuation = false;
        } else if (NOISE_RE.test(body) || !body.trim()) errorContinuation = false;
        else if (ERROR_RE.test(body) || errorContinuation) {
          add("assistant", body, end);
          errorContinuation = true;
        }
      } else if (NOISE_RE.test(line)) {
        errorContinuation = false;
      } else if (line.trim()) {
        add("assistant", line, end);
        errorContinuation = false;
      } else if (state.current?.role === "assistant") {
        add("assistant", "", end);
      }
    }
    if (offset >= fromOffset) deltaLine++;
    offset = end;
  }
  flush();
  return { messages };
}
