import { dataFilePath } from "../router/datafiles";
import { OPENCODE_VERSION } from "./config";

export const ENGINE_IDLE_SECS = 1800;
const START_TIMEOUT_MS = 45000;
const HEARTBEAT_EVERY_MS = 30000;
const HEALTH_TIMEOUT_MS = 2000;
const PASSWORD_SECRET = "engine_server_password";
const RECORD_FILE = "engine/engine.json";

// Params arrive by env so nothing secret or path-shaped is spliced into the command text.
// The loop stops opencode when the plugin writes this launch's token to RE_STOP, or after RE_IDLE seconds without a heartbeat.
export const LAUNCH_SCRIPT = [
  'oc=$(command -v opencode 2>/dev/null)',
  'if [ -z "$oc" ]; then echo "router-engine: opencode not found on PATH"; exit 127; fi',
  'echo "router-engine: launching $("$oc" --version 2>/dev/null)"',
  '"$oc" serve --hostname 127.0.0.1 --port 0 --log-level WARN --pure &',
  'pid=$!',
  'while kill -0 "$pid" 2>/dev/null; do',
  '  sleep 3',
  '  if [ "$(cat "$RE_STOP" 2>/dev/null)" = "$RE_TOKEN" ]; then echo "router-engine: stop requested"; break; fi',
  '  hb=$(cat "$RE_HEARTBEAT" 2>/dev/null); case "$hb" in ""|*[!0-9]*) hb=0;; esac',
  '  if [ $(( $(date +%s) - hb )) -gt "$RE_IDLE" ]; then echo "router-engine: idle, stopping"; break; fi',
  'done',
  'kill "$pid" 2>/dev/null',
  'wait "$pid" 2>/dev/null',
  'echo "router-engine: stopped"',
].join("\n");

export interface EngineRecord {
  port: number;
  token: string;
  fingerprint: string;
  logFile: string;
  startedAtMs: number;
  version?: string;
}

export interface EngineWanted {
  configJson: string;
  fingerprint: string;
  keyEnv: Record<string, string>;
}

export type EnginePhase = "down" | "starting" | "up" | "failed";

interface EngineState {
  phase: EnginePhase;
  record: EngineRecord | null;
  password: string | null;
  error: string | null;
  startedAt: number;
  lastHeartbeat: number;
  restartWanted: boolean;
}

const state: EngineState = { phase: "down", record: null, password: null, error: null, startedAt: 0, lastHeartbeat: 0, restartWanted: false };
let wanted: EngineWanted | null = null;

export function resetEngineForTests(): void {
  state.phase = "down";
  state.record = null;
  state.password = null;
  state.error = null;
  state.startedAt = 0;
  state.lastHeartbeat = 0;
  state.restartWanted = false;
  wanted = null;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function slashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function enginePath(name: string): string | null {
  const p = dataFilePath(`engine/${name}`);
  return p ? slashes(p) : null;
}

function writeText(path: string, text: string): boolean {
  try {
    const slash = path.lastIndexOf("/");
    if (slash > 0 && typeof host.makeDirs === "function") host.makeDirs(path.slice(0, slash));
    return host.writeFile(path, text);
  } catch {
    return false;
  }
}

function readText(path: string | null): string {
  if (!path) return "";
  try {
    return host.readFile(path) || "";
  } catch {
    return "";
  }
}

function randomToken(len: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i += 1) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Ascii(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i) & 0xff;
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) & 0xff : -1;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) & 0xff : -1;
    out += B64.charAt(a >> 2);
    out += B64.charAt(((a & 3) << 4) | (b < 0 ? 0 : b >> 4));
    out += b < 0 ? "=" : B64.charAt(((b & 15) << 2) | (c < 0 ? 0 : c >> 6));
    out += c < 0 ? "=" : B64.charAt(c & 63);
  }
  return out;
}

/** The server password lives in the plugin secret bucket; without one it stays in memory and a reload restarts the engine. */
function password(): string {
  if (state.password) return state.password;
  let stored: string | null = null;
  try {
    stored = host.secretGet(PASSWORD_SECRET);
  } catch {
    stored = null;
  }
  if (stored && stored.length >= 24) {
    state.password = stored;
    return stored;
  }
  const fresh = randomToken(40);
  try {
    host.secretSet(PASSWORD_SECRET, fresh);
  } catch {
    // Memory-only password: still authenticates this VM's requests.
  }
  state.password = fresh;
  return fresh;
}

export function authHeader(): string {
  return `Basic ${base64Ascii(`opencode:${password()}`)}`;
}

export function engineBase(): string | null {
  return state.phase === "up" && state.record ? `http://127.0.0.1:${state.record.port}` : null;
}

export interface HttpResult {
  status: number;
  body: string;
  error?: string;
}

export function engineRequest(method: string, path: string, body?: unknown, timeoutMs = 15000): HttpResult {
  const base = state.record ? `http://127.0.0.1:${state.record.port}` : "";
  if (!base) return { status: 0, body: "", error: "engine is not running" };
  const headers: Record<string, string> = { authorization: authHeader() };
  if (body !== undefined) headers["content-type"] = "application/json";
  const raw = host.fetch(JSON.stringify({ url: base + path, method, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs }));
  const res = parseJson<{ status?: number; body?: string; error?: string }>(raw, { error: "fetch returned non-JSON" });
  return { status: typeof res.status === "number" ? res.status : 0, body: typeof res.body === "string" ? res.body : "", error: res.error };
}

function readRecord(): EngineRecord | null {
  const rec = parseJson<EngineRecord | null>(readText(enginePath("engine.json")), null);
  return rec && typeof rec.port === "number" && typeof rec.token === "string" ? rec : null;
}

function writeRecord(rec: EngineRecord): void {
  const path = dataFilePath(RECORD_FILE);
  if (path) writeText(slashes(path), JSON.stringify(rec));
}

export function heartbeat(force = false): void {
  const now = Date.now();
  if (!force && now - state.lastHeartbeat < HEARTBEAT_EVERY_MS) return;
  state.lastHeartbeat = now;
  const path = enginePath("heartbeat");
  if (path) writeText(path, String(Math.floor(now / 1000)));
}

function requestStop(rec: EngineRecord | null): void {
  const path = enginePath("stop");
  if (rec && path) writeText(path, rec.token);
}

function healthy(port: number): { ok: boolean; version?: string } {
  const raw = host.fetch(
    JSON.stringify({ url: `http://127.0.0.1:${port}/global/health`, method: "GET", headers: { authorization: authHeader() }, timeoutMs: HEALTH_TIMEOUT_MS }),
  );
  const res = parseJson<{ status?: number; body?: string }>(raw, {});
  if (res.status !== 200) return { ok: false };
  const body = parseJson<{ healthy?: boolean; version?: string }>(res.body, {});
  return body.healthy === true ? { ok: true, version: body.version } : { ok: false };
}

/** Port from the `opencode server listening on http://127.0.0.1:PORT` line, or the launcher's own failure line. */
export function scanLaunchLog(log: string): { port?: number; failure?: string } {
  const listening = /listening on https?:\/\/127\.0\.0\.1:(\d+)/.exec(log);
  if (listening) return { port: Number(listening[1]) };
  const fail = /router-engine: (opencode not found on PATH|stopped|idle, stopping)/.exec(log);
  return fail ? { failure: fail[1] } : {};
}

function launch(w: EngineWanted): void {
  const token = randomToken(16);
  const logFile = enginePath(`engine-${token}.log`);
  const stopFile = enginePath("stop");
  const hbFile = enginePath("heartbeat");
  const xdg = enginePath("xdg");
  if (!logFile || !stopFile || !hbFile || !xdg) {
    state.phase = "failed";
    state.error = "no plugin data directory for the engine";
    return;
  }
  writeText(logFile, "");
  heartbeat(true);
  const env: Record<string, string> = {
    ...w.keyEnv,
    OPENCODE_CONFIG_CONTENT: w.configJson,
    OPENCODE_SERVER_PASSWORD: password(),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    XDG_DATA_HOME: `${xdg}/data`,
    XDG_CONFIG_HOME: `${xdg}/config`,
    XDG_STATE_HOME: `${xdg}/state`,
    XDG_CACHE_HOME: `${xdg}/cache`,
    RE_TOKEN: token,
    RE_STOP: stopFile,
    RE_HEARTBEAT: hbFile,
    RE_IDLE: String(ENGINE_IDLE_SECS),
  };
  const raw = host.exec(JSON.stringify({ bin: "sh", args: ["-lc", LAUNCH_SCRIPT], env, detach: true, logFile }));
  const res = parseJson<{ error?: string }>(raw, { error: "host.exec returned non-JSON" });
  if (res.error) {
    state.phase = "failed";
    state.error = `could not start opencode: ${res.error}`;
    return;
  }
  state.record = { port: 0, token, fingerprint: w.fingerprint, logFile, startedAtMs: Date.now() };
  state.phase = "starting";
  state.startedAt = Date.now();
  state.error = null;
}

/** Desired engine config; a different fingerprint restarts the engine once no turn is running. */
export function setWanted(w: EngineWanted): void {
  wanted = w;
  if (state.record && state.record.fingerprint !== w.fingerprint) state.restartWanted = true;
}

export function engineError(): string | null {
  return state.error;
}

export function engineVersionNote(): string | null {
  const v = state.record && state.record.version;
  return v && v !== OPENCODE_VERSION ? `OpenCode ${v} is running; the Router engine was verified against ${OPENCODE_VERSION}.` : null;
}

/** Advances the engine one step without blocking: adopt a running server, launch one, or wait for readiness. */
export function ensureEngine(anyTurnRunning: boolean): EnginePhase {
  if (!wanted) return state.phase;
  heartbeat();
  if (state.phase === "up" && state.restartWanted && !anyTurnRunning) {
    requestStop(state.record);
    state.record = null;
    state.phase = "down";
    state.restartWanted = false;
  }
  if (state.phase === "down") {
    const prior = readRecord();
    if (prior && prior.port && prior.fingerprint === wanted.fingerprint) {
      const h = healthy(prior.port);
      if (h.ok) {
        state.record = { ...prior, version: h.version };
        state.phase = "up";
        return state.phase;
      }
    }
    if (prior) requestStop(prior);
    launch(wanted);
    return state.phase;
  }
  if (state.phase === "starting" && state.record) {
    const scan = scanLaunchLog(readText(state.record.logFile));
    if (scan.failure) {
      state.phase = "failed";
      state.error = scan.failure === "opencode not found on PATH"
        ? `opencode not found on PATH; install it with \`npm i -g opencode-ai@${OPENCODE_VERSION}\``
        : `opencode exited during startup (${scan.failure})`;
      return state.phase;
    }
    if (scan.port) {
      state.record.port = scan.port;
      const h = healthy(scan.port);
      if (h.ok) {
        state.record.version = h.version;
        state.phase = "up";
        writeRecord(state.record);
        return state.phase;
      }
    }
    if (Date.now() - state.startedAt > START_TIMEOUT_MS) {
      requestStop(state.record);
      state.phase = "failed";
      state.error = `opencode did not become ready within ${START_TIMEOUT_MS / 1000}s`;
    }
  }
  return state.phase;
}

/** A failed engine retries on the next user turn instead of staying dead. */
export function retryEngine(): void {
  if (state.phase === "failed") {
    state.phase = "down";
    state.error = null;
    state.record = null;
  }
}

/** Marks the engine as gone after a refused connection so the next step relaunches it. */
export function engineLost(): void {
  if (state.phase === "up") {
    state.phase = "down";
    state.record = null;
  }
}
