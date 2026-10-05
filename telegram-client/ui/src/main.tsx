import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

declare global {
  interface Window {
    ct?: { invoke(method: string, args?: unknown): Promise<unknown>; close?(): void };
  }
}

type Account = { id: string; label: string; hasSession: boolean; current: boolean };
type Health = {
  state: string;
  message: string;
  storage?: { name: string; note: string };
  accounts?: Account[];
  currentAccount?: string | null;
  resolvedAccount?: unknown;
  sendPolicy?: { configured: boolean; mode?: string | null; senderAccountId?: string; allowedDestinations?: Array<{ id: string; label: string }> };
  sendState?: { state: string; failure?: string | null; message?: string | null; retryAfter?: number | null; destination?: unknown } | null;
};
type Preview = {
  previewId: string;
  sender: { id: string; displayName: string; username?: string | null; telegramUserId: string };
  destination: { id: string; label: string };
  text: string;
  policy: Health["sendPolicy"];
};

const inputStyle: React.CSSProperties = {
  boxSizing: "border-box", width: "100%", padding: "8px 10px", color: "var(--ct-fg, #eee)",
  background: "var(--ct-bg-elev, rgba(255,255,255,.04))", border: "1px solid var(--ct-border-default, rgba(255,255,255,.16))",
  borderRadius: 6, font: "inherit",
};
const buttonStyle: React.CSSProperties = {
  border: 0, borderRadius: 6, padding: "8px 12px", color: "white", background: "var(--ct-accent, #3698d4)",
  font: "inherit", cursor: "pointer",
};

function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [twoFactorPassword, setTwoFactorPassword] = useState("");
  const [accountLabel, setAccountLabel] = useState("default");
  const [confirmed, setConfirmed] = useState(false);
  const [jobId, setJobId] = useState("");
  const [loginOutput, setLoginOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [chatId, setChatId] = useState("");
  const [sendText, setSendText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sendReceipt, setSendReceipt] = useState("");

  async function refresh() {
    setBusy(true);
    try {
      const result = await window.ct!.invoke("status") as Health;
      setHealth(result);
      if (result.currentAccount) setAccountLabel(result.currentAccount);
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function startLogin() {
    if (!confirmed) {
      setMessage("Confirm the Telegram Desktop device identity and your own API credentials before login.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await window.ct!.invoke("loginStart", { apiId, apiHash, accountLabel, twoFactorPassword }) as { jobId?: string; error?: string; message?: string };
      if (result.error) throw new Error(result.error);
      setJobId(result.jobId || "");
      setLoginOutput("");
      setApiId("");
      setApiHash("");
      setTwoFactorPassword("");
      setMessage(result.message || "Login started. Use Refresh login progress to view the QR.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function pollLogin() {
    if (!jobId) return;
    setBusy(true);
    try {
      const result = await window.ct!.invoke("loginPoll", { jobId }) as { done?: boolean; output?: string; error?: string; state?: string };
      setLoginOutput(result.output || "");
      if (result.error) setMessage(result.error);
      else if (result.done) {
        setJobId("");
        setMessage("Login finished. Refreshing the resolved Telegram account.");
        await refresh();
      } else setMessage("Login is still running. Scan the QR above, then refresh progress again.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function selectAccount(id: string) {
    setBusy(true);
    setPreview(null);
    setSendReceipt("");
    try {
      const result = await window.ct!.invoke("useAccount", { id }) as { error?: string };
      if (result.error) throw new Error(result.error);
      await refresh();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      const result = await window.ct!.invoke("logout") as { result?: string; error?: string };
      if (result.error) throw new Error(result.error);
      setMessage(result.result || "Logged out.");
      setLoginOutput("");
      setJobId("");
      setPreview(null);
      setSendReceipt("");
      await refresh();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function previewSend() {
    setBusy(true);
    setMessage("");
    setPreview(null);
    setSendReceipt("");
    try {
      const result = await window.ct!.invoke("preview", { chatId, text: sendText }) as Preview | { error?: string; result?: string };
      if ("error" in result && result.error) throw new Error(result.error);
      const parsed = "result" in result && result.result ? JSON.parse(result.result) as Preview : result as Preview;
      if (!parsed.sender?.id || !parsed.destination?.id || typeof parsed.text !== "string") throw new Error("Telegram did not return a complete resolved preview.");
      setPreview(parsed);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function enableSavedMessagesPolicy() {
    if (!preview || preview.destination.label !== "Saved Messages") return;
    setBusy(true);
    setMessage("");
    try {
      const result = await window.ct!.invoke("setSendPolicy", { previewId: preview.previewId, approveSavedMessagesOnly: true }) as { result?: string; error?: string };
      if (result.error) throw new Error(result.error);
      if (result.result) {
        const policy = JSON.parse(result.result);
        setPreview((current) => current ? { ...current, policy } : current);
      }
      await refresh();
      setMessage("Saved-Messages-only send policy is enabled for the resolved sender.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function sendPreview() {
    if (!preview || !health?.sendPolicy?.configured) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await window.ct!.invoke("send", {
        chatId: preview.destination.id,
        text: preview.text,
        previewId: preview.previewId,
        idempotencyKey: preview.previewId,
      }) as { result?: string; error?: string };
      if (result.error) throw new Error(result.error);
      setSendReceipt(result.result || "");
      await refresh();
    } catch (error) {
      const failure = String(error);
      await refresh();
      setMessage(failure);
    } finally {
      setBusy(false);
    }
  }

  const accounts = health?.accounts || [];
  const policyAllowsPreview = !!preview && !!health?.sendPolicy?.configured &&
    health.sendPolicy.senderAccountId === preview.sender.id &&
    health.sendPolicy.allowedDestinations?.some((item) => item.id === preview.destination.id);
  const previewMatchesInput = !!preview && preview.destination.id === chatId && preview.text === sendText;
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "0 auto", padding: 20, color: "var(--ct-fg, #eee)", background: "var(--ct-bg, #14141c)" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 650 }}>Telegram Client</div>
          <div style={{ marginTop: 5, color: "var(--ct-muted, #9aa)", fontSize: 13 }}>{health?.state || "Checking connection"}</div>
        </div>
        <button style={buttonStyle} disabled={busy} onClick={() => void refresh()}>Refresh status</button>
      </header>

      {message && <p role="status" style={{ color: "var(--ct-warn, #e0a030)", whiteSpace: "pre-wrap" }}>{message}</p>}
      {health?.message && <p style={{ color: "var(--ct-muted, #9aa)" }}>{health.message}</p>}
      {health?.storage && <p style={{ fontSize: 12, color: "var(--ct-muted, #9aa)" }}>Session storage: {health.storage.name}. {health.storage.note}</p>}

      <section style={{ marginTop: 22, padding: 16, border: "1px solid var(--ct-border-default, rgba(255,255,255,.12))", borderRadius: 8 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 15 }}>Preview and send</h2>
        <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--ct-muted, #9aa)" }}>
          Sending is locked until you review a resolved sender and immutable destination. The initial owner policy permits Saved Messages only.
        </p>
        <label style={{ display: "block", marginBottom: 10, fontSize: 12 }}>Immutable chat id
          <input style={inputStyle} value={chatId} autoComplete="off" placeholder="id:12345" onChange={(event) => { setChatId(event.target.value); setPreview(null); setSendReceipt(""); }} />
        </label>
        <label style={{ display: "block", marginBottom: 10, fontSize: 12 }}>Exact message text
          <textarea style={{ ...inputStyle, minHeight: 82, resize: "vertical" }} value={sendText} onChange={(event) => { setSendText(event.target.value); setPreview(null); setSendReceipt(""); }} />
        </label>
        <button style={buttonStyle} disabled={busy || !chatId || !sendText} onClick={() => void previewSend()}>Preview resolved send</button>
        {preview && <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--ct-border-default, rgba(255,255,255,.12))", borderRadius: 6 }}>
          <strong>Resolved sender and destination</strong>
          <p style={{ margin: "8px 0" }}>Sender: <strong>{preview.sender.displayName}</strong> · account id <code>{preview.sender.id}</code> · Telegram user id <code>{preview.sender.telegramUserId}</code></p>
          <p style={{ margin: "8px 0" }}>Destination: <strong>{preview.destination.label}</strong> · immutable id <code>{preview.destination.id}</code></p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: 10, borderRadius: 6, background: "rgba(0,0,0,.18)", fontSize: 12 }}>{preview.text}</pre>
          <p style={{ margin: "8px 0", fontSize: 12 }}>Policy: {preview.policy?.configured ? "Saved Messages only is enabled" : "no owner-approved send policy is set"}</p>
          {preview.destination.label === "Saved Messages" && !health?.sendPolicy?.configured && <button style={buttonStyle} disabled={busy || !previewMatchesInput} onClick={() => void enableSavedMessagesPolicy()}>Enable Saved-Messages-only policy</button>}
          <button style={{ ...buttonStyle, marginLeft: 8 }} disabled={busy || !previewMatchesInput || !policyAllowsPreview} onClick={() => void sendPreview()}>{busy ? "Working" : "Send this preview"}</button>
        </div>}
        {sendReceipt && <pre role="status" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: 10, borderRadius: 6, background: "rgba(0,0,0,.18)", fontSize: 11 }}>{sendReceipt}</pre>}
        {health?.sendState && <p role="status" style={{ fontSize: 12, color: "var(--ct-muted, #9aa)" }}>Last send state: <strong>{health.sendState.state}</strong>{health.sendState.message ? ` · ${health.sendState.message}` : ""}</p>}
      </section>

      <section style={{ marginTop: 22, padding: 16, border: "1px solid var(--ct-border-default, rgba(255,255,255,.12))", borderRadius: 8 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 15 }}>Sign in with QR</h2>
        <p style={{ margin: "0 0 14px", fontSize: 12, lineHeight: 1.5, color: "var(--ct-muted, #9aa)" }}>
          The pinned release identifies this device as Telegram Desktop (Windows) in Telegram’s Devices list. Use your own API ID and hash from my.telegram.org; these replace the release binary’s shared application credentials for this account.
        </p>
        <label style={{ display: "block", marginBottom: 10, fontSize: 12 }}>Telegram API ID
          <input style={inputStyle} value={apiId} inputMode="numeric" autoComplete="off" onChange={(event) => setApiId(event.target.value)} />
        </label>
        <label style={{ display: "block", marginBottom: 10, fontSize: 12 }}>Telegram API hash
          <input style={inputStyle} type="password" autoComplete="new-password" value={apiHash} onChange={(event) => setApiHash(event.target.value)} />
        </label>
        <label style={{ display: "block", marginBottom: 10, fontSize: 12 }}>Account label
          <input style={inputStyle} value={accountLabel} autoComplete="off" onChange={(event) => setAccountLabel(event.target.value)} />
        </label>
        <label style={{ display: "block", marginBottom: 10, fontSize: 12 }}>Optional Telegram two-step verification password
          <input style={inputStyle} type="password" autoComplete="new-password" value={twoFactorPassword} onChange={(event) => setTwoFactorPassword(event.target.value)} />
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, margin: "12px 0", fontSize: 12, lineHeight: 1.45 }}>
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>I understand this client appears as Telegram Desktop (Windows), and I am entering my own Telegram API ID and hash.</span>
        </label>
        <button style={buttonStyle} disabled={busy || !apiId || !apiHash || !confirmed} onClick={() => void startLogin()}>
          {busy ? "Working" : "Start QR login"}
        </button>
        {jobId && <button style={{ ...buttonStyle, marginLeft: 8 }} disabled={busy} onClick={() => void pollLogin()}>Refresh login progress</button>}
        {loginOutput && <pre style={{ maxHeight: 280, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: 12, borderRadius: 6, background: "rgba(0,0,0,.24)", fontSize: 11 }}>{loginOutput}</pre>}
      </section>

      <section style={{ marginTop: 22 }}>
        <h2 style={{ fontSize: 15 }}>Resolved sender</h2>
        <p style={{ fontSize: 13 }}>Current account: <strong>{health?.currentAccount || "none"}</strong></p>
        {health?.resolvedAccount ? <pre style={{ overflow: "auto", whiteSpace: "pre-wrap", padding: 12, borderRadius: 6, background: "rgba(0,0,0,.18)", fontSize: 11 }}>{JSON.stringify(health.resolvedAccount, null, 2)}</pre> : null}
        {accounts.map((account) => (
          <div key={account.id} style={{ display: "flex", alignItems: "center", gap: 10, margin: "8px 0", padding: 10, border: "1px solid var(--ct-border-default, rgba(255,255,255,.1))", borderRadius: 6 }}>
            <span style={{ flex: 1 }}>{account.label} · {account.hasSession ? "session present" : "logged out"}{account.current ? " · current" : ""}</span>
            <button style={buttonStyle} disabled={busy || !account.hasSession || account.current} onClick={() => void selectAccount(account.id)}>Use sender</button>
          </div>
        ))}
      </section>

      <footer style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 11, color: "var(--ct-muted, #9aa)" }}>Agent verbs: accounts, use, chats, history, health, logout, preview, send.</span>
        <button style={{ ...buttonStyle, background: "var(--ct-err, #b64d58)" }} disabled={busy || !health?.currentAccount} onClick={() => void logout()}>Logout</button>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("ct-root")!).render(<App />);
