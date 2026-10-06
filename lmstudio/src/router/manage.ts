import { hostOf, isDeclaredKeySlot, validatePreset, validateProvider, type FieldError, type PresetInput, type ProviderInput } from "./config";
import { capabilityBadges, groupAndSearch } from "./models";
import { qualifyModel } from "./routing";
import {
  cachedModels,
  deleteKey,
  discoverModels,
  hasKey,
  invalidateModels,
  setKey,
  snapshot,
  statusFromEntry,
  writeState,
  type ProviderStatus,
} from "./store";
import type { ProviderConfig, RouterModel, RouterPreset } from "./types";

export type OpResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string; fieldErrors?: FieldError[] };

export interface ProviderView {
  id: string;
  name: string;
  kind: ProviderConfig["kind"];
  baseUrl: string;
  host: string;
  apiKeySecret: string;
  models: string[];
  keySlotDeclared: boolean;
  hasKey: boolean;
  enabled: boolean;
  source: ProviderConfig["source"];
  isDefault: boolean;
  status: ProviderStatus;
}

export interface ModelView {
  id: string;
  model: string;
  displayName: string;
  providerId: string;
  loaded?: boolean;
  badges: string[];
}

export interface SectionView {
  providerId: string;
  providerName: string;
  kind: ProviderConfig["kind"];
  total: number;
  models: ModelView[];
  status: ProviderStatus;
}

function fail(error: string, fieldErrors?: FieldError[]): { ok: false; error: string; fieldErrors?: FieldError[] } {
  return fieldErrors ? { ok: false, error, fieldErrors } : { ok: false, error };
}

function providerView(p: ProviderConfig, defaultProvider: string): ProviderView {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    host: hostOf(p.baseUrl),
    apiKeySecret: p.apiKeySecret,
    models: p.models,
    keySlotDeclared: isDeclaredKeySlot(p.apiKeySecret),
    hasKey: hasKey(p),
    enabled: p.enabled,
    source: p.source,
    isDefault: p.id === defaultProvider,
    status: statusFromEntry(p, cachedModels(p)),
  };
}

export function listProviders(): { providers: ProviderView[]; defaultProvider: string; issues: string[] } {
  const snap = snapshot();
  return {
    providers: snap.providers.map((p) => providerView(p, snap.defaultProvider)),
    defaultProvider: snap.defaultProvider,
    issues: snap.issues,
  };
}

function stripUserProvider(input: ProviderInput): ProviderInput {
  const out: ProviderInput = { id: input.id, name: input.name, kind: input.kind, baseUrl: input.baseUrl };
  if (input.apiKeySecret) out.apiKeySecret = input.apiKeySecret;
  if (Array.isArray(input.models) && input.models.length) out.models = input.models;
  return out;
}

export function addProvider(input: ProviderInput): OpResult<{ provider: ProviderView }> {
  const snap = snapshot();
  const result = validateProvider(input, snap.providers.map((p) => p.id));
  if (!result.ok) return fail(result.errors.map((e) => e.message).join(" "), result.errors);
  const p = result.value;
  snap.state.providers.push(stripUserProvider({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, apiKeySecret: p.apiKeySecret, models: p.models }));
  if (!writeState(snap.state)) return fail("Could not save the provider list.");
  return { ok: true, provider: providerView(p, snap.defaultProvider) };
}

export function updateProvider(id: string, input: ProviderInput): OpResult<{ provider: ProviderView }> {
  const snap = snapshot();
  const existing = snap.providers.find((p) => p.id === id);
  if (!existing) return fail(`Unknown provider ${id}.`);
  if (existing.source !== "user") return fail(`${existing.name} is defined in config.yaml; edit it there.`);
  const merged: ProviderInput = { ...existing, ...input, id };
  const result = validateProvider(merged, snap.providers.filter((p) => p.id !== id).map((p) => p.id));
  if (!result.ok) return fail(result.errors.map((e) => e.message).join(" "), result.errors);
  const p = result.value;
  snap.state.providers = snap.state.providers.map((raw) =>
    String(raw.id || "").toLowerCase() === id ? stripUserProvider({ id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, apiKeySecret: p.apiKeySecret, models: p.models }) : raw,
  );
  if (!writeState(snap.state)) return fail("Could not save the provider list.");
  invalidateModels(id);
  return { ok: true, provider: providerView({ ...p, enabled: existing.enabled }, snap.defaultProvider) };
}

export function removeProvider(id: string): OpResult {
  const snap = snapshot();
  const existing = snap.providers.find((p) => p.id === id);
  if (!existing) return fail(`Unknown provider ${id}.`);
  if (existing.source !== "user") return fail(`${existing.name} is ${existing.source === "builtin" ? "built in; disable it instead" : "defined in config.yaml"}.`);
  snap.state.providers = snap.state.providers.filter((raw) => String(raw.id || "").toLowerCase() !== id);
  snap.state.disabled = snap.state.disabled.filter((d) => d !== id);
  snap.state.presets = snap.state.presets.filter((raw) => String(raw.provider || "").toLowerCase() !== id);
  if (snap.state.defaultProvider === id) delete snap.state.defaultProvider;
  if (!writeState(snap.state)) return fail("Could not save the provider list.");
  return { ok: true };
}

export function setProviderEnabled(id: string, enabled: boolean): OpResult {
  const snap = snapshot();
  if (!snap.providers.some((p) => p.id === id)) return fail(`Unknown provider ${id}.`);
  const others = snap.state.disabled.filter((d) => d !== id);
  snap.state.disabled = enabled ? others : others.concat(id);
  return writeState(snap.state) ? { ok: true } : fail("Could not save the provider list.");
}

export function setDefaultProvider(id: string): OpResult {
  const snap = snapshot();
  if (!snap.providers.some((p) => p.id === id && p.enabled)) return fail(`Unknown or disabled provider ${id}.`);
  snap.state.defaultProvider = id;
  return writeState(snap.state) ? { ok: true } : fail("Could not save the provider list.");
}

export function setProviderKey(id: string, key: unknown): OpResult {
  const snap = snapshot();
  const p = snap.providers.find((x) => x.id === id);
  if (!p) return fail(`Unknown provider ${id}.`);
  const value = typeof key === "string" ? key.trim() : "";
  if (!value) return fail("Paste a key first.");
  if (/\s/.test(value)) return fail("A key cannot contain spaces or line breaks.");
  if (!setKey(p.apiKeySecret, value)) return fail("The plugin secret store is unavailable (grant the secrets permission).");
  for (const other of snap.providers) if (other.apiKeySecret === p.apiKeySecret) invalidateModels(other.id);
  return { ok: true };
}

export function clearProviderKey(id: string): OpResult {
  const snap = snapshot();
  const p = snap.providers.find((x) => x.id === id);
  if (!p) return fail(`Unknown provider ${id}.`);
  deleteKey(p.apiKeySecret);
  for (const other of snap.providers) if (other.apiKeySecret === p.apiKeySecret) invalidateModels(other.id);
  return { ok: true };
}

export function testProvider(id: string): OpResult<{ provider: ProviderView }> {
  const snap = snapshot();
  const p = snap.providers.find((x) => x.id === id);
  if (!p) return fail(`Unknown provider ${id}.`);
  discoverModels(p, { force: true });
  return { ok: true, provider: providerView(p, snap.defaultProvider) };
}

function modelView(m: RouterModel): ModelView {
  const view: ModelView = {
    id: qualifyModel(m.providerId, m.id),
    model: m.id,
    displayName: m.displayName,
    providerId: m.providerId,
    badges: capabilityBadges(m.capabilities),
  };
  if (m.loaded !== undefined) view.loaded = m.loaded;
  return view;
}

/** Enabled providers' models, discovered (or cached) and grouped; `query` filters across all sections. */
export function modelSections(opts: { provider?: string; query?: string; refresh?: boolean }): SectionView[] {
  const snap = snapshot();
  const targets = snap.providers.filter((p) => p.enabled && (!opts.provider || p.id === opts.provider));
  const all: RouterModel[] = [];
  const statuses: Record<string, ProviderStatus> = {};
  for (const p of targets) {
    const entry = discoverModels(p, { force: !!opts.refresh });
    all.push(...entry.models);
    statuses[p.id] = statusFromEntry(p, entry);
  }
  return groupAndSearch(targets, all, opts.query || "").map((s) => ({
    providerId: s.provider.id,
    providerName: s.provider.name,
    kind: s.provider.kind,
    total: s.total,
    models: s.models.map(modelView),
    status: statuses[s.provider.id],
  }));
}

export function listPresetViews(): RouterPreset[] {
  return snapshot().presets;
}

export function savePreset(input: PresetInput, opts?: { replace?: boolean }): OpResult<{ preset: RouterPreset }> {
  const snap = snapshot();
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const existing = snap.presets.find((p) => p.id === id);
  if (existing && existing.source !== "user") return fail(`Preset ${id} is defined in config.yaml; edit it there.`);
  if (existing && !opts?.replace) return fail(`A preset named ${id} already exists.`, [{ field: "id", message: `A preset named ${id} already exists.` }]);
  const taken = snap.presets.filter((p) => p.id !== id).map((p) => p.id);
  const result = validatePreset(input, taken);
  if (!result.ok) return fail(result.errors.map((e) => e.message).join(" "), result.errors);
  const preset = result.value;
  if (preset.provider && !snap.providers.some((p) => p.id === preset.provider)) {
    return fail(`Unknown provider ${preset.provider}.`, [{ field: "provider", message: `Unknown provider ${preset.provider}.` }]);
  }
  const { source: _source, ...stored } = preset;
  void _source;
  snap.state.presets = snap.state.presets.filter((raw) => raw.id !== id).concat(stored as PresetInput);
  if (!writeState(snap.state)) return fail("Could not save presets.");
  return { ok: true, preset };
}

export function removePreset(id: string): OpResult {
  const snap = snapshot();
  const existing = snap.presets.find((p) => p.id === id);
  if (!existing) return fail(`Unknown preset ${id}.`);
  if (existing.source !== "user") return fail(`Preset ${id} is defined in config.yaml.`);
  snap.state.presets = snap.state.presets.filter((raw) => raw.id !== id);
  return writeState(snap.state) ? { ok: true } : fail("Could not save presets.");
}
