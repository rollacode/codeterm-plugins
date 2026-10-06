import { KEY_SLOTS, PROVIDER_KINDS_INFO, PROVIDER_TEMPLATES } from "./config";
import {
  addProvider,
  clearProviderKey,
  listPresetViews,
  listProviders,
  modelSections,
  removePreset,
  removeProvider,
  savePreset,
  setDefaultProvider,
  setProviderEnabled,
  setProviderKey,
  testProvider,
  updateProvider,
} from "./manage";
import { allowHostCommand, keyCommand } from "./verbs";

type Args = Record<string, unknown>;

function s(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Iframe bridge. Keys flow in through `setProviderKey` only and are never returned. */
export function viewCall(method: string, raw: unknown): unknown {
  const args: Args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Args) : {};
  switch (method) {
    case "overview": {
      const { providers, defaultProvider, issues } = listProviders();
      return {
        providers,
        defaultProvider,
        issues,
        presets: listPresetViews(),
        kinds: PROVIDER_KINDS_INFO,
        templates: PROVIDER_TEMPLATES,
        keySlots: KEY_SLOTS,
        commands: Object.fromEntries(providers.map((p) => [p.id, { key: keyCommand(p.apiKeySecret), allowHost: allowHostCommand(p.host) }])),
      };
    }
    case "models":
      return { sections: modelSections({ provider: s(args.provider) || undefined, query: s(args.query), refresh: args.refresh === true }) };
    case "addProvider":
      return addProvider((args.provider || {}) as Args);
    case "updateProvider":
      return updateProvider(s(args.id), (args.provider || {}) as Args);
    case "removeProvider":
      return removeProvider(s(args.id));
    case "setProviderEnabled":
      return setProviderEnabled(s(args.id), args.enabled !== false);
    case "setDefaultProvider":
      return setDefaultProvider(s(args.id));
    case "setProviderKey":
      return setProviderKey(s(args.id), args.key);
    case "clearProviderKey":
      return clearProviderKey(s(args.id));
    case "testProvider":
      return testProvider(s(args.id));
    case "savePreset":
      return savePreset((args.preset || {}) as Args, { replace: args.replace === true });
    case "removePreset":
      return removePreset(s(args.id));
    default:
      return { ok: false, error: `unknown view method ${method}` };
  }
}
