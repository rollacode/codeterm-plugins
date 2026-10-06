import type { Overview, ProviderView, SectionView, PresetView } from "./logic";

declare global {
  interface Window {
    ct?: { invoke(method: string, args?: unknown): Promise<unknown>; close?(): void };
  }
}

export interface Fail {
  ok: false;
  error: string;
  fieldErrors?: { field: string; message: string }[];
}

export type Result<T = unknown> = ({ ok: true } & T) | Fail;

async function call<T>(method: string, args?: unknown): Promise<T> {
  const ct = window.ct;
  if (!ct) throw new Error("CodeTerm bridge is unavailable");
  return (await ct.invoke(method, args)) as T;
}

export const api = {
  overview: () => call<Overview>("overview"),
  models: (args: { provider?: string; query?: string; refresh?: boolean }) => call<{ sections: SectionView[] }>("models", args),
  addProvider: (provider: Record<string, unknown>) => call<Result<{ provider: ProviderView }>>("addProvider", { provider }),
  updateProvider: (id: string, provider: Record<string, unknown>) => call<Result<{ provider: ProviderView }>>("updateProvider", { id, provider }),
  removeProvider: (id: string) => call<Result>("removeProvider", { id }),
  setProviderEnabled: (id: string, enabled: boolean) => call<Result>("setProviderEnabled", { id, enabled }),
  setDefaultProvider: (id: string) => call<Result>("setDefaultProvider", { id }),
  setProviderKey: (id: string, key: string) => call<Result>("setProviderKey", { id, key }),
  clearProviderKey: (id: string) => call<Result>("clearProviderKey", { id }),
  testProvider: (id: string) => call<Result<{ provider: ProviderView }>>("testProvider", { id }),
  savePreset: (preset: Record<string, unknown>, replace: boolean) => call<Result<{ preset: PresetView }>>("savePreset", { preset, replace }),
  removePreset: (id: string) => call<Result>("removePreset", { id }),
};
