import type { LaunchParams, ModelInfo } from "@codeterm/plugin-sdk";

// LiteLLM's provider-owned environment names, never derived from user input.
// https://github.com/BerriAI/litellm/blob/main/litellm/main.py
// https://github.com/BerriAI/litellm-docs/blob/main/docs/providers/openrouter.md
export const PROVIDER_ENV: Record<string, { key: string; base: string }> = {
  openai: { key: "OPENAI_API_KEY", base: "OPENAI_API_BASE" },
  anthropic: { key: "ANTHROPIC_API_KEY", base: "ANTHROPIC_API_BASE" },
  groq: { key: "GROQ_API_KEY", base: "GROQ_API_BASE" },
  openrouter: { key: "OPENROUTER_API_KEY", base: "OPENROUTER_API_BASE" },
};

export interface Endpoint {
  name: string;
  kind: string;
  apiBase?: string;
  apiKeySecret: string;
  models: string[];
}

function nonempty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function modelIds(value: unknown): string[] {
  // The existing settings array UI offers scalar textarea fields, not nested
  // string arrays. Accept both the editor representation and native arrays.
  if (typeof value === "string") {
    if (value.trim().startsWith("[")) {
      try { value = JSON.parse(value); } catch { return []; }
    } else value = value.split(/\r?\n/);
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(nonempty).filter(Boolean))];
}

export function configuredEndpoints(settings: Record<string, unknown>): Endpoint[] {
  if (!Array.isArray(settings.endpoints)) return [];
  const endpoints: Endpoint[] = [];
  for (const value of settings.endpoints) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const name = nonempty(value.name);
    const kind = nonempty(value.kind).toLowerCase();
    const apiKeySecret = nonempty(value.apiKeySecret);
    const models = modelIds(value.models).filter(id => id.startsWith(`${kind}/`));
    if (!name || !Object.prototype.hasOwnProperty.call(PROVIDER_ENV, kind) || !apiKeySecret || !models.length) continue;
    endpoints.push({name, kind, apiKeySecret, models, ...(nonempty(value.apiBase) ? {apiBase: nonempty(value.apiBase)} : {})});
  }
  return endpoints;
}

export function endpointModels(endpoints: Endpoint[]): ModelInfo[] {
  const ownership = new Map<string, number>();
  for (const endpoint of endpoints) for (const id of endpoint.models) ownership.set(id, (ownership.get(id) || 0) + 1);
  return endpoints.flatMap(endpoint => endpoint.models.filter(id => ownership.get(id) === 1).map(id => ({id, displayName: id, group: endpoint.name})));
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

export function launchEndpoint(endpoints: Endpoint[], model: string | null): { endpoint: Endpoint; model: string } {
  const id = model ?? endpointModels(endpoints)[0]?.id;
  if (!id) throw new Error("Configure an Aider endpoint with a unique model ID before launching.");
  const owners = endpoints.filter(endpoint => endpoint.models.includes(id));
  if (owners.length !== 1) throw new Error(owners.length ? `Aider model ${id} belongs to multiple endpoints. Configure each model ID once.` : `Aider model ${id} has no configured endpoint.`);
  return { endpoint: owners[0], model: id };
}
