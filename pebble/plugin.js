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
var FIELD_MAX_LENGTH = 256;
var TRUNCATION_MARKER = "... [truncated]";
var OSC_SEQUENCE_RE = /(?:\x1B\]|\x9D)[^\x07\x1B\x9C]*(?:\x07|\x1B\\|\x9C)/g;
var CSI_SEQUENCE_RE = /(?:\x1B\[|\x9B)[0-9;?]*[ -/]*[@-~]/g;
var OTHER_ESCAPE_RE = /\x1B[@-Z\\-_]/g;
var CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
function stripAnsiAndControl(text) {
  return text.replace(OSC_SEQUENCE_RE, "").replace(CSI_SEQUENCE_RE, "").replace(OTHER_ESCAPE_RE, "").replace(CONTROL_CHAR_RE, "");
}
function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}
function sanitizeField(text) {
  return collapseWhitespace(stripAnsiAndControl(text));
}
function isHighSurrogate(code) {
  return code >= 55296 && code <= 56319;
}
function truncateWithMarker(text, maxLength) {
  if (text.length <= maxLength) return text;
  let keep = Math.max(0, maxLength - TRUNCATION_MARKER.length);
  if (keep > 0 && isHighSurrogate(text.charCodeAt(keep - 1))) keep -= 1;
  return `${text.slice(0, keep)}${TRUNCATION_MARKER}`;
}
function requiredString(raw, key) {
  const value = raw[key];
  if (typeof value !== "string") {
    throw new Error(`invalid Pebble payload: ${key} must be a string`);
  }
  return value;
}
function boundedField(raw, key) {
  const value = truncateWithMarker(sanitizeField(requiredString(raw, key)), FIELD_MAX_LENGTH);
  if (!value) {
    throw new Error(`invalid Pebble payload: ${key} is empty after sanitization`);
  }
  return value;
}
function parsePayload(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid Pebble payload: expected an object");
  }
  const raw = value;
  if (typeof raw.transcription !== "string" || !sanitizeField(raw.transcription)) {
    throw new Error("Pebble transcription is missing or empty; set CoreApp Send to Transcription only");
  }
  const transcription = truncateWithMarker(
    sanitizeField(raw.transcription),
    TRANSCRIPT_MAX_LENGTH
  );
  const recordedAt = requiredString(raw, "recordedAt");
  if (!/^\d{1,16}$/.test(recordedAt) || !Number.isSafeInteger(Number(recordedAt))) {
    throw new Error("invalid Pebble payload: recordedAt must be Unix epoch milliseconds");
  }
  return {
    transcription,
    recordedAt,
    client: boundedField(raw, "client"),
    ...raw.test === void 0 ? {} : { test: boundedField(raw, "test") }
  };
}
function formatMessage(payload) {
  return Object.entries(payload).map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join("\n");
}
var TARGET_UNAVAILABLE = "This CodeTerm build cannot report the receiver target. Events go to the General Agent.";
function unavailable(error, message = TARGET_UNAVAILABLE) {
  return { status: "unavailable", error, message };
}
function receiverTargetApi() {
  if (typeof host === "undefined" || host === null) return null;
  const api = host.receiverTarget;
  return typeof api === "object" && api !== null ? api : null;
}
function normalizeTarget(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return unavailable("receiver_target_unavailable");
  }
  const value = raw;
  if (typeof value.error === "string") {
    const message = typeof value.message === "string" && value.message ? sanitizeField(value.message) : "";
    return unavailable(sanitizeField(value.error) || "receiver_target_unavailable", message || TARGET_UNAVAILABLE);
  }
  if (value.pluginId !== void 0 && value.pluginId !== "pebble") {
    return unavailable("malformed_receiver_target");
  }
  if (typeof value.live !== "boolean") return unavailable("malformed_receiver_target");
  if (value.tabId === null) return { status: "general", tabId: null };
  if (typeof value.tabId !== "string" || !sanitizeField(value.tabId)) {
    return unavailable("malformed_receiver_target");
  }
  const tabId = truncateWithMarker(sanitizeField(value.tabId), FIELD_MAX_LENGTH);
  return value.live ? { status: "bound", tabId } : { status: "notLive", tabId };
}
function callReceiverTarget(verb) {
  const api = receiverTargetApi();
  const fn = api?.[verb];
  if (typeof fn !== "function") return unavailable("receiver_target_unavailable");
  try {
    return normalizeTarget(fn.call(api));
  } catch {
    return unavailable("receiver_target_unavailable");
  }
}
function viewCall(method) {
  if (method === "webhookSettings") {
    return { error: "This CodeTerm build does not provide webhook settings yet" };
  }
  if (method === "receiverTarget") return callReceiverTarget("get");
  if (method === "resetReceiverTarget") return callReceiverTarget("clear");
  return { error: `unknown view method: ${method}` };
}
var plugin = {
  webhookReceive(ctx) {
    if (!ctx || typeof ctx !== "object" || typeof ctx.receivedAt !== "string") {
      throw new Error("invalid webhook context: receivedAt must be a string");
    }
    const payload = parsePayload(ctx.payload);
    return {
      text: formatMessage(payload)
    };
  },
  viewCall
};
var plugin_default = plugin;
