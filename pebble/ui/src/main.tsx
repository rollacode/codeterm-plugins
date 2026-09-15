import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createRoot } from "react-dom/client";

declare global {
  interface Window {
    ct?: {
      invoke(method: string, args?: unknown): Promise<unknown>;
      close?(): void;
    };
  }
}

interface WebhookSettings {
  url: string;
  headerName: string;
  headerValue: string;
  token: string;
  secretName: string;
}

type ReceiverTarget =
  | { status: "general"; tabId: null }
  | { status: "bound"; tabId: string }
  | { status: "notLive"; tabId: string }
  | { status: "unavailable"; error: string; message: string };

type Load<T> = { kind: "loading" } | { kind: "ready"; value: T } | { kind: "error"; message: string };

const MASK = "••••••••••••";
const MUTED = "var(--ct-muted, #9aa)";
const FG = "var(--ct-fg, #eee)";
const DANGER = "var(--ct-err, #e57373)";
const OK = "var(--ct-ok, #4caf50)";
const WARN = "var(--ct-warn, #e0a030)";

const groupLabelStyle: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: MUTED,
  margin: "0 0 8px",
  fontWeight: 500,
};

const fieldLabelStyle: CSSProperties = { fontSize: 11.5, color: MUTED };

const valueStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  boxSizing: "border-box",
  overflowWrap: "anywhere",
  padding: "6px 9px",
  borderRadius: 6,
  border: "1px solid var(--ct-border-default, rgba(255,255,255,0.12))",
  background: "var(--ct-bg-elev, rgba(255,255,255,0.03))",
  color: FG,
  fontFamily: "var(--ct-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
  fontSize: 12,
  lineHeight: 1.45,
  userSelect: "all",
};

const ghostButtonStyle: CSSProperties = {
  font: "inherit",
  fontSize: 12,
  fontWeight: 540,
  padding: "5px 10px",
  minWidth: 64,
  borderRadius: 6,
  border: "1px solid var(--ct-border-default, rgba(255,255,255,0.12))",
  background: "color-mix(in srgb, var(--ct-fg, #eee) 7%, transparent)",
  color: FG,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const accentButtonStyle: CSSProperties = {
  ...ghostButtonStyle,
  border: "none",
  background: "var(--ct-accent, #5b8cff)",
  color: "#fff",
};

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function invoke(method: string): Promise<unknown> {
  if (!window.ct) throw new Error("CodeTerm view bridge is unavailable");
  return window.ct.invoke(method);
}

function copyWithSelection(value: string): boolean {
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Sandboxed iframes are often denied the async clipboard; a user-gesture copy still works.
    return copyWithSelection(value);
  }
}

function GroupLabel({ children, id }: { children: ReactNode; id?: string }) {
  return <h2 id={id} style={groupLabelStyle}>{children}</h2>;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    const copied = await writeClipboard(value);
    setState(copied ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };

  const color = state === "copied" ? OK : state === "failed" ? DANGER : FG;
  return (
    <button type="button" onClick={() => void copy()} aria-label={"Copy " + label} style={{ ...ghostButtonStyle, color }}>
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Select it" : "Copy"}</span>
    </button>
  );
}

function Field({ label, shown, copyValue, extra }: { label: string; shown: string; copyValue: string; extra?: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <span style={fieldLabelStyle}>{label}</span>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
        <code style={valueStyle} aria-label={label}>{shown}</code>
        {extra}
        <CopyButton value={copyValue} label={label} />
      </div>
    </div>
  );
}

function InlineError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 10px",
        borderRadius: 6,
        border: `1px solid color-mix(in srgb, ${DANGER} 35%, transparent)`,
        background: `color-mix(in srgb, ${DANGER} 10%, transparent)`,
      }}
    >
      <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
        <span style={{ color: DANGER, fontSize: 12.5, fontWeight: 560 }}>{title}</span>
        <span style={{ color: MUTED, fontSize: 11.5, overflowWrap: "anywhere" }}>{message}</span>
      </div>
      <button type="button" onClick={onRetry} style={accentButtonStyle}>Retry</button>
    </div>
  );
}

function Badge({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 560,
        padding: "2px 9px",
        borderRadius: 999,
        whiteSpace: "nowrap",
        color,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

function useLoad<T>(load: () => Promise<T>): [Load<T>, () => void, (next: Load<T>) => void] {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const run = useCallback(() => {
    setState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    load().then(
      (value) => setState({ kind: "ready", value }),
      (cause) => setState({ kind: "error", message: errorMessage(cause) }),
    );
  }, [load]);
  useEffect(run, [run]);
  return [state, run, setState];
}

async function loadSettings(): Promise<WebhookSettings> {
  const result = (await invoke("webhookSettings")) as Partial<WebhookSettings> & { error?: string };
  if (result?.error) throw new Error(result.error);
  if (!result?.url || !result.headerName || !result.headerValue || !result.token) {
    throw new Error("CodeTerm returned incomplete webhook settings");
  }
  return result as WebhookSettings;
}

function isTarget(value: unknown): value is ReceiverTarget {
  const status = (value as { status?: unknown } | null)?.status;
  return status === "general" || status === "bound" || status === "notLive" || status === "unavailable";
}

async function targetCall(method: "receiverTarget" | "resetReceiverTarget"): Promise<ReceiverTarget> {
  const result = await invoke(method);
  if (!isTarget(result)) {
    const error = (result as { error?: unknown } | null)?.error;
    throw new Error(typeof error === "string" ? error : "CodeTerm returned an unreadable receiver target");
  }
  return result;
}

const loadTarget = () => targetCall("receiverTarget");

function WebhookSection() {
  const [settings, retry] = useLoad(loadSettings);
  const [revealed, setRevealed] = useState(false);

  return (
    <section aria-labelledby="pebble-webhook">
      <GroupLabel id="pebble-webhook">CoreApp webhook</GroupLabel>
      {settings.kind === "loading" && <p role="status" style={{ margin: 0, color: MUTED, fontSize: 12 }}>Reading this machine's webhook…</p>}
      {settings.kind === "error" && (
        <InlineError title="Webhook settings unavailable" message={settings.message} onRetry={retry} />
      )}
      {settings.kind === "ready" && (
        <div style={{ display: "grid", gap: 10 }}>
          <Field label="Webhook URL" shown={settings.value.url} copyValue={settings.value.url} />
          <Field label="Header name" shown={settings.value.headerName} copyValue={settings.value.headerName} />
          <Field
            label="Header value"
            shown={revealed ? settings.value.headerValue : "Bearer ••••"}
            copyValue={settings.value.headerValue}
          />
          <Field
            label={"Token (" + settings.value.secretName + ")"}
            shown={revealed ? settings.value.token : MASK}
            copyValue={settings.value.token}
            extra={
              <button type="button" aria-pressed={revealed} onClick={() => setRevealed((v) => !v)} style={ghostButtonStyle}>
                {revealed ? "Hide" : "Show"}
              </button>
            }
          />
          <p style={{ margin: 0, color: MUTED, fontSize: 11.5 }}>
            In CoreApp send <strong style={{ color: FG }}>Transcription only</strong> and add no Content-Type header.
          </p>
        </div>
      )}
    </section>
  );
}

function TargetSection() {
  const [target, retry, setTarget] = useLoad(loadTarget);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") retry();
    };
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [retry]);

  const reset = async () => {
    setResetting(true);
    try {
      setTarget({ kind: "ready", value: await targetCall("resetReceiverTarget") });
    } catch (cause) {
      setTarget({ kind: "error", message: errorMessage(cause) });
    } finally {
      setResetting(false);
    }
  };

  const hint = (
    <span style={{ color: MUTED, fontSize: 11.5 }}>
      To pick a tab, open its ⋮ menu → <strong style={{ color: FG }}>Pebble ring → this tab</strong>.
    </span>
  );

  let body: ReactNode;
  if (target.kind === "loading") {
    body = <p role="status" style={{ margin: 0, color: MUTED, fontSize: 12 }}>Checking where events go…</p>;
  } else if (target.kind === "error") {
    body = <InlineError title="Receiver target unavailable" message={target.message} onRetry={retry} />;
  } else if (target.value.status === "unavailable") {
    body = <InlineError title="Receiver target unavailable" message={target.value.message} onRetry={retry} />;
  } else {
    const value = target.value;
    const bound = value.status !== "general";
    body = (
      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <div role="status" style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
            {value.status === "general" && <Badge color={MUTED}>General Agent</Badge>}
            {value.status === "bound" && <Badge color={OK}>Tab</Badge>}
            {value.status === "notLive" && <Badge color={WARN}>Tab not live</Badge>}
            {bound && <code style={{ ...valueStyle, flex: "none", padding: "2px 7px", userSelect: "text" }}>{value.tabId}</code>}
          </div>
          {bound && (
            <button type="button" onClick={() => void reset()} disabled={resetting} style={ghostButtonStyle}>
              {resetting ? "Resetting…" : "Reset to General Agent"}
            </button>
          )}
        </div>
        {value.status === "general" && <span style={{ color: MUTED, fontSize: 11.5 }}>No tab picked. Events go to the General Agent.</span>}
        {value.status === "bound" && <span style={{ color: MUTED, fontSize: 11.5 }}>Events go to this tab.</span>}
        {value.status === "notLive" && (
          <span style={{ color: MUTED, fontSize: 11.5 }}>This tab has no live session, so events go to the General Agent.</span>
        )}
        {hint}
      </div>
    );
  }

  return (
    <section aria-labelledby="pebble-target">
      <GroupLabel id="pebble-target">Delivers to</GroupLabel>
      {body}
    </section>
  );
}

function App() {
  return (
    <main
      style={{
        display: "grid",
        gap: 16,
        padding: 14,
        fontFamily: "var(--ct-font, system-ui, sans-serif)",
        fontSize: 12.5,
        color: FG,
        background: "var(--ct-bg, #14141c)",
      }}
    >
      <WebhookSection />
      <TargetSection />
    </main>
  );
}

const root = document.getElementById("ct-root");
if (root) createRoot(root).render(<App />);
