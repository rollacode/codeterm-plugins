import { humanizeState, type Tone } from "./kit";

const STATES: Record<string, { label: string; tone: Tone }> = {
  "logged-in": { label: "Signed in", tone: "ok" },
  "logged-out": { label: "Signed out", tone: "muted" },
  "installed-but-not-configured": { label: "Not set up", tone: "warn" },
  "login-in-progress": { label: "Signing in", tone: "accent" },
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
