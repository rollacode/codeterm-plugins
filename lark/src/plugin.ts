import { batteryFromStatus } from "./battery";
import type { Host, PluginModule } from "@codeterm/plugin-sdk";

declare const host: Host;

const plugin: Pick<PluginModule, "viewCall" | "statusBubble"> = {
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
  viewCall(method) {
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
