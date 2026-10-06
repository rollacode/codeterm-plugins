import { useEffect, useRef, useState } from "react";
import { Actions, Btn, codeBlock, Disclosure, Field, inputStyle, Notice, pageStyle, Section, StatusBar, type Tone } from "./kit";
import { scopeIncludes, toggleScopeChat, type SendScope } from "../../../shared/src/send-scope";
import { accountLine, isSignedIn, sendStateLabel, setupRows, statusView, viewLayout, type AccountInfo, type LoginStepInfo, type SetupInfo, type ViewHealth } from "./status";

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
  loginJobId?: string | null;
  setup?: SetupInfo;
  account?: AccountInfo | null;
  loginStep?: LoginStepInfo | null;
  sendScope?: SendScope;
  sendState?: { state: string; failure?: string | null; message?: string | null; retryAfter?: number | null; destination?: unknown } | null;
};
type Preview = {
  previewId: string;
  sender: { id: string; displayName: string; username?: string | null; telegramUserId: string };
  destination: { id: string; label: string; type?: string; username?: string | null; phone?: string | null };
  text: string;
  allowed?: boolean;
  restriction?: string | null;
};
export type ChatRow = { id: string; title: string; type?: string; username?: string | null };
type ChatSearch = { query?: string; match?: ChatRow | null; ambiguous?: boolean; candidates?: ChatRow[]; chats?: ChatRow[] };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [twoFactorPassword, setTwoFactorPassword] = useState("");
  const [accountLabel, setAccountLabel] = useState("default");
  const [confirmed, setConfirmed] = useState(false);
  const [jobId, setJobId] = useState("");
  const [loginOutput, setLoginOutput] = useState("");
  const [polledStep, setPolledStep] = useState<LoginStepInfo | null>(null);
  const [replaceCredentials, setReplaceCredentials] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [chatId, setChatId] = useState("");
  const [sendText, setSendText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sendReceipt, setSendReceipt] = useState("");
  const [chatQuery, setChatQuery] = useState("");
  const [chatResults, setChatResults] = useState<ChatRow[] | null>(null);

  async function refresh() {
    setBusy(true);
    try {
      const result = await window.ct!.invoke("status") as Health;
      setHealth(result);
      if (result.loginJobId) setJobId(result.loginJobId);
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
      const credentials = showCredentialInputs ? { apiId, apiHash } : { apiId: "", apiHash: "" };
      const result = await window.ct!.invoke("loginStart", { ...credentials, accountLabel, twoFactorPassword }) as { jobId?: string; error?: string; message?: string };
      if (result.error) throw new Error(result.error);
      setJobId(result.jobId || "");
      setPolledStep(null);
      setReplaceCredentials(false);
      setLoginOutput("");
      setApiId("");
      setApiHash("");
      setTwoFactorPassword("");
      setHealth((current) => current ? { ...current, loginStep: null } : current);
      setMessage(result.message || "Login started. Select Show QR to view the code.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function applyLoginProgress(result: LoginProgress) {
    if (result.step) {
      setJobId("");
      setLoginOutput("");
      setPolledStep(result.step);
      setMessage("");
      return;
    }
    setPolledStep(null);
    setHealth((current) => current ? { ...current, loginStep: null } : current);
    setLoginOutput(result.output || "");
    if (result.error) {
      setJobId("");
      setMessage(result.error);
    } else if (result.done) {
      setJobId("");
      setMessage("Login finished. Refreshing the resolved Telegram account.");
      await refresh();
    } else {
      if (result.jobId) setJobId(result.jobId);
      setMessage("Login is running. Scan the QR; this page checks progress automatically.");
    }
  }

  async function pollLogin() {
    if (!jobId || busy) return;
    setBusy(true);
    try {
      await applyLoginProgress(await window.ct!.invoke("loginPoll", { jobId }) as LoginProgress);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(password: string) {
    setBusy(true);
    setMessage("");
    try {
      const result = await window.ct!.invoke("loginPassword", { password }) as LoginProgress;
      if (result.error && !result.step && !result.jobId) setMessage(result.error);
      else await applyLoginProgress(result);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  const pollRef = useRef(pollLogin);
  pollRef.current = pollLogin;
  useEffect(() => {
    if (!jobId || polledStep) return;
    const timer = setInterval(() => { void pollRef.current(); }, 3000);
    return () => clearInterval(timer);
  }, [jobId, polledStep]);

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
      setPolledStep(null);
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

  async function findChats() {
    setBusy(true);
    setMessage("");
    try {
      const result = await window.ct!.invoke("chats", { query: chatQuery }) as { result?: string; error?: string };
      if (result.error) throw new Error(result.error);
      const parsed = JSON.parse(result.result || "{}") as ChatSearch;
      setChatResults(parsed.candidates || parsed.chats || []);
      if (parsed.match) chooseChat(parsed.match);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  function chooseChat(chat: ChatRow) {
    setChatId(chat.id);
    setPreview(null);
    setSendReceipt("");
  }

  async function saveScope(scope: SendScope) {
    setBusy(true);
    setMessage("");
    try {
      const result = await window.ct!.invoke("setSendScope", scope) as { result?: string; error?: string };
      if (result.error) throw new Error(result.error);
      await refresh();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function sendPreview() {
    if (!preview) return;
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
  const layout = viewLayout(health, polledStep);
  const signedIn = isSignedIn(health?.state) && layout.primary === "account";
  const status = polledStep ? statusView(polledStep.kind === "password" ? "password-required" : "input-required") : statusView(health?.state);
  const showCredentialInputs = layout.credentialsNeeded || replaceCredentials;
  const previewMatchesInput = !!preview && preview.destination.id === chatId && preview.text === sendText;

  const loginForm = (
    <>
      <Disclosure summary="Where do I get the API ID and hash?">
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          <li>Open <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer">my.telegram.org</a> (copy: <code>https://my.telegram.org</code>) in your browser.</li>
          <li>Sign in with the phone number of the Telegram account you want to use here; Telegram sends the login code to that account in the Telegram app, not by SMS.</li>
          <li>Choose <strong>API development tools</strong>.</li>
          <li>If you have no application yet, fill in the form: <em>App title</em> and <em>Short name</em> can be anything (for example “CodeTerm” and “codeterm”), platform <em>Desktop</em>; URL and description may stay empty. Press <strong>Create application</strong>.</li>
          <li>Copy <strong>App api_id</strong> (a number) into “Telegram API ID” and <strong>App api_hash</strong> (32 characters) into “Telegram API hash” below.</li>
        </ol>
      </Disclosure>
      <div style={{ height: 12 }} />
      {showCredentialInputs ? (
        <>
          <Field label="Telegram API ID">
            <input style={inputStyle} value={apiId} inputMode="numeric" autoComplete="off" onChange={(event) => setApiId(event.target.value)} />
          </Field>
          <Field label="Telegram API hash">
            <input style={inputStyle} type="password" autoComplete="new-password" value={apiHash} onChange={(event) => setApiHash(event.target.value)} />
          </Field>
        </>
      ) : (
        <p style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 10px", fontSize: 12.5 }}>
          <span style={{ flex: 1 }}>Using the stored API ID and API hash.</span>
          <Btn onClick={() => setReplaceCredentials(true)}>Use different credentials</Btn>
        </p>
      )}
      <Field label="Account label">
        <input style={inputStyle} value={accountLabel} autoComplete="off" onChange={(event) => setAccountLabel(event.target.value)} />
      </Field>
      <Field label="Two-step verification password (optional)">
        <input style={inputStyle} type="password" autoComplete="new-password" value={twoFactorPassword} onChange={(event) => setTwoFactorPassword(event.target.value)} />
      </Field>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, margin: "4px 0 0", fontSize: 12, lineHeight: 1.45 }}>
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>I understand this client appears as Telegram Desktop (Windows), and I am entering my own Telegram API ID and hash.</span>
      </label>
      <Actions>
        <Btn kind="primary" disabled={busy || (showCredentialInputs && (!apiId || !apiHash)) || !confirmed} onClick={() => void startLogin()}>
          {busy ? "Working…" : "Start QR login"}
        </Btn>
        {jobId && <Btn disabled={busy} onClick={() => void pollLogin()}>Show QR</Btn>}
      </Actions>
      {loginOutput && <pre aria-label="Login progress" style={{ ...codeBlock, maxHeight: 280, overflow: "auto", background: "rgba(0,0,0,.24)" }}>{loginOutput}</pre>}
    </>
  );

  return (
    <main style={pageStyle}>
      <StatusBar label={status.label} tone={status.tone} detail={health?.message} busy={busy} onRefresh={() => void refresh()} />
      {message && <Notice>{message}</Notice>}
      <SetupSummary health={health} />

      {layout.primary === "step" && layout.step ? (
        <Section title="Finish signing in" hint="Telegram accepted the QR scan and needs one more step for this account.">
          <LoginStepForm step={layout.step} busy={busy} onSubmit={(password) => void submitPassword(password)} />
          <Disclosure summary="Start over with a new QR">{loginForm}</Disclosure>
        </Section>
      ) : signedIn ? (
        <Section title="Account" hint="Messages are sent from the account marked current.">
          {health?.account && <AccountSummary account={health.account} />}
          <AccountList accounts={accounts} busy={busy} onUse={(id) => void selectAccount(id)} />
          <Disclosure summary="Sign in another account">{loginForm}</Disclosure>
          <Actions>
            <Btn kind="danger" disabled={busy || !health?.currentAccount} onClick={() => void logout()}>Sign out</Btn>
          </Actions>
        </Section>
      ) : (
        <Section title="Sign in" hint="Sign in with a QR code from the Telegram app on your phone.">
          {accounts.length > 0 && <AccountList accounts={accounts} busy={busy} onUse={(id) => void selectAccount(id)} />}
          {loginForm}
        </Section>
      )}

      <Section title="Preview and send" hint={signedIn ? "Find a chat by name, review the resolved recipient and text, then send." : "Sign in first."}>
        <Field label="Find chat">
          <form style={{ display: "flex", gap: 8 }} onSubmit={(event) => { event.preventDefault(); void findChats(); }}>
            <input style={{ ...inputStyle, flex: 1 }} value={chatQuery} autoComplete="off" placeholder="Name or @username" disabled={!signedIn} onChange={(event) => setChatQuery(event.target.value)} />
            <Btn type="submit" disabled={busy || !signedIn}>Find</Btn>
          </form>
        </Field>
        {chatResults && <ChatResults chats={chatResults} selectedId={chatId} scope={health?.sendScope} busy={busy} onChoose={chooseChat} onScope={(scope) => void saveScope(scope)} />}
        <Field label="Chat id">
          <input style={inputStyle} value={chatId} autoComplete="off" placeholder="id:12345" disabled={!signedIn} onChange={(event) => { setChatId(event.target.value); setPreview(null); setSendReceipt(""); }} />
        </Field>
        <Field label="Message">
          <textarea style={{ ...inputStyle, minHeight: 82, resize: "vertical" }} value={sendText} disabled={!signedIn} onChange={(event) => { setSendText(event.target.value); setPreview(null); setSendReceipt(""); }} />
        </Field>
        {!preview && (
          <Actions>
            <Btn kind="primary" disabled={busy || !signedIn || !chatId || !sendText} onClick={() => void previewSend()}>Preview</Btn>
          </Actions>
        )}
        {preview && (
          <div aria-label="Resolved preview" role="group" style={{ marginTop: 12, padding: 12, borderRadius: 10, border: "1px solid var(--ct-border-default, rgba(255,255,255,.12))", fontSize: 12.5 }}>
            <p style={{ margin: "0 0 6px" }}>From <strong>{preview.sender.displayName}</strong> to <strong>{preview.destination.label}</strong>{preview.destination.username ? ` ${preview.destination.username}` : ""}{preview.destination.type ? ` (${preview.destination.type})` : ""}</p>
            <pre style={codeBlock}>{preview.text}</pre>
            <Disclosure summary="Identifiers">
              <p style={{ margin: 0 }}>Sender account <code>{preview.sender.id}</code>, Telegram user <code>{preview.sender.telegramUserId}</code></p>
              <p style={{ margin: "4px 0 0" }}>Destination <code>{preview.destination.id}</code></p>
              {preview.destination.phone && <p style={{ margin: "4px 0 0" }}>Phone <code>{preview.destination.phone}</code></p>}
            </Disclosure>
            <Actions>
              <Btn kind="primary" disabled={busy || !previewMatchesInput} onClick={() => void sendPreview()}>{busy ? "Working…" : "Send"}</Btn>
              <Btn disabled={busy} onClick={() => { setPreview(null); setSendReceipt(""); }}>Edit</Btn>
            </Actions>
          </div>
        )}
        {sendReceipt && <pre role="status" style={codeBlock}>{sendReceipt}</pre>}
        {health?.sendState && <p role="status" style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ct-muted, #9aa)" }}>Last send: <strong>{sendStateLabel(health.sendState.state)}</strong>{health.sendState.message ? `, ${health.sendState.message}` : ""}</p>}
      </Section>

      <Section title="Restrict agent sends" hint="Off by default: the agent can send to any chat this account can write to. Sends you make here are never restricted.">
        <SendScopeEditor scope={health?.sendScope} busy={busy} onSave={(scope) => void saveScope(scope)} />
      </Section>

      <Disclosure summary="Security details">
        {health?.storage && <p style={{ margin: "0 0 6px" }}>Session storage: {health.storage.name}. {health.storage.note}</p>}
        <p style={{ margin: "0 0 6px" }}>The pinned release identifies this device as Telegram Desktop (Windows) in Telegram’s Devices list. Your own API ID and hash replace the release binary’s shared application credentials for this account; the hash is kept in the host secret store, never in a file or a command line.</p>
        <p style={{ margin: "0 0 6px" }}>Every send is recorded in a local idempotency ledger, so a repeated key is never sent twice, and a send whose confirmation was lost is reported as unknown rather than delivered.</p>
        <p style={{ margin: "0 0 6px" }}>A two-step verification password typed here goes straight to the sign-in process and is never stored.</p>
        <p style={{ margin: 0 }}>Agent verbs: accounts, use, chats, history, health, login, login-status, login-password, logout, preview, send.</p>
      </Disclosure>
    </main>
  );
}

function AccountList({ accounts, busy, onUse }: { accounts: Account[]; busy: boolean; onUse: (id: string) => void }) {
  return (
    <ul aria-label="Accounts" style={{ listStyle: "none", margin: "0 0 4px", padding: 0, display: "grid", gap: 6 }}>
      {accounts.map((account) => (
        <li key={account.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--ct-border-subtle, rgba(255,255,255,.08))", fontSize: 12.5 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong>{account.label}</strong>
            <span style={{ color: "var(--ct-muted, #9aa)" }}>{account.current ? " (current)" : account.hasSession ? "" : " (signed out)"}</span>
          </span>
          {!account.current && <Btn disabled={busy || !account.hasSession} onClick={() => onUse(account.id)}>Use</Btn>}
        </li>
      ))}
    </ul>
  );
}

type LoginProgress = { done?: boolean; output?: string; error?: string; state?: string; jobId?: string; step?: LoginStepInfo | null };

const ROW_TONE: Record<Tone, string> = {
  ok: "var(--ct-ok, var(--ct-green, #4caf50))",
  warn: "var(--ct-warn, #e0a030)",
  danger: "var(--ct-err, var(--ct-red, #e57373))",
  accent: "var(--ct-accent, #5b8cff)",
  muted: "var(--ct-muted, #9aa)",
};

export function SetupSummary({ health }: { health: ViewHealth | null }) {
  return (
    <dl aria-label="Setup" style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 14px", margin: "0 0 4px", fontSize: 12.5 }}>
      {setupRows(health).map((row) => (
        <div key={row.label} style={{ display: "contents" }}>
          <dt style={{ color: "var(--ct-muted, #9aa)" }}>{row.label}</dt>
          <dd data-tone={row.tone} style={{ margin: 0, color: ROW_TONE[row.tone] }}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AccountSummary({ account }: { account: AccountInfo }) {
  const detail = accountLine({ ...account, name: null });
  return (
    <p aria-label="Signed-in account" style={{ margin: "0 0 10px", fontSize: 12.5 }}>
      <strong>{account.name || account.label}</strong>
      {detail && detail !== account.label && <span style={{ color: "var(--ct-muted, #9aa)" }}> {detail}</span>}
    </p>
  );
}

export function LoginStepForm({ step, busy, onSubmit }: { step: LoginStepInfo; busy: boolean; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("");
  if (!step.submittable) {
    return (
      <p role="alert" style={{ margin: 0, fontSize: 12.5 }}>
        Telegram asked: <strong>{step.prompt}</strong>. This sign-in client cannot take that step outside an interactive terminal, so start over with a new QR.
      </p>
    );
  }
  return (
    <form onSubmit={(event) => { event.preventDefault(); if (value) { onSubmit(value); setValue(""); } }}>
      {step.hint && <p role="alert" style={{ margin: "0 0 8px", fontSize: 12.5, color: ROW_TONE.warn }}>{step.hint}</p>}
      <Field label={step.prompt}>
        <input style={inputStyle} type="password" autoComplete="current-password" value={value} onChange={(event) => setValue(event.target.value)} />
      </Field>
      <Actions>
        <Btn kind="primary" type="submit" disabled={busy || !value}>{busy ? "Working…" : "Continue"}</Btn>
      </Actions>
    </form>
  );
}

export { toggleScopeChat };

export function ChatResults({ chats, selectedId, scope, busy, onChoose, onScope }: {
  chats: ChatRow[]; selectedId: string; scope?: SendScope; busy: boolean; onChoose: (chat: ChatRow) => void; onScope: (scope: SendScope) => void;
}) {
  if (!chats.length) return <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--ct-muted, #9aa)" }}>No matching chats among the 100 most recent.</p>;
  const restricted = scope?.mode === "only";
  return (
    <ul aria-label="Matching chats" style={{ listStyle: "none", margin: "0 0 10px", padding: 0, display: "grid", gap: 6 }}>
      {chats.map((chat) => (
        <li key={chat.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--ct-border-subtle, rgba(255,255,255,.08))", fontSize: 12.5 }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong>{chat.title || chat.id}</strong>
            <span style={{ color: "var(--ct-muted, #9aa)" }}>{chat.username ? ` ${chat.username}` : ""}{chat.type ? ` · ${chat.type}` : ""} · {chat.id}</span>
          </span>
          {restricted && <Btn disabled={busy} onClick={() => onScope(toggleScopeChat(scope, chat))}>{scopeIncludes(scope, chat.id) ? "Remove from agent list" : "Allow for agent"}</Btn>}
          <Btn kind={chat.id === selectedId ? "primary" : "ghost"} disabled={busy} onClick={() => onChoose(chat)}>{chat.id === selectedId ? "Selected" : "Select"}</Btn>
        </li>
      ))}
    </ul>
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
                <span style={{ flex: 1 }}><strong>{chat.title || chat.id}</strong> <span style={{ color: "var(--ct-muted, #9aa)" }}>{chat.id}</span></span>
                <Btn disabled={busy} onClick={() => onSave({ mode: "only", chats: chats.filter((item) => item.id !== chat.id) })}>Remove</Btn>
              </li>
            ))}
          </ul>
        ) : <p style={{ margin: 0, color: "var(--ct-warn, #e0a030)" }}>No chats on the list yet, so the agent cannot send anywhere. Find a chat above and choose Allow for agent.</p>
      )}
    </div>
  );
}
