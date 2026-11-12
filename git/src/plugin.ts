import { defineProviderIo, ioEncoded, type HostIoSteps, type IoExports } from "@codeterm/plugin-sdk";
// Git plugin — CodeTerm's local-git presence, authored in TypeScript against
// @codeterm/plugin-sdk and compiled to QuickJS-compatible plugin.js by
// scripts/build-plugin.mjs. Contributes a pane-footer status bubble, a glance
// popover, and the full Git view ops the iframe UI drives via window.ct.invoke.
import type {
  ExecOpts,
  ExecResult,
  GlanceView,
  PluginModule,
  StatusBubble,
  TabContext,
  ViewNode,
} from "@codeterm/plugin-sdk";

function* exec(opts: ExecOpts): HostIoSteps<ExecResult> {
  const raw = (yield* ioEncoded(host.io.exec(opts)));
  try {
    return JSON.parse(raw) as ExecResult;
  } catch (e) {
    return { error: String(e) };
  }
}

function* git(cwd: string, args: string[]): HostIoSteps<ExecResult> {
  return (yield* exec({ bin: "git", args: ["-C", cwd].concat(args) }));
}

// --- pure parsers (exported for tests) ---

interface Porcelain {
  total: number;
  staged: number;
  unstaged: number;
  untracked: number;
}

// `git status --porcelain` → { total, staged, unstaged, untracked }.
function parsePorcelain(out: string | undefined): Porcelain {
  const lines = (out || "").split("\n").filter((l) => l.length > 0);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  lines.forEach((l) => {
    const x = l.charAt(0);
    const y = l.charAt(1);
    if (x === "?" && y === "?") {
      untracked++;
      return;
    }
    if (x !== " " && x !== "?") staged++;
    if (y !== " " && y !== "?") unstaged++;
  });
  return { total: lines.length, staged, unstaged, untracked };
}

// `git log --oneline` → array of short lines (already one per commit).
function parseLog(out: string | undefined): string[] {
  return (out || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function* branchOf(cwd: string): HostIoSteps<string | null> {
  const r = (yield* git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
  if (r.error || r.code !== 0) return null;
  return (r.stdout || "").trim() || null;
}

// --- capabilities ---

// statusBubble is a hot path: the host re-renders the footer pill often (every
// pane redraw / focus change), and each computation shells `git` twice. Cache
// the result per-cwd with a short TTL so rapid re-renders are free and the cost
// is bounded to one refresh per cwd per interval. The cache is also size-bounded
// so a long-lived VM that visits many cwds can't grow it without limit.
const BUBBLE_TTL_MS = 4000;
const BUBBLE_CACHE_MAX = 64;
const bubbleCache: Record<string, { bubble: StatusBubble | null; ts: number }> = {};
const selectedRepoByCwd: Record<string, string> = {};

type BubbleSteps<T> = HostIoSteps<T>;

function* bubbleGit(cwd: string, args: string[]): BubbleSteps<ExecResult> {
  return yield* host.io.exec({ bin: "git", args: ["-C", cwd].concat(args) });
}

function* bubbleBranch(cwd: string): BubbleSteps<string | null> {
  const r = yield* bubbleGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return r.error || r.code !== 0 ? null : (r.stdout || "").trim() || null;
}

function* bubbleRepos(cwd: string): HostIoSteps<Repo[]> {
  const top = yield* bubbleGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (ok(top) && (top.stdout || "").trim()) {
    const root = (top.stdout || "").trim();
    return [{ path: root, name: baseName(root), branch: yield* bubbleBranch(root) }];
  }
  const sep = cwd.replace(/[/\\]$/, "");
  const out: Repo[] = [];
  const names = yield* listChildDirs(cwd);
  for (let i = 0; i < names.length && out.length < 20; i++) {
    const p = `${sep}/${names[i]}`;
    if ((yield* host.io.fs.fileExists(`${p}/.git`))) out.push({ path: p, name: names[i], branch: yield* bubbleBranch(p) });
  }
  return out;
}

function* computeBubble(cwd: string, selectedPath: string | undefined): HostIoSteps<StatusBubble | null> {
  const directBranch = yield* bubbleBranch(cwd);
  const repos = directBranch ? [] : yield* bubbleRepos(cwd);
  let selected = repos.find((repo) => repo.path === selectedPath);
  if (!selected && selectedPath) {
    for (const repo of repos) {
      const result = yield* bubbleGit(repo.path, ["worktree", "list", "--porcelain"]);
      const worktree = (ok(result) ? parseWorktrees(result.stdout) : []).find((candidate) => candidate.path === selectedPath);
      if (worktree) {
        selected = { path: worktree.path, name: baseName(worktree.path), branch: worktree.branch };
        break;
      }
    }
  }
  selected ||= repos[0];
  const repoCwd = selected?.path || cwd;
  const branch = directBranch || selected?.branch;
  if (!branch) return null;
  const d = parsePorcelain((yield* bubbleGit(repoCwd, ["status", "--porcelain"])).stdout);
  const extra = repos.length > 1 ? ` +${repos.length - 1}` : "";
  const repoLabel = selected ? `${selected.name} · ` : "";
  return {
    label: `${branch}${extra}`,
    tone: "default",
    icon: "git",
    tooltip: d.total ? `${repoLabel}${d.total} changed — open Git` : `${repoLabel}clean — open Git`,
    // Click opens the plugin's own Git view (its sandboxed iframe UI).
    action: "openPanel:view:git",
  };
}

const bubbleRefreshes = new Set<string>();

function* statusBubble(ctx: TabContext): HostIoSteps<StatusBubble | null> {
  const cwd = ctx && ctx.cwd;
  if (!cwd) return null;
  const now = host.unixNowMs();
  const hit = bubbleCache[cwd];
  if (hit && now - hit.ts < BUBBLE_TTL_MS) return hit.bubble;
  if (bubbleRefreshes.has(cwd)) return hit?.bubble ?? null;
  const selected = selectedRepoByCwd[cwd];
  bubbleRefreshes.add(cwd);
  try {
    const bubble = yield* computeBubble(cwd, selected);
    if (selectedRepoByCwd[cwd] === selected) {
      if (Object.keys(bubbleCache).length >= BUBBLE_CACHE_MAX) {
        for (const key of Object.keys(bubbleCache)) delete bubbleCache[key];
      }
      bubbleCache[cwd] = { bubble, ts: now };
    }
    return bubble;
  } finally {
    bubbleRefreshes.delete(cwd);
  }
}

function* renderGlance(ctx: TabContext): HostIoSteps<GlanceView> {
  const cwd = ctx && ctx.cwd;
  if (!cwd) {
    return {
      title: "Git",
      nodes: [{ kind: "text", text: "No working directory for this pane.", style: { tone: "muted" } }],
    };
  }
  const branch = (yield* branchOf(cwd));
  if (!branch) {
    return { title: "Git", nodes: [{ kind: "text", text: "Not a git repository.", style: { tone: "muted" } }] };
  }
  const d = parsePorcelain((yield* git(cwd, ["status", "--porcelain"])).stdout);
  const commits = parseLog((yield* git(cwd, ["log", "--oneline", "-n", "5"])).stdout);

  const nodes: ViewNode[] = [
    { kind: "keyVal", key: "Branch", value: branch },
    {
      kind: "keyVal",
      key: "Working tree",
      value: d.total ? `${d.total} changed (${d.staged} staged)` : "clean",
      style: { tone: d.total ? "warn" : "ok" },
    },
  ];
  if (commits.length) {
    nodes.push({ kind: "divider" });
    nodes.push({ kind: "text", text: "Recent commits", style: { tone: "muted" } });
    commits.forEach((c) => nodes.push({ kind: "text", text: c }));
  }
  nodes.push({ kind: "divider" });
  nodes.push({ kind: "button", label: "Open Git", action: "openPanel:view:git" });
  return { title: `Git · ${branch}`, nodes };
}

// --- view ops: faithful port of the former native git_routes.rs ---
// The plugin's iframe UI (ui/) calls these via window.ct.invoke(method, args).
// Every op shells `git -C <cwd>` and reproduces the exact REST output shapes.

const FS = "\x1f"; // field separator inside the graph pretty-format
const RS = "\x1e"; // record separator between commits

interface Ref {
  name: string;
  kind: "tag" | "head" | "branch" | "remote";
}

// `%D`-style ref decoration → [{ name, kind }].
function parseRefs(s: string | undefined): Ref[] {
  if (!s) return [];
  const refs: Ref[] = [];
  for (let raw of s.split(", ")) {
      raw = raw.trim();
      if (!raw) continue;
      if (raw.indexOf("tag: ") === 0) {
        let t = raw.slice(5);
        if (t.indexOf("refs/tags/") === 0) t = t.slice(10);
        refs.push({ name: t.replace(/\^\{\}$/, ""), kind: "tag" });
        continue;
      }
      if (raw.indexOf("HEAD -> ") === 0) {
        let h = raw.slice(8);
        if (h.indexOf("refs/heads/") === 0) h = h.slice(11);
        refs.push({ name: "HEAD", kind: "head" }, { name: h, kind: "branch" });
        continue;
      }
      if (raw === "HEAD") refs.push({ name: "HEAD", kind: "head" });
      else if (raw.indexOf("refs/heads/") === 0) refs.push({ name: raw.slice(11), kind: "branch" });
      else if (raw.indexOf("refs/remotes/") === 0) refs.push({ name: raw.slice(13), kind: "remote" });
      else if (raw.indexOf("refs/tags/") === 0) refs.push({ name: raw.slice(10).replace(/\^\{\}$/, ""), kind: "tag" });
      else refs.push({ name: raw.replace(/^heads\//, ""), kind: "branch" });
  }
  return refs;
}

interface GraphCommit {
  sha: string;
  parents: string[];
  author: string;
  date: string;
  refs: Ref[];
  subject: string;
}

function parseGraph(out: string | undefined): GraphCommit[] {
  return (out || "")
    .split(RS)
    .map((rec) => (rec.charAt(0) === "\n" ? rec.slice(1) : rec))
    .filter((rec) => rec.indexOf(FS) !== -1)
    .map((rec): GraphCommit => {
      const f = rec.split(FS); // [0]="" [1]sha [2]parents [3]author [4]date [5]refs [6]subject
      return {
        sha: f[1] || "",
        parents: (f[2] || "").split(" ").filter((p) => p.length > 0),
        author: f[3] || "",
        date: f[4] || "",
        refs: parseRefs(f[5] || ""),
        subject: f[6] || "",
      };
    })
    .filter((c) => c.sha.length > 0);
}

interface Rename {
  path: string;
  old_path: string | null;
}

// `old => new` and `dir/{old => new}/file` rename forms → { path, old_path }.
function splitRename(s: string): Rename {
  const brace = s.indexOf("{");
  if (brace !== -1) {
    const close = s.indexOf("}", brace);
    const arrow = brace !== -1 && close !== -1 ? s.slice(brace + 1, close).indexOf(" => ") : -1;
    if (close !== -1 && arrow !== -1) {
      const pre = s.slice(0, brace);
      const inner = s.slice(brace + 1, close);
      const post = s.slice(close + 1);
      const a = inner.indexOf(" => ");
      const oldMid = inner.slice(0, a);
      const newMid = inner.slice(a + 4);
      const collapse = (p: string) => p.replace(/\/\//g, "/");
      return { path: collapse(pre + newMid + post), old_path: collapse(pre + oldMid + post) };
    }
  }
  const top = s.indexOf(" => ");
  if (top !== -1) return { path: s.slice(top + 4), old_path: s.slice(0, top) };
  return { path: s, old_path: null };
}

interface NumstatFile {
  path: string;
  old_path: string | null;
  added: number | null;
  deleted: number | null;
  status: string;
}

// `git show --numstat` body → [{ path, old_path, added, deleted, status }].
function parseNumstat(out: string | undefined): NumstatFile[] {
  return (out || "")
    .split("\n")
    .map((line): NumstatFile | null => {
      if (!line) return null;
      const parts = line.split("\t");
      if (parts.length < 3) return null;
      const addS = parts[0];
      const delS = parts[1];
      const r = splitRename(parts.slice(2).join("\t"));
      const binary = addS === "-" && delS === "-";
      return {
        path: r.path,
        old_path: r.old_path,
        added: addS === "-" ? null : parseInt(addS, 10) || 0,
        deleted: delS === "-" ? null : parseInt(delS, 10) || 0,
        status: r.old_path ? "renamed" : binary ? "binary" : "modified",
      };
    })
    .filter((f): f is NumstatFile => f !== null);
}

function classifyPorcelain(x: string, y: string): string {
  if (x === "?" && y === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "D" && y === "D") || (x === "A" && y === "A")) return "conflicted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "D" || y === "D") return "deleted";
  if (x !== " " && x !== "?") return "staged";
  return "modified";
}

interface StatusEntry {
  path: string;
  old_path: string | null;
  status: string;
  staged: boolean;
}

// `git status --porcelain=v1 -z` → [{ path, old_path, status, staged }].
function parseStatusPorcelain(out: string | undefined): StatusEntry[] {
  const tokens = (out || "").split("\0").filter((t) => t.length > 0);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.length < 3) continue;
    const x = tok.charAt(0);
    const y = tok.charAt(1);
    let oldPath: string | null = null;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      if (i + 1 < tokens.length) {
        oldPath = tokens[i + 1];
        i++;
      }
    }
    entries.push({
      path: tok.slice(3),
      old_path: oldPath,
      status: classifyPorcelain(x, y),
      staged: x !== " " && x !== "?",
    });
  }
  return entries;
}

type Counts = Record<string, [number | null, number | null]>;

// `git diff --numstat HEAD` → { path: [added, deleted] }.
function parseNumstatCounts(out: string | undefined): Counts {
  const map: Counts = {};
  (out || "").split("\n").forEach((line) => {
    if (!line) return;
    const parts = line.split("\t");
    if (parts.length < 3) return;
    const r = splitRename(parts.slice(2).join("\t"));
    map[r.path] = [
      parts[0] === "-" ? null : parseInt(parts[0], 10) || 0,
      parts[1] === "-" ? null : parseInt(parts[1], 10) || 0,
    ];
  });
  return map;
}

interface WorkdirFile extends StatusEntry {
  added: number | null;
  deleted: number | null;
}

function mergeWorkdirFiles(entries: StatusEntry[], counts: Counts): WorkdirFile[] {
  return entries.map((e) => {
    const c = e.status === "untracked" ? null : counts[e.path];
    return {
      path: e.path,
      old_path: e.old_path,
      status: e.status,
      staged: e.staged,
      added: c ? c[0] : null,
      deleted: c ? c[1] : null,
    };
  });
}

function baseName(p: string): string {
  const parts = String(p).replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || String(p);
}

function ok(r: ExecResult | undefined): boolean {
  return !!r && !r.error && r.code === 0;
}
function fail(r: ExecResult | undefined, msg: string): { error: string } {
  return { error: (r && (r.stderr || r.error)) || msg };
}

// --- ops ---

interface BranchStats {
  branch_base?: string;
  branch_added?: number;
  branch_deleted?: number;
}

function* branchLineStats(cwd: string, branch: string | null): HostIoSteps<BranchStats> {
  if (!branch) return {};
  let base: string | null = null;
  const up = (yield* git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]));
  if (ok(up)) base = (up.stdout || "").trim() || null;
  if (!base) {
    ["origin/main", "origin/master", "main", "master"].some(function* (cand): HostIoSteps<boolean> {
      if (ok((yield* git(cwd, ["rev-parse", "--verify", "-q", cand])))) {
        base = cand;
        return true;
      }
      return false;
    });
  }
  if (!base) return {};
  const mb = (yield* git(cwd, ["merge-base", base, "HEAD"]));
  if (!ok(mb)) return {};
  const baseSha = (mb.stdout || "").trim();
  if (!baseSha) return {};
  const ns = (yield* git(cwd, ["diff", "--numstat", baseSha, "HEAD"]));
  if (!ok(ns)) return {};
  let added = 0;
  let deleted = 0;
  (ns.stdout || "").split("\n").forEach((l) => {
    if (!l) return;
    const p = l.split("\t");
    if (p.length < 2) return;
    if (p[0] !== "-") added += parseInt(p[0], 10) || 0;
    if (p[1] !== "-") deleted += parseInt(p[1], 10) || 0;
  });
  return { branch_base: base, branch_added: added, branch_deleted: deleted };
}

interface GraphResult {
  commits: GraphCommit[];
  head_sha: string;
  branch: string | null;
  dirty: boolean;
  branch_base?: string;
  branch_added?: number;
  branch_deleted?: number;
}

function* gitGraph(cwd: string, limit?: number, skip?: number): HostIoSteps<GraphResult | { error: string }> {
  const r = (yield* git(cwd, [
    "-c", "core.quotePath=false", "log", "--branches", "--tags", "--remotes", "HEAD",
    "--topo-order", "--decorate=full",
    "--pretty=format:%x1f%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s%x1e",
    "-n", String(limit || 200), "--skip", String(skip || 0),
  ]));
  if (!ok(r)) return fail(r, "git log failed");
  const head = (yield* git(cwd, ["rev-parse", "HEAD"]));
  const branch = (yield* branchOf(cwd));
  const dirty = ((yield* git(cwd, ["status", "--porcelain"])).stdout || "").trim().length > 0;
  const out: GraphResult = {
    commits: parseGraph(r.stdout),
    head_sha: ok(head) ? (head.stdout || "").trim() : "",
    branch,
    dirty,
  };
  const stats = (yield* branchLineStats(cwd, branch));
  if (stats.branch_base) {
    out.branch_base = stats.branch_base;
    out.branch_added = stats.branch_added;
    out.branch_deleted = stats.branch_deleted;
  }
  return out;
}

function* gitCommitFiles(cwd: string, sha: string): HostIoSteps<NumstatFile[] | { error: string }> {
  const r = (yield* git(cwd, ["show", "-M", "-C", "--numstat", "--format=", sha]));
  if (!ok(r)) return fail(r, "git show failed");
  return parseNumstat(r.stdout);
}

function* gitCommitDiff(cwd: string, sha: string, path: string): HostIoSteps<{ diff: string } | { error: string }> {
  const rl = (yield* git(cwd, ["rev-list", "--parents", "-n", "1", sha]));
  const isMerge = (rl.stdout || "").trim().split(" ").filter(Boolean).length > 2;
  const r = isMerge
    ? (yield* git(cwd, ["diff", "-M", "-C", "--no-color", `${sha}^1`, sha, "--", path]))
    : (yield* git(cwd, ["show", "-M", "-C", "--no-color", "--format=", sha, "--", path]));
  if (r.error) return { error: r.error };
  return { diff: r.stdout || "" };
}

function* gitWorkdirFiles(cwd: string): HostIoSteps<WorkdirFile[] | { error: string }> {
  const s = (yield* git(cwd, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z"]));
  if (!ok(s)) return fail(s, "git status failed");
  const ns = (yield* git(cwd, ["-c", "core.quotePath=false", "diff", "--numstat", "HEAD"]));
  return mergeWorkdirFiles(parseStatusPorcelain(s.stdout), ok(ns) ? parseNumstatCounts(ns.stdout) : {});
}

function* gitWorkdirDiff(cwd: string, path: string): HostIoSteps<{ diff: string } | { error: string }> {
  const r = (yield* git(cwd, ["diff", "-M", "-C", "--no-color", "HEAD", "--", path]));
  if (r.error) return { error: r.error };
  return { diff: r.stdout || "" };
}

function* gitStage(cwd: string, paths: string[]): HostIoSteps<{ ok: true } | { error: string }> {
  if (!paths || !paths.length) return { error: "no paths" };
  const r = (yield* git(cwd, ["add", "--"].concat(paths)));
  if (!ok(r)) return fail(r, "git add failed");
  return { ok: true };
}

function* gitUnstage(cwd: string, paths: string[]): HostIoSteps<{ ok: true } | { error: string }> {
  if (!paths || !paths.length) return { error: "no paths" };
  const r = (yield* git(cwd, ["restore", "--staged", "--"].concat(paths)));
  if (!ok(r)) return fail(r, "git restore failed");
  return { ok: true };
}

function* gitRevert(cwd: string, path: string): HostIoSteps<{ reverted: true } | { error: string }> {
  const s = (yield* git(cwd, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--", path]));
  const entry = parseStatusPorcelain(s.stdout).filter((e) => e.path === path)[0];
  if (entry && entry.status === "untracked") return { error: "untracked file — delete it manually" };
  if (entry && entry.status === "conflicted") return { error: "conflicted file — resolve it manually" };
  const r = (yield* git(cwd, ["checkout", "HEAD", "--", path]));
  if (!ok(r)) return fail(r, "git checkout failed");
  return { reverted: true };
}

function* gitCommit(cwd: string, message: string): HostIoSteps<{ committed: true; stdout: string } | { error: string }> {
  const msg = (message || "").trim();
  if (!msg) return { error: "commit message is empty" };
  const r = (yield* git(cwd, ["commit", "-m", msg]));
  if (!ok(r)) return fail(r, "git commit failed");
  return { committed: true, stdout: r.stdout || "" };
}

function* gitPush(cwd: string): HostIoSteps<{ pushed: true; stdout: string; stderr: string } | { error: string }> {
  const r = (yield* git(cwd, ["push"]));
  if (!ok(r)) return fail(r, "git push failed");
  return { pushed: true, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// Child-directory names via the sandbox-aware host binding: `null` means denied
// or unreadable, `[]` a readable directory with no children. An older daemon has
// no such binding at all, so an absent member degrades to no discovery rather
// than a throw that would take the whole bubble down.
function* listChildDirs(cwd: string): HostIoSteps<string[]> {
  try { return (yield* host.io.fs.listChildDirs(cwd))?.filter(name => typeof name === "string" && name.length > 0) ?? []; }
  catch { return []; }
}

interface Repo {
  path: string;
  name: string;
  branch: string | null;
}

function* gitRepos(cwd: string): HostIoSteps<Repo[]> {
  const top = (yield* git(cwd, ["rev-parse", "--show-toplevel"]));
  if (ok(top) && (top.stdout || "").trim()) {
    const root = (top.stdout || "").trim();
    return [{ path: root, name: baseName(root), branch: (yield* branchOf(root)) }];
  }
  const sep = cwd.replace(/[/\\]$/, "");
  const out: Repo[] = [];
  const names = yield* listChildDirs(cwd);
  for (let i = 0; i < names.length && out.length < 20; i++) {
    const p = `${sep}/${names[i]}`;
    if ((yield* host.io.fs.fileExists(`${p}/.git`))) out.push({ path: p, name: names[i], branch: (yield* branchOf(p)) });
  }
  return out;
}

interface ViewArgs {
  cwd?: string;
  limit?: number;
  skip?: number;
  sha?: string;
  path?: string;
  paths?: string[];
  message?: string;
}

interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: string | null;
  prunable: string | null;
}

function parseWorktrees(out: string | undefined): Worktree[] {
  return (out || "")
    .trim()
    .split(/\r?\n\r?\n/)
    .map((record) => {
      const fields: Record<string, string> = {};
      for (const line of record.split(/\r?\n/)) {
        const split = line.indexOf(" ");
        fields[split === -1 ? line : line.slice(0, split)] = split === -1 ? "" : line.slice(split + 1);
      }
      if (!fields.worktree) return null;
      return {
        path: fields.worktree,
        head: fields.HEAD || null,
        branch: fields.branch?.replace(/^refs\/heads\//, "") || null,
        bare: "bare" in fields,
        detached: "detached" in fields,
        locked: "locked" in fields ? fields.locked || "locked" : null,
        prunable: "prunable" in fields ? fields.prunable || "prunable" : null,
      };
    })
    .filter((worktree): worktree is Worktree => worktree !== null);
}

function* gitWorktrees(cwd: string): HostIoSteps<Worktree[]> {
  const result = (yield* git(cwd, ["worktree", "list", "--porcelain"]));
  return ok(result) ? parseWorktrees(result.stdout) : [];
}

function* selectRepo(cwd: string, path: string): HostIoSteps<{ selected: true } | { error: string }> {
  const repos = (yield* gitRepos(cwd));
  const allowed = repos.some((repo) => repo.path === path)
    || repos.some(function* (repo): HostIoSteps<boolean> { return (yield* gitWorktrees(repo.path)).some((worktree) => worktree.path === path); });
  if (!allowed) return { error: "repository is outside this workspace" };
  selectedRepoByCwd[cwd] = path;
  delete bubbleCache[cwd];
  bubbleRefreshes.delete(cwd);
  return { selected: true };
}

// Methods that mutate the working tree / index / remote. These are NOT allowed
// to run against an arbitrary iframe-supplied cwd (path-authority): a compromised
// view could otherwise point add/commit/push/revert at any directory on disk.
const MUTATING: Record<string, true> = {
  gitStage: true,
  gitUnstage: true,
  gitCommit: true,
  gitPush: true,
  gitRevert: true,
};

// Resolve the repository root that `cwd` belongs to. git itself is the authority:
// `rev-parse --show-toplevel` fails (→ null) for anything that is not a work tree.
function* repoRoot(cwd: string): HostIoSteps<string | null> {
  const r = (yield* git(cwd, ["rev-parse", "--show-toplevel"]));
  if (!ok(r)) return null;
  return (r.stdout || "").trim() || null;
}

// Reject pathspecs that could reach outside the repo: absolute paths (POSIX or
// Windows drive form) and any `..` segment that escapes the root. git -C already
// scopes most commands, but a pathspec like `../other/secret` would still resolve
// relative to the repo — this is defense-in-depth on the iframe-supplied paths.
function pathWithinRepo(p: string): boolean {
  if (!p) return false;
  if (p.charAt(0) === "/" || /^[A-Za-z]:[\\/]/.test(p) || p.charAt(0) === "\\") return false;
  const segs = p.replace(/\\/g, "/").split("/");
  let depth = 0;
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      depth -= 1;
      if (depth < 0) return false;
    } else {
      depth += 1;
    }
  }
  return true;
}

function* viewCall(method: string, args: ViewArgs): HostIoSteps<unknown> {
  args = args || {};
  const cwd = args.cwd;
  if (!cwd) return { error: "no cwd" };

  // For mutating ops we do NOT trust the iframe-supplied cwd. We canonicalize it
  // to the repo root git reports (rejecting non-repos) and operate strictly from
  // that root, and we validate every path argument stays inside the repo.
  let opCwd = cwd;
  if (MUTATING[method]) {
    const root = (yield* repoRoot(cwd));
    if (!root) return { error: `${method}: not a git repository` };
    opCwd = root;
    const paths = args.paths || (args.path ? [args.path] : []);
    for (let i = 0; i < paths.length; i++) {
      if (!pathWithinRepo(paths[i])) {
        return { error: `${method}: refusing path outside repository: ${baseName(String(paths[i]))}` };
      }
    }
  }

  try {
    switch (method) {
      case "gitGraph":
        return (yield* gitGraph(cwd, args.limit, args.skip));
      case "gitCommitFiles":
        return (yield* gitCommitFiles(cwd, args.sha as string));
      case "gitCommitDiff":
        return (yield* gitCommitDiff(cwd, args.sha as string, args.path as string));
      case "gitWorkdirFiles":
        return (yield* gitWorkdirFiles(cwd));
      case "gitWorkdirDiff":
        return (yield* gitWorkdirDiff(cwd, args.path as string));
      case "gitStage":
        return (yield* gitStage(opCwd, args.paths || (args.path ? [args.path] : [])));
      case "gitUnstage":
        return (yield* gitUnstage(opCwd, args.paths || (args.path ? [args.path] : [])));
      case "gitCommit":
        return (yield* gitCommit(opCwd, args.message as string));
      case "gitPush":
        return (yield* gitPush(opCwd));
      case "gitRevert":
        return (yield* gitRevert(opCwd, args.path as string));
      case "gitRepos":
        return (yield* gitRepos(cwd));
      case "gitWorktrees":
        return (yield* gitWorktrees(cwd));
      case "gitSelectRepo":
        return (yield* selectRepo(cwd, args.path as string));
      default:
        return { error: `unknown method: ${method}` };
    }
  } catch (e) {
    // Keep the method name (and thus the failing git op) in the message; the raw
    // exception alone loses all context. cwd/paths are deliberately omitted.
    return { error: `${method}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const plugin: IoExports<PluginModule> = {
  statusBubble,
  renderGlance,
  viewCall: viewCall as PluginModule["viewCall"],
  // exported for tests (pure logic, no host.exec)
  __test_parsePorcelain: parsePorcelain,
  __test_parseLog: parseLog,
  __test_parseGraph: parseGraph,
  __test_parseRefs: parseRefs,
  __test_parseNumstat: parseNumstat,
  __test_splitRename: splitRename,
  __test_parseStatusPorcelain: parseStatusPorcelain,
  __test_parseNumstatCounts: parseNumstatCounts,
  __test_mergeWorkdirFiles: mergeWorkdirFiles,
  __test_classifyPorcelain: classifyPorcelain,
  __test_pathWithinRepo: pathWithinRepo,
  __test_parseWorktrees: parseWorktrees,
};

export default defineProviderIo(plugin, () => host.io);
