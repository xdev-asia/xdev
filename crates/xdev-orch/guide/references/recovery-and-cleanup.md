# Recovery and cleanup

- Circuit breaker: after repeated failures on one task, `worker-start` answers `circuit_broken`. Change the spec or ask the user.
- Depth: a worker starting workers is limited by the depth setting; past it you get `nested_worker_depth_exceeded`.
- `stop_unknown`: `worker-stop` closes the tab and waits. If the tab does not confirm, the worker is `stop_unknown`. Run `worker-show`; if the tab is gone, `worker-abandon`.
- `worker-abandon <handle>`: give a worker up without closing its tab. Its dispatch counts as failed and the task goes back to `ready`.
- `worker-release <handle> --outcome succeeded|failed`: settle a ready worker by hand. Answers `already_released` if it is already settled.
- `worker-keep-open <handle> [--off]`: keep the tab past the auto-close. While kept, `worker-stop` is refused with `worker_kept`.
- Reopen a task: `task-update <id> --status ready`, then `worker-start --task <id>`. A failed task needs `--retry-of <dispatch>`.
- A worker that stops without `worker_done` is escalated to you with a `stopReason`: finished, needs_input or exited.
