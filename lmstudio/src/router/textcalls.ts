import { checkToolArgs } from "./toolspec";

export interface TextToolCall {
  tool: string;
  args: Record<string, string>;
}

export interface TextCallParse {
  status: "none" | "ok" | "malformed";
  calls: TextToolCall[];
  cleaned: string;
  reason?: string;
}

const OPEN_RE = /<tool_call\s*>/gi;
const CLOSE_RE = /<\/tool_call\s*>/i;

type Raw = { tool: string; args: unknown } | { error: string };

function edgeTrim(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function firstIndex(text: string, from: number, patterns: RegExp[]): number {
  let best = text.length;
  for (const re of patterns) {
    const m = re.exec(text.slice(from));
    if (m && from + m.index < best) best = from + m.index;
  }
  return best;
}

function parseXmlBody(body: string): Raw {
  const fn = /<function=([^>\s]+)\s*>/i.exec(body);
  if (!fn) return { error: "tool_call without <function=NAME>" };
  const args: Record<string, string> = {};
  const paramRe = /<parameter=([^>\s]+)\s*>/gi;
  paramRe.lastIndex = fn.index + fn[0].length;
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(body)) !== null) {
    const start = m.index + m[0].length;
    const end = firstIndex(body, start, [/<\/parameter\s*>/i, /<parameter=/i, /<\/function\s*>/i]);
    args[m[1]] = edgeTrim(body.slice(start, end));
    paramRe.lastIndex = end;
  }
  return { tool: fn[1], args };
}

function parseJsonBody(body: string): Raw {
  const end = body.lastIndexOf("}");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body.slice(body.indexOf("{"), end + 1)) as Record<string, unknown>;
  } catch {
    return { error: "tool_call JSON does not parse" };
  }
  const fn = data.function && typeof data.function === "object" ? (data.function as Record<string, unknown>) : data;
  const name = typeof fn.name === "string" ? fn.name : typeof fn.tool === "string" ? fn.tool : "";
  if (!name) return { error: "tool_call JSON has no name" };
  let args = fn.arguments !== undefined ? fn.arguments : fn.args;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return { error: `${name} arguments are not JSON` };
    }
  }
  return { tool: name, args };
}

/** Qwen/Hermes text-form calls; only declared tools with valid args come back as calls. */
export function parseTextToolCalls(text: string): TextCallParse {
  const opens: { start: number; bodyStart: number }[] = [];
  OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_RE.exec(text)) !== null) opens.push({ start: m.index, bodyStart: m.index + m[0].length });
  if (!opens.length) return { status: "none", calls: [], cleaned: text };

  const calls: TextToolCall[] = [];
  const errors: string[] = [];
  const spans: [number, number][] = [];
  opens.forEach((open, i) => {
    const limit = i + 1 < opens.length ? opens[i + 1].start : text.length;
    const segment = text.slice(open.bodyStart, limit);
    const close = CLOSE_RE.exec(segment);
    const body = close ? segment.slice(0, close.index) : segment;
    spans.push([open.start, close ? open.bodyStart + close.index + close[0].length : limit]);
    const raw = body.trim().charAt(0) === "{" ? parseJsonBody(body) : parseXmlBody(body);
    if ("error" in raw) {
      errors.push(raw.error);
      return;
    }
    const checked = checkToolArgs(raw.tool, raw.args);
    if (checked.ok) calls.push({ tool: raw.tool, args: checked.args });
    else errors.push(checked.error);
  });

  let cleaned = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    cleaned += text.slice(cursor, start);
    cursor = end;
  }
  cleaned = (cleaned + text.slice(cursor)).replace(/\n{3,}/g, "\n\n").trim();
  if (errors.length) return { status: "malformed", calls: [], cleaned: text, reason: errors.join("; ") };
  return { status: "ok", calls, cleaned };
}
