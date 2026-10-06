import {
  PROVIDER_KINDS,
  type ProviderConfig,
  type ProviderKind,
  type ProviderSource,
  type RouterPreset,
} from "./types";

export const LMSTUDIO_PROVIDER_ID = "lmstudio";
export const DEFAULT_LMSTUDIO_URL = "http://localhost:1234";

// Must match the `api_key` env_var slots in settings.schema.json: the host's
// `--secret FIELD` only accepts schema-declared fields.
export const KEY_SLOTS: readonly string[] = [
  "lmstudio_api_key",
  "openai_api_key",
  "anthropic_api_key",
  "openrouter_api_key",
  "groq_api_key",
  "together_api_key",
  "deepseek_api_key",
  "xai_api_key",
  "mistral_api_key",
  "gemini_api_key",
  "mimo_api_key",
  "litellm_api_key",
  "custom1_api_key",
  "custom2_api_key",
  "custom3_api_key",
  "custom4_api_key",
];

export interface ProviderTemplate {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
}

export const PROVIDER_KINDS_INFO: { kind: ProviderKind; label: string; hint: string }[] = [
  { kind: "openai", label: "OpenAI-compatible", hint: "/models + /chat/completions — OpenRouter, Groq, Together, DeepSeek, xAI, Mistral, Ollama, vLLM, LiteLLM, custom" },
  { kind: "anthropic", label: "Anthropic Messages", hint: "/v1/models + /v1/messages with x-api-key" },
  { kind: "lmstudio", label: "LM Studio native", hint: "/api/v0/models with load state + stateful /api/v1/chat" },
];

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  { id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "openai", name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
  { id: "groq", name: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "together", name: "Together", kind: "openai", baseUrl: "https://api.together.xyz/v1" },
  { id: "deepseek", name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { id: "xai", name: "xAI", kind: "openai", baseUrl: "https://api.x.ai/v1" },
  { id: "mistral", name: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1" },
  { id: "gemini", name: "Gemini (OpenAI endpoint)", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "ollama", name: "Ollama", kind: "openai", baseUrl: "http://localhost:11434/v1" },
  { id: "litellm", name: "LiteLLM proxy", kind: "openai", baseUrl: "http://localhost:4000/v1" },
];

export interface ProviderInput {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  apiKeySecret?: unknown;
  models?: unknown;
  enabled?: unknown;
}

export interface PresetInput {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  provider?: unknown;
  model?: unknown;
  temperature?: unknown;
  maxTokens?: unknown;
  systemPrompt?: unknown;
  params?: unknown;
}

export interface RouterState {
  providers: ProviderInput[];
  presets: PresetInput[];
  disabled: string[];
  defaultProvider?: string;
}

export interface RouterSettings {
  baseUrl?: unknown;
  providers?: unknown;
  presets?: unknown;
  defaultProvider?: unknown;
}

export interface FieldError {
  field: string;
  message: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SECRET_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function emptyState(): RouterState {
  return { providers: [], presets: [], disabled: [] };
}

export function coerceState(raw: unknown): RouterState {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
  const state: RouterState = {
    providers: list(obj.providers) as ProviderInput[],
    presets: list(obj.presets) as PresetInput[],
    disabled: Array.isArray(obj.disabled) ? obj.disabled.filter((x): x is string => typeof x === "string") : [],
  };
  if (typeof obj.defaultProvider === "string" && obj.defaultProvider) state.defaultProvider = obj.defaultProvider;
  return state;
}

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

export function normalizeKind(value: unknown): ProviderKind | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "openai" || v === "openai-compatible" || v === "openai_compatible" || v === "oai") return "openai";
  if (v === "anthropic" || v === "anthropic-compatible" || v === "claude") return "anthropic";
  if (v === "lmstudio" || v === "lm-studio" || v === "lmstudio-native") return "lmstudio";
  return null;
}

export function defaultKeySlot(id: string): string {
  return `${id}_api_key`;
}

export function isDeclaredKeySlot(slot: string): boolean {
  return KEY_SLOTS.includes(slot);
}

interface ParsedUrl {
  scheme: string;
  authority: string;
  path: string;
}

function parseUrl(raw: string): ParsedUrl | null {
  const m = raw.match(/^(https?):\/\/([^/?#\s@]+)(\/[^?#\s]*)?$/i);
  if (!m) return null;
  return { scheme: m[1].toLowerCase(), authority: m[2], path: (m[3] || "").replace(/\/+$/, "") };
}

export function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parsed = parseUrl(raw.trim());
  if (!parsed) return null;
  return `${parsed.scheme}://${parsed.authority}${parsed.path}`;
}

/** host[:port] exactly as the host network allowlist matches it. */
export function hostOf(url: string): string {
  const parsed = parseUrl(url);
  return parsed ? parsed.authority.toLowerCase() : "";
}

/** API root the adapter appends endpoint paths to. */
export function apiRoot(provider: Pick<ProviderConfig, "kind" | "baseUrl">): string {
  const parsed = parseUrl(provider.baseUrl);
  if (!parsed) return provider.baseUrl.replace(/\/+$/, "");
  const origin = `${parsed.scheme}://${parsed.authority}`;
  if (provider.kind === "lmstudio") return origin + parsed.path.replace(/\/(api\/)?v\d+$/, "");
  if (provider.kind === "anthropic") return /\/v1$/.test(parsed.path) ? origin + parsed.path : `${origin}${parsed.path}/v1`;
  return parsed.path ? origin + parsed.path : `${origin}/v1`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function parseModelIds(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [];
  const out: string[] = [];
  for (const item of list) {
    const id = typeof item === "string" ? item.trim() : "";
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function finiteNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function validateProvider(
  input: ProviderInput,
  takenIds: readonly string[],
  source: ProviderSource = "user",
): Validated<ProviderConfig> {
  const errors: FieldError[] = [];
  const id = str(input.id).toLowerCase();
  if (!ID_RE.test(id)) errors.push({ field: "id", message: "Use 1-32 lowercase letters, digits or dashes." });
  else if (takenIds.includes(id)) errors.push({ field: "id", message: `A provider named ${id} already exists.` });
  const kind = normalizeKind(input.kind);
  if (!kind) errors.push({ field: "kind", message: "Kind must be openai, anthropic or lmstudio." });
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) errors.push({ field: "baseUrl", message: "Enter an http(s) URL such as https://api.example.com/v1." });
  const secretRaw = str(input.apiKeySecret);
  const apiKeySecret = secretRaw || defaultKeySlot(id);
  if (secretRaw && !SECRET_RE.test(apiKeySecret)) errors.push({ field: "apiKeySecret", message: "Key slot may use letters, digits, _ . -" });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id,
      name: str(input.name) || id,
      kind: kind as ProviderKind,
      baseUrl: baseUrl as string,
      apiKeySecret,
      models: parseModelIds(input.models),
      enabled: input.enabled !== false,
      source,
    },
  };
}

export function validatePreset(
  input: PresetInput,
  takenIds: readonly string[],
  source: ProviderSource = "user",
): Validated<RouterPreset> {
  const errors: FieldError[] = [];
  const id = str(input.id);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(id)) errors.push({ field: "id", message: "Use 1-48 letters, digits, _ . -" });
  else if (takenIds.includes(id)) errors.push({ field: "id", message: `A preset named ${id} already exists.` });
  const temperature = finiteNumber(input.temperature);
  if (input.temperature !== undefined && input.temperature !== "" && (temperature === undefined || temperature < 0 || temperature > 2)) {
    errors.push({ field: "temperature", message: "Temperature must be between 0 and 2." });
  }
  const maxTokens = finiteNumber(input.maxTokens);
  if (input.maxTokens !== undefined && input.maxTokens !== "" && (maxTokens === undefined || maxTokens < 1 || !Number.isInteger(maxTokens))) {
    errors.push({ field: "maxTokens", message: "Max tokens must be a positive whole number." });
  }
  if (input.params !== undefined && (typeof input.params !== "object" || input.params === null || Array.isArray(input.params))) {
    errors.push({ field: "params", message: "params must be an object." });
  }
  if (errors.length) return { ok: false, errors };
  const preset: RouterPreset = { id, name: str(input.name) || id, source };
  const description = str(input.description);
  if (description) preset.description = description;
  const provider = str(input.provider).toLowerCase();
  if (provider) preset.provider = provider;
  const model = str(input.model);
  if (model) preset.model = model;
  if (temperature !== undefined) preset.temperature = temperature;
  if (maxTokens !== undefined) preset.maxTokens = maxTokens;
  if (typeof input.systemPrompt === "string") preset.systemPrompt = input.systemPrompt;
  if (input.params && typeof input.params === "object") preset.params = { ...(input.params as Record<string, unknown>) };
  return { ok: true, value: preset };
}

function builtinLmStudio(settings: RouterSettings): ProviderConfig {
  return {
    id: LMSTUDIO_PROVIDER_ID,
    name: "LM Studio",
    kind: "lmstudio",
    baseUrl: normalizeBaseUrl(settings.baseUrl) || DEFAULT_LMSTUDIO_URL,
    apiKeySecret: defaultKeySlot(LMSTUDIO_PROVIDER_ID),
    models: [],
    enabled: true,
    source: "builtin",
  };
}

export interface ResolvedProviders {
  providers: ProviderConfig[];
  issues: string[];
}

/** config.yaml providers are read-only; user (router.json) providers cannot shadow them. */
export function resolveProviders(settings: RouterSettings, state: RouterState): ResolvedProviders {
  const issues: string[] = [];
  const providers: ProviderConfig[] = [];
  const declared = Array.isArray(settings.providers) ? (settings.providers as ProviderInput[]) : [];
  const declaresLmStudio = declared.some((p) => p && str(p.id).toLowerCase() === LMSTUDIO_PROVIDER_ID);
  if (!declaresLmStudio) providers.push(builtinLmStudio(settings));
  const add = (input: ProviderInput, source: ProviderSource) => {
    const result = validateProvider(input, providers.map((p) => p.id), source);
    if (result.ok) providers.push(result.value);
    else issues.push(`provider ${str(input && input.id) || "?"}: ${result.errors.map((e) => e.message).join(" ")}`);
  };
  for (const input of declared) add(input, "config");
  for (const input of state.providers) add(input, "user");
  for (const p of providers) if (state.disabled.includes(p.id)) p.enabled = false;
  return { providers, issues };
}

export function resolvePresets(settings: RouterSettings, state: RouterState): RouterPreset[] {
  const presets: RouterPreset[] = [];
  const add = (input: PresetInput, source: ProviderSource) => {
    const result = validatePreset(input, presets.map((p) => p.id), source);
    if (result.ok) presets.push(result.value);
  };
  if (Array.isArray(settings.presets)) for (const p of settings.presets as PresetInput[]) if (p) add(p, "config");
  for (const p of state.presets) add(p, "user");
  return presets;
}

export function defaultProviderId(settings: RouterSettings, state: RouterState, providers: ProviderConfig[]): string {
  const wanted = [state.defaultProvider, str(settings.defaultProvider), LMSTUDIO_PROVIDER_ID];
  for (const id of wanted) {
    if (id && providers.some((p) => p.id === id && p.enabled)) return id;
  }
  const first = providers.find((p) => p.enabled);
  return first ? first.id : LMSTUDIO_PROVIDER_ID;
}

/** A key is required for hosted APIs; local LM Studio/Ollama-style servers work without one. */
export function keyRequired(provider: Pick<ProviderConfig, "kind" | "baseUrl">): boolean {
  if (provider.kind === "anthropic") return true;
  if (provider.kind === "lmstudio") return false;
  const host = hostOf(provider.baseUrl).replace(/:\d+$/, "");
  return !(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || /\.(local|ts\.net)$/.test(host) || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host));
}
