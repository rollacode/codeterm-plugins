import { useState } from "react";
import { api, type Fail } from "./api";
import { ModelPicker } from "./ModelPicker";
import { presetDraft, presetPayload, type PresetDraft, type PresetView, type SectionView } from "./logic";
import { Field, fieldError, Spinner } from "./parts";

function PresetEditor({ preset, sections, onDone }: { preset: PresetView | null; sections: SectionView[]; onDone: (changed: boolean) => void }) {
  const [draft, setDraft] = useState<PresetDraft>(presetDraft(preset || undefined));
  const [fail, setFail] = useState<Fail | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<PresetDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const err = (f: string) => fieldError(fail?.fieldErrors, f);

  const submit = async () => {
    setBusy(true);
    const res = await api.savePreset(presetPayload(draft), !!preset);
    setBusy(false);
    if (!res.ok) return setFail(res);
    onDone(true);
  };

  return (
    <form
      className="rt-panel rt-form"
      aria-labelledby="preset-form-title"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 id="preset-form-title">{preset ? `Edit ${preset.name}` : "New preset"}</h3>
      <div className="rt-grid2">
        <Field id="ps-name" label="Name" error={err("name")}>
          <input id="ps-name" className="rt-input" value={draft.name} placeholder="Fast reviewer" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field id="ps-id" label="Id" error={err("id")}>
          <input id="ps-id" className="rt-input rt-mono" value={draft.id} disabled={!!preset} placeholder="fast-review" onChange={(e) => set({ id: e.target.value })} />
        </Field>
      </div>
      <ModelPicker id="ps-model" label="Model" sections={sections} value={draft.model} onChange={(model) => set({ model })} placeholder="Any model (uses the default provider)" />
      {err("provider") && (
        <div className="rt-field-error" role="alert">
          {err("provider")}
        </div>
      )}
      <div className="rt-grid2">
        <Field id="ps-temp" label="Temperature" hint="0 to 2; blank keeps the model default" error={err("temperature")}>
          <input id="ps-temp" className="rt-input" inputMode="decimal" value={draft.temperature} placeholder="0.7" onChange={(e) => set({ temperature: e.target.value })} />
        </Field>
        <Field id="ps-max" label="Max tokens" hint="Blank keeps the provider default" error={err("maxTokens")}>
          <input id="ps-max" className="rt-input" inputMode="numeric" value={draft.maxTokens} placeholder="4096" onChange={(e) => set({ maxTokens: e.target.value })} />
        </Field>
      </div>
      <Field id="ps-system" label="System prompt" hint="Blank uses the default preset's prompt.">
        <textarea id="ps-system" className="rt-input rt-textarea" rows={6} value={draft.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} />
      </Field>
      {fail && !fail.fieldErrors && (
        <p className="rt-field-error" role="alert">
          {fail.error}
        </p>
      )}
      <div className="rt-form-actions">
        <button type="submit" className="rt-btn rt-btn-primary" disabled={busy || !draft.id.trim()}>
          {busy ? <Spinner /> : null}Save preset
        </button>
        <button type="button" className="rt-btn rt-btn-ghost" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function describe(p: PresetView): string {
  const model = p.model ? (p.provider && p.provider !== "lmstudio" && !p.model.includes("::") ? `${p.provider}::${p.model}` : p.model) : "any model";
  const knobs = [p.temperature !== undefined ? `temperature ${p.temperature}` : "", p.maxTokens !== undefined ? `${p.maxTokens} max tokens` : ""].filter(Boolean);
  return [model, ...knobs].join(", ");
}

export function PresetsPanel({ presets, sections, onChanged }: { presets: PresetView[]; sections: SectionView[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<{ preset: PresetView | null } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <div className="rt-stack">
      {presets.length === 0 && <div className="rt-empty">No presets yet. A preset pins a model, its temperature, token budget and system prompt.</div>}
      <ul className="rt-presets">
        {presets.map((p) => (
          <li key={p.id} className="rt-preset">
            <div className="rt-preset-main">
              <span className="rt-preset-name">{p.name}</span>
              <span className="rt-dim">{describe(p)}</span>
            </div>
            {p.source === "user" ? (
              <div className="rt-preset-actions">
                <button type="button" className="rt-btn rt-btn-ghost" aria-label={`Edit preset ${p.name}`} onClick={() => setEditing({ preset: p })}>
                  Edit
                </button>
                <button
                  type="button"
                  className="rt-btn rt-btn-ghost rt-btn-danger"
                  aria-label={confirm === p.id ? `Confirm removing preset ${p.name}` : `Remove preset ${p.name}`}
                  onBlur={() => setConfirm(null)}
                  onClick={async () => {
                    if (confirm !== p.id) return setConfirm(p.id);
                    await api.removePreset(p.id);
                    onChanged();
                  }}
                >
                  {confirm === p.id ? "Confirm remove" : "Remove"}
                </button>
              </div>
            ) : (
              <span className="rt-tag">config.yaml</span>
            )}
          </li>
        ))}
      </ul>
      {editing ? (
        <PresetEditor
          key={editing.preset ? editing.preset.id : "new"}
          preset={editing.preset}
          sections={sections}
          onDone={(changed) => {
            setEditing(null);
            if (changed) onChanged();
          }}
        />
      ) : (
        <button type="button" className="rt-add" onClick={() => setEditing({ preset: null })}>
          New preset
        </button>
      )}
    </div>
  );
}
