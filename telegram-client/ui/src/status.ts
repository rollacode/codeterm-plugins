import { humanizeState, type Tone } from "./kit";

const STATES: Record<string, { label: string; tone: Tone }> = {
  "logged-in": { label: "Signed in", tone: "ok" },
  "logged-out": { label: "Signed out", tone: "muted" },
  "installed-but-not-configured": { label: "Not set up", tone: "warn" },
  "login-in-progress": { label: "Signing in", tone: "accent" },
  "password-required": { label: "Password needed", tone: "warn" },
  "input-required": { label: "Sign-in step needed", tone: "warn" },
  "reauth-needed": { label: "Sign in again", tone: "warn" },
  "not-installed": { label: "Client not installed", tone: "warn" },
  "install-error": { label: "Install failed", tone: "danger" },
  "checksum-mismatch": { label: "Install failed", tone: "danger" },
  "unsupported-platform": { label: "Unsupported system", tone: "danger" },
};

const SEND_STATES: Record<string, string> = {
  pending: "Sending",
  sent: "Sent",
  rate_limited: "Rate limited",
  failed: "Failed",
  unknown: "Delivery unknown",
};

export function statusView(state: string | null | undefined): { label: string; tone: Tone } {
  if (!state) return { label: "Checking", tone: "muted" };
  return STATES[state] ?? { label: humanizeState(state), tone: "muted" };
}

export function sendStateLabel(state: string): string {
  return SEND_STATES[state] ?? humanizeState(state);
}

export function isSignedIn(state: string | null | undefined): boolean {
  return state === "logged-in";
}

export type SetupInfo = { runtimeInstalled?: boolean; apiIdSet?: boolean; apiHashStored?: boolean };
export type AccountInfo = { label: string; name: string | null; username: string | null; phone: string | null; resolved: boolean };
export type LoginStepInfo = { kind: string; prompt: string; hint: string | null; retry: boolean; submittable: boolean };
export type ViewHealth = { state?: string | null; setup?: SetupInfo; account?: AccountInfo | null; loginStep?: LoginStepInfo | null };
export type SetupRow = { label: string; value: string; tone: Tone };

export function accountLine(account: AccountInfo | null | undefined): string | null {
  if (!account) return null;
  const parts = [account.name, account.username, account.phone].filter(Boolean) as string[];
  return parts.length ? parts.join(" · ") : account.label;
}

export function setupRows(health: ViewHealth | null | undefined): SetupRow[] {
  const setup = health?.setup || {};
  const signedIn = isSignedIn(health?.state);
  return [
    { label: "Telegram runtime", value: setup.runtimeInstalled ? "Installed" : "Not installed", tone: setup.runtimeInstalled ? "ok" : "warn" },
    { label: "API ID", value: setup.apiIdSet ? "API ID set" : "Not set", tone: setup.apiIdSet ? "ok" : "warn" },
    { label: "API hash", value: setup.apiHashStored ? "API hash stored" : "Not stored", tone: setup.apiHashStored ? "ok" : "warn" },
    { label: "Account", value: signedIn ? accountLine(health?.account) || "Signed in" : "Not signed in", tone: signedIn ? "ok" : "muted" },
  ];
}

export type ViewLayout = { primary: "account" | "step" | "sign-in"; credentialsNeeded: boolean; step: LoginStepInfo | null };

export function viewLayout(health: ViewHealth | null | undefined, polledStep?: LoginStepInfo | null): ViewLayout {
  const setup = health?.setup || {};
  const step = polledStep || health?.loginStep || null;
  const credentialsNeeded = !(setup.apiIdSet && setup.apiHashStored);
  if (isSignedIn(health?.state) && !polledStep) return { primary: "account", credentialsNeeded, step: null };
  return { primary: step ? "step" : "sign-in", credentialsNeeded, step };
}
