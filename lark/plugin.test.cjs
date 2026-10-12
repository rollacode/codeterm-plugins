const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const calls = [];
let granted = false;
const batteryReport = [0x55, 0xbb, 0xdd, 0x10, 0x80, 0, 9, 0, 1, 0, 97, 0, 0, 0, 4, 0, ...Array(48).fill(0)];
const status = { granted: false, enabled: false, devicesSelected: false, available: false };
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
assert.deepEqual(manifest.permissions, { local_recording: true });
const { button, ...trigger } = manifest.capabilities.localRecordingTrigger;
assert.equal(button.pressUsage, 0xe9);
assert.deepEqual(trigger,
  { vendorId: 0x3547, productId: 8, usagePage: 12, usage: 1 });
assert.deepEqual(Object.keys(plugin), ["statusBubble", "viewCall"]);
status.granted = true; status.enabled = true; status.available = true;
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
