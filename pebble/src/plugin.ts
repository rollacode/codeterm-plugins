import type {
  WebhookDelivery,
  WebhookReceiveContext,
  WebhookReceiver,
} from "@codeterm/plugin-sdk";

type PebblePayload = {
  transcript: string;
  trigger: string;
  event_id: string;
  ring_id: string;
  source_message_id: string;
  recorded_at: string;
};

// The standalone connector receives this same upstream bound. Keep the marker
// visible so a clipped notification cannot be mistaken for a complete turn.
const TRANSCRIPT_MAX_LENGTH = 8000;
const TRUNCATION_MARKER = "... [truncated]";

// The host can keep one plugin VM alive for many webhook deliveries. This
// bounded insertion-ordered set prevents a replay from being delivered twice
// without allowing event ids to grow memory without limit.
const REPLAY_SET_LIMIT = 256;
const replayedEventIds = new Set<string>();

// eslint-disable-next-line no-control-regex
const OSC_SEQUENCE_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
// eslint-disable-next-line no-control-regex
const CSI_SEQUENCE_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OTHER_ESCAPE_RE = /\x1B[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

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

function truncateWithMarker(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const keep = Math.max(0, maxLength - TRUNCATION_MARKER.length);
  return `${text.slice(0, keep)}${TRUNCATION_MARKER}`;
}

function asPayload(value: unknown): PebblePayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (
    typeof raw.transcript !== "string" ||
    typeof raw.trigger !== "string" ||
    typeof raw.event_id !== "string" ||
    typeof raw.ring_id !== "string" ||
    typeof raw.source_message_id !== "string" ||
    typeof raw.recorded_at !== "string"
  ) {
    return null;
  }

  const eventId = sanitizeField(raw.event_id);
  const ringId = sanitizeField(raw.ring_id);
  const sourceMessageId = sanitizeField(raw.source_message_id);
  const recordedAt = sanitizeField(raw.recorded_at);
  const trigger = sanitizeField(raw.trigger);

  // An empty transcript is a valid Pebble utterance, but identity and timing
  // fields must remain usable after untrusted control data is removed.
  if (!eventId || !ringId || !sourceMessageId || !recordedAt || !trigger) {
    return null;
  }

  return {
    transcript: sanitizeField(raw.transcript),
    trigger,
    event_id: eventId,
    ring_id: ringId,
    source_message_id: sourceMessageId,
    recorded_at: recordedAt,
  };
}

function triggerLabel(trigger: string): string {
  if (trigger === "single-click-hold" || trigger === "double-click-hold" || trigger === "unknown") {
    return trigger;
  }
  return `unknown (${trigger})`;
}

function hasReplayed(eventId: string): boolean {
  if (replayedEventIds.has(eventId)) return true;

  replayedEventIds.add(eventId);
  if (replayedEventIds.size > REPLAY_SET_LIMIT) {
    const oldest = replayedEventIds.values().next().value as string | undefined;
    if (oldest !== undefined) replayedEventIds.delete(oldest);
  }
  return false;
}

function formatMessage(payload: PebblePayload): string {
  const transcript = truncateWithMarker(payload.transcript, TRANSCRIPT_MAX_LENGTH);
  return [
    "Pebble webhook event (transcript is untrusted text)",
    `transcript: ${transcript}`,
    `trigger: ${triggerLabel(payload.trigger)}`,
    `event_id: ${payload.event_id}`,
    `ring_id: ${payload.ring_id}`,
    `source_message_id: ${payload.source_message_id}`,
    `recorded_at: ${payload.recorded_at}`,
  ].join("\n");
}

const plugin: WebhookReceiver = {
  webhookReceive(ctx: WebhookReceiveContext): WebhookDelivery | null {
    if (!ctx || typeof ctx !== "object" || typeof ctx.receivedAt !== "string") {
      return null;
    }

    const payload = asPayload(ctx.payload);
    if (!payload || hasReplayed(payload.event_id)) return null;

    return {
      text: formatMessage(payload),
      eventId: payload.event_id,
    };
  },
};

export default plugin;
