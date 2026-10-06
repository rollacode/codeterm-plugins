import { humanizeState, type Tone } from "./kit";
import type { Health, SendPolicy, SendPreview } from "./app";

const STATES: Record<string, { label: string; tone: Tone }> = {
  "logged-in": { label: "Signed in", tone: "ok" },
  "logged-out": { label: "Signed out", tone: "muted" },
  "not-logged-in": { label: "Signed out", tone: "muted" },
  "installed-not-configured": { label: "Not set up", tone: "warn" },
  "login-in-progress": { label: "Signing in", tone: "accent" },
  "install-in-progress": { label: "Installing", tone: "accent" },
  "reauth-needed": { label: "Sign in again", tone: "warn" },
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

export function sendGate({ preview, chatId, draft, health, policy, busy, blockedKey, sendResult }: {
  preview: SendPreview | null;
  chatId: string;
  draft: string;
  health: Health | null;
  policy: SendPolicy;
  busy: boolean;
  blockedKey: string;
  sendResult: string;
}): { previewMatches: boolean; policyMatches: boolean; sendEnabled: boolean } {
  const previewMatches = !!preview && preview.destination.id === chatId && preview.text === draft &&
    health?.state === "logged-in" && preview.sender.accountId === health.accountId && preview.sender.tenantId === health.tenantId;
  const policyMatches = !!preview && policy.configured && policy.senderAccountId === preview.sender.accountId &&
    policy.senderTenantId === preview.sender.tenantId && policy.allowedDestinations.some((item) => item.id === preview.destination.id);
  const sendEnabled = !busy && previewMatches && policyMatches && blockedKey !== preview?.idempotencyKey && !sendResult;
  return { previewMatches, policyMatches, sendEnabled };
}
