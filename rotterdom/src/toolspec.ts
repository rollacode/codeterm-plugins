export interface ToolSpec { name: string; description: string; required: string[]; optional?: string[] }
export const TOOL_SPECS: readonly ToolSpec[] = [
  { name: "shell", description: "Run an arbitrary shell command in the profile root. Shell can write and is not filesystem-confined.", required: ["command"] },
  { name: "read_file", description: "Read a bounded UTF-8 file under the profile root.", required: ["path"] },
  { name: "write_file", description: "Create or replace a file. expected must equal its entire current content (empty for a new file).", required: ["path", "content", "expected"] },
  { name: "edit_file", description: "Replace one unique occurrence after checking the entire current content against expected.", required: ["path", "old", "new", "expected"] },
  { name: "glob", description: "List files matching a root-relative glob (*, **, ?).", required: ["pattern"] },
  { name: "search", description: "Find literal text in root-confined files.", required: ["text"], optional: ["pattern"] },
  { name: "identify", description: "Identify this Domios instance.", required: [] },
  { name: "tab_list", description: "List Domios tabs.", required: [] },
  { name: "plan_list", description: "List Domios plans in this workspace.", required: [] },
  { name: "mem_search", description: "Search Domios memory.", required: ["query"] },
  { name: "blueprint_list", description: "List this caller's Blueprints.", required: [] },
  { name: "tab_read", description: "Read a profile-approved tab.", required: ["tab"] },
  { name: "tab_describe", description: "Describe a profile-approved tab.", required: ["tab", "description"] },
  { name: "send", description: "Send a message to a profile-approved agent tab.", required: ["tab", "text"] },
  { name: "plan_report", description: "Report to a profile-approved plan.", required: ["plan", "text"] },
  { name: "report", description: "Report to this agent's assigned parent and task.", required: ["text"] },
  { name: "blueprint_input", description: "Submit text to a profile-approved Blueprint.", required: ["blueprint", "text"] },
  { name: "blueprint_stop", description: "Stop a profile-approved Blueprint.", required: ["blueprint"] },
];
export function checkToolArgs(name: string, raw: unknown): Record<string, string> {
  const spec = TOOL_SPECS.find(t => t.name === name);
  if (!spec) throw new Error(`unknown tool: ${name}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("arguments must be an object");
  const args = raw as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (![...spec.required, ...(spec.optional || [])].includes(key) || typeof args[key] !== "string") {
      throw new Error(`invalid argument: ${key}`);
    }
  }
  for (const key of spec.required) if (typeof args[key] !== "string") throw new Error(`missing argument: ${key}`);
  return args as Record<string, string>;
}
export function openAiTools(names: string[]): unknown[] {
  return TOOL_SPECS.filter(t => names.includes(t.name)).map(t => ({ type: "function", function: {
    name: t.name, description: t.description, parameters: { type: "object",
      properties: Object.fromEntries([...t.required, ...(t.optional || [])].map(k => [k, { type: "string" }])),
      required: t.required, additionalProperties: false },
  } }));
}
