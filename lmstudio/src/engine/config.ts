import { apiRoot } from "../router/config";
import { splitModelId } from "../router/routing";
import type { ProviderConfig, RouterModel } from "../router/types";

/** OpenCode release whose routes, config keys and event shapes this engine was verified against. */
export const OPENCODE_VERSION = "1.18.34";
export const OC_PROVIDER_PREFIX = "router-";
export const DEFAULT_CONTEXT = 128000;
export const DEFAULT_OUTPUT = 8192;

export interface CompactionSettings {
  thresholdPct: number;
  model: string | null;
  keepTurns: number;
}

export const COMPACTION_DEFAULTS: CompactionSettings = { thresholdPct: 70, model: null, keepTurns: 6 };

function intIn(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : undefined;
}

/** Reads `compactThreshold` (% of the model window), `compactModel`, `compactKeepTurns`; anything invalid falls back to the default. */
export function compactionSettings(raw: Record<string, unknown> | null | undefined): CompactionSettings {
  const src = raw || {};
  const model = typeof src.compactModel === "string" && src.compactModel.trim() ? src.compactModel.trim() : null;
  return {
    thresholdPct: intIn(src.compactThreshold, 10, 95) ?? COMPACTION_DEFAULTS.thresholdPct,
    model,
    keepTurns: intIn(src.compactKeepTurns, 0, 50) ?? COMPACTION_DEFAULTS.keepTurns,
  };
}

export function ocProviderId(routerProviderId: string): string {
  return OC_PROVIDER_PREFIX + routerProviderId;
}

export interface OcModelRef {
  providerID: string;
  modelID: string;
}

export function ocModelRef(providerId: string, model: string): OcModelRef {
  return { providerID: ocProviderId(providerId), modelID: model };
}

/** `provider::model` (or a bare LM Studio id) as OpenCode's `providerID/modelID` string. */
export function ocModelString(qualified: string, defaultProvider: string): string | null {
  const split = splitModelId(qualified);
  const provider = split.providerId || defaultProvider;
  if (!provider || !split.model) return null;
  return `${ocProviderId(provider)}/${split.model}`;
}

export function keyEnvName(routerProviderId: string): string {
  return `ROUTER_KEY_${routerProviderId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export interface EngineProvider {
  provider: ProviderConfig;
  models: RouterModel[];
  /** Model ids sessions are using; declared even when the catalogue does not list them. */
  extraModels: string[];
  hasKey: boolean;
}

type Json = Record<string, unknown>;

function npmFor(kind: ProviderConfig["kind"]): string {
  return kind === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible";
}

function baseUrlFor(provider: ProviderConfig): string {
  const root = apiRoot(provider);
  return provider.kind === "lmstudio" ? `${root}/v1` : root;
}

function modelEntry(model: RouterModel | null, id: string, thresholdPct: number): Json {
  const context = model && model.capabilities.contextLength ? model.capabilities.contextLength : DEFAULT_CONTEXT;
  const output = Math.min(DEFAULT_OUTPUT, Math.max(1024, Math.floor(context / 4)));
  const entry: Json = {
    name: model ? model.displayName : id,
    tool_call: true,
    // OpenCode compacts once a turn's tokens reach `limit.input - compaction.reserved`; reserved is 0, so input is the threshold.
    limit: { context, input: Math.floor((context * thresholdPct) / 100), output },
  };
  if (model && model.capabilities.reasoning) entry.reasoning = true;
  if (model && model.capabilities.vision) entry.attachment = true;
  return entry;
}

function providerEntry(ep: EngineProvider, thresholdPct: number): Json {
  const models: Json = {};
  for (const m of ep.models) models[m.id] = modelEntry(m, m.id, thresholdPct);
  for (const id of ep.extraModels) if (!models[id]) models[id] = modelEntry(null, id, thresholdPct);
  const options: Json = { baseURL: baseUrlFor(ep.provider) };
  // The key reaches OpenCode only through its process env; the config names the variable.
  if (ep.hasKey) options.apiKey = `{env:${keyEnvName(ep.provider.id)}}`;
  return { npm: npmFor(ep.provider.kind), name: ep.provider.name, options, models };
}

/** Rules that apply to every session; `ask` would wait for an approval UI that does not exist, so nothing asks. */
export function basePermission(): Json {
  return {
    "*": "allow",
    external_directory: "deny",
    doom_loop: "deny",
    question: "deny",
    read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
  };
}

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: "allow" | "deny";
}

/** Session ruleset (`POST /session`): confinement to the session directory, and no shell when shell is off. */
export function sessionPermission(shell: boolean): PermissionRule[] {
  const rules: PermissionRule[] = [
    { permission: "external_directory", pattern: "*", action: "deny" },
    { permission: "doom_loop", pattern: "*", action: "deny" },
    { permission: "question", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*.env", action: "deny" },
    { permission: "read", pattern: "*.env.*", action: "deny" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
  ];
  if (!shell) rules.push({ permission: "bash", pattern: "*", action: "deny" });
  return rules;
}

export interface EngineConfigInput {
  providers: EngineProvider[];
  compaction: CompactionSettings;
  defaultProvider: string;
}

export function buildEngineConfig(input: EngineConfigInput): Json {
  const provider: Json = {};
  const enabled: string[] = [];
  for (const ep of input.providers) {
    const id = ocProviderId(ep.provider.id);
    provider[id] = providerEntry(ep, input.compaction.thresholdPct);
    enabled.push(id);
  }
  const config: Json = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    enabled_providers: enabled,
    provider,
    permission: basePermission(),
    compaction: { auto: true, reserved: 0, tail_turns: input.compaction.keepTurns },
  };
  const summarizer = input.compaction.model ? ocModelString(input.compaction.model, input.defaultProvider) : null;
  if (summarizer && enabled.indexOf(summarizer.split("/")[0]) >= 0) config.agent = { compaction: { model: summarizer } };
  return config;
}

/** Env for the engine process: keys by variable name only, never in argv or the config text. */
export function engineKeyEnv(providers: { provider: ProviderConfig; key: string | null }[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const p of providers) if (p.key) env[keyEnvName(p.provider.id)] = p.key;
  return env;
}

/** Stable text for change detection: config plus a hash of the keys, so a rotated key restarts the engine. */
export function configFingerprint(configJson: string, keys: Record<string, string>, md5: (s: string) => string): string {
  const names = Object.keys(keys).sort();
  return md5(`${configJson}\n${names.map((n) => `${n}=${md5(keys[n])}`).join("\n")}`);
}
