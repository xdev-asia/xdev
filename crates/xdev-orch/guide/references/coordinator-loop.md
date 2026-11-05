# Coordinator loop

A run holds a DAG of tasks. A task is `ready`, `blocked`, `in_progress`, `completed` or `failed`.

1. `task-create --spec "<text>" [--title <t>] [--dep <task id>]...` for each unit of work. A task with open deps is `blocked`; it becomes `ready` when every dep is `completed`.
2. `worker-start --task <id> --agent <id>` for each `ready` task. Start independent tasks together so they run in parallel.
3. End your turn. A `worker_done` settles the task and promotes tasks that waited on it.
4. On wake, `check`, then start whatever became `ready`.
5. `run-show` lists tasks, workers and open gates when you lose track. `task-list --ready` lists what can start now.

Several runs: `run-create` again, `run-use <id>` to switch, `run-list` to see them. Pass `--run <id>` to act on one without switching.

A run is done when every task is `completed`. Report to the user only then, with what you verified.
