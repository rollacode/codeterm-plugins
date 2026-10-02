// LM Studio text-tool parsing and execution bridge. Session scheduling and
// transcript emission stay in plugin.ts; host access and JSON decoding are
// injected so this helper does not own session state.

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface PendingExec {
  call: ToolCall;
  jobId: string;
  toolId?: string;
}

export interface ToolParseEntry {
  call: ToolCall;
}

interface ParsedToolCall {
  status?: unknown;
  tool?: unknown;
  args?: unknown;
  span?: unknown;
  reason?: unknown;
}

const TOOL_SCHEMA_JSON = JSON.stringify({
  tools: [
    { name: "exec", args: ["cmd"], optional: ["cwd"] },
    { name: "read_file", args: ["path"], optional: [] },
    { name: "write_file", args: ["path", "content"], optional: [] },
    { name: "codeterm", args: ["args"], optional: [] },
    { name: "mem_search", args: ["query"], optional: [] },
    { name: "spawn_agent", args: ["provider", "task"], optional: ["workspace"] },
  ],
  aliases: { command: "cmd", file: "path", filepath: "path" },
});
const FENCE_RE = /```[^\r\n`]*\r?\n[\s\S]*?```/g;
const TOOL_WRAPPER_RE = /<\s*\|?\/?\s*(?:tool_call|tool▁call)\s*\|?\s*>/gi;

type ToolHost = typeof host;

export function createToolRuntime(
  host: ToolHost,
  parseJson: <T>(raw: string, fallback: T) => T,
) {
  function shellQuote(s: string): string {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
  }

  // Build the `sh -lc` exec opts for an exec/codeterm tool call, or an error
  // result if required args are missing. The command runs async (host.exec.start)
  // so a multi-second tool exec never holds the shared VM lock.
  function execShellCmd(call: ToolCall): { shellCmd?: string; error?: string } {
    if (call.tool === "exec") {
      const cmd = typeof call.args.cmd === "string" ? call.args.cmd : "";
      const cwd = typeof call.args.cwd === "string" ? call.args.cwd : undefined;
      if (!cmd) return { error: "exec requires args.cmd" };
      return { shellCmd: cwd && cwd.trim() ? `cd ${shellQuote(cwd)} && ${cmd}` : cmd };
    }
    const args = typeof call.args.args === "string" ? call.args.args : "";
    if (!args) return { error: "codeterm requires args.args" };
    return { shellCmd: `codeterm ${args}` };
  }

  interface ExecStartResult {
    jobId?: string;
    error?: string;
  }

  interface ExecPoll {
    done?: boolean;
    code?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
  }

  function startExecJob(shellCmd: string): ExecStartResult {
    return parseJson<ExecStartResult>(
      host.execStart(JSON.stringify({ bin: "sh", args: ["-lc", shellCmd], timeoutMs: 120000 })),
      { error: "host.exec.start returned non-JSON" },
    );
  }

  function pollExecJob(jobId: string): ExecPoll {
    return parseJson<ExecPoll>(host.execPoll(jobId), { done: true, error: "host.exec.poll returned non-JSON" });
  }

  // Shape the terminal poll into the same `{code, stdout, stderr}` (+ optional
  // error) object the old blocking exec returned, so tool_result rendering is
  // byte-for-byte identical from the user's view.
  function execResultFromPoll(poll: ExecPoll): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (typeof poll.code === "number") result.code = poll.code;
    if (typeof poll.stdout === "string") result.stdout = poll.stdout;
    if (typeof poll.stderr === "string") result.stderr = poll.stderr;
    if (typeof poll.error === "string") result.error = poll.error;
    return result;
  }

  function formatToolResult(call: ToolCall, result: unknown): string {
    return JSON.stringify({ tool: call.tool, args: call.args, result }, null, 2);
  }

  // Mirrors the host's tri-state contract: "ok" carries entries to execute,
  // "none" is a normal assistant message, "malformed" is a tool-call-shaped block
  // that failed parse+repair and must be retried (never silently dropped).
  type ParseStatus = "ok" | "none" | "malformed";

  interface ParsedTools {
    entries: ToolParseEntry[];
    cleaned: string;
    status: ParseStatus;
    reason?: string;
  }

  // Remove the given (executed) spans from the displayed text and tidy whitespace,
  // so the user sees clean prose + the tool card instead of the raw call syntax.
  function stripSpans(text: string, spans: { start: number; end: number }[]): string {
    if (!spans.length) return text;
    const ordered = [...spans].sort((a, b) => a.start - b.start);
    let out = "";
    let cursor = 0;
    for (const s of ordered) {
      if (s.start < cursor) continue;
      out += text.slice(cursor, s.start);
      cursor = s.end;
    }
    out += text.slice(cursor);
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  function expandToolSpan(text: string, span: { start: number; end: number }): { start: number; end: number } {
    FENCE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FENCE_RE.exec(text)) !== null) {
      const start = match.index;
      const end = match.index + match[0].length;
      if (span.start >= start && span.end <= end) return { start, end };
    }

    let start = span.start;
    let end = span.end;
    const before = text.slice(0, start);
    TOOL_WRAPPER_RE.lastIndex = 0;
    let wrapper: RegExpExecArray | null;
    let lastBefore: RegExpExecArray | null = null;
    while ((wrapper = TOOL_WRAPPER_RE.exec(before)) !== null) lastBefore = wrapper;
    if (lastBefore && before.slice(lastBefore.index + lastBefore[0].length).trim() === "") start = lastBefore.index;

    const after = text.slice(end);
    const afterWrapper = after.match(/^\s*<\s*\|?\/?\s*(?:tool_call|tool▁call)\s*\|?\s*>/i);
    if (afterWrapper) end += afterWrapper[0].length;
    return { start, end };
  }

  function parsedSpan(parsed: ParsedToolCall, text: string): { start: number; end: number } | null {
    if (!Array.isArray(parsed.span) || parsed.span.length !== 2) return null;
    const start = typeof parsed.span[0] === "number" ? parsed.span[0] : -1;
    const end = typeof parsed.span[1] === "number" ? parsed.span[1] : -1;
    if (start < 0 || end < start || end > text.length) return null;
    return { start, end };
  }

  // Delegate extraction/repair/validation to the host's Rust parser. It returns a
  // tri-state JSON string: {status:"ok",tool,args,span} for a validated call,
  // {status:"none"} for plain prose, or {status:"malformed",reason} for a
  // tool-call-shaped block that survived neither parse nor repair (-> retry, not
  // drop). A parser throw is degraded to "none" so a single bad call never crashes
  // the turn.
  function parseToolEntries(text: string): ParsedTools {
    let raw = "";
    try {
      raw = host.toolcall.parse(text, TOOL_SCHEMA_JSON);
    } catch (e) {
      host.log("warn", `host.toolcall.parse failed: ${String(e)}`);
      return { entries: [], cleaned: text, status: "none" };
    }
    // Tolerate the legacy "null"/non-JSON shapes by degrading to "none".
    const parsed = parseJson<ParsedToolCall | null>(raw, null);
    if (!parsed || typeof parsed !== "object") return { entries: [], cleaned: text, status: "none" };

    if (parsed.status === "malformed") {
      const reason = typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "unparseable tool call";
      return { entries: [], cleaned: text, status: "malformed", reason };
    }
    if (parsed.status !== "ok" || typeof parsed.tool !== "string") {
      return { entries: [], cleaned: text, status: "none" };
    }
    const args = parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
      ? (parsed.args as Record<string, unknown>)
      : {};
    const span = parsedSpan(parsed, text);
    const cleaned = span ? stripSpans(text, [expandToolSpan(text, span)]) : text;
    return {
      entries: [{ call: { tool: parsed.tool, args } }],
      cleaned,
      status: "ok",
    };
  }

  function toolContent(call: ToolCall): string {
    if (call.tool === "exec" && typeof call.args.cmd === "string") return call.args.cmd;
    if (call.tool === "codeterm" && typeof call.args.args === "string") return `codeterm ${call.args.args}`;
    return JSON.stringify(call.args);
  }

  // Sync tools only. exec/codeterm are dispatched separately via the async
  // host.exec.start/poll path (see advanceTools) so they never block the VM.
  function executeTool(call: ToolCall): unknown {
    switch (call.tool) {
      case "read_file": {
        const path = typeof call.args.path === "string" ? call.args.path : "";
        if (!path) return { error: "read_file requires args.path" };
        return { content: host.readFile(path) };
      }
      case "write_file": {
        const path = typeof call.args.path === "string" ? call.args.path : "";
        const content = typeof call.args.content === "string" ? call.args.content : "";
        if (!path) return { error: "write_file requires args.path" };
        return { ok: host.writeFile(path, content) };
      }
      case "mem_search": {
        const query = typeof call.args.query === "string" ? call.args.query : "";
        if (!query) return { error: "mem_search requires args.query" };
        const maybeHost = host as unknown as {
          mem?: { search?: (opts: { query: string; k?: number }) => unknown } | ((optsJson: string) => string);
        };
        if (typeof maybeHost.mem === "function") {
          return parseJson<unknown>(maybeHost.mem(JSON.stringify({ query })), { error: "host.mem returned non-JSON" });
        }
        return maybeHost.mem && maybeHost.mem.search ? maybeHost.mem.search({ query, k: 5 }) : { error: "host.mem.search unavailable" };
      }
      case "spawn_agent": {
        const provider = typeof call.args.provider === "string" ? call.args.provider : "";
        const task = typeof call.args.task === "string" ? call.args.task : "";
        const workspace = typeof call.args.workspace === "string" ? call.args.workspace : "default";
        if (!provider || !task) return { error: "spawn_agent requires args.provider and args.task" };
        const maybeHost = host as unknown as {
          agent?: { spawn?: (...args: unknown[]) => unknown };
          worker?: { start?: (...args: unknown[]) => unknown };
        };
        if (maybeHost.agent && maybeHost.agent.spawn) {
          return maybeHost.agent.spawn(workspace, { backend: { provider }, task });
        }
        if (maybeHost.worker && maybeHost.worker.start) {
          return maybeHost.worker.start(JSON.stringify({ provider, task, workspace }));
        }
        return { error: "host.agent.spawn unavailable" };
      }
      default:
        return { error: `unknown tool: ${call.tool}` };
    }
  }

  return {
    execShellCmd, startExecJob, pollExecJob, execResultFromPoll,
    formatToolResult, parseToolEntries, toolContent, executeTool,
  };
}
