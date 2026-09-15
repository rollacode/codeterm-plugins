import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
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

const panelStyle: CSSProperties = {
  display: "grid",
  gap: 16,
  padding: 20,
  maxWidth: 720,
  margin: "0 auto",
  fontFamily: "var(--ct-font, system-ui, sans-serif)",
  fontSize: 13,
};

const fieldStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const valueStyle: CSSProperties = {
  display: "block",
  overflowWrap: "anywhere",
  padding: "9px 10px",
  borderRadius: 6,
  border: "1px solid var(--ct-border-default, rgba(255,255,255,0.14))",
  background: "var(--ct-bg-elev, rgba(255,255,255,0.04))",
  color: "var(--ct-fg, #eee)",
  fontFamily: "var(--ct-mono, ui-monospace, monospace)",
  fontSize: 12,
};

function CopyField({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (value: string) => void;
}) {
  return (
    <div style={fieldStyle}>
      <label>{label}</label>
      <div style={{ display: "flex", gap: 8, alignItems: "start" }}>
        <code style={{ ...valueStyle, flex: 1 }}>{value}</code>
        <button type="button" onClick={() => onCopy(value)} aria-label={"Copy " + label}>
          Copy
        </button>
      </div>
    </div>
  );
}

function App() {
  const [settings, setSettings] = useState<WebhookSettings | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!window.ct) throw new Error("CodeTerm view bridge is unavailable");
      const result = await window.ct.invoke("webhookSettings") as Partial<WebhookSettings> & { error?: string };
      if (result.error) throw new Error(result.error);
      if (!result.url || !result.headerName || !result.headerValue || !result.token) {
        throw new Error("CodeTerm returned incomplete webhook settings");
      }
      setSettings(result as WebhookSettings);
    } catch (cause) {
      setSettings(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Copied");
    } catch {
      setNotice("Select and copy the value manually");
    }
  }, []);

  return (
    <main style={panelStyle}>
      <header>
        <h1 style={{ margin: "0 0 6px", fontSize: 18 }}>Pebble webhook setup</h1>
        <p style={{ margin: 0, color: "var(--ct-muted, #9aa)" }}>
          Use these values in CoreApp on the phone that sends the transcription.
        </p>
      </header>

      {busy && <p role="status">Reading this machine's webhook settings…</p>}
      {error && (
        <section role="alert" style={{ color: "var(--ct-err, #e57373)" }}>
          {error}
          <button type="button" onClick={() => void refresh()} style={{ marginLeft: 10 }}>
            Retry
          </button>
        </section>
      )}
      {settings && !busy && (
        <section style={{ display: "grid", gap: 14 }} aria-label="CoreApp webhook values">
          <CopyField label="Webhook URL" value={settings.url} onCopy={copy} />
          <CopyField label="Header name" value={settings.headerName} onCopy={copy} />
          <CopyField label="Header value" value={settings.headerValue} onCopy={copy} />
          <CopyField label={"Token (" + settings.secretName + ")"} value={settings.token} onCopy={copy} />
          <p style={{ margin: 0, color: "var(--ct-muted, #9aa)" }}>
            In CoreApp choose <strong>Transcription only</strong>. Do not add a
            Content-Type header; CoreApp must generate its multipart boundary.
          </p>
        </section>
      )}
      {notice && <p role="status" aria-live="polite" style={{ margin: 0 }}>{notice}</p>}
      <button type="button" onClick={() => void refresh()} disabled={busy}>
        Refresh
      </button>
    </main>
  );
}

createRoot(document.getElementById("ct-root")!).render(<App />);
