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

type Chat = { id: string; topic?: string | null };
type SendPolicy = { configured: boolean; mode?: string | null; senderAccountId?: string | null; senderTenantId?: string | null; allowedDestinations: Array<{ id: string; label: string }> };
type SendPreview = {
  previewId: string;
  idempotencyKey: string;
  sender: { id: string; accountId: string; upn: string; tenantId: string; identityKey: string };
  tenant: { id: string };
  destination: { id: string; label: string };
  text: string;
  policy: SendPolicy;
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
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState("");
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [policy, setPolicy] = useState<SendPolicy>({ configured: false, allowedDestinations: [] });
  const [sendResult, setSendResult] = useState("");
  const [blockedKey, setBlockedKey] = useState("");
  const [sendInProgress, setSendInProgress] = useState(false);
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
      const chatResult = await window.ct!.invoke("chats") as { result?: string; error?: string };
      const parsedChats = chatResult.result ? JSON.parse(chatResult.result) as { chats?: Chat[] } : { chats: [] };
      const nextChats = Array.isArray(parsedChats.chats) ? parsedChats.chats : [];
      setChats(nextChats);
      setChatId((currentId) => nextChats.some((chat) => chat.id === currentId) ? currentId : "");
      if (chatResult.error) setMessage(chatResult.error);
      const currentPolicy = await window.ct!.invoke("policy") as SendPolicy;
      setPolicy(currentPolicy || { configured: false, allowedDestinations: [] });
      if (listed.error && current.state === "logged-in") setMessage(listed.error);
      else if (!chatResult.error) setMessage("");
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

  function invalidatePreview() {
    setPreview(null);
    setSendResult("");
    setBlockedKey("");
  }

  async function makePreview() {
    setBusy(true);
    setMessage("");
    invalidatePreview();
    try {
      const response = await window.ct!.invoke("preview", { chatId, text: draft }) as { result?: string; error?: string };
      if (response.error) throw new Error(response.error);
      if (!response.result) throw new Error("Teams Client did not return a preview.");
      setPreview(JSON.parse(response.result) as SendPreview);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function approveDestination() {
    if (!preview) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await window.ct!.invoke("approveSendPolicy", { approveDestination: true, previewId: preview.previewId }) as { result?: string; error?: string };
      if (response.error) throw new Error(response.error);
      if (!response.result) throw new Error("Teams Client did not save the single-chat policy.");
      setPolicy(JSON.parse(response.result) as SendPolicy);
      setMessage("Policy saved for the sender, tenant, and one immutable chat shown in this preview.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function sendPreview() {
    if (!preview) return;
    setBusy(true);
    setSendInProgress(true);
    setMessage("Sending with m365. Throttling retries can take about 10 seconds or more without output; wait for this result before taking another action.");
    setSendResult("");
    try {
      const response = await window.ct!.invoke("send", {
        chatId: preview.destination.id,
        text: preview.text,
        idempotencyKey: preview.idempotencyKey,
      }) as { result?: string; error?: string };
      if (response.error) {
        if (/^unknown:/i.test(response.error)) setBlockedKey(preview.idempotencyKey);
        throw new Error(response.error);
      }
      if (!response.result) throw new Error("Teams Client did not return a recorded send result.");
      setSendResult(response.result);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setSendInProgress(false);
      setBusy(false);
    }
  }

  const previewMatches = !!preview && preview.destination.id === chatId && preview.text === draft &&
    health?.state === "logged-in" && preview.sender.accountId === health.accountId && preview.sender.tenantId === health.tenantId;
  const policyMatches = !!preview && policy.configured && policy.senderAccountId === preview.sender.accountId &&
    policy.senderTenantId === preview.sender.tenantId && policy.allowedDestinations.some((item) => item.id === preview.destination.id);
  const sendEnabled = !busy && previewMatches && policyMatches && blockedKey !== preview?.idempotencyKey && !sendResult;

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

      <section style={{ marginTop: 20, padding: 16, border: "1px solid var(--ct-border-default, rgba(255,255,255,.12))", borderRadius: 8 }}>
        <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>Review and send one chat message</h2>
        <p style={{ color: "var(--ct-muted, #9aa)", fontSize: 12, lineHeight: 1.55 }}>
          Refresh chats, choose the safe test chat, and create a preview. The send button stays disabled until the preview shows the current account and tenant and you approve this exact chat.
        </p>
        <label style={{ display: "grid", gap: 6, marginTop: 12, fontSize: 13 }}>
          Destination chat
          <select value={chatId} disabled={busy || chats.length === 0} onChange={(event) => { setChatId(event.target.value); invalidatePreview(); }} style={{ padding: 8, color: "inherit", background: "var(--ct-bg, #242424)" }}>
            <option value="">Choose the safe test chat by immutable id</option>
            {chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.topic || chat.id} · {chat.id}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 6, marginTop: 12, fontSize: 13 }}>
          Exact message text
          <textarea value={draft} rows={4} disabled={busy} onChange={(event) => { setDraft(event.target.value); invalidatePreview(); }} style={{ resize: "vertical", padding: 8, color: "inherit", background: "var(--ct-bg, #242424)", font: "inherit" }} />
        </label>
        <button style={{ ...buttonStyle, marginTop: 12 }} disabled={busy || !chatId || draft.length === 0} onClick={() => void makePreview()}>
          {busy ? "Working" : "Preview message"}
        </button>

        {preview && <div style={{ marginTop: 16, padding: 12, border: "1px solid var(--ct-border-default, rgba(255,255,255,.14))", borderRadius: 6 }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>Resolved preview</h3>
          <p style={{ margin: "6px 0", fontSize: 13 }}>Sender account: <strong>{preview.sender.upn}</strong> · account id <code>{preview.sender.accountId}</code></p>
          <p style={{ margin: "6px 0", fontSize: 13 }}>Tenant: <strong>{preview.tenant.id}</strong></p>
          <p style={{ margin: "6px 0", fontSize: 13 }}>Destination: <strong>{preview.destination.label}</strong> · immutable chat id <code>{preview.destination.id}</code></p>
          <p style={{ margin: "10px 0 4px", fontSize: 12, color: "var(--ct-muted, #9aa)" }}>Exact payload</p>
          <pre style={{ margin: 0, padding: 10, whiteSpace: "pre-wrap", overflowWrap: "anywhere", borderRadius: 4, background: "var(--ct-bg, #1d1d1d)", font: "inherit" }}>{preview.text}</pre>
          <p style={{ margin: "10px 0 4px", fontSize: 12 }}>Policy: {policyMatches ? "approved for this account, tenant, and one chat" : policy.configured ? "approved for a different sender, tenant, or chat" : "not set"}</p>
          <p style={{ margin: "6px 0", color: "var(--ct-muted, #9aa)", fontSize: 12 }}>m365 handles throttling retries internally and may pause for about 10 seconds or more without output. Wait for the result; a surfaced 429 or 503 is recorded as unknown because the message may already have arrived.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button style={buttonStyle} disabled={busy || !previewMatches || policyMatches} onClick={() => void approveDestination()}>
              {policy.configured ? "Approve this one chat" : "Approve this one chat"}
            </button>
            <button style={{ ...buttonStyle, background: "var(--ct-err, #b64d58)" }} disabled={!sendEnabled} onClick={() => void sendPreview()}>{sendInProgress ? "Sending — wait for m365" : "Send this exact message"}</button>
          </div>
          {sendResult && <pre role="status" style={{ marginTop: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{sendResult}</pre>}
        </div>}
      </section>

      <footer style={{ marginTop: 20, fontSize: 11, color: "var(--ct-muted, #9aa)" }}>
        Agent verbs: accounts, use, chats, history, health, preview, send, logout. The approved policy covers one sender, one tenant, and one immutable chat.
      </footer>
    </main>
  );
}

createRoot(document.getElementById("ct-root")!).render(<App />);
