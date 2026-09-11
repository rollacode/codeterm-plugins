# Pebble

The Pebble plugin receives the authenticated Pebble ring webhook through
CodeTerm's host and delivers one sanitized, bounded message to the General
Agent. It supports the `single-click-hold` and `double-click-hold` triggers;
other non-empty trigger strings are retained as explicit `unknown (...)` data.

The host owns the route and authentication:

- Route: `POST /api/plugins/pebble/webhook`
- Header: `Authorization: Bearer <secret>`
- Secret-store name: `pebble_webhook_secret`

The six payload names — `transcript`, `trigger`, `event_id`, `ring_id`,
`source_message_id`, and `recorded_at` — come from the closed-source Pebble
CoreApp contract. They have not been verified against a live CoreApp in this
repository. A rename, casing change, or missing field is therefore an
observable failed delivery rather than a deliberate no-op, so the mismatch is
available for diagnosis instead of being silently discarded.

The plugin does not open a listener, parse URL tokens, call a network API, or
execute transcript text. Transcript content is treated as untrusted text:
ANSI/OSC/CSI and control sequences are removed, whitespace is collapsed to one
line, and content beyond the upstream 8000-character bound ends with the
visible `... [truncated]` marker. Repeated `event_id` values are ignored within
the bounded lifetime of the plugin VM.

## Installation

Refresh the registered marketplace channel and install the plugin:

```bash
codeterm plugin channel refresh codeterm-plugins
codeterm plugin install pebble
```

Then configure the Pebble CoreApp webhook to use the host route and the
`Authorization` header. The shared secret must be stored as
`pebble_webhook_secret` through CodeTerm's secret-store flow; do not put it in
the URL or in this repository.
