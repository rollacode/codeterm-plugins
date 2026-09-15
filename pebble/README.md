# Pebble

Receives Pebble Index/CoreApp transcription webhooks through CodeTerm and
forwards bounded, sanitized text to the General Agent.

## Setup

The token is per CodeTerm installation and is intentionally not embedded in
this plugin, the channel manifest, or its documentation. It is the value of
the `pebble_webhook_secret` entry in the prod CodeTerm secret store. It is not
the CodeTerm API token and it must never be placed in the URL or a query string.

On BLACKSTAR, retrieve the existing prod token from CodeTerm Settings →
Secrets, or run this locally on the prod machine:

```text
codeterm mem secret get --name pebble_webhook_secret
```

If the entry does not exist, create one in Settings → Secrets, then use the
same value in both CodeTerm and CoreApp. A token rotation requires updating
both places; do not commit or send the value through GitHub, chat, or a URL.

For Andrey's prod BLACKSTAR, configure CoreApp's Index webhook as follows:

- URL: `https://blackstar.tail0e459c.ts.net/api/plugins/pebble/webhook`
- Header name: `Authorization`
- Header value: `Bearer <the value of pebble_webhook_secret>`
- Send: **Transcription only**
- Remove any manually configured `Content-Type`. CoreApp supplies
  `multipart/form-data; boundary=...` automatically.

For another CodeTerm host, replace only the HTTPS origin and keep the path
`/api/plugins/pebble/webhook`. The phone must be able to reach that host over
HTTPS; Tailscale Serve is suitable for a phone on the same tailnet.

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
execute transcript text. Output fields are JSON-quoted untrusted data.
ANSI/OSC/CSI sequences, controls, bidi and zero-width formatting are stripped.
Whitespace is collapsed; transcription is clipped to 8000 UTF-16 code units,
metadata to 256, with a visible marker and intact surrogate pairs.

HTTP 401 means the Authorization header is missing or its Bearer value does
not match `pebble_webhook_secret`. HTTP 415 means the host rejected the media
type; remove a manually supplied Content-Type and use CodeTerm 1.10.19 or
newer. HTTP 400 means malformed JSON/multipart. HTTP 502 means the receiver
or agent delivery failed.
CodeTerm Settings → Logs contains host rejection codes and receiver failures,
without authentication headers or recording payloads.

<!-- revision: 2 -->
