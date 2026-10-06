import { useEffect, useRef, useState } from "react";
import { Actions, Btn, codeBlock, Disclosure, Field, inputStyle, Notice, pageStyle, Section, StatusBar, type Tone } from "./kit";
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
  const layout = viewLayout(health, polledStep);
  const signedIn = isSignedIn(health?.state) && layout.primary === "account";
  const status = polledStep ? statusView(polledStep.kind === "password" ? "password-required" : "input-required") : statusView(health?.state);
  const showCredentialInputs = layout.credentialsNeeded || replaceCredentials;
  const policyAllowsPreview = !!preview && !!health?.sendPolicy?.configured &&
    health.sendPolicy.senderAccountId === preview.sender.id &&
    health.sendPolicy.allowedDestinations?.some((item) => item.id === preview.destination.id);
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

      <Section title="Preview and send" hint={signedIn ? "Review the resolved sender and destination before anything is sent. Only Saved Messages can be approved." : "Sign in first. Sending stays locked until you review a resolved preview."}>
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
            <p style={{ margin: "0 0 6px" }}>From <strong>{preview.sender.displayName}</strong> to <strong>{preview.destination.label}</strong></p>
            <pre style={codeBlock}>{preview.text}</pre>
            <Disclosure summary="Identifiers">
              <p style={{ margin: 0 }}>Sender account <code>{preview.sender.id}</code>, Telegram user <code>{preview.sender.telegramUserId}</code></p>
              <p style={{ margin: "4px 0 0" }}>Destination <code>{preview.destination.id}</code></p>
              <p style={{ margin: "4px 0 0" }}>Policy: {preview.policy?.configured ? "Saved Messages only" : "not set"}</p>
            </Disclosure>
            <Actions>
              {preview.destination.label === "Saved Messages" && !health?.sendPolicy?.configured
                ? <Btn kind="primary" disabled={busy || !previewMatchesInput} onClick={() => void enableSavedMessagesPolicy()}>Allow sending to Saved Messages</Btn>
                : <Btn kind="primary" disabled={busy || !previewMatchesInput || !policyAllowsPreview} onClick={() => void sendPreview()}>{busy ? "Working…" : "Send"}</Btn>}
              <Btn disabled={busy} onClick={() => { setPreview(null); setSendReceipt(""); }}>Edit</Btn>
            </Actions>
          </div>
        )}
        {sendReceipt && <pre role="status" style={codeBlock}>{sendReceipt}</pre>}
        {health?.sendState && <p role="status" style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ct-muted, #9aa)" }}>Last send: <strong>{sendStateLabel(health.sendState.state)}</strong>{health.sendState.message ? `, ${health.sendState.message}` : ""}</p>}
      </Section>

      <Disclosure summary="Security details">
        {health?.storage && <p style={{ margin: "0 0 6px" }}>Session storage: {health.storage.name}. {health.storage.note}</p>}
        <p style={{ margin: "0 0 6px" }}>The pinned release identifies this device as Telegram Desktop (Windows) in Telegram’s Devices list. Your own API ID and hash replace the release binary’s shared application credentials for this account; the hash is kept in the host secret store, never in a file or a command line.</p>
        <p style={{ margin: "0 0 6px" }}>Sending is locked until you review a resolved sender and immutable destination. The initial owner policy permits Saved Messages only.</p>
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
