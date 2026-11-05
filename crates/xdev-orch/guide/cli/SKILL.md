---
name: xdev-cli
description: Drive the xDev app from a terminal tab with the `xdev` CLI: see which worktree and tabs are open, create a worktree, set its status, wait for a tab. Use when the user asks you to do something in xDev itself; for starting worker agents use xdev-orchestration.
---

# xDev CLI

This file is a stub. The guide is built into the `xdev` binary, so it always matches the version you run.

1. Find the CLI: use `$XDEV_CLI` if it is set, else `xdev` on PATH.
2. Run `<cli> skills get cli` and follow it.
3. For a deeper topic run `<cli> skills get cli --reference <name>`. `<cli> skills get cli --references` lists the names.
4. If a command fails with `app_not_running` (exit 3), tell the user to open xDev.
