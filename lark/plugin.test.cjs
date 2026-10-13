const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const calls = [];
let granted = false;
const batteryReport = [0x55, 0xbb, 0xdd, 0x10, 0x80, 0, 9, 0, 1, 0, 97, 0, 0, 0, 4, 0, ...Array(48).fill(0)];
let status = { granted: false, enabled: false, devicesSelected: false, available: false, captureActive: false };
const sandbox = {
  module: { exports: {} },
  host: {
    localRecording: {
      status: () => status,
      statusReport: () => batteryReport,
      setEnabled(enabled) {
        calls.push({ enabled });
        if (!granted) throw new Error("local_recording_not_granted");
        status.enabled = enabled;
        return status;
      },
    },
    receiverTarget: {
      get: () => ({ tabId: "selected-tab" }),
      clear: () => { calls.push({ clear: true }); return null; },
    },
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "plugin.js"), "utf8"), sandbox);
const plugin = sandbox.module.exports.default;
const offered = { inputs: [{ inputId: "receiver", collectionId: "Col01" }],
  microphones: [{ deviceId: "lark-mic", label: "Microphone (Wireless microphone)" },
    { deviceId: "other-mic", label: "Laptop microphone" }] };
assert.deepEqual(JSON.parse(JSON.stringify(plugin.viewCall("selectRecordingDevices", offered))),
  { inputId: "receiver", collectionId: "Col01", microphoneId: "lark-mic" });
for (const candidates of [null, {}, { ...offered, inputs: [] },
  { ...offered, inputs: [...offered.inputs, { inputId: "second", collectionId: "Col01" }] },
  { ...offered, inputs: [{ inputId: "receiver", collectionId: "Col02" }] },
  { ...offered, microphones: [{ deviceId: "default", label: "Wireless microphone" }] },
  { ...offered, microphones: [{ deviceId: "unknown", label: "" }] },
  { ...offered, microphones: [...offered.microphones, { deviceId: "second", label: "Wireless microphone" }] },
  { ...offered, microphones: [{ deviceId: "other", label: "Laptop microphone" }] }]) {
  assert.equal(plugin.viewCall("selectRecordingDevices", candidates), null);
}
assert.deepEqual(calls, [], "loading the plugin acquires no recorder or permissions");
assert.equal(plugin.viewCall("status"), status);
assert.throws(() => plugin.viewCall("enable"), /local_recording_not_granted/);
granted = true;
assert.equal(plugin.viewCall("enable").enabled, true);
assert.equal(plugin.viewCall("disable").enabled, false);
assert.deepEqual(calls, [{ enabled: true }, { enabled: true }, { enabled: false }]);
assert.equal(plugin.viewCall("receiverTarget").tabId, "selected-tab");
assert.equal(plugin.viewCall("resetReceiverTarget"), null);
assert.equal(calls.at(-1).clear, true);
assert.equal(plugin.viewCall("unknown").error, "unsupported_lark_action");
assert.equal(calls.length, 4);
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "plugin.json"), "utf8"));
assert.deepEqual(manifest.permissions, { local_recording: true, agent_commands: true });
const { button, ...trigger } = manifest.capabilities.localRecordingTrigger;
assert.equal(button.pressUsage, 0xe9);
assert.deepEqual(trigger,
  { vendorId: 0x3547, productId: 8, usagePage: 12, usage: 1 });
assert.deepEqual(Object.keys(plugin), ["renderGlance", "statusBubble", "onAgentCommand", "viewCall"]);
status.granted = true; status.enabled = true; status.devicesSelected = true; status.available = true;
assert.equal(plugin.statusBubble({tabId:"selected-tab"}).label, "LARK 97%");
assert.equal(plugin.statusBubble({tabId:"foreign-tab"}), null);
assert.equal(plugin.viewCall("battery")[0].percent, null);
assert.equal(plugin.viewCall("battery")[1].percent, 97);
for (const [index, value] of [[0, 0], [3, 0x11], [4, 0x40], [5, 1], [6, 3], [7, 2], [9, 101], [10, 255]]) {
  const previous = batteryReport[index]; batteryReport[index] = value;
  assert.equal(plugin.statusBubble({tabId:"selected-tab"}), null);
  batteryReport[index] = previous;
}
batteryReport[10] = 0;
assert.equal(plugin.statusBubble({tabId:"selected-tab"}).tone, "warn");
console.log("lark plugin: capability, confinement, observed battery and invalid-frame fixtures passed");

status.granted = true; status.enabled = true; status.devicesSelected = true; status.available = true;
batteryReport[10] = 97;
assert.equal(plugin.renderGlance().nodes.find(node => node.key === "Microphone 2").value, "97%");
batteryReport[10] = 10;
assert.equal(plugin.statusBubble({tabId:"selected-tab"}).tone, "warn");

const completeStatus = { granted: true, enabled: true, devicesSelected: true, available: true, captureActive: false };
const connectionCases = [
  [null, "unknown"], [{}, "unknown"],
  [{ error: "local_recording_grant_required" }, "needs_permission"],
  [{ error: "local_recording_unsupported" }, "unsupported"],
  [{ error: "transport-failed" }, "error"],
  [{ ...completeStatus, granted: false }, "needs_permission"],
  [{ ...completeStatus, enabled: false }, "disabled"],
  [{ ...completeStatus, devicesSelected: false, available: false }, "needs_selection"],
  [{ ...completeStatus, available: false }, "not_found"],
  [completeStatus, "connected"],
];
for (const [hostStatus, expected] of connectionCases) {
  status = hostStatus;
  assert.equal(plugin.viewCall("connection").state, expected);
  const diagnostic = plugin.viewCall("diagnostics");
  assert.equal(diagnostic.hostStatus, hostStatus);
  assert.equal(diagnostic.connection.state, expected);
  assert.equal(diagnostic.receiverReport, expected === "connected" ? batteryReport : null);
  assert.equal(JSON.parse(plugin.onAgentCommand({ verb: "status", args: [] }).result).state, expected);
  assert.equal(JSON.parse(plugin.onAgentCommand({ verb: "diagnostics", args: [] }).result).connection.state, expected);
  assert.equal(plugin.renderGlance().nodes[0].value, diagnostic.connection.label);
}
assert.equal(plugin.onAgentCommand({ verb: "enable", args: [] }).error, "unsupported_lark_command");
assert.ok(plugin.onAgentCommand({ verb: "status", args: ["foreign-device"] }).error);
assert.equal(plugin.onAgentCommand({ verb: "help", args: [] }).result.length > 0, true);
status = completeStatus;
const originalReport = sandbox.host.localRecording.statusReport;
sandbox.host.localRecording.statusReport = () => ({ error: "receiver_status_unavailable" });
assert.equal(plugin.viewCall("diagnostics").receiverReport.error, "receiver_status_unavailable");
assert.equal(plugin.viewCall("diagnostics").batteries.length, 0);
assert.equal(plugin.viewCall("connection").state, "connected");
sandbox.host.localRecording.statusReport = originalReport;
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const channel = JSON.parse(fs.readFileSync(path.join(__dirname, "../channel.json"), "utf8"));
assert.equal(manifest.version, packageJson.version);
assert.equal(channel.plugins.find(entry => entry.id === "lark").version, manifest.version);
assert.equal(fs.existsSync(path.join(__dirname, manifest.agentGuide)), true);
const { transformSync } = require("esbuild");
const mountSandbox = { module: { exports: {} } };
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, "ui/src/mount.ts"), "utf8"), { loader: "ts", format: "cjs" }).code, mountSandbox);
const root = {};
let rendered = 0;
mountSandbox.module.exports.mountView({ getElementById(id) { return id === "ct-root" ? root : null; } }, element => {
  assert.equal(element, root);
  rendered += 1;
});
assert.equal(rendered, 1);
mountSandbox.module.exports.mountView({ getElementById() { return null; } }, () => rendered += 1);
assert.equal(rendered, 1);
assert.ok(fs.readFileSync(path.join(__dirname, "ui/index.html"), "utf8").includes('id="ct-root"'));
console.log("lark plugin: 10 connection-state fixtures, diagnostic commands/report gating, release metadata and UI mount passed");
