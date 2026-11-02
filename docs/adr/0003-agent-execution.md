# 0003. Agent execution: tasks on worktrees, runners behind a trait

Status: accepted. Code: `xdev-agent`.
Date: 2026-11-02

## Context

Coding agents (Claude Code now, others later) edit files and spend quota.
People need to see what an agent did, stop and continue it, and decide what
lands on their branch.

## Decision

- A task is a file, `<data_dir>/tasks/<id>/task.json`, written before and after
  every step, so a crash leaves a readable state.
- Each task gets branch `xdev/task-<id>` and its own git worktree under the data
  folder. Agents never edit the person's working copy.
- Agents run through `trait Runner`. Claude Code (`claude -p`, JSON output) is
  the first runner; Codex, hosted models, MCP tools and A2A agents become more
  runners, not new orchestration.
- States: ready, running, paused, review, failed, merged, discarded. A run
  that is not live on load is paused and resumes the same agent session.
- After a run, xDev commits the worktree, runs the test command and stores
  evidence: diff numstat against the base, test exit and output, cost, session.
- Merge is `--no-ff` into the person's current branch, only with their
  approval and a clean working copy; a conflict aborts and keeps the task in
  review.

## Consequences

- One task per worktree; parallel tasks on one repo are possible later
  without changing the model.
- Durable execution here means files plus resumable sessions, not a workflow
  engine. [Inference] That is enough for one machine; a team server would
  need a queue.
