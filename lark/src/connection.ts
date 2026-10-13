import type { LocalRecordingStatus } from "@codeterm/plugin-sdk";

export interface Connection {
  state: "unknown" | "needs_permission" | "disabled" | "needs_selection" | "not_found" | "connected" | "unsupported" | "error";
  label: string;
  detail: string;
  status: LocalRecordingStatus | null;
}

export function connectionFromStatus(value: unknown): Connection {
  const result = (state: Connection["state"], label: string, detail: string, status: LocalRecordingStatus | null = null): Connection =>
    ({ state, label, detail, status });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return result("unknown", "Status unknown", "The host has not returned recording status. Refresh to check again.");
  }
  if ("error" in value && typeof value.error === "string") {
    if ((value.error === "local_recording_not_granted" || value.error === "local_recording_grant_required")) {
      return result("needs_permission", "Needs permission", "Grant local recording in Domios plugin permissions.");
    }
    if (value.error === "local_recording_unsupported") {
      return result("unsupported", "Unsupported host", value.error);
    }
    return result("error", "Host error", value.error);
  }
  if (!["granted", "enabled", "devicesSelected", "available", "captureActive"].every(key =>
    key in value && typeof (value as Record<string, unknown>)[key] === "boolean")) {
    return result("unknown", "Status unknown", "The host returned incomplete recording status.");
  }
  const status = value as LocalRecordingStatus;
  if (!status.granted) return result("needs_permission", "Needs permission", "Grant local recording in Domios plugin permissions.", status);
  if (!status.enabled) return result("disabled", "Disabled", "Enable LARK to connect the recording button.", status);
  if (!status.devicesSelected) return result("needs_selection", "Choose devices", "The host has no receiver and microphone selection. Enable LARK and choose both in the recording device picker.", status);
  if (!status.available) return result("not_found", "Not connected", "The selected receiver is unavailable. Check its USB connection, then enable LARK again. The host does not report the transport failure reason.", status);
  return result("connected", "Connected", status.captureActive ? "Voice capture active." : "Double-press the transmitter button to start recording.", status);
}
