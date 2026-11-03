//! Status hooks: how an agent CLI tells xDev that a prompt was sent, that it
//! waits for the person, or that its turn ended.
//!
//! Checked on 2026-11-03, Windows 11, each CLI run once with the flags from
//! `hook_args` and the command pointed at a script that logs argv and stdin:
//!
//! - `claude` 2.1.317 (`claude -p "say ok" --settings '<json>'`): the
//!   `{"hooks":{"<Event>":[{"hooks":[{"type":"command","command":"\"<prog>\" <args>"}]}]}}`
//!   shape is accepted; a quoted program path with `/` separators runs.
//!   `UserPromptSubmit` and `Stop` fired once each, with the hook JSON on
//!   stdin and `XDEV_PTY_ID` inherited from the CLI's environment.
//!   `Notification`: not checked (print mode never asks the person).
//! - `codex` 0.165.0 (`codex exec -c 'notify=["<prog>",...,"turn-done"]'`):
//!   the program ran once at the end of the turn with
//!   `{"type":"agent-turn-complete",...}` appended as the last argv; stdin
//!   empty; `XDEV_PTY_ID` inherited.
//! - Terminal titles per state (OSC 0/2): not checked (needs the app).
//! - Notification click: not run on screen. The locked
//!   `tauri-plugin-notification` 2.8.0 reports a click on desktop through
//!   `Notification::on_action` (`action_id == "tap"`, Windows only while the
//!   toast is on screen), so the desktop emits `status://notification-click`.
