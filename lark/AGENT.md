# LARK setup and diagnosis

Run these on the machine with the LARK receiver before giving instructions:

```sh
codeterm plugin get lark
codeterm plugin lark status
codeterm plugin lark diagnostics
```

The read-only plugin verbs require `agent_commands`; receiver status queries also require `local_recording`. Report a denied permission directly. `get` shows the installed version, grants/configuration and reload state. Version 0.1.0 lacks the singleton selection proposal added in 0.1.1. Version 0.1.2 repairs the blank settings page and adds diagnostic states; it does not repair transport or implement selection/reconnect.

The settings page shows status first. Its buttons, in order, are **Refresh status**, **Enable LARK**, **Disable LARK**, **Show diagnostics**. Permission is granted in Domios plugin permissions, not by a control in this page. After granting local recording, Enable LARK enables the existing host integration. Show diagnostics displays the same status/report as the diagnostic verb.

There is no receiver or microphone picker in LARK settings. The current host owns selection. Its separate recording device picker may offer devices after enabling; when no receiver is offered it may show nothing. Do not promise a visible picker. The plugin cannot enumerate devices, remember the owner's choice or reconnect automatically until a confined generic host API is provided. This is tracked separately in the owning plan as task_1r53v4.

Interpret `connection.state` before suggesting a step:

- `needs_permission`: grant local recording in Domios plugin permissions.
- `disabled`: use Enable LARK.
- `needs_selection`: the host has no selected receiver/microphone; gather device inventory if its picker is absent.
- `not_found`: a selection exists but the host reports it unavailable. Check USB connection and collect host logs. The host does not expose the transport failure reason here.
- `connected`: the host reports the selected receiver attached; validate battery and the physical double-press.
- `unknown`, `unsupported`, `error`: report the diagnostic detail. Do not guess an attachment cause.

The diagnostic object contains raw host status, the bounded receiver report (queried only while connected) and decoded transmitter batteries. Missing/invalid reports prove no percentage; they do not prove a receiver is absent. The plugin has no separate log file. Windows Domios logs are under `%USERPROFILE%/.codeterm/logs/`; production may omit debug-only local-recording messages.

Choose the recipient using its tab menu **Use LARK recording here**. Without a selected live target, the host uses General. Only a real double-press starting the existing recorder, a second double-press stopping it, and delivery to that recipient proves the complete recording journey.
