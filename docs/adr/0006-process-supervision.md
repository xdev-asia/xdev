# 0006. Process supervision: stop the whole tree

Status: accepted. Code: `xdev_ai::process`, `xdev-agent` (`process`, `squad`).
Date: 2026-11-02

## Context

xDev starts AI CLIs (Claude Code, Codex) as child processes. They start
through shims (`claude.cmd`, `node`), and the real agent is a grandchild or
deeper. Killing only the direct child on stop or timeout leaves the agent
running: it keeps editing the worktree and spending quota after the person
pressed stop.

## Decision

- Every AI CLI child xDev spawns with a timeout or a stop gets its own
  process group (`own_group`: `process_group(0)` on Unix, nothing on
  Windows).
- Every stop, cancel or timeout calls `kill_tree(pid)` while the child is
  still alive, then `kill` and `wait` on the child. Windows:
  `taskkill /PID <pid> /T /F` with `CREATE_NO_WINDOW`, which finds the tree
  by parent id. Unix: `kill -KILL -- -<pid>` on the group.
- One helper, in `xdev-ai` (the lower crate); `xdev-agent` uses it.
- Agent children get stdin closed and stdout and stderr read on their own
  threads, so a full pipe cannot stall them. After a kill, a grandchild
  that still holds a pipe can delay the result only for a bounded drain
  time.
- A squad run is driven by one process at a time: it holds a file lock
  (`run.lock`). A stop is a `stop` file the driving process polls; it then
  kills the agent's tree. A run whose lock is free but which never ended
  is marked stopped and its task paused when next read.

## Consequences

- A stop or timeout reaches the real agent on both platforms, not only the
  shim.
- [Inference] `taskkill /T` walks parent ids at kill time, so a process
  whose parent already exited is missed; Unix process groups do not have
  this gap unless a descendant leaves the group.
- If xDev itself crashes, nothing kills the agent tree.

## Not yet

- Windows Job Objects (kill on job close), so the tree dies even when xDev
  crashes.
- An environment allowlist for children; today they inherit xDev's
  environment.
- Finding and killing agent processes orphaned by a crashed xDev; today
  only the run record is recovered.
