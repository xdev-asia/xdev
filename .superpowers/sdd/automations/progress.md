# Lane automations: progress

Branch `feat/automations`, base `0aab035`. Plan: `plans/2026-11-04-automations.md`.

A first run left everything uncommitted (contract stubs on the Rust side, most of the UI). This
run reviewed it task by task, fixed what failed the typecheck and tests, implemented B1 to B8
(only stubs existed) and committed each task.

## Tasks

- T1 Contract: complete
- B1 Cron and RRULE parsing: complete
- B2 Occurrences: complete
- B3 Store, retention, coalescing: complete
- B4 Tick plan and watchdog: complete
- B5 Precheck runner and extra args: complete
- B6 Service and dispatch: complete
- B7 Wiring (tick thread, real env, commands, `pty` and `workspace` edits): complete
- B8 Settings section tests: complete
- U1 Settings store and mock tests: complete
- U2 Schedule model and templates: complete
- U3 List model: complete
- U4 Run model: complete
- U5 Dispatch client: complete
- U6 Page, list, detail, history: complete
- U7 Editor dialog: complete
- U8 Run details and delete: complete
- U9 Settings page, catalog, CSS: complete

## Decisions

- `Store` methods do not save; the service saves after each write (`save()` is atomic).
- `run_now` queues a `pending` manual run ("Queued"); the next tick starts it, and the command
  kicks a tick. Scheduled `Dispatch` steps also create a `pending` run that the same pass starts.
- The store mutex is never held across a precheck, a worktree creation or an event.
- A rule that cannot be evaluated is retried after an hour (`advance`), folded into one run.
- Extra arguments: quotes, backslash and other shell characters are refused as `shellSyntax`
  (a Windows `--add-dir` path needs forward slashes). Save checks them against the agent's CLI
  when the profile is known; the dispatch and `pty_spawn` check again.
- `agentNeverStarted` after launch: the window fails the run two minutes after the prompt if the
  tab never worked; the backend takes that one report from a `dispatched` run.
- The tick thread reads the clock in 1 s slices; `RunEvent::Exit` sets `stop`.
- `ui_ready` is cleared when the window is destroyed.

## Deviations from the plan

- Commit order: U4 before U3 (`listModel` imports `runModel`); the `main.tsx` settings sync and
  `styles/automations.css` landed with U6; the editor, delete and run details were wired into the
  page in the commit after U7.
- `precheck::normalize` is in the B3 commit (the store needs it); `store.rs` has its own atomic
  write (the helper in `atomic.rs` lives in the desktop crate).
- The service tests that run a real precheck are `cfg(unix)` (they use `/bin/sh`).
- The B7 "stop within 2 s" test is not written (it needs a running `AppHandle`); the loop is 1 s
  slices and a pass in hand finishes first.
- The editor shows no UI for `automation_next_runs` (command exists, preview not in the plan's UI).
- `kit/testHooks.ts`: `nodes()` also walks a part's `actions` slot (Toolbar), so tests see the toolbar.

## Needs a Windows or macOS check

- Windows: precheck through the default shell and the CMD batch file (`cmd_file`), no console
  window, `taskkill /T /F` of the tree, jiff's bundled tz database (check `jiff` features in the
  build), CRLF in output snapshots.
- macOS: precheck through the login shell finds `gh`; App Nap delaying the tick; the window
  destroy event clears `ui_ready`.

## Gate (Linux)

install 0; typecheck 0; `pnpm -r test` 0 (xdev-ui 154, desktop 2316); desktop build 0; `cargo fmt
--all --check` 0; clippy `-D warnings` 0; `cargo test --workspace --no-fail-fast` 0 (1656 passed,
0 failed); bindings check 0; `git status` clean, submodule untouched at its pin.
