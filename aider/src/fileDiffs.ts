import { recordedPatchDiff, type RecordedFileDiff } from "@codeterm/plugin-sdk";

function gitPath(line: string): string | null {
  let value = line.slice(4);
  if (value.startsWith('"')) {
    try { value = JSON.parse(value) as string; } catch (_) { return null; }
  }
  return value === "/dev/null" ? null : /^[ab]\//.test(value) ? value.slice(2) : null;
}

function gitOutput(args: string[]): string | null {
  try {
    const result = JSON.parse(host.exec(JSON.stringify({ bin: "git", timeoutMs: 5000, args }))) as { code?: number; stdout?: string } | null;
    return result?.code === 0 && typeof result.stdout === "string" ? result.stdout : null;
  } catch (_) { return null; }
}

export function aiderCommitDiffs(sessionKey: string, hash: string, paths: string[]): RecordedFileDiff[] {
  const cwd = /^(.*)[\\/]\.aider[\\/]history[\\/][^\\/]+\.md$/.exec(sessionKey)?.[1];
  if (!cwd || !/^[0-9a-f]{7,40}$/.test(hash)) return [];
  const root = gitOutput(["-C", cwd, "rev-parse", "--show-toplevel"])?.trimEnd();
  if (!root) return [];
  const diffs: RecordedFileDiff[] = [];
  for (const path of new Set(paths)) {
    const patch = gitOutput(["-C", root, "-c", "core.quotePath=false", "--literal-pathspecs", "show", "--format=", "--no-color", "--no-notes", "--no-ext-diff", "--no-textconv", "--no-renames", "--root", hash, "--", path]);
    if (!patch?.startsWith("diff --git ")) continue;
    const kind = /^new file mode /m.test(patch) ? "add" : /^deleted file mode /m.test(patch) ? "delete" : "modify";
    const oldHeader = patch.match(/^--- .+$/m)?.[0];
    const newHeader = patch.match(/^\+\+\+ .+$/m)?.[0];
    const recordedPath = (newHeader && gitPath(newHeader)) || (oldHeader && gitPath(oldHeader));
    if (recordedPath) {
      diffs.push(...recordedPatchDiff(recordedPath, patch, kind));
    } else if (/^Binary files .+ differ$/m.test(patch) || (kind !== "modify" && !/^@@ /m.test(patch))) {
      const header = patch.split("\n")[0];
      const expected = `diff --git a/${path} b/${path}`;
      if (header === expected) diffs.push({ path, kind, additions: 0, deletions: 0, hunks: [],
        ...(/^Binary files /m.test(patch) ? { binary: true } : {}) });
    }
  }
  return diffs;
}
