// Plugin-side tests for the Git plugin's pure porcelain/log parsers.
// Run: npx tsx plugins/git/plugin.test.cjs

globalThis.host = new Proxy(
  {},
  { get: () => () => { throw new Error("host called at load time"); } },
);

const plugin = require("./plugin.js").default;

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

test("parsePorcelain counts staged / unstaged / untracked", () => {
  const out = "M  staged.txt\n M unstaged.txt\nMM both.txt\n?? new.txt\n";
  const d = plugin.__test_parsePorcelain(out);
  assert(d.total === 4, "total 4");
  assert(d.staged === 2, "staged (M_, MM) = 2, got " + d.staged);
  assert(d.unstaged === 2, "unstaged (_M, MM) = 2, got " + d.unstaged);
  assert(d.untracked === 1, "untracked 1");
});

test("parsePorcelain clean tree is empty", () => {
  const d = plugin.__test_parsePorcelain("");
  assert(d.total === 0 && d.staged === 0 && d.untracked === 0, "all zero");
});

test("parseLog trims and drops blanks", () => {
  const commits = plugin.__test_parseLog("abc123 first\n def456 second \n\n");
  assert(commits.length === 2, "two commits, got " + commits.length);
  assert(commits[1] === "def456 second", "trimmed");
});

test("parseGraph splits \\x1e records / \\x1f fields", () => {
  const rec = (sha, parents, refs, subj) =>
    "\x1f" + sha + "\x1f" + parents + "\x1f" + "Ann" + "\x1f" + "2026-01-01" + "\x1f" + refs + "\x1f" + subj + "\x1e";
  const out = "\n" + rec("aaa", "bbb ccc", "HEAD -> refs/heads/main, tag: refs/tags/v1", "feat: x") + rec("bbb", "", "refs/remotes/origin/main", "init");
  const c = plugin.__test_parseGraph(out);
  assert(c.length === 2, "two commits, got " + c.length);
  assert(c[0].sha === "aaa", "sha aaa");
  assert(c[0].parents.length === 2 && c[0].parents[0] === "bbb", "two parents");
  assert(c[0].refs.some((r) => r.kind === "head" && r.name === "main"), "head main");
  assert(c[0].refs.some((r) => r.kind === "tag" && r.name === "v1"), "tag v1");
  assert(c[1].refs[0].kind === "remote" && c[1].refs[0].name === "origin/main", "remote ref");
  assert(c[1].parents.length === 0, "root has no parents");
});

test("splitRename handles plain and brace forms", () => {
  assert(plugin.__test_splitRename("a.txt").old_path === null, "no rename");
  const plain = plugin.__test_splitRename("old.txt => new.txt");
  assert(plain.path === "new.txt" && plain.old_path === "old.txt", "plain rename");
  const brace = plugin.__test_splitRename("src/{a => b}/f.txt");
  assert(brace.path === "src/b/f.txt" && brace.old_path === "src/a/f.txt", "brace rename, got " + JSON.stringify(brace));
});

test("parseNumstat marks rename / binary / modified", () => {
  const out = "3\t1\tsrc/a.ts\n-\t-\timg.png\n2\t0\told.txt => new.txt\n";
  const f = plugin.__test_parseNumstat(out);
  assert(f.length === 3, "three files");
  assert(f[0].status === "modified" && f[0].added === 3 && f[0].deleted === 1, "modified");
  assert(f[1].status === "binary" && f[1].added === null && f[1].deleted === null, "binary");
  assert(f[2].status === "renamed" && f[2].old_path === "old.txt", "renamed");
});

test("parseStatusPorcelain reads -z entries + rename old path", () => {
  const out = "M  staged.txt\0 M dirty.txt\0?? new.txt\0R  new-name.txt\0old-name.txt\0";
  const e = plugin.__test_parseStatusPorcelain(out);
  assert(e.length === 4, "four entries, got " + e.length);
  assert(e[0].status === "staged" && e[0].staged === true, "staged");
  assert(e[1].status === "modified" && e[1].staged === false, "unstaged modified");
  assert(e[2].status === "untracked", "untracked");
  assert(e[3].status === "renamed" && e[3].path === "new-name.txt" && e[3].old_path === "old-name.txt", "rename pair, got " + JSON.stringify(e[3]));
});

test("mergeWorkdirFiles joins numstat counts, untracked has no counts", () => {
  const entries = [
    { path: "a.ts", old_path: null, status: "modified", staged: false },
    { path: "new.txt", old_path: null, status: "untracked", staged: false },
  ];
  const merged = plugin.__test_mergeWorkdirFiles(entries, { "a.ts": [5, 2] });
  assert(merged[0].added === 5 && merged[0].deleted === 2, "joined counts");
  assert(merged[1].added === null && merged[1].deleted === null, "untracked null counts");
});

// ── path-authority (mutating-op path validation) ──

test("pathWithinRepo accepts repo-relative paths, rejects escapes", () => {
  const within = plugin.__test_pathWithinRepo;
  assert(within("src/plugin.ts") === true, "relative path ok");
  assert(within("a/b/../c.txt") === true, "internal .. that stays inside is ok");
  assert(within("") === false, "empty rejected");
  assert(within("../secret") === false, "parent escape rejected");
  assert(within("a/../../x") === false, "deep parent escape rejected");
  assert(within("/etc/passwd") === false, "absolute POSIX rejected");
  assert(within("C:\\Windows\\x") === false, "absolute Windows drive rejected");
  assert(within("\\\\server\\share") === false, "UNC / backslash-root rejected");
});

// ── manifest (Track S) ──

test("plugin.json does not advertise AI configuration without settings", () => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"));
  assert(manifest.settingsSchema == null, "Git should remain zero-configuration");
  assert(manifest.configHelp == null, "Git should not expose Configure with AI");
});

test("multi-repo bubble summarizes and follows the selected repository", () => {
  const parent = "C:/workspace";
  globalThis.host = {
    unixNowMs: () => 10000,
    platform: () => "windows",
    fileExists: (path) => /repo-[ab]\/\.git$/.test(path.replace(/\\/g, "/")),
    exec: (raw) => {
      const opts = JSON.parse(raw);
      if (opts.bin === "cmd") return JSON.stringify({ code: 0, stdout: "repo-a\r\nrepo-b\r\n", stderr: "" });
      const cwd = opts.args[1];
      const args = opts.args.slice(2);
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return JSON.stringify({ code: 1, stdout: "", stderr: "not a repository" });
      }
      if (args[0] === "rev-parse") {
        if (cwd === parent) return JSON.stringify({ code: 1, stdout: "", stderr: "not a repository" });
        const branch = cwd.endsWith("repo-b") ? "feature/b" : "main";
        return JSON.stringify({ code: 0, stdout: `${branch}\n`, stderr: "" });
      }
      if (args[0] === "status") return JSON.stringify({ code: 0, stdout: "", stderr: "" });
      throw new Error(`unexpected git call: ${cwd} ${args.join(" ")}`);
    },
  };
  const first = plugin.statusBubble({ cwd: parent });
  assert(first.label === "main +1", `first repo plus count, got ${first.label}`);
  const selected = plugin.viewCall("gitSelectRepo", { cwd: parent, path: `${parent}/repo-b` });
  assert(selected.selected === true, "selection accepted");
  const second = plugin.statusBubble({ cwd: parent });
  assert(second.label === "feature/b +1", `selected repo branch, got ${second.label}`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (err) { failed += 1; console.error(`✗ ${name}`); console.error(err); }
}
console.log(`git plugin: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
