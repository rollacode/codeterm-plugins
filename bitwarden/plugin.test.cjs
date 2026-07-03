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
      if (args.indexOf("unlock") >= 0) {
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

// ── remember-master toggle OFF stays session-only (opt-in parity) ──
// A successful unlock with the toggle off must NOT persist K_MASTER: a later
// no-session op stays locked (no silent JIT re-unlock).

test("remember off: unlock persists session only, K_MASTER never written", () => {
  const MASTER = "hunter2";
  const SESSION = "SESS-OFF";
  const secrets = {};
  const savedHost = globalThis.host;
  globalThis.host = {
    secretGet: (k) => (k in secrets ? secrets[k] : null),
    secretSet: (k, v) => { secrets[k] = v; },
    secretDelete: (k) => { delete secrets[k]; },
    settingsJson: () => "{}", // remember OFF
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
    assert(!("master_password" in secrets), "K_MASTER must NOT be persisted when toggle is off");
  } finally {
    globalThis.host = savedHost;
  }
});

// ── remember-master ON persists K_MASTER (via unlock-view flag) ──

test("remember on: unlock persists K_MASTER", () => {
  const MASTER = "hunter2";
  const SESSION = "SESS-ON";
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
    const r = plugin.secretUnlock({ masterPassword: MASTER, email: "a@b.c", rememberMasterPassword: true });
    assert("ok" in r, "expected unlock ok, got " + JSON.stringify(r));
    assert(secrets.master_password === MASTER, "K_MASTER must be persisted when toggle is on");
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
