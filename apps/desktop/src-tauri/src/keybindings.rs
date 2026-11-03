//! `<app config dir>/keybindings.json`: the person's shortcut overrides.
//! Rust only moves the text: it reads it, writes it atomically and says when
//! it changed. The UI parses it (`keys/keybindingsFile.ts`), so the page,
//! the keymap and the diagnostics share one parser.

use tauri::AppHandle;

use crate::commands::CmdError;

#[allow(dead_code)] // The commands below are stubs until the file lane lands.
pub const FILE_NAME: &str = "keybindings.json";
/// Emitted after our own write and when the file changes on disk, with a
/// `KeybindingsChanged` payload.
#[allow(dead_code)]
pub const CHANGED_EVENT: &str = "keybindings://changed";

/// What `keybindings_read` returns. `text` is `None` when there is no file.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsText {
    pub text: Option<String>,
    pub path: String,
}

/// The payload of `CHANGED_EVENT`: the file as it is now.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsChanged {
    pub text: Option<String>,
}

fn not_yet() -> CmdError {
    CmdError {
        code: "io",
        detail: Some("keybindings: not implemented yet".into()),
    }
}

/// The file's text, `None` when it is missing, and where it lives.
#[tauri::command(async)]
pub fn keybindings_read(_app: AppHandle) -> Result<KeybindingsText, CmdError> {
    Err(not_yet())
}

/// Replaces the whole file through a temp file; rejects with `bad_arg` past
/// 1 MiB. Emits `CHANGED_EVENT`.
#[tauri::command(async)]
pub fn keybindings_write(_app: AppHandle, _text: String) -> Result<(), CmdError> {
    Err(not_yet())
}

/// Opens the config folder; writes an empty version-1 file first when there
/// is none.
#[tauri::command]
pub fn keybindings_reveal(_app: AppHandle) -> Result<(), CmdError> {
    Err(not_yet())
}
