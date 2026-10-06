const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

globalThis.host = new Proxy({}, { get: () => () => { throw new Error("host called at load time"); } });
const testBundle = path.join(__dirname, ".plugin-test.cjs");
fs.copyFileSync(path.join(__dirname, "plugin.js"), testBundle);
const plugin = require(testBundle).default;
process.on("exit", () => fs.rmSync(testBundle, { force: true }));
const parse = require("./src/parse.ts");
const C = require("./src/constants.ts");

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function normalize(value) { return path.posix.normalize(String(value).replaceAll("\\", "/")); }

const DEVICE_LOG = "requesting device code...\n\nTo sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code KX7PQ2LMN to authenticate.\n\nwaiting for authentication...\n";
const SUCCESS_LOG = `${DEVICE_LOG}authenticated, exchanging for Teams tokens...\nskypetoken exchange successful\nrequesting graph token...\nrequesting assignments token...\ntokens saved to ~/.exo-teams/\n  skype: valid until 2030-01-01 10:00:00\n`;
const WHOAMI_OK = JSON.stringify({ user: "Andrey Kovalev", email: "andrey.kovalev@quantumsoft.pro", tokens: [
  { name: "skype", valid: true, expiry: "2030-01-01 10:00:00" },
  { name: "chatsvcagg", valid: true, expiry: "2030-01-01 10:00:00" },
  { name: "teams", valid: true, expiry: "2030-01-01 10:00:00" },
  { name: "graph", valid: true, expiry: "2030-01-01 10:00:00" },
  { name: "assignments", valid: false, expiry: "not set" },
] });
const WHOAMI_EXPIRED = JSON.stringify({ user: "", email: "", tokens: [
  { name: "skype", valid: false, expiry: "2020-01-01 10:00:00" },
  { name: "chatsvcagg", valid: false, expiry: "2020-01-01 10:00:00" },
] });
const ALEX_CHAT = "19:aaa_bbb@unq.gbl.spaces";
const GROUP_CHAT = "19:groupthread@thread.v2";
const RAW_CHATS = [
  { id: GROUP_CHAT, title: "", isOneOnOne: false, chatType: "chat", tenantId: "t1", members: [
    { mri: "8:orgid:self", friendlyName: "Andrey Kovalev" }, { mri: "8:orgid:alex", friendlyName: "Alexander Kouznetsov" }, { mri: "8:orgid:anna", friendlyName: "Anna Ivanova" },
  ], lastMessage: { originalarrivaltime: "2026-10-05T10:00:00.000Z" } },
  { id: ALEX_CHAT, title: "", isOneOnOne: true, chatType: "chat", tenantId: "t1", members: [
    { mri: "8:orgid:self", friendlyName: "Andrey Kovalev" }, { mri: "8:orgid:alex", friendlyName: "Alexander Kouznetsov" },
  ], lastMessage: { originalarrivaltime: "2026-10-06T09:00:00.000Z" } },
  { id: "19:meeting_x@thread.v2", title: "Sprint review", isOneOnOne: false, chatType: "meeting", members: [], lastMessage: { composetime: "2026-09-01T09:00:00.000Z" } },
  { id: "19:hidden@thread.v2", title: "Old", hidden: true, members: [] },
  { id: "not a chat id", title: "bad" },
];

test("device-code log yields the Microsoft URL and user code, then signed-in, without leaking anything else", () => {
  assert.deepEqual(parse.parseSignInLog("requesting device code...\n"), { state: "starting" });
  assert.deepEqual(parse.parseSignInLog(DEVICE_LOG), { state: "awaiting-user", signInUrl: "https://microsoft.com/devicelogin", deviceCode: "KX7PQ2LMN" });
  assert.deepEqual(parse.parseSignInLog(SUCCESS_LOG), { state: "signed-in" });
  const newPage = "To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code LSRGHM4XQ to authenticate.";
  assert.deepEqual(parse.parseSignInLog(newPage), { state: "awaiting-user", signInUrl: "https://login.microsoft.com/device", deviceCode: "LSRGHM4XQ" });
});

test("sign-in failures map to typed states with Microsoft's exact message", () => {
  const ca = `${DEVICE_LOG}Error: login failed: authentication failed: unexpected error: {"error":"invalid_grant","error_description":"AADSTS53003: Access has been blocked by Conditional Access policies. The access policy does not allow token issuance. Trace ID: 1a2b","error_codes":[53003]}`;
  const failed = parse.parseSignInLog(ca);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failure.state, "refused");
  assert.match(failed.failure.message, /Microsoft said: "AADSTS53003: Access has been blocked by Conditional Access policies\. The access policy does not allow token issuance\. Trace ID: 1a2b"/);
  const consent = parse.classifyAuthFailure('token endpoint returned 400: {"error":"invalid_client","error_description":"AADSTS65001: The user or administrator has not consented to use the application."}');
  assert.equal(consent.state, "refused");
  assert.match(consent.message, /administrator approval/);
  assert.equal(parse.parseSignInLog(`${DEVICE_LOG}Error: login failed: authentication failed: device code expired - try again`).failure.state, "expired");
  assert.equal(parse.parseSignInLog(`${DEVICE_LOG}Error: login failed: authentication failed: authorization was declined`).failure.state, "refused");
  assert.equal(parse.classifyAuthFailure("Error: refresh failed: refreshing skype token: token endpoint returned 400: {\"error\":\"invalid_grant\",\"error_description\":\"AADSTS700082: The refresh token has expired due to inactivity.\"}").state, "expired");
  assert.equal(parse.classifyAuthFailure("Error: loading tokens: reading skype token: open C:\\x\\.exo-teams\\token-skype.jwt: The system cannot find the file specified.").state, "logged-out");
  const license = parse.parseSignInLog(`${DEVICE_LOG}Error: login failed: skypetoken exchange failed: authz returned status 403: {"errorCode":"UserLicenseNotPresentForbidden","message":"User Login. Teams is disabled in user licenses"}`);
  assert.equal(license.failure.state, "sign-in-failed");
  assert.match(license.failure.message, /Teams is disabled in user licenses/);
});

test("token-shaped values never survive into a surfaced message", () => {
  const jwt = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJza3lwZSJ9.c2lnbmF0dXJlLXZhbHVl";
  const text = `Error: unexpected error: {"error":"x","error_description":"AADSTS9002313: bad request refresh_token=${jwt} code=0.AXYZsecret Bearer abcdefghijklmnopqrstuvwxyz0123"}`;
  const message = parse.microsoftMessage(text);
  assert.doesNotMatch(message, /eyJ0eXAi|0\.AXYZsecret|abcdefghijklmnopqrstuvwxyz0123/);
  assert.match(message, /AADSTS9002313/);
  assert.doesNotMatch(parse.redact(`skypetoken=${jwt}`), /eyJ/);
});

test("whoami output parses and only a valid skype and chatsvcagg session is usable", () => {
  const ok = parse.parseWhoami(WHOAMI_OK);
  assert.equal(ok.email, "andrey.kovalev@quantumsoft.pro");
  assert.equal(parse.sessionUsable(ok), true);
  assert.equal(parse.sessionExpiry(ok), "2030-01-01 10:00:00");
  assert.equal(parse.sessionUsable(parse.parseWhoami(WHOAMI_EXPIRED)), false);
  assert.equal(parse.parseWhoami("not json"), null);
});

test("conversation list maps 1:1 chats to the other member's name, sorts by activity, and drops hidden or malformed rows", () => {
  const chats = parse.mapChats(RAW_CHATS, "Andrey Kovalev");
  assert.deepEqual(chats.map((chat) => chat.id), [ALEX_CHAT, GROUP_CHAT, "19:meeting_x@thread.v2"]);
  assert.deepEqual(chats[0], { id: ALEX_CHAT, title: "Alexander Kouznetsov", topic: null, chatType: "oneOnOne", members: ["Alexander Kouznetsov"], username: null, lastActivity: "2026-10-06T09:00:00.000Z" });
  assert.equal(chats[1].title, "Alexander Kouznetsov, Anna Ivanova");
  assert.equal(chats[1].chatType, "group");
  assert.equal(chats[2].title, "Sprint review");
  assert.equal(chats[2].chatType, "meeting");
  assert.deepEqual(parse.mapChats(null, ""), []);
});

test("person resolution turns an email into name words and ranks the 1:1 chat over a group with the same person", () => {
  assert.equal(parse.personQuery("alexander.kouznetsov@quantumsoft.pro"), "alexander kouznetsov");
  assert.equal(parse.personQuery("Alexander Kouznetsov"), "Alexander Kouznetsov");
  const { matchChats } = require("../shared/src/send-scope.ts");
  const chats = parse.mapChats(RAW_CHATS, "Andrey Kovalev");
  const direct = matchChats(chats.filter((chat) => chat.chatType === "oneOnOne"), parse.personQuery("alexander.kouznetsov@quantumsoft.pro"));
  assert.equal(direct.match.id, ALEX_CHAT);
  assert.equal(matchChats(chats, "Anna").match.id, GROUP_CHAT);
});

test("message body is HTML-escaped for the RichText/Html post and read back as the same text", () => {
  const text = "a < b & c > d \"q\"\nline 2";
  const body = parse.htmlMessage(text);
  assert.equal(body, "a &lt; b &amp; c &gt; d &quot;q&quot;<br>line 2");
  assert.equal(parse.plainText(body), text);
  assert.equal(parse.htmlMessage("test domios plugin for teams"), "test domios plugin for teams");
});

test("the sent message id is the newest own message with the same text after the send started", () => {
  const messages = [
    { id: "1700000000001", content: "test domios plugin for teams", imdisplayname: "Andrey Kovalev", originalarrivaltime: "2026-10-06T08:00:00.000Z" },
    { id: "1700000000002", content: "test domios plugin for teams", imdisplayname: "Alexander Kouznetsov", originalarrivaltime: "2026-10-06T10:00:02.000Z" },
    { id: "1700000000003", content: "<p>test domios plugin for teams</p>", imdisplayname: "Andrey Kovalev", originalarrivaltime: "2026-10-06T10:00:01.000Z" },
    { id: "1700000000004", content: "something else", imdisplayname: "Andrey Kovalev", originalarrivaltime: "2026-10-06T10:00:03.000Z" },
  ];
  const after = Date.parse("2026-10-06T09:59:00.000Z");
  assert.equal(parse.findSentMessageId(messages, "test domios plugin for teams", "Andrey Kovalev", after), "1700000000003");
  assert.equal(parse.findSentMessageId(messages, "missing", "Andrey Kovalev", after), null);
});

test("send failures map to the ledger taxonomy: retried statuses stay unknown, definite rejections fail", () => {
  assert.equal(parse.sendFailure("Error: sending message: POST https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/x/messages returned status 429").kind, "unknown");
  assert.equal(parse.sendFailure("Error: sending message: POST https://emea.ng.msg.teams.microsoft.com/v1/x returned status 503").kind, "unknown");
  assert.equal(parse.sendFailure("Error: sending message: executing POST https://emea.ng.msg.teams.microsoft.com/v1/x: context deadline exceeded").kind, "unknown");
  assert.equal(parse.sendFailure("Error: sending message: POST https://emea.ng.msg.teams.microsoft.com/v1/x returned status 403").kind, "upstream-rejected");
  assert.equal(parse.sendFailure("Error: sending message: POST https://emea.ng.msg.teams.microsoft.com/v1/x returned status 401").kind, "reauth-needed");
  assert.equal(parse.sendFailure("Error: loading tokens: reading skype token: no such file").kind, "not-logged-in");
  assert.equal(parse.sendFailure("Error: auto-refresh failed: refreshing skype token: token endpoint returned 400").kind, "reauth-needed");
  assert.equal(parse.sendFailure("something odd").kind, "unknown");
});

test("checksum and module download output parse on every platform's tool", () => {
  const digest = C.GO_ARCHIVES["win32/x64"].sha256;
  assert.equal(parse.parseSha256(`SHA256 hash of C:\\x\\go.zip:\r\n${digest}\r\nCertUtil: -hashfile command completed successfully.\r\n`), digest);
  const spaced = digest.match(/../g).join(" ");
  assert.equal(parse.parseSha256(`SHA256 hash of file go.zip:\r\n${spaced}\r\nCertUtil: -hashfile command completed successfully.\r\n`), digest);
  assert.equal(parse.parseSha256(`${digest.toUpperCase()}  /tmp/go.tar.gz\n`), digest);
  assert.equal(parse.parseSha256("no digest"), null);
  assert.deepEqual(parse.parseGoModDownload(JSON.stringify({ Path: C.EXO_MODULE, Version: C.EXO_VERSION, Sum: C.EXO_MODULE_SUM })), { version: C.EXO_VERSION, sum: C.EXO_MODULE_SUM, error: "" });
  assert.equal(parse.normalizeArch("x86_64\n"), "x64");
  assert.equal(parse.normalizeArch("AMD64"), "x64");
  assert.equal(parse.normalizeArch("aarch64"), "arm64");
});

test("constants pin one exo-teams commit and a Go archive for each supported target", () => {
  assert.ok(C.EXO_VERSION.endsWith(C.EXO_COMMIT.slice(0, 12)));
  assert.match(C.EXO_MODULE_SUM, /^h1:[A-Za-z0-9+/]{43}=$/);
  assert.equal(C.EXO_CLIENT_ID, "1fec8e78-bce4-4aaf-ab1b-5451cc387264");
  for (const target of ["darwin/x64", "darwin/arm64", "linux/x64", "linux/arm64", "win32/x64", "win32/arm64"]) {
    assert.match(C.GO_ARCHIVES[target].sha256, /^[0-9a-f]{64}$/);
    assert.ok(C.GO_ARCHIVES[target].file.startsWith(`${C.GO_VERSION}.`));
  }
  assert.equal(plugin.__test_resolveTarget("freebsd", "x64").state, "unsupported-platform");
});

function mockHost(options = {}) {
  const platform = options.platform || "win32";
  const windows = platform === "win32";
  const home = `/fixture/home-${Math.random().toString(16).slice(2)}`;
  const files = new Map();
  const calls = [];
  const jobs = new Map();
  let nextJob = 0;
  const state = {
    whoami: options.whoami || WHOAMI_OK,
    chats: options.chats || RAW_CHATS,
    messages: options.messages || [],
    sendResult: options.sendResult || { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "message sent\n" },
    refresh: options.refresh || { code: 0, stdout: "", stderr: "tokens refreshed\n" },
  };
  function expandHome(value) {
    const text = String(value || "");
    if (text.startsWith("~/")) return normalize(`${home}/${text.slice(2)}`);
    return normalize(text);
  }
  const root = () => expandHome(C.ROOT);
  function exo(args, opts) {
    if (args[0] === "whoami") return { code: 0, stdout: state.whoami, stderr: "" };
    if (args[0] === "auth" && args[1] === "--refresh") {
      if (state.refresh.code === 0) state.whoami = WHOAMI_OK;
      return state.refresh;
    }
    if (args[0] === "list-chats") return { code: 0, stdout: JSON.stringify(state.chats), stderr: "" };
    if (args[0] === "send") {
      if (state.sendResult.code === 0) state.messages.push({ id: "1759744800123", content: args[2], imdisplayname: "Andrey Kovalev", originalarrivaltime: new Date(Date.now()).toISOString() });
      return state.sendResult;
    }
    if (args[0] === "new-dm") {
      const conv = "19:new_dm@unq.gbl.spaces";
      state.chats = state.chats.concat([{ id: conv, title: "", isOneOnOne: true, members: [{ friendlyName: "Andrey Kovalev" }, { friendlyName: "Boris Petrov" }] }]);
      state.messages.push({ id: "1759744800999", content: args[2], imdisplayname: "Andrey Kovalev", originalarrivaltime: new Date(Date.now()).toISOString(), conv });
      return { code: 0, stdout: JSON.stringify({ ok: true, id: conv }), stderr: "found user: Boris Petrov (boris@x.example)\ncreating conversation...\n" };
    }
    if (args[0] === "get-chat") return { code: 0, stdout: JSON.stringify(state.messages), stderr: "fetching messages from chat: x...\n" };
    return { code: 1, stdout: "", stderr: `Error: unknown command ${args[0]}` };
  }
  function run(opts) {
    const bin = normalize(opts.bin || "").split("/").pop();
    const args = (opts.args || []).map(String);
    calls.push({ bin, raw: String(opts.bin), args, env: { ...(opts.env || {}) }, detach: !!opts.detach, timeoutMs: opts.timeoutMs, logFile: opts.logFile });
    if (bin === "whoami.exe") return { code: 0, stdout: "FIXTURE\\owner\n", stderr: "" };
    if (bin === "icacls.exe" || bin === "chmod" || bin === "taskkill.exe" || bin === "kill") return { code: 0, stdout: "", stderr: "" };
    if (bin === "uname") return { code: 0, stdout: "arm64\n", stderr: "" };
    if (bin === "curl.exe" || bin === "curl") {
      if (options.downloadFails) return { code: 22, stdout: "", stderr: "curl: (22) The requested URL returned error: 404" };
      files.set(normalize(args[args.indexOf("-o") + 1]), "go archive bytes");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (bin === "powershell.exe" || bin === "shasum" || bin === "sha256sum") {
      const target = `${platform}/${platform === "win32" ? "x64" : "arm64"}`;
      const digest = options.badDigest ? "0".repeat(64) : C.GO_ARCHIVES[target].sha256;
      return { code: 0, stdout: windows ? `SHA256 hash of file:\r\n${digest}\r\nCertUtil: -hashfile command completed successfully.\r\n` : `${digest}  file\n`, stderr: "" };
    }
    if (bin === "tar.exe" || bin === "tar") {
      files.set(normalize(`${args[args.indexOf("-C") + 1]}/go/bin/${windows ? "go.exe" : "go"}`), "go");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (bin === "go.exe" || bin === "go") {
      if (args[0] === "mod") return { code: 0, stdout: JSON.stringify({ Path: C.EXO_MODULE, Version: C.EXO_VERSION, Sum: options.badModuleSum ? "h1:wrong=" : C.EXO_MODULE_SUM }), stderr: "" };
      if (args[0] === "install") {
        files.set(normalize(`${opts.env.GOBIN}/${windows ? "exo-teams.exe" : "exo-teams"}`), "binary");
        return { code: 0, stdout: "", stderr: "" };
      }
    }
    if (bin === "exo-teams.exe" || bin === "exo-teams") return exo(args, opts);
    return { code: 127, stdout: "", stderr: `unexpected ${bin}` };
  }
  function install() {
    const p = plugin.__test_paths();
    files.set(normalize(p.binary), "binary");
    files.set(normalize(p.marker), JSON.stringify({ module: C.EXO_MODULE, version: C.EXO_VERSION, sum: C.EXO_MODULE_SUM, go: C.GO_VERSION }));
  }
  function signIn() {
    const p = plugin.__test_paths();
    for (const name of C.EXO_TOKEN_FILES) files.set(normalize(`${p.tokenDir}/${name}`), "token");
  }
  globalThis.host = {
    platform: () => (platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform),
    envGet: (name) => (name === "PROCESSOR_ARCHITECTURE" ? "AMD64" : name === "SystemRoot" ? "D:\\Win" : null),
    settingsJson: () => JSON.stringify(options.settings || {}),
    path: {
      isWindows: windows,
      normalize: (value) => normalize(value),
      toNative: (value) => (windows ? normalize(value).replaceAll("/", "\\") : normalize(value)),
    },
    fs: {
      expandHome,
      makeDirs: () => true,
      fileExists: (file) => files.has(normalize(file)),
      writeFile: (file, contents) => { files.set(normalize(file), String(contents)); return true; },
      readFile: (file) => files.has(normalize(file)) ? files.get(normalize(file)) : null,
      readJson: (file) => { try { return JSON.parse(files.get(normalize(file))); } catch { return null; } },
      readFileTail: (file) => files.get(normalize(file)) ?? null,
      removeFile: (file) => files.delete(normalize(file)) || true,
    },
    exec: Object.assign((json) => JSON.stringify(run(JSON.parse(json))), {
      start(opts) {
        const id = `job-${++nextJob}`;
        if (opts.detach) {
          calls.push({ bin: normalize(opts.bin).split("/").pop(), args: opts.args.map(String), env: { ...(opts.env || {}) }, detach: true, timeoutMs: opts.timeoutMs, logFile: opts.logFile });
          files.set(normalize(opts.logFile), options.signInLog === undefined ? DEVICE_LOG : options.signInLog);
          jobs.set(id, { done: true, code: 0, stdout: JSON.stringify({ code: 0, pid: 4242 }), stderr: "" });
        } else jobs.set(id, { pending: true, opts });
        return { jobId: id };
      },
      poll(id) {
        const job = jobs.get(id);
        if (job.pending) { delete job.pending; Object.assign(job, { done: true, ...run(job.opts) }); }
        return { done: true, code: job.code, stdout: job.stdout, stderr: job.stderr, error: job.error };
      },
      close(id) { jobs.delete(id); },
    }),
  };
  plugin.__test_reset();
  return { files, calls, state, install, signIn, root, exoCalls: () => calls.filter((call) => /exo-teams/.test(call.bin)) };
}

function command(verb, args = []) {
  return plugin.onAgentCommand({ sessionId: "t", verb, args });
}
function result(value) {
  assert.equal(value.error, undefined, value.error);
  return JSON.parse(value.result);
}
function loginUntil(env, predicate, limit = 12) {
  let value = result(command("login"));
  for (let i = 0; i < limit && !predicate(value); i++) value = result(command("login-status"));
  return value;
}

test("first login installs the pinned toolchain and module stage by stage, then returns the device code", () => {
  const env = mockHost();
  const value = loginUntil(env, (v) => v.signIn === "device-code");
  assert.equal(value.state, "awaiting-user");
  assert.equal(value.signInUrl, "https://microsoft.com/devicelogin");
  assert.equal(value.deviceCode, "KX7PQ2LMN");
  const order = env.calls.map((call) => call.bin).filter((bin) => ["curl.exe", "powershell.exe", "tar.exe", "go.exe", "exo-teams.exe"].includes(bin));
  assert.deepEqual(order, ["curl.exe", "powershell.exe", "tar.exe", "go.exe", "go.exe", "exo-teams.exe"]);
  const hash = env.calls.find((call) => call.bin === "powershell.exe");
  assert.ok(hash.env.CT_HASH_FILE.endsWith(C.GO_ARCHIVES["win32/x64"].file), "the archive path travels in the environment, not in a command string");
  const curl = env.calls.find((call) => call.bin === "curl.exe");
  for (const tool of ["curl.exe", "tar.exe", "powershell.exe", "icacls.exe", "whoami.exe"]) {
    assert.match(env.calls.find((call) => call.bin === tool).raw, /^D:\\Win\\System32\\/,`${tool} runs from System32, never a PATH lookup that could find Git's GNU tar`);
  }
  assert.equal(curl.args[curl.args.length - 1], `https://go.dev/dl/${C.GO_ARCHIVES["win32/x64"].file}`);
  assert.ok(curl.args.includes("=https"));
  const [mod, build] = env.calls.filter((call) => call.bin === "go.exe");
  assert.deepEqual(mod.args, ["mod", "download", "-json", `${C.EXO_MODULE}@${C.EXO_VERSION}`]);
  assert.deepEqual(build.args, ["install", `${C.EXO_PACKAGE}@${C.EXO_VERSION}`]);
  for (const call of [mod, build]) {
    assert.equal(call.env.GOTOOLCHAIN, "local");
    assert.equal(call.env.GOENV, "off");
    assert.equal(call.env.CGO_ENABLED, "0");
    assert.equal(call.env.GOSUMDB, "sum.golang.org");
    assert.ok(call.env.GOMODCACHE.includes("teams-client"));
  }
  const auth = env.calls.find((call) => call.bin === "exo-teams.exe");
  assert.deepEqual(auth.args, ["auth"]);
  assert.equal(auth.detach, true);
  assert.equal(normalize(auth.env.HOME), normalize(`${env.root()}/exo-home`));
  assert.equal(auth.env.USERPROFILE, auth.env.HOME);
  assert.ok(normalize(auth.env.PATH).endsWith("/runtime/no-path"), "exo-teams cannot find a browser opener");
  const acl = env.calls.find((call) => call.bin === "icacls.exe");
  assert.deepEqual(acl.args.slice(1), ["/inheritance:r", "/grant:r", "FIXTURE\\owner:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "/C"]);
});

test("a Go archive with the wrong SHA-256 or a module with the wrong sum stops the install before building", () => {
  let env = mockHost({ badDigest: true });
  let value = loginUntil(env, (v) => v.done);
  assert.equal(value.state, "install-failed");
  assert.match(value.error, /did not match its pinned SHA-256/);
  assert.equal(env.calls.some((call) => call.bin === "tar.exe" || call.bin === "go.exe"), false);
  env = mockHost({ badModuleSum: true });
  value = loginUntil(env, (v) => v.done);
  assert.equal(value.state, "install-failed");
  assert.match(value.error, new RegExp(C.EXO_MODULE_SUM.replace(/[+/=]/g, "\\$&")));
  assert.equal(env.calls.some((call) => call.bin === "go.exe" && call.args[0] === "install"), false);
  env = mockHost({ downloadFails: true });
  value = loginUntil(env, (v) => v.done);
  assert.equal(value.state, "install-failed");
  assert.match(value.error, /404/);
});

test("macOS resolves its archive through uname and checks it with shasum", () => {
  const env = mockHost({ platform: "darwin" });
  loginUntil(env, (v) => v.signIn === "device-code");
  const curl = env.calls.find((call) => call.bin === "curl");
  assert.ok(curl.args.at(-1).endsWith(C.GO_ARCHIVES["darwin/arm64"].file));
  assert.deepEqual(env.calls.find((call) => call.bin === "shasum").args.slice(0, 2), ["-a", "256"]);
  assert.ok(env.calls.some((call) => call.bin === "chmod" && call.args[0] === "700"));
});

test("login while a code is pending returns the same code without a second sign-in process", () => {
  const env = mockHost();
  env.install();
  const first = result(command("login"));
  const again = result(command("login"));
  assert.equal(again.deviceCode, first.deviceCode);
  assert.equal(env.calls.filter((call) => call.bin === "exo-teams.exe" && call.args[0] === "auth").length, 1);
  assert.equal(result(command("health")).state, "awaiting-user");
});

test("login-status completes as logged-in after exo-teams saves tokens", () => {
  const env = mockHost({ signInLog: SUCCESS_LOG });
  env.install();
  result(command("login"));
  env.signIn();
  const done = result(command("login-status"));
  assert.equal(done.done, true);
  assert.equal(done.state, "logged-in");
  const health = result(command("health"));
  assert.equal(health.state, "logged-in");
  assert.equal(health.upn, "andrey.kovalev@quantumsoft.pro");
  assert.equal(health.cli.version, C.EXO_VERSION);
});

test("a refused sign-in ends with Microsoft's message and no retry", () => {
  const env = mockHost({ signInLog: `${DEVICE_LOG}Error: login failed: authentication failed: unexpected error: {"error":"access_denied","error_description":"AADSTS53003: Access has been blocked by Conditional Access policies."}` });
  env.install();
  result(command("login"));
  const done = result(command("login-status"));
  assert.equal(done.done, true);
  assert.equal(done.state, "refused");
  assert.match(done.error, /AADSTS53003: Access has been blocked by Conditional Access policies\./);
  assert.equal(env.calls.filter((call) => call.args[0] === "auth").length, 1);
});

test("an expired session refreshes silently; a failed refresh is typed expired with Microsoft's message", () => {
  let env = mockHost({ whoami: WHOAMI_EXPIRED });
  env.install(); env.signIn();
  assert.equal(result(command("health")).state, "logged-in");
  assert.ok(env.exoCalls().some((call) => call.args[0] === "auth" && call.args[1] === "--refresh"));
  env = mockHost({ whoami: WHOAMI_EXPIRED, refresh: { code: 1, stdout: "", stderr: 'tokens expired, refreshing...\nError: refresh failed: refreshing skype token: token endpoint returned 400: {"error":"invalid_grant","error_description":"AADSTS700082: The refresh token has expired due to inactivity."}' } });
  env.install(); env.signIn();
  const health = result(command("health"));
  assert.equal(health.state, "expired");
  assert.match(health.message, /AADSTS700082: The refresh token has expired due to inactivity\./);
});

test("states before sign-in are typed: not-installed, then logged-out", () => {
  const env = mockHost();
  assert.equal(result(command("health")).state, "not-installed");
  env.install();
  assert.equal(result(command("health")).state, "logged-out");
  assert.match(command("send", [ALEX_CHAT, "hi"]).error, /^not-logged-in:/);
});

test("chats lists display names and search finds Alexander Kouznetsov's 1:1 chat by name or email", () => {
  const env = mockHost();
  env.install(); env.signIn();
  const listed = result(command("chats"));
  assert.equal(listed.chats[0].title, "Alexander Kouznetsov");
  const byName = result(command("search", ["Alexander", "Kouznetsov"]));
  assert.equal(byName.match.id, ALEX_CHAT);
  const byEmail = result(command("search", ["alexander.kouznetsov@quantumsoft.pro"]));
  assert.equal(byEmail.match.id, ALEX_CHAT);
  result(command("chats", ["Anna"]));
  assert.equal(env.exoCalls().filter((call) => call.args[0] === "list-chats").length, 1, "the chat list is cached");
  result(command("chats", ["--refresh"]));
  assert.equal(env.exoCalls().filter((call) => call.args[0] === "list-chats").length, 2);
});

test("send posts the escaped text through exo-teams and returns the message id read back from the chat", () => {
  const env = mockHost();
  env.install(); env.signIn();
  const sent = result(command("send", [ALEX_CHAT, "--key", "teams-1", "test", "domios", "plugin", "for", "teams"]));
  assert.equal(sent.status, "sent");
  assert.equal(sent.messageId, "1759744800123");
  assert.equal(sent.destination.label, "Alexander Kouznetsov");
  const send = env.exoCalls().find((call) => call.args[0] === "send");
  assert.deepEqual(send.args, ["send", ALEX_CHAT, "test domios plugin for teams", "--json"]);
  const outbox = JSON.parse(env.files.get(normalize(plugin.__test_paths().outbox)));
  assert.equal(outbox.attempts[0].state, "sent");
  assert.equal(outbox.attempts[0].messageId, "1759744800123");
  assert.equal(JSON.stringify(outbox).includes("domios"), false, "the ledger never stores message text");
  const again = result(command("send", [ALEX_CHAT, "--key", "teams-1", "test", "domios", "plugin", "for", "teams"]));
  assert.equal(again.messageId, "1759744800123");
  assert.equal(env.exoCalls().filter((call) => call.args[0] === "send").length, 1, "a sent key is never resent");
  assert.match(command("send", [ALEX_CHAT, "--key", "teams-1", "other text"]).error, /^invalid-request:/);
});

test("HTML-significant text is escaped and the read-back still finds the id", () => {
  const env = mockHost();
  env.install(); env.signIn();
  const sent = result(command("send", [ALEX_CHAT, "--key", "k2", "<b>x</b> & y"]));
  assert.equal(env.exoCalls().find((call) => call.args[0] === "send").args[2], "&lt;b&gt;x&lt;/b&gt; &amp; y");
  assert.equal(sent.messageId, "1759744800123");
});

test("a throttled send stays unknown and its key is refused afterwards; a 403 is upstream-rejected", () => {
  let env = mockHost({ sendResult: { code: 1, stdout: "", stderr: "message sent?\nError: sending message: POST https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/x/messages returned status 429" } });
  env.install(); env.signIn();
  assert.match(command("send", [ALEX_CHAT, "--key", "k3", "hello"]).error, /^unknown:/);
  assert.match(command("send", [ALEX_CHAT, "--key", "k3", "hello"]).error, /^unknown:/);
  assert.equal(env.exoCalls().filter((call) => call.args[0] === "send").length, 1);
  env = mockHost({ sendResult: { code: 1, stdout: "", stderr: "Error: sending message: POST https://emea.ng.msg.teams.microsoft.com/v1/x returned status 403" } });
  env.install(); env.signIn();
  assert.match(command("send", [ALEX_CHAT, "--key", "k4", "hello"]).error, /^upstream-rejected:/);
});

test("an id the account has no chat for is chat-not-found; a name is not an id", () => {
  const env = mockHost();
  env.install(); env.signIn();
  assert.match(command("send", ["19:nope@thread.v2", "hi"]).error, /^chat-not-found:/);
  assert.match(command("send", ["Alexander", "hi"]).error, /^invalid-request:/);
  assert.equal(env.exoCalls().some((call) => call.args[0] === "send"), false);
});

test("send-to uses the existing 1:1 chat, and starts a new one for a full name with no chat", () => {
  const env = mockHost();
  env.install(); env.signIn();
  const existing = result(command("send-to", ["Alexander Kouznetsov", "--key", "p1", "hello"]));
  assert.equal(existing.destination.id, ALEX_CHAT);
  assert.equal(env.exoCalls().some((call) => call.args[0] === "new-dm"), false);
  const created = result(command("send-to", ["Boris Petrov", "--key", "p2", "hi", "Boris"]));
  const dm = env.exoCalls().find((call) => call.args[0] === "new-dm");
  assert.deepEqual(dm.args, ["new-dm", "Boris Petrov", "hi Boris", "--json"]);
  assert.equal(created.destination.id, "19:new_dm@unq.gbl.spaces");
  assert.equal(created.destination.label, "Boris Petrov");
  assert.equal(created.messageId, "1759744800999");
  assert.equal(result(command("send-to", ["Boris Petrov", "--key", "p2", "hi", "Boris"])).messageId, "1759744800999");
  assert.match(command("send-to", ["Zed", "hello"]).error, /full name/);
});

test("the owner restriction refuses agent sends to other chats; view sends stay allowed", () => {
  const env = mockHost();
  env.install(); env.signIn();
  assert.equal(JSON.parse(plugin.viewCall("setSendScope", { mode: "only", chats: [{ id: GROUP_CHAT, title: "Group" }] }).result).mode, "only");
  assert.match(command("send", [ALEX_CHAT, "--key", "r1", "x"]).error, /^chat-not-allowed:|Restrict agent sends/);
  const view = plugin.viewCall("send", { chatId: ALEX_CHAT, idempotencyKey: "r2", text: "x" });
  assert.equal(JSON.parse(view.result).status, "sent");
});

test("history is bounded and carries message text as untrusted data", () => {
  const messages = Array.from({ length: 60 }, (_, i) => ({ id: String(i), messagetype: "RichText/Html", content: `<p>m${i}</p>`, imdisplayname: "Alexander Kouznetsov", originalarrivaltime: `2026-10-06T10:${String(i).padStart(2, "0")}:00.000Z` }));
  messages.push({ id: "sys", messagetype: "ThreadActivity/AddMember", content: "<addmember/>" });
  const env = mockHost({ messages });
  env.install(); env.signIn();
  const history = result(command("history", [ALEX_CHAT, "5"]));
  assert.deepEqual(history.messages.map((m) => m.content), ["m55", "m56", "m57", "m58", "m59"]);
  assert.ok(history.messages.every((m) => m.untrusted === true));
  const bounded = plugin.__test_boundedHistory("c:1", [{ id: "1", createdDateTime: "a", from: "x", content: "y".repeat(50000) }], 20, 2048);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 2048);
  assert.equal(bounded.truncated, true);
});

test("no exo-teams call carries a token, and logout deletes every token file", () => {
  const env = mockHost();
  env.install(); env.signIn();
  result(command("send", [ALEX_CHAT, "--key", "z1", "hi"]));
  for (const call of env.calls) {
    assert.equal(call.args.some((arg) => /eyJ|token-|refresh/i.test(arg) && !/^--refresh$/.test(arg)), false, `${call.bin} ${call.args.join(" ")}`);
  }
  assert.match(command("logout").result, /token files were removed/);
  const p = plugin.__test_paths();
  for (const name of C.EXO_TOKEN_FILES) assert.equal(env.files.has(normalize(`${p.tokenDir}/${name}`)), false);
  assert.equal(result(command("health")).state, "logged-out");
});

test("manifest declares the token files as credentials, the subprocess allowlist, and no m365 path", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "plugin.json"), "utf8"));
  const declared = manifest.credentials.map((entry) => entry.file);
  for (const name of C.EXO_TOKEN_FILES) assert.ok(declared.includes(`${C.ROOT}/${C.EXO_HOME_DIR}/${C.EXO_TOKEN_DIR}/${name}`), name);
  for (const bin of ["exo-teams.exe", "go.exe", "curl.exe", "tar.exe", "powershell.exe", "exo-teams", "go", "curl", "tar", "shasum", "sha256sum"]) assert.ok(manifest.permissions.subprocess.allow.includes(bin), bin);
  const text = fs.readFileSync(path.join(__dirname, "plugin.json"), "utf8") + fs.readFileSync(path.join(__dirname, "src/plugin.ts"), "utf8");
  assert.doesNotMatch(text, /m365|cli-microsoft365|graph\.microsoft\.com\/v1\.0\/chats/);
  assert.equal(manifest.permissions.secrets, undefined);
  assert.match(manifest.configHelp, /send-to/);
});

test("agent verbs route, and the single-account model refuses use", () => {
  const env = mockHost();
  env.install(); env.signIn();
  assert.match(command("nope").error, /Unknown Teams Client verb/);
  assert.match(command("use", ["x"]).error, /one signed-in Teams account/);
  assert.equal(result(command("accounts")).accounts[0].upn, "andrey.kovalev@quantumsoft.pro");
  const preview = result(command("preview", [ALEX_CHAT, "hello"]));
  assert.equal(preview.destination.label, "Alexander Kouznetsov");
  assert.equal(env.exoCalls().some((call) => call.args[0] === "send"), false, "preview sends nothing");
});

test("plugin view shows the sign-in code and labels the typed states as words", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { App, SignInLink } = require("./ui/src/app.tsx");
  const { StatusBar } = require("./ui/src/kit.tsx");
  const { statusView, setupRows } = require("./ui/src/status.ts");
  const page = renderToStaticMarkup(React.createElement(App));
  assert.match(page, /<h2[^>]*>/);
  for (const state of ["logged-out", "awaiting-user", "logged-in", "expired", "refused", "install-in-progress"]) {
    const view = statusView(state);
    assert.doesNotMatch(view.label, /[-_]/, state);
    const bar = renderToStaticMarkup(React.createElement(StatusBar, { ...view, busy: false, onRefresh() {} }));
    if (state.includes("-")) assert.equal(bar.includes(state), false, state);
  }
  assert.equal(setupRows({ state: "logged-in", upn: "a@b.c" })[0].label, "exo-teams runtime");
  const code = renderToStaticMarkup(React.createElement(SignInLink, { url: "https://microsoft.com/devicelogin", code: "KX7PQ2LMN" }));
  assert.ok(code.includes("KX7PQ2LMN") && code.includes("https://microsoft.com/devicelogin"));
});

for (const [name, fn] of tests) {
  try {
    fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}
