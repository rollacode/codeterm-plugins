// Bitwarden connection panel — the plugin's own UI, rendered in the host's
// sandboxed iframe. Talks to the plugin (its secret methods) via window.ct.
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Tone = "ok" | "warn" | "danger" | "muted";
declare global {
  interface Window {
    ct?: { invoke(method: string, args?: unknown): Promise<unknown>; close?(): void };
  }
}
const ct = () => window.ct!;

const COLOR: Record<Tone, string> = {
  ok: "var(--ct-ok, #4caf50)",
  warn: "var(--ct-warn, #e0a030)",
  danger: "var(--ct-err, #e57373)",
  muted: "var(--ct-muted, #9aa)",
};

function Badge({ tone, label }: { tone: Tone; label: string }) {
  const c = COLOR[tone];
  return (
    <span style={{ fontSize: 11, fontWeight: 560, padding: "2px 9px", borderRadius: 999, color: c, background: `color-mix(in srgb, ${c} 16%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}>
      {label}
    </span>
  );
}

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span style={{
      display: "inline-block", width: size, height: size, flex: "none",
      border: "2px solid color-mix(in srgb, var(--ct-fg, #eee) 22%, transparent)",
      borderTopColor: "var(--ct-accent, #5b8cff)", borderRadius: "50%",
      animation: "ctbw-spin 0.7s linear infinite",
    }} />
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", background: "var(--ct-bg-elev, rgba(255,255,255,0.03))",
  border: "1px solid var(--ct-border-default, rgba(255,255,255,0.12))", borderRadius: 6,
  padding: "7px 9px", color: "var(--ct-fg, #eee)", fontSize: 12.5,
};
const btnStyle: React.CSSProperties = {
  font: "inherit", fontSize: 12.5, fontWeight: 540, padding: "6px 14px", borderRadius: 6,
  border: "none", background: "var(--ct-accent, #5b8cff)", color: "#fff", cursor: "pointer", whiteSpace: "nowrap",
};

function RememberToggle({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, color: COLOR.muted, cursor: disabled ? "default" : "pointer" }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      Remember master password for auto-unlock
    </label>
  );
}

function conciseReason(reason: string | null | undefined): string {
  if (!reason) return "The Bitwarden connection failed.";
  const first = reason.split(/\n|\sat\sClientRequest|\sat\sTLSSocket/)[0].trim();
  return first.length > 240 ? `${first.slice(0, 237)}…` : first;
}

interface Status {
  status: "unlocked" | "locked" | "logged_out" | "unavailable";
  user?: string | null;
  endpoint?: string | null;
  reason?: string | null;
}

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [email, setEmail] = useState("");
  const [master, setMaster] = useState("");
  const [twoFactor, setTwoFactor] = useState("");
  const [apiClientId, setApiClientId] = useState("");
  const [apiClientSecret, setApiClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);

  // Server URL is a cheap read — fetch it on its own so the panel paints at once.
  const refreshServer = useCallback(async () => {
    try {
      const su = await ct().invoke("serverUrl");
      setServerUrl((su as { url?: string })?.url ?? "");
    } catch {
      /* leave the field empty; the status probe surfaces real errors */
    }
  }, []);

  // The standing consent answer, owned by the plugin and never inferred here.
  const refreshConsent = useCallback(async () => {
    try {
      const c = await ct().invoke("autoUnlockConsent");
      setRemember((c as { enabled?: boolean })?.enabled === true);
    } catch {
      setRemember(false);
    }
  }, []);

  // `bw status` can take up to 30s, so it must not block the first paint. Run it
  // as a host exec job and poll, leaving the UI responsive the whole time.
  const refreshStatus = useCallback(async () => {
    try {
      const started = (await ct().invoke("statusStart")) as { jobId?: string; error?: string };
      if (started?.error || !started?.jobId) {
        // Fall back to the synchronous path if the async one is unavailable.
        setStatus((await ct().invoke("status")) as Status);
        return;
      }
      const jobId = started.jobId;
      for (let i = 0; i < 130; i++) {
        const p = (await ct().invoke("statusPoll", { jobId })) as { done: boolean; status?: Status; error?: string };
        if (p?.error) throw new Error(p.error);
        if (p?.done) {
          if (p.status) setStatus(p.status);
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, []);

  const refresh = useCallback(async () => {
    await refreshServer();
    await refreshConsent();
    await refreshStatus();
  }, [refreshServer, refreshConsent, refreshStatus]);

  // Paint immediately: kick the cheap server read and the deferred status probe
  // independently so neither blocks the other or the initial render.
  useEffect(() => {
    void refreshServer();
    void refreshConsent();
    void refreshStatus();
  }, [refreshServer, refreshConsent, refreshStatus]);

  const st = status?.status;
  const hasApiKey = !!apiClientId.trim() && !!apiClientSecret.trim();
  const canSubmit = !!master && (!!email.trim() || hasApiKey || st === "locked");
  // An unlock the user did not ask to be remembered sends false and stores nothing.
  const doUnlock = () => run(() => ct().invoke("unlock", {
    masterPassword: master,
    email: email.trim() || undefined,
    twoFactorToken: twoFactor.trim() || undefined,
    apiKeyClientId: apiClientId.trim() || undefined,
    apiKeyClientSecret: apiClientSecret.trim() || undefined,
    persistForAutoUnlock: remember,
  }), "unlock");

  // Every toggle routes here: OFF revokes synchronously, and refresh() restores
  // the checkbox from durable state if the verb failed.
  const changeConsent = (enabled: boolean) => {
    setRemember(enabled);
    void run(() => ct().invoke("setAutoUnlockConsent", { enabled }), enabled ? "remember password" : "forget password");
  };

  const run = useCallback(async (fn: () => Promise<unknown>, errPrefix: string) => {
    setBusy(true);
    setError(null);
    try {
      const r: any = await fn();
      if (r && r.error) throw new Error(r.error.message || r.error.kind || String(r.error));
      await refresh();
    } catch (e) {
      setError(`${errPrefix}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 18, color: "var(--ct-fg, #eee)", background: "var(--ct-bg, #14141c)" }}>
      <style>{"@keyframes ctbw-spin{to{transform:rotate(360deg)}}"}</style>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ct-muted, #9aa)", marginBottom: 8 }}>Server</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        <input style={inputStyle} value={serverUrl} placeholder="https://vault.bitwarden.com"
          onChange={(e) => setServerUrl(e.target.value)}
          onBlur={() => void run(() => ct().invoke("setServerUrl", { url: serverUrl }), "save URL")} />
      </div>

      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ct-muted, #9aa)", marginBottom: 8 }}>Connection</div>
      {/* Reserve height so the panel doesn't jump when the deferred status lands. */}
      <div style={{ minHeight: 132 }}>
      {!status ? (
        <span style={{ color: COLOR.muted, fontSize: 12.5 }}>Checking status…</span>
      ) : st === "unlocked" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Badge tone="ok" label={`Unlocked${status.user ? ` · ${status.user}` : ""}`} />
            <button style={{ ...btnStyle, background: "rgba(255,255,255,0.08)" }} disabled={busy}
              onClick={() => void run(() => ct().invoke("signout"), "sign out")}>Sign out</button>
          </div>
          <RememberToggle checked={remember} disabled={busy} onChange={changeConsent} />
        </div>
      ) : st === "unavailable" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Badge tone="danger" label="Unavailable" />
          <span style={{ color: COLOR.muted, fontSize: 11.5 }}>{conciseReason(status.reason)}</span>
          <div>
            <button style={btnStyle} disabled={busy}
              onClick={() => void run(() => ct().invoke("resetConnection"), "reset connection")}>
              {busy ? "Resetting…" : "Sign in again"}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Badge tone={st === "locked" ? "warn" : "danger"} label={st === "locked" ? "Locked" : "Not signed in"} />
          <span style={{ color: COLOR.muted, fontSize: 11.5 }}>
            Enter your Bitwarden email + master password, or API-key credentials, to sign in and unlock.
          </span>
          <input style={inputStyle} type="email" autoComplete="username" placeholder="Bitwarden email"
            value={email} onChange={(e) => setEmail(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <input style={inputStyle} type="password" autoComplete="current-password" placeholder="Master password"
              value={master} onChange={(e) => setMaster(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canSubmit && !busy) void doUnlock(); }} />
            <button style={btnStyle} disabled={busy || !canSubmit} onClick={() => void doUnlock()}>
              {busy ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Spinner size={12} /> Signing in…</span> : st === "locked" ? "Unlock" : "Sign in"}
            </button>
          </div>
          <input style={inputStyle} inputMode="numeric" placeholder="2FA code (if enabled)"
            value={twoFactor} onChange={(e) => setTwoFactor(e.target.value)} />
          <input style={inputStyle} autoComplete="off" placeholder="API key client_id (optional)"
            value={apiClientId} onChange={(e) => setApiClientId(e.target.value)} />
          <input style={inputStyle} type="password" autoComplete="off" placeholder="API key client_secret (optional)"
            value={apiClientSecret} onChange={(e) => setApiClientSecret(e.target.value)} />
          <RememberToggle checked={remember} disabled={busy} onChange={changeConsent} />
          {busy && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
              <Spinner />
              <span style={{ color: COLOR.muted, fontSize: 11.5 }}>Signing in to Bitwarden — this can take 20–30s for a self-hosted server…</span>
            </div>
          )}
        </div>
      )}
      </div>
      {error && <div style={{ color: COLOR.danger, fontSize: 12, marginTop: 10 }}>{error}</div>}
    </div>
  );
}

const el = document.getElementById("ct-root");
if (el) createRoot(el).render(<App />);
