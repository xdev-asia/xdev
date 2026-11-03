//! Open a worktree in another program: one of the person's Open In apps,
//! or the system file manager.

use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::commands::{AppState, CmdError};
use crate::settings::{OpenInSettings, SettingsSection};
use crate::settings_store;

/// Where `open_in` sends a folder.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OpenTarget {
    /// The Open In app with this id.
    App {
        id: String,
    },
    FileManager,
}

/// Settings → Open In Apps as stored; the default list when nothing is.
#[tauri::command(async)]
pub fn open_in_settings(app: AppHandle) -> OpenInSettings {
    settings_store::read(&app).open_in
}

/// Stores the Open In list and returns what was stored.
#[tauri::command(async)]
pub fn open_in_settings_put(app: AppHandle, v: OpenInSettings) -> Result<OpenInSettings, CmdError> {
    settings_store::write(&app, &[SettingsSection::OpenIn], |s| s.open_in = v).map(|s| s.open_in)
}

/// Opens `path`, a repo or worktree the workspace knows, in `target`.
#[tauri::command(async)]
pub fn open_in(
    state: State<'_, AppState>,
    path: PathBuf,
    target: OpenTarget,
) -> Result<(), CmdError> {
    let _ = (state, path, target);
    Err(CmdError {
        code: "io",
        detail: Some("open_in is not implemented yet".into()),
    })
}
