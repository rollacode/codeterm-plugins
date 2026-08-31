// Plugin-side tests for the Bitwarden secret-backend plugin.
// Run: npx tsx plugins/bitwarden/plugin.test.cjs
//
// Bitwarden behaviour lives with the plugin, not in CodeTerm core — core only
// tests the generic JsSecretBackend seam. These exercise the pure helpers
// (no host.exec): base64, bw error-message mapping, list-envelope unwrap, and
// login-cipher shape.

// The plugin references `host` only inside methods, never at module load, so a
// bare require is safe. Stub it anyway so an accidental top-level call is loud.
globalThis.host = new Proxy(
  {},
  { get: () => () => { throw new Error("host called at load time"); } },
);

const { copyFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const testBundle = join(__dirname, ".plugin-test.cjs");
copyFileSync(join(__dirname, "plugin.js"), testBundle);
const plugin = require(testBundle).default;
process.on("exit", () => rmSync(testBundle, { force: true }));

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

test("base64 — standard encoding", () => {
  assert(plugin.__test_base64("hello") === "aGVsbG8=", "base64 of 'hello'");
});

test("bw error-message mapping", () => {
  assert(plugin.__test_mapError("Vault is locked.").kind === "locked", "locked");
  assert(plugin.__test_mapError("Item Not found.").kind === "not_found", "not_found");
  assert(plugin.__test_mapError("You are not logged in.").kind === "logged_out", "logged_out");
  assert(
    plugin.__test_mapError("An item with that name already exists.").kind === "already_exists",
    "already_exists",
  );
});

test("list-envelope unwrap", () => {
  const out = plugin.__test_unwrap({ object: "list", data: [1, 2] });
  assert(Array.isArray(out) && out.length === 2 && out[0] === 1 && out[1] === 2, "unwrap data array");
});

test("login-cipher shape (type=1, password in login)", () => {
  const cipher = plugin.__test_buildCipher({ name: "n", value: "p", notes: null }, null, null);
  assert(cipher.type === 1, "type 1 login");
  assert(cipher.name === "n", "name");
  assert(cipher.login.password === "p", "password in login");
});

// ── network-scope (server URL host allow-list) ──

test("hostOf extracts lowercased host, strips port/path", () => {
  const h = plugin.__test_hostOf;
  assert(h("https://vault.bitwarden.com") === "vault.bitwarden.com", "plain host");
  assert(h("https://Vault.Bitwarden.com:8443/path?x") === "vault.bitwarden.com", "port/path stripped + lowercased");
  assert(h("not a url") === "", "no scheme → empty");
});

test("serverHostAllowed honours allow-list incl. subdomains, rejects others", () => {
  const allowed = plugin.__test_serverHostAllowed;
  const allow = ["vault.bitwarden.com"];
  assert(allowed("https://vault.bitwarden.com", allow) === true, "exact host allowed");
  assert(allowed("https://vault.bitwarden.com/path", allow) === true, "path ignored");
  assert(allowed("https://eu.vault.bitwarden.com", ["bitwarden.com"]) === true, "subdomain of allowed base");
  assert(allowed("https://evil.com", allow) === false, "unlisted host rejected");
  assert(allowed("https://notbitwarden.com", ["bitwarden.com"]) === false, "non-suffix lookalike rejected");
  assert(allowed("ftp://vault.bitwarden.com", allow) === false, "non-http scheme rejected");
  assert(allowed("https://vault.bitwarden.com", []) === false, "empty allow-list rejects all");
});

test("bw exec expands PATH with user-local bin on Unix", () => {
  globalThis.host = {
    platform: () => "linux",
    homeDir: () => "/home/test",
    envGet: (key) => key === "PATH" ? "/usr/bin:/bin" : null,
  };
  const opts = JSON.parse(plugin.__test_bwExecOpts(["status"], {}));
  assert(opts.bin === "env", "uses env wrapper");
  assert(opts.args[0] === "PATH=/home/test/.local/bin:/usr/bin:/bin:/snap/bin:/opt/homebrew/bin:/usr/local/bin", "expanded PATH");
  assert(opts.args[1] === "bw", "runs bw through env PATH");
  assert(opts.args.includes("status"), "preserves bw args");
});

// ── manifest (Track S) ──

test("plugin.json carries a non-empty configHelp", () => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"));
  assert(typeof manifest.configHelp === "string" && manifest.configHelp.trim().length > 0, "configHelp is a non-empty string");
});

// ── auto-unlock parity (RED until Phase 3) ──
// When the vault session is absent/expired but a master password is persisted,
// a session op must auto-unlock (bw unlock --passwordenv) and retry, returning
// the value. Functional host mock: exec succeeds only with a valid session.

test("auto-unlock: no session + persisted master password → op retries and returns the value", () => {
  const MASTER = "correct-horse-battery-staple";
  const SESSION = "SESSION-TOKEN-XYZ";
  const ITEM = {
    object: "item", id: "id-1", type: 1, name: "db-pw", notes: null,
    login: { username: null, password: "s3cr3t-value", totp: null, uris: [] },
  };
  const secrets = { master_password: MASTER }; // note: no "session" → locked
  let unlockCalls = 0;

  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: (optsJson) => {
      const o = JSON.parse(optsJson);
      const args = o.args || [];
      const env = o.env || {};
      let body;
      if (args.indexOf("status") >= 0) {
        body = { success: true, data: { status: "locked" } };
      } else if (args.indexOf("unlock") >= 0) {
        unlockCalls += 1;
        body = env.BW_PASSWORD === MASTER
          ? { success: true, data: { object: "message", raw: SESSION } }
          : { success: false, message: "Invalid master password." };
      } else {
        body = env.BW_SESSION === SESSION
          ? { success: true, data: ITEM }
          : { success: false, message: "Vault is locked." };
      }
      return JSON.stringify({ stdout: JSON.stringify(body), stderr: "", code: body.success ? 0 : 1 });
    },
  };

  try {
    const r = plugin.secretGetItem("db-pw");
    assert("ok" in r, "expected auto-unlock+retry to return the item, got " + JSON.stringify(r));
    assert(r.ok.value === "s3cr3t-value", "expected the decrypted secret value");
    assert(unlockCalls === 1, "expected exactly one auto-unlock attempt, got " + unlockCalls);
  } finally {
    globalThis.host = savedHost;
  }
});

test("auto-relogin: logged-out email account logs in, unlocks, and completes the operation once", () => {
  const MASTER = "correct-horse-battery-staple";
  const EMAIL = "owner@example.com";
  const SESSION = "SESSION-AFTER-LOGIN";
  const secrets = { master_password: MASTER, login_email: EMAIL };
  const calls = [];
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: (optsJson) => {
      const o = JSON.parse(optsJson);
      const args = o.args || [], env = o.env || {};
      calls.push({ args, env });
      let body;
      if (args.includes("status")) body = { success: true, data: { status: "unauthenticated" } };
      else if (args.includes("login")) body = env.BW_PASSWORD === MASTER ? { success: true, data: {} } : { success: false, message: "Invalid credentials" };
      else if (args.includes("unlock")) body = env.BW_PASSWORD === MASTER ? { success: true, data: { raw: SESSION } } : { success: false, message: "Invalid master password" };
      else body = env.BW_SESSION === SESSION
        ? { success: true, data: { id: "id-1", type: 1, name: "publish-token", login: { password: "value" } } }
        : { success: false, message: "You are not logged in." };
      return JSON.stringify({ stdout: JSON.stringify(body), stderr: "", code: body.success ? 0 : 1 });
    },
  };
  try {
    const r = plugin.secretGetItem("publish-token");
    assert("ok" in r && r.ok.value === "value", "expected recovered operation, got " + JSON.stringify(r));
    assert(calls.filter((c) => c.args.includes("login")).length === 1, "expected one login");
    assert(calls.filter((c) => c.args.includes("unlock")).length === 1, "expected one unlock");
    assert(calls.filter((c) => c.args.includes("get")).length === 1, "expected one operation attempt");
    assert(calls.every((c) => !c.args.includes(MASTER)), "master password must never enter argv");
    assert(secrets.session === SESSION, "fresh session must be persisted");
  } finally {
    globalThis.host = savedHost;
  }
});

test("auto-relogin: API-key account restores login without exposing credentials in argv", () => {
  const MASTER = "master-password";
  const CLIENT_ID = "client-id";
  const CLIENT_SECRET = "client-secret";
  const SESSION = "API-SESSION";
  const secrets = {
    master_password: MASTER,
    api_client_id: CLIENT_ID,
    api_client_secret: CLIENT_SECRET,
  };
  const calls = [];
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: (optsJson) => {
      const o = JSON.parse(optsJson);
      const args = o.args || [], env = o.env || {};
      calls.push({ args, env });
      let body;
      if (args.includes("status")) body = { success: true, data: { status: "unauthenticated" } };
      else if (args.includes("login")) body = env.BW_CLIENTID === CLIENT_ID && env.BW_CLIENTSECRET === CLIENT_SECRET
        ? { success: true, data: {} }
        : { success: false, message: "Invalid credentials" };
      else if (args.includes("unlock")) body = env.BW_PASSWORD === MASTER ? { success: true, data: { raw: SESSION } } : { success: false, message: "Invalid master password" };
      else body = env.BW_SESSION === SESSION ? { success: true, data: [] } : { success: false, message: "You are not logged in." };
      return JSON.stringify({ stdout: JSON.stringify(body), stderr: "", code: body.success ? 0 : 1 });
    },
  };
  try {
    const r = plugin.secretList({});
    assert("ok" in r, "expected API-key recovery, got " + JSON.stringify(r));
    const login = calls.find((c) => c.args.includes("login"));
    assert(login && login.args.includes("--apikey"), "expected API-key login");
    assert(login.env.BW_CLIENTID === CLIENT_ID && login.env.BW_CLIENTSECRET === CLIENT_SECRET, "API credentials must be environment-only");
    assert(calls.every((c) => !c.args.includes(CLIENT_ID) && !c.args.includes(CLIENT_SECRET) && !c.args.includes(MASTER)), "credentials must never enter argv");
    assert(secrets.session === SESSION, "fresh API session must be persisted");
  } finally {
    globalThis.host = savedHost;
  }
});

test("auto-relogin: stale session receives one bounded login-unlock-retry cycle", () => {
  const MASTER = "master-password";
  const SESSION = "fresh-session";
  const secrets = { session: "stale-session", master_password: MASTER, login_email: "owner@example.com" };
  let operationCalls = 0;
  let loginCalls = 0;
  let unlockCalls = 0;
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: (optsJson) => {
      const o = JSON.parse(optsJson);
      const args = o.args || [], env = o.env || {};
      let body;
      if (args.includes("status")) body = { success: true, data: { status: "unauthenticated" } };
      else if (args.includes("login")) { loginCalls++; body = { success: true, data: {} }; }
      else if (args.includes("unlock")) { unlockCalls++; body = { success: true, data: { raw: SESSION } }; }
      else {
        operationCalls++;
        body = env.BW_SESSION === SESSION
          ? { success: true, data: { id: "id-1", type: 1, name: "token", login: { password: "value" } } }
          : { success: false, message: "You are not logged in." };
      }
      return JSON.stringify({ stdout: JSON.stringify(body), stderr: "", code: body.success ? 0 : 1 });
    },
  };
  try {
    const r = plugin.secretGetItem("token");
    assert("ok" in r, "expected stale-session recovery, got " + JSON.stringify(r));
    assert(operationCalls === 2, "operation must run once before and once after recovery");
    assert(loginCalls === 1 && unlockCalls === 1, "recovery must be exactly one login and one unlock");
  } finally {
    globalThis.host = savedHost;
  }
});

test("auto-relogin: server login failure is surfaced and keeps persisted credentials", () => {
  const MASTER = "master-password";
  const secrets = { master_password: MASTER, login_email: "owner@example.com" };
  let loginCalls = 0;
  let unlockCalls = 0;
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: (optsJson) => {
      const args = JSON.parse(optsJson).args || [];
      let body;
      if (args.includes("status")) body = { success: true, data: { status: "unauthenticated" } };
      else if (args.includes("login")) { loginCalls++; body = { success: false, message: "Error saving device" }; }
      else if (args.includes("unlock")) { unlockCalls++; body = { success: true, data: { raw: "unexpected" } }; }
      else body = { success: false, message: "You are not logged in." };
      return JSON.stringify({ stdout: JSON.stringify(body), stderr: "", code: body.success ? 0 : 1 });
    },
  };
  try {
    const r = plugin.secretGetItem("token");
    assert("error" in r && r.error.kind === "backend" && r.error.message === "Error saving device", "expected server failure, got " + JSON.stringify(r));
    assert(loginCalls === 1 && unlockCalls === 0, "failed login must stop before unlock");
    assert(secrets.master_password === MASTER, "transient server failure must retain the password");
  } finally {
    globalThis.host = savedHost;
  }
});

test("async status: logged-out vault advances through login and unlock jobs", () => {
  const MASTER = "master-password";
  const SESSION = "async-session";
  const secrets = { master_password: MASTER, login_email: "owner@example.com" };
  const jobs = {};
  const polled = [];
  let nextJob = 1;
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    execStart: (optsJson) => {
      const opts = JSON.parse(optsJson);
      const id = "job-" + nextJob++;
      jobs[id] = opts;
      return JSON.stringify({ jobId: id });
    },
    execPoll: (id) => {
      polled.push(id);
      const opts = jobs[id];
      const args = opts.args || [];
      let body;
      if (args.includes("status")) body = { success: true, data: { status: "unauthenticated" } };
      else if (args.includes("login")) body = { success: true, data: {} };
      else body = { success: true, data: { raw: SESSION } };
      return JSON.stringify({ done: true, stdout: JSON.stringify(body), stderr: "", code: 0 });
    },
  };
  try {
    const started = plugin.viewCall("statusStart", {});
    assert(started.jobId === "job-1", "expected stable flow id");
    assert(plugin.viewCall("statusPoll", { jobId: started.jobId }).done === false, "status should advance to login");
    assert(plugin.viewCall("statusPoll", { jobId: started.jobId }).done === false, "login should advance to unlock");
    const done = plugin.viewCall("statusPoll", { jobId: started.jobId });
    assert(done.done === true && done.status.status === "unlocked", "expected unlocked, got " + JSON.stringify(done));
    assert(polled.join(",") === "job-1,job-2,job-3", "expected event-driven job chain, got " + polled.join(","));
    assert(secrets.session === SESSION, "async unlock must persist the fresh session");
    assert(Object.values(jobs).every((j) => !(j.args || []).includes(MASTER)), "master password must never enter argv");
  } finally {
    globalThis.host = savedHost;
  }
});

test("successful unlock always persists the master password for auto-unlock", () => {
  const MASTER = "hunter2";
  const SESSION = "SESS-OFF";
  const secrets = {};
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: (optsJson) => {
      const o = JSON.parse(optsJson);
      const args = o.args || [], env = o.env || {};
      let body;
      if (args.indexOf("status") >= 0) body = { success: true, data: { status: "locked", serverUrl: "https://vault.bitwarden.com" } };
      else if (args.indexOf("unlock") >= 0) body = env.BW_PASSWORD === MASTER ? { success: true, data: { raw: SESSION } } : { success: false, message: "Invalid master password." };
      else body = { success: true, data: {} };
      return JSON.stringify({ stdout: JSON.stringify(body), stderr: "", code: body.success ? 0 : 1 });
    },
  };
  try {
    const r = plugin.secretUnlock({ masterPassword: MASTER, email: "a@b.c" });
    assert("ok" in r, "expected unlock ok, got " + JSON.stringify(r));
    assert(secrets.session === SESSION, "session must be persisted");
    assert(secrets.master_password === MASTER, "K_MASTER must always be persisted");
  } finally {
    globalThis.host = savedHost;
  }
});

test("locked identity survives a later CLI logout for headless recovery", () => {
  const MASTER = "master-password";
  const EMAIL = "owner@example.com";
  const SESSION_1 = "first-session";
  const SESSION_2 = "recovered-session";
  const secrets = {};
  let state = "locked";
  let unlocks = 0;
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: (optsJson) => {
      const o = JSON.parse(optsJson);
      const args = o.args || [], env = o.env || {};
      let body;
      if (args.includes("status")) {
        body = { success: true, data: { status: state, userEmail: state === "locked" ? EMAIL : undefined, serverUrl: "https://vault.bitwarden.com" } };
      } else if (args.includes("login")) {
        state = "locked";
        body = env.BW_PASSWORD === MASTER ? { success: true, data: {} } : { success: false, message: "Invalid credentials" };
      } else if (args.includes("unlock")) {
        unlocks += 1;
        state = "unlocked";
        body = env.BW_PASSWORD === MASTER ? { success: true, data: { raw: unlocks === 1 ? SESSION_1 : SESSION_2 } } : { success: false, message: "Invalid master password" };
      } else {
        body = env.BW_SESSION === SESSION_2
          ? { success: true, data: { id: "id-1", type: 1, name: "token", login: { password: "value" } } }
          : { success: false, message: "You are not logged in." };
      }
      return JSON.stringify({ stdout: JSON.stringify(body), stderr: "", code: body.success ? 0 : 1 });
    },
  };
  try {
    const unlocked = plugin.secretUnlock({ masterPassword: MASTER });
    assert("ok" in unlocked, "expected locked vault unlock, got " + JSON.stringify(unlocked));
    assert(secrets.login_email === EMAIL, "locked status identity must be persisted");

    state = "unauthenticated";
    delete secrets.session;
    const recovered = plugin.secretGetItem("token");
    assert("ok" in recovered && recovered.ok.value === "value", "expected relogin recovery, got " + JSON.stringify(recovered));
    assert(unlocks === 2, "expected initial and recovery unlocks only, got " + unlocks);
  } finally {
    globalThis.host = savedHost;
  }
});

// ── empty-creds unlock triggers auto-unlock (mem secret unlock no-arg) ──

test("empty-creds unlock: no input + persisted master → auto-unlock succeeds", () => {
  const MASTER = "hunter2";
  const SESSION = "SESS-EMPTY";
  const secrets = { master_password: MASTER };
  let unlockCalls = 0;
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: (optsJson) => {
      const o = JSON.parse(optsJson);
      const args = o.args || [], env = o.env || {};
      let body;
      if (args.indexOf("unlock") >= 0) { unlockCalls += 1; body = env.BW_PASSWORD === MASTER ? { success: true, data: { raw: SESSION } } : { success: false, message: "Invalid master password." }; }
      else body = { success: true, data: {} };
      return JSON.stringify({ stdout: JSON.stringify(body), stderr: "", code: body.success ? 0 : 1 });
    },
  };
  try {
    const r = plugin.secretUnlock({});
    assert("ok" in r, "expected empty-creds unlock to auto-unlock, got " + JSON.stringify(r));
    assert(secrets.session === SESSION, "session must be set by auto-unlock");
    assert(unlockCalls === 1, "expected exactly one unlock, got " + unlockCalls);
  } finally {
    globalThis.host = savedHost;
  }
});

test("empty-creds unlock: no input + nothing persisted → bad_request", () => {
  const secrets = {};
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: () => JSON.stringify({ stdout: JSON.stringify({ success: false, message: "no creds" }), code: 1 }),
  };
  try {
    const r = plugin.secretUnlock({});
    assert("error" in r && r.error.kind === "bad_request", "expected bad_request with nothing persisted, got " + JSON.stringify(r));
  } finally {
    globalThis.host = savedHost;
  }
});

// ── status cause mapping (R3): the real failure survives to `reason` ──

test("status cause: bw binary missing → unavailable with probed detail", () => {
  const secrets = {};
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: () => JSON.stringify({ error: "spawn bw: No such file or directory" }),
  };
  try {
    const s = plugin.secretStatus();
    assert(s.status === "unavailable", "expected unavailable, got " + JSON.stringify(s));
    assert(/No such file/i.test(s.reason || ""), "reason must surface the exec error, got " + s.reason);
  } finally {
    globalThis.host = savedHost;
  }
});

test("status cause: bw-level error passes the bw message through", () => {
  const secrets = {};
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: () => JSON.stringify({ stdout: JSON.stringify({ success: false, message: "Server is unreachable" }), code: 1 }),
  };
  try {
    const s = plugin.secretStatus();
    assert(s.status === "unavailable", "expected unavailable, got " + JSON.stringify(s));
    assert(/unreachable/i.test(s.reason || ""), "reason must pass the bw message through, got " + s.reason);
  } finally {
    globalThis.host = savedHost;
  }
});

test("locked with nothing remembered: status answers once and names the way out", () => {
  const secrets = {};
  const savedHost = globalThis.host;
  let execs = 0;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: () => {
      execs++;
      return JSON.stringify({ stdout: JSON.stringify({ success: true, data: { status: "locked" } }), code: 0 });
    },
  };
  try {
    const s = plugin.secretStatus();
    assert(s.status === "locked", "expected locked, got " + JSON.stringify(s));
    assert(/unlock/i.test(s.reason || ""), "a terminal lock must name the way out, got " + s.reason);
    assert(execs === 1, "one bw invocation is enough to know, ran " + execs);
  } finally {
    globalThis.host = savedHost;
  }
});

test("locked with nothing remembered: an operation fails structurally without running bw", () => {
  const secrets = {};
  const savedHost = globalThis.host;
  let execs = 0;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: () => { execs++; return JSON.stringify({ stdout: "{}", code: 0 }); },
  };
  try {
    const r = plugin.secretGetItem("example");
    const err = r && r.error;
    assert(err && err.kind === "locked", "expected a locked envelope, got " + JSON.stringify(r));
    assert(/unlock/i.test(err.message || ""), "the error must name the way out, got " + err.message);
    assert(execs === 0, "a headlessly-unopenable vault needs no bw call, ran " + execs);
  } finally {
    globalThis.host = savedHost;
  }
});

test("bw status runs on its own shorter budget than a full command", () => {
  const secrets = {};
  const savedHost = globalThis.host;
  const budgets = [];
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: (optsJson) => {
      budgets.push(JSON.parse(optsJson).timeoutMs);
      return JSON.stringify({ stdout: JSON.stringify({ success: true, data: { status: "locked" } }), code: 0 });
    },
  };
  try {
    plugin.secretStatus();
    assert(budgets.length === 1, "expected one status call, got " + budgets.length);
    assert(budgets[0] < 30000, "status must not book the full command budget, got " + budgets[0]);
  } finally {
    globalThis.host = savedHost;
  }
});

test("a rejected master password is forgotten, so the next call fails fast", () => {
  const secrets = { master_password: "wrong" };
  const savedHost = globalThis.host;
  let unlocks = 0;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: (optsJson) => {
      const args = JSON.parse(optsJson).args || [];
      if (args.indexOf("unlock") >= 0) {
        unlocks++;
        return JSON.stringify({ stdout: JSON.stringify({ success: false, message: "Invalid master password." }), code: 1 });
      }
      return JSON.stringify({ stdout: JSON.stringify({ success: true, data: { status: "locked" } }), code: 0 });
    },
  };
  try {
    const first = plugin.secretGetItem("example");
    assert(first && first.error && first.error.kind === "locked", "expected locked, got " + JSON.stringify(first));
    assert(unlocks === 1, "the first call may try the remembered password once, tried " + unlocks);
    assert(!("master_password" in secrets), "a rejected password must not be kept");

    const second = plugin.secretGetItem("example");
    assert(second && second.error && second.error.kind === "locked", "still locked");
    assert(unlocks === 1, "the second call must not retry a password already rejected, tried " + unlocks);
  } finally {
    globalThis.host = savedHost;
  }
});

test("a transient unlock failure keeps the remembered password", () => {
  const secrets = { master_password: "right" };
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: (optsJson) => {
      const args = JSON.parse(optsJson).args || [];
      if (args.indexOf("unlock") >= 0) {
        return JSON.stringify({ stdout: JSON.stringify({ success: false, message: "Server is unreachable" }), code: 1 });
      }
      return JSON.stringify({ stdout: JSON.stringify({ success: true, data: { status: "locked" } }), code: 0 });
    },
  };
  try {
    plugin.secretGetItem("example");
    assert(secrets.master_password === "right", "a network failure must not wipe a good credential");
  } finally {
    globalThis.host = savedHost;
  }
});

test("api-key creds without a master password are refused up front, not by bw", () => {
  const secrets = {};
  const savedHost = globalThis.host;
  let execs = 0;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}",
    manifest: () => ({ permissions: { network: { allow: [] } } }),
    exec: () => { execs++; return JSON.stringify({ stdout: "{}", code: 0 }); },
  };
  try {
    const r = plugin.secretUnlock({ apiKeyClientId: "id", apiKeyClientSecret: "secret" });
    assert(r && r.error && r.error.kind === "bad_request", "expected bad_request, got " + JSON.stringify(r));
    assert(/master password/i.test(r.error.message || ""), "the error must name what is missing, got " + r.error.message);
    assert(execs === 0, "the requirement is knowable without running bw, ran " + execs);
  } finally {
    globalThis.host = savedHost;
  }
});

test("reset connection applies the configured server and clears stale credentials", () => {
  const secrets = {
    session: "stale-session",
    master_password: "stale-master",
    login_email: "old@example.com",
    api_client_id: "old-id",
    api_client_secret: "old-secret",
  };
  const calls = [];
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => JSON.stringify({ serverUrl: "https://vault.example.test" }),
    manifest: () => ({ permissions: { network: { allow: ["vault.example.test"] } } }),
    exec: (optsJson) => {
      const o = JSON.parse(optsJson);
      const args = o.args || [];
      calls.push(args);
      return JSON.stringify({ stdout: JSON.stringify({ success: true, data: {} }), stderr: "", code: 0 });
    },
  };
  try {
    const result = plugin.viewCall("resetConnection", {});
    assert("ok" in result, "expected reset to succeed, got " + JSON.stringify(result));
    assert(calls.length === 2, "expected logout and config commands");
    assert(calls[0].includes("logout"), "logout must run first");
    assert(calls[1].join(" ").includes("config server https://vault.example.test"), "configured server must be applied");
    assert(Object.keys(secrets).length === 0, "all stale auth credentials must be cleared");
  } finally {
    globalThis.host = savedHost;
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}`);
    console.error(err);
  }
}
console.log(`bitwarden plugin: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
