# LARK M2

Use the selected LARK M2 transmitter double-press to START the existing Domios recorder; double-press again to STOP and send audio through the configured Transcriber. LARK contains no recorder, transcription engine or sender.

Requires the first Domios host release containing local recording wiring (currently targeted at 1.14.2; not yet verified for publication). Install only a reviewed matching host/plugin pair. Grant `local_recording`, open the LARK view and enable. With a supported receiver connected, the host offers an explicit receiver/microphone picker. Choose the LARK microphone; no default microphone is substituted. Select a recipient from its tab menu with **Use LARK recording here**. Default General semantics are host-owned. The recipient/session is frozen at START; changing focus does not reroute the clip.

The existing composer recording indicator and Cancel control remain active. The host discards recordings at the two-minute failure deadline. Disable, grant revoke, receiver loss, microphone failure or plugin unload cancels capture. Reconnect requires explicit rearming. Another manual recording/preview prevents concurrent hardware capture. The selected receiver descriptor is validated; release reports and foreign input never toggle.

Enabling captures/uploads nothing. No network, subprocess, secrets or broad input permission is requested. Audio uses existing attachment retention and configured transcription permissions; LARK adds no telemetry or credentials. Failed/cancelled owned clips are removed unless an ordinary delivery may already have accepted them; uncertain sends never replay.

Windows button-to-recording/transcription proof is pending. macOS native source is present but unavailable until exact descriptor/button element mapping is approved; native arm64 build, physical Mac and Intel verification remain pending. Linux is inert. No compatibility claim is based on portable fixtures alone.

Build: `node scripts/build-plugin.mjs lark`. Focused logic/privacy fixture: `node lark/plugin.test.cjs`. Do not edit generated `plugin.js` or split UI bundles. No release/installation is performed by the build.
