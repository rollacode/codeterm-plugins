# LARK M2

Use the selected LARK M2 transmitter double-press to START the existing Domios recorder; double-press again to STOP and send audio through the configured Transcriber. LARK contains no recorder, transcription engine or sender.

Requires Domios 1.14.3 or newer carrying the reviewed local recording wiring; host inclusion and publication are still pending. Install only a reviewed matching host/plugin pair. Grant `local_recording`, open the LARK view and enable. With a supported receiver connected, the host offers an explicit receiver/microphone picker. Choose the LARK microphone; no default microphone is substituted. Select a recipient from its tab menu with **Use LARK recording here**. Default General semantics are host-owned. The recipient/session is frozen at START; changing focus does not reroute the clip.

The existing composer recording indicator and Cancel control remain active. Recording continues until the next double-press or explicit cancellation, without a duration limit. Disable, grant revoke, receiver loss, microphone failure or plugin unload cancels capture. Reconnect requires explicit rearming. Another manual recording/preview prevents concurrent hardware capture. The selected receiver descriptor is validated; release reports and foreign input never toggle.

Enabling captures/uploads nothing. No network, subprocess, secrets or broad input permission is requested. Audio uses existing attachment retention and configured transcription permissions; LARK adds no telemetry or credentials. Failed/cancelled owned clips are removed unless an ordinary delivery may already have accepted them; uncertain sends never replay.

Windows button-to-recording/transcription proof is pending. macOS native source is present but unavailable until exact descriptor/button element mapping is approved; native arm64 build, physical Mac and Intel verification remain pending. Linux is inert. No compatibility claim is based on portable fixtures alone.

Build: `node scripts/build-plugin.mjs lark`. Focused logic/privacy fixture: `node lark/plugin.test.cjs`. Do not edit generated `plugin.js` or split UI bundles. No release/installation is performed by the build.

The monochrome icon uses the Hollyland emblem shown on the [official LARK M2 product page](https://www.hollyland.com/product/lark-m2), with currentColor for the host theme.

The LARK plugin owns the fixed heartbeat query, response decoding, transmitter connection/battery interpretation and status bubble. The host provides only a bounded exchange for the immutable manifest-declared query on the exact selected receiver, gated by the persisted local-recording grant. It exposes no arbitrary device path or runtime output command. Unknown or unavailable status hides the percentage. Protocol references: https://github.com/soradev64/omarchy-lark-battery and https://github.com/blchinezu/larkctl.

The transmitter button collection/interface, report schema, approved button usages and duplicate window are declared by this plugin. The host validates that declared HID pattern and selected device; it contains no LARK-specific IDs or button protocol values in the production Windows adapter. A different producer declares its own supported singleton-button pattern through the same capability.
