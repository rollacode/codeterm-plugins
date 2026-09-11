const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const plugin = require("./plugin.js").default;
const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8"));
const packageManifest = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
const channel = JSON.parse(readFileSync(join(__dirname, "..", "channel.json"), "utf8"));
const source = readFileSync(join(__dirname, "src", "plugin.ts"), "utf8");

const channelEntry = channel.plugins.find((entry) => entry.id === "pebble");
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function assertIncludes(text, expected, message) {
  assert(text.includes(expected), `${message}: missing ${JSON.stringify(expected)}\n${text}`);
}
function assertThrows(fn, expectedMessage) {
  try {
    fn();
  } catch (error) {
    assert(error && typeof error.message === "string", "malformed delivery throws an Error");
    assert(error.message.includes(expectedMessage), `error names ${expectedMessage}: ${error.message}`);
    return;
  }
  throw new Error(`expected throw containing ${expectedMessage}`);
}

let sequence = 0;
function payload(overrides = {}) {
  sequence += 1;
  return {
    transcript: "turn on the porch light",
    trigger: "single-click-hold",
    event_id: `event-${sequence}`,
    ring_id: "ring-7",
    source_message_id: "message-42",
    recorded_at: "2026-09-11T07:00:00Z",
    ...overrides,
  };
}
function receive(value, receivedAt = "2026-09-11T07:00:01Z") {
  return plugin.webhookReceive({ payload: value, receivedAt });
}

test("declares the pinned Pebble webhook capability and matching versions", () => {
  assert(manifest.id === "pebble", `manifest id is ${manifest.id}`);
  assert(manifest.version === "0.1.0", `manifest version is ${manifest.version}`);
  assert(manifest.hostApi === 2, `hostApi is ${manifest.hostApi}`);
  assert(
    JSON.stringify(manifest.capabilities && manifest.capabilities.webhookReceiver) === JSON.stringify({ kind: "pebble" }),
    "manifest webhookReceiver must be exactly {kind: pebble}",
  );
  assert(packageManifest.version === "0.1.0", `package version is ${packageManifest.version}`);
  assert(channelEntry && channelEntry.version === "0.1.0", "channel entry version is 0.1.0");
  assert(channelEntry.path === "pebble", `channel path is ${channelEntry && channelEntry.path}`);
});

test("exports a synchronous webhookReceive method", () => {
  assert(typeof plugin.webhookReceive === "function", "webhookReceive is a function");
  const result = receive(payload({ event_id: "sync-event" }));
  assert(result && typeof result.then !== "function", "webhookReceive is synchronous");
});

for (const trigger of ["single-click-hold", "double-click-hold"]) {
  test(`delivers all Pebble fields for ${trigger}`, () => {
    const fixture = payload({ trigger, event_id: `fields-${trigger}` });
    const result = receive(fixture);
    assert(result && typeof result.text === "string", "valid fixture returns text");
    assert(result.eventId === fixture.event_id, "eventId carries event_id");
    for (const [key, value] of Object.entries(fixture)) {
      assertIncludes(result.text, `${key}: ${value}`, `${key} is preserved`);
    }
  });
}

test("represents an undocumented trigger as explicit unknown data", () => {
  const result = receive(payload({ trigger: "triple-click-hold", event_id: "unknown-trigger" }));
  assert(result, "unknown trigger fixture is delivered");
  assertIncludes(result.text, "trigger: unknown (triple-click-hold)", "unknown trigger is explicit");
});

test("accepts the documented unknown trigger value explicitly", () => {
  const result = receive(payload({ trigger: "unknown", event_id: "unknown-enum" }));
  assert(result, "unknown enum fixture is delivered");
  assertIncludes(result.text, "trigger: unknown", "unknown enum is visible");
});

test("strips ANSI, OSC, CSI, and control input and collapses whitespace", () => {
  const transcript = "\x1b[31mred\x1b[0m\ttext\nwith\x00 controls\x1b]0;unsafe title\x07\x7f";
  const result = receive(payload({ transcript, event_id: "hygiene-event" }));
  assert(result, "hygiene fixture is delivered");
  assertIncludes(result.text, "transcript: red text with controls", "transcript is sanitized");
  assert(!/[\x00-\x1f\x7f\x1b]/.test(result.text), "output contains no ANSI/control characters");
  assert(!result.text.includes("unsafe title"), "OSC title payload is removed");
});

test("visibly truncates transcript content at 8000 characters", () => {
  const result = receive(payload({ transcript: "x".repeat(8001), event_id: "truncate-event" }));
  assert(result, "truncation fixture is delivered");
  const transcriptLine = result.text.split("\n").find((line) => line.startsWith("transcript: "));
  assert(transcriptLine, "transcript line exists");
  assert(transcriptLine.endsWith("... [truncated]"), "truncation marker is visible");
  assert(transcriptLine.length === "transcript: ".length + 8000, "transcript line honors the 8000-character bound");
});

test("throws an observable failure for malformed or unsafe payloads", () => {
  const valid = payload({ event_id: "invalid-baseline" });
  const cases = [
    [null, "expected an object"],
    [[], "expected an object"],
    [{ ...valid, transcript: 42 }, "transcript"],
    [{ ...valid, trigger: null }, "trigger"],
    [{ ...valid, event_id: "" }, "event_id"],
    [{ ...valid, ring_id: "\x1b[31m\x1b[0m" }, "ring_id"],
    [{ ...valid, source_message_id: 42 }, "source_message_id"],
    [{ ...valid, recorded_at: "" }, "recorded_at"],
  ];
  for (const [invalid, expectedMessage] of cases) {
    assertThrows(() => receive(invalid), expectedMessage);
  }
  assertThrows(() => receive(null, null), "receivedAt");
  assertThrows(() => plugin.webhookReceive(null), "receivedAt");
});

test("suppresses repeated event_id values", () => {
  const first = receive(payload({ event_id: "duplicate-event", transcript: "first delivery" }));
  const second = receive(payload({ event_id: "duplicate-event", transcript: "replayed delivery" }));
  assert(first, "first delivery is returned");
  assert(second === null, "duplicate event_id is the deliberate no-op");
  assert(second !== first, "duplicate suppression differs from a failed delivery");
});

test("keeps replay suppression bounded and evicts the oldest id", () => {
  // Earlier tests have already occupied a few replay slots, so cross the
  // bound by one complete window plus one new id before checking eviction.
  for (let i = 0; i < 257; i += 1) {
    assert(receive(payload({ event_id: `bounded-${i}` })), `bounded event ${i} is delivered`);
  }
  assert(receive(payload({ event_id: "bounded-0" })), "oldest event is evicted after the replay bound");
});

test("source stays inside the synchronous QuickJS host contract", () => {
  for (const forbidden of [
    "host.fetch",
    "host.exec",
    "node:",
    "process.",
    "argv",
    "setTimeout",
    "setInterval",
    "EventSource",
    "SSE",
  ]) {
    assert(!source.includes(forbidden), `source must not use ${forbidden}`);
  }
});

let passed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
console.log(`${passed} Pebble plugin tests passed`);
