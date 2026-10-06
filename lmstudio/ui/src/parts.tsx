import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { statusLabel, statusTone, type ProviderState } from "./logic";

export function Badges({ badges, loaded }: { badges: string[]; loaded?: boolean }) {
  if (!badges.length && !loaded) return null;
  return (
    <span className="rt-badges">
      {loaded && <span className="rt-badge rt-badge-live">loaded</span>}
      {badges.map((b) => (
        <span key={b} className="rt-badge">
          {b}
        </span>
      ))}
    </span>
  );
}

export function StatusPill({ state }: { state: ProviderState }) {
  return (
    <span className="rt-status" data-tone={statusTone(state)}>
      <span className="rt-status-dot" aria-hidden="true" />
      {statusLabel(state)}
    </span>
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: string;
  count?: number;
}

/** WAI-ARIA tabs with roving focus; the thumb slides under the selected tab. */
export function Segmented<T extends string>({ tabs, value, onChange, idPrefix }: { tabs: TabDef<T>[]; value: T; onChange: (id: T) => void; idPrefix: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, tabs.findIndex((t) => t.id === value));
  const onKey = (e: KeyboardEvent) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className="rt-seg" role="tablist" aria-label="Router sections" style={{ ["--seg-count" as string]: tabs.length, ["--seg-index" as string]: index }} onKeyDown={onKey}>
      <span className="rt-seg-thumb" aria-hidden="true" />
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={`${idPrefix}-tab-${t.id}`}
          role="tab"
          type="button"
          aria-selected={t.id === value}
          aria-controls={`${idPrefix}-panel-${t.id}`}
          tabIndex={t.id === value ? 0 : -1}
          className="rt-seg-opt"
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined && <span className="rt-seg-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="rt-field" data-invalid={error ? true : undefined}>
      <label className="rt-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error ? (
        <div className="rt-field-error" id={`${id}-error`} role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="rt-hint" id={`${id}-hint`}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function fieldError(errors: { field: string; message: string }[] | undefined, field: string): string | undefined {
  return errors?.find((e) => e.field === field)?.message;
}

export function Spinner() {
  return <span className="rt-spin" aria-hidden="true" />;
}
