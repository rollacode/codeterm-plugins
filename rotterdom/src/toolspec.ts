export interface ToolSpec { name: string; description: string; required: string[]; optional?: string[] }
export const TOOL_SPECS: readonly ToolSpec[] = [
  { name: "shell", description: "Run an arbitrary shell command in the profile root. Shell can write and is not filesystem-confined.", required: ["command"] },
  { name: "read_file", description: "Read a bounded UTF-8 file under the profile root.", required: ["path"] },
  { name: "write_file", description: "Create or replace a file. expected must equal its entire current content (empty for a new file).", required: ["path", "content", "expected"] },
  { name: "edit_file", description: "Replace one unique occurrence after checking the entire current content against expected.", required: ["path", "old", "new", "expected"] },
  { name: "glob", description: "List files matching a root-relative glob (*, **, ?).", required: ["pattern"] },
  { name: "search", description: "Find literal text in root-confined files.", required: ["text"], optional: ["pattern"] },
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
