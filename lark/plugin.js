"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lark/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);

// lark/src/battery.ts
function batteryFromStatus(report) {
  if (!Array.isArray(report) || report.length !== 64 || report.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return [];
  if ([85, 187, 221, 16, 128].some((byte, i) => report[i] !== byte)) return [];
  const length = report[5] * 256 + report[6];
  if (length < 4 || length > 56 || report[7] > 1 || report[8] > 1 || report[9] > 100 || report[10] > 100) return [];
  return [0, 1].map((i) => ({ slot: i + 1, connected: report[7 + i] === 1, percent: report[7 + i] === 1 ? report[9 + i] : null }));
}

// lark/src/plugin.ts
var plugin = {
  statusBubble(ctx) {
    const target = host.receiverTarget.get();
    const status = host.localRecording.status();
    if (!target || !("tabId" in target) || target.tabId !== ctx.tabId || !status || "error" in status || !status.granted || !status.enabled || !status.available) return null;
    const batteries = batteryFromStatus(host.localRecording.statusReport()).filter((battery) => battery.connected);
    if (!batteries.length) return null;
    return {
      label: `LARK ${batteries.map((battery) => `${battery.percent}%`).join(" \xB7 ")}`,
      tone: batteries.some((battery) => battery.percent <= 15) ? "warn" : "accent",
      icon: "battery",
      tooltip: batteries.map((battery) => `Microphone ${battery.slot}: ${battery.percent}%`).join(", "),
      action: "openPanel:view:lark"
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
  }
};
var plugin_default = plugin;
