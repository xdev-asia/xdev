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

## Open a file

```sh
xdev file open <path> --line 12
xdev file open src/main.rs:12:3
```

- `file open` shows a file in the xDev window and brings the window to the front. The path is absolute or relative to the current folder, and must be inside a worktree xDev knows. A `..` that leaves the worktree is refused.
- `--line` and `--column` (1-based) win over a `:line:column` suffix. It prints `opened`, the worktree, the path, the line and the column.

## Ports

```sh
xdev ports
xdev ports --all --json
xdev ports --worktree <id>
```

- `ports`: the listening ports of your worktree, as a table of `PORT`, `PID`, `PROCESS`, `WORKTREE`. From outside xDev's terminals it lists every worktree.
- `--worktree <id>` picks another worktree. `--all` lists every worktree.
- `--json` gives `ports`, each with `port`, `pid`, `process`, `worktree`, `worktreeName`, `url`, `protocol`, and `unavailable` when the scan could not run.

## Automations

```sh
xdev automations list
xdev automations show <id>
xdev automations runs <id> --limit 5
xdev automations run <id>
xdev automations disable <id>
xdev automations remove <id> --yes
```

- `list`, `show`, `runs`: read only. An id is the full id, a unique prefix, or the exact name. `runs` shows the newest runs, `--limit` is 1 to 200, default 10.
- `run` queues a run now, as Run now does in the app, paused or not. The window starts it. It prints `queued`, the run id and the status.
- `enable` lets the schedule run it; `disable` stops the schedule. `remove` deletes the automation and its runs, and needs `--yes`.
- `run`, `enable`, `disable` and `remove` change state. Like the worktree writes, they pass when the automation's worktree is yours and otherwise ask the person.

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
