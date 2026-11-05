# Worktrees

A worktree is one checkout of the repo with its own branch and its own tabs. xDev shows each as a row in the sidebar.

## Create

```sh
xdev worktree create --name <name>
xdev worktree create --name <name> --parent <id> --from <ref>
```

- Without `--parent` the new worktree is a child of yours. Give `--parent` an id, a unique id prefix, a name or a path to place it elsewhere.
- Without `--from` it starts from the repo's base branch.
- The output is `id<TAB>branch<TAB>path`. Keep the id: other verbs take it.
- `--agent <profile>` opens that agent in the new worktree. `--prompt <text>` is typed to it when it is ready.

## Read

```sh
xdev worktree ps
xdev worktree current --json
```

`ps` prints `name<TAB>branch<TAB>status<TAB>agents<TAB>id`. `--all` adds the worktrees of every repo.

## Set

```sh
xdev worktree set --worktree <id> --status completed
xdev worktree set --title <text>
```

Status values: `todo`, `in-progress`, `in-review`, `completed`, `none`. Set `in-review` when your work is ready for a person to look at. Without `--worktree` the verb changes yours.
