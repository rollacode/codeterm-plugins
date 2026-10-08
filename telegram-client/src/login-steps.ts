export type LoginStepKind = "password" | "code" | "phone" | "input";

export type LoginStep = {
  kind: LoginStepKind;
  prompt: string;
  hint: string | null;
  retry: boolean;
  submittable: boolean;
};

export type LoginOutcome =
  | { phase: "input-required"; step: LoginStep }
  | { phase: "failed"; failure: string }
  | { phase: "running" };

export type NextLoginAction =
  | "done"
  | "show-qr"
  | "wait"
  | "ask-password"
  | "unsupported-step"
  | "fix-credentials"
  | "start-login";

const PROMPT_LABEL = /^(.*\S)\s*:\s*$/;

function stepForPrompt(label: string, retry: boolean): LoginStep {
  if (/^2FA password$/i.test(label)) {
    return {
      kind: "password",
      prompt: "Enter your two-step verification password",
      hint: retry ? "Telegram rejected that password. Enter it again." : null,
      retry,
      submittable: true,
    };
  }
  if (/^Code\b/i.test(label)) {
    const via = label.match(/\(sent via ([^)]+)\)/i);
    return { kind: "code", prompt: via ? `Enter the code sent via ${via[1]}` : "Enter the login code", hint: null, retry, submittable: false };
  }
  if (/^Phone\b/i.test(label)) {
    return { kind: "phone", prompt: "Enter the account phone number", hint: null, retry, submittable: false };
  }
  return { kind: "input", prompt: label, hint: null, retry, submittable: false };
}

// tg writes prompts to stderr and reads stdin; a detached login has no stdin, so a prompt
// ends the log as `<Label>: tg: <error>EOF` on one line.
export function classifyLoginOutput(output: string): LoginOutcome {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || "";
  const prompted = last.match(/^(.*?:)\s*tg: (.*)$/);
  if (prompted && prompted[1].trim() && /\bEOF\b/.test(prompted[2])) {
    const label = prompted[1].match(PROMPT_LABEL);
    if (label) return { phase: "input-required", step: stepForPrompt(label[1], false) };
  }
  if (/^tg: /.test(last)) {
    const failure = last.slice(4).trim();
    if (/2fa password/i.test(failure) && /invalid password|PASSWORD_HASH_INVALID/i.test(failure)) {
      return { phase: "input-required", step: stepForPrompt("2FA password", true) };
    }
    return { phase: "failed", failure };
  }
  return { phase: "running" };
}

export function loginStateForStep(step: LoginStep): string {
  return step.kind === "password" ? "password-required" : "input-required";
}

export function nextLoginAction(current: { state?: string; done?: boolean; qr?: boolean; step?: LoginStep | null; credentialsRejected?: boolean }): NextLoginAction {
  if (current.state === "logged-in") return "done";
  if (current.step) return current.step.submittable ? "ask-password" : "unsupported-step";
  if (current.credentialsRejected) return "fix-credentials";
  if (current.state === "login-in-progress") return current.qr ? "show-qr" : "wait";
  return "start-login";
}

export function maskPhone(phone: unknown): string | null {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length <= 5) return `+${"•".repeat(digits.length)}`;
  return `+${digits.slice(0, 3)}${"•".repeat(digits.length - 5)}${digits.slice(-2)}`;
}
