# Plan 4b, lane B (backend) — progress

Worktree `wt/status-4b-backend`, branch `feat/status-4b-backend` from `feat/status-notifications` @ 4910b8b.

## Task 1: complete (C1 claude events + version gate)
- `crates/xdev-agent/src/version.rs`: `CliVersion::parse` + `cli_version(program)`, `--version` run once per
  (program path, file mtime) per process, 5 s timeout, no console window.
- `hook_args(cli, xdev, version)`: claude gets the 8 C1 events with `"timeout": 10` (number) on >= 2.1.317;
  unknown/older versions get only `UserPromptSubmit` + `Stop`. `Notification` dropped.
- [Unverified] the first claude version supporting PermissionRequest, Elicitation, ElicitationResult,
  PreToolUse(AskUserQuestion), PostToolUse, StopFailure: gate set at 2.1.317 (the only version checked).
- Matchers: `*` on PermissionRequest/Elicitation/ElicitationResult/PostToolUse, `AskUserQuestion` on
  PreToolUse, none on UserPromptSubmit/StopFailure/Stop (same as the spike's settings).
- `Launch::add_hooks` probes the version; `add_hooks_with(xdev, version)` for tests/callers that know it.
- needs-input idempotent: `append_hook_detail` drops a `needs-input` within 2000 ms (`REPEAT_MS`) of a
  `needs-input` that is the file's last line. Decision: a time window, not "any repeat", so a second
  permission prompt after a denied one (no PostToolUse in between) still shows.
- `append_hook_detail` also clips detail strings to DETAIL_MAX and keeps the line < 4096 bytes (R5).

## Task 2: complete (C6 bounded stdin in `xdev agent-hook`)
- CLI `Event` covers all 7 HookEvent values (kebab on the command line).
- Hook JSON: codex `notify` payload = last argument when it parses as a JSON object; otherwise stdin,
  skipped when a terminal, read up to 64 KiB, waited on at most 1 s (an over-cap input is cut, fails to
  parse, so no detail). Junk/non-object input still writes the bare line.
- Whitelist: `tool_name`, `message` (`last_assistant_message` stands in on turn-done), `is_interrupt`,
  `error`; notify: only `last-assistant-message`. Never `prompt`, `input-messages`, `tool_input`, `cwd`,
  `transcript_path`.
- Notify turn filter: `UserPromptSubmit` (codex hooks) stores `turn_id` in `<local>/hooks/<id>.turn`
  (the desktop watcher reads only `*.jsonl`, so it is ignored there); a notify whose `turn-id` differs
  is dropped. No `.turn` file (old codex, notify only) → every payload counts.
- Interpretation: "prints nothing" = stdout. A failure (bad/missing XDEV_PTY_ID, unknown event) still
  prints one stderr line, as before 4b and as the existing tests require; exit is always 0.
