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

## Open, split, stop, close

```sh
xdev terminal create --title tests --cmd make
xdev terminal create --worktree <id> --cwd src --json
xdev terminal split --right
xdev terminal split --down --terminal <id>
xdev terminal stop --terminal <id>
xdev terminal close --terminal <id>
```

- `create` opens a shell tab in a worktree (default: yours) and prints its id. `--cmd` is one line, typed and run once the shell starts. `--cwd` is a folder inside the worktree, relative to the current folder; a folder outside is refused.
- `split` opens a shell in a new pane beside a tab's pane (default: this terminal's), in the folder that tab's shell is in now (where it started, if the shell does not report it; the root if it left the worktree), and prints the new id. Give `--right` or `--down`.
- `stop` ends the tab's process; the tab stays. Exit 5 means it had already ended.
- `close` closes the tab and prints its id. A tab id may be a unique prefix.
- Your own worktree passes. Opening in a child worktree passes. Anything else asks the person first; exit 7 means they said no.

## Show and name

```sh
xdev terminal switch --terminal <id>
xdev terminal rename build
xdev terminal set-pane-title tests --terminal <id>
```

- `switch` brings a tab (default: this terminal), its pane and its worktree to the front.
- `rename` names a tab by hand; titles its program sets no longer change it. An empty name gives the program's title back.
- `set-pane-title` sets the title the pane shows, as the program's own title would. The program's next title, or a name given by hand, wins.
- Your own worktree and its family pass. Anything else asks the person first.
