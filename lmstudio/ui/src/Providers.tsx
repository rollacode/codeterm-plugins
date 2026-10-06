import { useState } from "react";
import { api, type Fail } from "./api";
import { draftFromTemplate, kindLabel, relativeTime, slugify, type Overview, type ProviderDraft, type ProviderView } from "./logic";
import { Field, fieldError, Spinner, StatusPill } from "./parts";

function KeyRow({ p, onChanged, command }: { p: ProviderView; onChanged: () => void; command?: string }) {
  const [editing, setEditing] = useState(!p.hasKey);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `key-${p.id}`;

  const save = async () => {
    setBusy(true);
    setError(null);
    const res = await api.setProviderKey(p.id, value);
    setBusy(false);
    setValue("");
    if (!res.ok) return setError(res.error);
    setEditing(false);
    onChanged();
  };

  if (!editing && p.hasKey) {
    return (
      <div className="rt-keyrow">
        <span className="rt-key-set">Key stored in slot {p.apiKeySecret}</span>
        <button type="button" className="rt-btn rt-btn-ghost" onClick={() => setEditing(true)}>
          Replace key
        </button>
        <button
          type="button"
          className="rt-btn rt-btn-ghost rt-btn-danger"
          onClick={async () => {
            await api.clearProviderKey(p.id);
            setEditing(true);
            onChanged();
          }}
        >
          Remove key
        </button>
      </div>
    );
  }
  return (
    <form
      className="rt-keyrow"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) void save();
      }}
    >
      <label className="rt-sr" htmlFor={inputId}>
        API key for {p.name}
      </label>
      <input
        id={inputId}
        className="rt-input rt-input-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={`Paste API key (slot ${p.apiKeySecret})`}
        value={value}
        aria-describedby={`${inputId}-hint`}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className="rt-btn rt-btn-primary" disabled={!value.trim() || busy}>
        {busy ? <Spinner /> : null}Save key
      </button>
      {p.hasKey && (
        <button type="button" className="rt-btn rt-btn-ghost" onClick={() => setEditing(false)}>
          Cancel
        </button>
      )}
      <div className="rt-hint rt-keyrow-hint" id={`${inputId}-hint`}>
        {error ? (
          <span role="alert" className="rt-field-error">
            {error}
          </span>
        ) : p.keySlotDeclared && command ? (
          <>
            Stored only in the plugin secret store. From a shell: <code>{command}</code>
          </>
        ) : (
          "Stored only in the plugin secret store."
        )}
      </div>
    </form>
  );
}

function ProviderCard({ p, overview, onChanged, onEdit }: { p: ProviderView; overview: Overview; onChanged: () => void; onEdit: (p: ProviderView) => void }) {
  const [testing, setTesting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const view = p;
  const commands = overview.commands[p.id];
  const needsKey = view.kind !== "lmstudio";

  const test = async () => {
    setTesting(true);
    await api.testProvider(p.id);
    setTesting(false);
    onChanged();
  };

  return (
    <article className="rt-card" data-tone={view.enabled ? undefined : "muted"} data-state={view.status.state} aria-labelledby={`prov-${p.id}-name`}>
      <header className="rt-card-head">
        <div className="rt-card-title">
          <h3 id={`prov-${p.id}-name`}>{view.name}</h3>
          <span className="rt-card-sub">
            {kindLabel(view.kind)}
            {view.isDefault && <span className="rt-tag">default</span>}
            {view.source !== "user" && <span className="rt-tag">{view.source === "builtin" ? "built in" : "config.yaml"}</span>}
          </span>
        </div>
        <StatusPill state={view.status.state} />
      </header>
      <div className="rt-card-url" title={view.baseUrl}>
        {view.baseUrl}
      </div>
      <p className="rt-card-msg" aria-live="polite">
        {testing ? "Testing connection…" : view.status.message}
        {!testing && view.status.checkedAt ? <span className="rt-dim"> · {relativeTime(view.status.checkedAt, Date.now())}</span> : null}
      </p>
      {view.status.state === "denied" && commands && (
        <p className="rt-hint">
          Allow this host once: <code>{commands.allowHost}</code>
        </p>
      )}
      {needsKey && <KeyRow p={view} onChanged={onChanged} command={commands?.key} />}
      <footer className="rt-card-actions">
        <button type="button" className="rt-btn" onClick={test} disabled={testing || !view.enabled} aria-describedby={`prov-${p.id}-name`}>
          {testing ? <Spinner /> : null}Test connection
        </button>
        {!view.isDefault && view.enabled && (
          <button type="button" className="rt-btn rt-btn-ghost" onClick={async () => (await api.setDefaultProvider(p.id), onChanged())}>
            Make default
          </button>
        )}
        <button type="button" className="rt-btn rt-btn-ghost" onClick={async () => (await api.setProviderEnabled(p.id, !view.enabled), onChanged())}>
          {view.enabled ? "Disable" : "Enable"}
        </button>
        {view.source === "user" && (
          <>
            <button type="button" className="rt-btn rt-btn-ghost" onClick={() => onEdit(view)}>
              Edit
            </button>
            <button
              type="button"
              className="rt-btn rt-btn-ghost rt-btn-danger"
              onBlur={() => setConfirmRemove(false)}
              onClick={async () => {
                if (!confirmRemove) return setConfirmRemove(true);
                await api.removeProvider(p.id);
                onChanged();
              }}
            >
              {confirmRemove ? "Confirm remove (and its presets)" : "Remove"}
            </button>
          </>
        )}
      </footer>
    </article>
  );
}

function ProviderForm({ overview, editing, onDone }: { overview: Overview; editing: ProviderView | null; onDone: (changed: boolean) => void }) {
  const taken = overview.providers.map((p) => p.id);
  const [draft, setDraft] = useState<ProviderDraft>(
    editing
      ? { id: editing.id, name: editing.name, kind: editing.kind, baseUrl: editing.baseUrl, apiKeySecret: editing.apiKeySecret, models: editing.models.join(", ") }
      : { id: "", name: "", kind: "openai", baseUrl: "", apiKeySecret: "", models: "" },
  );
  const [idTouched, setIdTouched] = useState(!!editing);
  const [fail, setFail] = useState<Fail | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ProviderDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const kindHint = overview.kinds.find((k) => k.kind === draft.kind)?.hint;

  const submit = async () => {
    setBusy(true);
    const payload: Record<string, unknown> = { id: draft.id, name: draft.name, kind: draft.kind, baseUrl: draft.baseUrl };
    if (draft.apiKeySecret.trim()) payload.apiKeySecret = draft.apiKeySecret.trim();
    payload.models = draft.models;
    const res = editing ? await api.updateProvider(editing.id, payload) : await api.addProvider(payload);
    setBusy(false);
    if (!res.ok) return setFail(res);
    onDone(true);
  };

  return (
    <form
      className="rt-panel rt-form"
      aria-labelledby="prov-form-title"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 id="prov-form-title">{editing ? `Edit ${editing.name}` : "Add a provider"}</h3>
      {!editing && (
        <div className="rt-templates" role="group" aria-label="Start from a known provider">
          {overview.templates.map((t) => (
            <button
              type="button"
              key={t.id}
              className="rt-chip"
              aria-pressed={draft.baseUrl === t.baseUrl}
              onClick={() => {
                setDraft(draftFromTemplate(t, taken));
                setIdTouched(true);
                setFail(null);
              }}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}
      <div className="rt-grid2">
        <Field id="pf-name" label="Name" error={fieldError(fail?.fieldErrors, "name")}>
          <input
            id="pf-name"
            className="rt-input"
            value={draft.name}
            placeholder="Xiaomi MiMo"
            onChange={(e) => set(idTouched ? { name: e.target.value } : { name: e.target.value, id: slugify(e.target.value) })}
          />
        </Field>
        <Field id="pf-id" label="Id" hint="Used in model ids: id::model" error={fieldError(fail?.fieldErrors, "id")}>
          <input
            id="pf-id"
            className="rt-input rt-mono"
            value={draft.id}
            disabled={!!editing}
            placeholder="mimo"
            aria-invalid={!!fieldError(fail?.fieldErrors, "id")}
            onChange={(e) => {
              setIdTouched(true);
              set({ id: e.target.value });
            }}
          />
        </Field>
      </div>
      <Field id="pf-kind" label="API" hint={kindHint} error={fieldError(fail?.fieldErrors, "kind")}>
        <select id="pf-kind" className="rt-input" value={draft.kind} onChange={(e) => set({ kind: e.target.value as ProviderDraft["kind"] })}>
          {overview.kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <Field id="pf-url" label="Base URL" error={fieldError(fail?.fieldErrors, "baseUrl")}>
        <input
          id="pf-url"
          className="rt-input rt-mono"
          value={draft.baseUrl}
          inputMode="url"
          placeholder={draft.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.example.com/v1"}
          aria-invalid={!!fieldError(fail?.fieldErrors, "baseUrl")}
          onChange={(e) => set({ baseUrl: e.target.value })}
        />
      </Field>
      <Field
        id="pf-slot"
        label="Key slot"
        hint={`Defaults to ${draft.id || "id"}_api_key. Slots the CLI accepts: ${overview.keySlots.join(", ")}.`}
        error={fieldError(fail?.fieldErrors, "apiKeySecret")}
      >
        <input id="pf-slot" className="rt-input rt-mono" list="pf-slots" value={draft.apiKeySecret} placeholder={`${draft.id || "id"}_api_key`} onChange={(e) => set({ apiKeySecret: e.target.value })} />
        <datalist id="pf-slots">
          {overview.keySlots.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </Field>
      <Field id="pf-models" label="Model ids (optional)" hint="Comma-separated. Used when the API has no model listing, as some Anthropic-compatible endpoints do.">
        <input id="pf-models" className="rt-input rt-mono" value={draft.models} placeholder="mimo-v2.6-pro, mimo-v2.6-flash" onChange={(e) => set({ models: e.target.value })} />
      </Field>
      {fail && !fail.fieldErrors && (
        <p className="rt-field-error" role="alert">
          {fail.error}
        </p>
      )}
      <div className="rt-form-actions">
        <button type="submit" className="rt-btn rt-btn-primary" disabled={busy}>
          {busy ? <Spinner /> : null}
          {editing ? "Save provider" : "Add provider"}
        </button>
        <button type="button" className="rt-btn rt-btn-ghost" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ProvidersPanel({ overview, onChanged }: { overview: Overview; onChanged: () => void }) {
  const [form, setForm] = useState<{ editing: ProviderView | null } | null>(null);
  return (
    <div className="rt-stack">
      {overview.issues.length > 0 && (
        <div className="rt-note" role="status">
          config.yaml has entries the router skipped: {overview.issues.join("; ")}
        </div>
      )}
      <div className="rt-cards">
        {overview.providers.map((p) => (
          <ProviderCard key={`${p.id}:${p.status.checkedAt}:${p.hasKey}:${p.enabled}`} p={p} overview={overview} onChanged={onChanged} onEdit={(x) => setForm({ editing: x })} />
        ))}
      </div>
      {form ? (
        <ProviderForm
          key={form.editing ? form.editing.id : "new"}
          overview={overview}
          editing={form.editing}
          onDone={(changed) => {
            setForm(null);
            if (changed) onChanged();
          }}
        />
      ) : (
        <button type="button" className="rt-add" onClick={() => setForm({ editing: null })}>
          Add a provider
        </button>
      )}
    </div>
  );
}
