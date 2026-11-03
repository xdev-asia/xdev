# Plan 4b integration review (`main..feat/status-4b-int`)

Reviewer: claude-3-b. Base: `main`. Branch: `feat/status-4b-int` (backend + UI lanes merged, conflicts resolved in 900cdcd).

Every outcome lists its commit. "Left" items give the reason. Items marked [Unverified] were not checked against a real CLI or OS.

## Blocker

| # | Finding | Outcome |
|---|---|---|
| B1 | The status settings have `suppressWhenFocused`, but the UI has no switch for it. The guide said "no switch yet". | Fixed in 25efc36 with the "Quiet when in view" switch on the Notifications page. Guide updated in ec5dc6b. |
| B2 | The UI caps (`prompt/needsInput/turnDone`) were guessed from the CLI name. The backend wires different events by version and codex home, so a codex on `notify` alone was treated as fully hooked. | Fixed in 70e9a88. `capsFor(Launch.hook_events)` is passed through `PtyInfo.hookEvents`. |
| B3 | `docs/guide/agent-hooks-cli.md` did not match the Rust CLI. It was missing the output format, exit codes, file places and the stderr line, and it said nothing about the open-tab effect. | Fixed in ec5dc6b. |
| B4 | The `.off` marker was not synced with `status.hooks` at startup. A setting changed while the app was closed (or a stale marker) left the hooks in the wrong state. | Fixed in 16d47cc. |

## Should-fix

| # | Finding | Outcome |
|---|---|---|
| S1 | A codex private home was keyed only by account. Two profiles with their own `CODEX_HOME` and no account shared one home and re-linked each other's `auth.json`. | Fixed in 6d5cf7a. The folder is now `<account>-<8 hex of real home>`. |
| S2 | `link_auth` had two problems. Two launches racing both got `AlreadyExists`. The backup name `unlinked-<ms>` could collide. | Fixed in 6d5cf7a. A link that is already the same file is accepted, and the backup name is `unlinked-<ms>-<pid>-<n>`. |
| S3 | A pane without prompt hooks (codex on `notify`) was woken by output but never quieted by timing, so it stayed working. | Fixed in 5994226. Quiet ends working when `!caps.prompt`. |
| S4 | R18: a `resume` that came right after `turn-done` was dropped, so the turn read as done while it went on. | Fixed in 2e31c68 (`DONE_QUIET_MS` window). |
| S5 | Turning Status hooks off left open panes trusting their hook caps. With the marker set, no hook comes, so they hung in working. | Fixed in bebe6ae. `setHooks(false)` puts panes back on timing, and the guide is updated. |
| S6 | The settings pages saved a whole copy loaded at mount, so one switch overwrote changes made elsewhere. | Fixed in 1957350 (`patchStatusSettings` reads the stored settings, then writes the patch). |
| S7 | `status_notify` swallowed an OS refusal, so the Test hint never showed. | Fixed in 169135b. It now returns `CmdError::io`. |
| S8 | A failed turn (`failed`, pty alive) was treated as a dead tab. Send and prompt targets skipped it. | Fixed in b712d3f (`runningAgent` = agent and no exit code). |
| S9 | Line counts were not read again when a hooked turn ended as `done`. | Fixed in 421e961 (`SETTLED` includes `done`). |
| S10 | The bell hint said it counts tabs, but it counts worktrees. | Fixed in 8ffb774, en and vi. |
| S11 | A tab opened without `cli` (a custom profile running claude or codex) got no caps or account. | Fixed in 2e4f579 (`PtyInfo.cli` from `Launch.cli`). |

## Nit / left

| # | Finding | Outcome |
|---|---|---|
| N1 | The sidebar unread row ignores the event switches. | Left. C14 says a BEL (and any unread state) always marks unread, and only the channels depend on the switches. The row mark is not a channel. |
| N2 | No sound plays when the OS notification fails. | Left. This is by design and tested ("a sound goes only with an OS notification that was sent"). |
| N3 | `main.rs` agent-hook parsing uses `args`, not `args_os`. A non-UTF-8 argument makes clap fail. | Left. It exits 0 with a stderr line, so the agent is not hurt. |
| N4 | `sound.ts` `force` play does not set `last`, so a Test followed by an event can play twice within 2 s. | Left (cosmetic). |
| N5 | `markRead` on a `done` tab leaves it `done`, not idle. | Left. Looking at the pane makes it idle, and mark read only clears the bold. |

## [Unverified]

These need a real CLI, OS or long run. None were checked in this review.

- A codex token refresh that replaces `auth.json` by rename breaks the hard link. The next launch sets it aside and links again, but a running codex in the private home keeps the old token until then.
- The cmd.exe quoting of hook commands (`--%` form) has not been checked on a real Windows shell with spaces in paths.
- Codex trust-hash test vectors come from the spike, not from a codex build.
- `AGENTS.md` and other files in the real codex home besides `config.toml`, `auth.json` and `sessions` are not bridged into the private home.
- The sessions bridge is made after the first launch writes, so the first session may be private.
- The CLI version probe has no timeout or cache check against a real slow CLI.
- The version cache has no mtime key, so an upgraded CLI keeps the old caps until restart.
- `hooks/<pty>.jsonl` and the `.turn`/`.done` side files are never cleaned up.
- `caps.needsInput` is computed but not read by the state machine.
- Focus versus pointerdown order for "seen" has not been checked on macOS or Linux.

## Gate (2026-11-03)

- pnpm install, typecheck, build: ok.
- `pnpm -r test`: 829 + 6 vitest tests passed.
- `cargo fmt --check`: ok.
- clippy: failed once on a collapsible `if` in `src-tauri/src/lib.rs` (from 16d47cc). It passes after the fix.
- `cargo test --workspace`: 928 passed, 0 failed, 6 ignored.
- Bindings export: no diff.
