# Terminals

A worktree holds terminal tabs. Each tab has an id, a kind, a profile (the agent or shell in it), a state and a title.

## List

```sh
xdev terminal list
xdev terminal list --worktree <id> --json
```

Plain rows are `id<TAB>kind<TAB>profile<TAB>state<TAB>title`. A tab id may be shortened to a unique prefix.

## Wait

```sh
xdev terminal wait --tab <id> --for done
xdev terminal wait --tab <id> --for needs-you --timeout 120
```

States to wait for:

- `idle`: the agent stopped producing output.
- `done`: the agent finished its turn.
- `needs-you`: the agent asked for a decision.
- `exit`: the process ended.

The answer is `state<TAB>atMs`. Exit 4 means the timeout passed with no change. Exit 5 means the tab closed. Exit 6 means xDev quit.
