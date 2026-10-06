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
  { id: ALEX_CHAT, title: "", isOneOnOne: true, hidden: true, chatType: "chat", tenantId: "t1", members: [
    { mri: "8:orgid:self", friendlyName: "Andrey Kovalev" }, { mri: "8:orgid:alex", friendlyName: "Alexander Kouznetsov" },
  ], lastMessage: { originalarrivaltime: "2026-10-06T09:00:00.000Z" } },
  { id: "19:meeting_x@thread.v2", title: "Sprint review", isOneOnOne: false, chatType: "meeting", members: [], lastMessage: { composetime: "2026-09-01T09:00:00.000Z" } },
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

test("conversation list maps 1:1 chats to the other member's name, sorts by activity, keeps the 1:1 threads chatsvcagg flags hidden, and drops malformed rows", () => {
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
  assert.equal(parse.classifyAuthFailure("spawn C:\\x\\exo-teams.exe: The system cannot find the file specified."), null, "a process failure is never mistaken for a missing sign-in");
  assert.equal(parse.sendFailure("Error: auto-refresh failed: refreshing skype token: token endpoint returned 400").kind, "reauth-needed");
  assert.equal(parse.sendFailure("something odd").kind, "unknown");
  assert.equal(parse.sendFailure("Error: creating DM: creating new DM: POST https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations returned status 405").kind, "upstream-rejected", "a refused DM creation sent nothing");
  assert.equal(parse.sendFailure("Error: creating DM: creating new DM: executing POST https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations: context deadline exceeded").kind, "upstream-rejected");
  assert.equal(parse.sendFailure("Error: sending message: POST https://emea.ng.msg.teams.microsoft.com/v1/x returned status 405").kind, "upstream-rejected");
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
    sendFileResult: options.sendFileResult || null,
    refresh: options.refresh || { code: 0, stdout: "", stderr: "tokens refreshed\n" },
    chatMessages: options.chatMessages || null,
    localFiles: options.localFiles || {},
    onGetChat: options.onGetChat || null,
  };
  const local = (file) => state.localFiles[normalize(file)];
  const digest = (content) => require("node:crypto").createHash("sha256").update(content).digest("hex");
  function probeWindows(env) {
    const file = local(env.CT_FILE);
    if (!file) return { code: 0, stdout: "error=ItemNotFoundException\r\n", stderr: "" };
    if (file.dir) return { code: 0, stdout: "kind=dir\r\n", stderr: "" };
    if (file.denied) return { code: 0, stdout: "error=UnauthorizedAccessException\r\n", stderr: "" };
    const size = file.size ?? Buffer.byteLength(file.content);
    const lines = [`size=${size}`, `link=${file.link ? "True" : "False"}`];
    if (size <= Number(env.CT_MAX_BYTES)) lines.push(`sha256=${digest(file.content).toUpperCase()}`);
    return { code: 0, stdout: `${lines.join("\r\n")}\r\n`, stderr: "" };
  }
  function expandHome(value) {
    const text = String(value || "");
    if (text.startsWith("~/")) return normalize(`${home}/${text.slice(2)}`);
    return normalize(text);
  }
  const root = () => expandHome(C.ROOT);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "plugin.json"), "utf8"));
  const deniedReads = () => new Set(manifest.credentials.map((entry) => expandHome(entry.file)));
  const token = (name) => files.has(normalize(`${plugin.__test_paths().tokenDir}/${name}`));
  function exo(args, opts) {
    if (args[0] === "whoami") return token("token-skype.jwt")
      ? { code: 0, stdout: state.whoami, stderr: "" }
      : { code: 1, stdout: "", stderr: "Error: loading tokens: reading skype token: open C:\\h\\.exo-teams\\token-skype.jwt: The system cannot find the file specified.\n" };
    if (args[0] === "auth" && args[1] === "--refresh" && !token("refresh-token.jwt")) return { code: 1, stdout: "", stderr: "Error: refresh failed: no refresh token found - run 'exo-teams auth' to login again\n" };
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
      return { code: 0, stdout: JSON.stringify({ ok: true, id: conv }), stderr: `found user: ${args[1]} (person@x.example)\ncreating conversation...\n` };
    }
    if (args[0] === "send-file") {
      if (state.sendFileResult) return state.sendFileResult;
      const file = args[args.indexOf("--file") + 1];
      const message = args.includes("--message") ? args[args.indexOf("--message") + 1] : "";
      state.messages.push({ id: "1759744800555", messagetype: "RichText/Html", content: message, imdisplayname: "Andrey Kovalev", originalarrivaltime: new Date(Date.now()).toISOString(), properties: { files: JSON.stringify([{ fileName: normalize(file).split("/").pop(), itemid: "DRIVE-ITEM" }]) } });
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: `uploading ${file} (1 KB)...\nfile sent (1/1)\n` };
    }
    if (args[0] === "get-chat") {
      if (state.onGetChat) state.onGetChat(args[1]);
      if (state.getChatError) return { code: 1, stdout: "", stderr: state.getChatError };
      const rows = state.chatMessages ? state.chatMessages[args[1]] : state.messages;
      if (rows === undefined) return { code: 1, stdout: "", stderr: "Error: fetching messages: GET https://emea.ng.msg.teams.microsoft.com/v1/x returned status 404" };
      return { code: 0, stdout: JSON.stringify(rows), stderr: "fetching messages from chat: x...\n" };
    }
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
    if (bin === "powershell.exe" && opts.env && opts.env.CT_FILE !== undefined) return probeWindows(opts.env);
    if (bin === "realpath") {
      const file = local(args[0]);
      return file ? { code: 0, stdout: `${file.real || normalize(args[0])}\n`, stderr: "" } : { code: 1, stdout: "", stderr: `realpath: ${args[0]}: No such file or directory` };
    }
    if (bin === "wc") {
      const file = local(args[1]);
      if (!file || file.dir) return { code: 1, stdout: "", stderr: `wc: ${args[1]}: read: Is a directory` };
      return { code: 0, stdout: `  ${file.size ?? Buffer.byteLength(file.content)} ${args[1]}\n`, stderr: "" };
    }
    if ((bin === "shasum" || bin === "sha256sum") && local(args[args.length - 1])) {
      return { code: 0, stdout: `${digest(local(args[args.length - 1]).content)}  file\n`, stderr: "" };
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
      fileExists: (file) => !deniedReads().has(normalize(file)) && files.has(normalize(file)),
      writeFile: (file, contents) => { files.set(normalize(file), String(contents)); return true; },
      readFile: (file) => !deniedReads().has(normalize(file)) && files.has(normalize(file)) ? files.get(normalize(file)) : null,
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

test("send-to never delivers to a group chat that merely contains the person", () => {
  const env = mockHost({ chats: RAW_CHATS.filter((chat) => chat.id !== ALEX_CHAT) });
  env.install(); env.signIn();
  const sent = result(command("send-to", ["Alexander Kouznetsov", "--key", "g1", "test domios plugin for teams"]));
  assert.deepEqual(env.exoCalls().find((call) => call.args[0] === "new-dm").args, ["new-dm", "Alexander Kouznetsov", "test domios plugin for teams", "--json"]);
  assert.equal(env.exoCalls().some((call) => call.args[0] === "send" && call.args[1] === GROUP_CHAT), false);
  assert.equal(sent.destination.label, "Alexander Kouznetsov");
  assert.equal(sent.messageId, "1759744800999");
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

test("the file probe output parses to a typed state and never needs the path", () => {
  const sha = "a".repeat(64);
  assert.deepEqual(parse.parseFileProbe(`size=2048\r\nlink=False\r\nsha256=${sha.toUpperCase()}\r\n`), { state: "file", size: 2048, link: false, sha256: sha });
  assert.deepEqual(parse.parseFileProbe("size=99999999999\r\nlink=False\r\n"), { state: "file", size: 99999999999, link: false, sha256: null });
  assert.equal(parse.parseFileProbe("size=1\r\nlink=True\r\n").link, true);
  assert.deepEqual(parse.parseFileProbe("kind=dir\r\n"), { state: "directory" });
  assert.deepEqual(parse.parseFileProbe("error=ItemNotFoundException\r\n"), { state: "missing" });
  assert.deepEqual(parse.parseFileProbe("error=UnauthorizedAccessException\r\n"), { state: "denied" });
  assert.deepEqual(parse.parseFileProbe("error=IOException\r\n"), { state: "unreadable" });
  assert.deepEqual(parse.parseFileProbe(""), { state: "unreadable" });
  assert.equal(parse.parseByteCount("   1234 /tmp/a b.txt\n"), 1234);
  assert.equal(parse.parseByteCount("wc: x: Is a directory"), null);
});

test("file send failures: a read or upload failure posted nothing, the chat post keeps the send taxonomy", () => {
  assert.equal(parse.fileSendFailure("Error: reading file D:\\x\\a.pdf: open D:\\x\\a.pdf: Access is denied.").kind, "file-unreadable");
  const upload = parse.fileSendFailure("Error: sending file D:\\x\\a.pdf: uploading to OneDrive: uploading to OneDrive: PUT https://graph.microsoft.com/v1.0/me/drive/root:/x:/content returned status 507");
  assert.equal(upload.kind, "upstream-rejected");
  assert.match(upload.detail, /no chat message was posted/);
  assert.equal(parse.fileSendFailure("Error: sending file D:\\x\\a.pdf: creating share link: POST https://graph.microsoft.com/v1.0/me/drive/items/I/createLink returned status 403").kind, "upstream-rejected");
  assert.equal(parse.fileSendFailure("Error: sending file D:\\x\\a.pdf: sending message with file: POST https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/x/messages returned status 429").kind, "unknown");
  assert.equal(parse.fileSendFailure("Error: sending file D:\\x\\a.pdf: sending message with file: POST https://emea.ng.msg.teams.microsoft.com/v1/x returned status 403").kind, "upstream-rejected");
  assert.equal(parse.fileSendFailure("Error: auto-refresh failed: refreshing graph token: token endpoint returned 400").kind, "reauth-needed");
});

test("the sent file message id is the newest own message carrying that file name", () => {
  const files = (name) => ({ files: JSON.stringify([{ fileName: name }]) });
  const messages = [
    { id: "1", imdisplayname: "Andrey Kovalev", originalarrivaltime: "2026-10-06T08:00:00.000Z", properties: files("report.pdf") },
    { id: "2", imdisplayname: "Andrey Kovalev", originalarrivaltime: "2026-10-06T10:00:01.000Z", properties: files("Report.PDF") },
    { id: "3", imdisplayname: "Alexander Kouznetsov", originalarrivaltime: "2026-10-06T10:00:02.000Z", properties: files("report.pdf") },
    { id: "4", imdisplayname: "Andrey Kovalev", originalarrivaltime: "2026-10-06T10:00:03.000Z", properties: { files: [{ title: "other.pdf" }] } },
  ];
  const after = Date.parse("2026-10-06T09:59:00.000Z");
  assert.equal(parse.findSentFileMessageId(messages, "report.pdf", "Andrey Kovalev", after), "2");
  assert.equal(parse.findSentFileMessageId(messages, "other.pdf", "Andrey Kovalev", after), "4");
  assert.equal(parse.findSentFileMessageId(messages, "missing.pdf", "Andrey Kovalev", after), null);
});

test("message search needs every word in the text or a file name, skips system rows, and snips around the match", () => {
  const long = `${"lead ".repeat(60)}the Invoice for <b>October</b> is ready ${"tail ".repeat(60)}`;
  const messages = [
    { id: "m1", messagetype: "RichText/Html", content: `<p>${long}</p>`, imdisplayname: "Anna Ivanova", originalarrivaltime: "2026-10-06T10:00:00.000Z" },
    { id: "m2", messagetype: "Text", content: "invoice later", imdisplayname: "Anna Ivanova", originalarrivaltime: "2026-10-06T11:00:00.000Z" },
    { id: "m3", messagetype: "RichText/Html", content: "", imdisplayname: "Anna Ivanova", originalarrivaltime: "2026-10-06T12:00:00.000Z", properties: { files: JSON.stringify([{ fileName: "october-invoice.pdf" }]) } },
    { id: "m4", messagetype: "ThreadActivity/AddMember", content: "invoice october" },
  ];
  const hits = parse.searchMessages(messages, parse.searchTerms("  INVOICE   october "), { id: GROUP_CHAT, title: "Finance" });
  assert.deepEqual(hits.map((hit) => hit.messageId), ["m1", "m3"]);
  assert.equal(hits[0].chat, "Finance");
  assert.equal(hits[0].from, "Anna Ivanova");
  assert.match(hits[0].snippet, /^….*the Invoice for October is ready.*…$/);
  assert.ok(hits[0].snippet.length < 260);
  assert.deepEqual(hits[1].files, ["october-invoice.pdf"]);
  assert.deepEqual(parse.searchMessages(messages, [], { id: "x", title: "x" }), []);
});

const REPORT = "C:/docs/report.pdf";
const REPORT_CONTENT = "%PDF-1.7 SECRET-FILE-CONTENT";

test("send-file probes the file, uploads through exo-teams send-file, and returns the message id read back", () => {
  const env = mockHost({ localFiles: { [REPORT]: { content: REPORT_CONTENT } } });
  env.install(); env.signIn();
  const sent = result(command("send-file", [ALEX_CHAT, "C:\\docs\\report.pdf", "--message", "here", "&", "there", "--key", "f1"]));
  assert.equal(sent.status, "sent");
  assert.equal(sent.messageId, "1759744800555");
  assert.deepEqual(sent.file, { name: "report.pdf", bytes: Buffer.byteLength(REPORT_CONTENT) });
  assert.equal(sent.destination.label, "Alexander Kouznetsov");
  const upload = env.exoCalls().find((call) => call.args[0] === "send-file");
  assert.deepEqual(upload.args, ["send-file", ALEX_CHAT, "--file", "C:\\docs\\report.pdf", "--message", "here &amp; there", "--json"]);
  assert.equal(upload.timeoutMs, C.TIMEOUTS.sendFile);
  const probe = env.calls.find((call) => call.bin === "powershell.exe" && call.env.CT_FILE);
  assert.match(probe.raw, /^D:\\Win\\System32\\/);
  assert.equal(probe.env.CT_FILE, "C:\\docs\\report.pdf");
  assert.equal(probe.env.CT_MAX_BYTES, String(C.MAX_FILE_BYTES));
  assert.equal(probe.args.some((arg) => arg.includes("report.pdf")), false, "the path travels in the environment, not in a command string");
  const outbox = JSON.stringify(JSON.parse(env.files.get(normalize(plugin.__test_paths().outbox))));
  assert.equal(/report|there|SECRET/.test(outbox), false, "the ledger holds neither the file name, the message, nor contents");
  for (const call of env.calls) assert.equal(JSON.stringify(call).includes("SECRET-FILE-CONTENT"), false, "file contents never reach a process argument or environment");
  assert.equal(JSON.stringify(sent).includes("SECRET"), false);
  const again = result(command("send-file", [ALEX_CHAT, "C:\\docs\\report.pdf", "--message", "here", "&", "there", "--key", "f1"]));
  assert.equal(again.messageId, "1759744800555");
  assert.equal(env.exoCalls().filter((call) => call.args[0] === "send-file").length, 1, "a sent key is never resent");
  env.state.localFiles[REPORT] = { content: `${REPORT_CONTENT} v2` };
  assert.match(command("send-file", [ALEX_CHAT, "C:\\docs\\report.pdf", "--message", "here", "&", "there", "--key", "f1"]).error, /^invalid-request:.*different chat, text or file/);
});

test("send-file to a person uses the existing 1:1 chat and refuses a person without one", () => {
  const env = mockHost({ localFiles: { "C:/docs/my notes.txt": { content: "notes" } } });
  env.install(); env.signIn();
  const sent = result(command("send-file", ["Alexander", "Kouznetsov", "C:\\docs\\my", "notes.txt", "--key", "f2"]));
  assert.equal(sent.destination.id, ALEX_CHAT);
  assert.deepEqual(env.exoCalls().find((call) => call.args[0] === "send-file").args, ["send-file", ALEX_CHAT, "--file", "C:\\docs\\my notes.txt", "--json"]);
  assert.match(command("send-file", ["Boris Petrov", "C:\\docs\\my notes.txt", "--key", "f3"]).error, /^invalid-request:.*existing chat/);
  assert.equal(env.exoCalls().some((call) => call.args[0] === "new-dm"), false);
});

test("send-file refuses bad paths, oversize, unreadable, directory, link and plugin-data files before any upload", () => {
  const env = mockHost({ localFiles: {
    "C:/big.iso": { content: "x", size: C.MAX_FILE_BYTES + 1 },
    "C:/limit.bin": { content: "y", size: C.MAX_FILE_BYTES },
    "C:/dir": { dir: true },
    "C:/locked.txt": { content: "z", denied: true },
    "C:/link.txt": { content: "l", link: true },
  } });
  env.install(); env.signIn();
  const big = command("send-file", [ALEX_CHAT, "C:\\big.iso"]).error;
  assert.match(big, /^file-too-large:.*25 MiB/);
  assert.match(command("send-file", [ALEX_CHAT, "C:\\missing.txt"]).error, /^file-unreadable: No file exists/);
  assert.match(command("send-file", [ALEX_CHAT, "C:\\dir"]).error, /^file-unreadable:.*directory/);
  assert.match(command("send-file", [ALEX_CHAT, "C:\\locked.txt"]).error, /^file-unreadable:.*may not read/);
  assert.match(command("send-file", [ALEX_CHAT, "C:\\link.txt"]).error, /^invalid-request:.*link or junction/);
  assert.match(command("send-file", [ALEX_CHAT, "docs\\report.pdf"]).error, /^invalid-request:.*absolute path/);
  assert.match(command("send-file", [ALEX_CHAT]).error, /^invalid-request:/);
  assert.match(command("send-file", [ALEX_CHAT, "C:\\a.txt", "--key"]).error, /^invalid-request:.*--key/);
  assert.equal(env.exoCalls().some((call) => call.args[0] === "send-file"), false);
  assert.equal(result(command("send-file", [ALEX_CHAT, "C:\\limit.bin", "--key", "edge"])).status, "sent", "exactly the limit is allowed");
  assert.match(result(command("health")).lastSend.state, /sent/);
});

test("a token file or a link into the plugin data is never sent (macOS probe via realpath, wc and shasum)", () => {
  const env = mockHost({ platform: "darwin" });
  env.install(); env.signIn();
  const token = `${env.root()}/exo-home/.exo-teams/token-skype.jwt`;
  env.state.localFiles[token] = { content: "eyJsecret" };
  env.state.localFiles["/tmp/innocent.txt"] = { content: "eyJsecret", real: token };
  env.state.localFiles["/Users/me/report.pdf"] = { content: REPORT_CONTENT };
  assert.match(command("send-file", [ALEX_CHAT, token]).error, /^invalid-request:.*data directory/);
  assert.match(command("send-file", [ALEX_CHAT, "/tmp/innocent.txt"]).error, /^invalid-request:.*data directory/);
  assert.equal(env.exoCalls().some((call) => call.args[0] === "send-file"), false);
  const sent = result(command("send-file", ["Alexander Kouznetsov", "/Users/me/report.pdf", "--key", "mac1"]));
  assert.equal(sent.file.name, "report.pdf");
  assert.deepEqual(env.calls.filter((call) => ["realpath", "wc", "shasum"].includes(call.bin)).map((call) => call.bin).slice(-4), ["realpath", "realpath", "wc", "shasum"]);
  assert.equal(env.exoCalls().find((call) => call.args[0] === "send-file").args[3], "/Users/me/report.pdf");
});

test("send-file outcomes keep the ledger rules: unreadable and upload failures are definite, a lost post stays unknown", () => {
  let env = mockHost({ localFiles: { [REPORT]: { content: REPORT_CONTENT } }, sendFileResult: { code: 1, stdout: "", stderr: "Error: sending file C:\\docs\\report.pdf: uploading to OneDrive: uploading to OneDrive: PUT https://graph.microsoft.com/v1.0/me/drive/root:/x:/content returned status 403" } });
  env.install(); env.signIn();
  assert.match(command("send-file", [ALEX_CHAT, REPORT, "--key", "u1"]).error, /^upstream-rejected:.*no chat message was posted/);
  assert.equal(JSON.parse(env.files.get(normalize(plugin.__test_paths().outbox))).attempts[0].state, "failed");
  env = mockHost({ localFiles: { [REPORT]: { content: REPORT_CONTENT } }, sendFileResult: { code: 1, stdout: "", stderr: "Error: reading file C:\\docs\\report.pdf: open C:\\docs\\report.pdf: The process cannot access the file because it is being used by another process." } });
  env.install(); env.signIn();
  assert.match(command("send-file", [ALEX_CHAT, REPORT, "--key", "u2"]).error, /^file-unreadable:/);
  env = mockHost({ localFiles: { [REPORT]: { content: REPORT_CONTENT } }, sendFileResult: { code: 1, stdout: "", stderr: "Error: sending file C:\\docs\\report.pdf: sending message with file: executing POST https://emea.ng.msg.teams.microsoft.com/v1/x: context deadline exceeded" } });
  env.install(); env.signIn();
  assert.match(command("send-file", [ALEX_CHAT, REPORT, "--key", "u3"]).error, /^unknown:/);
  assert.match(command("send-file", [ALEX_CHAT, REPORT, "--key", "u3"]).error, /^unknown:/);
  assert.equal(env.exoCalls().filter((call) => call.args[0] === "send-file").length, 1);
  env = mockHost({ localFiles: { [REPORT]: { content: REPORT_CONTENT } } });
  env.install(); env.signIn();
  assert.equal(JSON.parse(plugin.viewCall("setSendScope", { mode: "only", chats: [{ id: GROUP_CHAT, title: "Group" }] }).result).mode, "only");
  assert.match(command("send-file", [ALEX_CHAT, REPORT, "--key", "u4"]).error, /^chat-not-allowed:|Restrict agent sends/);
  assert.equal(env.exoCalls().some((call) => call.args[0] === "send-file"), false);
});

const SEARCH_MESSAGES = {
  [ALEX_CHAT]: [
    { id: "a1", messagetype: "RichText/Html", content: "<p>the invoice for October is attached</p>", imdisplayname: "Alexander Kouznetsov", originalarrivaltime: "2026-10-06T09:00:00.000Z" },
    { id: "a2", messagetype: "Text", content: "lunch?", imdisplayname: "Alexander Kouznetsov", originalarrivaltime: "2026-10-06T09:05:00.000Z" },
  ],
  [GROUP_CHAT]: [
    { id: "g1", messagetype: "RichText/Html", content: "Invoice sent to the client", imdisplayname: "Anna Ivanova", originalarrivaltime: "2026-10-05T10:00:00.000Z" },
    { id: "g2", messagetype: "RichText/Html", content: "new invoice draft", imdisplayname: "Andrey Kovalev", originalarrivaltime: "2026-10-06T12:00:00.000Z" },
  ],
  "19:meeting_x@thread.v2": [],
};

test("search-messages scans recent chats and returns chat, sender, time, snippet and message id, newest first", () => {
  const env = mockHost({ chatMessages: SEARCH_MESSAGES });
  env.install(); env.signIn();
  const found = result(command("search-messages", ["invoice"]));
  assert.deepEqual(found.hits.map((hit) => [hit.messageId, hit.chat, hit.from]), [
    ["g2", "Alexander Kouznetsov, Anna Ivanova", "Andrey Kovalev"],
    ["a1", "Alexander Kouznetsov", "Alexander Kouznetsov"],
    ["g1", "Alexander Kouznetsov, Anna Ivanova", "Anna Ivanova"],
  ]);
  assert.deepEqual(Object.keys(found.hits[1]).sort(), ["chat", "chatId", "createdDateTime", "from", "messageId", "snippet", "untrusted"]);
  assert.equal(found.hits[1].chatId, ALEX_CHAT);
  assert.equal(found.hits[1].createdDateTime, "2026-10-06T09:00:00.000Z");
  assert.equal(found.hits[1].snippet, "the invoice for October is attached");
  assert.deepEqual(found.scanned, { chats: 3, of: 3, messagesPerChat: C.SEARCH_RECENT_MESSAGES, unreadable: [] });
  assert.equal(found.complete, true);
  assert.equal(found.chat, null);
  for (const call of env.exoCalls().filter((call) => call.args[0] === "get-chat")) assert.deepEqual(call.args.slice(2), ["--json", "--count", String(C.SEARCH_RECENT_MESSAGES)]);
  const limited = result(command("search-messages", ["invoice", "--limit", "1"]));
  assert.equal(limited.hits.length, 1);
  assert.equal(limited.truncated, true);
  assert.deepEqual(result(command("search-messages", ["invoice", "october"])).hits.map((hit) => hit.messageId), ["a1"]);
  assert.deepEqual(result(command("search-messages", ["nothing", "here"])).hits, []);
  assert.equal(result(command("search", ["Alexander", "Kouznetsov"])).match.id, ALEX_CHAT, "search stays the chat lookup");
});

test("search-messages --chat reads one chat deeper, by id or name, and refuses an ambiguous or unknown chat", () => {
  const env = mockHost({ chatMessages: SEARCH_MESSAGES });
  env.install(); env.signIn();
  const byName = result(command("search-messages", ["invoice", "--chat", "Alexander Kouznetsov"]));
  assert.deepEqual(byName.chat, { id: ALEX_CHAT, title: "Alexander Kouznetsov" });
  assert.deepEqual(byName.hits.map((hit) => hit.messageId), ["a1"]);
  assert.equal(byName.scanned.messagesPerChat, C.SEARCH_CHAT_MESSAGES);
  const reads = env.exoCalls().filter((call) => call.args[0] === "get-chat");
  assert.deepEqual(reads.map((call) => call.args[1]), [ALEX_CHAT]);
  assert.equal(reads[0].args.at(-1), String(C.SEARCH_CHAT_MESSAGES));
  assert.deepEqual(result(command("search-messages", ["invoice", "--chat", GROUP_CHAT])).hits.map((hit) => hit.messageId), ["g2", "g1"]);
  assert.match(command("search-messages", ["invoice", "--chat", "Nobody"]).error, /^chat-not-found:/);
  assert.match(command("search-messages", ["invoice", "--chat", "19:nope@thread.v2"]).error, /^chat-not-found:/);
  assert.match(command("search-messages", ["x"]).error, /^invalid-request:/);
  assert.match(command("search-messages", ["invoice", "--limit", "99"]).error, /^invalid-request:/);
  assert.match(command("search-messages", ["invoice", "--chat"]).error, /^invalid-request:/);
  const twins = mockHost({ chatMessages: SEARCH_MESSAGES, chats: RAW_CHATS.concat([{ id: "19:alex2@unq.gbl.spaces", isOneOnOne: true, members: [{ friendlyName: "Andrey Kovalev" }, { friendlyName: "Alexander Petrov" }] }]) });
  twins.install(); twins.signIn();
  assert.match(command("search-messages", ["invoice", "--chat", "Alexander"]).error, /^invalid-request: Several chats match/);
  assert.equal(twins.exoCalls().some((call) => call.args[0] === "get-chat"), false, "an ambiguous chat is never guessed");
});

test("search-messages stops at its time budget, reports unreadable chats, and surfaces an expired session", () => {
  let clock = Date.parse("2026-10-06T12:00:00.000Z");
  const env = mockHost({ chatMessages: { [ALEX_CHAT]: SEARCH_MESSAGES[ALEX_CHAT] }, onGetChat: () => { clock += C.SEARCH_BUDGET_MS / 2 + 1; } });
  env.install(); env.signIn();
  plugin.__test_setClock(() => clock);
  try {
    const partial = result(command("search-messages", ["invoice"]));
    assert.equal(partial.scanned.chats, 2);
    assert.equal(partial.complete, false);
    assert.deepEqual(partial.scanned.unreadable, [GROUP_CHAT]);
    assert.deepEqual(partial.hits.map((hit) => hit.messageId), ["a1"]);
    assert.match(partial.note, /2 most recently active of 3 chats/);
  } finally { plugin.__test_setClock(null); }
  const none = mockHost({ chatMessages: {} });
  none.install(); none.signIn();
  assert.match(command("search-messages", ["invoice"]).error, /^upstream-rejected:/);
  const expired = mockHost({ chatMessages: SEARCH_MESSAGES });
  expired.install(); expired.signIn();
  expired.state.getChatError = 'Error: auto-refresh failed: refreshing skype token: token endpoint returned 400: {"error":"invalid_grant","error_description":"AADSTS700082: The refresh token has expired due to inactivity."}';
  assert.match(command("search-messages", ["invoice"]).error, /^reauth-needed:.*AADSTS700082/);
});

test("the manifest lets agents discover send-file and search-messages, and allows the unix probe tools", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "plugin.json"), "utf8"));
  for (const verb of ["send-file <chat-or-person> <absolute path>", "search-messages <query> [--chat <chat>] [--limit N]", "search <name|email>"]) assert.ok(manifest.configHelp.includes(verb), verb);
  assert.match(manifest.description, /search message text/);
  assert.match(manifest.description, /files/);
  for (const bin of ["wc", "realpath"]) assert.ok(manifest.permissions.subprocess.allow.includes(bin), bin);
  const readme = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");
  assert.match(readme, /send-file/);
  assert.match(readme, /search-messages/);
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
