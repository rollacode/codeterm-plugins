import type { Profile } from "./types";
const READ = ["read_file", "glob", "search"];
const INSPECT = ["identify", "tab_list", "plan_list", "mem_search", "blueprint_list", "tab_read"];
export function predefinedProfiles(endpoint: string, model: string, root: string): Profile[] {
  const base = { endpoint, model, root, deny: [], budgets: { tokens: 64000, turns: 24, deadlineMs: 300000 } };
  return [
    { ...base, id: "coding", name: "Coding", systemPrompt: "Complete the coding task using the available file and search tools. Read current content before edits. Verify your changes and report the result.", allow: [...READ, "write_file", "edit_file", "shell", "report"] },
    { ...base, id: "reader", name: "Reader", systemPrompt: "Read and explain the material requested by the user. Use only the supplied read and search tools.", allow: READ, readOnly: true },
    { ...base, id: "domios-inspector", name: "Domios Inspector", systemPrompt: "Inspect Domios using the supplied read tools. Distinguish observations from assumptions and report your findings in your answer.", allow: INSPECT, readOnly: true },
    { ...base, id: "domios-operator", name: "Domios Operator", systemPrompt: "Operate Domios through the supplied scoped tools. Act only on the approved targets. Report each action's observable result.", allow: [...INSPECT, "tab_describe", "send", "plan_report", "report", "blueprint_input", "blueprint_stop"], targets: { tabs: [], plans: [], blueprints: [] } },
  ];
}
