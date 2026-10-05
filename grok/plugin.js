"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// grok/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);
var TITLE_RE = /\bgrok\b/i;
var OUTPUT_FINGERPRINTS = [
  "Grok Build TUI",
  "You are logged in with grok.com",
  "Compactions remaining"
];
var TUI_FRAGMENTS = ["grok build tui", "compactions remaining"];
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var ALWAYS_APPROVE = "--always-approve";
var BYPASS_PERMISSIONS = ["--permission-mode", "bypassPermissions"];
var GROK_AUTH_CREDENTIAL = "grokAuth";
var GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
var cachedGrokClientVersion;
function quote(value) {
  return host.shell.quoteFor(String(value || ""), host.platform());
}
function hasFlag(parts, flag) {
  for (let i = 0; i < parts.length; i++) if (parts[i] === flag) return true;
  return false;
}
function grokHome() {
  const home = host.homeDir();
  if (!home) return null;
  const sep = host.platform() === "windows" ? "\\" : "/";
  return home.replace(/[/\\]+$/, "") + sep + ".grok";
}
function joinPath(left, right) {
  const sep = host.platform() === "windows" ? "\\" : "/";
  return left.replace(/[/\\]+$/, "") + sep + right;
}
function cwdKey(cwd) {
  const native = host.path && host.path.toNative ? host.path.toNative(cwd) : cwd;
  return encodeURIComponent(native);
}
function sessionsRoot() {
  const home = grokHome();
  return home ? joinPath(home, "sessions") : null;
}
function sessionDir(cwd, sessionId) {
  const root = sessionsRoot();
  if (!root || !cwd || !sessionId) return null;
  return joinPath(joinPath(root, cwdKey(cwd)), sessionId);
}
function sessionExistsAt(cwd, sessionId) {
  const dir = sessionDir(cwd, sessionId);
  return !!dir && host.fs.fileExists(joinPath(dir, "summary.json"));
}
function readSummary(cwd, sessionId) {
  const dir = sessionDir(cwd, sessionId);
  if (!dir) return null;
  return host.fs.readJson(joinPath(dir, "summary.json"));
}
function isUuid(value) {
  return UUID_RE.test(String(value || ""));
}
function parseTimeMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
function appendLaunchFlags(parts, params) {
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
function resumeCommand(params) {
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
function starterTask(params) {
  const handshake = params.starterPrompt === "startup_handshake" ? String(params.starterPromptText || "").trim() : "";
  return [handshake, params.task].filter(Boolean).join("\n\n");
}
function updateText(update) {
  if (!update) return "";
  const content = update.content;
  if (content && typeof content === "object" && typeof content.text === "string") {
    return String(content.text).trim();
  }
  return "";
}
function grokUpdateToChat(row, seq) {
  const params = row.params && typeof row.params === "object" ? row.params : null;
  const update = params && params.update && typeof params.update === "object" ? params.update : null;
  const kind = update ? String(update.sessionUpdate || "") : "";
  let type = "";
  if (kind === "user_message_chunk") type = "user";
  else if (kind === "agent_thought_chunk") type = "thinking";
  else if (kind === "agent_message_chunk") type = "assistant";
  else return null;
  const content = updateText(update);
  if (!content) return null;
  const meta = row._meta && typeof row._meta === "object" ? row._meta : {};
  const id = typeof meta.eventId === "string" && meta.eventId ? String(meta.eventId) : `grok-${seq}`;
  let tsMs = typeof meta.agentTimestampMs === "number" ? meta.agentTimestampMs : 0;
  if (!tsMs && typeof row.timestamp === "number") tsMs = row.timestamp > 1e12 ? row.timestamp : row.timestamp * 1e3;
  return { id, type, content, timestamp: String(tsMs || seq), seq };
}
function readGrokChat(cwd, sessionId, cursor) {
  const path = sessionDir(cwd, sessionId);
  const empty = { messages: [], cursor: cursor && /^\d+$/.test(cursor) ? cursor : "0" };
  if (!path) return empty;
  const file = joinPath(path, "updates.jsonl");
  const raw = host.fs.readFile(file);
  if (!raw) return empty;
  const start = cursor && /^\d+$/.test(cursor) ? parseInt(cursor, 10) : 0;
  const lines = String(raw).split("\n");
  const messages = [];
  let next = start;
  for (let i = start; i < lines.length; i++) {
    next = i + 1;
    const line = lines[i].trim();
    if (!line) continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const msg = grokUpdateToChat(row, i);
    if (msg) messages.push(msg);
  }
  return { messages, cursor: String(next) };
}
function listSessionIds(cwd) {
  const root = sessionsRoot();
  if (!root || !cwd) return [];
  const dir = joinPath(root, cwdKey(cwd));
  if (!host.fs.fileExists(dir)) return [];
  const entries = host.fs.readDir(dir) || [];
  const ids = [];
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i].name;
    if (!entries[i].isDir || !isUuid(name)) continue;
    if (host.fs.fileExists(joinPath(joinPath(dir, name), "summary.json"))) ids.push(name);
  }
  return ids;
}
function discoverFromCache() {
  const home = grokHome();
  if (!home) return null;
  const cache = host.fs.readJson(joinPath(home, "models_cache.json"));
  if (!cache || !cache.models) return null;
  const models = [];
  const ids = Object.keys(cache.models);
  for (let i = 0; i < ids.length; i++) {
    const info = cache.models[ids[i]] && cache.models[ids[i]].info;
    if (!info || info.hidden) continue;
    const id = String(info.id || ids[i]);
    models.push({
      id,
      displayName: String(info.name || id),
      description: info.description ? String(info.description) : void 0,
      group: "xAI"
    });
  }
  return models.length ? models : null;
}
function discoverFromCli() {
  const raw = host.exec(JSON.stringify({ bin: "grok", args: ["models"], timeoutMs: 5e3 }));
  let result = null;
  try {
    result = JSON.parse(String(raw || "null"));
  } catch (_) {
    return null;
  }
  if (!result || result.code !== 0 || typeof result.stdout !== "string") return null;
  const lines = result.stdout.split("\n");
  const models = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*[* -]\s+([a-z0-9][a-z0-9._-]*)\b/i.exec(lines[i]);
    if (!m) continue;
    models.push({ id: m[1], displayName: m[1], group: "xAI" });
  }
  return models.length ? models : null;
}
function manifestModels() {
  try {
    const m = JSON.parse(host.manifestJson() || "null");
    return Array.isArray(m && m.models) ? m.models : [];
  } catch (_) {
    return [];
  }
}
var plugin = {
  starterPromptText(prompt) {
    if (prompt === "no_starter" || prompt === "team_bootstrap") return void 0;
    if (prompt === "idle_wakeup") {
      return "You are a newly started agent. Wait for instructions from the user or your orchestration parent.";
    }
    return "Execute the assigned task.";
  },
  detectFromTitle(title) {
    return TITLE_RE.test(String(title || ""));
  },
  detectFromOutput(text) {
    const t = String(text || "");
    let hits = 0;
    for (let i = 0; i < OUTPUT_FINGERPRINTS.length; i++) {
      if (t.indexOf(OUTPUT_FINGERPRINTS[i]) !== -1) hits += 1;
    }
    return hits >= 2 || t.indexOf("Grok Build TUI") !== -1;
  },
  screenHasTui(screen) {
    const lower = String(screen || "").toLowerCase();
    for (let i = 0; i < TUI_FRAGMENTS.length; i++) {
      if (lower.indexOf(TUI_FRAGMENTS[i]) !== -1) return true;
    }
    return false;
  },
  isOutputNoise(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return true;
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (c !== "\u2500" && c !== "\u2501" && c !== "\u2550" && c !== "\u2502" && c !== "\u2503" && c !== "\u256D" && c !== "\u256E" && c !== "\u256F" && c !== "\u2570" && c !== " " && c !== "	" && c !== "\n" && c !== "\r") {
        return false;
      }
    }
    return true;
  },
  buildLaunchCommand(params) {
    const p = params || {};
    const parts = ["grok"];
    appendLaunchFlags(parts, p);
    const task = starterTask(p);
    if (task) parts.push(quote(task));
    return parts.join(" ");
  },
  buildResumeCommand(sessionId, skipPermissions) {
    return resumeCommand({ sessionId, skipPermissions });
  },
  buildResumeCommandWithContext(params) {
    return resumeCommand(params);
  },
  discoverModels() {
    return discoverFromCache() || discoverFromCli() || manifestModels();
  },
  sessionExists(cwd, sessionId) {
    return sessionExistsAt(cwd, sessionId);
  },
  sessionJsonlPath(cwd, sessionId) {
    const dir = sessionDir(cwd, sessionId);
    if (!dir) return null;
    const path = joinPath(dir, "chat_history.jsonl");
    return host.fs.fileExists(path) ? path : null;
  },
  usesStructuredChat() {
    return true;
  },
  readStructuredChat(cwd, sessionId, cursor) {
    return readGrokChat(cwd, sessionId, cursor);
  },
  sessionCreatedMs(cwd, sessionId) {
    return parseTimeMs(readSummary(cwd, sessionId)?.created_at);
  },
  detectSessionId(cwd, exclude, maxAgeMs) {
    const skip = new Set(Array.isArray(exclude) ? exclude : exclude ? [exclude] : []);
    const now = host.unixNowMs();
    const ids = listSessionIds(cwd);
    const viable = [];
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
  detectLaunchSession(evidence) {
    const home = grokHome();
    if (!home) return null;
    const rows = host.fs.readJson(joinPath(home, "active_sessions.json"));
    if (!Array.isArray(rows) || !evidence || !evidence.processes) return null;
    const pids = {};
    for (let i = 0; i < evidence.processes.length; i++) pids[evidence.processes[i].pid] = true;
    const matches = [];
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
  detectSessionModel(cwd, sessionId) {
    const model = readSummary(cwd, sessionId)?.current_model_id;
    return model ? String(model) : null;
  },
  detectSessionReasoningEffort(cwd, sessionId) {
    const effort = readSummary(cwd, sessionId)?.reasoning_effort;
    return effort ? String(effort) : null;
  },
  findSession(sessionId) {
    const root = sessionsRoot();
    if (!root || !isUuid(sessionId) || !host.fs.fileExists(root)) return null;
    const cwdDirs = host.fs.readDir(root) || [];
    for (let i = 0; i < cwdDirs.length; i++) {
      if (!cwdDirs[i].isDir) continue;
      const summaryPath = joinPath(joinPath(cwdDirs[i].path, sessionId), "summary.json");
      const summary = host.fs.readJson(summaryPath);
      if (summary) return summary;
    }
    return null;
  },
  parseUsage(rawText, nowMs) {
    const data = safeJson(String(rawText || ""));
    if (!data) return null;
    const spendCents = typeof data.spendCents === "number" ? data.spendCents : null;
    const weeklyPct = typeof data.weeklyPct === "number" && Number.isFinite(data.weeklyPct) && data.weeklyPct >= 0 && data.weeklyPct <= 100 ? data.weeklyPct : null;
    const weeklyResetsAtMs = typeof data.weeklyResetsAtMs === "number" && Number.isFinite(data.weeklyResetsAtMs) ? data.weeklyResetsAtMs : null;
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
      raw_text: String(rawText || "")
    };
  },
  fetchUsage(nowMs) {
    const ticks = latestSessionCostTicks();
    const weekly = fetchWeeklyUsage();
    const spendCents = ticks == null ? null : Math.round(ticks / 1e7);
    if (spendCents === null && weekly.weeklyPct === null) return null;
    return JSON.stringify({
      spendCents,
      weeklyPct: weekly.weeklyPct,
      weeklyResetsAtMs: weekly.weeklyResetsAtMs,
      fetchedAtMs: nowMs
    });
  }
};
function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}
function fetchWeeklyUsage() {
  const empty = { weeklyPct: null, weeklyResetsAtMs: null };
  try {
    const credential = safeJson(String(host.credentialPublic(GROK_AUTH_CREDENTIAL) || ""));
    if (!credential || typeof credential.userId !== "string" || !credential.userId) return empty;
    const version = grokClientVersion();
    if (!version) return empty;
    const response = safeJson(host.fetch(JSON.stringify({
      url: GROK_BILLING_URL,
      method: "GET",
      timeoutMs: 15e3,
      headers: {
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-grok-client-version": version,
        "x-grok-client-mode": "headless"
      },
      credential: {
        id: GROK_AUTH_CREDENTIAL,
        headers: {
          Authorization: "Bearer {accessToken}",
          "x-userid": "{userId}"
        }
      }
    })));
    if (!response || typeof response.status !== "number" || response.status < 200 || response.status >= 300) {
      return empty;
    }
    const body = safeJson(typeof response.body === "string" ? response.body : "");
    const config = body && body.config;
    const period = config && config.currentPeriod;
    const percentage = config && config.creditUsagePercent;
    const periodType = period && period.type;
    const resetsAtMs = period && typeof period.end === "string" ? parseTimeMs(period.end) : null;
    if (typeof percentage !== "number" || !Number.isFinite(percentage) || percentage < 0 || percentage > 100 || typeof periodType !== "string" || !periodType.toUpperCase().includes("WEEKLY") || resetsAtMs === null) return empty;
    return { weeklyPct: percentage, weeklyResetsAtMs: resetsAtMs };
  } catch (_) {
    return empty;
  }
}
function grokClientVersion() {
  if (cachedGrokClientVersion !== void 0) return cachedGrokClientVersion;
  try {
    const result = safeJson(host.exec(JSON.stringify({ bin: "grok", args: ["--version"], timeoutMs: 5e3 })));
    const stdout = result && typeof result.stdout === "string" ? result.stdout : "";
    const match = result && result.code === 0 ? stdout.match(/\bgrok\s+([0-9]+(?:\.[0-9]+){1,3})\b/i) : null;
    cachedGrokClientVersion = match ? match[1] : null;
  } catch (_) {
    cachedGrokClientVersion = null;
  }
  return cachedGrokClientVersion;
}
function latestSessionCostTicks() {
  const root = sessionsRoot();
  if (!root || !host.fs.fileExists(root)) return null;
  const cwdDirs = host.fs.readDir(root) || [];
  let bestTicks = null;
  let bestUpdated = "";
  for (let i = 0; i < cwdDirs.length; i++) {
    if (!cwdDirs[i].isDir) continue;
    const sessions = host.fs.readDir(cwdDirs[i].path) || [];
    for (let j = 0; j < sessions.length; j++) {
      if (!sessions[j].isDir || !isUuid(sessions[j].name)) continue;
      const usage = host.fs.readJson(joinPath(sessions[j].path, "usage.json"));
      if (!usage || !usage.session || typeof usage.session.costUsdTicks !== "number") continue;
      const updated = typeof usage.updatedAt === "string" ? String(usage.updatedAt) : "";
      if (bestTicks == null || updated > bestUpdated) {
        bestTicks = usage.session.costUsdTicks;
        bestUpdated = updated;
      }
    }
  }
  return bestTicks;
}
var plugin_default = plugin;
