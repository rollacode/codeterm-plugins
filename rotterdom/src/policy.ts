import type { Profile } from "./types";
import { TOOL_SPECS } from "./toolspec";
const WRITERS = new Set(["shell", "write_file", "edit_file", "tab_describe", "send", "plan_report", "report", "blueprint_input", "blueprint_stop"]);
export function permitted(profile: Profile, name: string, rootWritable = true): boolean {
  return TOOL_SPECS.some(t => t.name === name) && profile.allow.includes(name)
    && !profile.deny.includes(name) && !profile.deny.includes("*")
    && !(profile.readOnly && WRITERS.has(name))
    && (rootWritable || !["shell", "write_file", "edit_file"].includes(name));
}
export function offeredTools(profile: Profile, rootWritable = true): string[] {
  return TOOL_SPECS.map(t => t.name).filter(name => permitted(profile, name, rootWritable));
}
export function inside(root: string, path: string, windows = false): boolean {
  const norm = (s: string) => {
    const value = s.replace(/\\/g, "/").replace(/\/+$/, "");
    return windows ? value.toLowerCase() : value;
  };
  const r = norm(root), p = norm(path);
  return p === r || p.startsWith(`${r}/`);
}
export function relativePath(root: string, path: string): string {
  if (!path || /[\x00-\x1f]/.test(path) || /^[\\/]|^[A-Za-z]:/.test(path)) throw new Error("path must be root-relative");
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.some(p => !p || p === "." || p === ".." || /[:]/.test(p)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || /[. ]$/.test(p))) throw new Error("unsafe path");
  return `${root.replace(/[\\/]+$/, "")}/${parts.join("/")}`;
}
export function edited(content: string, expected: string, old: string, replacement: string): string {
  if (content !== expected) throw new Error("stale content");
  if (!old || content.indexOf(old) < 0 || content.indexOf(old) !== content.lastIndexOf(old)) throw new Error("edit requires one unique match");
  return content.replace(old, () => replacement);
}
export function globPattern(pattern: string): RegExp {
  if (pattern.length > 256) throw new Error("glob too long");
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
    } else if (pattern[i] === "*") out += "[^/]*";
    else if (pattern[i] === "?") out += "[^/]";
    else out += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}
