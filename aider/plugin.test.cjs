const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

function load(over = {}) {
  const host = {
    platform: () => "linux",
    settingsJson: () => "{}",
    shell: { quoteFor: (v) => "'" + v.replace(/'/g, "'\\''") + "'" },
    fs: { readDir: () => [], readFileHead: () => null, readFile: () => null, expandHome: p => p.replace("~/.codeterm", "/installed") },
    ...over,
  };
  const context = { host, module: { exports: {} }, exports: {} };
  new vm.Script(readFileSync(join(__dirname, "plugin.js"), "utf8")).runInNewContext(context);
  return context.module.exports.default;
}
const mimoEndpoint = {name: "MiMo", kind: "openai", apiBase: "https://example.test/v1", apiKeySecret: "mimo-key", models: ["openai/mimo-v2.6-pro"]};
// Existing launch/parser cases exercise the explicit plain path; adapter cases
// below supply their own settings to exercise the default and failure modes.
const configured = (endpoints, over = {}) => load({settingsJson: () => JSON.stringify({endpoints, plainMode: true}), ...over});
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
  assert.deepEqual(manifest.models, []);
  assert.equal(manifest.defaultModel, undefined);
  assert.equal(manifest.modelCatalogue.authority, "authoritative");
  assert.equal(manifest.spawn.composerCursorPosition, "prompt_line");
  assert.equal(manifest.spawn.inputFallbackMs, 5000);
  assert.equal(manifest.spawn.onboardingAutoAnswer, "always");
  assert.equal(manifest.spawn.hasHooks, false);
});
test("settings schema exposes config and endpoint list", () => {
  const schema = JSON.parse(readFileSync(join(__dirname, "settings.schema.json")));
  assert.deepEqual(schema[0].fields.map(f => f.key).sort(), ["configPath", "endpoints", "plainMode"]);
});
test("full access maps to --yes-always and stays off otherwise", () => {
  const p = configured([mimoEndpoint]);
  assert.match(p.buildLaunchCommand({cwd: "/work", skipPermissions: true}), /--yes-always/);
  assert.doesNotMatch(p.buildLaunchCommand({cwd: "/work"}), /--yes-always/);
});
test("runtime settings and nonce are applied in the launch shell", () => {
  const p = load({settingsJson: () => JSON.stringify({endpoints: [mimoEndpoint], configPath: "/work/aider.yml"})});
  const command = p.buildLaunchCommand({cwd: "/work", launchMarker: "nonce", args: ["--model", "openai/mimo-v2.6-pro"]});
  assert.match(command, /OPENAI_API_BASE='https:\/\/example.test\/v1'/);
  assert.match(command, /codeterm mem secret get --name 'mimo-key'/);
  assert.match(command, /--config '\/work\/aider.yml'/);
  assert.match(command, /DOMIOS_AIDER_SESSION_ID='nonce'/);
  assert.doesNotMatch(command, /(?:export |\$env:)CODETERM_SESSION_BINDING_NONCE=/);
  assert.match(command, /--chat-history-file/);
  assert.match(command, /--input-history-file/);
  assert.match(command, /--no-pretty/);
});
test("Windows launch fetches the key in PowerShell", () => {
  const command = configured([mimoEndpoint], {platform: () => "windows"}).buildLaunchCommand({cwd: "D:/repo"});
  assert.match(command, /\$env:OPENAI_API_KEY=\(codeterm mem secret get/);
  assert.match(command, /\$\(\$env:DOMIOS_AIDER_SESSION_ID\)\.md/);
});

test("launch leaves the framed task to confirmed PTY delivery and stays interactive", () => {
  const task = "-=-codeterm:tab label=Fermi tab=sender-=-\nInspect é and `$value`.\n\nName the caller's file.";
  for (const platform of ["linux", "windows"]) {
    const quoted = [];
    const p = configured([mimoEndpoint], {platform: () => platform,
      shell: {quoteFor: value => {quoted.push(value); return JSON.stringify(value);}}});
    const command = p.buildLaunchCommand({cwd: "/repo", task, starterPrompt: "startup_handshake",
      starterPromptText: "A different host starter"});
    assert.doesNotMatch(command, /--message(?:-file)?\b/);
    assert.ok(!quoted.includes(task));
    assert.ok(!quoted.includes("A different host starter"));
  }
});

test("manifest selects PTY task delivery without native system or starter injection", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json")));
  assert.equal(manifest.spawn.taskDelivery, "pty_input");
  assert.deepEqual(manifest.spawn.systemPromptDelivery, {kind: "external"});
  const p = configured([mimoEndpoint]);
  assert.doesNotMatch(p.buildLaunchCommand({cwd: "/repo", task: "Actual task", starterPrompt: "no_starter"}), /--message/);
  assert.doesNotMatch(p.buildLaunchCommand({cwd: "/repo", starterPromptText: "Host starter"}), /--message/);
  for (const prompt of ["assigned_task", "no_starter", "idle_wakeup", "team_bootstrap", "startup_handshake"]) {
    assert.equal(p.starterPromptText(prompt), undefined);
  }
});

test("launch loads project instructions as read-only context", () => {
  const paths = [];
  const p = configured([mimoEndpoint], {fs: {readFileHead: (path, bytes) => {
    paths.push([path, bytes]);
    return "#";
  }}});
  assert.match(p.buildLaunchCommand({cwd: "/some repo/"}), /--read '\/some repo\/AGENTS.md'/);
  assert.deepEqual(paths, [["/some repo/AGENTS.md", 1]]);
});

test("launch tolerates missing or unreadable project instructions", () => {
  assert.doesNotMatch(configured([mimoEndpoint]).buildLaunchCommand({cwd: "/repo"}), /--read/);
  const p = configured([mimoEndpoint], {fs: {readFileHead: () => {throw new Error("denied");}}});
  assert.doesNotMatch(p.buildLaunchCommand({cwd: "/repo"}), /--read/);
});

test("Windows instructions path is quoted and empty instructions still load", () => {
  const p = configured([mimoEndpoint], {platform: () => "windows", fs: {readFileHead: () => ""}});
  assert.match(p.buildLaunchCommand({cwd: "D:/some repo"}), /--read 'D:\/some repo\/AGENTS.md'/);
});

test("launch reads the primer from the installed instance plugin beside AGENTS", () => {
  const paths = [];
  const primer = "/home/dev/.codeterm-dev/plugins/aider/domios-primer.md";
  const p = configured([mimoEndpoint], {fs: {
    expandHome: path => {
      assert.equal(path, "~/.codeterm/plugins/aider/domios-primer.md");
      return primer;
    },
    readFileHead: (path, bytes) => { paths.push([path, bytes]); return "R"; },
  }});
  const command = p.buildLaunchCommand({cwd: "/project"});
  assert.match(command, /--read '\/project\/AGENTS.md'/);
  assert.ok(command.includes(`--read '${primer}'`));
  assert.deepEqual(paths, [["/project/AGENTS.md", 1], [primer, 1]]);
});

test("missing or unreadable primer does not prevent launch", () => {
  for (const read of [() => null, () => {throw new Error("unreadable");}]) {
    const p = configured([mimoEndpoint], {fs: {
      expandHome: () => "/installed/aider/domios-primer.md",
      readFileHead: path => path.endsWith("AGENTS.md") ? "#" : read(),
    }});
    const command = p.buildLaunchCommand({cwd: "/project"});
    assert.match(command, /--read '\/project\/AGENTS.md'/);
    assert.doesNotMatch(command, /--read '[^']*domios-primer/);
    assert.match(command, /--chat-history-file/);
  }
});

test("primer loads without project instructions and Windows paths stay quoted", () => {
  const primer = "C:/Users/Some User/.codeterm-dev/plugins/aider/domios-primer.md";
  const p = configured([mimoEndpoint], {platform: () => "windows", fs: {
    expandHome: () => primer,
    readFileHead: path => path === primer ? "Rules" : null,
  }});
  const command = p.buildLaunchCommand({cwd: "D:/project"});
  assert.ok(command.includes(`--read '${primer}'`));
  assert.doesNotMatch(command, /--read 'D:\/project\/AGENTS.md'/);
});

test("unresolved or failed primer path expansion does not block launch", () => {
  for (const expandHome of [() => null, () => {throw new Error("unavailable");}]) {
    const command = configured([mimoEndpoint], {fs: {expandHome, readFileHead: () => null}}).buildLaunchCommand({});
    assert.match(command, /--chat-history-file/);
    assert.doesNotMatch(command, /domios-primer/);
  }
});

test("resume launch paths also include the installed Domios primer", () => {
  const primer = "/installed/aider/domios-primer.md";
  const p = configured([mimoEndpoint], {fs: {
    expandHome: () => primer,
    readFileHead: path => path === primer ? "Rules" : null,
  }});
  for (const command of [p.buildResumeCommand("session"), p.buildResumeCommandWithContext({sessionId: "session", cwd: "/project"})]) {
    assert.ok(command.includes(`--read '${primer}'`));
  }
});

test("bundled primer contains only Aider file-reading guidance", () => {
  const primer = readFileSync(join(__dirname, "domios-primer.md"), "utf8");
  assert.ok(Buffer.byteLength(primer) < 2000);
  for (const rule of ["Aider inside a Domios tab", "exact path with forward slashes", "added to the chat automatically", "at most four files"]) {
    assert.ok(primer.includes(rule), rule);
  }
  assert.doesNotMatch(primer, /type="report"|status=|startup-ack|replies go back|You have no tools/);
});

test("core tool-less instructions load alongside AGENTS and primer in both launch modes", () => {
  const shared = "D:/Domios rules/core 'shared'.md";
  const primer = "/installed/plugins/aider/domios-primer.md";
  for (const platform of ["linux", "windows"]) {
    for (const plainMode of [true, false]) {
      const reads = [];
      const p = load({platform: () => platform,
        settingsJson: () => JSON.stringify({endpoints: [mimoEndpoint], plainMode}),
        fs: {expandHome: path => path.replace("~/.codeterm", "/installed"),
          readFileHead: (path, bytes) => {reads.push([path, bytes]); return "Rules";}}});
      const command = p.buildLaunchCommand({cwd: "/repo", toolLessInstructionsPath: shared});
      assert.ok(command.includes("--read 'D:/Domios rules/core '\\''shared'\\''.md'"));
      assert.ok(command.includes("--read '/repo/AGENTS.md'"));
      assert.ok(command.includes(`--read '${primer}'`));
      assert.deepEqual(reads, [[shared, 1], ["/repo/AGENTS.md", 1], [primer, 1]]);
      assert.doesNotMatch(command, /--message(?:-file)?\b/);
    }
  }
});

test("supplied unreadable or invalid core instructions refuse launch", () => {
  for (const read of [() => null, () => {throw new Error("denied");}]) {
    const p = configured([mimoEndpoint], {fs: {readFileHead: read}});
    for (const path of ["/missing/rules.md", "", " ", 42]) {
      assert.throws(() => p.buildLaunchCommand({toolLessInstructionsPath: path}), /tool-less instructions are unreadable/);
    }
  }
});

test("empty readable core file loads and resume context preserves its path", () => {
  const p = configured([mimoEndpoint], {fs: {readFileHead: () => ""}});
  const command = p.buildResumeCommandWithContext({sessionId: "session", cwd: "/repo", toolLessInstructionsPath: "/core/rules.md"});
  assert.ok(command.includes("--read '/core/rules.md'"));
  assert.doesNotThrow(() => p.buildLaunchCommand({cwd: "/repo"}));
});

test("context capability maps files and skills separately from the interactive brief", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json")));
  assert.deepEqual(manifest.capabilities.contextAttach, {editable: true, readOnly: true});
  const contextFiles = {edit: ["/repo/new file.ts", "D:/repo/caller's.ts"],
    read: ["/host/plan-skill.md", "\\\\server\\share\\read.md"]};
  for (const platform of ["linux", "windows"]) {
    for (const plainMode of [true, false]) {
      const reads = [];
      const quotes = [];
      const p = load({platform: () => platform,
        settingsJson: () => JSON.stringify({endpoints: [mimoEndpoint], plainMode}),
        shell: {quoteFor: path => {quotes.push(path); return JSON.stringify(path);}},
        fs: {expandHome: path => path.replace("~/.codeterm", "/installed"),
          readFileHead: path => {reads.push(path); return "";}}});
      const task = '<domios from="tab">Whole brief\nSecond line</domios>';
      const command = p.buildLaunchCommand({cwd: "/repo", task, contextFiles});
      for (const path of contextFiles.edit) assert.ok(command.includes(`--file ${JSON.stringify(path)}`));
      for (const path of contextFiles.read) assert.ok(command.includes(`--read ${JSON.stringify(path)}`));
      assert.deepEqual(reads.slice(0, 2), contextFiles.read);
      assert.ok(!reads.includes(contextFiles.edit[0])); // New editable files need not exist.
      assert.ok(!quotes.includes(task));
      assert.doesNotMatch(command, /--message(?:-file)?\b|\/add|\/read-only/);
    }
  }
});

test("absent or empty attachment lists preserve an interactive launch", () => {
  const p = configured([mimoEndpoint]);
  for (const contextFiles of [undefined, null, {edit: [], read: []}]) {
    const command = p.buildLaunchCommand({contextFiles});
    assert.doesNotMatch(command, /--file\b|--read\b|--message\b/);
    assert.match(command, /--chat-history-file/);
  }
});

test("unreadable requested context refuses instead of dropping a read file", () => {
  for (const read of [() => null, () => {throw new Error("denied");}]) {
    const p = configured([mimoEndpoint], {fs: {readFileHead: read}});
    assert.throws(() => p.buildLaunchCommand({contextFiles: {edit: [], read: ["/missing/skill.md"]}}), /read-only context is unreadable/);
  }
});

test("malformed or unsupported attachment kinds and unresolved paths refuse", () => {
  const p = configured([mimoEndpoint]);
  for (const contextFiles of ["/repo/file", [], {}, {edit: [], read: [], execute: []},
    {edit: "/repo/file", read: []}, {edit: [], read: [false]}, {edit: ["relative.ts"], read: []},
    {edit: ["C:relative.ts"], read: []}, {edit: ["/repo/bad\nfile"], read: []},
    {edit: [], read: ["/repo/bad\0file"]}, {edit: [" "], read: []}]) {
    assert.throws(() => p.buildLaunchCommand({contextFiles}), /Invalid Aider contextFiles/);
  }
});

test("attachment duplicates deduplicate and edit/read overlap refuses", () => {
  const p = configured([mimoEndpoint], {fs: {readFileHead: () => "#"}});
  const command = p.buildLaunchCommand({contextFiles: {edit: ["/repo/edit.ts", "/repo/edit.ts"], read: ["/repo/read.md", "/repo/read.md"]}});
  assert.equal(command.split("--file '/repo/edit.ts'").length - 1, 1);
  assert.equal(command.split("--read '/repo/read.md'").length - 1, 1);
  assert.throws(() => p.buildLaunchCommand({contextFiles: {edit: ["/repo/same"], read: ["/repo/same"]}}), /no overlap/);
});

test("resume context retains editable and read-only attachments", () => {
  const p = configured([mimoEndpoint], {fs: {readFileHead: () => ""}});
  const command = p.buildResumeCommandWithContext({sessionId: "session", cwd: "/repo",
    contextFiles: {edit: ["/repo/edit.ts"], read: ["/host/skill.md"]}});
  assert.ok(command.includes("--file '/repo/edit.ts'"));
  assert.ok(command.includes("--read '/host/skill.md'"));
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
test("thinking blocks use the collapsed host block before the answer", () => {
  const rows = parse("#### Q\n\n<thinking-content-x>\nhidden\n</thinking-content-x>\nAnswer\n");
  assert.deepEqual(contents(rows), ["Q", "hidden", "Answer"]);
  assert.equal(rows[1].role, "assistant");
  assert.equal(rows[1].blocks[0].kind, "thinking");
  assert.equal(rows[2].blocks[0].kind, "text");
});

test("per-turn ask command and its exact Aider expansion are one user row", () => {
  const rows = parse("#### /ask Review this\n\n> Warning: files\n\n#### Review this\n\nAnswer\n");
  assert.deepEqual(contents(rows), ["/ask Review this", "Answer"]);
});

test("mode command echo deduplication survives complete-line tails", () => {
  for (const command of ["ask", "code", "architect", "context"]) {
    const result = tail([`#### /${command} Review\n\n`, "> Added file\n\n", "#### Review\n\n", "Answer\n"]);
    assert.deepEqual(contents(result.rows), [`/${command} Review`, "Answer"]);
  }
});

test("mode echo matching does not swallow real later or different user input", () => {
  assert.deepEqual(contents(parse("#### /ask Q\n\nAnswer\n\n#### Q\n\nOther answer\n")), ["/ask Q", "Answer", "Q", "Other answer"]);
  assert.deepEqual(contents(parse("#### /ask Q\n\n#### Different\n\nAnswer\n")), ["/ask Q", "Different", "Answer"]);
});

test("launch marker binds its exact file even when another tab is newer", () => {
  const p = load({fs: {readDir: () => [
    {name: "first.md", modifiedMs: 10},
    {name: "second.md", modifiedMs: 20},
  ]}});
  for (const launchMarker of ["first", "second"]) {
    assert.deepEqual(plain(p.detectLaunchSession({cwd: "/same", launchMarker, launchedAtMs: 0})), {sessionId: launchMarker, source: "launch_marker"});
  }
});

test("missing launch marker file never borrows a nearby history", () => {
  const p = load({fs: {readDir: () => [{name: "other.md", modifiedMs: Date.now()}]}});
  assert.equal(p.detectLaunchSession({cwd: "/same", launchMarker: "mine", launchedAtMs: 0}), null);
  assert.equal(p.detectLaunchSession({cwd: "/same", launchedAtMs: 0}), null);
});
test("unclosed thinking stays separate from ordinary assistant text", () => {
  const rows = parse("#### Q\n\n<thinking-content-x>\nhidden\n");
  assert.deepEqual(contents(rows), ["Q", "hidden"]);
  assert.equal(rows[1].blocks[0].kind, "thinking");
});
test("inline multiple thinking blocks preserve visible text", () => {
  const rows = parse("#### Q\n\nA<thinking-content-x>hide</thinking-content-x>B<thinking-content-y>hide</thinking-content-y>C\n");
  assert.deepEqual(contents(rows), ["Q", "A", "hide", "B", "hide", "C"]);
  assert.equal(new Set(rows.map(r => r.uuid)).size, rows.length);
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
test("split thinking blocks update one stable reasoning row", () => {
  const result = tail(["#### Q\n\n<thinking-content-x>\n", "hidden\n", "</thinking-content-x>\nAnswer\n"]);
  assert.deepEqual(contents(result.rows), ["Q", "hidden", "Answer"]);
  assert.equal(result.deltas[1][0].blocks[0].kind, "thinking");
  assert.equal(result.deltas[2].length, 1);
});

test("growing Unicode thinking retains its byte identity and paragraphs", () => {
  const result = tail(["#### Q\r\n\r\n<thinking-content-x>\r\n", "Plan 😀\r\n", "\r\nRead files\r\n", "</thinking-content-x>\r\nDone\r\n"]);
  assert.deepEqual(contents(result.rows), ["Q", "Plan 😀\n\nRead files", "Done"]);
  assert.equal(result.deltas[1][0].uuid, result.deltas[2][0].uuid);
  assert.equal(result.rows[1].uuid, `aider:thinking:${Buffer.byteLength("#### Q\r\n\r\n")}`);
});

test("empty thinking tags do not create rows", () => {
  assert.deepEqual(contents(parse("#### Q\n\n<thinking-content-x></thinking-content-x>\nAnswer\n")), ["Q", "Answer"]);
});

test("automatic file-add continuations separate answers without blank floods", () => {
  const source = "#### Review\n\nFirst answer\n> Tokens: 10\n<thinking-content-next>\n" + "Planning\n".repeat(100) + "</thinking-content-next>\nSecond answer\n";
  const rows = parse(source);
  assert.deepEqual(contents(rows).filter((_, i) => rows[i].blocks[0].kind === "text"), ["Review", "First answer", "Second answer"]);
  assert.equal(rows[2].blocks[0].kind, "thinking");
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

test("applied edit is a compact system row after the answer", () => {
  const rows = parse("#### Edit hello.py\n\nHere is the code.\n> Tokens: 10\n> Applied edit to hello.py  \n");
  assert.deepEqual(rows.map(r => r.role), ["user", "assistant", "system"]);
  assert.deepEqual(contents(rows), ["Edit hello.py", "Here is the code.", "Applied edit to hello.py"]);
});
test("multiple edits and a commit share a compact change row", () => {
  const rows = parse("#### Q\n\nDone.\n> Applied edit to src/a.ts  \n> Applied edit to src/b.ts  \n> Commit abc1234 fix both files  \n> Tokens: 5\n");
  assert.equal(rows[2].role, "system");
  assert.equal(text(rows[2]), "Applied edit to src/a.ts\nApplied edit to src/b.ts\nCommit abc1234 fix both files");
});
test("edit paths with spaces and Unicode remain intact", () => {
  const rows = parse("> Applied edit to dir/my файл.py  \n");
  assert.equal(rows[0].role, "system");
  assert.equal(text(rows[0]), "Applied edit to dir/my файл.py");
});
test("dry run edit notices stay visible", () => {
  const rows = parse("> Did not apply edit to hello.py (--dry-run)  \n");
  assert.equal(rows[0].role, "system");
  assert.equal(text(rows[0]), "Did not apply edit to hello.py (--dry-run)");
});
test("change-looking text inside a fence remains assistant code", () => {
  const answer = "```text\n> Applied edit to hello.py\n> Commit abc1234 example\n```";
  const rows = parse("#### Q\n\n" + answer + "\n");
  assert.deepEqual(rows.map(r => r.role), ["user", "assistant"]);
  assert.equal(text(rows[1]), answer);
});
test("change notices split from answer keep chronological roles", () => {
  const result = tail(["#### Q\n\nAnswer\n", "> Applied edit to hello.py  \n", "> Commit abc1234 fix hello  \n", "> Tokens: 5\n"]);
  assert.deepEqual(result.rows.map(r => r.role), ["user", "assistant", "system"]);
  assert.deepEqual(contents(result.rows), ["Q", "Answer", "Applied edit to hello.py\nCommit abc1234 fix hello"]);
  assert.equal(result.deltas[3].length, 0);
});
test("change notices terminate error continuation", () => {
  const rows = parse("> litellm.AuthenticationError: test\n> Applied edit to hello.py\n> Run shell command?\n");
  assert.deepEqual(rows.map(r => r.role), ["assistant", "system"]);
  assert.deepEqual(contents(rows), ["litellm.AuthenticationError: test", "Applied edit to hello.py"]);
});
test("separate turns have separate change identities", () => {
  const rows = parse("#### Q\n\nA\n> Applied edit to hello.py\n\n#### Q\n\nA\n> Applied edit to hello.py\n");
  const edits = rows.filter(r => r.role === "system");
  assert.equal(edits.length, 2);
  assert.notEqual(edits[0].uuid, edits[1].uuid);
});
test("every line split preserves change notices without duplicates", () => {
  const source = "#### Q\n\nAnswer\n> Applied edit to hello.py  \n> Commit abc1234 fix hello  \n> Tokens: 5\n";
  const expected = parse(source);
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "\n") continue;
    assert.deepEqual(tail([source.slice(0, i + 1), source.slice(i + 1)]).rows.map(r => [r.uuid, r.role, text(r)]), expected.map(r => [r.uuid, r.role, text(r)]));
  }
});

test("unconfigured catalogue is empty and launch gives an actionable error", () => {
  assert.deepEqual(plain(load().discoverModels()), []);
  assert.throws(() => load().buildLaunchCommand({}), /Configure an Aider endpoint/);
});
test("catalogue uses model IDs and endpoint names as groups", () => {
  const p = configured([mimoEndpoint, {name: "Anthropic direct", kind: "anthropic", apiKeySecret: "claude-key", models: ["anthropic/claude-sonnet-4-6"]}]);
  assert.deepEqual(plain(p.discoverModels()), [
    {id: "openai/mimo-v2.6-pro", displayName: "openai/mimo-v2.6-pro", group: "MiMo", reasoningEfforts: []},
    {id: "anthropic/claude-sonnet-4-6", displayName: "anthropic/claude-sonnet-4-6", group: "Anthropic direct", reasoningEfforts: []},
  ]);
});
test("model textarea accepts lines and JSON string arrays", () => {
  for (const models of ["openai/a\nopenai/b", '["openai/a","openai/b"]', ["openai/a", "openai/b"]]) {
    assert.deepEqual(plain(configured([{...mimoEndpoint, models}]).discoverModels()).map(m => m.id), ["openai/a", "openai/b"]);
  }
});
test("model IDs are trimmed and deduplicated within an endpoint", () => {
  assert.deepEqual(plain(configured([{...mimoEndpoint, models: [" openai/a ", "openai/a", "", 7]}]).discoverModels()).map(m => m.id), ["openai/a"]);
});
test("invalid endpoints and incompatible model prefixes are omitted", () => {
  const bad = [null, [], {}, {...mimoEndpoint, kind: "__proto__"}, {...mimoEndpoint, kind: "azure"}, {...mimoEndpoint, name: ""}, {...mimoEndpoint, apiKeySecret: ""}, {...mimoEndpoint, models: "[broken"}, {...mimoEndpoint, models: {}}, {...mimoEndpoint, models: ["anthropic/claude"]}];
  assert.deepEqual(plain(configured(bad).discoverModels()), []);
});
test("duplicate model ownership is hidden and rejected on launch", () => {
  const p = configured([mimoEndpoint, {...mimoEndpoint, name: "Other"}]);
  assert.deepEqual(plain(p.discoverModels()), []);
  assert.throws(() => p.buildLaunchCommand({args: ["--model", "openai/mimo-v2.6-pro"]}), /multiple endpoints/);
});
test("unconfigured selected models cannot silently use another key", () => {
  assert.throws(() => configured([mimoEndpoint]).buildLaunchCommand({args: ["--model", "openai/unknown"]}), /no configured endpoint/);
});
test("first unique configured model is the launch default", () => {
  const command = configured([mimoEndpoint]).buildLaunchCommand({});
  assert.match(command, /--model 'openai\/mimo-v2.6-pro'/);
  assert.match(command, /OPENAI_API_KEY/);
});
test("selection supports long equals and short model flags", () => {
  const endpoint = {name: "Claude", kind: "anthropic", apiKeySecret: "claude-key", models: ["anthropic/claude-test"]};
  for (const args of [["--model=anthropic/claude-test"], ["-m", "anthropic/claude-test"], ["--model", "anthropic/claude-test"]]) {
    const command = configured([mimoEndpoint, endpoint]).buildLaunchCommand({args});
    assert.match(command, /ANTHROPIC_API_KEY/);
    assert.doesNotMatch(command, /OPENAI_API_KEY|mimo-key/);
  }
});
test("last model flag determines the endpoint", () => {
  const endpoint = {name: "Claude", kind: "anthropic", apiKeySecret: "claude-key", models: ["anthropic/claude-test"]};
  const command = configured([mimoEndpoint, endpoint]).buildLaunchCommand({args: ["--model", "openai/mimo-v2.6-pro", "--model", "anthropic/claude-test"]});
  assert.match(command, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(command, /OPENAI_API_KEY/);
});
test("malformed model flags fail clearly", () => {
  for (const args of [["--model"], ["--model="], ["-m", "--yes-always"]]) {
    assert.throws(() => configured([mimoEndpoint]).buildLaunchCommand({args}), /requires a configured model ID/);
  }
});
test("each provider exports only its own key and optional base", () => {
  for (const kind of ["openai", "anthropic", "groq", "openrouter"]) {
    const prefix = kind.toUpperCase();
    const endpoint = {name: kind, kind, apiBase: "https://example.test/v1", apiKeySecret: "test-key", models: [`${kind}/test-model`]};
    for (const platform of ["linux", "windows"]) {
      const command = configured([endpoint], {platform: () => platform}).buildLaunchCommand({});
      assert.match(command, new RegExp(`${prefix}_API_KEY`));
      assert.match(command, new RegExp(`${prefix}_API_BASE`));
      for (const other of ["OPENAI", "ANTHROPIC", "GROQ", "OPENROUTER"].filter(p => p !== prefix)) assert.doesNotMatch(command, new RegExp(`${other}_API_(KEY|BASE)`));
    }
  }
});
test("optional base is omitted without creating another provider base", () => {
  const command = configured([{name: "Claude", kind: "anthropic", apiKeySecret: "claude-key", models: ["anthropic/test"]}]).buildLaunchCommand({});
  assert.match(command, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(command, /API_BASE/);
});
test("same provider endpoints select credentials by model ownership", () => {
  const command = configured([mimoEndpoint, {name: "OpenAI", kind: "openai", apiKeySecret: "openai-direct", models: ["openai/gpt-test"]}]).buildLaunchCommand({args: ["--model", "openai/gpt-test"]});
  assert.match(command, /secret get --name 'openai-direct'/);
  assert.doesNotMatch(command, /mimo-key|example.test/);
});
test("keys are fetched only at runtime and values in settings are ignored", () => {
  let execCalls = 0;
  const p = configured([{...mimoEndpoint, apiKey: "SENTINEL_SECRET_VALUE"}], {exec: () => {execCalls++; throw new Error("must not fetch secrets inside VM");}});
  const command = p.buildLaunchCommand({});
  assert.equal(execCalls, 0);
  assert.match(command, /codeterm mem secret get --name 'mimo-key'/);
  assert.doesNotMatch(command, /SENTINEL_SECRET_VALUE|--api-key/);
});
test("catalogue reads current settings on every discovery", () => {
  let endpoints = [];
  const p = load({settingsJson: () => JSON.stringify({endpoints})});
  assert.deepEqual(plain(p.discoverModels()), []);
  endpoints = [mimoEndpoint];
  assert.equal(p.discoverModels()[0].id, "openai/mimo-v2.6-pro");
});
test("invalid settings JSON yields an empty catalogue", () => {
  assert.deepEqual(plain(load({settingsJson: () => "invalid"}).discoverModels()), []);
});
test("endpoint schema uses supported object array fields", () => {
  const schema = JSON.parse(readFileSync(join(__dirname, "settings.schema.json")));
  const endpoints = schema[0].fields.find(f => f.key === "endpoints");
  assert.equal(endpoints.kind, "array");
  assert.equal(endpoints.item.kind, "object");
  assert.deepEqual(endpoints.item.fields.map(f => f.key), ["name", "kind", "apiBase", "apiKeySecret", "models"]);
  assert.equal(endpoints.item.fields.find(f => f.key === "models").kind, "textarea");
});

// Representative frames reconstructed from the owner's observations and
// Aider 0.86.2 waiting.py's fixed scan palette; not newly captured DEV output.
const classify = (screenText, agentType = "aider") => plain(load().classifyTabState({tabId: "test", agentType, screenText}));
test("Aider block spinner reports working", () => {
  assert.deepEqual(classify("Aider v0.86.2\nModel: openai/mimo-v2.6-pro\n> Say hello\n  ░█       Waiting for openai/mimo-v2.6-pro\n"), {state: "working", confidence: 1});
});
test("Aider ASCII spinner reports working", () => {
  assert.equal(classify("  =#       Waiting for openai/test").state, "working");
});
test("streaming output after a submitted user turn reports working", () => {
  assert.equal(classify("Aider v0.86.2\n> Write a function\n```python\ndef hello():\n    print('hello')").state, "working");
});
test("repo map update marker reports working", () => {
  assert.equal(classify("Aider v0.86.2\nUpdating repo map").state, "working");
  assert.equal(classify("  █░       Updating repo map").state, "working");
});
test("idle prompt leaves idle geometry to core and suppresses old activity", () => {
  const screen = "Aider v0.86.2\n> Say hello\n░█ Waiting for openai/test\nHello\nTokens: 3\n>\n\n";
  assert.equal(classify(screen), null);
  assert.equal(load().screenHasTui(screen), true);
  assert.deepEqual(plain(load().detectEvents(screen)), []);
});
test("active question takes precedence over earlier generation", () => {
  const screen = "Aider v0.86.2\n> Create hello.py\nHere is the code\n" + permissionQuestion;
  assert.deepEqual(classify(screen), {state: "clarifying_question", confidence: 1, data: {questions: [permissionQuestion]}});
});
test("answered question returns to composer without a stale verdict", () => {
  assert.equal(classify("Aider v0.86.2\n" + permissionQuestion + " y\nApplied edit to hello.py\n>"), null);
});
test("bare status prose and typed input alone are not activity evidence", () => {
  for (const screen of ["", "Waiting for a reply", "> Typed but not submitted", "Aider v0.86.2\nModel: openai/test"]) assert.equal(classify(screen), null);
});
test("old spinner in scrollback does not classify an unrelated tail as working", () => {
  assert.equal(classify("░█ Waiting for openai/test\n>\nSome unrelated line"), null);
});
test("classifier only handles its attributed Aider provider", () => {
  assert.equal(classify("░█ Waiting for openai/test", "codex"), null);
});

test("typed input after an older completed turn is not streaming", () => {
  assert.equal(classify("> Earlier question\nOld answer\n> Typed but not submitted"), null);
});
test("old output before a settled composer is not current turn evidence", () => {
  assert.equal(classify("> Earlier question\nOld answer\n>\nOther output"), null);
});

const effortModel = {id: "openai/effort-test", mapTokens: 8192, reasoningMode: "effort", reasoningEfforts: [{id: "low", displayName: "Low"}, {id: "high", displayName: "High"}], defaultReasoningEffort: "low"};
const budgetModel = {id: "openai/budget-test", reasoningMode: "budget", reasoningEfforts: [{id: "off", displayName: "Off", thinkingTokens: 0}, {id: "high", displayName: "High", thinkingTokens: 16384}]};
const tuned = (models) => configured([{...mimoEndpoint, models}]);
test("per-model tuning catalogue exposes only declared reasoning choices", () => {
  const models = plain(tuned([effortModel, budgetModel, "openai/plain"]).discoverModels());
  assert.deepEqual(models[0].reasoningEfforts, [{id: "low", displayName: "Low"}, {id: "high", displayName: "High"}]);
  assert.equal(models[0].defaultReasoningEffort, "low");
  assert.deepEqual(models[1].reasoningEfforts, [{id: "off", displayName: "Off"}, {id: "high", displayName: "High"}]);
  assert.deepEqual(models[2].reasoningEfforts, []);
});
test("selected model alone supplies map tokens", () => {
  const p = tuned([effortModel, "openai/plain"]);
  assert.match(p.buildLaunchCommand({args: ["--model", effortModel.id]}), /'--map-tokens' '8192'/);
  assert.doesNotMatch(p.buildLaunchCommand({args: ["--model", "openai/plain"]}), /--map-tokens/);
});
test("unset map tuning keeps Aider default even for MiMo", () => {
  assert.doesNotMatch(configured([mimoEndpoint]).buildLaunchCommand({}), /--map-tokens/);
});
test("zero map tokens explicitly disables the repo map", () => {
  assert.match(tuned([{id: "openai/test", mapTokens: 0}]).buildLaunchCommand({}), /'--map-tokens' '0'/);
});
test("invalid map token values never become launch flags", () => {
  for (const mapTokens of [-1, 3.5, "8192", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.doesNotMatch(tuned([{id: "openai/test", mapTokens}]).buildLaunchCommand({}), /--map-tokens/);
  }
});
test("effort model receives its chosen effort and no budget flag", () => {
  const command = tuned([effortModel]).buildLaunchCommand({args: ["--model", effortModel.id, "--reasoning-effort", "high"]});
  assert.match(command, /'--reasoning-effort' 'high'/);
  assert.doesNotMatch(command, /--thinking-tokens/);
});
test("budget model translates a chosen level to thinking tokens", () => {
  const command = tuned([budgetModel]).buildLaunchCommand({args: ["--model", budgetModel.id, "--reasoning-effort", "high"]});
  assert.match(command, /'--thinking-tokens' '16384'/);
  assert.doesNotMatch(command, /--reasoning-effort/);
});
test("zero thinking budget remains a declared choice", () => {
  assert.match(tuned([budgetModel]).buildLaunchCommand({args: ["--reasoning-effort", "off"]}), /'--thinking-tokens' '0'/);
});
test("declared choices and a catalogue default send no flag when unchosen", () => {
  assert.doesNotMatch(tuned([effortModel]).buildLaunchCommand({}), /--reasoning-effort|--thinking-tokens/);
  assert.doesNotMatch(tuned([budgetModel]).buildLaunchCommand({}), /--reasoning-effort|--thinking-tokens/);
});
test("plain model rejects another model's reasoning choice", () => {
  const p = tuned([effortModel, "openai/plain"]);
  assert.throws(() => p.buildLaunchCommand({args: ["--model", "openai/plain", "--reasoning-effort", "high"]}), /does not declare reasoning level/);
});
test("unsupported levels fail instead of silently choosing a different level", () => {
  assert.throws(() => tuned([effortModel]).buildLaunchCommand({args: ["--reasoning-effort", "max"]}), /does not declare reasoning level/);
});
test("core reasoning launch format reaches the per-model translator", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json")));
  const format = manifest.commands.reasoningEffortLaunchArgsFormat;
  assert.deepEqual(format, ["--reasoning-effort", "{effort}"]);
  const args = ["--model", budgetModel.id, ...format.map(s => s.replace("{effort}", "high"))];
  assert.match(tuned([budgetModel]).buildLaunchCommand({args}), /'--thinking-tokens' '16384'/);
});
test("reasoning equals syntax is consumed and normalized", () => {
  assert.match(tuned([budgetModel]).buildLaunchCommand({args: ["--reasoning-effort=high"]}), /'--thinking-tokens' '16384'/);
});
test("malformed reasoning choices are rejected", () => {
  for (const args of [["--reasoning-effort"], ["--reasoning-effort="], ["--thinking-tokens"], ["--reasoning-effort", "--model", effortModel.id]]) {
    assert.throws(() => tuned([effortModel]).buildLaunchCommand({args}), /requires a declared model option/);
  }
});
test("direct thinking args are gated by declared budgets", () => {
  assert.match(tuned([budgetModel]).buildLaunchCommand({args: ["--thinking-tokens=16384"]}), /'--thinking-tokens' '16384'/);
  assert.throws(() => tuned([budgetModel]).buildLaunchCommand({args: ["--thinking-tokens", "32768"]}), /does not declare thinking budget/);
  assert.throws(() => tuned([effortModel]).buildLaunchCommand({args: ["--thinking-tokens", "16384"]}), /does not declare thinking budget/);
});
test("mixed effort and budget flags are rejected", () => {
  assert.throws(() => tuned([budgetModel]).buildLaunchCommand({args: ["--reasoning-effort", "high", "--thinking-tokens", "16384"]}), /not both/);
});
test("raw map flags cannot override a selected model declaration", () => {
  assert.throws(() => tuned([effortModel]).buildLaunchCommand({args: ["--map-tokens", "3"]}), /Configure mapTokens/);
});
test("invalid reasoning declarations do not advertise a selector", () => {
  for (const model of [
    {id: "openai/test", reasoningEfforts: [{id: "high"}]},
    {id: "openai/test", reasoningMode: "invalid", reasoningEfforts: [{id: "high"}]},
    {id: "openai/test", reasoningMode: "budget", reasoningEfforts: [{id: "high", thinkingTokens: -1}, {id: "medium"}, {id: "low", thinkingTokens: "4096"}]},
  ]) assert.deepEqual(plain(tuned([model]).discoverModels())[0].reasoningEfforts, []);
});
test("invalid default is omitted and duplicate levels are deduplicated", () => {
  const model = plain(tuned([{...effortModel, defaultReasoningEffort: "max", reasoningEfforts: [{id: "high"}, {id: "high"}, null]}]).discoverModels())[0];
  assert.equal(model.defaultReasoningEffort, undefined);
  assert.deepEqual(model.reasoningEfforts, [{id: "high", displayName: "high"}]);
});
test("model object textarea preserves tuning and display names", () => {
  const p = tuned(JSON.stringify([{...effortModel, displayName: "Effort test"}]));
  assert.equal(p.discoverModels()[0].displayName, "Effort test");
  assert.match(p.buildLaunchCommand({}), /'--map-tokens' '8192'/);
});

test("adapter is default, plain mode is explicit, marker preserves core nonce", () => {
  const settings = {endpoints: [mimoEndpoint]};
  const p = load({settingsJson: () => JSON.stringify(settings)});
  const command = p.buildLaunchCommand({launchMarker: "ct-launch-own", sessionId: "different-binding"});
  assert.match(command, /export PYTHONPATH='\/installed\/plugins\/aider\/startup'\$\{PYTHONPATH/);
  assert.match(command, /export DOMIOS_AIDER_ADAPTER='1'/);
  assert.match(command, /DOMIOS_AIDER_SESSION_ID='ct-launch-own'/);
  assert.doesNotMatch(command, /(?:export |\$env:)CODETERM_SESSION_BINDING_NONCE=/);
  const plainCommand = configured([mimoEndpoint]).buildLaunchCommand({launchMarker: "ct-launch-own"});
  assert.doesNotMatch(plainCommand, /PYTHONPATH|launch-adapter/);
  assert.match(plainCommand, /DOMIOS_AIDER_ADAPTER='0'/);
});

test("Windows adapter uses an argument array and runtime secret, never its value", () => {
  const p = load({platform: () => "windows", settingsJson: () => JSON.stringify({endpoints: [mimoEndpoint]})});
  const command = p.buildLaunchCommand({launchMarker: "ct-launch-own"});
  assert.match(command, /\$env:PYTHONPATH=\(@\('\/installed\/plugins\/aider\/startup'\)/);
  assert.match(command, /\$env:DOMIOS_AIDER_ADAPTER='1'/);
  assert.match(command, /; aider /);
  assert.match(command, /codeterm mem secret get --name 'mimo-key'/);
  assert.doesNotMatch(command, /CODETERM_SESSION_BINDING_NONCE|plainMode/);
});

test("missing adapter path refuses instead of silently launching plain Aider", () => {
  const p = load({settingsJson: () => JSON.stringify({endpoints: [mimoEndpoint]}), fs: {expandHome: () => null}});
  assert.throws(() => p.buildLaunchCommand({}), /Reinstall.*plainMode=true/);
});

test("manifest declares tool-less relay and installer/updater preserve adapter pin", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json")));
  assert.equal(manifest.capabilities.toolLess, true);
  assert.equal(manifest.capabilities.replyRelay, true);
  for (const platform of ["macos", "linux", "windows"]) {
    assert.equal(manifest.installer[platform], manifest.updater[platform]);
    assert.match(manifest.installer[platform], /uv tool install --force aider-chat==0\.86\.2/);
    assert.match(manifest.installer[platform], /pipx install --force aider-chat==0\.86\.2/);
    assert.doesNotMatch(manifest.updater[platform], /pipx upgrade|uv tool upgrade/);
  }
});

const relaySession = "ct-launch-relay";
const byteLength = value => Buffer.byteLength(value, "utf8");
function relayFixture(user = "Inspect é", answer = "Final answer", echoes = "") {
  const prefix = "# aider chat started at fixture\r\n";
  const beforeAnswer = prefix + `#### ${user}  \r\n\r\n` + echoes;
  const response = `\r\n${answer}\r\n\r\n`;
  const history = beforeAnswer + response + "> Tokens: 5\r\n";
  const start = {version: 1, kind: "adapter_start", sessionId: relaySession, launchMarker: relaySession,
    processGeneration: "boot1", aiderVersion: "0.86.2"};
  const end = {...start, kind: "turn_complete", turnSequence: 1, userRecordStart: byteLength(prefix),
    responseRecordStart: byteLength(beforeAnswer), responseRecordEnd: byteLength(beforeAnswer + response),
    historyBytes: byteLength(history), outcome: "answered", complete: true};
  delete end.aiderVersion;
  return {history, start, end};
}
const jsonLines = records => records.map(r => JSON.stringify(r)).join("\n") + "\n";
function relayRead(f, records = [f.start, f.end], afterOffset = 0, sid = relaySession) {
  const sidecar = records === null ? null : typeof records === "string" ? records : jsonLines(records);
  const p = load({fs: {readFile: path => {
    assert.ok(path === `/repo/.aider/history/${sid}.md` || path === `/repo/.aider/history/${sid}.md.domios-turns.jsonl`);
    return path.endsWith(".jsonl") ? sidecar : f.history;
  }}});
  return plain(p.readReplyRelayTurn("/repo", sid, afterOffset));
}

test("relay single answer has stable own-session identities and UTF-8 user offset", () => {
  const f = relayFixture();
  const result = relayRead(f, undefined, f.end.userRecordStart);
  assert.equal(result.complete, true);
  assert.equal(result.userText, "Inspect é");
  assert.equal(result.answer, "Final answer");
  assert.equal(result.userRecordStart, f.end.userRecordStart);
  assert.equal(result.userTurnId, `aider:${relaySession}:user:${f.end.userRecordStart}`);
  assert.equal(result.assistantTurnId, `aider:${relaySession}:boot1:answer:1:${f.end.responseRecordStart}`);
  assert.deepEqual(relayRead(f), result);
});

test("relay is pending with an answer history but no authoritative completion", () => {
  const f = relayFixture();
  assert.equal(relayRead(f, [f.start]), null);
  assert.equal(relayRead(f, jsonLines([f.start]) + JSON.stringify(f.end)), null);
});

test("plain session is unavailable and a start-only session is pending", () => {
  const f = relayFixture();
  assert.equal(relayRead(f, null).unavailable, true);
  assert.match(relayRead(f, null).reason, /plain mode|adapter/);
  assert.equal(relayRead(f, [] ).unavailable, true);
  assert.equal(relayRead(f, [f.start]), null);
});

test("relay final reflection answer excludes earlier answers and thinking", () => {
  const f = relayFixture("Review", "<thinking-content-x>hidden</thinking-content-x>\r\nGrounded final\r\n```ts\r\nconst x = 1;\r\n```",
    "First answer\r\n> Tokens: 2\r\n> Add file to the chat?\r\nSecond answer\r\n");
  assert.equal(relayRead(f).answer, "Grounded final\n```ts\nconst x = 1;\n```");
});

test("relay /ask keeps original payload identity despite nested input echo", () => {
  const f = relayFixture("/ask inspect", "Final", "#### inspect  \r\n\r\n");
  assert.equal(relayRead(f).userText, "/ask inspect");
  assert.equal(relayRead(f).answer, "Final");
});

test("declared line-break normalization matches pasted frames without rewriting raw relay text", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json")));
  assert.deepEqual(manifest.spawn.turnEvidenceNormalization, {dropLineBreaks: true});
  // Contract fixture for core's symmetric comparison, not plugin-side mutation.
  const payload = '<domios from="tab" tab="sender">First line\r\nSecond é\nThird line</domios>\r\n';
  const stored = '<domios from="tab" tab="sender">First lineSecond éThird line</domios>';
  const normalize = value => manifest.spawn.turnEvidenceNormalization.dropLineBreaks
    ? value.trim().replace(/[\r\n]/g, "") : value.trim();
  assert.notEqual(payload.trim(), stored);
  const raw = relayRead(relayFixture(stored)).userText;
  assert.equal(raw, stored);
  assert.equal(normalize(payload), normalize(raw));
  const multiline = payload.trim().replace(/\r\n/g, "\n");
  const headingLines = multiline.split("\n").join("  \r\n#### ");
  assert.equal(relayRead(relayFixture(headingLines)).userText, multiline);
});

for (const outcome of ["error", "cancelled", "reflection_limit"]) {
  test(`relay ${outcome} returns matching original user without partial answer`, () => {
    const f = relayFixture("Question", "partial");
    f.end.complete = false;
    f.end.outcome = outcome;
    const result = relayRead(f);
    assert.deepEqual(Object.keys(result).sort(), ["complete", "outcome", "userRecordStart", "userText", "userTurnId"]);
    assert.equal(result.complete, false);
    assert.equal(result.outcome, outcome);
    assert.equal(result.userText, "Question");
  });
}

test("relay skips completed users before the captured delivery boundary", () => {
  const f = relayFixture();
  assert.equal(relayRead(f, undefined, f.end.userRecordStart + 1), null);
});

test("relay and Chat preserve the normalized multiline routed task", () => {
  const task = "-=-codeterm:tab label=Fermi tab=sender-=-\nInspect é.\n\nName the caller's file.";
  const f = relayFixture(task.split("\n").join("  \r\n#### "));
  assert.equal(relayRead(f).userText, task);
  assert.equal(text(parse(f.history).find(row => row.role === "user")), task);
});

test("relay queued followups accept consumed-user-plus-one and interior UTF-8 offsets", () => {
  const first = relayFixture("First é", "First answer");
  const second = relayFixture("Followup 😀", "Second answer");
  const shift = byteLength(first.history);
  const end = {...second.end, turnSequence: 2};
  for (const key of ["userRecordStart", "responseRecordStart", "responseRecordEnd", "historyBytes"]) end[key] += shift;
  const combined = {...first, history: first.history + second.history};
  const records = [first.start, first.end, end];
  const insideAccent = byteLength(first.history.slice(0, first.history.indexOf("é"))) + 1;
  for (const offset of [first.end.userRecordStart + 1, insideAccent, shift, end.userRecordStart]) {
    const result = relayRead(combined, records, offset);
    assert.equal(result.userText, "Followup 😀");
    assert.equal(result.userRecordStart, end.userRecordStart);
    assert.equal(result.answer, "Second answer");
  }
});

test("relay rejects wrong session, launch marker, generation and malformed records", () => {
  for (const change of [{sessionId: "other"}, {launchMarker: "other"}, {processGeneration: "other"}, {version: 2},
    {kind: "unknown"}, {complete: true, outcome: "error"}, {complete: false, outcome: "guessed"}]) {
    const f = relayFixture();
    assert.equal(relayRead(f, [f.start, {...f.end, ...change}]), null, JSON.stringify(change));
  }
  const f = relayFixture();
  assert.equal(relayRead(f, jsonLines([f.start]) + "{broken}\n"), null);
});

test("relay ignores truncated final record and rejects an unsupported adapter version", () => {
  const f = relayFixture();
  assert.deepEqual(relayRead(f, jsonLines([f.start, f.end]) + '{"kind":'), relayRead(f));
  assert.equal(relayRead(f, [{...f.start, aiderVersion: "0.87.0"}]).unavailable, true);
});

test("relay bounds cannot exceed history or split a Unicode character", () => {
  for (const change of [{responseRecordEnd: 999999}, {historyBytes: 999999}, {userRecordStart: -1},
    {responseRecordStart: 1}, {turnSequence: 0}, {userRecordStart: 1.5}]) {
    const f = relayFixture();
    assert.equal(relayRead(f, [f.start, {...f.end, ...change}]), null);
  }
  const f = relayFixture("é", "😀 final");
  f.end.responseRecordStart += 3; // newline pair + middle of the emoji
  assert.equal(relayRead(f), null);
});

test("relay latest process generation cannot reuse old completion", () => {
  const f = relayFixture();
  assert.equal(relayRead(f, [f.start, f.end, {...f.start, processGeneration: "boot2"}]), null);
  assert.equal(relayRead(f, [f.start, f.end, {...f.start, processGeneration: "boot2"}, f.end]), null);
});

test("relay rejects path traversal and reports unreadable evidence", () => {
  assert.equal(load().readReplyRelayTurn("/repo", "../other", 0), null);
  const p = load({fs: {readFile: () => {throw Error("denied");}}});
  assert.equal(p.readReplyRelayTurn("/repo", relaySession, 0).unavailable, true);
});

let failed = 0;
for (const [name, run] of tests) {
  try { run(); console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}`); console.error(err); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
