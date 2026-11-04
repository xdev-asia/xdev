# xDev orchestration

You can start worker agents in other xDev terminal tabs, hand each a task, and get its result back as mail. Use it when the work is large, parallel, or needs a different agent or its own worktree. For small work, use your own subagents.

Every command is `xdev orchestration <verb>` (alias `xdev orch`). Add `--json` for the raw answer.

## Recipe

1. `run-create --objective "<goal>"` once. Your tab becomes the coordinator of the run.
2. Start a worker: `worker-start --spec "<task>" --agent <id>`. For a DAG, `task-create` first, then `worker-start --task <id>`.
3. End your turn. Do not wait in a loop.
4. When xDev wakes you with mail, run `check`.
5. Follow the `next` line of each receipt.

A start that failed is never rerun as it was. Retry with `--retry-of <dispatch>`.

## Never

- Poll: no `check` in a loop, no `sleep`.
- Steer a worker by typing into its terminal.
- Create checkouts yourself. Use `--worktree new-child`.

## When xDev wakes you

Run `check`. Then, per message type:

- `question`: answer with `reply`.
- `escalation`: read `stopReason`. Read the worker with `worker-read`, then retry or abandon it.
- `worker_done`: the task is settled. Verify the claim (diff, tests) before you tell the user.
- `decision_gate`: resolve it with `gate-resolve`.

Handle the whole batch, then end your turn.

## Task spec

A worker cannot see your conversation. Write the spec so it stands alone:

- the goal
- the files it may touch
- constraints
- the result you expect
- how to verify it

The spec may be up to 64 KiB. A larger one fails with `worker_prompt_too_large`.

## If you are a worker

Your prompt has a Task ID and a Dispatch ID. Do the task. Ask the coordinator with `ask` only when you are blocked, then end your turn. When done, run:

`xdev orchestration send --to run:<run id> --type worker_done --outcome succeeded|failed --body "<result>"`

Then stop. xDev closes your tab after a quiet spell unless it is kept open.

## Safety

Silence is not proof of success. A worker that stops without `worker_done` is escalated to you. Check its work before you rely on it.

## Deeper topics

Run `xdev skills get orchestration --reference <name>`:

- `coordinator-loop`: DAG, deps, several runs.
- `placement`: `--worktree` values, `--terminal`, setup.
- `messaging-and-gates`: groups, priorities, gates.
- `recovery-and-cleanup`: breaker, `stop_unknown`, abandon, release, keep-open, reopening a task.
- `low-level`: `--retry-request`, `request-show`, `reset`.
