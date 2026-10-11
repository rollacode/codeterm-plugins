import type { Endpoint, Profile } from "./types";
export interface Settings { endpoints: Endpoint[]; profiles: Profile[]; defaultProfile?: string }
export function settings(): Settings {
  const value = JSON.parse(host.settingsJson() || "{}");
  if (!Array.isArray(value.endpoints) || !Array.isArray(value.profiles)) throw new Error("configure endpoints and profiles first");
  for (const group of [value.endpoints, value.profiles]) {
    const ids = new Set();
    for (const item of group) {
      if (!item || typeof item.id !== "string" || !/^[a-z0-9_-]+$/.test(item.id) || ids.has(item.id)) throw new Error("invalid or duplicate config id");
      ids.add(item.id);
    }
  }
  return value;
}
export function resolve(id?: string, model?: string, systemPrompt?: string): { profile: Profile; endpoint: Endpoint } {
  const s = settings();
  const p = s.profiles.find(p => p.id === (id || s.defaultProfile));
  if (!p) throw new Error("unknown profile");
  const profile: Profile = { ...p, model: model || p.model,
    systemPrompt: systemPrompt === undefined ? p.systemPrompt : systemPrompt };
  const endpoint = s.endpoints.find(e => e.id === p.endpoint);
  if (!endpoint || typeof endpoint.baseUrl !== "string" || !Array.isArray(endpoint.models)) throw new Error("unknown or invalid endpoint");
  if (!profile.model || typeof profile.systemPrompt !== "string" || typeof profile.root !== "string"
    || !/^(\/|[A-Za-z]:[\\/])/.test(profile.root) || !Array.isArray(profile.allow) || !Array.isArray(profile.deny)) throw new Error("invalid profile");
  for (const [key, ceiling] of [["tokens", 1000000], ["turns", 100], ["deadlineMs", 3600000]] as const) {
    const budget = profile.budgets?.[key];
    if (!Number.isInteger(budget) || budget <= 0 || budget > ceiling) throw new Error(`invalid ${key} budget`);
  }
  return { profile, endpoint };
}
