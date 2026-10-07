const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

function load(over = {}) {
  const host = {
    platform: () => "linux",
    settingsJson: () => "{}",
    shell: { quoteFor: (v) => "'" + v.replace(/'/g, "'\\''") + "'" },
    fs: { readDir: () => [], readFileHead: () => null },
    ...over,
  };
  const context = { host, module: { exports: {} }, exports: {} };
  new vm.Script(readFileSync(join(__dirname, "plugin.js"), "utf8")).runInNewContext(context);
  return context.module.exports.default;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const parse = (text) => plain(load().parseSessionDelta(text).messages);
const text = (row) => row.blocks[0].data.text;
const contents = (rows) => rows.map(text);
const tests = [];
const test = (name, run) => tests.push([name, run]);

test("marketplace metadata, icon and model catalogue", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json")));
  const pkg = JSON.parse(readFileSync(join(__dirname, "package.json")));
  const channel = JSON.parse(readFileSync(join(__dirname, "../channel.json"))).plugins.find(p => p.id === "aider");
  assert.equal(manifest.id, "aider");
  assert.equal(pkg.name, "@codeterm/plugin-aider");
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.version, channel.version);
  assert.equal(channel.path, "aider");
  assert.equal(channel.minCodeterm, manifest.minCodeterm);
  assert.equal(manifest.minCodeterm, "1.12.4");
  assert.equal(manifest.icon, "icon.svg");
  assert.ok(readFileSync(join(__dirname, manifest.icon), "utf8").includes("<svg"));
  assert.ok(manifest.models.some(m => m.id === "openai/mimo-v2.6-pro"));
  assert.equal(manifest.spawn.composerCursorPosition, "prompt_line");
  assert.equal(manifest.spawn.inputFallbackMs, 5000);
  assert.equal(manifest.spawn.onboardingAutoAnswer, "always");
  assert.equal(manifest.spawn.hasHooks, false);
});
test("settings schema exposes the three launch settings", () => {
  const schema = JSON.parse(readFileSync(join(__dirname, "settings.schema.json")));
  assert.deepEqual(schema[0].fields.map(f => f.key).sort(), ["apiBase", "apiKeySecret", "configPath"]);
});
test("full access maps to --yes-always and stays off otherwise", () => {
  const p = load({});
  assert.match(p.buildLaunchCommand({cwd: "/work", skipPermissions: true}), /--yes-always/);
  assert.doesNotMatch(p.buildLaunchCommand({cwd: "/work"}), /--yes-always/);
});
test("runtime settings and nonce are applied in the launch shell", () => {
  const p = load({settingsJson: () => JSON.stringify({apiBase: "https://example.test/v1", apiKeySecret: "mimo-key", configPath: "/work/aider.yml"})});
  const command = p.buildLaunchCommand({cwd: "/work", launchMarker: "nonce", args: ["--model", "openai/mimo-v2.6-pro"]});
  assert.match(command, /OPENAI_API_BASE='https:\/\/example.test\/v1'/);
  assert.match(command, /codeterm mem secret get --name 'mimo-key'/);
  assert.match(command, /--config '\/work\/aider.yml'/);
  assert.match(command, /CODETERM_SESSION_BINDING_NONCE='nonce'/);
  assert.match(command, /--chat-history-file/);
  assert.match(command, /--input-history-file/);
  assert.match(command, /--no-pretty/);
});
test("Windows launch fetches the key in PowerShell", () => {
  const command = load({platform: () => "windows", settingsJson: () => '{"apiKeySecret":"mimo-key"}'}).buildLaunchCommand({cwd: "D:/repo"});
  assert.match(command, /\$env:OPENAI_API_KEY=\(codeterm mem secret get/);
  assert.match(command, /\$\(\$env:CODETERM_SESSION_BINDING_NONCE\)\.md/);
});
test("onboarding answers gitignore and documentation dialogs", () => {
  const p = load();
  assert.equal(p.launchOnboardingResponse("Add .aider* to .gitignore (recommended)? (Y)es/(N)o [Yes]:").step, "WQ==");
  assert.equal(p.launchOnboardingResponse("Open documentation url for more info? (Y)es/(N)o/(D)on't ask again [Yes]:").step, "RA==");
});
test("detection requires Aider output and a prompt", () => {
  const p = load();
  assert.equal(p.detectFromOutput("Aider v0.86\nModel: openai/mimo-v2.6-pro"), true);
  assert.equal(p.screenHasTui("Aider v0.86\n>"), true);
  assert.equal(p.screenHasTui("$ ls"), false);
});
test("binding selects fresh newest history excluding other sessions", () => {
  const now = Date.now();
  const p = load({fs: {readDir: () => [
    {name: "old.md", modifiedMs: now - 60000},
    {name: "a.md", modifiedMs: now - 100},
    {name: "b.md", modifiedMs: now},
    {name: "b.input", modifiedMs: now + 1},
  ]}});
  assert.equal(p.detectSessionId("/work", ["b"], 10000), "a");
  assert.equal(p.detectSessionId("/work", ["a", "b"], 10000), null);
});
test("session file paths use per-tab history", () => {
  const p = load();
  assert.equal(p.sessionFilePath("/work", "nonce"), "/work/.aider/history/nonce.md");
  assert.equal(p.sessionJsonlPath("/work", "nonce"), p.sessionFilePath("/work", "nonce"));
});
test("single send is exactly one user row and one answer", () => {
  const rows = parse("#### Hello\n\nHello there\n\n");
  assert.deepEqual(rows.map(r => r.role), ["user", "assistant"]);
  assert.deepEqual(contents(rows), ["Hello", "Hello there"]);
  assert.equal(rows[0].recordIndex, 0);
  assert.equal(rows[1].recordIndex, 2);
});
test("multiline user headings are one row", () => {
  assert.deepEqual(contents(parse("#### first  \n#### second  \n#### third\n\nAnswer\n")), ["first\nsecond\nthird", "Answer"]);
});
test("blank lines inside multiline user input are preserved", () => {
  assert.deepEqual(contents(parse("#### first  \n####   \n#### last\n\nAnswer\n")), ["first\n\nlast", "Answer"]);
});
test("repeated identical sends stay separate", () => {
  const rows = parse("#### Hi\n\nYes\n\n#### Hi\n\nYes\n");
  assert.deepEqual(contents(rows), ["Hi", "Yes", "Hi", "Yes"]);
  assert.notEqual(rows[0].uuid, rows[2].uuid);
});
test("blank and placeholder user turns are dropped", () => {
  assert.deepEqual(contents(parse("#### \n\n#### <blank>\n\n#### Real\n\nAnswer\n")), ["Real", "Answer"]);
});
test("session headers and startup metadata are hidden", () => {
  assert.deepEqual(parse("# aider chat started at 2026-10-07 10:00:00\n\n> Aider v0.86  \n> Model: test  \n> Git repo: .git  \n> Repo-map: using 4096 tokens  \n"), []);
});
test("token and repo chatter after an answer is hidden", () => {
  assert.deepEqual(contents(parse("#### Q\n\nAnswer\n> Tokens: 10 sent, 5 received.  \n> Added x.ts to the chat  \nRepo Map: 4096 tokens\nTokens: 5\n")), ["Q", "Answer"]);
});
test("ordinary blockquoted tool chatter is dropped", () => {
  assert.deepEqual(contents(parse("#### Q\n\n> Run shell command?  \n> Done  \nAnswer\n")), ["Q", "Answer"]);
});
test("fenced markdown and indentation are preserved", () => {
  const answer = "Example:\n\n```ts\n  const value = 1;\n#### literal heading\n> Tokens: literal code\n```\n\nDone.";
  assert.equal(text(parse("#### Q\n\n" + answer + "\n")[1]), answer);
});
test("tilde fences protect thinking syntax and headings", () => {
  const answer = "~~~~html\n<thinking-content-x>literal</thinking-content-x>\n#### code\n~~~~";
  assert.equal(text(parse("#### Q\n\n" + answer + "\n")[1]), answer);
});
test("thinking blocks are removed", () => {
  assert.deepEqual(contents(parse("#### Q\n\n<thinking-content-x>\nhidden\n</thinking-content-x>\nAnswer\n")), ["Q", "Answer"]);
});
test("unclosed thinking never leaks", () => {
  assert.deepEqual(contents(parse("#### Q\n\n<thinking-content-x>\nhidden\n")), ["Q"]);
});
test("inline multiple thinking blocks preserve visible text", () => {
  assert.deepEqual(contents(parse("#### Q\n\nA<thinking-content-x>hide</thinking-content-x>B<thinking-content-y>hide</thinking-content-y>C\n")), ["Q", "ABC"]);
});
test("authentication errors are readable and keep continuation", () => {
  assert.deepEqual(contents(parse("#### Q\n\n> litellm.AuthenticationError: Invalid key  \n> Check your API credentials.  \n> Tokens: 0 sent  \n")), ["Q", "litellm.AuthenticationError: Invalid key\nCheck your API credentials."]);
});
test("startup errors without a user turn are visible", () => {
  assert.deepEqual(contents(parse("> Model: test  \n> litellm.AuthenticationError: Invalid API key  \n")), ["litellm.AuthenticationError: Invalid API key"]);
});
test("connection and empty response errors are visible", () => {
  assert.equal(parse("> APIConnectionError: offline\n")[0].role, "assistant");
  assert.equal(text(parse("> Empty response received from LLM. Check your provider account?\n")[0]), "Empty response received from LLM. Check your provider account?");
});
test("empty input has no rows", () => assert.deepEqual(parse(""), []));

// Simulate the host's complete-line chunks and its UUID merge. Each hook gets
// an explicit prefix ending at that delta boundary, never hidden parser state.
function tail(parts) {
  let prefix = "";
  let offset = 0;
  const merged = new Map();
  const deltas = [];
  const p = load({fs: {readFileHead: (_path, size) => Buffer.from(prefix).subarray(0, size).toString("utf8")}});
  for (const part of parts) {
    prefix += part;
    const rows = plain(p.parseSessionDelta(part, {session_key: "/work/history.md", from_offset: offset}).messages);
    deltas.push(rows);
    rows.forEach(row => merged.set(row.uuid, row));
    offset += Buffer.byteLength(part);
  }
  return {rows: [...merged.values()], deltas};
}
test("user-only and answer-only chunks retain both rows once", () => {
  const result = tail(["#### Hi\n\n", "Hello\n\n", "> Tokens: 1\n"]);
  assert.deepEqual(contents(result.rows), ["Hi", "Hello"]);
  assert.equal(result.deltas[2].length, 0);
});
test("split assistant paragraphs update the same UUID", () => {
  const result = tail(["#### Q\n\nFirst\n", "\nSecond\n"]);
  assert.deepEqual(contents(result.rows), ["Q", "First\n\nSecond"]);
  assert.equal(result.deltas[0][1].uuid, result.deltas[1][0].uuid);
});
test("split multiline user send stays one row", () => {
  assert.deepEqual(contents(tail(["#### first  \n", "#### second\n\n", "Answer\n"]).rows), ["first\nsecond", "Answer"]);
});
test("split fenced code protects role markers", () => {
  assert.deepEqual(contents(tail(["#### Q\n\n```md\n", "#### code\n> Tokens: code\n", "```\nDone\n"]).rows), ["Q", "```md\n#### code\n> Tokens: code\n```\nDone"]);
});
test("split thinking blocks never emit reasoning", () => {
  const result = tail(["#### Q\n\n<thinking-content-x>\n", "hidden\n", "</thinking-content-x>\nAnswer\n"]);
  assert.deepEqual(contents(result.rows), ["Q", "Answer"]);
  assert.equal(result.deltas[1].length, 0);
});
test("split error continuation updates a single error row", () => {
  assert.deepEqual(contents(tail(["#### Q\n\n", "> litellm.AuthenticationError: bad key\n", "> Check the key.\n", "> Tokens: 0\n"]).rows), ["Q", "litellm.AuthenticationError: bad key\nCheck the key."]);
});
test("Unicode CRLF byte positions remain stable", () => {
  const result = tail(["#### Привіт 😀\r\n\r\n", "Hello 😀\r\n", "More\r\n"]);
  assert.deepEqual(contents(result.rows), ["Привіт 😀", "Hello 😀\nMore"]);
  assert.equal(result.rows[1].uuid, `aider:assistant:${Buffer.byteLength("#### Привіт 😀\r\n\r\n")}`);
});
test("independent sessions and rereads do not share state", () => {
  const a = parse("#### A\n\nOne\n");
  parse("#### B\n\nTwo\n");
  assert.deepEqual(parse("#### A\n\nOne\n"), a);
});
test("unreadable prior context returns no misleading rows", () => {
  assert.deepEqual(plain(load().parseSessionDelta("#### code\n", {session_key: "missing", from_offset: 200})), {messages: []});
});
test("multiline delivery uses a collision-free tagged block", () => {
  assert.equal(load().chatPreprocess({provider: "aider", text: "first\nsecond"}).text, "{domios\nfirst\nsecond\ndomios}");
  assert.equal(load().chatPreprocess({provider: "aider", text: "{domios}\nsecond"}).text, "{domios1\n{domios}\nsecond\ndomios1}");
});

test("every complete-line split converges to the same clean transcript", () => {
  const source = "# aider chat started at 2026-10-07 10:00:00\n> Model: test\n#### first  \n#### last\n\n<thinking-content-x>\nhidden\n</thinking-content-x>\nAnswer\n\n```md\n#### code\n> Tokens: code\n```\n> Tokens: 5\n\n#### Again\n\n> litellm.AuthenticationError: bad key\n> Check credentials.\n";
  const expected = contents(parse(source));
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "\n") continue;
    assert.deepEqual(contents(tail([source.slice(0, i + 1), source.slice(i + 1)]).rows), expected, `split at ${i}`);
  }
});

const permissionQuestion = "Create new file? (Y)es/(N)o [Yes]:";
test("unanswered final permission question is reported", () => {
  const p = load();
  const screen = "Aider v0.86\n> old prompt\nhello.py\n" + permissionQuestion + "\n\n";
  assert.equal(p.parsePrompt(screen).question, permissionQuestion);
  assert.deepEqual(plain(p.detectEvents(screen)), ["permission_request"]);
  assert.equal(p.hasEventMarkers(screen), true);
});
test("idle composer suppresses stale permission prompts and events", () => {
  const p = load();
  for (const composer of [">", "ask>", "code>"]) {
    const screen = permissionQuestion + "\nApplied edit to hello.py\n" + composer + "\n\n";
    assert.equal(p.parsePrompt(screen), null);
    assert.deepEqual(plain(p.detectEvents(screen)), []);
    assert.equal(p.hasEventMarkers(screen), false);
    assert.equal(p.launchOnboardingResponse(screen), null);
    assert.equal(p.launchOnboardingSafeChoice(screen), null);
  }
});
test("answered question on its original line is no longer live", () => {
  const p = load();
  const screen = permissionQuestion + " y\n";
  assert.equal(p.parsePrompt(screen), null);
  assert.deepEqual(plain(p.detectEvents(screen)), []);
});
test("generation following a stale question does not reopen the banner", () => {
  const p = load();
  const screen = permissionQuestion + "\nGenerating a response...\n";
  assert.equal(p.parsePrompt(screen), null);
  assert.deepEqual(plain(p.detectEvents(screen)), []);
});
test("latest unanswered question wins over an older question", () => {
  const p = load();
  const last = "Run shell command? (Y)es/(N)o";
  assert.equal(p.parsePrompt(permissionQuestion + "\n>\n" + last).question, last);
});
test("onboarding ignores old dialogs after the composer returns", () => {
  const p = load();
  const screen = "Add .aider* to .gitignore (recommended)? (Y)es/(N)o [Yes]:\nAider v0.86\n>";
  assert.equal(p.launchOnboardingResponse(screen), null);
  assert.equal(p.launchOnboardingSafeChoice(screen), null);
  assert.deepEqual(plain(p.detectEvents(screen)), []);
});

let failed = 0;
for (const [name, run] of tests) {
  try { run(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}`); console.error(err); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
