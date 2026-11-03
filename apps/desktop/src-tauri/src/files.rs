//! File tabs and the file tree's menu: thin commands over
//! `xdev_workspace::files`. Each one first checks that `worktree` is a repo
//! or worktree the registry knows.

use std::path::PathBuf;

use tauri::State;
use xdev_workspace::{Eol, FileText, WriteOutcome};

use crate::commands::{AppState, CmdError};

fn todo(what: &str) -> CmdError {
    CmdError {
        code: "io",
        detail: Some(format!("{what} is not built yet")),
    }
}

/// The file's text, or why it has none (binary, too large).
#[tauri::command(async)]
pub fn file_read(
    _state: State<'_, AppState>,
    _worktree: PathBuf,
    _rel: String,
) -> Result<FileText, CmdError> {
    Err(todo("file_read"))
}

/// Saves `text` with `eol` when the file still has the `expected` hash
/// (`None`: the file must not exist); `Conflict` otherwise.
#[tauri::command(async)]
pub fn file_write(
    _state: State<'_, AppState>,
    _worktree: PathBuf,
    _rel: String,
    _text: String,
    _eol: Eol,
    _expected: Option<String>,
) -> Result<WriteOutcome, CmdError> {
    Err(todo("file_write"))
}

#[tauri::command(async)]
pub fn file_create(
    _state: State<'_, AppState>,
    _worktree: PathBuf,
    _rel: String,
    _dir: bool,
) -> Result<(), CmdError> {
    Err(todo("file_create"))
}

#[tauri::command(async)]
pub fn file_rename(
    _state: State<'_, AppState>,
    _worktree: PathBuf,
    _from: String,
    _to: String,
) -> Result<(), CmdError> {
    Err(todo("file_rename"))
}

/// Asks the policy gate (`Delete`) first, then moves the item to the trash.
#[tauri::command(async)]
pub fn file_trash(
    _state: State<'_, AppState>,
    _worktree: PathBuf,
    _rel: String,
) -> Result<(), CmdError> {
    Err(todo("file_trash"))
}

/// Opens the OS file manager with the item selected where the OS allows it.
#[tauri::command(async)]
pub fn file_reveal(
    _state: State<'_, AppState>,
    _worktree: PathBuf,
    _rel: String,
) -> Result<(), CmdError> {
    Err(todo("file_reveal"))
}
