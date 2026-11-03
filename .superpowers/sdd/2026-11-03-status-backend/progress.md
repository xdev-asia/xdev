# Plan 4 — lane status-backend

Task 1: complete (Steps 1–2 only; Steps 3–4 need the GUI)
- claude 2.1.317: R2 JSON shape works; UserPromptSubmit + Stop fired; Notification not checked (print mode).
- codex 0.165.0: notify argv as R2, JSON appended last; matches R2.
- No change to R2 constants.
- Notification click: locked tauri-plugin-notification is 2.8.0 (Cargo.toml says 2.6.0, which also has on_action);
  desktop `on_action` reports `tap` → Task 5 emits `status://notification-click`.
