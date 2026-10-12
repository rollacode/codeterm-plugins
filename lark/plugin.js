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

// lark/src/selection.ts
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function selectRecordingDevices(value) {
  const request = record(value);
  if (!request || !Array.isArray(request.inputs) || request.inputs.length !== 1 || !Array.isArray(request.microphones) || request.microphones.length > 64) return null;
  const input = record(request.inputs[0]);
  if (!input || typeof input.inputId !== "string" || !input.inputId || input.collectionId !== "Col01") return null;
  const microphones = request.microphones.map(record).filter((microphone) => microphone && typeof microphone.deviceId === "string" && microphone.deviceId && microphone.deviceId !== "default" && microphone.deviceId !== "communications" && typeof microphone.label === "string" && /\bwireless microphone\b/i.test(microphone.label));
  if (microphones.length !== 1) return null;
  return {
    inputId: input.inputId,
    collectionId: input.collectionId,
    microphoneId: microphones[0].deviceId
  };
}

// lark/src/plugin.ts
var plugin = {
  renderGlance() {
    const status = host.localRecording.status();
    const ready = status && !("error" in status) && status.granted && status.enabled && status.available;
    const nodes = [{ kind: "keyVal", key: "Recording button", value: ready ? "Ready" : "Unavailable", style: { tone: ready ? "ok" : "muted" } }];
    const batteries = ready ? batteryFromStatus(host.localRecording.statusReport()) : [];
    if (!batteries.length) nodes.push({ kind: "keyVal", key: "Battery", value: "Not reported", style: { tone: "muted" } });
    for (const battery of batteries) nodes.push({ kind: "keyVal", key: `Microphone ${battery.slot}`, value: battery.connected ? `${battery.percent}%` : "Disconnected", style: { tone: !battery.connected ? "muted" : battery.percent <= 15 ? "warn" : "ok" } });
    return { title: "LARK M2", nodes };
  },
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
  viewCall(method, args) {
    if (method === "selectRecordingDevices") return selectRecordingDevices(args);
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
