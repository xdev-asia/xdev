# Low level

- `--retry-request <id>` on a mutating verb makes it safe to repeat: the first answer is stored and returned again, and nothing runs twice. Ids are kept 30 days, at most 10000.
- `request-show <id>` prints what a `--retry-request` answered.
- `reset --tasks` forgets the run's tasks, workers and gates. `reset --messages` forgets its mail. `reset --all` forgets every run. Ask the user first; it cannot be undone.
- `worker-read <handle> [--max-chars <n>]` returns the worker's terminal text.
- `--as <tab>` acts for another tab; the default is the terminal you run in.
- `--run <id>` acts on a run other than the current one.
