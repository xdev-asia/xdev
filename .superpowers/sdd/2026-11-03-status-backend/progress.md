# Plan 4 — lane status-backend

Task 1: complete (Steps 1–2 only; Steps 3–4 need the GUI)
- claude 2.1.317: R2 JSON shape works; UserPromptSubmit + Stop fired; Notification not checked (print mode).
- codex 0.165.0: notify argv as R2, JSON appended last; matches R2.
- No change to R2 constants.
- Notification click: locked tauri-plugin-notification is 2.8.0 (Cargo.toml says 2.6.0, which also has on_action);
  desktop `on_action` reports `tap` → Task 5 emits `status://notification-click`.

Task 2: complete
- local_dir override: xdev-core reads `XDEV_LOCAL_DIR` (and `XDEV_DATA_DIR`); CLI test uses both, no hidden flag.
- Deviation: `HookEvent` in xdev-agent does not derive `clap::ValueEnum` (xdev-agent has no clap dep);
  the CLI has a mirror `agent_hook::Event` (ValueEnum) mapped `From` into `HookEvent`.
- `agent-hook` is a hidden subcommand, handled in `main` before `run` (no folder side effects);
  clap parse errors on `agent-hook` (unknown event) also exit 0 with a stderr line.

Task 3: complete
- Extra spike: claude runs hook commands under bash on Windows ($BASH_VERSION set) → program is a POSIX
  double-quoted word (`"`, `\`, `$`, backtick escaped), `\` → `/` on Windows only. Codex: TOML basic string.
- `Launch` gains `cli: Option<Cli>` (plan) and also `hooks: bool` + `Launch::add_hooks(xdev)` (not in plan):
  keeps the "did it get flags" fact next to the args so `PtyInfo.hooks` reads it.
- `launch_for(data_dir, id, account, hooks: Option<&Path>)`: callers pass `hooks_now(app)`, which reads
  settings.json at `settings_path(app)` (app_config_dir, where Settings already live; not data_dir) and
  `cli_beside(current_exe)` → `hook_program(&StatusSettings, exe)` (R4). pty_spawn and pty_approve both use it,
  so the approved fingerprint matches the spawned one.
- `cli_beside` and `settings_path` made `pub(crate)`.
- StatusSettings field comments are `//` (not `///`) so the TS file matches the contract (no field docs).
- StatusSettings is camelCase on disk too (one serde shape for disk and IPC); missing fields default per field.

Task 4: complete
- `hooks.rs`: `HookReader` (per-file offset + "skipping" flag), `PtyHook`, `watch(app, dir)` → `HookWatcher`
  kept with `app.manage`. Debounce 100 ms, NonRecursive, `NoCache`, same setup as the vault watcher.
- Overlong line still being written (no newline yet, > 4096 bytes) is dropped up to its newline instead of
  growing the buffer; added test `reader_skips_a_long_line_still_being_written` (not in plan).
- Lines with `v` != 1 are skipped. Watcher failure only logs to stderr; panes still run without status.
- Added an end-to-end test `watcher_emits_appended_lines` (real notify, 10 s timeout) using `append_hook`.
- Bindings: `PtyHook` exported; HookEvent.ts and PtyHook.ts regenerate byte-identical to the contract.
