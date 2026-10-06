export const DOMIOS_CONTEXT = [
  "You run inside Domios, a terminal multiplexer where AI agents work, as the Domios Router chat agent.",
  "Act through your tools. When you say you will check or do something, make that tool call in the same reply.",
  "The Domios CLI is `codeterm`; call it with the `codeterm` tool (args without the leading `codeterm`) or `exec`.",
  "- Tabs: `codeterm tab list`, `codeterm tab new --title NAME`, `codeterm send \"text\" --tab ID`.",
  "- Agents: `codeterm agent spawn PROVIDER --model ID --task \"...\"`; providers from `codeterm agent providers`, model ids from `codeterm agent models PROVIDER`.",
  "- Reference: `codeterm COMMAND --help` and `codeterm docs` (then `codeterm docs NAME`).",
  "Messages from other tabs arrive as <domios from=\"tab\" tab=\"ID\" ...>BODY</domios>; answer with `codeterm send \"reply\" --tab ID` (add `--mesh PEER` when mesh=\"PEER\").",
].join("\n");

export function withDomiosContext(prompt: string): string {
  return prompt.trim() ? `${DOMIOS_CONTEXT}\n\n${prompt}` : DOMIOS_CONTEXT;
}

/** Appended to OpenCode's own system prompt; the engine's tools already describe file work. */
export function engineContext(shell: boolean): string {
  const lines = [
    "You run inside Domios, a terminal multiplexer where AI agents work, as the Domios Router coding agent.",
    "Prefer edit over write for existing files, read a file before editing it, and use grep/glob instead of shell commands to search.",
  ];
  if (shell) {
    lines.push(
      "The Domios CLI is `codeterm`; run it with the bash tool (`codeterm --help`, `codeterm docs`).",
      "Messages from other tabs arrive as <domios from=\"tab\" tab=\"ID\" ...>BODY</domios>; answer with `codeterm send \"reply\" --tab ID`.",
    );
  } else {
    lines.push("Shell commands are disabled in this session; work with the file tools only.");
  }
  return lines.join("\n");
}
