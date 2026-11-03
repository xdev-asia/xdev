# 0012. Machine-bound data in the local folder, records in the data folder

Status: accepted. Amended by 0013. Code: `xdev-core` (`local_dir`,
`move_indexes`), `xdev-agent` (`TaskStore::with_local`,
`SquadStore::with_local`).
Date: 2026-11-02
Note (0013): the local folder also holds terminal scrollback
(`pty/<id>.log`) and agent hook events (`hooks/<pty_id>.jsonl`). Worktrees
made from the workspace go to a per-repo folder, by default
`<repo parent>/wt/<repo>-<name>`; task worktrees stay as below.

## Context

On Windows the data folder is `%APPDATA%` (Roaming). A roaming profile syncs
it to every machine the person logs into. Vault indexes and task worktrees are
large, tied to one machine, and can be rebuilt or recreated; syncing them
costs time and space and gains nothing. This amends ADR 0003, which put
worktrees under the data folder.

## Decision

- Two folders, both resolved by `xdev-core` so the CLI and the desktop app
  agree:
  - data folder (`data_dir`): `%APPDATA%\asia.xdev.desktop` on Windows. Holds
    settings, the accounts registry, `policy.json`, `audit.jsonl`, task
    records (`tasks/`) and squads (`squads/`).
  - local folder (`local_dir`): `%LOCALAPPDATA%\asia.xdev.desktop` on Windows.
    Holds vault indexes (`vaults/<id>/index.db`) and task worktrees
    (`worktrees/<id>`).
- On macOS and Linux both resolve to the same folder, so nothing moves there.
- `XDEV_LOCAL_DIR` sets the local folder. Without it, `XDEV_DATA_DIR` sets
  both, so tests and portable setups keep everything in one folder.
- At start, the CLI and the desktop app move an old `vaults/` from the data
  folder to the local folder once, if the local one has none. If the move
  fails, the index is rebuilt from the vault.
- A task keeps the absolute worktree path it was created with. Existing
  worktrees are not moved; they stay in the data folder until the task is
  merged or discarded. Only new tasks get a worktree in the local folder.

## Consequences

- Records that matter across machines still roam; bulk that does not stays
  local.
- An index left in the data folder by a failed move is never read again and
  can be deleted by hand.
- `TaskStore::new` and `SquadStore::new` keep one folder for everything; the
  runtimes use the explicit `with_local` constructors.
