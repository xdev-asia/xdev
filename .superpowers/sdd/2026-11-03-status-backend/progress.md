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
