# Placement

`worker-start` decides where the worker runs.

- `--worktree current`: the coordinator's worktree. Workers that edit the same files will collide; use it for read-only or disjoint work.
- `--worktree <name or id>`: an existing worktree.
- `--worktree new-child`: a fresh worktree branched from the current one. Use it for parallel edits.
- `--worktree new-top-level`: a fresh worktree from the repo's main line.
- `--terminal <tab>`: use an existing tab instead of opening one. The task text is typed into it. The worker is kept open.
- `--setup inherit` runs the repo's setup first; `--setup skip` does not. `--setup run` behaves as `inherit`.
- `--name <text>`: the tab title; default `worker-<task id>`.
- `--keep-open`: do not auto-close the tab when the worker finishes.

`--model` and `--effort` are not supported yet and answer `unsupported`.
