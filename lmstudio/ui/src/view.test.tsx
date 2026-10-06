import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  draftFromTemplate,
  filterSections,
  flatten,
  pickerInit,
  pickerKey,
  pickerReducer,
  presetDraft,
  presetPayload,
  relativeTime,
  slugify,
  statusLabel,
  statusTone,
  type Overview,
  type PickerAction,
  type PickerState,
  type ProviderView,
  type SectionView,
} from "./logic";
import { ModelPicker } from "./ModelPicker";
import { ModelsPanel } from "./Models";
import { Segmented } from "./parts";
import { PresetsPanel } from "./Presets";
import { ProvidersPanel } from "./Providers";

const status = (state: ProviderView["status"]["state"], message = "") => ({ state, message, modelCount: 0, checkedAt: null });

const providers: ProviderView[] = [
  { id: "lmstudio", name: "LM Studio", kind: "lmstudio", baseUrl: "http://localhost:1234", host: "localhost:1234", apiKeySecret: "lmstudio_api_key", models: [], keySlotDeclared: true, hasKey: false, enabled: true, source: "builtin", isDefault: true, status: status("connected", "3 models") },
  { id: "mimo", name: "Xiaomi MiMo", kind: "openai", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", host: "token-plan-sgp.xiaomimimo.com", apiKeySecret: "mimo_api_key", models: [], keySlotDeclared: true, hasKey: false, enabled: true, source: "user", isDefault: false, status: status("key_missing", "No API key in slot mimo_api_key.") },
  { id: "claude", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", host: "api.anthropic.com", apiKeySecret: "anthropic_api_key", models: [], keySlotDeclared: true, hasKey: true, enabled: true, source: "user", isDefault: false, status: status("auth", "Key rejected (HTTP 401)") },
];

const overview: Overview = {
  providers,
  defaultProvider: "lmstudio",
  issues: [],
  presets: [
    { id: "codeterm", name: "CodeTerm", source: "config" },
    { id: "fast", name: "Fast", provider: "mimo", model: "mimo-v2.6-flash", temperature: 0.2, maxTokens: 256, source: "user" },
  ],
  kinds: [
    { kind: "openai", label: "OpenAI-compatible", hint: "" },
    { kind: "anthropic", label: "Anthropic Messages", hint: "" },
    { kind: "lmstudio", label: "LM Studio native", hint: "" },
  ],
  templates: [{ id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1" }],
  keySlots: ["mimo_api_key", "custom1_api_key"],
  commands: { mimo: { key: 'printf %s "$API_KEY" | codeterm plugin config lmstudio --secret mimo_api_key', allowHost: "codeterm plugin settings lmstudio --allow-host token-plan-sgp.xiaomimimo.com" } },
};

const sections: SectionView[] = [
  {
    providerId: "lmstudio",
    providerName: "LM Studio",
    kind: "lmstudio",
    total: 2,
    status: status("connected"),
    models: [
      { id: "qwen3-8b", model: "qwen3-8b", displayName: "Qwen3 8B", providerId: "lmstudio", loaded: true, badges: ["33k", "tools"] },
      { id: "gemma-3", model: "gemma-3", displayName: "Gemma 3", providerId: "lmstudio", loaded: false, badges: ["vision"] },
    ],
  },
  {
    providerId: "mimo",
    providerName: "Xiaomi MiMo",
    kind: "openai",
    total: 2,
    status: status("connected"),
    models: [
      { id: "mimo::mimo-v2.6-pro", model: "mimo-v2.6-pro", displayName: "mimo-v2.6-pro", providerId: "mimo", badges: [] },
      { id: "mimo::mimo-v2.6-flash", model: "mimo-v2.6-flash", displayName: "mimo-v2.6-flash", providerId: "mimo", badges: ["262k"] },
    ],
  },
];

function run(state: PickerState, keys: string[], query?: string): { state: PickerState; chosen: string[] } {
  const chosen: string[] = [];
  let s = state;
  if (query !== undefined) s = pickerReducer(s, { type: "query", query });
  for (const key of keys) {
    const visible = flatten(filterSections(sections, s.query));
    const action: PickerAction | null = pickerKey(key, s, visible);
    if (!action) continue;
    if (action.type === "choose") chosen.push(action.id);
    s = pickerReducer(s, action);
  }
  return { state: s, chosen };
}

test("picker opens on ArrowDown, wraps, and Enter chooses the active model", () => {
  const { state, chosen } = run(pickerInit(""), ["ArrowDown", "ArrowUp", "Enter"]);
  assert.deepEqual(chosen, ["mimo::mimo-v2.6-flash"], "ArrowUp from the first option wraps to the last");
  assert.equal(state.open, false);
  assert.equal(state.selected, "mimo::mimo-v2.6-flash");
});

test("typing filters across provider sections and resets the active option", () => {
  const { chosen } = run(pickerInit(""), ["ArrowDown", "Enter"], "flash");
  assert.deepEqual(chosen, ["mimo::mimo-v2.6-flash"]);
  const vision = flatten(filterSections(sections, "vision"));
  assert.deepEqual(vision.map((m) => m.id), ["gemma-3"]);
  const byProvider = filterSections(sections, "xiaomi pro");
  assert.deepEqual(byProvider.map((s) => s.models.map((m) => m.id)), [[], ["mimo::mimo-v2.6-pro"]]);
  assert.deepEqual(flatten(filterSections(sections, "262k")).map((m) => m.id), ["mimo::mimo-v2.6-flash"]);
});

test("Escape closes without choosing; Home/End jump; Enter on no match does nothing", () => {
  let r = run(pickerInit("qwen3-8b"), ["ArrowDown", "End", "Escape"]);
  assert.deepEqual(r.chosen, []);
  assert.equal(r.state.open, false);
  assert.equal(r.state.selected, "qwen3-8b");
  r = run(pickerInit(""), ["ArrowDown", "End", "Home", "Enter"]);
  assert.deepEqual(r.chosen, ["qwen3-8b"]);
  r = run(pickerInit(""), ["Enter"], "zzz");
  assert.deepEqual(r.chosen, []);
  assert.equal(pickerKey("Enter", pickerInit(""), []), null, "closed picker leaves Enter to the form");
});

test("closed picker renders an accessible combobox with its label", () => {
  const html = renderToStaticMarkup(<ModelPicker id="pick" label="Model" sections={sections} value="mimo::mimo-v2.6-pro" onChange={() => {}} />);
  assert.match(html, /<label[^>]*for="pick"[^>]*>Model<\/label>/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="pick-list"/);
  assert.match(html, /placeholder="mimo-v2.6-pro  \(mimo::mimo-v2.6-pro\)"/, "placeholder shows the current selection");
});

test("provider cards expose status, a masked key field for hosted APIs and a test action", () => {
  const html = renderToStaticMarkup(<ProvidersPanel overview={overview} onChanged={() => {}} />);
  assert.equal((html.match(/<article/g) || []).length, 3);
  assert.match(html, /aria-labelledby="prov-mimo-name"/);
  assert.match(html, /Key missing/);
  assert.match(html, /Key rejected/);
  assert.match(html, /<input[^>]*id="key-mimo"[^>]*type="password"/);
  assert.match(html, /<label[^>]*for="key-mimo"[^>]*>API key for Xiaomi MiMo<\/label>/);
  assert.doesNotMatch(html, /id="key-lmstudio"/, "LM Studio needs no key row");
  assert.match(html, /Key stored in slot anthropic_api_key/);
  assert.equal((html.match(/>Test connection</g) || []).length, 3);
  assert.match(html, /--secret mimo_api_key/);
  const cards = html.split("<article").slice(1);
  assert.doesNotMatch(cards[0], />Remove</, "built-in provider has no Remove");
  assert.match(cards[1], />Remove</, "user provider can be removed");
});

test("models panel renders sections as labelled, collapsible regions with a search box", () => {
  const html = renderToStaticMarkup(<ModelsPanel sections={sections} loading={false} onRefresh={() => {}} />);
  assert.match(html, /type="search"/);
  assert.match(html, /<label[^>]*for="model-search"/);
  assert.match(html, /aria-expanded="true"[^>]*aria-controls="models-mimo"/);
  assert.match(html, /4 models from 2 providers/);
  assert.match(html, /mimo::mimo-v2.6-flash/);
  assert.match(html, />loaded</);
  const loading = renderToStaticMarkup(<ModelsPanel sections={null} loading={true} onRefresh={() => {}} />);
  assert.match(loading, /Loading models/);
  const empty = renderToStaticMarkup(<ModelsPanel sections={[]} loading={false} onRefresh={() => {}} />);
  assert.match(empty, /No provider is enabled/);
});

test("presets list marks config presets read-only and names actions per preset", () => {
  const html = renderToStaticMarkup(<PresetsPanel presets={overview.presets} sections={sections} onChanged={() => {}} />);
  assert.match(html, /aria-label="Edit preset Fast"/);
  assert.match(html, /aria-label="Remove preset Fast"/);
  assert.doesNotMatch(html, /Edit preset CodeTerm/);
  assert.match(html, /mimo::mimo-v2.6-flash, temperature 0.2, 256 max tokens/);
});

test("segmented tabs follow the WAI-ARIA tabs pattern", () => {
  const html = renderToStaticMarkup(
    <Segmented idPrefix="rt" value="models" onChange={() => {}} tabs={[{ id: "providers", label: "Providers" }, { id: "models", label: "Models", count: 4 }]} />,
  );
  assert.match(html, /role="tablist"/);
  assert.match(html, /id="rt-tab-models" role="tab" type="button" aria-selected="true" aria-controls="rt-panel-models" tabindex="0"/);
  assert.match(html, /id="rt-tab-providers" role="tab" type="button" aria-selected="false" aria-controls="rt-panel-providers" tabindex="-1"/);
});

test("form helpers: templates avoid id clashes, slugs, preset round-trip, status vocabulary", () => {
  assert.equal(draftFromTemplate(overview.templates[0], ["openrouter", "openrouter-2"]).id, "openrouter-3");
  assert.equal(slugify("Xiaomi MiMo (Anthropic)"), "xiaomi-mimo-anthropic");
  const d = presetDraft(overview.presets[1]);
  assert.equal(d.model, "mimo::mimo-v2.6-flash");
  assert.deepEqual(presetPayload(d), { id: "fast", name: "Fast", provider: "mimo", model: "mimo-v2.6-flash", temperature: "0.2", maxTokens: "256" });
  assert.deepEqual(presetPayload({ ...d, model: "qwen3-8b", temperature: "", maxTokens: "" }), { id: "fast", name: "Fast", provider: "lmstudio", model: "qwen3-8b" });
  assert.equal(statusLabel("denied"), "Host not allowed");
  assert.equal(statusTone("connected"), "ok");
  assert.equal(relativeTime(1000, 1000 + 125_000), "2 min ago");
});
