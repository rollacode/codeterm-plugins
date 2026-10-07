import type {
  LaunchParams,
  ModelInfo,
  ParsedPrompt,
  PluginModule,
  ResumeParams,
  SessionDeltaContext,
  TabStateSnapshot,
  TabStateClassification,
} from "@codeterm/plugin-sdk";
import {
  parseAiderHistoryDelta,
  utf8Length,
} from "./history";

import { modelLaunchArgs } from "./modelTuning";
import { hasAiderActivity } from "./activity";
import { readRelayEvidence } from "./replyRelay";
import type { Endpoint } from "./endpoints";
import { configuredEndpoints, endpointModels, launchEndpoint, selectedModel, PROVIDER_ENV } from "./endpoints";

const TITLE_RE = /aider/i;
const OUTPUT_MARKERS = ["aider", "Aider", "Aider Chat"];
const OUTPUT_SIGNALS = [
  "Model:",
  "Tokens:",
  "Repo Map:",
  "Run shell command",
  "Add file to the chat",
  "Create new file",
];
const TUI_FRAGMENTS = ["aider", "tokens sent"];
const PROMPT_QUESTION_RE = /^(Run shell commands?\?|Add file to the chat\?|Create new file[^\n]*\?|Add \.aider\* to \.gitignore \(recommended\)\?|Open documentation url for more info\?)\s*\(Y\)es\/\(N\)o(?:\/\(D\)on't ask again)?\s*(\[[^\]]*\])?\s*:?\s*$/;
const SHELL_COMMAND_QUESTION_RE = /^Run shell commands?\?\s*\(Y\)es\/\(N\)o\s*$/;
const GITIGNORE_QUESTION_RE = /^Add \.aider\* to \.gitignore \(recommended\)\?\s*\(Y\)es\/\(N\)o\s*(\[[^\]]*\])?\s*:?\s*$/;
const DOCS_URL_QUESTION_RE = /^Open documentation url for more info\?\s*\(Y\)es\/\(N\)o\/\(D\)on't ask again\s*(\[[^\]]*\])?\s*:?\s*$/;
const COMMAND_LINE_RE = /^[ \t]*[$>][ \t]+(\S[^\n]*)$/;
const MODE_PROMPT_RE = /^(?:[a-z]+)?>\s*$/;
const TAGGED_BLOCK_BASE = "domios";

function isMultiline(text: string): boolean {
  return /\r?\n/.test(String(text || ""));
}

function pickTaggedBlockTag(text: string): string {
  let tag = TAGGED_BLOCK_BASE;
  let suffix = 1;
  while (text.includes(`{${tag}`) || text.includes(`{/${tag}}`)) {
    tag = `${TAGGED_BLOCK_BASE}${suffix}`;
    suffix += 1;
  }
  return tag;
}

function wrapMultiline(text: string): string {
  const body = String(text || "");
  const tag = pickTaggedBlockTag(body);
  return `{${tag}\n${body}\n${tag}}`;
}

function deliverText(text: string): string {
  return isMultiline(text) ? wrapMultiline(text) : String(text || "");
}

function pluginSettings(): Record<string, unknown> {
  const raw = typeof host.settingsJson === "function" ? host.settingsJson() : null;
  if (!raw) return {};
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function withLaunchEnv(command: string, p: LaunchParams, endpoint: Endpoint, startupDir?: string): string {
  const platform = host.platform();
  const quote = (v: string) => host.shell.quoteFor(v, platform);
  // On Windows Domios launches agents in PowerShell; the host reports the
  // platform as "windows".
  const isPowerShell = platform === "windows";
  const exports: string[] = [];
  exports.push(isPowerShell
    ? `$env:DOMIOS_AIDER_ADAPTER=${quote(startupDir ? "1" : "0")};`
    : `export DOMIOS_AIDER_ADAPTER=${quote(startupDir ? "1" : "0")};`);
  if (startupDir) {
    exports.push(isPowerShell
      ? `$env:PYTHONPATH=(@(${quote(startupDir)}) + @($env:PYTHONPATH -split ';' | Where-Object { $_ })) -join ';';`
      : `export PYTHONPATH=${quote(startupDir)}\${PYTHONPATH:+":$PYTHONPATH"};`);
  }
  const nonce =
    (typeof p.launchMarker === "string" && p.launchMarker) ||
    (typeof p.sessionId === "string" && p.sessionId) ||
    null;
  if (nonce) {
    exports.push(
      isPowerShell
        ? `$env:DOMIOS_AIDER_SESSION_ID=${quote(nonce)};`
        : `export DOMIOS_AIDER_SESSION_ID=${quote(nonce)};`,
    );
  }
  const env = PROVIDER_ENV[endpoint.kind];
  if (endpoint.apiBase) {
    exports.push(isPowerShell
      ? `$env:${env.base}=${quote(endpoint.apiBase)};`
      : `export ${env.base}=${quote(endpoint.apiBase)};`);
  }
  // Only the secret's name enters the command. The value stays in the shell.
  exports.push(isPowerShell
    ? `$env:${env.key}=(codeterm mem secret get --name ${quote(endpoint.apiKeySecret)});`
    : `export ${env.key}="$(codeterm mem secret get --name ${quote(endpoint.apiKeySecret)})";`);
  if (exports.length === 0) return command;
  return `${exports.join(" ")} ${command}`;
}
/** Per-tab history folder: one file per launch, named by the binding nonce. */
function historyDir(cwd: string): string {
  return `${String(cwd || "")}/.aider/history`;
}

function historyFilePath(cwd: string, sessionId: string): string {
  return `${historyDir(cwd)}/${sessionId}.md`;
}

interface HistoryFileEntry {
  id: string;
  path: string;
  modifiedMs: number | null;
}

function historyFileEntries(cwd: string): HistoryFileEntry[] {
  const fs = (globalThis as { host?: { fs?: { readDir?: (p: string) => unknown[] } } }).host?.fs;
  if (!fs || typeof fs.readDir !== "function") return [];
  let entries: unknown[];
  try {
    entries = fs.readDir(historyDir(cwd)) as unknown[];
  } catch (_) {
    return [];
  }
  const out: HistoryFileEntry[] = [];
  for (const raw of entries) {
    const entry = raw as { name?: string; path?: string; modifiedMs?: number | null };
    if (!entry || typeof entry.name !== "string") continue;
    if (!entry.name.endsWith(".md")) continue;
    const id = entry.name.slice(0, -3);
    if (!id) continue;
    out.push({
      id,
      path: typeof entry.path === "string" && entry.path ? entry.path : historyFilePath(cwd, id),
      modifiedMs: typeof entry.modifiedMs === "number" ? entry.modifiedMs : null,
    });
  }
  return out;
}

function lastNonEmptyLine(text: string): string {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

function extractBannerModel(text: string): string | null {
  const match = String(text || "").match(/Model:\s*([^\s]+)/);
  return match ? match[1] : null;
}

function extractPromptedCommands(screen: string): string[] {
  const lines = String(screen || "").split(/\r?\n/);
  const commands: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(COMMAND_LINE_RE);
    if (match) commands.push(match[1].trim());
  }
  return commands;
}

function isCodetermOnlyCommandList(commands: string[]): boolean {
  return commands.length > 0 && commands.every((command) => command.startsWith("codeterm "));
}

function isStartupDialog(question: string): boolean {
  return GITIGNORE_QUESTION_RE.test(question) || DOCS_URL_QUESTION_RE.test(question);
}

/** A question is live only at the end of the current screen. Scrollback may
 * still contain answered questions while Aider has returned to its composer. */
function parsePromptWithContext(text: string): ParsedPrompt | null {
  const question = lastNonEmptyLine(String(text || ""));
  if (!PROMPT_QUESTION_RE.test(question)) return null;
  const options: [string, string][] = [["Yes", "1"], ["No", "2"]];
  return { question, options };
}

function parsePrompt(text: string): ParsedPrompt | null {
  const prompt = parsePromptWithContext(text);
  return prompt && !isStartupDialog(prompt.question) ? prompt : null;
}

function promptSafeChoice(prompt: ParsedPrompt | null | undefined, screen: string): string | null {
  if (!prompt || !prompt.question) return null;
  if (GITIGNORE_QUESTION_RE.test(prompt.question)) return "1";
  if (DOCS_URL_QUESTION_RE.test(prompt.question)) return "3";
  if (!SHELL_COMMAND_QUESTION_RE.test(prompt.question)) return null;
  return isCodetermOnlyCommandList(extractPromptedCommands(screen)) ? "1" : null;
}

const plugin: PluginModule = {
  starterPromptText(_prompt: "no_starter" | "assigned_task" | "idle_wakeup" | "team_bootstrap" | "startup_handshake"): string | undefined {
    // No native initial turn: core delivers the exact prepared payload to the
    // interactive composer after readiness, including any required starter.
    return undefined;
  },

  detectFromTitle(title: string): boolean {
    return TITLE_RE.test(String(title || ""));
  },

  detectFromOutput(text: string): boolean {
    const t = String(text || "");
    let hasMarker = false;
    for (let i = 0; i < OUTPUT_MARKERS.length; i++) {
      if (t.indexOf(OUTPUT_MARKERS[i]) !== -1) { hasMarker = true; break; }
    }
    if (!hasMarker) return false;
    for (let j = 0; j < OUTPUT_SIGNALS.length; j++) {
      if (t.indexOf(OUTPUT_SIGNALS[j]) !== -1) return true;
    }
    return false;
  },

  classifyTabState(snapshot: TabStateSnapshot): TabStateClassification | null {
    if (snapshot.agentType !== "aider") return null;
    const screen = String(snapshot.screenText || "");
    // SDK TabState has no Idle variant and exposes no cursor geometry.
    // Leave a settled composer to core's existing prompt-line cursor evidence.
    if (MODE_PROMPT_RE.test(lastNonEmptyLine(screen))) return null;
    const prompt = parsePrompt(screen);
    if (prompt) return { state: "clarifying_question", confidence: 1, data: { questions: [prompt.question] } };
    return hasAiderActivity(screen) ? { state: "working", confidence: 1 } : null;
  },

  screenHasTui(screen: string): boolean {
    const text = String(screen || "");
    const lower = text.toLowerCase();
    let hasFragment = false;
    for (let i = 0; i < TUI_FRAGMENTS.length; i++) {
      if (lower.indexOf(TUI_FRAGMENTS[i]) !== -1) { hasFragment = true; break; }
    }
    const prompt = lastNonEmptyLine(text);
    if (!MODE_PROMPT_RE.test(prompt)) return false;
    // A mode-prefixed prompt (e.g. "ask>") is itself an aider signal.
    if (/^[a-z]+>$/.test(prompt)) return true;
    // A bare prompt with no aider marker is not an aider screen.
    return hasFragment && /aider/i.test(text);
  },

  isOutputNoise(text: string): boolean {
    const trimmed = String(text || "").trim();
    if (!trimmed) return true;
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (
        c !== "─" && c !== "━" && c !== "═" && c !== "█" && c !== "▀" &&
        c !== " " && c !== "\t" && c !== "\n" && c !== "\r"
      ) {
        return false;
      }
    }
    return true;
  },

  hasEventMarkers(chunk: string): boolean {
    return parsePrompt(chunk) !== null || parsePromptWithContext(chunk) !== null;
  },

  detectEvents(text: string): string[] {
    return (parsePrompt(text) || parsePromptWithContext(text)) ? ["permission_request"] : [];
  },

  discoverModels(): ModelInfo[] {
    return endpointModels(configuredEndpoints(pluginSettings()));
  },

  modelGroupUsage(): [] {
    return [];
  },

  updatePromptSafeChoice(prompt: ParsedPrompt): string | null {
    return promptSafeChoice(prompt, prompt.question);
  },

  parsePrompt,


  buildPromptResponse(optionIndex: number, _screen?: string): string[] {
    const ENTER = "DQ==";
    const YES = "WQ==";
    const NO = "Tg==";
    const DONT_ASK = "RA==";
    if (optionIndex === 2) return [DONT_ASK, ENTER];
    return [optionIndex === 0 ? YES : NO, ENTER];
  },

  buildLaunchCommand(params: LaunchParams): string {
    const p = params || {};
    const platform = host.platform();
    const quote = (v: string) => host.shell.quoteFor(v, platform);
    const isPowerShell = platform === "windows";
    const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : ".";
    const historyDirPath = `${cwd}/.aider/history`;
    // The nonce must expand at run time, so the path is a double-quoted
    // string with the variable left unquoted; only the directory is escaped.
    const escapeDir = (value: string) =>
      isPowerShell
        ? value.replace(/`/g, "``").replace(/"/g, '`"')
        : value.replace(/(["\\$`])/g, "\\$1");
    const dirQuoted = escapeDir(historyDirPath);
    const chatHistoryPath = isPowerShell
      ? `"${dirQuoted}/$($env:DOMIOS_AIDER_SESSION_ID).md"`
      : `"${dirQuoted}/\${DOMIOS_AIDER_SESSION_ID}.md"`;
    const inputHistoryPath = isPowerShell
      ? `"${dirQuoted}/$($env:DOMIOS_AIDER_SESSION_ID).input"`
      : `"${dirQuoted}/\${DOMIOS_AIDER_SESSION_ID}.input"`;
    const settings = pluginSettings();
    const requestedModel = selectedModel(p);
    const selected = launchEndpoint(configuredEndpoints(settings), requestedModel);
    let startupDir: string | undefined;
    if (settings.plainMode !== true) {
      startupDir = host.fs.expandHome("~/.codeterm/plugins/aider/startup") || undefined;
      if (!startupDir) throw new Error("Domios Aider adapter is missing. Reinstall the plugin or explicitly set plainMode=true.");
    }
    // Preserve aider's normal entry point in the PTY process tree. Python's
    // startup hook installs the adapter before aider.main runs, in its own venv.
    const parts = ["aider", ...modelLaunchArgs(p.args || [], selected.entry).map(quote)];
    if (p.skipPermissions) parts.push("--yes-always");
    if (!requestedModel) parts.push("--model", quote(selected.model));
    parts.push("--no-auto-commits", "--no-pretty", "--no-fancy-input", "--no-show-model-warnings", "--chat-language", "English");
    // Aider does not load the agents.md convention itself. Keep repository
    // instructions in read-only context, without scanning the whole tree.
    const instructions = `${cwd.replace(/[\\/]+$/, "")}/AGENTS.md`;
    try {
      if (host.fs.readFileHead(instructions, 1) !== null) {
        parts.push("--read", quote(instructions));
      }
    } catch (_) {
      // Missing or unreadable instructions must not prevent starting Aider.
    }
    try {
      // expandHome maps ~/.codeterm to this instance's data directory, so
      // the bundled primer resolves inside the installed plugin on DEV too.
      const primer = host.fs.expandHome("~/.codeterm/plugins/aider/domios-primer.md");
      if (primer && host.fs.readFileHead(primer, 1) !== null) {
        parts.push("--read", quote(primer));
      }
    } catch (_) {
      // A missing bundled primer must not prevent starting Aider either.
    }
    const configPath =
      (typeof settings.configPath === "string" && settings.configPath) ||
      (typeof p.configPath === "string" && p.configPath) ||
      null;
    if (configPath) {
      parts.push("--config", quote(configPath));
    }
    // --message/--message-file exit after one answer in Aider 0.86.2.
    // The manifest selects core's confirmed PTY delivery for the initial task.
    const command = parts.join(" ");
    const historyFlags = [
      "--chat-history-file",
      chatHistoryPath,
      "--input-history-file",
      inputHistoryPath,
    ].join(" ");
    const mkdir = isPowerShell
      ? `New-Item -ItemType Directory -Force -Path ${quote(historyDirPath)} | Out-Null;`
      : `mkdir -p ${quote(historyDirPath)};`;
    return withLaunchEnv(`${mkdir} ${command} ${historyFlags}`, p, selected.endpoint, startupDir);
  },


  buildResumeCommand(_sessionId: string, _skipPermissions?: boolean): string {
    return this.buildLaunchCommand({});
  },

  buildResumeCommandWithContext(params: ResumeParams): string {
    return this.buildLaunchCommand({ ...params, task: params.systemPrompt || undefined });
  },

  launchOnboardingResponse(screen: string): { frameKey: string; step: string } | null {
    const prompt = parsePromptWithContext(String(screen || ""));
    if (!prompt) return null;
    const choice = promptSafeChoice(prompt, String(screen || ""));
    if (!choice) return null;
    const keys = this.buildPromptResponse!(Number(choice) - 1, String(screen || ""));
    return { frameKey: prompt.question, step: keys[0] };
  },

  launchOnboardingSafeChoice(screen: string): string | null {
    const prompt = parsePromptWithContext(String(screen || ""));
    return prompt ? promptSafeChoice(prompt, String(screen || "")) : null;
  },

  chatPreprocess(ctx: { provider?: string | null; text: string }): { text: string } | null {
    if (ctx?.provider !== "aider") return null;
    const text = String(ctx?.text || "");
    const delivered = deliverText(text);
    return delivered === text ? null : { text: delivered };
  },

  detectSessionId(cwd: string, exclude?: string[] | string, maxAgeMs?: number): string | null {
    const excluded = Array.isArray(exclude) ? exclude : exclude ? [exclude] : [];
    const limit = typeof maxAgeMs === "number" && maxAgeMs > 0 ? maxAgeMs : 0;
    const now = Date.now();
    let newest: HistoryFileEntry | null = null;
    for (const entry of historyFileEntries(cwd)) {
      if (excluded.indexOf(entry.id) !== -1) continue;
      if (limit > 0) {
        if (entry.modifiedMs === null) continue;
        if (now - entry.modifiedMs > limit) continue;
      }
      if (!newest) {
        newest = entry;
        continue;
      }
      const a = typeof entry.modifiedMs === "number" ? entry.modifiedMs : -1;
      const b = typeof newest.modifiedMs === "number" ? newest.modifiedMs : -1;
      if (a > b) newest = entry;
    }
    return newest ? newest.id : null;
  },

  detectLaunchSession(evidence: {
    cwd: string;
    launchMarker?: string | null;
    launchedAtMs: number;
    processes?: unknown[];
  }): { sessionId: string; source: "pid_registry" | "launch_marker" } | null {
    const marker = evidence && typeof evidence.launchMarker === "string" ? evidence.launchMarker : "";
    if (!marker) return null;
    const cwd = evidence && typeof evidence.cwd === "string" ? evidence.cwd : "";
    if (!cwd) return null;
    return historyFileEntries(cwd).some((entry) => entry.id === marker)
      ? { sessionId: marker, source: "launch_marker" }
      : null;
  },

  enumerateSessions(): unknown[] {
    return [];
  },

  findSession(_sessionId: string): unknown | null {
    return null;
  },

  sessionExists(cwd: string, sessionId: string): boolean {
    if (!sessionId) return false;
    return historyFileEntries(cwd).some((entry) => entry.id === sessionId);
  },

  sessionCreatedMs(_cwd: string, _sessionId: string): number | null {
    return null;
  },

  detectActiveSession(_cwd: string, _currentSid?: string): string | null {
    return null;
  },

  detectSessionModel(_cwd: string, _sessionId: string): string | null {
    return null;
  },

  usageSources(_cwd: string, _sessionId: string): { path: string; sessionId?: string }[] {
    return [];
  },

  sessionFilePath(cwd: string, sessionId: string): string | null {
    if (!cwd || !sessionId) return null;
    return historyFilePath(cwd, sessionId);
  },

  sessionJsonlPath(cwd: string, sessionId: string): string | null {
    if (!cwd || !sessionId) return null;
    return historyFilePath(cwd, sessionId);
  },

  readReplyRelayTurn(cwd: string, sessionId: string, afterOffset: number) {
    if (!cwd || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
    const path = historyFilePath(cwd, sessionId);
    try {
      return readRelayEvidence(host.fs.readFile(path), host.fs.readFile(`${path}.domios-turns.jsonl`), sessionId, afterOffset);
    } catch (_) {
      return { unavailable: true as const, reason: "Domios Aider completion evidence is unreadable." };
    }
  },

  parseSessionDelta(chunk: string, context?: SessionDeltaContext): unknown {
    const text = String(chunk || "");
    if (!context || context.from_offset === 0) return parseAiderHistoryDelta(text);
    // Evidence, backfill and live tail readers can call independently.
    const prefix = host.fs.readFileHead(context.session_key, context.from_offset + utf8Length(text));
    if (prefix === null) return { messages: [] };
    return parseAiderHistoryDelta(prefix, context.from_offset);
  },

  checkIntegration(): unknown {
    return {
      config_file_exists: false,
      plugin_file_exists: false,
      plugin_file_owned: false,
      plugin_file_current: false,
      plugin_installed: false,
    };
  },

  installIntegration(_apiPort: number, _options: { consent: boolean }): unknown {
    return { ok: false, error: "aider has no integration to install" };
  },

  uninstallIntegration(): unknown {
    return { ok: true };
  },

  ensureIntegrationOnStartup(_apiPort: number): unknown {
    return this.checkIntegration!();
  },
};

export default plugin;
export {
  deliverText,
  extractBannerModel,
  lastNonEmptyLine,
  MODE_PROMPT_RE,
  pickTaggedBlockTag,
  promptSafeChoice,
  parsePromptWithContext,
  wrapMultiline,
};
