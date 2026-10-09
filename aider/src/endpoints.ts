import type { LaunchParams, ModelInfo, ReasoningEffortInfo } from "@codeterm/plugin-sdk";

// LiteLLM's provider-owned environment names, never derived from user input.
// https://github.com/BerriAI/litellm/blob/main/litellm/main.py
// https://github.com/BerriAI/litellm-docs/blob/main/docs/providers/openrouter.md
export const PROVIDER_ENV: Record<string, { key: string; base: string }> = {
  openai: { key: "OPENAI_API_KEY", base: "OPENAI_API_BASE" },
  anthropic: { key: "ANTHROPIC_API_KEY", base: "ANTHROPIC_API_BASE" },
  groq: { key: "GROQ_API_KEY", base: "GROQ_API_BASE" },
  openrouter: { key: "OPENROUTER_API_KEY", base: "OPENROUTER_API_BASE" },
};

export interface ReasoningLevel extends ReasoningEffortInfo {
  thinkingTokens?: number;
}

export interface ModelEntry {
  id: string;
  displayName?: string;
  mapTokens?: number;
  reasoningMode?: "effort" | "budget";
  reasoningEfforts: ReasoningLevel[];
  defaultReasoningEffort?: string;
}

export interface Endpoint {
  name: string;
  kind: string;
  apiBase?: string;
  apiKeySecret: string;
  models: ModelEntry[];
}

function nonempty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function modelEntries(value: unknown): ModelEntry[] {
  // Existing settings UI uses a textarea for nested model arrays.
  if (typeof value === "string") {
    if (value.trim().startsWith("[")) {
      try { value = JSON.parse(value); } catch { return []; }
    } else value = value.split(/\r?\n/);
  }
  if (!Array.isArray(value)) return [];
  const models: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const id = nonempty(typeof raw === "string" ? raw : item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const model: ModelEntry = {id, reasoningEfforts: []};
    if (nonempty(item.displayName)) model.displayName = nonempty(item.displayName);
    if (tokenCount(item.mapTokens)) model.mapTokens = item.mapTokens;
    if (item.reasoningMode === "effort" || item.reasoningMode === "budget") {
      model.reasoningMode = item.reasoningMode;
      const levels = Array.isArray(item.reasoningEfforts) ? item.reasoningEfforts : [];
      const levelIds = new Set<string>();
      for (const level of levels) {
        if (!level || typeof level !== "object" || Array.isArray(level)) continue;
        const levelId = nonempty(level.id);
        if (!levelId || levelIds.has(levelId)) continue;
        if (model.reasoningMode === "budget" && !tokenCount(level.thinkingTokens)) continue;
        levelIds.add(levelId);
        model.reasoningEfforts.push({id: levelId, displayName: nonempty(level.displayName) || levelId,
          ...(nonempty(level.description) ? {description: nonempty(level.description)} : {}),
          ...(model.reasoningMode === "budget" ? {thinkingTokens: level.thinkingTokens} : {})});
      }
      const defaultId = nonempty(item.defaultReasoningEffort);
      if (model.reasoningEfforts.some(level => level.id === defaultId)) model.defaultReasoningEffort = defaultId;
    }
    models.push(model);
  }
  return models;
}

export function configuredEndpoints(settings: Record<string, unknown>): Endpoint[] {
  if (!Array.isArray(settings.endpoints)) return [];
  const endpoints: Endpoint[] = [];
  for (const value of settings.endpoints) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const name = nonempty(value.name);
    const kind = nonempty(value.kind).toLowerCase();
    const apiKeySecret = nonempty(value.apiKeySecret);
    const models = modelEntries(value.models).filter(model => model.id.startsWith(`${kind}/`));
    if (!name || !Object.prototype.hasOwnProperty.call(PROVIDER_ENV, kind) || !apiKeySecret || !models.length) continue;
    endpoints.push({name, kind, apiKeySecret, models, ...(nonempty(value.apiBase) ? {apiBase: nonempty(value.apiBase)} : {})});
  }
  return endpoints;
}

export function endpointModels(endpoints: Endpoint[]): ModelInfo[] {
  const ownership = new Map<string, number>();
  for (const endpoint of endpoints) for (const model of endpoint.models) ownership.set(model.id, (ownership.get(model.id) || 0) + 1);
  return endpoints.flatMap(endpoint => endpoint.models.filter(model => ownership.get(model.id) === 1).map(model => ({
    id: model.id, displayName: model.displayName || model.id, group: endpoint.name,
    reasoningEfforts: model.reasoningEfforts.map(({id, displayName, description}) => ({id, displayName, ...(description ? {description} : {})})),
    ...(model.defaultReasoningEffort ? {defaultReasoningEffort: model.defaultReasoningEffort} : {}),
  })));
}

export function selectedModel(params: LaunchParams): string | null {
  let model: string | null = null;
  const args = params.args || [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === "--model" || arg === "-m") {
      if (!args[i + 1] || String(args[i + 1]).startsWith("-")) throw new Error("Aider --model requires a configured model ID.");
      model = String(args[++i]);
    } else if (arg.startsWith("--model=")) {
      model = arg.slice(8);
      if (!model) throw new Error("Aider --model requires a configured model ID.");
    }
  }
  return model;
}

export function launchEndpoint(endpoints: Endpoint[], model: string | null): { endpoint: Endpoint; model: string; entry: ModelEntry } {
  const id = model ?? endpointModels(endpoints)[0]?.id;
  if (!id) throw new Error("Configure an Aider endpoint with a unique model ID before launching.");
  const owners = endpoints.filter(endpoint => endpoint.models.some(model => model.id === id));
  if (owners.length !== 1) throw new Error(owners.length ? `Aider model ${id} belongs to multiple endpoints. Configure each model ID once.` : `Aider model ${id} has no configured endpoint.`);
  return { endpoint: owners[0], model: id, entry: owners[0].models.find(model => model.id === id)! };
}
