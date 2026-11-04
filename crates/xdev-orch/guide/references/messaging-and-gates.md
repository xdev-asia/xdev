# Messaging and gates

Addresses: `run:<id>` (the coordinator), `dispatch:<id>` (a worker), and groups `@all`, `@idle`, `@worktree:<id>`, `@<agent>`.

- `send --to <address> --subject <s> --body <text>`; `--body -` reads stdin. `--type` is one of status, dispatch, worker_done, merge_ready, escalation, handoff, decision_gate, question, heartbeat. `--priority urgent` is shown first. `--payload <json>` attaches data.
- `check` reads the oldest 50 unread messages and marks them handled. `--peek` does not mark. `--all` includes handled ones. `--types a,b` filters. `--wait` blocks; use it only when you have nothing else to do.
- `inbox` lists previews. `reply --id <message> --body <text>` answers in the same thread.
- `ask --question <q>`: a worker's ask returns at once, then the worker ends its turn and the answer arrives as mail. A coordinator's `ask --wait` blocks until a person answers, up to `--timeout-ms` (default 600000, at most 1800000). After a timeout the gate stays pending; pick the answer up with `ask --resume <gate>`.
- `gate-create --task <id> --question <q> [--option <o>]...` opens a decision gate on a task. `gate-resolve <id> --resolution <text>` closes it and the answer goes to the asker. `gate-list` lists them.
