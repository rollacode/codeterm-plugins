import { humanizeState, type Tone } from "./kit";
import type { Health, SendPreview } from "./app";

const STATES: Record<string, { label: string; tone: Tone }> = {
  "logged-in": { label: "Signed in", tone: "ok" },
  "logged-out": { label: "Signed out", tone: "muted" },
  "not-logged-in": { label: "Signed out", tone: "muted" },
  "installed-not-configured": { label: "Not set up", tone: "warn" },
  "login-in-progress": { label: "Signing in", tone: "accent" },
  "install-in-progress": { label: "Installing", tone: "accent" },
  "reauth-needed": { label: "Sign in again", tone: "warn" },
  "status-unavailable": { label: "Status unavailable", tone: "warn" },
  "token-expired": { label: "Sign in again", tone: "warn" },
  "refresh-token-revoked": { label: "Sign in again", tone: "warn" },
  "mfa-required": { label: "MFA required", tone: "warn" },
  "consent-not-granted": { label: "Consent needed", tone: "warn" },
  "conditional-access-blocked": { label: "Blocked by policy", tone: "danger" },
  "browser-open-failed": { label: "Browser did not open", tone: "danger" },
  "not-installed": { label: "Node.js needed", tone: "warn" },
  "install-failed": { label: "Install failed", tone: "danger" },
  "storage-protection-failed": { label: "Storage error", tone: "danger" },
  "unsupported-platform": { label: "Unsupported system", tone: "danger" },
};

export function statusView(state: string | null | undefined): { label: string; tone: Tone } {
  if (!state) return { label: "Checking", tone: "muted" };
  return STATES[state] ?? { label: humanizeState(state), tone: "muted" };
}

export function isSignedIn(state: string | null | undefined): boolean {
  return state === "logged-in";
}

export function sendGate({ preview, chatId, draft, health, busy, blockedKey, sendResult }: {
  preview: SendPreview | null;
  chatId: string;
  draft: string;
  health: Health | null;
  busy: boolean;
  blockedKey: string;
  sendResult: string;
}): { previewMatches: boolean; sendEnabled: boolean } {
  const previewMatches = !!preview && preview.destination.id === chatId && preview.text === draft &&
    health?.state === "logged-in" && preview.sender.accountId === health.accountId && preview.sender.tenantId === health.tenantId;
  const sendEnabled = !busy && previewMatches && blockedKey !== preview?.idempotencyKey && !sendResult;
  return { previewMatches, sendEnabled };
}

const RUNTIME_MISSING = ["not-installed", "install-failed", "install-in-progress", "unsupported-platform"];

export type SetupRow = { label: string; value: string; tone: Tone };

export function setupRows(health: Pick<Health, "state" | "upn" | "tenantId" | "expiresOn"> | null | undefined): SetupRow[] {
  const state = health?.state;
  const runtimeReady = !!state && !RUNTIME_MISSING.includes(state);
  const signedIn = isSignedIn(state);
  return [
    { label: "m365 runtime", value: !state ? "Checking" : runtimeReady ? "Installed" : "Not installed", tone: runtimeReady ? "ok" : "warn" },
    { label: "Account", value: signedIn ? health?.upn || "Signed in" : "Not signed in", tone: signedIn ? "ok" : "muted" },
    { label: "Tenant", value: signedIn && health?.tenantId ? health.tenantId : signedIn ? "Not reported yet" : "—", tone: signedIn && health?.tenantId ? "ok" : "muted" },
  ];
}

export function primarySection(state: string | null | undefined): "account" | "sign-in" | "unknown" {
  if (isSignedIn(state)) return "account";
  return state === "status-unavailable" || !state ? "unknown" : "sign-in";
}
