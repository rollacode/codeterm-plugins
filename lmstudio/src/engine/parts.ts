// Same row shape as codeterm/plugins/provider-opencode/src/helpers.ts partToChatMsg, so the chat UI renders
// engine rows exactly like OpenCode PTY transcripts (edit diffs come from toolKind "edit" + toolEdits).

export interface OpencodePart {
  id?: string;
  messageID?: string;
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  auto?: boolean;
  overflow?: boolean;
  state?: { status?: string; input?: unknown; output?: unknown; error?: unknown; title?: unknown };
}

export interface CanonicalToolFields {
  kind: string;
  summary: string;
  detail: string;
  edits: Array<{ path: string; old: string; new: string }>;
}

export type ChatRow = Record<string, unknown> & { id: string; type: string; content: string };

export function partToChatMsg(part: OpencodePart, role: string, id: string, tsMs: number): ChatRow | null {
  const timestamp = String(tsMs);
  const type = part && part.type;
  if (type === "text") {
    const txt = part.text || "";
    if (!txt.trim()) return null;
    return { id, type: role === "user" ? "user" : "assistant", content: txt, timestamp };
  }
  if (type === "reasoning") {
    const rtxt = part.text || "";
    if (!rtxt.trim()) return null;
    return { id, type: "thinking", content: rtxt, timestamp };
  }
  if (type === "tool") {
    const tool = part.tool || "tool";
    const state = part.state || {};
    const canonical = canonicalToolFields(tool, state.input);
    const out: ChatRow = {
      id,
      type: "tool_call",
      content: "",
      timestamp,
      toolName: tool,
      toolKind: canonical.kind,
      toolSummary: canonical.summary,
      toolDetail: canonical.detail,
      toolEdits: canonical.edits,
    };
    if (state.input !== undefined) out.toolInput = state.input;
    if (typeof state.output === "string") out.toolResult = state.output;
    if (state.status === "error") {
      out.toolResult = typeof state.error === "string" ? state.error : "tool failed";
      out.toolError = true;
    }
    return out;
  }
  return null;
}

export function canonicalToolFields(name: string, input: unknown): CanonicalToolFields {
  const tool = String(name || "").trim();
  const value = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const text = (key: string): string => (typeof value[key] === "string" ? (value[key] as string) : "");
  const command = text("command") || text("cmd");
  const path = text("file_path") || text("filePath") || text("path");
  const pattern = text("pattern");
  const edits = extractCanonicalEdits(value);
  const lower = tool.toLowerCase();
  if (lower === "bash" || lower === "shell" || lower === "exec" || lower === "run") {
    return { kind: "command", summary: cleanToolText(command, "Command"), detail: command, edits: [] };
  }
  if (lower === "edit" || lower === "multiedit" || lower === "write") {
    // A write carries only `content`; showing it as an all-added diff beats an empty card.
    const written = lower === "write" && !edits.length && typeof value.content === "string" ? [{ path, old: "", new: value.content as string }] : edits;
    return { kind: "edit", summary: path || "File edit", detail: path, edits: written };
  }
  if (lower === "read") {
    return { kind: "read", summary: path || "Read file", detail: path, edits: [] };
  }
  if (lower === "glob" || lower === "grep" || lower === "search") {
    return { kind: "search", summary: cleanToolText(pattern || path, "Search"), detail: pattern || path, edits: [] };
  }
  return { kind: "generic", summary: cleanToolText(tool, "Tool"), detail: tool, edits };
}

export function extractCanonicalEdits(input: Record<string, unknown>): Array<{ path: string; old: string; new: string }> {
  const parentPath =
    typeof input.file_path === "string" ? input.file_path : typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : "";
  const pair = (value: unknown, fallbackPath: string): { path: string; old: string; new: string } | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    const oldValue = typeof item.old_string === "string" ? item.old_string : item.oldString;
    const newValue = typeof item.new_string === "string" ? item.new_string : item.newString;
    if (typeof oldValue !== "string" && typeof newValue !== "string") return null;
    const path =
      typeof item.file_path === "string" ? item.file_path : typeof item.filePath === "string" ? item.filePath : typeof item.path === "string" ? item.path : fallbackPath;
    return { path, old: typeof oldValue === "string" ? oldValue : "", new: typeof newValue === "string" ? newValue : "" };
  };
  if (Array.isArray(input.edits)) {
    return input.edits.map((edit) => pair(edit, parentPath)).filter((e): e is { path: string; old: string; new: string } => e !== null);
  }
  const single = pair(input, parentPath);
  return single ? [single] : [];
}

export function cleanToolText(value: string, fallback: string): string {
  const text = String(value || "").replace(/[\r\n\t]+/g, " ").trim();
  if (!text) return fallback;
  return text.length > 120 ? text.slice(0, 117) + "..." : text;
}
