import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Connection } from "../../src/connection";
import { mountView } from "./mount";

declare global { interface Window { ct?: { invoke(method: string, args?: unknown): Promise<unknown>; close?(): void } } }

function LarkView() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [diagnostics, setDiagnostics] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    if (!window.ct) { setError("Domios view bridge is unavailable."); return; }
    void window.ct.invoke("connection").then(value => {
      if (active) setConnection(value as Connection);
    }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, []);
  async function action(method: string) {
    setBusy(true);
    setError("");
    try {
      if (!window.ct) throw new Error("Domios view bridge is unavailable.");
      if (method === "diagnostics") {
        setDiagnostics(await window.ct.invoke(method));
      } else {
        const value = await window.ct.invoke(method);
        if (value && typeof value === "object" && "error" in value) throw new Error(String(value.error));
      }
      setConnection(await window.ct.invoke("connection") as Connection);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <main style={{ fontFamily: "system-ui", color: "var(--ct-fg, #eee)", padding: 20 }}>
    <h1>LARK M2</h1>
    <p>Double-press to start recording. Double-press again to stop and send through your existing Transcriber.</p>
    <p role="status">{connection ? `${connection.label}. ${connection.detail}` : "Checking recording status…"}</p>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy} onClick={() => void action("status")}>Refresh status</button>{" "}
    <button disabled={busy} onClick={() => void action("enable")}>Enable LARK</button>{" "}
    <button disabled={busy} onClick={() => void action("disable")}>Disable LARK</button>{" "}
    <button disabled={busy} onClick={() => void action("diagnostics")}>Show diagnostics</button>
    {diagnostics !== null && <pre aria-label="LARK diagnostics" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(diagnostics, null, 2)}</pre>}
    <p>Grant local recording in Domios plugin permissions before enabling. These settings do not contain a receiver or microphone picker. The current host owns that picker; when no receiver is offered it may show no picker. LARK cannot list devices, save a choice, or reconnect automatically until the host exposes those capabilities.</p>
    <p>Select the recipient from its tab menu: Use LARK recording here. Without a selection, the host uses General.</p>
    <p>Enabling opens no microphone and sends no audio. START uses the selected microphone. Cancel uses the ordinary recording controls.</p>
  </main>;
}

mountView(document, root => createRoot(root).render(<LarkView />));
