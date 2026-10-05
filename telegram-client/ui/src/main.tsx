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
      await refresh();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  const accounts = health?.accounts || [];
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
        <span style={{ fontSize: 11, color: "var(--ct-muted, #9aa)" }}>Agent verbs: accounts, use, chats, history, health, logout. Sending is disabled.</span>
        <button style={{ ...buttonStyle, background: "var(--ct-err, #b64d58)" }} disabled={busy || !health?.currentAccount} onClick={() => void logout()}>Logout</button>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("ct-root")!).render(<App />);
