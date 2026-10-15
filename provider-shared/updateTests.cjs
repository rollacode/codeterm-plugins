const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");

module.exports = (tests, load, directory) => {
  const manifest = JSON.parse(readFileSync(join(directory, "plugin.json"), "utf8"));
  const aider = manifest.id === "aider";
  const target = aider ? "0.86.2" : "1.0.50";
  const older = aider ? "0.85.0" : "1.0.49";
  const outside = aider ? "0.87.0" : "1.1.0";
  const url = aider ? "https://pypi.org/pypi/aider-chat/json" : "https://registry.npmjs.org/@xai-official/grok";
  const metadata = versions => aider
    ? { info: { version: outside }, releases: Object.fromEntries(versions.map(v => [v, [{}]])) }
    : { "dist-tags": { latest: outside }, versions: Object.fromEntries(versions.map(v => [v, {}])) };
  const probe = (current = older, versions = [target], overrides = {}) => {
    const calls = { exec: [], fetch: [] };
    const plugin = load({
      manifestJson: () => JSON.stringify(manifest),
      exec: options => { calls.exec.push(JSON.parse(options)); return JSON.stringify({code: 0, stdout: `${manifest.id} ${current}\n`}); },
      fetch: options => { calls.fetch.push(JSON.parse(options)); return JSON.stringify({status: 200, body: JSON.stringify(metadata(versions))}); },
      ...overrides,
    });
    return { plugin, calls };
  };
  const plain = value => JSON.parse(JSON.stringify(value));
  tests.push(["CLI compatibility emits only host-declared reason variants", () => {
    // CodeTerm release/1.14.2 provider_compat::CompatibilityReason (snake_case).
    const reasons = new Set([
      "sqlite_schema_conversion", "event_route_changed", "server_password_required",
      "version_unknown", "version_not_declared", "invalid_manifest", "undeclared_capability",
    ]);
    assert.ok(manifest.cliCompatibility.breaking.length > 0);
    for (const rule of manifest.cliCompatibility.breaking) {
      assert.deepEqual(Object.keys(rule).sort(), ["range", "reasons"]);
      assert.ok(rule.reasons.length > 0);
      for (const reason of rule.reasons) assert.ok(reasons.has(reason), `Unknown host reason: ${reason}`);
      assert.deepEqual(rule.reasons, ["version_not_declared"]);
    }
    assert.equal(typeof manifest.description, "string");
    assert.ok(manifest.description.length > 0);
  }]);
  tests.push(["update check reports installed and supported target through bounded host probes", () => {
    const {plugin, calls} = probe();
    assert.deepEqual(plain(plugin.checkForUpdate()), {currentVersion: older, latestVersion: target});
    assert.deepEqual(calls.exec, [{bin: manifest.cliBinary, args: ["--version"], timeoutMs: 5000}]);
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.fetch[0].url, url);
    assert.equal(calls.fetch[0].timeoutMs, 6000);
    assert.ok(manifest.permissions.subprocess.allow.includes(manifest.cliBinary));
    assert.ok(manifest.permissions.network.allow.includes(new URL(url).hostname));
  }]);
  tests.push(["update check returns null when already newest or newer", () => {
    assert.equal(probe(target).plugin.checkForUpdate(), null);
    assert.equal(probe(outside).plugin.checkForUpdate(), null);
  }]);
  tests.push(["update check selects supported release when upstream latest is outside range", () => {
    assert.deepEqual(plain(probe(older, [outside, target, `${target}-alpha.1`]).plugin.checkForUpdate()),
      {currentVersion: older, latestVersion: target});
    assert.equal(probe(older, [outside]).plugin.checkForUpdate(), null);
  }]);
  tests.push(["update check orders supported versions numerically and excludes breaking ranges", () => {
    const compatibility = {supported: [">=1.0.0, <1.1.0"], breaking: [{range: "=1.0.99"}]};
    const overrides = {manifestJson: () => JSON.stringify({...manifest, cliCompatibility: compatibility})};
    assert.deepEqual(plain(probe("1.0.1", ["1.0.9", "1.0.10", "1.0.99", "1.1.0"], overrides).plugin.checkForUpdate()),
      {currentVersion: "1.0.1", latestVersion: "1.0.10"});
  }]);
  tests.push(["update check fails closed on missing or malformed compatibility and unavailable metadata", () => {
    for (const raw of ["null", "{", "{}", '{"cliCompatibility":{"supported":[]}}']) {
      const {plugin, calls} = probe(older, [target], {manifestJson: () => raw});
      assert.equal(plugin.checkForUpdate(), null);
      assert.equal(calls.exec.length, 0);
    }
    for (const raw of ["null", "{", '{"status":503}', '{"status":200,"body":"{}"}', '{"status":200,"body":"{"}']) {
      assert.equal(probe(older, [target], {fetch: () => raw}).plugin.checkForUpdate(), null);
    }
    for (const stdout of ["unknown", "1.0.50; injected", "1.0.50-alpha.1"]) {
      assert.equal(probe(older, [target], {exec: () => JSON.stringify({code:0, stdout})}).plugin.checkForUpdate(), null);
    }
    assert.equal(probe(older, [target], {exec: () => JSON.stringify({code:1, stdout: target})}).plugin.checkForUpdate(), null);
  }]);
  tests.push(["updater pins the checked target on every platform", () => {
    for (const platform of ["macos", "linux", "windows"]) {
      const command = manifest.updater[platform];
      assert.ok(command.includes("{version}"));
      const pinned = command.replaceAll("{version}", target);
      assert.ok(!pinned.includes("{version}"));
      if (aider) {
        assert.ok(pinned.includes(`uv tool install --force aider-chat==${target}`));
        assert.ok(pinned.includes(`pipx install --force aider-chat==${target}`));
        assert.doesNotMatch(pinned, /upgrade|--latest/);
      } else assert.equal(pinned, `grok update --version ${target}`);
    }
  }]);
  tests.push(["native updater executes exact target without interactive flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "plugin-update-"));
    try {
      const log = join(dir, "args.json");
      const windows = process.platform === "win32";
      const fixture = join(dir, "argv.cjs");
      const recordArgs = "require('node:fs').writeFileSync(process.env.UPDATE_ARGS, JSON.stringify(process.argv.slice(2)));\n";
      writeFileSync(fixture, recordArgs);
      const shim = windows ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
        : `#!${process.execPath}\n${recordArgs}`;
      for (const platform of windows ? ["windows"] : ["macos", "linux"]) {
        for (const runner of aider ? ["uv", "pipx"] : ["grok"]) {
          const binary = join(dir, runner + (windows ? ".cmd" : ""));
          writeFileSync(binary, shim, {mode:0o755});
          const command = manifest.updater[platform].replaceAll("{version}", target);
          const shell = windows ? join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe") : "/bin/bash";
          const shellArgs = windows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
          const result = spawnSync(shell, shellArgs, {env: {...process.env, PATH:dir, UPDATE_ARGS:log}, encoding:"utf8", windowsHide:true});
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), aider
            ? runner === "uv" ? ["tool", "install", "--force", `aider-chat==${target}`] : ["install", "--force", `aider-chat==${target}`]
            : ["update", "--version", target]);
          rmSync(binary);
        }
      }
    } finally { rmSync(dir, {recursive:true, force:true}); }
  }]);
};
