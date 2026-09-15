# Pebble

Receives Pebble Index/CoreApp transcription webhooks through CodeTerm and
forwards bounded, sanitized text to the General Agent.

## Setup

The token is per CodeTerm installation and is intentionally not embedded in
this plugin, the channel manifest, or its documentation. Open the Pebble view
in CodeTerm to display the current machine's webhook URL and token. The view
reads the active CodeTerm secret store and never writes the URL or token to the
plugin repository.

In CoreApp's Index webhook settings, copy the values shown by the Pebble view:

- URL: the displayed machine URL
- Header name: `Authorization`
- Header value: `Bearer <the displayed token>`
- Send: **Transcription only**
- Remove any manually configured `Content-Type`. CoreApp supplies
  `multipart/form-data; boundary=...` automatically.

If the view reports that the secret is unavailable, create the
`pebble_webhook_secret` entry in CodeTerm Settings → Secrets, then refresh the
view.

The URL is generated for the machine running CodeTerm. The phone must be able
to reach that machine; HTTPS Tailscale Serve is suitable for a phone on the
same tailnet. Do not put the token in the URL or a query string.

The host must support multipart webhook parsing; updating this plugin alone
cannot fix a host that only accepts JSON.

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
execute transcript text. Output fields are JSON-quoted.
ANSI/OSC/CSI sequences, controls, bidi and zero-width formatting are stripped.
Whitespace is collapsed; transcription is clipped to 8000 UTF-16 code units,
metadata to 256, with a visible marker and intact surrogate pairs.

HTTP 401 means the Authorization header is missing or its Bearer value does
not match `pebble_webhook_secret`. HTTP 415 means the host rejected the media
type; remove a manually supplied Content-Type and use CodeTerm 1.10.20 or
newer. HTTP 400 means malformed JSON/multipart. HTTP 502 means the receiver
or agent delivery failed.
CodeTerm Settings → Logs contains host rejection codes and receiver failures,
without authentication headers or recording payloads.

<!-- revision: 3 -->
