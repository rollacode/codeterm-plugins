Recorded Grok sessions used by the structured chat tests. Rows are verbatim; only bulk text was truncated.

`pulse-session/updates.jsonl`: 36 rows from Grok session `01a13ade-172b-7101-bc82-f5f7f189ae79`
(a Worker lane). Covers user prompt (truncated to 300 chars), hook_execution, thought, assistant
messages, `run_terminal_command` (exit 0 and exit 1), `grep` with `file_matches`, `list_dir`,
`read_file`, a failed `read_file`, `write` and `search_replace` with diff content,
`auto_compact_started` / `compaction_checkpoint` / `auto_compact_completed`, a cancelled
`turn_completed`, and the background task rows. Large tool outputs were cut to 300-400 chars;
the kept grep result is complete so its counts are exact.

`switch-session/`: Grok session `01a122fc-abe9-7281-9837-24a92a378d30`. `updates.jsonl` has long
assistant text cut to 300 chars; `events.jsonl` keeps only its `turn_started` rows, whose
`model_id` changes grok-4.6 -> grok-4.5 -> grok-4.6. That is the only recorded evidence of a model
switch: no `updates.jsonl` row records one.
