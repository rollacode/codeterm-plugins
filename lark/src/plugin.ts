import { batteryFromStatus } from "./battery";
import { connectionFromStatus } from "./connection";
import { selectRecordingDevices } from "./selection";
import type { Host, PluginModule, ViewNode } from "@codeterm/plugin-sdk";

declare const host: Host;

function diagnostics() {
  const hostStatus = host.localRecording.status();
  const connection = connectionFromStatus(hostStatus);
  const receiverReport = connection.state === "connected" ? host.localRecording.statusReport() : null;
  return { connection, hostStatus, receiverReport, batteries: batteryFromStatus(receiverReport) };
}

const plugin: Pick<PluginModule, "viewCall" | "statusBubble" | "renderGlance" | "onAgentCommand"> = {
  renderGlance() {
    const status = host.localRecording.status();
    const connection = connectionFromStatus(status);
    const ready = connection.state === "connected";
    const nodes: ViewNode[] = [
      { kind: "keyVal", key: "Recording button", value: connection.label, style: { tone: ready ? "ok" : "muted" } },
      { kind: "text", text: connection.detail },
    ];
    const batteries = ready ? batteryFromStatus(host.localRecording.statusReport()) : [];
    if (!batteries.length) nodes.push({ kind: "keyVal", key: "Battery", value: ready ? "No valid receiver report" : "Connect receiver first", style: { tone: "muted" } });
    for (const battery of batteries) nodes.push({ kind: "keyVal", key: `Microphone ${battery.slot}`, value: battery.connected ? `${battery.percent}%` : "Disconnected", style: { tone: !battery.connected ? "muted" : battery.percent! <= 15 ? "warn" : "ok" } });
    return { title: "LARK M2", nodes };
  },
  statusBubble(ctx) {
    const target = host.receiverTarget.get();
    const status = host.localRecording.status();
    if (!target || !("tabId" in target) || target.tabId !== ctx.tabId || !status || "error" in status || !status.granted || !status.enabled || !status.available) return null;
    const batteries = batteryFromStatus(host.localRecording.statusReport()).filter(battery => battery.connected);
    if (!batteries.length) return null;
    return {
      label: `LARK ${batteries.map(battery => `${battery.percent}%`).join(" · ")}`,
      tone: batteries.some(battery => battery.percent! <= 15) ? "warn" : "accent",
      icon: "battery",
      tooltip: batteries.map(battery => `Microphone ${battery.slot}: ${battery.percent}%`).join(", "),
      action: "openPanel:view:lark",
    };
  },
  onAgentCommand(ctx) {
    if (ctx.args.length) return { error: "LARK diagnostic commands take no arguments." };
    if (ctx.verb === "status") return { result: JSON.stringify(connectionFromStatus(host.localRecording.status())) };
    if (ctx.verb === "diagnostics") return { result: JSON.stringify(diagnostics()) };
    if (ctx.verb === "help") return { result: "Read-only verbs: status, diagnostics. Run codeterm plugin get lark first; settings show Refresh status, Enable LARK, Disable LARK, Show diagnostics. Device selection is host-owned and may have no picker when no receiver is offered." };
    return { error: "unsupported_lark_command" };
  },
  viewCall(method, args) {
    if (method === "selectRecordingDevices") return selectRecordingDevices(args);
    if (method === "connection") return connectionFromStatus(host.localRecording.status());
    if (method === "diagnostics") return diagnostics();
    if (method === "battery") return batteryFromStatus(host.localRecording.statusReport());
    if (method === "status") return host.localRecording.status();
    if (method === "enable") return host.localRecording.setEnabled(true);
    if (method === "disable") return host.localRecording.setEnabled(false);
    if (method === "receiverTarget") return host.receiverTarget.get();
    if (method === "resetReceiverTarget") return host.receiverTarget.clear();
    return { error: "unsupported_lark_action" };
  },
};

export default plugin;
