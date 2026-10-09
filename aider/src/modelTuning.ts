import type { ModelEntry } from "./endpoints";

/** Core encodes its effort choice through the manifest's launch-args format.
 * Consume that choice before quoting args; never pass undeclared tuning on. */
export function modelLaunchArgs(args: string[], model: ModelEntry): string[] {
  const output: string[] = [];
  let effort: string | undefined;
  let budget: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    const flag = arg.split("=", 1)[0];
    if (flag === "--map-tokens") throw new Error("Configure mapTokens on the selected Aider model instead of launch args.");
    if (flag !== "--reasoning-effort" && flag !== "--thinking-tokens") {
      output.push(arg);
      continue;
    }
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : String(args[++i] ?? "");
    if (!value || value.startsWith("-")) throw new Error(`${flag} requires a declared model option.`);
    if (flag === "--reasoning-effort") effort = value;
    else budget = value;
  }
  if (model.mapTokens !== undefined) output.push("--map-tokens", String(model.mapTokens));
  if (effort !== undefined && budget !== undefined) throw new Error("Choose a reasoning level or thinking budget, not both.");
  if (effort !== undefined) {
    const level = model.reasoningEfforts.find(level => level.id === effort);
    if (!level || !model.reasoningMode) throw new Error(`Aider model ${model.id} does not declare reasoning level ${effort}.`);
    if (model.reasoningMode === "budget") output.push("--thinking-tokens", String(level.thinkingTokens));
    else output.push("--reasoning-effort", level.id);
  } else if (budget !== undefined) {
    // Direct Aider budget args are also gated by the selected model's list.
    if (model.reasoningMode !== "budget" || !model.reasoningEfforts.some(level => String(level.thinkingTokens) === budget)) {
      throw new Error(`Aider model ${model.id} does not declare thinking budget ${budget}.`);
    }
    output.push("--thinking-tokens", budget);
  }
  return output;
}
