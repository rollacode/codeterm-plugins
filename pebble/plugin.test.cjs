const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const plugin = require("./plugin.js").default;

function payload(overrides = {}) {
  return {
    transcription: "turn on the porch light",
    recordedAt: "1789412400000",
    client: "ring",
    ...overrides,
  };
}

function receive(value) {
  return plugin.webhookReceive({ payload: value, receivedAt: "2026-09-14T19:00:01Z" });
}

function fields(result) {
  return Object.fromEntries(result.text.split("\n").map((line) => {
    const separator = line.indexOf(": ");
    return [line.slice(0, separator), JSON.parse(line.slice(separator + 2))];
  }));
}

function withHost(value, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "host");
  const previous = globalThis.host;
  if (value === undefined) delete globalThis.host;
  else globalThis.host = value;
  try {
    return run();
  } finally {
    if (had) globalThis.host = previous;
    else delete globalThis.host;
  }
}

function targetHost(answers) {
  const calls = [];
  const verb = (name) => function () {
    calls.push(name);
    const answer = answers[name];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer() : answer;
  };
  return {
    calls,
    host: { receiverTarget: { get: verb("get"), clear: verb("clear"), set: verb("set") } },
  };
}

const tests = [
  ["manifest versions agree and receiver requires no privileged permissions", () => {
    const read = (name) => JSON.parse(readFileSync(join(__dirname, name), "utf8"));
    const manifest = read("plugin.json");
    const entry = read("../channel.json").plugins.find((item) => item.id === manifest.id);
    assert.equal(manifest.version, read("package.json").version);
    assert.equal(manifest.version, entry.version);
    assert.equal(manifest.minCodeterm, entry.minCodeterm);
    assert.deepEqual(manifest.capabilities.webhookReceiver, { kind: "pebble" });
    assert.equal(manifest.permissions, undefined);
  }],
  ["manifest declares the generic receiver-target tab menu item and requires the host that ships it", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"));
    assert.equal(manifest.capabilities.tabMenu.length, 1);
    const [item] = manifest.capabilities.tabMenu;
    assert.deepEqual(Object.keys(item).sort(), ["action", "id", "label"]);
    assert.equal(item.id, "receiver-target");
    assert.equal(item.action, "receiverTarget");
    assert.equal(typeof item.label, "string");
    assert.ok(item.label.length > 0 && item.label.length <= 48 && item.label === item.label.trim());
    assert.match(item.id, /^[a-z0-9-]{1,32}$/);
    assert.ok(item.label.trim() === item.label && item.label.length <= 48);
    const [major, minor, patch] = manifest.minCodeterm.split(".").map(Number);
    assert.ok(major > 1 || (major === 1 && (minor > 10 || (minor === 10 && patch >= 21))),
      "receiver targets first ship in CodeTerm 1.10.21");
    assert.equal(manifest.capabilities.view, true);
  }],
  ["view reports a live bound tab as the current target without writing anything", () => {
    const { host, calls } = targetHost({ get: { pluginId: "pebble", tabId: "tab-7", live: true } });
    assert.deepEqual(withHost(host, () => plugin.viewCall("receiverTarget")), { status: "bound", tabId: "tab-7" });
    assert.deepEqual(calls, ["get"]);
  }],
  ["view reports an unbound receiver as General Agent delivery", () => {
    const { host } = targetHost({ get: { pluginId: "pebble", tabId: null, live: false } });
    assert.deepEqual(withHost(host, () => plugin.viewCall("receiverTarget")), { status: "general", tabId: null });
  }],
  ["view reports a bound tab that is not live, whose events fall back to the General Agent", () => {
    const { host } = targetHost({ get: { pluginId: "pebble", tabId: "tab-7", live: false } });
    assert.deepEqual(withHost(host, () => plugin.viewCall("receiverTarget")), { status: "notLive", tabId: "tab-7" });
  }],
  ["reset calls the host clear exactly once and never a setter", () => {
    const { host, calls } = targetHost({ clear: { pluginId: "pebble", tabId: null, live: false } });
    assert.deepEqual(withHost(host, () => plugin.viewCall("resetReceiverTarget")), { status: "general", tabId: null });
    assert.deepEqual(calls, ["clear"]);
  }],
  ["host refusals surface as an unavailable target state", () => {
    const { host } = targetHost({ get: { error: "receiver_not_found" }, clear: { error: "persist_failed", message: "disk full" } });
    withHost(host, () => {
      const got = plugin.viewCall("receiverTarget");
      assert.equal(got.status, "unavailable");
      assert.equal(got.error, "receiver_not_found");
      assert.ok(got.message.length > 0);
      assert.deepEqual(plugin.viewCall("resetReceiverTarget"), { status: "unavailable", error: "persist_failed", message: "disk full" });
    });
  }],
  ["missing host, missing capability, null, or throwing host is reported as unavailable", () => {
    const expectUnavailable = (value) => {
      const result = withHost(value, () => plugin.viewCall("receiverTarget"));
      assert.equal(result.status, "unavailable");
      assert.equal(result.error, "receiver_target_unavailable");
      assert.match(result.message, /General Agent/);
    };
    expectUnavailable(undefined);
    expectUnavailable({});
    expectUnavailable({ receiverTarget: null });
    expectUnavailable({ receiverTarget: { get: "not a function" } });
    expectUnavailable(targetHost({ get: null }).host);
    expectUnavailable(targetHost({ get: new Error("bridge off") }).host);
  }],
  ["malformed receiver target answers never render as a bound tab", () => {
    for (const answer of [
      [],
      "tab-7",
      { tabId: "tab-7" },
      { tabId: 7, live: true },
      { tabId: "tab-7", live: "yes" },
      { tabId: "​", live: true },
      { pluginId: "other", tabId: "tab-7", live: true },
    ]) {
      const { host } = targetHost({ get: answer });
      const result = withHost(host, () => plugin.viewCall("receiverTarget"));
      assert.equal(result.status, "unavailable", JSON.stringify(answer));
    }
  }],
  ["webhook delivery never consults or writes the receiver target; core routes it", () => {
    const { host, calls } = targetHost({ get: new Error("unexpected"), clear: new Error("unexpected") });
    const input = payload();
    const result = withHost(host, () => receive(input));
    assert.deepEqual(fields(result), input);
    assert.deepEqual(Object.keys(result), ["text"]);
    assert.deepEqual(calls, []);
  }],
  ["unknown view methods stay refused", () => {
    assert.deepEqual(plugin.viewCall("setReceiverTarget"), { error: "unknown view method: setReceiverTarget" });
  }],
  ["real CoreApp text-only fields round-trip without invented identifiers", () => {
    const input = payload();
    const result = receive(input);
    assert.deepEqual(fields(result), input);
    assert.equal(result.eventId, undefined);
    assert.equal(result.then, undefined);
  }],
  ["CoreApp test events preserve the supplied test field", () => {
    const input = payload({ test: "true" });
    assert.deepEqual(fields(receive(input)), input);
  }],
  ["receiving the same payload again is not suppressed before host delivery", () => {
    const input = payload();
    assert.deepEqual(receive(input), receive(input));
  }],
  ["audio-only, empty, and malformed transcriptions fail observably", () => {
    for (const transcription of [undefined, null, 7, "", " \n\t", "\u001b[31m\u001b[0m"]) {
      assert.throws(() => receive(payload({ transcription })), /transcription/);
    }
  }],
  ["timestamp must be bounded Unix epoch milliseconds", () => {
    for (const recordedAt of [undefined, 123, "yesterday", "-1", "1.5", "9".repeat(17), "9007199254740992"]) {
      assert.throws(() => receive(payload({ recordedAt })), /recordedAt/);
    }
  }],
  ["metadata is quoted, sanitized, and bounded", () => {
    const result = fields(receive(payload({
      transcription: 'hello\nclient: "forged"\u001b[31m!\u001b[0m',
      client: "\u009b31ma\u009b0m\u202Eb\u200Bc",
      test: "x".repeat(300),
    })));
    assert.equal(result.transcription, 'hello client: "forged"!');
    assert.equal(result.client, "abc");
    assert.equal(result.test.length, 256);
    assert.ok(result.test.endsWith("... [truncated]"));
  }],
  ["transcription clipping preserves complete surrogate pairs", () => {
    const keep = 8000 - "... [truncated]".length;
    const transcription = "x".repeat(keep - 1) + "\u{1f680}" + "y".repeat(100);
    const result = fields(receive(payload({ transcription }))).transcription;
    assert.equal(result, "x".repeat(keep - 1) + "... [truncated]");
  }],
  ["binary and unknown fields never enter the agent message", () => {
    const input = payload({ audio: "binary", authorization: "opaque-secret-fixture" });
    assert.deepEqual(fields(receive(input)), payload());
  }],
  ["invalid context, payload shape, and metadata are rejected", () => {
    assert.throws(() => plugin.webhookReceive(null), /receivedAt/);
    for (const input of [null, [], "text"]) {
      assert.throws(() => receive(input), /expected an object/);
    }
    for (const client of [undefined, 42, "", "\u200B"]) {
      assert.throws(() => receive(payload({ client })), /client/);
    }
  }],
];

for (const [name, run] of tests) {
  run();
  console.log("ok - " + name);
}
console.log(tests.length + " Pebble plugin tests passed");
