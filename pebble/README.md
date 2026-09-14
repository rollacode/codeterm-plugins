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
execute transcript text. Every payload field is treated as untrusted data and
is delivered as a JSON-quoted value under a header that says so: ANSI/OSC/CSI
sequences (7-bit and 8-bit), C0/C1 controls, and zero-width and bidi formatting
characters are removed, and whitespace is collapsed to one line. The transcript
is bounded at the upstream 8000 characters and every other field at 256; clipped
content ends with the visible `... [truncated]` marker and never splits a
surrogate pair.

`event_id` is the replay key, so it is never rewritten: an id that is empty,
longer than 256 characters, or contains control, formatting, or extra
whitespace characters is a failed delivery. Repeated `event_id` values are
ignored within the bounded lifetime of the plugin VM. An id is marked seen when
the plugin returns its delivery, before the host confirms the message reached
the agent, so a sender retry after a host-side delivery failure is suppressed
as a replay.

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
