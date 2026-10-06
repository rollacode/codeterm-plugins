import { hostOf, keyRequired, KEY_SLOTS } from "./config";
import {
  addProvider,
  listPresetViews,
  listProviders,
  modelSections,
  removePreset,
  removeProvider,
  savePreset,
  setDefaultProvider,
  testProvider,
  type ProviderView,
} from "./manage";
import { splitModelId } from "./routing";

export const AGENT_VERBS = [
  "providers",
  "add-provider <id> <openai|anthropic|lmstudio> <baseUrl> [--name NAME] [--key-slot SLOT] [--models id1,id2]",
  "remove-provider <id>",
  "test-provider <id>",
  "set-default <provider>",
  "models [provider] [query] [--refresh]",
  "presets",
  "add-preset <id> <provider::model> [--name NAME] [--temperature N] [--max-tokens N] [--system TEXT]",
  "remove-preset <id>",
];

const PLUGIN_ID = "lmstudio";

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.indexOf("--") === 0 && a.length > 2) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < args.length && args[i + 1].indexOf("--") !== 0) flags[a.slice(2)] = args[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function flag(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function keyCommand(slot: string): string {
  return `printf %s "$API_KEY" | codeterm plugin config ${PLUGIN_ID} --secret ${slot}`;
}

export function allowHostCommand(host: string): string {
  return `codeterm plugin settings ${PLUGIN_ID} --allow-host ${host}`;
}

function nextSteps(p: ProviderView): string[] {
  const steps: string[] = [];
  if (!p.hasKey && keyRequired(p)) {
    steps.push(
      p.keySlotDeclared
        ? `store the key (never in argv history): ${keyCommand(p.apiKeySecret)}`
        : `slot ${p.apiKeySecret} is not declared for --secret; re-add with --key-slot one of ${KEY_SLOTS.join(", ")} or paste the key in the Router view`,
    );
  }
  if (p.status.state !== "connected" && keyRequired(p)) steps.push(`if CodeTerm blocks the host: ${allowHostCommand(hostOf(p.baseUrl))}`);
  return steps;
}

function providerLine(p: ProviderView): string {
  const key = keyRequired(p) || p.hasKey ? ` key=${p.apiKeySecret}:${p.hasKey ? "set" : "unset"}` : "";
  const flags = [p.isDefault ? "default" : "", p.enabled ? "" : "disabled", p.source !== "user" ? p.source : ""].filter(Boolean).join(",");
  return `${p.id}\t${p.kind}\t${p.status.state}\t${p.baseUrl}${key}${flags ? `\t[${flags}]` : ""}`;
}

function err(message: string): { error: string } {
  return { error: message };
}

export function runAgentVerb(verb: string, args: string[]): { result: string } | { error: string } {
  const p = parseArgs(args || []);
  switch (verb) {
    case "providers": {
      const { providers, issues } = listProviders();
      const lines = providers.map(providerLine);
      if (issues.length) lines.push("", "config issues:", ...issues.map((i) => `- ${i}`));
      return { result: lines.join("\n") || "no providers" };
    }
    case "add-provider": {
      const [id, kind, baseUrl] = p.positional;
      if (!id || !kind || !baseUrl) return err(`usage: ${AGENT_VERBS[1]}`);
      const res = addProvider({ id, kind, baseUrl, name: flag(p, "name") || p.positional.slice(3).join(" ") || undefined, apiKeySecret: flag(p, "key-slot"), models: flag(p, "models") });
      if (!res.ok) return err(res.error);
      return { result: [`added ${providerLine(res.provider)}`, ...nextSteps(res.provider)].join("\n") };
    }
    case "remove-provider": {
      const id = p.positional[0];
      if (!id) return err("usage: remove-provider <id>");
      const res = removeProvider(id.toLowerCase());
      return res.ok ? { result: `removed ${id} (its key stays in the secret bucket until cleared)` } : err(res.error);
    }
    case "test-provider": {
      const id = p.positional[0];
      if (!id) return err("usage: test-provider <id>");
      const res = testProvider(id.toLowerCase());
      if (!res.ok) return err(res.error);
      return { result: [`${res.provider.id}: ${res.provider.status.state} — ${res.provider.status.message}`, ...nextSteps(res.provider)].join("\n") };
    }
    case "set-default": {
      const id = p.positional[0];
      if (!id) return err("usage: set-default <provider>");
      const res = setDefaultProvider(id.toLowerCase());
      return res.ok ? { result: `default provider: ${id}` } : err(res.error);
    }
    case "models": {
      const known = listProviders().providers.map((x) => x.id);
      const first = (p.positional[0] || "").toLowerCase();
      const provider = known.includes(first) ? first : undefined;
      const query = (provider ? p.positional.slice(1) : p.positional).join(" ");
      const sections = modelSections({ provider, query, refresh: p.flags.refresh === true });
      const lines: string[] = [];
      for (const s of sections) {
        lines.push(`## ${s.providerName} (${s.providerId}) — ${s.models.length}/${s.total}${s.status.state === "connected" ? "" : ` · ${s.status.state}: ${s.status.message}`}`);
        for (const m of s.models) lines.push(`${m.id}${m.badges.length ? `\t${m.badges.join(" ")}` : ""}${m.loaded ? "\tloaded" : ""}`);
      }
      return { result: lines.join("\n") || "no providers enabled" };
    }
    case "presets": {
      const lines = listPresetViews().map((x) => {
        const knobs = [x.temperature !== undefined ? `t=${x.temperature}` : "", x.maxTokens !== undefined ? `max=${x.maxTokens}` : ""].filter(Boolean).join(" ");
        const model = x.model ? (x.provider && !splitModelId(x.model).providerId ? `${x.provider}::${x.model}` : x.model) : x.provider ? `${x.provider}::(default)` : "(any)";
        return `${x.id}\t${x.name}\t${model}${knobs ? `\t${knobs}` : ""}${x.source !== "user" ? `\t[${x.source}]` : ""}`;
      });
      return { result: lines.join("\n") || "no presets" };
    }
    case "add-preset": {
      const [id, model] = p.positional;
      if (!id) return err(`usage: ${AGENT_VERBS[7]}`);
      const split = splitModelId(model || "");
      const res = savePreset(
        {
          id,
          name: flag(p, "name"),
          provider: split.providerId || flag(p, "provider"),
          model: split.model || undefined,
          temperature: flag(p, "temperature"),
          maxTokens: flag(p, "max-tokens"),
          systemPrompt: flag(p, "system"),
        },
        { replace: p.flags.replace === true },
      );
      return res.ok ? { result: `saved preset ${res.preset.id}` } : err(res.error);
    }
    case "remove-preset": {
      const id = p.positional[0];
      if (!id) return err("usage: remove-preset <id>");
      const res = removePreset(id);
      return res.ok ? { result: `removed preset ${id}` } : err(res.error);
    }
    default:
      return err(`unknown verb "${verb}". Verbs: ${AGENT_VERBS.join(" | ")}`);
  }
}
