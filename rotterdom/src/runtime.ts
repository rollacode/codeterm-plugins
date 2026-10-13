import type { Profile } from "./types";
import { checkToolArgs } from "./toolspec";
import { edited, globPattern, inside, permitted, relativePath } from "./policy";
import { startDomios } from "./domios";
export type Pending = { jobId: string };
const MAX_FILE = 128 * 1024;
export function confinedPath(profile: Profile, name: string, writing = false): string {
  const root = host.canonicalPath(profile.root);
  if (!root) throw new Error("root unavailable or denied by host");
  const path = relativePath(root, name);
  const windows = host.platform() === "windows";
  const parts = path.slice(root.length + 1).split("/");
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current += `/${parts[i]}`;
    const canonical = host.canonicalPath(current);
    if (!canonical) {
      if (writing && i === parts.length - 1 && !host.fileExists(current)) return current;
      throw new Error("path unavailable or denied by host");
    }
    if (!inside(root, canonical, windows) || host.isSymlink(current) !== false) throw new Error("symlink or root escape refused");
  }
  return current;
}
function read(path: string): string {
  const content = host.readFileHead(path, MAX_FILE + 1);
  if (content === null) throw new Error("read unavailable or denied by host");
  if (content.length > MAX_FILE || unescape(encodeURIComponent(content)).length > MAX_FILE) throw new Error("file exceeds read limit");
  return content;
}
export function execute(profile: Profile, name: string, raw: unknown, deadline: number): unknown | Pending {
  if (!permitted(profile, name, host.projectWriteAllowed(profile.root))) throw new Error(`tool refused: ${name}`);
  const a = checkToolArgs(name, raw);
  const domios = startDomios(profile, name, a, deadline);
  if (domios) return domios;
  if (name === "shell") {
    if (!a.command || a.command.length > 32768) throw new Error("invalid shell command");
    const root = host.canonicalPath(profile.root);
    if (!root) throw new Error("root unavailable or denied by host");
    const windows = host.platform() === "windows";
    const cmd = windows ? `Set-Location -LiteralPath ${host.shell.quoteFor(root, "windows")}; if (!$?) { exit 1 }; ${a.command}`
      : `cd ${host.shell.quoteFor(root, host.platform())} && ${a.command}`;
    const result = host.exec.start({ bin: windows ? "powershell" : "sh",
      args: windows ? ["-NoProfile", "-NonInteractive", "-Command", cmd] : ["-c", cmd],
      timeoutMs: Math.max(1, Math.min(120000, deadline - host.unixNowMs())) });
    if (!result.jobId) throw new Error(result.error || "shell start failed");
    return { jobId: result.jobId };
  }
  if (name === "read_file") return { content: read(confinedPath(profile, a.path)) };
  if (name === "write_file" || name === "edit_file") {
    const path = confinedPath(profile, a.path, name === "write_file");
    const before = host.fileExists(path) ? read(path) : "";
    if (before !== a.expected) throw new Error("stale content");
    const next = name === "edit_file" ? edited(before, a.expected, a.old, a.new) : a.content;
    if (unescape(encodeURIComponent(next)).length > MAX_FILE) throw new Error("write exceeds limit");
    const lock = host.lockFile(path);
    if (!lock) throw new Error("file lock unavailable or denied by host");
    try {
      const content = host.fileExists(path) ? read(path) : "";
      if (content !== a.expected) throw new Error("stale content");
      if (!host.writeFileAtomic(path, next)) throw new Error("write failed or denied by host");
      return { path: a.path, written: true };
    } finally { host.unlockFile(lock); }
  }
  if (name === "glob" || name === "search") {
    const pattern = globPattern(a.pattern || "**/*");
    const root = host.canonicalPath(profile.root);
    if (!root) throw new Error("root unavailable or denied by host");
    const files: string[] = [];
    const queue = [{ path: root, depth: 0 }];
    let visited = 0;
    while (queue.length) {
      const dir = queue.shift()!;
      for (const entry of host.fs.readDir(dir.path).sort((a, b) => a.path.localeCompare(b.path))) {
        if (++visited > 2000) throw new Error("search exceeds entry budget");
        const rel = entry.path.replace(/\\/g, "/").slice(root.replace(/\\/g, "/").length + 1);
        try { confinedPath(profile, rel); } catch { continue; }
        if (entry.isDir && dir.depth < 8) queue.push({ path: entry.path, depth: dir.depth + 1 });
        if (entry.isFile && pattern.test(rel)) files.push(rel);
      }
    }
    if (name === "glob") return { files: files.sort().slice(0, 200), truncated: files.length > 200 };
    if (!a.text || a.text.length > 4096) throw new Error("invalid search text");
    const matches: { path: string; line: number; text: string }[] = [];
    for (const file of files.sort()) {
      let content: string;
      try { content = read(confinedPath(profile, file)); } catch { continue; }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) if (lines[i].includes(a.text)) {
        matches.push({ path: file, line: i + 1, text: lines[i].slice(0, 500) });
        if (matches.length >= 200) return { matches, truncated: true };
      }
    }
    return { matches, truncated: false };
  }
  throw new Error(`unknown tool: ${name}`);
}
