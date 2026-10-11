import { useState } from "react";
import { createRoot } from "react-dom/client";

declare global { interface Window { ct?: { invoke(method: string): Promise<unknown> } } }
interface Status { granted: boolean; enabled: boolean; available: boolean; devicesSelected: boolean; captureActive: boolean; error?: string }

function LarkView() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function action(method: string) {
    setBusy(true);
    setError("");
    try {
      if (!window.ct) throw new Error("Domios view bridge is unavailable.");
      const value = await window.ct.invoke(method) as Status;
      if (value?.error) throw new Error(value.error);
      setStatus(value);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <main style={{ fontFamily: "system-ui", color: "var(--ct-fg, #eee)", padding: 20 }}>
    <h1>LARK M2</h1>
    <p>Double-press to start recording. Double-press again to stop and send through your existing Transcriber.</p>
    <p>Select the recipient from its tab menu: Use LARK recording here. Without a selection, the host uses General.</p>
    {status && <p role="status">{!status.granted ? "Local recording permission is required." : !status.enabled ? "Disabled" : !status.devicesSelected ? "Choose receiver and microphone in the host picker." : !status.available ? "Selected receiver unavailable" : status.captureActive ? "Voice capture active" : "Armed"}</p>}
    {error && <p role="alert">{error}</p>}
    <button disabled={busy} onClick={() => void action("status")}>Refresh status</button>{" "}
    <button disabled={busy} onClick={() => void action("enable")}>Enable LARK</button>{" "}
    <button disabled={busy} onClick={() => void action("disable")}>Disable LARK</button>
    <p>Enabling opens no microphone and sends no audio. START uses the microphone you select. Cancel uses the ordinary recording controls.</p>
    <p>Windows integration is under verification. macOS element mapping and hardware proof are pending.</p>
  </main>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<LarkView />);
