---
name: xdev-orchestration
description: Run work in separate xDev worker agents and get their results back. Use when the user asks for xDev workers, a different agent (Codex from Claude), its own worktree, task DAGs, ask/reply or decision gates; also when you are a dispatched worker (your prompt has Task and Dispatch IDs). Otherwise prefer your own subagents.
---

# xDev orchestration

This file is a stub. The guide is built into the `xdev` binary, so it always matches the version you run.

1. Find the CLI: use `$XDEV_CLI` if it is set, else `xdev` on PATH.
2. Run `<cli> skills get orchestration` and follow it.
3. For a deeper topic run `<cli> skills get orchestration --reference <name>`. `<cli> skills get orchestration --references` lists the names.
4. If a command fails with `app_not_running` (exit 3), tell the user to open xDev.
