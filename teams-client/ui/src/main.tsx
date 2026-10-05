import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

declare global {
  interface Window {
    ct?: { invoke(method: string, args?: unknown): Promise<unknown>; close?(): void };
  }
}

type Account = {
  id: string;
  accountId: string;
  tenantId: string | null;
  upn: string;
  active: boolean;
  expiresOn?: string | null;
};

type Health = {
  state: string;
  message: string;
  accountId?: string | null;
  tenantId?: string | null;
  upn?: string | null;
  expiresOn?: string | null;
};

const buttonStyle: React.CSSProperties = {
  border: 0,
  borderRadius: 6,
  padding: "8px 12px",
  color: "white",
  background: "var(--ct-accent, #6264a7)",
  font: "inherit",
  cursor: "pointer",
};

function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [jobId, setJobId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function refresh() {
    setBusy(true);
    try {
      const current = await window.ct!.invoke("status") as Health;
      setHealth(current);
      const listed = await window.ct!.invoke("accounts") as { accounts?: Account[]; error?: string };
      setAccounts(Array.isArray(listed.accounts) ? listed.accounts : []);
      if (listed.error && current.state === "logged-in") setMessage(listed.error);
      else setMessage("");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function startLogin() {
    setBusy(true);
    setMessage("");
    try {
      const result = await window.ct!.invoke("loginStart") as { jobId?: string; error?: string; message?: string };
      if (result.error) throw new Error(result.error);
      setJobId(result.jobId || "");
      setMessage(result.message || "Microsoft browser sign-in started.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function checkLogin() {
    if (!jobId) return;
    setBusy(true);
    try {
      const result = await window.ct!.invoke("loginPoll", { jobId }) as {
        done?: boolean;
        state?: string;
        error?: string;
        message?: string;
      };
      if (result.done) setJobId("");
      if (result.error) setMessage(result.error);
      else setMessage(result.message || "Sign-in is still running. Complete it in the browser, then check again.");
      if (result.done) await refresh();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function useAccount(id: string) {
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
      setMessage(result.result || "Signed out.");
      setJobId("");
      await refresh();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 760, margin: "0 auto", padding: 20, color: "var(--ct-fg, #eee)" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 650 }}>Teams Client</div>
          <div style={{ marginTop: 5, color: "var(--ct-muted, #9aa)", fontSize: 13 }}>{health?.state || "Checking connection"}</div>
        </div>
        <button style={buttonStyle} disabled={busy} onClick={() => void refresh()}>Refresh status</button>
      </header>

      {message && <p role="status" style={{ color: "var(--ct-warn, #e0a030)", whiteSpace: "pre-wrap" }}>{message}</p>}
      {health?.message && <p style={{ color: "var(--ct-muted, #9aa)", lineHeight: 1.5 }}>{health.message}</p>}

      <section style={{ marginTop: 20, padding: 16, border: "1px solid var(--ct-border-default, rgba(255,255,255,.12))", borderRadius: 8 }}>
        <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>Microsoft account</h2>
        <p style={{ margin: "0 0 14px", color: "var(--ct-muted, #9aa)", fontSize: 12, lineHeight: 1.55 }}>
          Sign in with your work or school account. If your tenant allows user consent, approve the m365 permissions in the browser. If it restricts user consent, a tenant administrator must approve those permissions once. This plugin does not create an Entra app registration.
        </p>
        {health?.accountId && <p style={{ margin: "6px 0", fontSize: 13 }}>Account id: <strong>{health.accountId}</strong></p>}
        {health?.upn && <p style={{ margin: "6px 0", fontSize: 13 }}>Account: <strong>{health.upn}</strong></p>}
        {health?.tenantId && <p style={{ margin: "6px 0", fontSize: 13 }}>Tenant id: <strong>{health.tenantId}</strong></p>}
        {health?.expiresOn && <p style={{ margin: "6px 0", fontSize: 13 }}>Token expiry: <strong>{health.expiresOn}</strong></p>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
          <button style={buttonStyle} disabled={busy || !!jobId || health?.state === "logged-in"} onClick={() => void startLogin()}>
            {busy ? "Working" : "Sign in with browser"}
          </button>
          {jobId && <button style={buttonStyle} disabled={busy} onClick={() => void checkLogin()}>Check sign-in status</button>}
          <button style={{ ...buttonStyle, background: "var(--ct-err, #b64d58)" }} disabled={busy || health?.state !== "logged-in"} onClick={() => void logout()}>Logout</button>
        </div>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 15 }}>Configured accounts</h2>
        {accounts.length === 0 && <p style={{ color: "var(--ct-muted, #9aa)", fontSize: 13 }}>No saved m365 connections.</p>}
        {accounts.map((account) => (
          <div key={account.id} style={{ display: "flex", alignItems: "center", gap: 10, margin: "8px 0", padding: 10, border: "1px solid var(--ct-border-default, rgba(255,255,255,.1))", borderRadius: 6 }}>
            <span style={{ flex: 1, fontSize: 13 }}>
              {account.upn || account.id} · account {account.accountId} · tenant {account.tenantId || "unknown"}{account.active ? " · current" : ""}
            </span>
            <button style={buttonStyle} disabled={busy || account.active} onClick={() => void useAccount(account.id)}>Use account</button>
          </div>
        ))}
      </section>

      <footer style={{ marginTop: 20, fontSize: 11, color: "var(--ct-muted, #9aa)" }}>
        Agent verbs: accounts, use, chats, history, health, logout. Sending and preview are disabled.
      </footer>
    </main>
  );
}

createRoot(document.getElementById("ct-root")!).render(<App />);
