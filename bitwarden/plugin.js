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

// bitwarden/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);

// ../../codeterm/codeterm/packages/plugin-sdk/src/ioPrograms.ts
function* ioValue(request) {
  return yield request;
}
function defineProviderIo(source, io) {
  const exports = { ...source };
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (typeof value !== "function") continue;
    exports[key] = function(...args) {
      const result = value.apply(source, args);
      return result && typeof result.next === "function" ? io().run(result) : result;
    };
  }
  return exports;
}
function* ioEncoded(steps) {
  return JSON.stringify(yield* steps);
}

// bitwarden/src/metadata-process.ts
var METADATA_PROCESS = String.raw`
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join, delimiter } = require('node:path');
function fail(message) {
  process.stdout.write(JSON.stringify({ success: false, message }));
}
function executable() {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (process.platform === 'win32') {
      const native = join(dir, 'bw.exe');
      if (existsSync(native)) return [native, []];
      const pkgPath = join(dir, 'node_modules', '@bitwarden', 'cli', 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.bw;
        return [process.execPath, [join(dir, 'node_modules', '@bitwarden', 'cli', bin)]];
      }
    } else {
      const bin = join(dir, 'bw');
      if (existsSync(bin)) return [bin, []];
    }
  }
  return ['bw', []];
}
function run() {
  const [bin, prefix] = executable();
  const result = spawnSync(bin, prefix.concat(process.argv.slice(1)), {
    encoding: 'utf8', env: process.env, shell: false, windowsHide: true,
    timeout: 25000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    const code = result.error.code;
    return fail(code === 'ETIMEDOUT' ? 'bw metadata timed out' :
      code === 'ENOBUFS' ? 'bw metadata exceeded capture limit' : 'bw metadata could not start');
  }
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { return fail('bw metadata returned invalid JSON'); }
  if (!response || response.success !== true || result.status !== 0) {
    const message = response && typeof response.message === 'string' ? response.message.toLowerCase() : '';
    if (message.includes('vault is locked')) return fail('Vault is locked');
    if (message.includes('you are not logged in')) return fail('You are not logged in');
    return fail('bw metadata failed: exit ' + (Number.isInteger(result.status) ? result.status : -1));
  }
  let data = response.data;
  for (let depth = 0; depth < 8 && data && !Array.isArray(data) && typeof data === 'object'; depth++) {
    data = data.data;
  }
  if (!Array.isArray(data)) return fail('bw metadata returned unexpected shape');
  const items = [];
  for (const c of data) {
    if (!c || typeof c !== 'object') return fail('bw metadata returned unexpected shape');
    if (c.type !== 1) continue;
    if (typeof c.id !== 'string' || typeof c.name !== 'string') return fail('bw metadata returned unexpected shape');
    for (const key of ['folderId', 'organizationId', 'revisionDate']) {
      if (c[key] != null && typeof c[key] !== 'string') return fail('bw metadata returned unexpected shape');
    }
    if (c.collectionIds != null && (!Array.isArray(c.collectionIds) ||
      !c.collectionIds.every(id => typeof id === 'string'))) return fail('bw metadata returned unexpected shape');
    items.push({ type: 1, id: c.id, name: c.name, folderId: c.folderId,
      organizationId: c.organizationId, collectionIds: c.collectionIds, revisionDate: c.revisionDate });
  }
  const output = JSON.stringify({ success: true, data: items });
  if (Buffer.byteLength(output) > 120 * 1024) return fail('bw metadata exceeded host output limit');
  process.stdout.write(output);
}
try { run(); } catch { fail('bw metadata process failed'); }
`;

// bitwarden/src/serve-process.ts
var SERVE_PROCESS = String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync, unlinkSync, existsSync, statSync, readFileSync } = require('node:fs');
const net = require('node:net');
const { join, delimiter } = require('node:path');
${METADATA_PROCESS.slice(METADATA_PROCESS.indexOf("function executable()"), METADATA_PROCESS.indexOf("function run()"))}
const marker = process.env.CT_BW_READY;
const probe = net.createServer();
let child;
let ready = false;
const finish = () => { try { unlinkSync(marker); } catch {} if (child) child.kill(); process.exit(0); };
process.on('SIGTERM', finish);
process.on('SIGINT', finish);
probe.listen(0, '127.0.0.1', () => {
  const port = probe.address().port;
  probe.close(() => {
    const [bin, prefix] = executable();
    child = spawn(bin, prefix.concat(['serve', '--hostname', '127.0.0.1', '--port', String(port)]), { env: process.env, windowsHide: true, stdio: 'ignore' });
    delete process.env.BW_SESSION;
    // CLI releases differ in whether informational startup logs are enabled.
    // Probe the random port allocated for this child without capturing its output.
    const check = () => {
      if (!child || child.exitCode !== null) return;
      const socket = net.connect({host: '127.0.0.1', port});
      socket.once('connect', () => {
        socket.destroy(); ready = true;
        writeFileSync(marker, JSON.stringify({port}), {mode: 0o600});
      });
      socket.once('error', () => { socket.destroy(); if (!ready) setTimeout(check, 50); });
    };
    check();
    child.on('error', finish); child.on('exit', finish);
  });
});
// Startup and idle leases also bound leftovers after plugin replacement/unload.
const started = Date.now();
setInterval(() => {
  try {
    if (!ready && Date.now() - started > 20000) return finish();
    if (ready && (!existsSync(marker) || Date.now() - statSync(marker).mtimeMs > 300000)) finish();
  } catch { finish(); }
}, 1000);
`;

// bitwarden/src/plugin.ts
var DEFAULT_SERVER = "https://vault.bitwarden.com";
var K_SESSION = "session";
var K_MASTER = "master_password";
var K_EMAIL = "login_email";
var K_CLIENT_ID = "api_client_id";
var K_CLIENT_SECRET = "api_client_secret";
var BW_TIMEOUT_MS = 3e4;
var BW_STATUS_TIMEOUT_MS = 8e3;
function* rememberedMasterPassword() {
  const master = yield* ioValue({ op: "secretGet", name: K_MASTER });
  return master && master.length ? master : null;
}
function* canUnlockHeadlessly() {
  return !!(yield* rememberedMasterPassword());
}
function isRejectedCredential(msg) {
  const m = (typeof msg === "string" ? msg : "").toLowerCase();
  return m.indexOf("invalid master password") >= 0 || m.indexOf("username or password is incorrect") >= 0 || m.indexOf("invalid credentials") >= 0;
}
var LOCKED_HINT = "vault is locked and no master password is remembered \u2014 run `codeterm mem secret unlock` interactively";
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64Encode(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 128) bytes.push(c);
    else if (c < 2048) {
      bytes.push(192 | c >> 6, 128 | c & 63);
    } else if (c >= 55296 && c <= 56319) {
      const c2 = str.charCodeAt(++i);
      const cp = 65536 + ((c & 1023) << 10) + (c2 & 1023);
      bytes.push(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
    } else {
      bytes.push(224 | c >> 12, 128 | c >> 6 & 63, 128 | c & 63);
    }
  }
  let out = "";
  for (let j = 0; j < bytes.length; j += 3) {
    const b0 = bytes[j], b1 = bytes[j + 1], b2 = bytes[j + 2];
    out += B64[b0 >> 2];
    out += B64[(b0 & 3) << 4 | (b1 === void 0 ? 0 : b1 >> 4)];
    out += b1 === void 0 ? "=" : B64[(b1 & 15) << 2 | (b2 === void 0 ? 0 : b2 >> 6)];
    out += b2 === void 0 ? "=" : B64[b2 & 63];
  }
  return out;
}
function mapBwError(msg) {
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
function unwrapData(v) {
  if (v && typeof v === "object" && v.data !== void 0) {
    return v.data;
  }
  if (v && typeof v === "object" && v.template !== void 0) {
    return v.template;
  }
  return v;
}
function buildLoginCipher(req, existingId, folderId) {
  return {
    id: existingId || null,
    type: 1,
    name: req.name,
    notes: req.notes || null,
    folderId: folderId || null,
    organizationId: req.organization || null,
    collectionIds: req.collection ? [req.collection] : [],
    favorite: false,
    login: { username: null, password: req.value, totp: null, uris: [] }
  };
}
function isValidHttpUrl(s) {
  const t = (s || "").trim().toLowerCase();
  if (!(t.indexOf("http://") === 0 || t.indexOf("https://") === 0)) return false;
  return hostOf(s).length > 0;
}
function hostOf(s) {
  const afterScheme = (s || "").split("://")[1] || "";
  const hostPort = afterScheme.replace(/^\/+/, "").split(/[\/?#]/)[0];
  return (hostPort.split(":")[0] || "").toLowerCase();
}
function serverHostAllowed(url, allow) {
  if (!isValidHttpUrl(url)) return false;
  const h = hostOf(url);
  if (!h) return false;
  return (allow || []).some((a) => {
    const e = hostOf("https://" + (a || "")) || (a || "").toLowerCase().split(":")[0];
    return !!e && (h === e || h.lastIndexOf("." + e) === h.length - e.length - 1);
  });
}
function* effectiveAllow() {
  let allow = [];
  try {
    const m = host.manifest();
    const a = m && m.permissions && m.permissions.network && m.permissions.network.allow;
    if (Array.isArray(a)) allow = a.filter((x) => typeof x === "string");
  } catch (e) {
    allow = [];
  }
  const def = hostOf(DEFAULT_SERVER);
  if (def && allow.indexOf(def) < 0) allow.push(def);
  const configured = hostOf(yield* serverUrl());
  if (configured && allow.indexOf(configured) < 0) allow.push(configured);
  return allow;
}
function parseBwOutput(ex) {
  if (ex.truncated) return { success: false, message: "bw metadata exceeded host output limit" };
  if (ex.error) return { success: false, message: ex.error };
  try {
    return JSON.parse((ex.stdout || "").trim());
  } catch (e) {
    return { success: false, message: "bw output was not valid JSON (exit " + ex.code + ")" };
  }
}
function hostStringCall(name) {
  try {
    const h = host;
    const fn = h[name];
    if (typeof fn !== "function") return null;
    const value = fn();
    return typeof value === "string" && value.length ? value : null;
  } catch (e) {
    return null;
  }
}
function hostEnvGet(key) {
  try {
    const h = host;
    if (typeof h.envGet !== "function") return null;
    const value = h.envGet(key);
    return typeof value === "string" && value.length ? value : null;
  } catch (e) {
    return null;
  }
}
function expandedBwPath() {
  const platform = (hostStringCall("platform") || "").toLowerCase();
  if (platform.indexOf("win") >= 0) return null;
  const parts = [];
  const home = hostStringCall("homeDir");
  if (home) parts.push(`${home.replace(/\/+$/, "")}/.local/bin`);
  const currentPath = hostEnvGet("PATH");
  if (currentPath) parts.push.apply(parts, currentPath.split(":"));
  parts.push("/snap/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");
  const seen = {};
  const out = [];
  for (const part of parts) {
    if (!part || seen[part]) continue;
    seen[part] = true;
    out.push(part);
  }
  return out.length ? out.join(":") : null;
}
function bwExecOpts(args, opts) {
  const full = args.concat(["--nointeraction", "--response"]);
  const env = opts.env || {};
  if (opts.session) env.BW_SESSION = opts.session;
  const metadata = args[0] === "list" && args[1] === "items";
  const bin = metadata ? "node" : "bw";
  const commandArgs = metadata ? ["-e", METADATA_PROCESS, "--"].concat(full) : full;
  const path = expandedBwPath();
  if (path) {
    return JSON.stringify({ bin: "env", args: [`PATH=${path}`, bin].concat(commandArgs), env, stdin: opts.stdin || null, timeoutMs: opts.timeoutMs || BW_TIMEOUT_MS });
  }
  return JSON.stringify({ bin, args: commandArgs, env, stdin: opts.stdin || null, timeoutMs: opts.timeoutMs || BW_TIMEOUT_MS });
}
var serve = null;
var serveEpoch = 0;
var vaultRevision = 0;
var serveDisabledUntil = 0;
function* stopServe() {
  ++serveEpoch;
  const previous = serve;
  serve = null;
  if (!previous) return;
  try {
    if (previous.job) yield* ioValue({ op: "execClose", job: previous.job });
  } catch {
  }
  try {
    yield* host.io.fs.removeFile(previous.marker);
  } catch {
  }
}
function* startServe(session) {
  if (Date.now() < serveDisabledUntil || typeof host.dataDir !== "function") return;
  if (serve && serve.session !== session) yield* stopServe();
  if (!serve) {
    const epoch = serveEpoch;
    const root = host.dataDir() + "/bitwarden";
    const marker = root + "/bw-serve-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".json";
    const pending = { job: "", marker, session, epoch, port: void 0 };
    serve = pending;
    try {
      if (!(yield* host.io.fs.makeDirs(root))) throw new Error("serve storage unavailable");
      const env = { BW_SESSION: session, CT_BW_READY: marker };
      const path = expandedBwPath();
      if (path) env.PATH = path;
      if (serve !== pending || serveEpoch !== epoch) return;
      const started = yield { op: "execStart", options: { bin: "node", args: ["-e", SERVE_PROCESS], env, timeoutMs: 24 * 60 * 60 * 1e3 } };
      if (!started.jobId) throw new Error("serve start failed");
      pending.job = started.jobId;
      if (serve !== pending || serveEpoch !== epoch) {
        yield* ioValue({ op: "execClose", job: pending.job });
        return;
      }
    } catch {
      try {
        if (pending.job) yield* ioValue({ op: "execClose", job: pending.job });
      } catch {
      }
      try {
        yield* host.io.fs.removeFile(marker);
      } catch {
      }
      if (serve === pending) {
        serve = null;
        serveDisabledUntil = Date.now() + 3e4;
      }
      return;
    }
  }
}
function* serveGet(name, session) {
  yield* startServe(session);
  const current = serve;
  if (!current || !current.job) return null;
  const job = yield* ioValue({ op: "execPoll", job: current.job });
  if (job.done) {
    yield* stopServe();
    return null;
  }
  if (!current.port) {
    const ready = yield* host.io.fs.readJson(current.marker);
    if (ready && Number.isInteger(ready.port) && ready.port > 0 && ready.port <= 65535) current.port = ready.port;
    else return null;
  }
  try {
    yield* host.io.fs.writeFile(current.marker, JSON.stringify({ port: current.port }));
    const response = yield* host.io.fetch({ url: "http://127.0.0.1:" + current.port + "/object/item/" + encodeURIComponent(name), timeoutMs: 2e3 });
    if (serve !== current || serveEpoch !== current.epoch) return { success: false, message: "Vault is locked." };
    if (response.error) throw new Error("serve unavailable");
    const body = JSON.parse(response.body || "{}");
    if (typeof body.success !== "boolean") throw new Error("invalid serve response");
    if (!body.success && mapBwError(body.message).kind === "backend") throw new Error("serve unavailable");
    return body;
  } catch {
    if (serve === current) yield* stopServe();
    serveDisabledUntil = Date.now() + 3e4;
    return null;
  }
}
function* bw(args, opts) {
  opts = opts || {};
  if (args[0] === "get" && args[1] === "item" && opts.session) {
    const served = yield* serveGet(args[2], opts.session);
    if (served) return served;
  } else if (args[0] !== "status" && args[0] !== "list") {
    yield* stopServe();
    serveDisabledUntil = 0;
  }
  const raw = JSON.stringify(yield* host.io.exec(JSON.parse(bwExecOpts(args, opts))));
  let ex;
  try {
    ex = JSON.parse(raw);
  } catch (e) {
    return { success: false, message: "bw exec result was not valid JSON" };
  }
  return parseBwOutput(ex);
}
function extractSessionToken(data) {
  const d = data;
  const token = typeof d === "string" ? d : d && d.raw || d && d.template && d.template.raw;
  return (token || "").trim();
}
var autoUnlocking = false;
var lastRecoveryError = null;
function* tryAutoLogin(master) {
  const clientId = yield* ioValue({ op: "secretGet", name: K_CLIENT_ID });
  const clientSecret = yield* ioValue({ op: "secretGet", name: K_CLIENT_SECRET });
  const email = yield* ioValue({ op: "secretGet", name: K_EMAIL });
  let login;
  let usedApiKey = false;
  if (clientId && clientSecret) {
    usedApiKey = true;
    login = yield* bw(["login", "--apikey"], {
      env: { BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret }
    });
  } else if (email) {
    login = yield* bw(["login", email, "--passwordenv", "BW_PASSWORD"], {
      env: { BW_PASSWORD: master }
    });
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
      yield* ioValue({ op: "secretDelete", name: K_CLIENT_ID });
      yield* ioValue({ op: "secretDelete", name: K_CLIENT_SECRET });
    } else {
      yield* ioValue({ op: "secretDelete", name: K_MASTER });
    }
  }
  return false;
}
function* tryAutoUnlock() {
  if (autoUnlocking) return false;
  autoUnlocking = true;
  try {
    const master = yield* rememberedMasterPassword();
    if (master && master.length) {
      const status = yield* bwStatus();
      if (status.failure) {
        lastRecoveryError = { kind: "backend", message: status.failure.message };
        return false;
      }
      yield* rememberLoginIdentity(status);
      if (status.status && status.status.status === "unauthenticated" && !(yield* tryAutoLogin(master))) {
        return false;
      }
      const unlocked = yield* bw(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { env: { BW_PASSWORD: master } });
      if (!unlocked.success) {
        if (isRejectedCredential(unlocked.message)) {
          yield* ioValue({ op: "secretDelete", name: K_MASTER });
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
      yield* ioValue({ op: "secretSet", name: K_SESSION, value: token });
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
function* runWithSession(args, stdin) {
  let session = yield* ioValue({ op: "secretGet", name: K_SESSION });
  let triedUnlock = false;
  if (!session) {
    if (!(yield* canUnlockHeadlessly())) return { error: { kind: "locked", message: LOCKED_HINT } };
    if (!(yield* tryAutoUnlock())) return { error: lastRecoveryError || { kind: "locked", message: LOCKED_HINT } };
    triedUnlock = true;
    session = yield* ioValue({ op: "secretGet", name: K_SESSION });
    if (!session) return { error: { kind: "locked", message: LOCKED_HINT } };
  }
  let r = yield* bw(args, { session, stdin });
  if (!r.success) {
    const err = mapBwError(r.message);
    if ((err.kind === "locked" || err.kind === "logged_out") && !triedUnlock && (yield* canUnlockHeadlessly())) {
      yield* ioValue({ op: "secretDelete", name: K_SESSION });
      if (!(yield* tryAutoUnlock())) return { error: lastRecoveryError || err };
      const fresh = yield* ioValue({ op: "secretGet", name: K_SESSION });
      if (fresh) {
        r = yield* bw(args, { session: fresh, stdin });
        if (!r.success) return { error: mapBwError(r.message) };
        return { ok: unwrapData(r.data) };
      }
    }
    return { error: err };
  }
  return { ok: unwrapData(r.data) };
}
function settings() {
  try {
    return JSON.parse(host.settingsJson()) || {};
  } catch (e) {
    return {};
  }
}
function* serverUrl() {
  const s = settings();
  if (s.serverUrl && s.serverUrl.length) return s.serverUrl;
  const u = yield* ioValue({ op: "secretGet", name: "server_url" });
  return u && u.length ? u : DEFAULT_SERVER;
}
function isBinaryMissing(msg) {
  const m = (typeof msg === "string" ? msg : "").toLowerCase();
  return m.indexOf("no such file") >= 0 || m.indexOf("enoent") >= 0 || m.indexOf("cannot find") >= 0 || m.indexOf("executable file not found") >= 0 || m.indexOf("spawn") >= 0 && m.indexOf("bw") >= 0;
}
function bwExecToStatusResult(ex) {
  if (ex.error) {
    if (isBinaryMissing(ex.error)) {
      return { failure: { kind: "binary_missing", message: "Bitwarden CLI (bw) not found" } };
    }
    return { failure: { kind: "exec_error", message: "bw could not be started" } };
  }
  const resp = parseBwOutput(ex);
  if (!resp.success) return { failure: { kind: "bw_error", message: mapBwError(resp.message).message || "bw status failed" } };
  return { status: unwrapData(resp.data) };
}
function* bwStatus() {
  const session = yield* ioValue({ op: "secretGet", name: K_SESSION });
  const raw = JSON.stringify(yield* host.io.exec(JSON.parse(bwExecOpts(["status"], { session: session || void 0, timeoutMs: BW_STATUS_TIMEOUT_MS }))));
  let ex;
  try {
    ex = JSON.parse(raw);
  } catch (e) {
    return { failure: { kind: "exec_error", message: "bw exec result was not valid JSON" } };
  }
  return bwExecToStatusResult(ex);
}
function* rememberLoginIdentity(res) {
  const email = res.status && res.status.userEmail;
  if (email) yield* ioValue({ op: "secretSet", name: K_EMAIL, value: email });
}
function* statusFromBw(res) {
  const endpoint = yield* serverUrl();
  if (res.failure) return { status: "unavailable", reason: res.failure.message };
  const s = res.status;
  if (!s) return { status: "unavailable", reason: "bw status returned no data" };
  yield* rememberLoginIdentity(res);
  if (s.status === "unlocked") {
    return { status: "unlocked", user: s.userEmail || null, transient: false, endpoint: s.serverUrl || endpoint };
  }
  if (s.status === "locked") return { status: "locked", endpoint };
  return { status: "logged_out", endpoint };
}
function* secretStatus() {
  let st = yield* statusFromBw(yield* bwStatus());
  if (st.status === "locked" && !(yield* canUnlockHeadlessly())) {
    return { status: "locked", endpoint: st.endpoint, reason: LOCKED_HINT };
  }
  if ((st.status === "locked" || st.status === "logged_out") && (yield* canUnlockHeadlessly())) {
    if (yield* tryAutoUnlock()) st = yield* statusFromBw(yield* bwStatus());
    else if (lastRecoveryError) {
      st = { status: "unavailable", endpoint: st.endpoint, reason: lastRecoveryError.message || lastRecoveryError.kind };
    }
  }
  return st;
}
function* secretUnlock(creds) {
  ++vaultRevision;
  creds = creds || {};
  const hasPw = creds.masterPassword && creds.masterPassword.length;
  if (!hasPw && !creds.apiKeyClientId) {
    if ((yield* canUnlockHeadlessly()) && (yield* tryAutoUnlock())) return { ok: true };
    if (lastRecoveryError) return { error: lastRecoveryError };
    return { error: { kind: "bad_request", message: "master password (or API-key creds) required" } };
  }
  if (!hasPw) {
    return { error: { kind: "bad_request", message: "master password is required to unlock, even with API-key credentials" } };
  }
  const server = yield* serverUrl();
  if (!isValidHttpUrl(server)) {
    return { error: { kind: "bad_request", message: "invalid bitwarden server URL: " + server } };
  }
  if (!serverHostAllowed(server, yield* effectiveAllow())) {
    return { error: { kind: "bad_request", message: "server host not permitted by plugin network permissions: " + hostOf(server) } };
  }
  let statusResult = yield* bwStatus();
  yield* rememberLoginIdentity(statusResult);
  let st = statusResult.status;
  let loggedIn = !!st && st.status !== "unauthenticated";
  const currentServer = st && st.serverUrl || "";
  if (loggedIn && currentServer && currentServer !== server) {
    yield* bw(["logout"]);
    yield* ioValue({ op: "secretDelete", name: K_SESSION });
    loggedIn = false;
  }
  const serverChanged = currentServer !== server;
  if (serverChanged) {
    const cfg = yield* bw(["config", "server", server]);
    if (!cfg.success) return { error: { kind: "backend", message: "could not point bw at " + server } };
  }
  if (serverChanged) {
    statusResult = yield* bwStatus();
    yield* rememberLoginIdentity(statusResult);
    st = statusResult.status;
    loggedIn = !!st && st.status !== "unauthenticated";
  }
  if (!loggedIn) {
    let login;
    if (creds.apiKeyClientId && creds.apiKeyClientSecret) {
      login = yield* bw(["login", "--apikey"], { env: { BW_CLIENTID: creds.apiKeyClientId, BW_CLIENTSECRET: creds.apiKeyClientSecret } });
      if (login.success) {
        yield* ioValue({ op: "secretSet", name: K_CLIENT_ID, value: creds.apiKeyClientId });
        yield* ioValue({ op: "secretSet", name: K_CLIENT_SECRET, value: creds.apiKeyClientSecret });
      }
    } else if (creds.email) {
      let args = ["login", creds.email, "--passwordenv", "BW_PASSWORD"];
      if (creds.twoFactorToken) args = args.concat(["--method", "0", "--code", creds.twoFactorToken]);
      login = yield* bw(args, { env: { BW_PASSWORD: creds.masterPassword } });
    } else {
      return { error: { kind: "bad_request", message: "either email + master_password or api_key_* required" } };
    }
    if (!login.success && (login.message || "").toLowerCase().indexOf("already logged in") < 0) {
      return { error: mapBwError(login.message) };
    }
  }
  const unlocked = yield* bw(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { env: { BW_PASSWORD: creds.masterPassword } });
  if (!unlocked.success) return { error: mapBwError(unlocked.message) };
  const token = extractSessionToken(unlocked.data);
  if (!token) return { error: { kind: "backend", message: "bw unlock returned empty session" } };
  yield* ioValue({ op: "secretSet", name: K_SESSION, value: token });
  yield* startServe(token);
  yield* ioValue({ op: "secretSet", name: K_MASTER, value: creds.masterPassword });
  if (!creds.apiKeyClientId && creds.email) yield* ioValue({ op: "secretSet", name: K_EMAIL, value: creds.email });
  return { ok: true };
}
function* secretLock() {
  ++vaultRevision;
  yield* bw(["lock"]);
  yield* ioValue({ op: "secretDelete", name: K_SESSION });
  return { ok: true };
}
function* secretLogout() {
  ++vaultRevision;
  yield* bw(["logout"]);
  yield* clearStoredCredentials();
  return { ok: true };
}
function* clearStoredCredentials() {
  yield* ioValue({ op: "secretDelete", name: K_SESSION });
  yield* ioValue({ op: "secretDelete", name: K_MASTER });
  yield* ioValue({ op: "secretDelete", name: K_EMAIL });
  yield* ioValue({ op: "secretDelete", name: K_CLIENT_ID });
  yield* ioValue({ op: "secretDelete", name: K_CLIENT_SECRET });
}
function* resetConnection() {
  ++vaultRevision;
  const server = yield* serverUrl();
  if (!isValidHttpUrl(server)) {
    return { error: { kind: "bad_request", message: "invalid bitwarden server URL: " + server } };
  }
  if (!serverHostAllowed(server, yield* effectiveAllow())) {
    return { error: { kind: "bad_request", message: "server host not permitted by plugin network permissions: " + hostOf(server) } };
  }
  yield* bw(["logout"]);
  yield* clearStoredCredentials();
  const configured = yield* bw(["config", "server", server]);
  if (!configured.success) {
    return { error: { kind: "backend", message: "could not point bw at " + server } };
  }
  return { ok: true };
}
function isoToMs(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}
function metadataRefs(listed) {
  let v = listed;
  while (v && typeof v === "object" && !Array.isArray(v) && v.data !== void 0) {
    v = v.data;
  }
  if (!Array.isArray(v)) return null;
  for (const item of v) {
    if (!item || typeof item !== "object") return null;
    const c = item;
    for (const key of ["folderId", "organizationId", "revisionDate"]) {
      if (c[key] != null && typeof c[key] !== "string") return null;
    }
    if (c.collectionIds != null && (!Array.isArray(c.collectionIds) || !c.collectionIds.every((id) => typeof id === "string"))) return null;
  }
  return v.filter((c) => c && c.type === 1 && typeof c.id === "string" && typeof c.name === "string").map(toRef);
}
var UNEXPECTED_LIST = { error: { kind: "backend", message: "bw list returned an unexpected shape" } };
function toRef(c) {
  return {
    item_id: c.id,
    name: c.name,
    folder: c.folderId || null,
    organization: c.organizationId || null,
    collection: c.collectionIds && c.collectionIds[0] || null,
    last_modified: isoToMs(c.revisionDate)
  };
}
function* findByName(name) {
  const r = yield* runWithSession(["list", "items", "--search", name]);
  if ("error" in r) return r;
  const exact = (r.ok || []).filter((c) => c.type === 1 && c.name.toLowerCase() === name.toLowerCase());
  if (exact.length === 0) return { error: { kind: "not_found" } };
  if (exact.length > 1) return { error: { kind: "ambiguous", candidates: exact.map((c) => c.id) } };
  return { ok: exact[0] };
}
function* resolveFolderId(name) {
  if (!name) return { ok: null };
  const r = yield* runWithSession(["list", "folders"]);
  if ("error" in r) return r;
  const f = (r.ok || []).find((x) => x.name && x.name.toLowerCase() === name.toLowerCase());
  return { ok: f ? f.id : null };
}
function* resolveOrCreateFolder(name) {
  const existing = yield* resolveFolderId(name);
  if ("error" in existing) return existing;
  if (existing.ok) return existing;
  const encoded = base64Encode(JSON.stringify({ name }));
  const r = yield* runWithSession(["create", "folder", encoded]);
  if ("error" in r) return r;
  const created = r.ok;
  return { ok: created && created.id || null };
}
function* secretSave(req) {
  if (!req.name) return { error: { kind: "bad_request", message: "name required" } };
  if (!req.value) return { error: { kind: "bad_request", message: "value must not be empty" } };
  const existing = yield* findByName(req.name);
  const existingItem = "ok" in existing && existing.ok || null;
  if (existingItem && !req.overwrite) return { error: { kind: "already_exists" } };
  let folderId = null;
  if (req.folder) {
    const f = yield* resolveOrCreateFolder(req.folder);
    if ("error" in f) return f;
    folderId = f.ok;
  }
  const cipher = buildLoginCipher(req, existingItem ? existingItem.id : null, folderId);
  const encoded = base64Encode(JSON.stringify(cipher));
  const r = existingItem ? yield* runWithSession(["edit", "item", existingItem.id, encoded]) : yield* runWithSession(["create", "item", encoded]);
  if ("error" in r) return r;
  yield* runWithSession(["sync"]);
  return { ok: toRef(r.ok) };
}
function* secretGetItem(nameOrId) {
  const revision = vaultRevision;
  const r = yield* runWithSession(["get", "item", nameOrId]);
  if ("error" in r) return r;
  if (revision !== vaultRevision) return { error: { kind: "locked" } };
  const item = r.ok;
  const value = item.login && item.login.password;
  if (value === void 0 || value === null) return { error: { kind: "backend", message: "item has no login.password field" } };
  return { ok: { item_id: item.id, name: item.name, value, notes: item.notes || null } };
}
function* listMetadata(filter) {
  filter = filter || {};
  let args = ["list", "items"];
  if (filter.organization) args = args.concat(["--organizationid", filter.organization]);
  if (filter.collection) args = args.concat(["--collectionid", filter.collection]);
  const r = yield* runWithSession(args);
  if ("error" in r) return r;
  let items = metadataRefs(r.ok);
  if (!items) return UNEXPECTED_LIST;
  if (filter.folder) {
    const fid = yield* resolveFolderId(filter.folder);
    if ("error" in fid) return fid;
    items = items.filter((c) => c.folder === (fid.ok || null));
  }
  items.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
  if (filter.limit) items = items.slice(0, filter.limit);
  return { ok: items };
}
function* searchMetadata(query) {
  const q = (query || "").trim();
  if (!q) return { error: { kind: "bad_request", message: "query must not be empty" } };
  const r = yield* runWithSession(["list", "items", "--search", q]);
  if ("error" in r) return r;
  const items = metadataRefs(r.ok);
  return items ? { ok: items } : UNEXPECTED_LIST;
}
function* secretList(filter) {
  try {
    return yield* listMetadata(filter);
  } catch {
    return { error: { kind: "backend", message: "bw metadata request failed" } };
  }
}
function* secretSearch(query) {
  try {
    return yield* searchMetadata(query);
  } catch {
    return { error: { kind: "backend", message: "bw metadata request failed" } };
  }
}
function* secretDelete(nameOrId) {
  const item = yield* runWithSession(["get", "item", nameOrId]);
  if ("error" in item) return item;
  const r = yield* runWithSession(["delete", "item", item.ok.id, "--permanent"]);
  if ("error" in r) return r;
  yield* runWithSession(["sync"]);
  return { ok: true };
}
function* secretOrganizations() {
  const r = yield* runWithSession(["list", "organizations"]);
  if ("error" in r) return r;
  return { ok: (r.ok || []).map((v) => ({ id: v.id, name: v.name })) };
}
function* secretCollections(orgId) {
  let args = ["list", "collections"];
  if (orgId) args = args.concat(["--organizationid", orgId]);
  const r = yield* runWithSession(args);
  if ("error" in r) return r;
  return { ok: (r.ok || []).map((v) => ({ id: v.id, name: v.name, organization_id: v.organizationId || null })) };
}
function* secretSync() {
  const r = yield* runWithSession(["sync"]);
  if ("error" in r) return r;
  return { ok: true };
}
function secretInit() {
  return { ok: true };
}
function* statusStart() {
  const session = yield* ioValue({ op: "secretGet", name: K_SESSION });
  const optsJson = bwExecOpts(["status"], { session: session || void 0 });
  let res;
  try {
    res = yield* ioValue({ op: "execStart", options: JSON.parse(optsJson) });
  } catch (e) {
    return { error: "exec start: " + e };
  }
  if (res.error) return { error: res.error };
  if (res.jobId) statusFlows[res.jobId] = { hostJobId: res.jobId, phase: "status" };
  return { jobId: res.jobId };
}
var statusFlows = {};
function* startFlowJob(flowId, phase, args, opts, usedApiKey) {
  let started;
  try {
    started = yield* ioValue({ op: "execStart", options: JSON.parse(bwExecOpts(args, opts)) });
  } catch (e) {
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
function* startFlowLogin(flowId, master) {
  const clientId = yield* ioValue({ op: "secretGet", name: K_CLIENT_ID });
  const clientSecret = yield* ioValue({ op: "secretGet", name: K_CLIENT_SECRET });
  const email = yield* ioValue({ op: "secretGet", name: K_EMAIL });
  if (clientId && clientSecret) {
    return !!(yield* startFlowJob(flowId, "login", ["login", "--apikey"], {
      env: { BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret }
    }, true));
  }
  if (email) {
    return !!(yield* startFlowJob(flowId, "login", ["login", email, "--passwordenv", "BW_PASSWORD"], {
      env: { BW_PASSWORD: master }
    }, false));
  }
  lastRecoveryError = { kind: "logged_out", message: "stored Bitwarden login identity is missing" };
  return false;
}
function* flowFailure(flowId, message, usedApiKey) {
  lastRecoveryError = mapBwError(message);
  if (isRejectedCredential(message)) {
    if (usedApiKey) {
      yield* ioValue({ op: "secretDelete", name: K_CLIENT_ID });
      yield* ioValue({ op: "secretDelete", name: K_CLIENT_SECRET });
    } else {
      yield* ioValue({ op: "secretDelete", name: K_MASTER });
    }
  }
  delete statusFlows[flowId];
  return {
    done: true,
    status: { status: "unavailable", endpoint: yield* serverUrl(), reason: lastRecoveryError.message || lastRecoveryError.kind }
  };
}
function* statusPoll(jobId) {
  if (!jobId) return { done: true, error: "no jobId" };
  const flow = statusFlows[jobId] || { hostJobId: jobId, phase: "status" };
  let p;
  try {
    p = JSON.parse(yield* ioEncoded(ioValue({ op: "execPoll", job: flow.hostJobId })));
  } catch (e) {
    delete statusFlows[jobId];
    return { done: true, error: "exec poll: " + e };
  }
  if (!p.done) return { done: false };
  const response = parseBwOutput(p);
  if (flow.phase === "login") {
    if (!response.success && (response.message || "").toLowerCase().indexOf("already logged in") < 0) {
      return yield* flowFailure(jobId, response.message, flow.usedApiKey);
    }
    const master2 = yield* rememberedMasterPassword();
    if (!master2 || !(yield* startFlowJob(jobId, "unlock", ["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], {
      env: { BW_PASSWORD: master2 || "" }
    }))) {
      delete statusFlows[jobId];
      return { done: true, status: { status: "unavailable", endpoint: yield* serverUrl(), reason: lastRecoveryError && (lastRecoveryError.message || lastRecoveryError.kind) || LOCKED_HINT } };
    }
    return { done: false };
  }
  if (flow.phase === "unlock") {
    if (!response.success) return yield* flowFailure(jobId, response.message);
    const token = extractSessionToken(response.data);
    if (!token) return yield* flowFailure(jobId, "bw unlock returned no session token");
    yield* ioValue({ op: "secretSet", name: K_SESSION, value: token });
    yield* startServe(token);
    lastRecoveryError = null;
    delete statusFlows[jobId];
    return { done: true, status: { status: "unlocked", user: yield* ioValue({ op: "secretGet", name: K_EMAIL }), transient: false, endpoint: yield* serverUrl() } };
  }
  const statusResult = bwExecToStatusResult(p);
  const status = yield* statusFromBw(statusResult);
  if (status.status !== "locked" && status.status !== "logged_out" || !(yield* canUnlockHeadlessly())) {
    delete statusFlows[jobId];
    return { done: true, status };
  }
  const master = (yield* rememberedMasterPassword()) || "";
  const started = status.status === "logged_out" ? yield* startFlowLogin(jobId, master) : !!(yield* startFlowJob(jobId, "unlock", ["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], { env: { BW_PASSWORD: master } }));
  if (!started) {
    delete statusFlows[jobId];
    return { done: true, status: { status: "unavailable", endpoint: status.endpoint, reason: lastRecoveryError && (lastRecoveryError.message || lastRecoveryError.kind) || LOCKED_HINT } };
  }
  return { done: false };
}
function* renderGlance() {
  const s = yield* secretStatus();
  const nodes = [];
  if (s.status === "unlocked") {
    nodes.push({ kind: "badge", label: "Unlocked", tone: "ok" });
    nodes.push({ kind: "keyVal", key: "Account", value: s.user || "\u2014" });
    if (s.endpoint) nodes.push({ kind: "keyVal", key: "Server", value: s.endpoint });
  } else if (s.status === "locked") {
    nodes.push({ kind: "badge", label: "Locked", tone: "warn" });
    nodes.push({ kind: "text", text: "Vault is locked \u2014 unlock it in settings.", style: { tone: "muted" } });
  } else if (s.status === "unavailable") {
    nodes.push({ kind: "badge", label: "Unavailable", tone: "danger" });
    nodes.push({ kind: "note", body: s.reason || "The Bitwarden CLI isn't available.", level: "error" });
  } else {
    nodes.push({ kind: "badge", label: "Not signed in", tone: "danger" });
    if (s.endpoint) nodes.push({ kind: "keyVal", key: "Server", value: s.endpoint });
  }
  nodes.push({ kind: "divider" });
  nodes.push({ kind: "button", label: "Open settings", action: "settings" });
  return { title: "Bitwarden", nodes };
}
function* viewCall(method, args) {
  args = args || {};
  if (method === "status") return yield* secretStatus();
  if (method === "statusStart") return yield* statusStart();
  if (method === "statusPoll") return yield* statusPoll(args.jobId || "");
  if (method === "serverUrl") return { url: yield* serverUrl() };
  if (method === "setServerUrl") {
    const url = (args.url || "").trim();
    if (url && !isValidHttpUrl(url)) return { error: "invalid server URL" };
    yield* ioValue({ op: "secretSet", name: "server_url", value: url });
    return { ok: true };
  }
  if (method === "unlock") {
    return yield* secretUnlock({
      masterPassword: args.masterPassword,
      email: args.email,
      twoFactorToken: args.twoFactorToken,
      apiKeyClientId: args.apiKeyClientId,
      apiKeyClientSecret: args.apiKeyClientSecret
    });
  }
  if (method === "resetConnection") return yield* resetConnection();
  if (method === "signout") return yield* secretLogout();
  if (method === "organizations") {
    const o = yield* secretOrganizations();
    return { organizations: "ok" in o && o.ok || [] };
  }
  if (method === "collections") {
    const c = yield* secretCollections(args.organization);
    return { collections: "ok" in c && c.ok || [] };
  }
  return { error: "unknown view method: " + method };
}
var plugin = defineProviderIo({
  secretStatus,
  renderGlance,
  viewCall,
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
  __test_statusFromExec: (ex) => bwExecToStatusResult(ex),
  __test_unwrap: unwrapData,
  __test_buildCipher: buildLoginCipher,
  __test_hostOf: hostOf,
  __test_serverHostAllowed: serverHostAllowed,
  __test_bwExecOpts: bwExecOpts
}, () => host.io);
var plugin_default = defineProviderIo(plugin, () => host.io);
