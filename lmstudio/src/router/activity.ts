export type Activity = "idle" | "thinking" | "working";

export interface ActivityInput {
  streaming: boolean;
  answering: boolean;
  toolsRunning: boolean;
  queued: boolean;
}

/** Thinking until answer tokens or tool work start; idle only when nothing is in flight. */
export function activityOf(i: ActivityInput): Activity {
  if (i.toolsRunning || (i.streaming && i.answering)) return "working";
  if (i.streaming || i.queued) return "thinking";
  return "idle";
}

export function activityLine(model: string, activity: Activity): string {
  if (activity === "idle") return "";
  return ["Domios Router", model, activity === "thinking" ? "Thinking" : "Working"].filter(Boolean).join(" · ");
}
