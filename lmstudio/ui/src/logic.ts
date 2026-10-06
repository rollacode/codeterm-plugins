import { matchScore } from "../../src/router/models";
import type { RouterModel } from "../../src/router/types";

export type ProviderState = "connected" | "key_missing" | "unreachable" | "auth" | "denied" | "error" | "disabled" | "unchecked";
export type Tone = "ok" | "warn" | "danger" | "muted";

export interface ProviderStatus {
  state: ProviderState;
  message: string;
  modelCount: number;
  checkedAt: number | null;
}

export interface ProviderView {
  id: string;
  name: string;
  kind: "openai" | "anthropic" | "lmstudio";
  baseUrl: string;
  host: string;
  apiKeySecret: string;
  models: string[];
  keySlotDeclared: boolean;
  hasKey: boolean;
  enabled: boolean;
  source: "builtin" | "config" | "user";
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
  kind: ProviderView["kind"];
  total: number;
  models: ModelView[];
  status: ProviderStatus;
}

export interface PresetView {
  id: string;
  name: string;
  description?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  source: "builtin" | "config" | "user";
}

export interface Template {
  id: string;
  name: string;
  kind: ProviderView["kind"];
  baseUrl: string;
}

export interface Overview {
  providers: ProviderView[];
  defaultProvider: string;
  issues: string[];
  presets: PresetView[];
  kinds: { kind: ProviderView["kind"]; label: string; hint: string }[];
  templates: Template[];
  keySlots: string[];
  commands: Record<string, { key: string; allowHost: string }>;
}

const STATUS: Record<ProviderState, { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "ok" },
  key_missing: { label: "Key missing", tone: "warn" },
  unreachable: { label: "Unreachable", tone: "danger" },
  auth: { label: "Key rejected", tone: "danger" },
  denied: { label: "Host not allowed", tone: "warn" },
  error: { label: "Error", tone: "danger" },
  disabled: { label: "Disabled", tone: "muted" },
  unchecked: { label: "Not tested", tone: "muted" },
};

export function statusLabel(state: ProviderState): string {
  return (STATUS[state] || STATUS.error).label;
}

export function statusTone(state: ProviderState): Tone {
  return (STATUS[state] || STATUS.error).tone;
}

export function kindLabel(kind: ProviderView["kind"]): string {
  return kind === "openai" ? "OpenAI-compatible" : kind === "anthropic" ? "Anthropic" : "LM Studio";
}

function asRouterModel(m: ModelView): RouterModel {
  const caps: RouterModel["capabilities"] = {};
  for (const b of m.badges) {
    if (b === "vision") caps.vision = true;
    else if (b === "tools") caps.tools = true;
    else if (b === "reasoning") caps.reasoning = true;
  }
  return { providerId: m.providerId, id: m.model, displayName: m.displayName, capabilities: caps };
}

/** Client-side filter with the same ranking the agent `models` verb uses; badges stay searchable. */
export function filterSections(sections: SectionView[], query: string): SectionView[] {
  const q = query.trim();
  if (!q) return sections;
  return sections.map((s) => {
    const ranked = s.models
      .map((m, i) => ({ m, i, score: matchScore(asRouterModel(m), s.providerName, q) || (m.badges.some((b) => q.toLowerCase().split(/\s+/).every((t) => b.toLowerCase().includes(t))) ? 1 : 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.m);
    return { ...s, models: ranked };
  });
}

export function flatten(sections: SectionView[]): ModelView[] {
  const out: ModelView[] = [];
  for (const s of sections) out.push(...s.models);
  return out;
}

export interface PickerState {
  open: boolean;
  query: string;
  active: number;
  selected: string;
}

export type PickerAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "query"; query: string }
  | { type: "move"; delta: number; count: number }
  | { type: "home" }
  | { type: "end"; count: number }
  | { type: "hover"; index: number }
  | { type: "choose"; id: string };

export function pickerInit(selected: string): PickerState {
  return { open: false, query: "", active: 0, selected };
}

export function pickerReducer(state: PickerState, action: PickerAction): PickerState {
  switch (action.type) {
    case "open":
      return { ...state, open: true, active: 0 };
    case "close":
      return { ...state, open: false, query: "" };
    case "query":
      return { ...state, open: true, query: action.query, active: 0 };
    case "move": {
      if (action.count <= 0) return { ...state, open: true, active: 0 };
      if (!state.open) return { ...state, open: true, active: 0 };
      const next = (state.active + action.delta + action.count) % action.count;
      return { ...state, active: next };
    }
    case "home":
      return { ...state, active: 0 };
    case "end":
      return { ...state, active: Math.max(0, action.count - 1) };
    case "hover":
      return { ...state, active: action.index };
    case "choose":
      return { ...state, open: false, query: "", selected: action.id };
    default:
      return state;
  }
}

/** Maps a key press to a picker action; null leaves the event to the browser. */
export function pickerKey(key: string, state: PickerState, visible: ModelView[]): PickerAction | null {
  const count = visible.length;
  if (key === "ArrowDown") return { type: "move", delta: 1, count };
  if (key === "ArrowUp") return { type: "move", delta: -1, count };
  if (!state.open) return null;
  if (key === "Home") return { type: "home" };
  if (key === "End") return { type: "end", count };
  if (key === "Escape") return { type: "close" };
  if (key === "Enter") {
    const pick = visible[state.active];
    return pick ? { type: "choose", id: pick.id } : null;
  }
  return null;
}

export interface ProviderDraft {
  id: string;
  name: string;
  kind: ProviderView["kind"];
  baseUrl: string;
  apiKeySecret: string;
  models: string;
}

export function draftFromTemplate(t: Template, taken: string[]): ProviderDraft {
  let id = t.id;
  for (let n = 2; taken.includes(id); n += 1) id = `${t.id}-${n}`;
  return { id, name: t.name, kind: t.kind, baseUrl: t.baseUrl, apiKeySecret: "", models: "" };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export interface PresetDraft {
  id: string;
  name: string;
  model: string;
  temperature: string;
  maxTokens: string;
  systemPrompt: string;
}

export function presetDraft(p?: PresetView): PresetDraft {
  if (!p) return { id: "", name: "", model: "", temperature: "", maxTokens: "", systemPrompt: "" };
  const model = p.model ? (p.provider && !p.model.includes("::") && p.provider !== "lmstudio" ? `${p.provider}::${p.model}` : p.model) : "";
  return {
    id: p.id,
    name: p.name,
    model,
    temperature: p.temperature === undefined ? "" : String(p.temperature),
    maxTokens: p.maxTokens === undefined ? "" : String(p.maxTokens),
    systemPrompt: p.systemPrompt || "",
  };
}

/** Splits `provider::model` back into the preset wire shape; bare ids belong to LM Studio. */
export function presetPayload(d: PresetDraft): Record<string, unknown> {
  const at = d.model.indexOf("::");
  const payload: Record<string, unknown> = { id: d.id.trim(), name: d.name.trim() || d.id.trim() };
  if (at > 0) {
    payload.provider = d.model.slice(0, at);
    payload.model = d.model.slice(at + 2);
  } else if (d.model.trim()) {
    payload.provider = "lmstudio";
    payload.model = d.model.trim();
  }
  if (d.temperature.trim()) payload.temperature = d.temperature.trim();
  if (d.maxTokens.trim()) payload.maxTokens = d.maxTokens.trim();
  if (d.systemPrompt.trim()) payload.systemPrompt = d.systemPrompt;
  return payload;
}

export function relativeTime(at: number | null, now: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
