import type { Profile } from "./types";
import { instanceBinDir } from "./instanceCli";
export function domiosCommand(profile: Profile, tool: string, a: Record<string, string>): { args: string[]; stdin?: string } | null {
  const scoped = (kind: "tabs" | "plans" | "blueprints", value: string) => {
    if (!value || value.startsWith("-") || !profile.targets?.[kind]?.includes(value)) throw new Error(`target outside profile ${kind} scope`);
    return value;
  };
  switch (tool) {
    case "identify": return { args: ["identify", "--json"] };
    case "tab_list": return { args: ["tab", "list", "--json"] };
    case "plan_list": return { args: ["plan", "list", "--workspace", "--json"] };
    case "mem_search": return { args: ["mem", "search", "--json", "--", a.query] };
    case "blueprint_list": return { args: ["blueprint", "list", "--json"] };
    case "tab_read": return { args: ["tab", "get-text", "--tab", scoped("tabs", a.tab)] };
    case "tab_describe": return { args: ["tab", "describe", "--tab", scoped("tabs", a.tab), "--", a.description] };
    case "send": return { args: ["send", "--tab", scoped("tabs", a.tab), "--require-agent", "--from-pad", "-"], stdin: a.text };
    case "report": return { args: ["agent", "report", "--from-pad", "-"], stdin: a.text };
    case "plan_report": return { args: ["agent", "report", "--plan", scoped("plans", a.plan), "--from-pad", "-"], stdin: a.text };
    case "blueprint_input": return { args: ["blueprint", "input", scoped("blueprints", a.blueprint), "--from-pad", "-"], stdin: a.text };
    case "blueprint_stop": return { args: ["blueprint", "stop", scoped("blueprints", a.blueprint)] };
    default: return null;
  }
}
export function startDomios(profile: Profile, name: string, args: Record<string, string>, deadline: number) {
  const command = domiosCommand(profile, name, args);
  if (!command) return null;
  const dir = instanceBinDir();
  if (!dir) throw new Error("instance CLI directory unavailable");
  const bin = `${dir.replace(/[\\/]+$/, "")}/${host.platform() === "windows" ? "codeterm.exe" : "codeterm"}`;
  const result = host.exec.start({ bin, ...command, timeoutMs: Math.max(1, Math.min(30000, deadline - host.unixNowMs())) });
  if (!result.jobId) throw new Error(result.error || "Domios command start failed");
  return { jobId: result.jobId };
}
