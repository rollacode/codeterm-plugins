const assert = require("node:assert/strict");
const { test } = require("node:test");
const { stateDir, bundleDir } = require("./src/host-paths.ts");

test("state and package paths use injected instance roots on every platform", () => {
  for (const root of ["/tmp/clean instance", "C:/Users/Owner/instance data", "D:\\instance data\\"]) {
    const base = root.replace(/[\\/]+$/, "");
    for (const id of ["telegram-client", "teams-client", "rotterdom", "aider"]) {
      assert.equal(stateDir(root, id), `${base}/${id}`);
      assert.equal(bundleDir(root, id), `${base}/plugins/${id}`);
    }
  }
});

test("unavailable roots and invalid ids refuse home or working-directory fallbacks", () => {
  for (const root of ["", " ", null, undefined]) assert.throws(() => stateDir(root, "aider"));
  for (const id of ["../other", "a/b", "", "Aider"]) assert.throws(() => bundleDir("/instance", id));
});
