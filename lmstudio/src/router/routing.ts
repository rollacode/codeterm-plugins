import { LMSTUDIO_PROVIDER_ID } from "./config";
import type { ProviderConfig, RouterPreset } from "./types";

export const MODEL_SEPARATOR = "::";

/** The lmstudio provider owns the bare namespace so pre-router model ids keep resolving. */
export function qualifyModel(providerId: string, model: string): string {
  if (!model) return "";
  return providerId === LMSTUDIO_PROVIDER_ID ? model : `${providerId}${MODEL_SEPARATOR}${model}`;
}

export function splitModelId(raw: string): { providerId: string | null; model: string } {
  const value = raw.trim();
  const at = value.indexOf(MODEL_SEPARATOR);
  if (at <= 0) return { providerId: null, model: value };
  return { providerId: value.slice(0, at).toLowerCase(), model: value.slice(at + MODEL_SEPARATOR.length) };
}

export interface ModelTarget {
  provider: ProviderConfig | null;
  model: string;
  error?: string;
}

function bareProvider(providers: ProviderConfig[], defaultProvider: string): ProviderConfig | null {
  return (
    providers.find((p) => p.id === LMSTUDIO_PROVIDER_ID && p.enabled) ||
    providers.find((p) => p.id === defaultProvider && p.enabled) ||
    providers.find((p) => p.enabled) ||
    null
  );
}

export function resolveModelTarget(
  raw: string,
  providers: ProviderConfig[],
  defaultProvider: string,
  presetProvider?: string,
): ModelTarget {
  const { providerId, model } = splitModelId(raw);
  if (providerId) {
    const provider = providers.find((p) => p.id === providerId) || null;
    if (!provider) return { provider: null, model, error: `unknown provider "${providerId}"` };
    if (!provider.enabled) return { provider: null, model, error: `provider "${providerId}" is disabled` };
    return { provider, model };
  }
  if (presetProvider) {
    const provider = providers.find((p) => p.id === presetProvider) || null;
    if (!provider) return { provider: null, model, error: `unknown provider "${presetProvider}"` };
    if (!provider.enabled) return { provider: null, model, error: `provider "${presetProvider}" is disabled` };
    return { provider, model };
  }
  const provider = bareProvider(providers, defaultProvider);
  return provider ? { provider, model } : { provider: null, model, error: "no enabled provider" };
}

/** A preset's model as a routable id: `provider` + bare `model`, or an already-qualified model. */
export function presetModelId(preset: Pick<RouterPreset, "provider" | "model">): string {
  const model = (preset.model || "").trim();
  if (!model) return "";
  if (splitModelId(model).providerId) return model;
  return preset.provider ? qualifyModel(preset.provider, model) : model;
}

/** Generic preset knobs mapped onto each wire format. */
export function presetParams(preset: RouterPreset | null): Record<string, unknown> {
  if (!preset) return {};
  const params: Record<string, unknown> = { ...(preset.params || {}) };
  if (preset.temperature !== undefined) params.temperature = preset.temperature;
  if (preset.maxTokens !== undefined) params.max_tokens = preset.maxTokens;
  return params;
}

export interface RouteRequest {
  raw: string;
  presetProvider?: string;
}

/** Re-resolves a live session against the current registry; an auto-picked model survives while its provider does. */
export function reroute(
  req: RouteRequest,
  current: { providerId: string | null; model: string },
  providers: ProviderConfig[],
  defaultProvider: string,
): ModelTarget {
  const target = resolveModelTarget(req.raw, providers, defaultProvider, req.raw ? undefined : req.presetProvider);
  if (!target.provider || target.model) return target;
  return { provider: target.provider, model: current.providerId === target.provider.id ? current.model : "" };
}
