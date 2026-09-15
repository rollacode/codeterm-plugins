import type {
  PluginModule,
  WebhookDelivery,
  WebhookReceiveContext,
  WebhookReceiver,
} from "@codeterm/plugin-sdk";

type PebblePayload = {
  transcription: string;
  recordedAt: string;
  client: string;
  test?: string;
};

// The standalone connector receives this same upstream bound. Keep the marker
// visible so a clipped notification cannot be mistaken for a complete turn.
const TRANSCRIPT_MAX_LENGTH = 8000;
const FIELD_MAX_LENGTH = 256;
const TRUNCATION_MARKER = "... [truncated]";

// eslint-disable-next-line no-control-regex
const OSC_SEQUENCE_RE = /(?:\x1B\]|\x9D)[^\x07\x1B\x9C]*(?:\x07|\x1B\\|\x9C)/g;
// eslint-disable-next-line no-control-regex
const CSI_SEQUENCE_RE = /(?:\x1B\[|\x9B)[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OTHER_ESCAPE_RE = /\x1B[@-Z\\-_]/g;
// C0/C1 controls plus zero-width and bidi formatting characters that can hide
// or reorder text the agent reads.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

function stripAnsiAndControl(text: string): string {
  return text
    .replace(OSC_SEQUENCE_RE, "")
    .replace(CSI_SEQUENCE_RE, "")
    .replace(OTHER_ESCAPE_RE, "")
    .replace(CONTROL_CHAR_RE, "");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sanitizeField(text: string): string {
  return collapseWhitespace(stripAnsiAndControl(text));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function truncateWithMarker(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let keep = Math.max(0, maxLength - TRUNCATION_MARKER.length);
  if (keep > 0 && isHighSurrogate(text.charCodeAt(keep - 1))) keep -= 1;
  return `${text.slice(0, keep)}${TRUNCATION_MARKER}`;
}

function requiredString(raw: Record<string, unknown>, key: keyof PebblePayload): string {
  const value = raw[key];
  if (typeof value !== "string") {
    throw new Error(`invalid Pebble payload: ${key} must be a string`);
  }
  return value;
}

function boundedField(raw: Record<string, unknown>, key: keyof PebblePayload): string {
  const value = truncateWithMarker(sanitizeField(requiredString(raw, key)), FIELD_MAX_LENGTH);
  if (!value) {
    throw new Error(`invalid Pebble payload: ${key} is empty after sanitization`);
  }
  return value;
}

function parsePayload(value: unknown): PebblePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid Pebble payload: expected an object");
  }

  const raw = value as Record<string, unknown>;
  if (typeof raw.transcription !== "string" || !sanitizeField(raw.transcription)) {
    throw new Error("Pebble transcription is missing or empty; set CoreApp Send to Transcription only");
  }
  const transcription = truncateWithMarker(
    sanitizeField(raw.transcription),
    TRANSCRIPT_MAX_LENGTH,
  );
  const recordedAt = requiredString(raw, "recordedAt");
  if (!/^\d{1,16}$/.test(recordedAt) || !Number.isSafeInteger(Number(recordedAt))) {
    throw new Error("invalid Pebble payload: recordedAt must be Unix epoch milliseconds");
  }
  return {
    transcription,
    recordedAt,
    client: boundedField(raw, "client"),
    ...(raw.test === undefined ? {} : { test: boundedField(raw, "test") }),
  };
}

function formatMessage(payload: PebblePayload): string {
  return Object.entries(payload)
    .map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
    .join("\n");
}

function viewCall(method: string): unknown {
  if (method === "webhookSettings") {
    return { error: "This CodeTerm build does not provide webhook settings yet" };
  }
  return { error: `unknown view method: ${method}` };
}

const plugin: WebhookReceiver & Pick<PluginModule, "viewCall"> = {
  webhookReceive(ctx: WebhookReceiveContext): WebhookDelivery | null {
    if (!ctx || typeof ctx !== "object" || typeof ctx.receivedAt !== "string") {
      throw new Error("invalid webhook context: receivedAt must be a string");
    }

    const payload = parsePayload(ctx.payload);
    return {
      text: formatMessage(payload),
    };
  },
  viewCall,
};

export default plugin;
