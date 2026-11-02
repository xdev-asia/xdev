# 0004. Policy enforced by the app, owned by the person

Status: accepted. Code: `xdev-policy`.
Date: 2026-11-02

## Context

An agent reads repo files, docs and web pages that may contain instructions
aimed at it (prompt injection). A rule written into a prompt can be argued
away; a check in code cannot.

## Decision

- Every step that touches the person's repo, runs a command or spends quota
  passes `xdev_policy::Gate::check` first. `Deny` stops. `Ask` waits for a
  person; silence is never consent.
- The policy file is the person's: `<data_dir>/policy.json`. A repo, or an
  agent editing a repo, cannot loosen it.
- Merge and delete can be `ask` or `deny`, never `allow`.
- Agents get a short tool list by default (`Read Edit Write Grep Glob`); shell
  access is asked for.
- Every decision is appended to `<data_dir>/audit.jsonl`. If the record cannot
  be written, the action is denied.
- Secrets stay with their tools (Claude Code keeps its own login); xDev never
  reads, logs or passes tokens in prompts.
- Content from repos, docs and the web is data for the agent, never a source
  of permissions.

## Consequences

- The worktree keeps changes off the person's branch, but is not a sandbox:
  [Unverified] the agent process can still reach anything the user can. An
  OS-level sandbox is a later ADR, and third-party native tools wait for it.
- Organisation policy (later) layers on top of the person's: it can tighten,
  not loosen.
