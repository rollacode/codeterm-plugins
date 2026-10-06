export interface ToolParam {
  name: string;
  description: string;
  required: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  params: ToolParam[];
}

const p = (name: string, description: string, required = true): ToolParam => ({ name, description, required });

export const TOOL_SPECS: readonly ToolSpec[] = [
  { name: "exec", description: "Run a shell command and return its exit code, stdout and stderr.", params: [p("cmd", "Shell command line."), p("cwd", "Working directory.", false)] },
  { name: "codeterm", description: "Run the Domios CLI: `codeterm <args>`.", params: [p("args", "Arguments after `codeterm`, e.g. `tab list`.")] },
  { name: "read_file", description: "Read a text file.", params: [p("path", "File path.")] },
  { name: "write_file", description: "Write a text file, replacing its content.", params: [p("path", "File path."), p("content", "Full file content.")] },
  { name: "mem_search", description: "Search Domios memory.", params: [p("query", "Search query.")] },
  { name: "spawn_agent", description: "Spawn an agent tab with a task.", params: [p("provider", "Agent provider id."), p("task", "Task text."), p("workspace", "Workspace id.", false)] },
];

export function toolSpec(name: string): ToolSpec | undefined {
  return TOOL_SPECS.find((t) => t.name === name);
}

function jsonSchema(spec: ToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const param of spec.params) properties[param.name] = { type: "string", description: param.description };
  return { type: "object", properties, required: spec.params.filter((x) => x.required).map((x) => x.name) };
}

export function openAiTools(): Record<string, unknown>[] {
  return TOOL_SPECS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: jsonSchema(t) } }));
}

export function anthropicTools(): Record<string, unknown>[] {
  return TOOL_SPECS.map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t) }));
}

export type ArgsCheck = { ok: true; args: Record<string, string> } | { ok: false; error: string };

/** Keeps only declared string params; a missing required param is an error, never a guess. */
export function checkToolArgs(name: string, raw: unknown): ArgsCheck {
  const spec = toolSpec(name);
  if (!spec) return { ok: false, error: `unknown tool: ${name}. Declared tools: ${TOOL_SPECS.map((t) => t.name).join(", ")}` };
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const args: Record<string, string> = {};
  for (const param of spec.params) {
    const value = input[param.name];
    if (typeof value === "string") args[param.name] = value;
    else if (typeof value === "number" || typeof value === "boolean") args[param.name] = String(value);
  }
  const missing = spec.params.filter((x) => x.required && !args[x.name]).map((x) => x.name);
  if (missing.length) return { ok: false, error: `${name} requires ${missing.join(", ")}` };
  return { ok: true, args };
}
