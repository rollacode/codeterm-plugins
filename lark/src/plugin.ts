import { defineProviderIo, ioValue, type HostIoSteps, type IoExports } from "@codeterm/plugin-sdk";
import { batteryFromStatus } from "./battery";
import { connectionFromStatus } from "./connection";
import { selectRecordingDevices } from "./selection";
import type { Host, PluginModule, ViewNode } from "@codeterm/plugin-sdk";

declare const host: Host;

function* diagnostics(): HostIoSteps<{ connection: ReturnType<typeof connectionFromStatus>; hostStatus: ReturnType<typeof host.localRecording.status>; receiverReport: ReturnType<typeof host.localRecording.statusReport>; batteries: ReturnType<typeof batteryFromStatus> }> {
  const hostStatus = (yield* ioValue<ReturnType<typeof host.localRecording.status>>({ op: "localRecordingStatus" }));
  const connection = connectionFromStatus(hostStatus);
  const receiverReport = connection.state === "connected" ? (yield* ioValue<ReturnType<typeof host.localRecording.statusReport>>({ op: "receiverStatusReport" })) : null;
  return { connection, hostStatus, receiverReport, batteries: batteryFromStatus(receiverReport) };
}

const plugin: IoExports<Pick<PluginModule, "viewCall" | "statusBubble" | "renderGlance" | "onAgentCommand">> = {
  *renderGlance(): HostIoSteps<{ title: string; nodes: ViewNode[]; }> {
    const status = (yield* ioValue<ReturnType<typeof host.localRecording.status>>({ op: "localRecordingStatus" }));
    const connection = connectionFromStatus(status);
    const ready = connection.state === "connected";
    const nodes: ViewNode[] = [
      { kind: "keyVal", key: "Recording button", value: connection.label, style: { tone: ready ? "ok" : "muted" } },
      { kind: "text", text: connection.detail },
    ];
    const batteries = ready ? batteryFromStatus((yield* ioValue<ReturnType<typeof host.localRecording.statusReport>>({ op: "receiverStatusReport" }))) : [];
    if (!batteries.length) nodes.push({ kind: "keyVal", key: "Battery", value: ready ? "No valid receiver report" : "Connect receiver first", style: { tone: "muted" } });
    for (const battery of batteries) nodes.push({ kind: "keyVal", key: `Microphone ${battery.slot}`, value: battery.connected ? `${battery.percent}%` : "Disconnected", style: { tone: !battery.connected ? "muted" : battery.percent! <= 15 ? "warn" : "ok" } });
    return { title: "LARK M2", nodes };
  },
  *statusBubble(ctx): HostIoSteps<{ label: string; tone: "warn" | "accent"; icon: string; tooltip: string; action: string; } | null> {
    const target = (yield* ioValue<ReturnType<typeof host.receiverTarget.get>>({ op: "receiverTarget" }));
    const status = (yield* ioValue<ReturnType<typeof host.localRecording.status>>({ op: "localRecordingStatus" }));
    if (!target || !("tabId" in target) || target.tabId !== ctx.tabId || !status || "error" in status || !status.granted || !status.enabled || !status.available) return null;
    const batteries = batteryFromStatus((yield* ioValue<ReturnType<typeof host.localRecording.statusReport>>({ op: "receiverStatusReport" }))).filter(battery => battery.connected);
    if (!batteries.length) return null;
    return {
      label: `LARK ${batteries.map(battery => `${battery.percent}%`).join(" · ")}`,
      tone: batteries.some(battery => battery.percent! <= 15) ? "warn" : "accent",
      icon: "battery",
      tooltip: batteries.map(battery => `Microphone ${battery.slot}: ${battery.percent}%`).join(", "),
      action: "openPanel:view:lark",
    };
  },
  *onAgentCommand(ctx): HostIoSteps<{ error: string; result?: undefined; } | { result: string; error?: undefined; }> {
    if (ctx.args.length) return { error: "LARK diagnostic commands take no arguments." };
    if (ctx.verb === "status") return { result: JSON.stringify(connectionFromStatus((yield* ioValue<ReturnType<typeof host.localRecording.status>>({ op: "localRecordingStatus" })))) };
    if (ctx.verb === "diagnostics") return { result: JSON.stringify((yield* diagnostics())) };
    if (ctx.verb === "help") return { result: "Read-only verbs: status, diagnostics. Run codeterm plugin get lark first; settings show Refresh status, Enable LARK, Disable LARK, Show diagnostics. Device selection is host-owned and may have no picker when no receiver is offered." };
    return { error: "unsupported_lark_command" };
  },
  *viewCall(method, args): HostIoSteps<unknown> {
    if (method === "selectRecordingDevices") return selectRecordingDevices(args);
    if (method === "connection") return connectionFromStatus((yield* ioValue<ReturnType<typeof host.localRecording.status>>({ op: "localRecordingStatus" })));
    if (method === "diagnostics") return (yield* diagnostics());
    if (method === "battery") return batteryFromStatus((yield* ioValue<ReturnType<typeof host.localRecording.statusReport>>({ op: "receiverStatusReport" })));
    if (method === "status") return (yield* ioValue<ReturnType<typeof host.localRecording.status>>({ op: "localRecordingStatus" }));
    if (method === "enable") return (yield* ioValue<ReturnType<typeof host.localRecording.status>>({ op: "localRecordingSetEnabled", enabled: true }));
    if (method === "disable") return (yield* ioValue<ReturnType<typeof host.localRecording.status>>({ op: "localRecordingSetEnabled", enabled: false }));
    if (method === "receiverTarget") return (yield* ioValue<ReturnType<typeof host.receiverTarget.get>>({ op: "receiverTarget" }));
    if (method === "resetReceiverTarget") return (yield* ioValue<ReturnType<typeof host.receiverTarget.get>>({ op: "receiverTargetClear" }));
    return { error: "unsupported_lark_action" };
  },
};

export default defineProviderIo(plugin, () => host.io);
