# Pebble

Receives Pebble Index/CoreApp transcription webhooks through CodeTerm and
forwards bounded, sanitized text to the General Agent.

## Setup

The CodeTerm host must support multipart webhook parsing; updating this plugin
alone cannot fix a host that only accepts JSON.

In CoreApp's Index webhook settings:

- URL: your reachable CodeTerm HTTPS origin plus `/api/plugins/pebble/webhook`.
- Header name: `Authorization`.
- Header value: `Bearer <secret>`.
- Send: **Transcription only**.
- Remove any manually configured `Content-Type`. CoreApp supplies
  `multipart/form-data; boundary=...` automatically.

Store the same secret as `pebble_webhook_secret` in CodeTerm's secret store.
Tailscale Serve works when the sending phone can reach that tailnet address.

## Wire contract

The [official webhook documentation](https://help.repebble.com/en/articles/15724406-index-advanced-features-mcp-webhook)
and [CoreApp sender](https://github.com/coredevices/mobileapp/blob/master/experimental/src/commonMain/kotlin/coredevices/ring/external/indexwebhook/IndexWebhookApi.kt)
define multipart fields `transcription`, `recordedAt` (epoch milliseconds),
and `client`. Test events also carry `test=true`.
The host decodes text parts into the receiver's payload object and skips file
parts. Audio is not transcribed by this plugin. Missing or empty transcription
is an observable receiver error; select Transcription only and check the
phone's transcription result.

The unsigned form supplies no event identifier. The plugin invents none,
returns no `eventId`, and keeps no replay cache. Identical requests are
processed again; exactly-once delivery is not promised. This avoids suppressing
a sender retry merely because the plugin ran before a host delivery failure.

## Safety and diagnostics

The host authenticates before parsing JSON or multipart content or invoking
the receiver. It limits the complete request to 1 MiB, with at most 16 form
parts and 64 KiB per text part. Oversized audio can still exceed the request
limit even though file parts are not forwarded.

The plugin does not open a listener, read secrets, call network APIs, or
execute transcript text. Output fields are JSON-quoted untrusted data.
ANSI/OSC/CSI sequences, controls, bidi and zero-width formatting are stripped.
Whitespace is collapsed; transcription is clipped to 8000 UTF-16 code units,
metadata to 256, with a visible marker and intact surrogate pairs.

HTTP 415 means the host rejected the media type. HTTP 400 means malformed
JSON/multipart. HTTP 502 means the receiver or agent delivery failed.
CodeTerm Settings → Logs contains host rejection codes and receiver failures,
without authentication headers or recording payloads.

<!-- revision: 1 -->
