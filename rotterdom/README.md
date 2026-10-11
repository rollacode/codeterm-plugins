# Rotterdom

A lightweight harness for any OpenAI-compatible `/chat/completions` endpoint: LM Studio, Ollama, OpenRouter and compatible hosted services. No watcher or decision adapter.

Version 0.1.0 requires Domios 1.14.2. Build with `node scripts/build-plugin.mjs rotterdom`; test the built QuickJS-compatible bundle with `node rotterdom/plugin.test.cjs`.

Configure `endpoints: [{id, baseUrl, models, secret?}]`, `profiles: [{id, name, endpoint, model, systemPrompt, root, allow, deny, readOnly?, params?, budgets}]` and `defaultProfile`. `baseUrl` includes the API prefix (usually `/v1`). Optional `secret` names a plugin-scoped stored secret; secrets never belong in config or history. Remote endpoints require `codeterm plugin settings rotterdom --allow-host host:port`.

The exact system prompt is preserved, including whitespace and an empty string. Sampling accepts temperature, top_p and seed. Budgets require positive integers: tokens (up to 1,000,000), turns (up to 100 model responses), deadlineMs (up to one hour). Endpoints must report token usage; unreported usage fails closed. Token usage includes input and output across every request. A response can consume the remaining budget before the host can refuse its tool calls.

Tools: shell, read_file, write_file, edit_file, glob, search. Only allowed tools are offered; dispatch enforces the same policy. Deny wins, `deny: ["*"]` refuses everything, and readOnly disables shell and file mutations. Unknown tools and undeclared arguments are refused. An arbitrary shell can write outside the root: granting shell cannot enforce path or command restrictions. File tools reject traversal, symlinks, Windows device names and stale content. Writes use a lock and atomic replacement. The confinement check does not protect against another process racing filesystem symlink changes.

History is saved atomically under the running instance's `rotterdom/session-<id>.json`. Each tool call is claimed durably before execution and completed durably after execution. A crash after claiming produces an unconfirmed result on recovery; it never re-executes the call. Reusing a call id with changed arguments is refused. Persistence failure stops execution. Closing a busy session cancels pending jobs; its uncertain tool effects remain in the ledger.

Host filesystem and subprocess grants remain the outer ceiling. Project roots are read-only until the owner explicitly grants `project_write` through Domios. This also applies in DEV; a denied file operation reports failure. Search caps entries, depth, file size and returned matches; file read/write limits are 128 KiB. Shell timeout is at most 120 seconds and also bounded by the remaining deadline.

The native wire, tool specification, transcript and instance CLI helpers derive from the retired LM Studio router at cc011d8. Endpoint request construction retains its OpenAI wire approach, with profile policy and budgets replacing the original unrestricted tool set.

## Domios chat

Open with `codeterm tab new --chat-backend rotterdom --config '{"profile":"coding"}'`. The provider picker exposes configured models and profiles as presets. Routed sends use the native loop and poll the resulting Chat UI transcript. Busy sessions refuse overlapping turns and model switches. Session ids equal tab ids; reopening the same tab recovers the saved history, without replaying pending calls. `systemPrompt` in session config overrides the profile verbatim, including an empty string. Model changes retain the profile policy and require a model configured for its endpoint.

## Predefined profiles

Omit `profiles`, configure `root`, `model`, and `endpoints`, and choose Coding, Reader, Domios Inspector or Domios Operator. Custom profiles replace these definitions and preserve their system prompts exactly. Coding has shell, files, search and a native report tool. Reader has file read and search only. Inspector exposes structured identify, tab, plan, memory and Blueprint reads, without arbitrary CLI or shell. Operator adds scoped describe, send, report, Blueprint input and stop actions. Its `targets: {tabs: [], plans: [], blueprints: []}` starts empty; configure exact ids before these actions can run.

Domios commands use argv and stdin, never model-authored shell strings. They resolve the running instance's CLI and inherit the session's host-owned tab/API identity. A target must pass both the profile's target list and the CLI's own authorization. Messages and reports go through `--from-pad -` with stdin. Read-only profiles exclude all mutating Domios commands.

## Project approval

After configuring an existing absolute root, the owner approves `codeterm plugin config rotterdom --grant project_write` and reloads the plugin. The host snapshots the canonical configured roots in `grants.yaml`. A new root requires a new approval; `--revoke project_write` clears write grants. Never edit grants from a model tool. The plugin declares generic `projectFiles` setting selectors, not an unrestricted filesystem permission. Arbitrary shell remains a separate broad subprocess grant and is excluded from read-only profiles.

## Blueprint Agent stage

The host exposes an `agent` step for providers declaring `chatBackend.agentTasks`. Use `provider: rotterdom`, a configured `profile`, `task`, `deadline_ms`, `max_tokens` and `max_turns`; its input and output are text. The output is structured JSON: `{status, output, error?}`. Status is `done`, `failed`, `cancelled` or `deadline_exceeded`; the pipeline routes `done` or `failed`. The final assistant response is parsed as JSON when possible, otherwise returned as a string.

The stage shrinks the profile budgets to the requested limits. The exact profile prompt remains unchanged; the task and preceding stage output are user inputs. Task history and a completion ledger persist independently under `task_<runId>`. Repeating an already claimed task returns its saved result or an unconfirmed refusal, never reruns it. Stage results route through Blueprint; the native `report` tool is disabled for stage tasks. Deadline and graph abort interrupt the host wait and cancel subprocess jobs; an unfinished write stays unconfirmed. No timer or poll loop advances an Agent stage.
