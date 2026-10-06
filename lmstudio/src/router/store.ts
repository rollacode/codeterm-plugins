import {
  coerceState,
  defaultProviderId,
  keyRequired,
  resolvePresets,
  resolveProviders,
  type RouterSettings,
  type RouterState,
} from "./config";
import { classifyFetch, modelsRequests, type FetchOutcome } from "./adapters";
import { readDataFile, writeDataFile } from "./datafiles";
import { parseModelList } from "./models";
import type { HttpRequest, ProviderConfig, RouterError, RouterModel, RouterPreset } from "./types";

const STATE_FILE = "router.json";
const MODEL_CACHE_FILE = "router-models.json";
export const REMOTE_MODEL_TTL_MS = 10 * 60 * 1000;
export const LOCAL_MODEL_TTL_MS = 15 * 1000;
export const FAILURE_TTL_MS = 60 * 1000;

export interface RouterSnapshot {
  settings: RouterSettings & Record<string, unknown>;
  state: RouterState;
  providers: ProviderConfig[];
  presets: RouterPreset[];
  defaultProvider: string;
  issues: string[];
}

export interface ModelCacheEntry {
  at: number;
  baseUrl: string;
  models: RouterModel[];
  error: RouterError | null;
  configured?: boolean;
}

function configuredModels(provider: ProviderConfig): RouterModel[] {
  return provider.models.map((id) => ({ providerId: provider.id, id, displayName: id, capabilities: {} }));
}

let memCache: Record<string, ModelCacheEntry> | null = null;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(name: string, value: unknown): boolean {
  return writeDataFile(name, JSON.stringify(value, null, 2));
}

function readJsonFile(name: string): unknown {
  return parseJson<unknown>(readDataFile(name), null);
}

export function readSettings(): RouterSettings & Record<string, unknown> {
  const raw = parseJson<unknown>(host.settingsJson ? host.settingsJson() : "{}", {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as RouterSettings & Record<string, unknown>) : {};
}

export function readState(): RouterState {
  return coerceState(readJsonFile(STATE_FILE));
}

export function writeState(state: RouterState): boolean {
  return writeJsonFile(STATE_FILE, state);
}

export function snapshot(): RouterSnapshot {
  const settings = readSettings();
  const state = readState();
  const { providers, issues } = resolveProviders(settings, state);
  return {
    settings,
    state,
    providers,
    presets: resolvePresets(settings, state),
    defaultProvider: defaultProviderId(settings, state, providers),
    issues,
  };
}

function secretsAvailable(): boolean {
  return typeof host.secretGet === "function";
}

export function getKey(provider: Pick<ProviderConfig, "apiKeySecret">): string | null {
  if (!secretsAvailable()) return null;
  try {
    const value = host.secretGet(provider.apiKeySecret);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function hasKey(provider: Pick<ProviderConfig, "apiKeySecret">): boolean {
  return !!getKey(provider);
}

export function setKey(slot: string, value: string): boolean {
  if (typeof host.secretSet !== "function") return false;
  try {
    return host.secretSet(slot, value);
  } catch {
    return false;
  }
}

export function deleteKey(slot: string): boolean {
  if (typeof host.secretDelete !== "function") return false;
  try {
    return host.secretDelete(slot);
  } catch {
    return false;
  }
}

export function fetchSync(req: HttpRequest): FetchOutcome {
  try {
    return parseJson<FetchOutcome>(host.fetch(JSON.stringify(req)), { error: "fetch returned non-JSON" });
  } catch (e) {
    return { error: String(e) };
  }
}

function cache(): Record<string, ModelCacheEntry> {
  if (!memCache) {
    const stored = readJsonFile(MODEL_CACHE_FILE);
    memCache = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, ModelCacheEntry>) : {};
  }
  return memCache;
}

function persistCache(): void {
  const entries = cache();
  const durable: Record<string, ModelCacheEntry> = {};
  for (const id of Object.keys(entries)) if (!entries[id].error) durable[id] = entries[id];
  writeJsonFile(MODEL_CACHE_FILE, durable);
}

export function invalidateModels(providerId: string): void {
  delete cache()[providerId];
}

export function resetModelCache(): void {
  memCache = {};
}

export function cachedModels(provider: ProviderConfig): ModelCacheEntry | null {
  const entry = cache()[provider.id];
  return entry && entry.baseUrl === provider.baseUrl ? entry : null;
}

function ttl(provider: ProviderConfig): number {
  return provider.kind === "lmstudio" ? LOCAL_MODEL_TTL_MS : REMOTE_MODEL_TTL_MS;
}

function now(): number {
  try {
    return typeof host.unixNowMs === "function" ? host.unixNowMs() : Date.now();
  } catch {
    return Date.now();
  }
}

export function discoverModels(provider: ProviderConfig, opts?: { force?: boolean }): ModelCacheEntry {
  const existing = cachedModels(provider);
  const reusable = existing && !(existing.error && existing.error.kind === "key_missing");
  if (!opts?.force && existing && reusable && now() - existing.at < (existing.error ? FAILURE_TTL_MS : ttl(provider))) return existing;
  const key = getKey(provider);
  let entry: ModelCacheEntry;
  if (!key && keyRequired(provider)) {
    entry = {
      at: now(),
      baseUrl: provider.baseUrl,
      models: existing ? existing.models : [],
      error: { kind: "key_missing", message: `No API key in slot ${provider.apiKeySecret}.` },
    };
  } else {
    entry = { at: now(), baseUrl: provider.baseUrl, models: [], error: { kind: "unreachable", message: "no model endpoint answered" } };
    for (const req of modelsRequests(provider, key)) {
      const res = fetchSync(req);
      const failure = classifyFetch(req.url, res);
      if (failure) {
        entry.error = failure;
        if (failure.kind === "not_found") continue;
        break;
      }
      const body = parseJson<unknown>(res.body, undefined);
      if (body === undefined) {
        entry.error = { kind: "parse", message: "The model list was not JSON." };
        continue;
      }
      entry.models = parseModelList(provider.id, body);
      entry.error = null;
      break;
    }
    if (entry.error && entry.error.kind === "not_found" && provider.models.length) {
      entry.models = configuredModels(provider);
      entry.error = null;
      entry.configured = true;
    } else if (entry.error && existing) entry.models = existing.models;
  }
  cache()[provider.id] = entry;
  persistCache();
  return entry;
}

export type ProviderState = "connected" | "key_missing" | "unreachable" | "auth" | "denied" | "error" | "disabled" | "unchecked";

export interface ProviderStatus {
  state: ProviderState;
  message: string;
  modelCount: number;
  checkedAt: number | null;
}

export function statusFromEntry(provider: ProviderConfig, entry: ModelCacheEntry | null): ProviderStatus {
  if (!provider.enabled) return { state: "disabled", message: "Disabled", modelCount: entry ? entry.models.length : 0, checkedAt: entry ? entry.at : null };
  if (!entry) {
    if (keyRequired(provider) && !hasKey(provider)) return { state: "key_missing", message: `No API key in slot ${provider.apiKeySecret}.`, modelCount: 0, checkedAt: null };
    return { state: "unchecked", message: "Not checked yet", modelCount: 0, checkedAt: null };
  }
  const count = entry.models.length;
  if (!entry.error) {
    const message = entry.configured ? `No model listing here; using ${count} configured model${count === 1 ? "" : "s"}` : `${count} model${count === 1 ? "" : "s"}`;
    return { state: "connected", message, modelCount: count, checkedAt: entry.at };
  }
  const kind = entry.error.kind;
  const state: ProviderState =
    kind === "key_missing" ? "key_missing" : kind === "auth" ? "auth" : kind === "denied" ? "denied" : kind === "unreachable" || kind === "timeout" ? "unreachable" : "error";
  return { state, message: entry.error.message, modelCount: count, checkedAt: entry.at };
}
