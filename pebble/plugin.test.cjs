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
  return Object.fromEntries(result.text.split("\n").slice(1).map((line) => {
    const separator = line.indexOf(": ");
    return [line.slice(0, separator), JSON.parse(line.slice(separator + 2))];
  }));
}

const tests = [
  ["manifest versions agree and receiver requires no privileged permissions", () => {
    const read = (name) => JSON.parse(readFileSync(join(__dirname, name), "utf8"));
    const manifest = read("plugin.json");
    const entry = read("../channel.json").plugins.find((item) => item.id === manifest.id);
    assert.equal(manifest.version, read("package.json").version);
    assert.equal(manifest.version, entry.version);
    assert.deepEqual(manifest.capabilities.webhookReceiver, { kind: "pebble" });
    assert.equal(manifest.permissions, undefined);
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
  ["untrusted metadata is quoted, sanitized, and bounded", () => {
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
