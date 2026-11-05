# xDev CLI

The `xdev` command talks to the xDev app that is already running on this machine. Use it to read the app's state and to change worktrees. Run it from a terminal tab inside xDev, so it knows which worktree and tab you are in.

Find it: `$XDEV_CLI` if set, else `xdev` on PATH. Add `--json` to a verb for the raw answer. Plain output is one row per line, columns split by TAB.

## Look

```sh
xdev status
xdev worktree current
xdev worktree ps
xdev terminal list
```

- `status`: app version, the worktree in front, tab counts.
- `worktree current`: the worktree this terminal runs in.
- `worktree ps`: worktrees of this repo. `--all` lists every repo.
- `terminal list`: tabs of a worktree (default: yours). `--worktree <id>` picks another.

## Change

```sh
xdev worktree create --name <name> --agent <profile>
xdev worktree set --status in-review --comment <text>
```

- `worktree create` makes a child of your worktree and prints `id`, `branch`, `path`. The new tab is not focused. `--from <ref>` sets the start point. `--prompt <text>` types text into the agent once it is ready; `-` reads stdin.
- `worktree set` changes the status, comment or title of a worktree (default: yours). Status is one of `todo`, `in-progress`, `in-review`, `completed`, `none`. A comment is at most 2000 characters.

## Wait

```sh
xdev terminal wait --tab <id> --for idle --timeout 600
```

`--for` is `idle`, `done`, `needs-you` or `exit`. Timeout is in seconds, at most 86400. It prints the state and the time. Do not poll `terminal list` in a loop; wait.

## Skills

```sh
xdev skills list
xdev skills get <topic> --full
xdev skills installed
xdev skills update
```

- `skills list`: the guides built into this binary.
- `skills get <topic>`: one guide. `--full` adds every reference; `--json` wraps it.
- `skills installed`: skills the agents on this machine load.
- `skills update`: refreshes installed copies of the bundled skills; it never adds one.

## Never

- Poll: no `sleep` loops around a verb.
- Edit files in another worktree. Create one with `worktree create`.
- Ignore an exit code. Read `references/exit-codes.md`.

## Other tools

- Start worker agents, hand out tasks, get results as mail: `xdev skills get orchestration`.
- Guides built into this binary: `xdev skills get cli`.

## References

- `worktrees`: placement, status values, parent and child.
- `terminals`: tab kinds, tab states, waiting.
- `exit-codes`: what each exit code means and what to do.

Read one with `xdev skills get cli --reference <name>`.
