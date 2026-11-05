import { SERVE_PROCESS } from "./serve-process";
import { defineProviderIo, ioValue, type HostIoSteps } from "@codeterm/plugin-sdk";
import { METADATA_PROCESS } from "./metadata-process";
// Bitwarden secret-backend plugin (capability: secret_backend).
// Authored in TypeScript against @codeterm/plugin-sdk and compiled to a
// QuickJS-compatible plugin.js by scripts/build-plugin.mjs.
//
// Ports the native `secrets/bitwarden/` Rust impl to TS-on-QuickJS. Talks to the
// `bw` CLI via host.io.exec (always --nointeraction --response; secrets via env/stdin,
// never argv). Session/master-password persist in the per-plugin secret bucket
// (host.secret*). Returns {ok}/{error:{kind,...}} envelopes the JsSecretBackend
// adapter maps onto the core SecretStore trait; secretStatus returns a bare
// StoreStatus. Behaviour mirrors the native reference exactly (parity-gated).
import type {
  GlanceView,
  PluginModule,
  SecretCreds,
  SecretError,
  SecretListFilter,
  SecretSaveRequest,
  SecretStatus,
  ViewNode,
} from "@codeterm/plugin-sdk";

const DEFAULT_SERVER = "https://vault.bitwarden.com";
const K_SESSION = "session";
const K_MASTER = "master_password";
const K_EMAIL = "login_email";
const K_CLIENT_ID = "api_client_id";
const K_CLIENT_SECRET = "api_client_secret";
const BW_TIMEOUT_MS = 30_000;

// `bw status` reads local state and answers promptly even against a self-hosted
// server, so it does not deserve the full command budget. The host holds the
// plugin VM's mutex for the whole synchronous call, so every second spent here
// is a second every other secret call spends queued behind it (#4).
const BW_STATUS_TIMEOUT_MS = 8_000;

// The credential auto-unlock uses, or null. Signing in always stores it, so the
// only reason this is empty is that the user has never signed in or has locked.
function* rememberedMasterPassword(): HostIoSteps<string | null> {
  const master = (yield* ioValue<string | null>({ op: "secretGet", name: K_MASTER }));
  return master && master.length ? master : null;
}

// A locked vault with nothing remembered can never be opened headlessly. Saying
// so costs one local secret read; discovering it by running bw costs the budget
// above, twice, for an answer that was already knowable.
function* canUnlockHeadlessly(): HostIoSteps<boolean> {
  return !!(yield* rememberedMasterPassword());
}

// bw's wording for "these credentials are wrong", as opposed to a network or
// server failure. Only the former is worth forgetting a stored password over.
function isRejectedCredential(msg: string | undefined): boolean {
  const m = (typeof msg === "string" ? msg : "").toLowerCase();
  return (
    m.indexOf("invalid master password") >= 0 ||
    m.indexOf("username or password is incorrect") >= 0 ||
    m.indexOf("invalid credentials") >= 0
  );
}

const LOCKED_HINT = "vault is locked and no master password is remembered — run `codeterm mem secret unlock` interactively";

type Envelope<T = unknown> = { ok: T } | { error: SecretError };

// bw --response JSON envelope.
interface BwResponse {
  success: boolean;
  data?: unknown;
  message?: string;
  errorCode?: unknown;
}

// --- pure helpers (parity-tested against the native Rust) ---

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64Encode(str: string): string {
  // UTF-8 → base64. Pure JS (QuickJS has no btoa/Buffer).
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  let out = "";
  for (let j = 0; j < bytes.length; j += 3) {
    const b0 = bytes[j], b1 = bytes[j + 1], b2 = bytes[j + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 63];
  }
  return out;
}

// Translate a bw error message → a SecretError kind (mirror map_bw_message).
function mapBwError(msg: string | undefined): SecretError {
  const m = (typeof msg === "string" ? msg : "").toLowerCase();
  if (m.indexOf("vault is locked") >= 0) return { kind: "locked" };
  if (m.indexOf("you are not logged in") >= 0) return { kind: "logged_out" };
  if (m.indexOf("not found") >= 0) return { kind: "not_found" };
  if (m.indexOf("more than one result") >= 0) return { kind: "ambiguous", candidates: [] };
  if (m.indexOf("already") >= 0 && m.indexOf("exists") >= 0) return { kind: "already_exists" };
  if (m.indexOf("unreachable") >= 0 || m.indexOf("econnrefused") >= 0 || m.indexOf("enotfound") >= 0) {
    return { kind: "backend", message: "Bitwarden server is unreachable" };
  }
  if (/^bw metadata (failed: exit -?\d{1,3}|timed out|exceeded capture limit|could not start|returned invalid json|returned unexpected shape|exceeded host output limit|process failed)$/.test(m)) {
    return { kind: "backend", message: m };
  }
  return { kind: "backend", message: "bw failed" };
}

// {object:"list",data:[...]} / {template:{...}} unwrap (mirror unwrap_data_envelope).
function unwrapData(v: unknown): unknown {
  if (v && typeof v === "object" && (v as Record<string, unknown>).data !== undefined) {
    return (v as Record<string, unknown>).data;
  }
  if (v && typeof v === "object" && (v as Record<string, unknown>).template !== undefined) {
    return (v as Record<string, unknown>).template;
  }
  return v;
}

interface CipherItem {
  id: string;
  type: number;
  name: string;
  notes?: string | null;
  folderId?: string | null;
  organizationId?: string | null;
  collectionIds?: string[];
  revisionDate?: string;
  login?: { password?: string | null } | null;
}

function buildLoginCipher(req: SecretSaveRequest, existingId: string | null, folderId: string | null): unknown {
  return {
    id: existingId || null,
    type: 1,
    name: req.name,
    notes: req.notes || null,
    folderId: folderId || null,
    organizationId: req.organization || null,
    collectionIds: req.collection ? [req.collection] : [],
    favorite: false,
    login: { username: null, password: req.value, totp: null, uris: [] },
  };
}

function isValidHttpUrl(s: string): boolean {
  const t = (s || "").trim().toLowerCase();
  if (!(t.indexOf("http://") === 0 || t.indexOf("https://") === 0)) return false;
  return hostOf(s).length > 0;
}

// Host portion of a URL (lowercased, port stripped). "" when none.
function hostOf(s: string): string {
  const afterScheme = (s || "").split("://")[1] || "";
  const hostPort = afterScheme.replace(/^\/+/, "").split(/[\/?#]/)[0];
  return (hostPort.split(":")[0] || "").toLowerCase();
}

// Network-scope guard: a server URL is only honoured if its host is within the
// plugin's declared network allow-list (manifest permissions.network.allow).
// `bw config server <url>` would otherwise let the iframe point the CLI — and so
// the vault traffic — at an arbitrary origin beyond what the manifest grants.
function serverHostAllowed(url: string, allow: string[]): boolean {
  if (!isValidHttpUrl(url)) return false;
  const h = hostOf(url);
  if (!h) return false;
  return (allow || []).some((a) => {
    const e = hostOf("https://" + (a || "")) || (a || "").toLowerCase().split(":")[0];
    return !!e && (h === e || h.lastIndexOf("." + e) === h.length - e.length - 1);
  });
}

// Allowed hosts = manifest network grants, always including the default cloud
// host so the out-of-the-box server keeps working even if the manifest read
// fails. To use a self-hosted server, add its host to the plugin's network
// permissions (the explicit host-permission step for a new origin).
function* effectiveAllow(): HostIoSteps<string[]> {
  let allow: string[] = [];
  try {
    const m = host.manifest() as { permissions?: { network?: { allow?: unknown } } } | null;
    const a = m && m.permissions && m.permissions.network && m.permissions.network.allow;
    if (Array.isArray(a)) allow = a.filter((x) => typeof x === "string") as string[];
  } catch (e) {
    allow = [];
  }
  const def = hostOf(DEFAULT_SERVER);
  if (def && allow.indexOf(def) < 0) allow.push(def);
  const configured = hostOf((yield* serverUrl()));
  if (configured && allow.indexOf(configured) < 0) allow.push(configured);
  return allow;
}

// --- bw exec layer ---

interface BwOpts {
  env?: Record<string, string>;
  session?: string;
  stdin?: string | null;
  timeoutMs?: number;
}

interface BwExec { error?: string; stdout?: string; stderr?: string; code?: number; truncated?: boolean }

// Shape a raw exec/poll result into bw's { success, data, message } envelope.
function parseBwOutput(ex: BwExec): BwResponse {
  if (ex.truncated) return { success: false, message: "bw metadata exceeded host output limit" };
  if (ex.error) return { success: false, message: ex.error };
  try {
    return JSON.parse((ex.stdout || "").trim()); // { success, data, message, errorCode }
  } catch (e) {
    // stdout/stderr may hold vault items; never let them become an error message.
    return { success: false, message: "bw output was not valid JSON (exit " + ex.code + ")" };
  }
}

function hostStringCall(name: string): string | null {
  try {
    const h = host as unknown as Record<string, unknown>;
    const fn = h[name];
    if (typeof fn !== "function") return null;
    const value = (fn as () => unknown)();
    return typeof value === "string" && value.length ? value : null;
  } catch (e) {
    return null;
  }
}

function hostEnvGet(key: string): string | null {
  try {
    const h = host as unknown as { envGet?: (name: string) => unknown };
    if (typeof h.envGet !== "function") return null;
    const value = h.envGet(key);
    return typeof value === "string" && value.length ? value : null;
  } catch (e) {
    return null;
  }
}

function expandedBwPath(): string | null {
  const platform = (hostStringCall("platform") || "").toLowerCase();
  if (platform.indexOf("win") >= 0) return null;

  const parts: string[] = [];
  const home = hostStringCall("homeDir");
  if (home) parts.push(`${home.replace(/\/+$/, "")}/.local/bin`);

  const currentPath = hostEnvGet("PATH");
  if (currentPath) parts.push.apply(parts, currentPath.split(":"));

  parts.push("/snap/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");

  const seen: Record<string, boolean> = {};
  const out: string[] = [];
  for (const part of parts) {
    if (!part || seen[part]) continue;
    seen[part] = true;
    out.push(part);
  }
  return out.length ? out.join(":") : null;
}

function bwExecOpts(args: string[], opts: BwOpts): string {
  const full = args.concat(["--nointeraction", "--response"]);
  const env = opts.env || {};
  if (opts.session) env.BW_SESSION = opts.session;
  const metadata = args[0] === "list" && args[1] === "items";
  const bin = metadata ? "node" : "bw";
  const commandArgs = metadata ? ["-e", METADATA_PROCESS, "--"].concat(full) : full;
  const path = expandedBwPath();
  if (path) {
    return JSON.stringify({ bin: "env", args: [`PATH=${path}`, bin].concat(commandArgs), env: env, stdin: opts.stdin || null, timeoutMs: opts.timeoutMs || BW_TIMEOUT_MS });
  }
  return JSON.stringify({ bin: bin, args: commandArgs, env: env, stdin: opts.stdin || null, timeoutMs: opts.timeoutMs || BW_TIMEOUT_MS });
}

// No item values live in this state. The marker contains only the bound port.
let serve: { job: string; marker: string; port?: number; session: string; epoch: number } | null = null;
let serveEpoch = 0;
let vaultRevision = 0;
let serveDisabledUntil = 0;

function* stopServe(): HostIoSteps<void> {
  ++serveEpoch;
  const previous = serve;
  serve = null;
  if (!previous) return;
  try { if (previous.job) host.exec.close(previous.job); } catch { }
  try { yield* host.io.fs.removeFile(previous.marker); } catch { }
}

function* startServe(session: string): HostIoSteps<void> {
  if (Date.now() < serveDisabledUntil || typeof host.dataDir !== "function") return;
  if (serve && serve.session !== session) yield* stopServe();
  if (!serve) {
    const epoch = serveEpoch;
    const root = host.dataDir() + "/bitwarden";
    const marker = root + "/bw-serve-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".json";
    // Reserve before yielding: concurrent reads use the CLI until this startup completes.
    const pending = { job: "", marker, session, epoch, port: undefined as number | undefined };
    serve = pending;
    try {
      if (!(yield* host.io.fs.makeDirs(root))) throw new Error("serve storage unavailable");
      const env: Record<string, string> = { BW_SESSION: session, CT_BW_READY: marker };
      const path = expandedBwPath();
      if (path) env.PATH = path;
      if (serve !== pending || serveEpoch !== epoch) return;
      const started = (yield { op: "execStart", options: { bin: "node", args: ["-e", SERVE_PROCESS], env, timeoutMs: 24 * 60 * 60 * 1000 } }) as { jobId?: string };
      if (!started.jobId) throw new Error("serve start failed");
      pending.job = started.jobId;
      if (serve !== pending || serveEpoch !== epoch) { host.exec.close(pending.job); return; }
    } catch {
      try { if (pending.job) host.exec.close(pending.job); } catch { }
      try { yield* host.io.fs.removeFile(marker); } catch { }
      if (serve === pending) { serve = null; serveDisabledUntil = Date.now() + 30000; }
      return;
    }
  }
}

function* serveGet(name: string, session: string): HostIoSteps<BwResponse | null> {
  yield* startServe(session);
  const current = serve;
  if (!current || !current.job) return null;
  const job = host.exec.poll(current.job);
  if (job.done) { yield* stopServe(); return null; }
  if (!current.port) {
    const ready = yield* host.io.fs.readJson<{ port?: number }>(current.marker);
    if (ready && Number.isInteger(ready.port) && ready.port! > 0 && ready.port! <= 65535) current.port = ready.port;
    else return null;
  }
  try {
    // Refresh the idle lease. No values, names or session tokens are written.
    yield* host.io.fs.writeFile(current.marker, JSON.stringify({ port: current.port }));
    const response = yield* host.io.fetch({ url: "http://127.0.0.1:" + current.port + "/object/item/" + encodeURIComponent(name), timeoutMs: 2000 });
    if (serve !== current || serveEpoch !== current.epoch) return { success: false, message: "Vault is locked." };
    if (response.error) throw new Error("serve unavailable");
    const body = JSON.parse(response.body || "{}");
    if (typeof body.success !== "boolean") throw new Error("invalid serve response");
    if (!body.success && mapBwError(body.message).kind === "backend") throw new Error("serve unavailable");
    return body;
  } catch {
    if (serve === current) yield* stopServe();
    serveDisabledUntil = Date.now() + 30000;
    return null;
  }
}

function* bw(args: string[], opts?: BwOpts): HostIoSteps<BwResponse> {
  opts = opts || {};
  if (args[0] === "get" && args[1] === "item" && opts.session) {
    const served = yield* serveGet(args[2], opts.session);
    if (served) return served;
  } else if (args[0] !== "status" && args[0] !== "list") {
    yield* stopServe();
    serveDisabledUntil = 0;
  }
  const raw = JSON.stringify(yield* host.io.exec(JSON.parse(bwExecOpts(args, opts))));
  let ex: BwExec;
  try { ex = JSON.parse(raw); } catch (e) { return { success: false, message: "bw exec result was not valid JSON" }; }
  return parseBwOutput(ex);
}

// bw unlock/--raw returns the session token either as a bare string or wrapped
// in {raw} / {template:{raw}}. Normalise to a trimmed string ("" when absent).
function extractSessionToken(data: unknown): string {
  const d = data as string | { raw?: string; template?: { raw?: string } } | undefined;
  const token = typeof d === "string" ? d : (d && d.raw) || (d && d.template && d.template.raw);
  return (token || "").trim();
}

// Re-entrancy guard: one auto-unlock in flight at a time, never recursive.
let autoUnlocking = false;
let lastRecoveryError: SecretError | null = null;

function* tryAutoLogin(master: string): HostIoSteps<boolean> {
  const clientId = (yield* ioValue<string | null>({ op: "secretGet", name: K_CLIENT_ID }));
  const clientSecret = (yield* ioValue<string | null>({ op: "secretGet", name: K_CLIENT_SECRET }));
  const email = (yield* ioValue<string | null>({ op: "secretGet", name: K_EMAIL }));
  let login: BwResponse;
  let usedApiKey = false;

  if (clientId && clientSecret) {
    usedApiKey = true;
    login = (yield* bw(["login", "--apikey"], {
      env: { BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret },
    }));
  } else if (email) {
    login = (yield* bw(["login", email, "--passwordenv", "BW_PASSWORD"], {
      env: { BW_PASSWORD: master },
    }));
  } else {
    lastRecoveryError = { kind: "logged_out", message: "stored Bitwarden login identity is missing" };
    return false;
  }

  if (login.success || (login.message || "").toLowerCase().indexOf("already logged in") >= 0) {
    lastRecoveryError = null;
    return true;
  }
  lastRecoveryError = mapBwError(login.message);
  if (isRejectedCredential(login.message)) {
    if (usedApiKey) {
      (yield* ioValue<boolean>({ op: "secretDelete", name: K_CLIENT_ID }));
      (yield* ioValue<boolean>({ op: "secretDelete", name: K_CLIENT_SECRET }));
    } else {
      (yield* ioValue<boolean>({ op: "secretDelete", name: K_MASTER }));
    }
  }
  return false;
}

// Re-establish login and BW_SESSION from the local file-backed credential bucket.
// Secrets pass through the environment only and are never logged.
function* tryAutoUnlock(): HostIoSteps<boolean> {
  if (autoUnlocking) return false;
  autoUnlocking = true;
  try {
    const master = (yield* rememberedMasterPassword());
    if (master && master.length) {
      const status = (yield* bwStatus());
      if (status.failure) {
        lastRecoveryError = { kind: "backend", message: status.failure.message };
        return false;
      }
      (yield* rememberLoginIdentity(status));
      if (status.status && status.status.status === "unauthenticated" && !(yield* tryAutoLogin(master))) {
        return false;
      }
      const unlocked = (yield* bw(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { env: { BW_PASSWORD: master } }));
      if (!unlocked.success) {
        // A rejected password never starts working. Kept, it makes every later
        // call pay a doomed unlock before failing; forgotten, the next call
        // fails immediately and says to unlock interactively. A transient
        // failure is left alone so a flaky network does not wipe the credential.
        if (isRejectedCredential(unlocked.message)) {
          (yield* ioValue<boolean>({ op: "secretDelete", name: K_MASTER }));
          lastRecoveryError = { kind: "locked", message: "stored Bitwarden master password was rejected" };
        } else {
          lastRecoveryError = mapBwError(unlocked.message);
        }
        return false;
      }
      const token = extractSessionToken(unlocked.data);
      if (!token) {
        lastRecoveryError = { kind: "backend", message: "bw unlock returned no session token" };
        return false;
      }
      (yield* ioValue<boolean>({ op: "secretSet", name: K_SESSION, value: token }));
      yield* startServe(token);
      lastRecoveryError = null;
      return true;
    }
    lastRecoveryError = { kind: "locked", message: LOCKED_HINT };
    return false;
  } finally {
    autoUnlocking = false;
  }
}

// Run a session-scoped bw command. Persist ONLY the short-lived BW_SESSION token.
// If the session is missing/expired (or an op returns {locked} mid-flight) and a
// master password is remembered, perform ONE JIT auto-unlock then retry ONCE.
// A local guard bounds it to a single auto-unlock+retry so a persistent lock
// cannot loop.
function* runWithSession(args: string[], stdin?: string): HostIoSteps<Envelope> {
  let session = (yield* ioValue<string | null>({ op: "secretGet", name: K_SESSION }));
  let triedUnlock = false;
  if (!session) {
    if (!(yield* canUnlockHeadlessly())) return { error: { kind: "locked", message: LOCKED_HINT } };
    if (!(yield* tryAutoUnlock())) return { error: lastRecoveryError || { kind: "locked", message: LOCKED_HINT } };
    triedUnlock = true;
    session = (yield* ioValue<string | null>({ op: "secretGet", name: K_SESSION }));
    if (!session) return { error: { kind: "locked", message: LOCKED_HINT } };
  }
  let r = (yield* bw(args, { session: session, stdin: stdin }));
  if (!r.success) {
    const err = mapBwError(r.message);
    if ((err.kind === "locked" || err.kind === "logged_out") && !triedUnlock && (yield* canUnlockHeadlessly())) {
      (yield* ioValue<boolean>({ op: "secretDelete", name: K_SESSION }));
      if (!(yield* tryAutoUnlock())) return { error: lastRecoveryError || err };
      const fresh = (yield* ioValue<string | null>({ op: "secretGet", name: K_SESSION }));
      if (fresh) {
        r = (yield* bw(args, { session: fresh, stdin: stdin }));
        if (!r.success) return { error: mapBwError(r.message) };
        return { ok: unwrapData(r.data) };
      }
    }
    return { error: err };
  }
  return { ok: unwrapData(r.data) };
}

interface BitwardenSettings {
  serverUrl?: string;
}

function settings(): BitwardenSettings {
  try {
    return (JSON.parse(host.settingsJson()) as BitwardenSettings) || {};
  } catch (e) {
    return {};
  }
}

function* serverUrl(): HostIoSteps<string> {
  const s = settings();
  if (s.serverUrl && s.serverUrl.length) return s.serverUrl;
  const u = (yield* ioValue<string | null>({ op: "secretGet", name: "server_url" }));
  return u && u.length ? u : DEFAULT_SERVER;
}

interface BwStatus {
  status: string;
  userEmail?: string;
  serverUrl?: string;
}

// Why `bw status` failed, so statusFromBw can report the real cause (R3):
// binary_missing = bw not on PATH; exec_error = other spawn failure;
// bw_error = bw ran but reported a problem (server unreachable / bad session).
type StatusFailure = { kind: "binary_missing" | "exec_error" | "bw_error"; message: string };
type StatusResult = { status?: BwStatus; failure?: StatusFailure };

function isBinaryMissing(msg: string): boolean {
  const m = (typeof msg === "string" ? msg : "").toLowerCase();
  return m.indexOf("no such file") >= 0 || m.indexOf("enoent") >= 0 ||
    m.indexOf("cannot find") >= 0 || m.indexOf("executable file not found") >= 0 ||
    (m.indexOf("spawn") >= 0 && m.indexOf("bw") >= 0);
}

// Map a raw bw exec result into a StatusResult, preserving the failure cause.
function bwExecToStatusResult(ex: BwExec): StatusResult {
  if (ex.error) {
    if (isBinaryMissing(ex.error)) {
      return { failure: { kind: "binary_missing", message: "Bitwarden CLI (bw) not found" } };
    }
    return { failure: { kind: "exec_error", message: "bw could not be started" } };
  }
  const resp = parseBwOutput(ex);
  if (!resp.success) return { failure: { kind: "bw_error", message: mapBwError(resp.message).message || "bw status failed" } };
  return { status: unwrapData(resp.data) as BwStatus };
}

function* bwStatus(): HostIoSteps<StatusResult> {
  const session = (yield* ioValue<string | null>({ op: "secretGet", name: K_SESSION }));
  const raw = JSON.stringify(yield* host.io.exec(JSON.parse(bwExecOpts(["status"], { session: session || undefined, timeoutMs: BW_STATUS_TIMEOUT_MS }))));
  let ex: BwExec;
  try { ex = JSON.parse(raw); } catch (e) { return { failure: { kind: "exec_error", message: "bw exec result was not valid JSON" } }; }
  return bwExecToStatusResult(ex);
}

function* rememberLoginIdentity(res: StatusResult): HostIoSteps<void> {
  const email = res.status && res.status.userEmail;
  if (email) (yield* ioValue<boolean>({ op: "secretSet", name: K_EMAIL, value: email }));
}

// --- SecretStore trait surface (called by JsSecretBackend) ---

// Map a raw bw status result into the host's StoreStatus shape. Shared by the
// secretStatus and the statusStart/statusPoll path. On failure the
// real cause (R3) is surfaced in `reason` rather than a generic string.
function* statusFromBw(res: StatusResult): HostIoSteps<SecretStatus> {
  const endpoint = (yield* serverUrl());
  if (res.failure) return { status: "unavailable", reason: res.failure.message };
  const s = res.status;
  if (!s) return { status: "unavailable", reason: "bw status returned no data" };
  (yield* rememberLoginIdentity(res));
  if (s.status === "unlocked") {
    return { status: "unlocked", user: s.userEmail || null, transient: false, endpoint: s.serverUrl || endpoint };
  }
  if (s.status === "locked") return { status: "locked", endpoint: endpoint };
  return { status: "logged_out", endpoint: endpoint };
}

// Yielding status probe. If the vault reports locked but a master password is
// remembered, attempt one JIT auto-unlock so status reflects the truly-reachable
// state. Loop-guarded (tryAutoUnlock is single-flight; unlocked is terminal).
function* secretStatus(): HostIoSteps<SecretStatus> {
  let st = (yield* statusFromBw((yield* bwStatus())));
  // Locked with nothing to unlock from is a terminal answer, not a reason to
  // spend two more bw invocations arriving at the same place.
  if (st.status === "locked" && !(yield* canUnlockHeadlessly())) {
    return { status: "locked", endpoint: st.endpoint, reason: LOCKED_HINT };
  }
  if ((st.status === "locked" || st.status === "logged_out") && (yield* canUnlockHeadlessly())) {
    if ((yield* tryAutoUnlock())) st = (yield* statusFromBw((yield* bwStatus())));
    else if (lastRecoveryError) {
      st = { status: "unavailable", endpoint: st.endpoint, reason: lastRecoveryError.message || lastRecoveryError.kind };
    }
  }
  return st;
}

function* secretUnlock(creds: SecretCreds): HostIoSteps<Envelope<true>> {
  ++vaultRevision;
  creds = creds || {};
  const hasPw = creds.masterPassword && creds.masterPassword.length;
  if (!hasPw && !creds.apiKeyClientId) {
    // No input: honour the `mem secret unlock` no-arg contract by re-unlocking
    // from persisted creds. Only when nothing is persisted is it a bad request.
    if ((yield* canUnlockHeadlessly()) && (yield* tryAutoUnlock())) return { ok: true };
    if (lastRecoveryError) return { error: lastRecoveryError };
    return { error: { kind: "bad_request", message: "master password (or API-key creds) required" } };
  }
  if (!hasPw) {
    // API-key credentials can log in, but `bw unlock` still needs the master
    // password — saying so beats a confusing backend error from bw.
    return { error: { kind: "bad_request", message: "master password is required to unlock, even with API-key credentials" } };
  }
  const server = (yield* serverUrl());
  if (!isValidHttpUrl(server)) {
    return { error: { kind: "bad_request", message: "invalid bitwarden server URL: " + server } };
  }
  if (!serverHostAllowed(server, (yield* effectiveAllow()))) {
    return { error: { kind: "bad_request", message: "server host not permitted by plugin network permissions: " + hostOf(server) } };
  }

  let statusResult = (yield* bwStatus());
  (yield* rememberLoginIdentity(statusResult));
  let st = statusResult.status;
  let loggedIn = !!st && st.status !== "unauthenticated";
  const currentServer = (st && st.serverUrl) || "";
  if (loggedIn && currentServer && currentServer !== server) {
    (yield* bw(["logout"]));
    (yield* ioValue<boolean>({ op: "secretDelete", name: K_SESSION }));
    loggedIn = false;
  }
  const serverChanged = currentServer !== server;
  if (serverChanged) {
    const cfg = (yield* bw(["config", "server", server]));
    if (!cfg.success) return { error: { kind: "backend", message: "could not point bw at " + server } };
  }

  if (serverChanged) {
    statusResult = (yield* bwStatus());
    (yield* rememberLoginIdentity(statusResult));
    st = statusResult.status;
    loggedIn = !!st && st.status !== "unauthenticated";
  }
  if (!loggedIn) {
    let login: BwResponse;
    if (creds.apiKeyClientId && creds.apiKeyClientSecret) {
      login = (yield* bw(["login", "--apikey"], { env: { BW_CLIENTID: creds.apiKeyClientId as string, BW_CLIENTSECRET: creds.apiKeyClientSecret as string } }));
      if (login.success) {
        (yield* ioValue<boolean>({ op: "secretSet", name: K_CLIENT_ID, value: creds.apiKeyClientId as string }));
        (yield* ioValue<boolean>({ op: "secretSet", name: K_CLIENT_SECRET, value: creds.apiKeyClientSecret as string }));
      }
    } else if (creds.email) {
      let args = ["login", creds.email, "--passwordenv", "BW_PASSWORD"];
      if (creds.twoFactorToken) args = args.concat(["--method", "0", "--code", creds.twoFactorToken as string]);
      login = (yield* bw(args, { env: { BW_PASSWORD: creds.masterPassword as string } }));
    } else {
      return { error: { kind: "bad_request", message: "either email + master_password or api_key_* required" } };
    }
    if (!login.success && (login.message || "").toLowerCase().indexOf("already logged in") < 0) {
      return { error: mapBwError(login.message) };
    }
  }

  const unlocked = (yield* bw(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { env: { BW_PASSWORD: creds.masterPassword as string } }));
  if (!unlocked.success) return { error: mapBwError(unlocked.message) };
  const token = extractSessionToken(unlocked.data);
  if (!token) return { error: { kind: "backend", message: "bw unlock returned empty session" } };

  (yield* ioValue<boolean>({ op: "secretSet", name: K_SESSION, value: token }));
  yield* startServe(token);
  (yield* ioValue<boolean>({ op: "secretSet", name: K_MASTER, value: creds.masterPassword as string }));
  if (!creds.apiKeyClientId && creds.email) (yield* ioValue<boolean>({ op: "secretSet", name: K_EMAIL, value: creds.email }));
  return { ok: true };
}

function* secretLock(): HostIoSteps<Envelope<true>> {
  ++vaultRevision;
  (yield* bw(["lock"]));
  (yield* ioValue<boolean>({ op: "secretDelete", name: K_SESSION }));
  return { ok: true };
}

function* secretLogout(): HostIoSteps<Envelope<true>> {
  ++vaultRevision;
  (yield* bw(["logout"]));
  (yield* clearStoredCredentials());
  return { ok: true };
}

function* clearStoredCredentials(): HostIoSteps<void> {
  (yield* ioValue<boolean>({ op: "secretDelete", name: K_SESSION }));
  (yield* ioValue<boolean>({ op: "secretDelete", name: K_MASTER }));
  (yield* ioValue<boolean>({ op: "secretDelete", name: K_EMAIL }));
  (yield* ioValue<boolean>({ op: "secretDelete", name: K_CLIENT_ID }));
  (yield* ioValue<boolean>({ op: "secretDelete", name: K_CLIENT_SECRET }));
}

function* resetConnection(): HostIoSteps<Envelope<true>> {
  ++vaultRevision;
  const server = (yield* serverUrl());
  if (!isValidHttpUrl(server)) {
    return { error: { kind: "bad_request", message: "invalid bitwarden server URL: " + server } };
  }
  if (!serverHostAllowed(server, (yield* effectiveAllow()))) {
    return { error: { kind: "bad_request", message: "server host not permitted by plugin network permissions: " + hostOf(server) } };
  }

  (yield* bw(["logout"]));
  (yield* clearStoredCredentials());
  const configured = (yield* bw(["config", "server", server]));
  if (!configured.success) {
    return { error: { kind: "backend", message: "could not point bw at " + server } };
  }
  return { ok: true };
}

function isoToMs(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

interface SecretRefOut {
  item_id: string;
  name: string;
  folder: string | null;
  organization: string | null;
  collection: string | null;
  last_modified: number | null;
}

// Unwraps nested {success, data: {object: "list", data: [...]}} envelopes and
// keeps only login-item metadata; login, notes, fields and attachments stay here.
function metadataRefs(listed: unknown): SecretRefOut[] | null {
  let v = listed;
  while (v && typeof v === "object" && !Array.isArray(v) && (v as Record<string, unknown>).data !== undefined) {
    v = (v as Record<string, unknown>).data;
  }
  if (!Array.isArray(v)) return null;
  for (const item of v) {
    if (!item || typeof item !== "object") return null;
    const c = item as Record<string, unknown>;
    for (const key of ["folderId", "organizationId", "revisionDate"]) {
      if (c[key] != null && typeof c[key] !== "string") return null;
    }
    if (c.collectionIds != null && (!Array.isArray(c.collectionIds) ||
      !c.collectionIds.every((id: unknown) => typeof id === "string"))) return null;
  }
  return (v as CipherItem[])
    .filter((c) => c && c.type === 1 && typeof c.id === "string" && typeof c.name === "string")
    .map(toRef);
}

const UNEXPECTED_LIST: Envelope = { error: { kind: "backend", message: "bw list returned an unexpected shape" } };

function toRef(c: CipherItem): SecretRefOut {
  return {
    item_id: c.id,
    name: c.name,
    folder: c.folderId || null,
    organization: c.organizationId || null,
    collection: (c.collectionIds && c.collectionIds[0]) || null,
    last_modified: isoToMs(c.revisionDate),
  };
}

function* findByName(name: string): HostIoSteps<Envelope<CipherItem>> {
  const r = (yield* runWithSession(["list", "items", "--search", name]));
  if ("error" in r) return r;
  const exact = ((r.ok as CipherItem[]) || []).filter((c) => c.type === 1 && c.name.toLowerCase() === name.toLowerCase());
  if (exact.length === 0) return { error: { kind: "not_found" } };
  if (exact.length > 1) return { error: { kind: "ambiguous", candidates: exact.map((c) => c.id) } };
  return { ok: exact[0] };
}

interface FolderItem { id: string; name: string }

function* resolveFolderId(name: string | null | undefined): HostIoSteps<Envelope<string | null>> {
  if (!name) return { ok: null };
  const r = (yield* runWithSession(["list", "folders"]));
  if ("error" in r) return r;
  const f = ((r.ok as FolderItem[]) || []).find((x) => x.name && x.name.toLowerCase() === name.toLowerCase());
  return { ok: f ? f.id : null };
}

function* resolveOrCreateFolder(name: string): HostIoSteps<Envelope<string | null>> {
  const existing = (yield* resolveFolderId(name));
  if ("error" in existing) return existing;
  if (existing.ok) return existing;
  const encoded = base64Encode(JSON.stringify({ name: name }));
  const r = (yield* runWithSession(["create", "folder", encoded]));
  if ("error" in r) return r;
  const created = r.ok as FolderItem | null;
  return { ok: (created && created.id) || null };
}

function* secretSave(req: SecretSaveRequest): HostIoSteps<Envelope> {
  if (!req.name) return { error: { kind: "bad_request", message: "name required" } };
  if (!req.value) return { error: { kind: "bad_request", message: "value must not be empty" } };
  const existing = (yield* findByName(req.name));
  const existingItem = ("ok" in existing && existing.ok) || null;
  if (existingItem && !req.overwrite) return { error: { kind: "already_exists" } };

  let folderId: string | null = null;
  if (req.folder) {
    const f = (yield* resolveOrCreateFolder(req.folder));
    if ("error" in f) return f;
    folderId = f.ok;
  }
  const cipher = buildLoginCipher(req, existingItem ? existingItem.id : null, folderId);
  const encoded = base64Encode(JSON.stringify(cipher));
  const r = existingItem
    ? (yield* runWithSession(["edit", "item", existingItem.id, encoded]))
    : (yield* runWithSession(["create", "item", encoded]));
  if ("error" in r) return r;
  (yield* runWithSession(["sync"]));
  return { ok: toRef(r.ok as CipherItem) };
}

function* secretGetItem(nameOrId: string): HostIoSteps<Envelope> {
  const revision = vaultRevision;
  const r = (yield* runWithSession(["get", "item", nameOrId]));
  if ("error" in r) return r;
  if (revision !== vaultRevision) return { error: { kind: "locked" } };
  const item = r.ok as CipherItem;
  const value = item.login && item.login.password;
  if (value === undefined || value === null) return { error: { kind: "backend", message: "item has no login.password field" } };
  return { ok: { item_id: item.id, name: item.name, value: value, notes: item.notes || null } };
}

function* listMetadata(filter?: SecretListFilter): HostIoSteps<Envelope> {
  filter = filter || {};
  let args = ["list", "items"];
  if (filter.organization) args = args.concat(["--organizationid", filter.organization]);
  if (filter.collection) args = args.concat(["--collectionid", filter.collection]);
  const r = (yield* runWithSession(args));
  if ("error" in r) return r;
  let items = metadataRefs(r.ok);
  if (!items) return UNEXPECTED_LIST;
  if (filter.folder) {
    const fid = (yield* resolveFolderId(filter.folder));
    if ("error" in fid) return fid;
    items = items.filter((c) => c.folder === (fid.ok || null));
  }
  items.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
  if (filter.limit) items = items.slice(0, filter.limit);
  return { ok: items };
}

function* searchMetadata(query: string): HostIoSteps<Envelope> {
  const q = (query || "").trim();
  if (!q) return { error: { kind: "bad_request", message: "query must not be empty" } };
  const r = (yield* runWithSession(["list", "items", "--search", q]));
  if ("error" in r) return r;
  const items = metadataRefs(r.ok);
  return items ? { ok: items } : UNEXPECTED_LIST;
}

function metadataCall(run: () => Envelope): Envelope {
  try {
    return run();
  } catch {
    return { error: { kind: "backend", message: "bw metadata request failed" } };
  }
}

function* secretList(filter?: SecretListFilter): HostIoSteps<Envelope> {
  try { return (yield* listMetadata(filter)); } catch { return { error: { kind: "backend", message: "bw metadata request failed" } }; }
}

function* secretSearch(query: string): HostIoSteps<Envelope> {
  try { return (yield* searchMetadata(query)); } catch { return { error: { kind: "backend", message: "bw metadata request failed" } }; }
}

function* secretDelete(nameOrId: string): HostIoSteps<Envelope<true>> {
  const item = (yield* runWithSession(["get", "item", nameOrId]));
  if ("error" in item) return item;
  const r = (yield* runWithSession(["delete", "item", (item.ok as CipherItem).id, "--permanent"]));
  if ("error" in r) return r;
  (yield* runWithSession(["sync"]));
  return { ok: true };
}

interface OrgItem { id: string; name: string; organizationId?: string | null }

function* secretOrganizations(): HostIoSteps<Envelope> {
  const r = (yield* runWithSession(["list", "organizations"]));
  if ("error" in r) return r;
  return { ok: ((r.ok as OrgItem[]) || []).map((v) => ({ id: v.id, name: v.name })) };
}

function* secretCollections(orgId?: string): HostIoSteps<Envelope> {
  let args = ["list", "collections"];
  if (orgId) args = args.concat(["--organizationid", orgId]);
  const r = (yield* runWithSession(args));
  if ("error" in r) return r;
  return { ok: ((r.ok as OrgItem[]) || []).map((v) => ({ id: v.id, name: v.name, organization_id: v.organizationId || null })) };
}

function* secretSync(): HostIoSteps<Envelope<true>> {
  const r = (yield* runWithSession(["sync"]));
  if ("error" in r) return r;
  return { ok: true };
}

// Cheap, non-mutating, non-blocking: secretInit runs on every load and must not
// shell `bw status` (up to 30s) or auto-unlock. Status probing and unlocking are
// explicit, async, user-driven actions (see statusStart/statusPoll, secretUnlock).
function secretInit(): Envelope<true> {
  return { ok: true };
}

// --- async status (non-blocking; for the iframe load path) ---
// All process waits yield through host.io. The existing UI job/poll protocol
// remains compatible with the iframe.
// statusStart/statusPoll move it onto the host's exec job queue: each call is
// sub-millisecond, the iframe polls, and the panel stays responsive.

function* statusStart(): HostIoSteps<{ jobId?: string; error?: string }> {
  const session = (yield* ioValue<string | null>({ op: "secretGet", name: K_SESSION }));
  const optsJson = bwExecOpts(["status"], { session: session || undefined });
  let res: { jobId?: string; error?: string };
  try { res = JSON.parse(JSON.stringify((yield* ioValue<{ jobId?: string; error?: string }>({ op: "execStart", options: JSON.parse(optsJson) })))); } catch (e) { return { error: "exec start: " + e }; }
  if (res.error) return { error: res.error };
  if (res.jobId) statusFlows[res.jobId] = { hostJobId: res.jobId, phase: "status" };
  return { jobId: res.jobId };
}

interface StatusFlow {
  hostJobId: string;
  phase: "status" | "login" | "unlock";
  usedApiKey?: boolean;
}

const statusFlows: Record<string, StatusFlow> = {};

function* startFlowJob(flowId: string, phase: StatusFlow["phase"], args: string[], opts: BwOpts, usedApiKey?: boolean): HostIoSteps<string | null> {
  let started: { jobId?: string; error?: string };
  try { started = JSON.parse(JSON.stringify((yield* ioValue<{ jobId?: string; error?: string }>({ op: "execStart", options: JSON.parse(bwExecOpts(args, opts)) })))); } catch (e) {
    lastRecoveryError = { kind: "backend", message: "exec start: " + e };
    return null;
  }
  if (started.error || !started.jobId) {
    lastRecoveryError = { kind: "backend", message: "bw could not be started" };
    return null;
  }
  statusFlows[flowId] = { hostJobId: started.jobId, phase, usedApiKey };
  return started.jobId;
}

function* startFlowLogin(flowId: string, master: string): HostIoSteps<boolean> {
  const clientId = (yield* ioValue<string | null>({ op: "secretGet", name: K_CLIENT_ID }));
  const clientSecret = (yield* ioValue<string | null>({ op: "secretGet", name: K_CLIENT_SECRET }));
  const email = (yield* ioValue<string | null>({ op: "secretGet", name: K_EMAIL }));
  if (clientId && clientSecret) {
    return !!(yield* startFlowJob(flowId, "login", ["login", "--apikey"], {
      env: { BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret },
    }, true));
  }
  if (email) {
    return !!(yield* startFlowJob(flowId, "login", ["login", email, "--passwordenv", "BW_PASSWORD"], {
      env: { BW_PASSWORD: master },
    }, false));
  }
  lastRecoveryError = { kind: "logged_out", message: "stored Bitwarden login identity is missing" };
  return false;
}

function* flowFailure(flowId: string, message: string | undefined, usedApiKey?: boolean): HostIoSteps<{ done: true; status: SecretStatus }> {
  lastRecoveryError = mapBwError(message);
  if (isRejectedCredential(message)) {
    if (usedApiKey) {
      (yield* ioValue<boolean>({ op: "secretDelete", name: K_CLIENT_ID }));
      (yield* ioValue<boolean>({ op: "secretDelete", name: K_CLIENT_SECRET }));
    } else {
      (yield* ioValue<boolean>({ op: "secretDelete", name: K_MASTER }));
    }
  }
  delete statusFlows[flowId];
  return {
    done: true,
    status: { status: "unavailable", endpoint: (yield* serverUrl()), reason: lastRecoveryError.message || lastRecoveryError.kind },
  };
}

function* statusPoll(jobId: string): HostIoSteps<{ done: boolean; status?: SecretStatus; error?: string }> {
  if (!jobId) return { done: true, error: "no jobId" };
  const flow = statusFlows[jobId] || { hostJobId: jobId, phase: "status" as const };
  let p: BwExec & { done?: boolean };
  try { p = JSON.parse(host.execPoll(flow.hostJobId)); } catch (e) {
    delete statusFlows[jobId];
    return { done: true, error: "exec poll: " + e };
  }
  if (!p.done) return { done: false };
  const response = parseBwOutput(p);
  if (flow.phase === "login") {
    if (!response.success && (response.message || "").toLowerCase().indexOf("already logged in") < 0) {
      return (yield* flowFailure(jobId, response.message, flow.usedApiKey));
    }
    const master = (yield* rememberedMasterPassword());
    if (!master || !(yield* startFlowJob(jobId, "unlock", ["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], {
      env: { BW_PASSWORD: master || "" },
    }))) {
      delete statusFlows[jobId];
      return { done: true, status: { status: "unavailable", endpoint: (yield* serverUrl()), reason: (lastRecoveryError && (lastRecoveryError.message || lastRecoveryError.kind)) || LOCKED_HINT } };
    }
    return { done: false };
  }
  if (flow.phase === "unlock") {
    if (!response.success) return (yield* flowFailure(jobId, response.message));
    const token = extractSessionToken(response.data);
    if (!token) return (yield* flowFailure(jobId, "bw unlock returned no session token"));
    (yield* ioValue<boolean>({ op: "secretSet", name: K_SESSION, value: token }));
    yield* startServe(token);
    lastRecoveryError = null;
    delete statusFlows[jobId];
    return { done: true, status: { status: "unlocked", user: (yield* ioValue<string | null>({ op: "secretGet", name: K_EMAIL })), transient: false, endpoint: (yield* serverUrl()) } };
  }
  const statusResult = bwExecToStatusResult(p);
  const status = (yield* statusFromBw(statusResult));
  if ((status.status !== "locked" && status.status !== "logged_out") || !(yield* canUnlockHeadlessly())) {
    delete statusFlows[jobId];
    return { done: true, status };
  }
  const master = (yield* rememberedMasterPassword()) || "";
  const started = status.status === "logged_out"
    ? (yield* startFlowLogin(jobId, master))
    : !!(yield* startFlowJob(jobId, "unlock", ["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { env: { BW_PASSWORD: master } }));
  if (!started) {
    delete statusFlows[jobId];
    return { done: true, status: { status: "unavailable", endpoint: status.endpoint, reason: (lastRecoveryError && (lastRecoveryError.message || lastRecoveryError.kind)) || LOCKED_HINT } };
  }
  return { done: false };
}

// Glance: a quick peek at the vault connection — not the unlock form.
function* renderGlance(): HostIoSteps<GlanceView> {
  const s = (yield* secretStatus());
  const nodes: ViewNode[] = [];
  if (s.status === "unlocked") {
    nodes.push({ kind: "badge", label: "Unlocked", tone: "ok" });
    nodes.push({ kind: "keyVal", key: "Account", value: s.user || "—" });
    if (s.endpoint) nodes.push({ kind: "keyVal", key: "Server", value: s.endpoint });
  } else if (s.status === "locked") {
    nodes.push({ kind: "badge", label: "Locked", tone: "warn" });
    nodes.push({ kind: "text", text: "Vault is locked — unlock it in settings.", style: { tone: "muted" } });
  } else if (s.status === "unavailable") {
    nodes.push({ kind: "badge", label: "Unavailable", tone: "danger" });
    nodes.push({ kind: "note", body: s.reason || "The Bitwarden CLI isn't available.", level: "error" });
  } else {
    nodes.push({ kind: "badge", label: "Not signed in", tone: "danger" });
    if (s.endpoint) nodes.push({ kind: "keyVal", key: "Server", value: s.endpoint });
  }
  nodes.push({ kind: "divider" });
  nodes.push({ kind: "button", label: "Open settings", action: "settings" });
  return { title: "Bitwarden", nodes: nodes };
}

interface ViewArgs {
  url?: string;
  masterPassword?: string;
  email?: string;
  twoFactorToken?: string;
  apiKeyClientId?: string;
  apiKeyClientSecret?: string;
  organization?: string;
  jobId?: string;
  enabled?: boolean;
}

// Bridge entry for the plugin's iframe UI (capability: view). The iframe owns the
// connection panel (status / unlock / server URL); each call lands here and is
// routed to the plugin's own secret methods — never to arbitrary exports.
function* viewCall(method: string, args: ViewArgs): HostIoSteps<unknown> {
  args = args || {};
  if (method === "status") return (yield* secretStatus());
  // Async, non-blocking status for the iframe load path.
  if (method === "statusStart") return (yield* statusStart());
  if (method === "statusPoll") return (yield* statusPoll(args.jobId || ""));
  if (method === "serverUrl") return { url: (yield* serverUrl()) };
  if (method === "setServerUrl") {
    const url = (args.url || "").trim();
    if (url && !isValidHttpUrl(url)) return { error: "invalid server URL" };
    (yield* ioValue<boolean>({ op: "secretSet", name: "server_url", value: url }));
    return { ok: true };
  }
  if (method === "unlock") {
    return (yield* secretUnlock({
      masterPassword: args.masterPassword,
      email: args.email,
      twoFactorToken: args.twoFactorToken,
      apiKeyClientId: args.apiKeyClientId,
      apiKeyClientSecret: args.apiKeyClientSecret,
    } as SecretCreds));
  }
  if (method === "resetConnection") return (yield* resetConnection());
  if (method === "signout") return (yield* secretLogout());
  if (method === "organizations") {
    const o = (yield* secretOrganizations());
    return { organizations: ("ok" in o && o.ok) || [] };
  }
  if (method === "collections") {
    const c = (yield* secretCollections(args.organization));
    return { collections: ("ok" in c && c.ok) || [] };
  }
  return { error: "unknown view method: " + method };
}

const plugin = defineProviderIo({
  secretStatus,
  renderGlance,
  viewCall: viewCall as PluginModule["viewCall"],
  secretUnlock,
  secretLock,
  secretLogout,
  secretSave,
  secretGetItem,
  secretList,
  secretSearch,
  secretDelete,
  secretOrganizations,
  secretCollections,
  secretSync,
  secretInit,
  __test_stopServe: stopServe,
  // exported for parity tests (pure logic, no host.exec)
  __test_base64: base64Encode,
  __test_mapError: mapBwError,
  __test_metadataProcess: METADATA_PROCESS,
  __test_metadataRefs: metadataRefs,
  __test_parseBwOutput: parseBwOutput,
  __test_statusFromExec: (ex: BwExec) => bwExecToStatusResult(ex),
  __test_unwrap: unwrapData,
  __test_buildCipher: buildLoginCipher,
  __test_hostOf: hostOf,
  __test_serverHostAllowed: serverHostAllowed,
  __test_bwExecOpts: bwExecOpts,
}, () => host.io) satisfies PluginModule;

export default plugin;
