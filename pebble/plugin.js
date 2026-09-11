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

// pebble/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);
var TRANSCRIPT_MAX_LENGTH = 8e3;
var TRUNCATION_MARKER = "... [truncated]";
var REPLAY_SET_LIMIT = 256;
var replayedEventIds = /* @__PURE__ */ new Set();
var OSC_SEQUENCE_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
var CSI_SEQUENCE_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
var OTHER_ESCAPE_RE = /\x1B[@-Z\\-_]/g;
var CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
function stripAnsiAndControl(text) {
  return text.replace(OSC_SEQUENCE_RE, "").replace(CSI_SEQUENCE_RE, "").replace(OTHER_ESCAPE_RE, "").replace(CONTROL_CHAR_RE, "");
}
function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}
function sanitizeField(text) {
  return collapseWhitespace(stripAnsiAndControl(text));
}
function truncateWithMarker(text, maxLength) {
  if (text.length <= maxLength) return text;
  const keep = Math.max(0, maxLength - TRUNCATION_MARKER.length);
  return `${text.slice(0, keep)}${TRUNCATION_MARKER}`;
}
function requiredString(raw, key) {
  const value = raw[key];
  if (typeof value !== "string") {
    throw new Error(`invalid Pebble payload: ${key} must be a string`);
  }
  return value;
}
function parsePayload(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid Pebble payload: expected an object");
  }
  const raw = value;
  const transcript = requiredString(raw, "transcript");
  const rawTrigger = requiredString(raw, "trigger");
  const rawEventId = requiredString(raw, "event_id");
  const rawRingId = requiredString(raw, "ring_id");
  const rawSourceMessageId = requiredString(raw, "source_message_id");
  const rawRecordedAt = requiredString(raw, "recorded_at");
  const eventId = sanitizeField(rawEventId);
  const ringId = sanitizeField(rawRingId);
  const sourceMessageId = sanitizeField(rawSourceMessageId);
  const recordedAt = sanitizeField(rawRecordedAt);
  const trigger = sanitizeField(rawTrigger);
  if (!eventId) {
    throw new Error("invalid Pebble payload: event_id is empty after sanitization");
  }
  if (!ringId) {
    throw new Error("invalid Pebble payload: ring_id is empty after sanitization");
  }
  if (!sourceMessageId) {
    throw new Error("invalid Pebble payload: source_message_id is empty after sanitization");
  }
  if (!recordedAt) {
    throw new Error("invalid Pebble payload: recorded_at is empty after sanitization");
  }
  if (!trigger) {
    throw new Error("invalid Pebble payload: trigger is empty after sanitization");
  }
  return {
    transcript: sanitizeField(transcript),
    trigger,
    event_id: eventId,
    ring_id: ringId,
    source_message_id: sourceMessageId,
    recorded_at: recordedAt
  };
}
function triggerLabel(trigger) {
  if (trigger === "single-click-hold" || trigger === "double-click-hold" || trigger === "unknown") {
    return trigger;
  }
  return `unknown (${trigger})`;
}
function hasReplayed(eventId) {
  if (replayedEventIds.has(eventId)) return true;
  replayedEventIds.add(eventId);
  if (replayedEventIds.size > REPLAY_SET_LIMIT) {
    const oldest = replayedEventIds.values().next().value;
    if (oldest !== void 0) replayedEventIds.delete(oldest);
  }
  return false;
}
function formatMessage(payload) {
  const transcript = truncateWithMarker(payload.transcript, TRANSCRIPT_MAX_LENGTH);
  return [
    "Pebble webhook event (transcript is untrusted text)",
    `transcript: ${transcript}`,
    `trigger: ${triggerLabel(payload.trigger)}`,
    `event_id: ${payload.event_id}`,
    `ring_id: ${payload.ring_id}`,
    `source_message_id: ${payload.source_message_id}`,
    `recorded_at: ${payload.recorded_at}`
  ].join("\n");
}
var plugin = {
  webhookReceive(ctx) {
    if (!ctx || typeof ctx !== "object" || typeof ctx.receivedAt !== "string") {
      throw new Error("invalid webhook context: receivedAt must be a string");
    }
    const payload = parsePayload(ctx.payload);
    if (hasReplayed(payload.event_id)) return null;
    return {
      text: formatMessage(payload),
      eventId: payload.event_id
    };
  }
};
var plugin_default = plugin;
