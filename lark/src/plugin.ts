import { batteryFromStatus } from "./battery";
import { selectRecordingDevices } from "./selection";
import type { Host, PluginModule, ViewNode } from "@codeterm/plugin-sdk";

declare const host: Host;

const plugin: Pick<PluginModule, "viewCall" | "statusBubble" | "renderGlance"> = {
  renderGlance() {
    const status = host.localRecording.status();
    const ready = status && !("error" in status) && status.granted && status.enabled && status.available;
    const nodes: ViewNode[] = [{ kind: "keyVal", key: "Recording button", value: ready ? "Ready" : "Unavailable", style: { tone: ready ? "ok" : "muted" } }];
    const batteries = ready ? batteryFromStatus(host.localRecording.statusReport()) : [];
    if (!batteries.length) nodes.push({ kind: "keyVal", key: "Battery", value: "Not reported", style: { tone: "muted" } });
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
  viewCall(method, args) {
    if (method === "selectRecordingDevices") return selectRecordingDevices(args);
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
