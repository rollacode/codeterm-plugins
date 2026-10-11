import type { ModelInfo } from "@codeterm/plugin-sdk";

export function parseGrokModels(stdout: string): ModelInfo[] | null {
  const lines = stdout.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === "Available models:");
  if (start < 0) return null;
  const ids = new Set<string>();
  const models: ModelInfo[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const match = /^\s*[-*]\s+([a-z0-9][a-z0-9._-]*)(?:\s+\(default\))?\s*$/i.exec(line);
    if (!match) return null;
    if (!ids.has(match[1])) {
      ids.add(match[1]);
      models.push({ id: match[1], displayName: match[1], group: "xAI" });
    }
  }
  return models.length ? models : null;
}
