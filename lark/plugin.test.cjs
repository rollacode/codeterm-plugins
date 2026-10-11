const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const calls = [];
let granted = false;
const status = { granted: false, enabled: false, devicesSelected: false, available: false };
const sandbox = {
  module: { exports: {} },
  host: {
    localRecording: {
      status: () => status,
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
assert.deepEqual(manifest.capabilities.localRecordingTrigger,
  { vendorId: 0x3547, productId: 8, usagePage: 12, usage: 1 });
assert.deepEqual(Object.keys(plugin), ["viewCall"]);
console.log("lark plugin: 6 capability and confinement fixtures passed");
