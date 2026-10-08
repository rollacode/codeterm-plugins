import { useEffect, useState } from "react";
import { Actions, Btn, codeBlock, Disclosure, Field, inputStyle, Notice, pageStyle, Section, StatusBar, type Tone } from "./kit";
import { matchChats, scopeIncludes, toggleScopeChat, type SendScope } from "../../../shared/src/send-scope";
import { isSignedIn, primarySection, sendGate, setupRows, statusView } from "./status";

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

export type Health = {
  state: string;
  message: string;
  accountId?: string | null;
  tenantId?: string | null;
  upn?: string | null;
  expiresOn?: string | null;
  loginJobId?: string | null;
};

export type Chat = { id: string; title: string; topic?: string | null; chatType?: string | null; members?: string[]; username?: string | null };
export type SendPreview = {
  previewId: string;
  idempotencyKey: string;
  sender: { id: string; accountId: string; upn: string; tenantId: string; identityKey: string };
  tenant: { id: string };
  destination: { id: string; label: string; chatType?: string | null; members?: string[] };
  text: string;
  allowed?: boolean;
  restriction?: string | null;
};

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState("");
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [scope, setScope] = useState<SendScope>({ mode: "all" });
  const [chatQuery, setChatQuery] = useState("");
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
      if (current.loginJobId) setJobId(current.loginJobId);
      const listed = await window.ct!.invoke("accounts") as { accounts?: Account[]; error?: string };
      setAccounts(Array.isArray(listed.accounts) ? listed.accounts : []);
      const chatResult = await window.ct!.invoke("chats") as { result?: string; error?: string };
      const parsedChats = chatResult.result ? JSON.parse(chatResult.result) as { chats?: Chat[] } : { chats: [] };
      const nextChats = Array.isArray(parsedChats.chats) ? parsedChats.chats : [];
      setChats(nextChats);
      setChatId((currentId) => nextChats.some((chat) => chat.id === currentId) ? currentId : "");
      if (chatResult.error) setMessage(chatResult.error);
      const currentScope = await window.ct!.invoke("sendScope") as SendScope;
      setScope(currentScope && currentScope.mode ? currentScope : { mode: "all" });
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
        jobId?: string;
        state?: string;
        error?: string;
        message?: string;
      };
      if (result.done) setJobId("");
      else if (result.jobId) setJobId(result.jobId);
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

  async function saveScope(next: SendScope) {
    setBusy(true);
    setMessage("");
    try {
      const response = await window.ct!.invoke("setSendScope", next) as { result?: string; error?: string };
      if (response.error) throw new Error(response.error);
      if (response.result) setScope(JSON.parse(response.result) as SendScope);
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

  const signedIn = isSignedIn(health?.state);
  const section = primarySection(health?.state);
  const status = statusView(health?.state);
  const { previewMatches, sendEnabled } = sendGate({ preview, chatId, draft, health, busy, blockedKey, sendResult });
  const shownChats = chatQuery.trim() ? matchChats(chats, chatQuery, 50).candidates : chats;
  const selectedChat = chats.find((chat) => chat.id === chatId) || null;

  return (
    <main style={pageStyle}>
      <StatusBar label={status.label} tone={status.tone} detail={health?.message} busy={busy} onRefresh={() => void refresh()} />
      {message && <Notice>{message}</Notice>}
      <SetupSummary health={health} />

      {section === "account" ? (
        <Section title="Account">
          {health?.expiresOn && (
            <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px", margin: 0, fontSize: 12.5 }}>
              <dt style={termStyle}>Token expires</dt><dd style={{ margin: 0 }}>{health.expiresOn}</dd>
            </dl>
          )}
          {accounts.length > 1 && <div style={{ marginTop: 12 }}><AccountList accounts={accounts} busy={busy} onUse={(id) => void useAccount(id)} /></div>}
          <Actions>
            <Btn kind="danger" disabled={busy} onClick={() => void logout()}>Sign out</Btn>
          </Actions>
        </Section>
      ) : section === "unknown" ? null : (
        <Section title="Sign in" hint="Use your Microsoft 365 work or school account. Sign-in opens in your browser.">
          {accounts.length > 0 && <AccountList accounts={accounts} busy={busy} onUse={(id) => void useAccount(id)} />}
          <Actions>
            {jobId
              ? <Btn kind="primary" disabled={busy} onClick={() => void checkLogin()}>Check sign-in status</Btn>
              : <Btn kind="primary" disabled={busy} onClick={() => void startLogin()}>{busy ? "Working…" : "Sign in with browser"}</Btn>}
          </Actions>
        </Section>
      )}

      <Section title="Preview and send" hint={signedIn ? "Pick a chat, preview the message, then send." : "Sign in first to load your chats."}>
        <Field label="Find chat">
          <input value={chatQuery} autoComplete="off" placeholder="Name, topic, or email" disabled={busy || chats.length === 0} onChange={(event) => setChatQuery(event.target.value)} style={inputStyle} />
        </Field>
        <Field label="Chat">
          <select value={chatId} disabled={busy || chats.length === 0} onChange={(event) => { setChatId(event.target.value); invalidatePreview(); }} style={inputStyle}>
            <option value="">{chats.length === 0 ? "No chats loaded" : shownChats.length === 0 ? "No matching chats" : "Choose a chat"}</option>
            {shownChats.map((chat) => <option key={chat.id} value={chat.id}>{chatLabel(chat)}</option>)}
          </select>
        </Field>
        {scope.mode === "only" && selectedChat && (
          <Actions>
            <Btn disabled={busy} onClick={() => void saveScope(toggleScopeChat(scope, selectedChat))}>{scopeIncludes(scope, selectedChat.id) ? "Remove from agent list" : "Allow for agent"}</Btn>
          </Actions>
        )}
        <Field label="Message">
          <textarea value={draft} rows={4} disabled={busy || !signedIn} onChange={(event) => { setDraft(event.target.value); invalidatePreview(); }} style={{ ...inputStyle, resize: "vertical" }} />
        </Field>
        {!preview && (
          <Actions>
            <Btn kind="primary" disabled={busy || !chatId || draft.length === 0} onClick={() => void makePreview()}>{busy ? "Working…" : "Preview"}</Btn>
          </Actions>
        )}

        {preview && (
          <PreviewCard
            preview={preview}
            previewMatches={previewMatches}
            sendEnabled={sendEnabled}
            busy={busy}
            sendInProgress={sendInProgress}
            sendResult={sendResult}
            onSend={() => void sendPreview()}
            onEdit={invalidatePreview}
          />
        )}
      </Section>

      <Section title="Restrict agent sends" hint="Off by default: the agent can send to any chat this account can write to. Sends you make here are never restricted.">
        <SendScopeEditor scope={scope} busy={busy} onSave={(next) => void saveScope(next)} />
      </Section>

      <Disclosure summary="Security details">
        <p style={{ margin: "0 0 6px" }}>If your tenant allows user consent, approve the m365 permissions in the browser. If it restricts user consent, a tenant administrator must approve those permissions once. This plugin does not create an Entra app registration.</p>
        <p style={{ margin: "0 0 6px" }}>Every send is recorded in a local idempotency ledger, so a repeated key is never sent twice, and a send without a Graph message id is reported as unknown rather than delivered.</p>
        <p style={{ margin: "0 0 6px" }}>m365 retries throttling internally. A surfaced 429 or 503 is recorded as unknown because the message may already have arrived.</p>
        <p style={{ margin: 0 }}>Agent verbs: accounts, use, chats, history, health, preview, send, logout.</p>
      </Disclosure>
    </main>
  );
}

export function chatLabel(chat: Chat): string {
  const kind = chat.chatType === "oneOnOne" ? "1:1" : chat.chatType === "group" ? "group" : chat.chatType === "meeting" ? "meeting" : "";
  return kind ? `${chat.title} · ${kind}` : chat.title;
}

export function PreviewCard({ preview, previewMatches, sendEnabled, busy, sendInProgress, sendResult, onSend, onEdit }: {
  preview: SendPreview;
  previewMatches: boolean;
  sendEnabled: boolean;
  busy: boolean;
  sendInProgress: boolean;
  sendResult: string;
  onSend: () => void;
  onEdit: () => void;
}) {
  return (
        <div aria-label="Resolved preview" role="group" style={{ marginTop: 12, padding: 12, borderRadius: 10, border: "1px solid var(--ct-border-default, rgba(255,255,255,.12))", fontSize: 12.5 }}>
          <p style={{ margin: "0 0 6px" }}>From <strong>{preview.sender.upn}</strong> to <strong>{preview.destination.label}</strong></p>
          <pre style={codeBlock}>{preview.text}</pre>
          <Disclosure summary="Identifiers">
            <p style={{ margin: 0 }}>Sender account <code>{preview.sender.accountId}</code></p>
            <p style={{ margin: "4px 0 0" }}>Tenant <code>{preview.tenant.id}</code></p>
            <p style={{ margin: "4px 0 0" }}>Chat <code>{preview.destination.id}</code></p>
          </Disclosure>
          {preview.allowed === false && <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ct-warn, #e0a030)" }}>The agent may not send to this chat under Restrict agent sends; your own send from here is allowed.</p>}
          <Actions>
            <Btn kind="primary" disabled={!sendEnabled} onClick={onSend}>{sendInProgress ? "Sending…" : "Send"}</Btn>
            <Btn disabled={busy} onClick={onEdit}>Edit</Btn>
          </Actions>
          {previewMatches && <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ct-muted, #9aa)" }}>Sending can pause for 10 seconds or more while Microsoft throttles. Wait for the result.</p>}
          {sendResult && <pre role="status" style={codeBlock}>{sendResult}</pre>}
        </div>
  );
}

export function SendScopeEditor({ scope, busy, onSave }: { scope?: SendScope; busy: boolean; onSave: (scope: SendScope) => void }) {
  const mode = scope?.mode || "all";
  const chats = scope && scope.mode === "only" ? scope.chats : [];
  return (
    <div role="radiogroup" aria-label="Agent send restriction" style={{ display: "grid", gap: 8, fontSize: 12.5 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="radio" name="send-scope" checked={mode === "all"} disabled={busy} onChange={() => onSave({ mode: "all" })} />
        <span>All chats (default)</span>
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="radio" name="send-scope" checked={mode === "only"} disabled={busy} onChange={() => onSave({ mode: "only", chats })} />
        <span>Only these chats</span>
      </label>
      {mode === "only" && (
        chats.length ? (
          <ul aria-label="Chats the agent may send to" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {chats.map((chat) => (
              <li key={chat.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}><strong>{chat.title || chat.id}</strong> <span style={{ color: "var(--ct-muted, #9aa)" }}>{chat.id}</span></span>
                <Btn disabled={busy} onClick={() => onSave({ mode: "only", chats: chats.filter((item) => item.id !== chat.id) })}>Remove</Btn>
              </li>
            ))}
          </ul>
        ) : <p style={{ margin: 0, color: "var(--ct-warn, #e0a030)" }}>No chats on the list yet, so the agent cannot send anywhere. Pick a chat above and choose Allow for agent.</p>
      )}
    </div>
  );
}

const termStyle = { color: "var(--ct-muted, #9aa)" };

function AccountList({ accounts, busy, onUse }: { accounts: Account[]; busy: boolean; onUse: (id: string) => void }) {
  return (
    <ul aria-label="Accounts" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
      {accounts.map((account) => (
        <li key={account.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--ct-border-subtle, rgba(255,255,255,.08))", fontSize: 12.5 }}>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            <strong>{account.upn || account.id}</strong>
            <span style={{ color: "var(--ct-muted, #9aa)" }}>{account.active ? " (current)" : ""}</span>
          </span>
          {!account.active && <Btn disabled={busy} onClick={() => onUse(account.id)}>Use</Btn>}
        </li>
      ))}
    </ul>
  );
}

const ROW_TONE: Record<Tone, string> = {
  ok: "var(--ct-ok, var(--ct-green, #4caf50))",
  warn: "var(--ct-warn, #e0a030)",
  danger: "var(--ct-err, var(--ct-red, #e57373))",
  accent: "var(--ct-accent, #5b8cff)",
  muted: "var(--ct-muted, #9aa)",
};

export function SetupSummary({ health }: { health: Health | null }) {
  return (
    <dl aria-label="Setup" style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 14px", margin: "0 0 4px", fontSize: 12.5 }}>
      {setupRows(health).map((row) => (
        <div key={row.label} style={{ display: "contents" }}>
          <dt style={termStyle}>{row.label}</dt>
          <dd data-tone={row.tone} style={{ margin: 0, overflowWrap: "anywhere", color: ROW_TONE[row.tone] }}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
