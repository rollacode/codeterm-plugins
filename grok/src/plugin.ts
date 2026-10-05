import type {
  LaunchParams,
  LaunchSessionDetection,
  LaunchSessionEvidence,
  ModelInfo,
  PluginModule,
  ResumeParams,
} from "@codeterm/plugin-sdk";

const TITLE_RE = /\bgrok\b/i;
const OUTPUT_FINGERPRINTS = [
  "Grok Build TUI",
  "You are logged in with grok.com",
  "Compactions remaining",
];
const TUI_FRAGMENTS = ["grok build tui", "compactions remaining"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALWAYS_APPROVE = "--always-approve";
const BYPASS_PERMISSIONS = ["--permission-mode", "bypassPermissions"];
const GROK_AUTH_CREDENTIAL = "grokAuth";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
let cachedGrokClientVersion: string | null | undefined;

interface GrokManifest {
  models?: ModelInfo[];
}

interface GrokSummary {
  info?: { id?: string; cwd?: string };
  created_at?: string;
  current_model_id?: string;
  reasoning_effort?: string;
  generated_title?: string;
  session_summary?: string;
}

interface GrokUsageFile {
  session?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsdTicks?: number;
  };
}

interface ActiveSession {
  session_id?: string;
  pid?: number;
}

interface ModelsCache {
  models?: Record<string, { info?: { id?: string; name?: string; description?: string | null; hidden?: boolean } }>;
}

function quote(value: string): string {
  return host.shell.quoteFor(String(value || ""), host.platform());
}

function hasFlag(parts: string[], flag: string): boolean {
  for (let i = 0; i < parts.length; i++) if (parts[i] === flag) return true;
  return false;
}

function grokHome(): string | null {
  const home = host.homeDir();
  if (!home) return null;
  const sep = host.platform() === "windows" ? "\\" : "/";
  return home.replace(/[/\\]+$/, "") + sep + ".grok";
}

function joinPath(left: string, right: string): string {
  const sep = host.platform() === "windows" ? "\\" : "/";
  return left.replace(/[/\\]+$/, "") + sep + right;
}

function cwdKey(cwd: string): string {
  const native = host.path && host.path.toNative ? host.path.toNative(cwd) : cwd;
  return encodeURIComponent(native);
}

function sessionsRoot(): string | null {
  const home = grokHome();
  return home ? joinPath(home, "sessions") : null;
}

function sessionDir(cwd: string, sessionId: string): string | null {
  const root = sessionsRoot();
  if (!root || !cwd || !sessionId) return null;
  return joinPath(joinPath(root, cwdKey(cwd)), sessionId);
}

function sessionExistsAt(cwd: string, sessionId: string): boolean {
  const dir = sessionDir(cwd, sessionId);
  return !!dir && host.fs.fileExists(joinPath(dir, "summary.json"));
}

function readSummary(cwd: string, sessionId: string): GrokSummary | null {
  const dir = sessionDir(cwd, sessionId);
  if (!dir) return null;
  return host.fs.readJson(joinPath(dir, "summary.json"));
}

function isUuid(value: string): boolean {
  return UUID_RE.test(String(value || ""));
}

function parseTimeMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function appendLaunchFlags(parts: string[], params: LaunchParams): void {
  if (!hasFlag(parts, ALWAYS_APPROVE)) parts.push(ALWAYS_APPROVE);
  if (params.skipPermissions && !hasFlag(parts, "--permission-mode")) {
    parts.push(BYPASS_PERMISSIONS[0], quote(BYPASS_PERMISSIONS[1]));
  }
  const args = params.args || [];
  for (let i = 0; i < args.length; i++) parts.push(quote(String(args[i])));
  const marker = String(params.launchMarker || "").trim();
  if (isUuid(marker) && !hasFlag(parts, "--session-id")) {
    parts.push("--session-id", quote(marker));
  }
}

function resumeCommand(params: ResumeParams): string {
  const parts = ["grok", ALWAYS_APPROVE, "--resume", quote(String(params.sessionId || ""))];
  if (params.skipPermissions && !hasFlag(parts, "--permission-mode")) {
    parts.push(BYPASS_PERMISSIONS[0], quote(BYPASS_PERMISSIONS[1]));
  }
  const extra = params.args || [];
  for (let i = 0; i < extra.length; i++) parts.push(quote(String(extra[i])));
  const system = String(params.systemPrompt || "").trim();
  if (system) parts.push("--system-prompt-override", quote(system));
  return parts.join(" ");
}

function starterTask(params: LaunchParams): string {
  const handshake = params.starterPrompt === "startup_handshake"
    ? String(params.starterPromptText || "").trim()
    : "";
  return [handshake, params.task].filter(Boolean).join("\n\n");
}

function updateText(update: Record<string, unknown> | null): string {
  if (!update) return "";
  const content = update.content;
  if (content && typeof content === "object" && typeof (content as { text?: string }).text === "string") {
    return String((content as { text: string }).text).trim();
  }
  return "";
}

function grokUpdateToChat(row: Record<string, unknown>, seq: number): Record<string, unknown> | null {
  const params = row.params && typeof row.params === "object" ? row.params as Record<string, unknown> : null;
  const update = params && params.update && typeof params.update === "object"
    ? params.update as Record<string, unknown>
    : null;
  const kind = update ? String(update.sessionUpdate || "") : "";
  let type = "";
  if (kind === "user_message_chunk") type = "user";
  else if (kind === "agent_thought_chunk") type = "thinking";
  else if (kind === "agent_message_chunk") type = "assistant";
  else return null;
  const content = updateText(update);
  if (!content) return null;
  const meta = row._meta && typeof row._meta === "object" ? row._meta as Record<string, unknown> : {};
  const id = typeof meta.eventId === "string" && meta.eventId ? String(meta.eventId) : `grok-${seq}`;
  let tsMs = typeof meta.agentTimestampMs === "number" ? meta.agentTimestampMs : 0;
  if (!tsMs && typeof row.timestamp === "number") tsMs = row.timestamp > 1e12 ? row.timestamp : row.timestamp * 1000;
  return { id, type, content, timestamp: String(tsMs || seq), seq };
}

function readGrokChat(cwd: string, sessionId: string, cursor?: string | null): { messages: unknown[]; cursor: string } {
  const path = sessionDir(cwd, sessionId);
  const empty = { messages: [] as unknown[], cursor: cursor && /^\d+$/.test(cursor) ? cursor : "0" };
  if (!path) return empty;
  const file = joinPath(path, "updates.jsonl");
  const raw = host.fs.readFile(file);
  if (!raw) return empty;
  const start = cursor && /^\d+$/.test(cursor) ? parseInt(cursor, 10) : 0;
  const lines = String(raw).split("\n");
  const messages: unknown[] = [];
  let next = start;
  for (let i = start; i < lines.length; i++) {
    next = i + 1;
    const line = lines[i].trim();
    if (!line) continue;
    let row: Record<string, unknown> | null = null;
    try { row = JSON.parse(line); } catch (_) { continue; }
    if (!row || typeof row !== "object") continue;
    const msg = grokUpdateToChat(row, i);
    if (msg) messages.push(msg);
  }
  return { messages, cursor: String(next) };
}

function listSessionIds(cwd: string): string[] {
  const root = sessionsRoot();
  if (!root || !cwd) return [];
  const dir = joinPath(root, cwdKey(cwd));
  if (!host.fs.fileExists(dir)) return [];
  const entries = host.fs.readDir(dir) || [];
  const ids: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i].name;
    if (!entries[i].isDir || !isUuid(name)) continue;
    if (host.fs.fileExists(joinPath(joinPath(dir, name), "summary.json"))) ids.push(name);
  }
  return ids;
}

function discoverFromCache(): ModelInfo[] | null {
  const home = grokHome();
  if (!home) return null;
  const cache = host.fs.readJson(joinPath(home, "models_cache.json")) as ModelsCache | null;
  if (!cache || !cache.models) return null;
  const models: ModelInfo[] = [];
  const ids = Object.keys(cache.models);
  for (let i = 0; i < ids.length; i++) {
    const info = cache.models[ids[i]] && cache.models[ids[i]].info;
    if (!info || info.hidden) continue;
    const id = String(info.id || ids[i]);
    models.push({
      id,
      displayName: String(info.name || id),
      description: info.description ? String(info.description) : undefined,
      group: "xAI",
    });
  }
  return models.length ? models : null;
}

function discoverFromCli(): ModelInfo[] | null {
  const raw = host.exec(JSON.stringify({ bin: "grok", args: ["models"], timeoutMs: 5000 }));
  let result: { code?: number; stdout?: string } | null = null;
  try { result = JSON.parse(String(raw || "null")); } catch (_) { return null; }
  if (!result || result.code !== 0 || typeof result.stdout !== "string") return null;
  const lines = result.stdout.split("\n");
  const models: ModelInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*[* -]\s+([a-z0-9][a-z0-9._-]*)\b/i.exec(lines[i]);
    if (!m) continue;
    models.push({ id: m[1], displayName: m[1], group: "xAI" });
  }
  return models.length ? models : null;
}

function manifestModels(): ModelInfo[] {
  try {
    const m = JSON.parse(host.manifestJson() || "null") as GrokManifest | null;
    return Array.isArray(m && m.models) ? m!.models! : [];
  } catch (_) {
    return [];
  }
}

const plugin: PluginModule = {
  starterPromptText(prompt) {
    if (prompt === "no_starter" || prompt === "team_bootstrap") return undefined;
    if (prompt === "idle_wakeup") {
      return "You are a newly started agent. Wait for instructions from the user or your orchestration parent.";
    }
    return "Execute the assigned task.";
  },

  detectFromTitle(title: string): boolean {
    return TITLE_RE.test(String(title || ""));
  },

  detectFromOutput(text: string): boolean {
    const t = String(text || "");
    let hits = 0;
    for (let i = 0; i < OUTPUT_FINGERPRINTS.length; i++) {
      if (t.indexOf(OUTPUT_FINGERPRINTS[i]) !== -1) hits += 1;
    }
    return hits >= 2 || t.indexOf("Grok Build TUI") !== -1;
  },

  screenHasTui(screen: string): boolean {
    const lower = String(screen || "").toLowerCase();
    for (let i = 0; i < TUI_FRAGMENTS.length; i++) {
      if (lower.indexOf(TUI_FRAGMENTS[i]) !== -1) return true;
    }
    return false;
  },

  isOutputNoise(text: string): boolean {
    const trimmed = String(text || "").trim();
    if (!trimmed) return true;
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (
        c !== "─" && c !== "━" && c !== "═" && c !== "│" && c !== "┃" &&
        c !== "╭" && c !== "╮" && c !== "╯" && c !== "╰" &&
        c !== " " && c !== "\t" && c !== "\n" && c !== "\r"
      ) {
        return false;
      }
    }
    return true;
  },

  buildLaunchCommand(params: LaunchParams): string {
    const p = params || {};
    const parts = ["grok"];
    appendLaunchFlags(parts, p);
    const task = starterTask(p);
    if (task) parts.push(quote(task));
    return parts.join(" ");
  },

  buildResumeCommand(sessionId: string, skipPermissions?: boolean): string {
    return resumeCommand({ sessionId, skipPermissions });
  },

  buildResumeCommandWithContext(params: ResumeParams): string {
    return resumeCommand(params);
  },

  discoverModels(): ModelInfo[] {
    return discoverFromCache() || discoverFromCli() || manifestModels();
  },

  sessionExists(cwd: string, sessionId: string): boolean {
    return sessionExistsAt(cwd, sessionId);
  },

  sessionJsonlPath(cwd: string, sessionId: string): string | null {
    const dir = sessionDir(cwd, sessionId);
    if (!dir) return null;
    const path = joinPath(dir, "chat_history.jsonl");
    return host.fs.fileExists(path) ? path : null;
  },

  usesStructuredChat(): boolean {
    return true;
  },

  readStructuredChat(cwd: string, sessionId: string, cursor?: string | null): unknown {
    return readGrokChat(cwd, sessionId, cursor);
  },

  sessionCreatedMs(cwd: string, sessionId: string): number | null {
    return parseTimeMs(readSummary(cwd, sessionId)?.created_at);
  },

  detectSessionId(cwd: string, exclude?: string | string[], maxAgeMs?: number): string | null {
    const skip = new Set(Array.isArray(exclude) ? exclude : exclude ? [exclude] : []);
    const now = host.unixNowMs();
    const ids = listSessionIds(cwd);
    const viable: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (skip.has(id)) continue;
      if (typeof maxAgeMs === "number") {
        const created = parseTimeMs(readSummary(cwd, id)?.created_at);
        if (created == null || now - created > maxAgeMs) continue;
      }
      viable.push(id);
    }
    if (viable.length === 1) return viable[0];
    return null;
  },

  detectLaunchSession(evidence: LaunchSessionEvidence): LaunchSessionDetection | null {
    const home = grokHome();
    if (!home) return null;
    const rows = host.fs.readJson(joinPath(home, "active_sessions.json")) as ActiveSession[] | null;
    if (!Array.isArray(rows) || !evidence || !evidence.processes) return null;
    const pids: Record<number, true> = {};
    for (let i = 0; i < evidence.processes.length; i++) pids[evidence.processes[i].pid] = true;
    const matches: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (typeof row.pid === "number" && pids[row.pid] && typeof row.session_id === "string") {
        matches.push(row.session_id);
      }
    }
    if (matches.length === 1) return { sessionId: matches[0], source: "pid_registry" };
    const marker = String(evidence.launchMarker || "").trim();
    if (isUuid(marker) && sessionExistsAt(evidence.cwd, marker)) {
      return { sessionId: marker, source: "launch_marker" };
    }
    return null;
  },

  detectSessionModel(cwd: string, sessionId: string): string | null {
    const model = readSummary(cwd, sessionId)?.current_model_id;
    return model ? String(model) : null;
  },

  detectSessionReasoningEffort(cwd: string, sessionId: string): string | null {
    const effort = readSummary(cwd, sessionId)?.reasoning_effort;
    return effort ? String(effort) : null;
  },

  findSession(sessionId: string): unknown | null {
    const root = sessionsRoot();
    if (!root || !isUuid(sessionId) || !host.fs.fileExists(root)) return null;
    const cwdDirs = host.fs.readDir(root) || [];
    for (let i = 0; i < cwdDirs.length; i++) {
      if (!cwdDirs[i].isDir) continue;
      const summaryPath = joinPath(joinPath(cwdDirs[i].path, sessionId), "summary.json");
      const summary = host.fs.readJson(summaryPath) as GrokSummary | null;
      if (summary) return summary;
    }
    return null;
  },

  parseUsage(rawText: string, nowMs: number): unknown {
    const data = safeJson(String(rawText || "")) as {
      spendCents?: unknown;
      weeklyPct?: unknown;
      weeklyResetsAtMs?: unknown;
    } | null;
    if (!data) return null;
    const spendCents = typeof data.spendCents === "number" ? data.spendCents : null;
    const weeklyPct = typeof data.weeklyPct === "number"
      && Number.isFinite(data.weeklyPct)
      && data.weeklyPct >= 0
      && data.weeklyPct <= 100
      ? data.weeklyPct
      : null;
    const weeklyResetsAtMs = typeof data.weeklyResetsAtMs === "number"
      && Number.isFinite(data.weeklyResetsAtMs)
      ? data.weeklyResetsAtMs
      : null;
    const hasWeekly = weeklyPct !== null && weeklyResetsAtMs !== null;
    if (spendCents === null && !hasWeekly) return null;
    return {
      provider: "grok",
      account_id: null,
      captured_at_ms: nowMs,
      session_pct: null,
      session_resets_at_ms: null,
      weekly_pct: hasWeekly ? weeklyPct : null,
      weekly_resets_at_ms: hasWeekly ? weeklyResetsAtMs : null,
      spend_cents: spendCents,
      spend_limit_cents: null,
      spend_remaining_cents: null,
      spend_resets_at_ms: null,
      raw_text: String(rawText || ""),
    };
  },

  fetchUsage(nowMs: number): unknown {
    const ticks = latestSessionCostTicks();
    const weekly = fetchWeeklyUsage();
    const spendCents = ticks == null ? null : Math.round(ticks / 10_000_000);
    if (spendCents === null && weekly.weeklyPct === null) return null;
    return JSON.stringify({
      spendCents,
      weeklyPct: weekly.weeklyPct,
      weeklyResetsAtMs: weekly.weeklyResetsAtMs,
      fetchedAtMs: nowMs,
    });
  },
};

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function fetchWeeklyUsage(): { weeklyPct: number | null; weeklyResetsAtMs: number | null } {
  const empty = { weeklyPct: null, weeklyResetsAtMs: null };
  try {
    const credential = safeJson(String(host.credentialPublic(GROK_AUTH_CREDENTIAL) || "")) as {
      userId?: unknown;
    } | null;
    if (!credential || typeof credential.userId !== "string" || !credential.userId) return empty;

    const version = grokClientVersion();
    if (!version) return empty;
    const response = safeJson(host.fetch(JSON.stringify({
      url: GROK_BILLING_URL,
      method: "GET",
      timeoutMs: 15000,
      headers: {
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-grok-client-version": version,
        "x-grok-client-mode": "headless",
      },
      credential: {
        id: GROK_AUTH_CREDENTIAL,
        headers: {
          Authorization: "Bearer {accessToken}",
          "x-userid": "{userId}",
        },
      },
    }))) as { status?: unknown; body?: unknown } | null;
    if (!response || typeof response.status !== "number" || response.status < 200 || response.status >= 300) {
      return empty;
    }
    const body = safeJson(typeof response.body === "string" ? response.body : "") as {
      config?: {
        creditUsagePercent?: unknown;
        currentPeriod?: { type?: unknown; end?: unknown };
      };
    } | null;
    const config = body && body.config;
    const period = config && config.currentPeriod;
    const percentage = config && config.creditUsagePercent;
    const periodType = period && period.type;
    const resetsAtMs = period && typeof period.end === "string" ? parseTimeMs(period.end) : null;
    if (typeof percentage !== "number"
      || !Number.isFinite(percentage)
      || percentage < 0
      || percentage > 100
      || typeof periodType !== "string"
      || !periodType.toUpperCase().includes("WEEKLY")
      || resetsAtMs === null) return empty;
    return { weeklyPct: percentage, weeklyResetsAtMs: resetsAtMs };
  } catch (_) {
    return empty;
  }
}

function grokClientVersion(): string | null {
  if (cachedGrokClientVersion !== undefined) return cachedGrokClientVersion;
  try {
    const result = safeJson(host.exec(JSON.stringify({ bin: "grok", args: ["--version"], timeoutMs: 5000 }))) as {
      code?: unknown;
      stdout?: unknown;
    } | null;
    const stdout = result && typeof result.stdout === "string" ? result.stdout : "";
    const match = result && result.code === 0 ? stdout.match(/\bgrok\s+([0-9]+(?:\.[0-9]+){1,3})\b/i) : null;
    cachedGrokClientVersion = match ? match[1] : null;
  } catch (_) {
    cachedGrokClientVersion = null;
  }
  return cachedGrokClientVersion;
}

function latestSessionCostTicks(): number | null {
  const root = sessionsRoot();
  if (!root || !host.fs.fileExists(root)) return null;
  const cwdDirs = host.fs.readDir(root) || [];
  let bestTicks: number | null = null;
  let bestUpdated = "";
  for (let i = 0; i < cwdDirs.length; i++) {
    if (!cwdDirs[i].isDir) continue;
    const sessions = host.fs.readDir(cwdDirs[i].path) || [];
    for (let j = 0; j < sessions.length; j++) {
      if (!sessions[j].isDir || !isUuid(sessions[j].name)) continue;
      const usage = host.fs.readJson(joinPath(sessions[j].path, "usage.json")) as GrokUsageFile | null;
      if (!usage || !usage.session || typeof usage.session.costUsdTicks !== "number") continue;
      const updated = typeof (usage as { updatedAt?: string }).updatedAt === "string"
        ? String((usage as { updatedAt: string }).updatedAt)
        : "";
      if (bestTicks == null || updated > bestUpdated) {
        bestTicks = usage.session.costUsdTicks;
        bestUpdated = updated;
      }
    }
  }
  return bestTicks;
}

export default plugin;
