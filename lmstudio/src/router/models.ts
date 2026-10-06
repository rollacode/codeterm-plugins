import type { ModelCapabilities, ProviderConfig, RouterModel } from "./types";

type Row = Record<string, unknown>;

function rows(body: unknown): Row[] {
  if (Array.isArray(body)) return body.filter((r): r is Row => !!r && typeof r === "object");
  if (!body || typeof body !== "object") return [];
  const obj = body as Row;
  for (const key of ["data", "models"]) {
    const list = obj[key];
    if (Array.isArray(list)) return list.filter((r): r is Row => !!r && typeof r === "object");
  }
  return [];
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()) : [];
}

function capabilities(row: Row): ModelCapabilities {
  const caps: ModelCapabilities = {};
  const topProvider = row.top_provider && typeof row.top_provider === "object" ? (row.top_provider as Row) : {};
  const ctx =
    num(row.context_length) ??
    num(row.context_window) ??
    num(row.max_context_length) ??
    num(row.max_input_tokens) ??
    num(topProvider.context_length);
  if (ctx) caps.contextLength = ctx;

  const arch = row.architecture && typeof row.architecture === "object" ? (row.architecture as Row) : {};
  const inputModalities = strList(arch.input_modalities).concat(strList(row.input_modalities), strList(row.modalities));
  const capObj = row.capabilities && typeof row.capabilities === "object" && !Array.isArray(row.capabilities) ? (row.capabilities as Row) : null;
  const capList = strList(row.capabilities);
  const params = strList(row.supported_parameters);

  if (
    inputModalities.includes("image") ||
    row.type === "vlm" ||
    row.vision === true ||
    (capObj && (capObj.vision === true || capObj.image_input === true)) ||
    capList.includes("vision")
  ) caps.vision = true;

  if (
    params.includes("tools") ||
    params.includes("tool_choice") ||
    capList.includes("tool_use") ||
    capList.includes("tools") ||
    row.trained_for_tool_use === true ||
    (capObj && (capObj.function_calling === true || capObj.tool_use === true || capObj.tools === true))
  ) caps.tools = true;

  if (params.includes("reasoning") || params.includes("include_reasoning") || capList.includes("reasoning") || (capObj && (capObj.reasoning === true || capObj.thinking === true))) {
    caps.reasoning = true;
  }
  return caps;
}

function isEmbedding(row: Row, id: string): boolean {
  return row.type === "embeddings" || row.type === "embedding" || /(^|[-_/])embed/i.test(id);
}

/** Tolerates OpenAI {data:[{id}]}, Anthropic {data:[{id,display_name}]}, LM Studio v0 {data:[{id,state,type}]} and v1 {models:[{key,display_name,loaded_instances}]}. */
export function parseModelList(providerId: string, body: unknown): RouterModel[] {
  const out: RouterModel[] = [];
  const seen = new Set<string>();
  for (const row of rows(body)) {
    const id = typeof row.id === "string" ? row.id : typeof row.key === "string" ? row.key : "";
    if (!id || seen.has(id) || isEmbedding(row, id)) continue;
    seen.add(id);
    const displayName =
      typeof row.display_name === "string" && row.display_name.trim()
        ? row.display_name.trim()
        : typeof row.name === "string" && row.name.trim()
          ? row.name.trim()
          : id;
    const model: RouterModel = { providerId, id, displayName, capabilities: capabilities(row) };
    if (row.state === "loaded" || (Array.isArray(row.loaded_instances) && row.loaded_instances.length > 0)) model.loaded = true;
    else if (row.state === "not-loaded" || Array.isArray(row.loaded_instances)) model.loaded = false;
    out.push(model);
  }
  return out;
}

export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

export function capabilityBadges(caps: ModelCapabilities): string[] {
  const out: string[] = [];
  if (caps.contextLength) out.push(formatContext(caps.contextLength));
  if (caps.vision) out.push("vision");
  if (caps.tools) out.push("tools");
  if (caps.reasoning) out.push("reasoning");
  return out;
}

function fold(s: string): string {
  return s.toLowerCase();
}

/** 0 = no match; higher ranks first. Every whitespace token must match somewhere. */
export function matchScore(model: RouterModel, providerName: string, query: string): number {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return 1;
  const id = fold(model.id);
  const name = fold(model.displayName);
  const hay = `${id} ${name} ${fold(providerName)} ${fold(model.providerId)} ${capabilityBadges(model.capabilities).join(" ")}`;
  let score = 0;
  for (const t of tokens) {
    if (!hay.includes(t)) return 0;
    if (id === t || name === t) score += 100;
    else if (id.startsWith(t) || name.startsWith(t) || id.includes(`/${t}`)) score += 40;
    else if (id.includes(t) || name.includes(t)) score += 20;
    else score += 5;
  }
  return score;
}

export interface ModelSection {
  provider: Pick<ProviderConfig, "id" | "name" | "kind">;
  models: RouterModel[];
  total: number;
}

/** Sections follow provider order; models keep API order unless a query ranks them. */
export function groupAndSearch(
  providers: Pick<ProviderConfig, "id" | "name" | "kind">[],
  models: RouterModel[],
  query: string,
): ModelSection[] {
  const q = query.trim();
  return providers.map((provider) => {
    const own = models.filter((m) => m.providerId === provider.id);
    if (!q) return { provider, models: own, total: own.length };
    const ranked = own
      .map((m, i) => ({ m, i, s: matchScore(m, provider.name, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.m);
    return { provider, models: ranked, total: own.length };
  });
}
