import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

export type Tone = "ok" | "warn" | "danger" | "accent" | "muted";

const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--ct-ok, var(--ct-green, #4caf50))",
  warn: "var(--ct-warn, #e0a030)",
  danger: "var(--ct-err, var(--ct-red, #e57373))",
  accent: "var(--ct-accent, #5b8cff)",
  muted: "var(--ct-muted, #9aa)",
};

const text = {
  fg: "var(--ct-fg, #e8e8ef)",
  muted: "var(--ct-muted, #9aa)",
};

export function StatusChip({ label, tone }: { label: string; tone: Tone }) {
  const color = TONE_COLOR[tone];
  return (
    <span
      data-tone={tone}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, flex: "none",
        fontSize: 11.5, fontWeight: 560, padding: "3px 10px", borderRadius: 999, color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
      }}
    >
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: color }} />
      {label}
    </span>
  );
}

export function StatusBar({ label, tone, detail, busy, onRefresh }: {
  label: string;
  tone: Tone;
  detail?: string;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <div role="group" aria-label="Status" style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 14 }}>
      <StatusChip label={label} tone={tone} />
      {detail && <p style={{ flex: 1, minWidth: 0, margin: "2px 0 0", fontSize: 12.5, lineHeight: 1.5, color: text.muted }}>{detail}</p>}
      <Btn style={{ marginLeft: "auto" }} disabled={busy} onClick={onRefresh}>Refresh</Btn>
    </div>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      style={{
        marginTop: 12, padding: 16, borderRadius: 12,
        background: "color-mix(in srgb, var(--ct-surface, var(--ct-bg-elev, #1c1c26)) 72%, transparent)",
        border: "1px solid var(--ct-border-subtle, rgba(255,255,255,.08))",
      }}
    >
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 620, color: text.fg }}>{title}</h2>
      {hint && <p style={{ margin: "4px 0 12px", fontSize: 12, lineHeight: 1.5, color: text.muted }}>{hint}</p>}
      {!hint && <div style={{ height: 10 }} />}
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 5, marginBottom: 10, fontSize: 12, color: text.fg }}>
      {label}
      {children}
    </label>
  );
}

export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details style={{ marginTop: 12, padding: "10px 14px", borderRadius: 10, border: "1px solid var(--ct-border-subtle, rgba(255,255,255,.08))", fontSize: 12, lineHeight: 1.55, color: text.muted }}>
      <summary style={{ cursor: "pointer", fontWeight: 560, color: text.fg }}>{summary}</summary>
      <div style={{ marginTop: 8 }}>{children}</div>
    </details>
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 12 }}>{children}</div>;
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" style={{ margin: "0 0 12px", padding: "8px 12px", borderRadius: 8, whiteSpace: "pre-wrap", fontSize: 12.5, color: TONE_COLOR.warn, background: `color-mix(in srgb, ${TONE_COLOR.warn} 10%, transparent)` }}>
      {children}
    </p>
  );
}

export const inputStyle: CSSProperties = {
  boxSizing: "border-box", width: "100%", padding: "7px 10px", color: text.fg,
  background: "var(--ct-bg-elev, rgba(255,255,255,.04))", border: "1px solid var(--ct-border-default, rgba(255,255,255,.16))",
  borderRadius: 8, font: "inherit", fontSize: 12.5,
};

const buttonBase: CSSProperties = {
  font: "inherit", fontSize: 12.5, fontWeight: 560, padding: "6px 14px", borderRadius: 8,
  cursor: "pointer", whiteSpace: "nowrap",
};

export function Btn({ kind = "ghost", style, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "ghost" | "danger" }) {
  const base = kind === "primary" ? primaryButton : kind === "danger" ? dangerGhostButton : ghostButton;
  return <button {...props} type={type} style={{ ...base, ...(props.disabled ? { opacity: 0.5, cursor: "default" } : null), ...style }} />;
}

const primaryButton: CSSProperties = {
  ...buttonBase, border: "1px solid transparent", color: "var(--ct-on-accent, #fff)", background: TONE_COLOR.accent,
};

const ghostButton: CSSProperties = {
  ...buttonBase, fontWeight: 500, border: "1px solid var(--ct-border-default, rgba(255,255,255,.16))", color: text.fg, background: "transparent",
};

const dangerGhostButton: CSSProperties = {
  ...ghostButton, color: TONE_COLOR.danger, borderColor: `color-mix(in srgb, ${TONE_COLOR.danger} 40%, transparent)`,
};

export const codeBlock: CSSProperties = {
  margin: "8px 0 0", padding: 10, borderRadius: 8, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
  background: "rgba(0,0,0,.18)", fontSize: 11.5,
};

export const pageStyle: CSSProperties = {
  fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "0 auto", padding: "4px 2px 16px", color: text.fg,
};

export function humanizeState(state: string): string {
  const words = state.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Unknown";
}
