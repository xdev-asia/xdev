//! Terminal links: resolve a printed path to a worktree file, open a file or a URL with the OS,
//! and build the hosted URL of a file line. The commands answer `io` until their tasks land.

use std::path::PathBuf;

use tauri::State;

use crate::commands::{AppState, CmdError};

fn todo() -> CmdError {
    CmdError {
        code: "io",
        detail: Some("todo".to_owned()),
    }
}

#[tauri::command(async)]
pub fn file_links_resolve(
    _state: State<'_, AppState>,
    _worktree: PathBuf,
    _paths: Vec<String>,
) -> Result<Vec<Option<String>>, CmdError> {
    Err(todo())
}

#[tauri::command(async)]
pub fn file_open_default(
    _state: State<'_, AppState>,
    _worktree: PathBuf,
    _rel: String,
) -> Result<(), CmdError> {
    Err(todo())
}

#[tauri::command(async)]
pub fn open_url(_url: String) -> Result<(), CmdError> {
    Err(todo())
}

#[tauri::command(async)]
pub fn file_remote_url(
    _state: State<'_, AppState>,
    _worktree: PathBuf,
    _rel: String,
    _line: u32,
    _end_line: Option<u32>,
) -> Result<String, CmdError> {
    Err(todo())
}
