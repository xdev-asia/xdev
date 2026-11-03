# 0013. Agents run as their real CLI in embedded PTY terminals

Status: Accepted (2026-11-02). Code:
`apps/desktop/src-tauri/src/pty.rs`.
Date: 2026-11-02
Amends 0003, 0004, 0006 and 0012. Defers 0001 and 0007–0011.

## Context

ADR 0003 runs agents headless through `trait Runner` and shows the result in
a task view. That hides the CLI people already use, and every CLI release
can break the wrapper. People already run agent CLIs in plain terminals, one
git worktree per job, several jobs at once. What they lack is the glue:
worktrees, status, notifications, review, commit and PR, and quota per
account. The plugin platform (0001, 0007–0011) is not built, and the
workspace comes first.

## Decision

- Each worktree has its own terminal tabs. A tab is a PTY running a shell or
  an agent CLI, with cwd set to the worktree. xDev does not parse the
  agent's conversation or drive it through a private protocol; the tab shows
  what the CLI prints.
- PTY layer: `portable-pty` (ConPTY on Windows) in Rust, xterm.js in the
  frontend, one `Terminal` per tab, disposed on close. One reader thread per
  PTY does 8 KB reads and coalesces chunks for up to 16 ms before sending them
  on a Tauri `Channel`. If the frontend falls behind by more than 4 MB, the
  reader pauses until it catches up.
- Commands are `pty_spawn`, `pty_write`, `pty_resize` and `pty_kill`.
  `pty_spawn` takes an agent profile id, never a program string, so the
  policy check runs in Rust.
- A profile is program, args, env, model, effort, permission mode and
  account. New profiles start in the CLI's normal, asking mode. A profile
  set to skip approvals shows a red badge on its tabs.
- Agent launch passes a new `Action::LaunchAgent { profile, program,
  permissions }` in `xdev-policy`. The default rule is `Ask`. The approval is
  remembered per profile with a blake3 fingerprint of the resolved program,
  args and permission mode; a change to any of them asks again. A profile in
  `skip` mode asks every time.
- Shell tabs are not gated: the person types every command.
- A repo's `xdev.yaml` is repo content, so data (ADR 0004). Its `setup`,
  `copy` and `archive` commands run only after the person trusts that file.
  Trust is stored with the file's hash; a changed file asks again. `run`
  commands start only from a click.
- Scrollback: a ring of the last 2 MB per tab in memory, mirrored to
  `<local_dir>/pty/<id>.log` (the local folder of ADR 0012, never the
  roaming one). It is deleted with its worktree. A setting turns off keeping
  it after quit; then restore brings back the layout only. No encryption or
  redaction yet.
- Agent status (`working`, `needs-you`, `done`, `failed`, `idle`) comes from,
  in order: hook events, the terminal title (OSC 0/2), then output timing.
  Hook settings are passed per process, on the command line or in env; xDev
  does not write into the person's CLI config folders. The hook runs
  `xdev agent-hook <event>`, which reads `XDEV_PTY_ID` and appends one JSON
  line to `<local_dir>/hooks/<pty_id>.jsonl`. The app watches that folder.
  There is no network listener.
- Every spawn follows ADR 0006. Closing a tab, deleting a worktree,
  `pty_kill` and app exit call `kill_tree` on the tab's process.
- The headless runner, tasks and squads stay in the code and under the Tasks
  view, but are no longer the main way to run agents.

## Consequences

- The person sees and uses each CLI as it ships. [Inference] A new CLI
  release needs no xDev release unless its flags for model, effort, permissions or hooks
  change.
- Flag mapping per CLI lives in one table in `xdev-agent`, with a test per
  CLI. Unknown CLIs get no mapping; their args are used as typed.
- [Unverified] Hook flags and config overrides can change or disappear
  between CLI versions. They are checked in a phase 0 spike; a CLI with no
  per-process hook falls back to the terminal title and output timing, which
  are less exact, and some states (such as `needs-you`) may not be shown.
- Shell tabs and approved agent tabs run with the person's rights, as they
  would in a plain terminal. The worktree is still not a sandbox (ADR 0004).
- Scrollback on disk is raw terminal output and may hold whatever a command
  printed, including secrets. It stays on the machine, in the local folder.
- Windows Job Objects are still "Not yet" in ADR 0006, so a
  crashed xDev can leave a PTY process tree behind, as it can today.
- Terminals do not survive quitting the app. On relaunch, agent tabs show
  "Ended — Resume" with the CLI's own resume command. A separate PTY daemon
  is a later decision.
- Two ways to run agents (PTY tabs and headless tasks) means two code paths
  to keep working until tasks are retired or rebuilt on top of tabs.
