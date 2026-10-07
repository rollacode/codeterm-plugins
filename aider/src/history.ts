/** Pure parser for Aider's markdown history. Positions are UTF-8 byte offsets. */
export interface HistoryRow {
  role: "user" | "assistant";
  blocks: Array<{ kind: "text"; data: { text: string } }>;
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
const NOISE_RE = /^(?:Aider v\d|Model:|Weak model:|Editor model:|Git repo:|Repo[ -]?[Mm]ap:|Tokens:|Added .+ to the chat|Use \/help|Cost:|Open documentation url|Add \.aider\* to \.gitignore|Please visit)/;

/** `prefix` ends at the host's complete-line delta boundary. Older row content
 * is used only as context; rows are emitted when their visible content grew
 * after `fromOffset`. Stable UUIDs let the host merge split rows in place. */
export function parseAiderHistoryDelta(prefix: string, fromOffset = 0): { messages: HistoryRow[] } {
  const messages: HistoryRow[] = [];
  const state: { current: { role: "user" | "assistant"; lines: string[]; start: number; line: number; end: number } | null } = { current: null };
  let offset = 0;
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
        blocks: [{ kind: "text", data: { text } }],
        ts: null,
        uuid: `aider:${state.current.role}:${state.current.start}`,
        ...(state.current.start >= fromOffset ? { recordIndex: state.current.line } : {}),
      });
    }
    state.current = null;
  }

  function add(role: "user" | "assistant", text: string, end: number) {
    if (state.current?.role !== role) {
      flush();
      state.current = { role, lines: [], start: offset, line: deltaLine, end };
    }
    state.current!.lines.push(text);
    if (text.trim()) state.current!.end = end;
  }

  // Keep delimiters to calculate exact offsets for CRLF and Unicode histories.
  const records = prefix.match(/[^\n]*\n|[^\n]+$/g) || [];
  for (const record of records) {
    const raw = record.replace(/\r?\n$/, "");
    const end = offset + utf8Length(record);
    let line = raw;
    if (!fence) {
      // Suppress even an unclosed thinking block across tail boundaries.
      let visible = "";
      while (line) {
        if (thinkingTag) {
          const close = `</${thinkingTag}>`;
          const at = line.indexOf(close);
          if (at < 0) { line = ""; break; }
          line = line.slice(at + close.length);
          thinkingTag = null;
        } else {
          const open = /<thinking-content-[^>]*>/.exec(line);
          if (!open) { visible += line; break; }
          visible += line.slice(0, open.index);
          thinkingTag = open[0].slice(1, -1);
          line = line.slice(open.index + open[0].length);
        }
      }
      line = visible;
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
        if (NOISE_RE.test(body) || !body.trim()) errorContinuation = false;
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
