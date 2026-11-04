//! The git history panel's commands: the commit graph, one commit's files
//! and diff, and opening a commit or a file on its web host.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};
use xdev_git::{CommitFiles, LOG_LIMIT_MAX, Repo, RepoLog};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::workspace::{WorktreeFileDiff, known_checkout};

/// Opens a URL outside the app. A fake stands in for it in tests.
#[allow(dead_code)] // used by the open commands in the host URL task
pub(crate) trait UrlOpener {
    fn open(&self, url: &str) -> Result<(), CmdError>;
}

fn not_ready() -> CmdError {
    CmdError {
        code: "git",
        detail: Some("not implemented".to_owned()),
    }
}

fn log_with(data: &Path, path: &Path, limit: usize, skip: usize) -> Result<RepoLog, CmdError> {
    known_checkout(data, path)?;
    let repo = Repo::discover(path)?;
    Ok(repo.repo_log(None, limit.clamp(1, LOG_LIMIT_MAX), skip)?)
}

fn commit_files_with(data: &Path, path: &Path, id: &str) -> Result<CommitFiles, CmdError> {
    known_checkout(data, path)?;
    Ok(Repo::discover(path)?.commit_files(id)?)
}

fn commit_file_with(
    data: &Path,
    path: &Path,
    id: &str,
    file: &str,
) -> Result<WorktreeFileDiff, CmdError> {
    let _ = (data, path, id, file);
    Err(not_ready())
}

fn open_commit_with(
    opener: &dyn UrlOpener,
    data: &Path,
    path: &Path,
    id: &str,
) -> Result<(), CmdError> {
    let _ = (opener, data, path, id);
    Err(not_ready())
}

fn open_file_with(
    opener: &dyn UrlOpener,
    data: &Path,
    path: &Path,
    file: &str,
    line: Option<u32>,
    end_line: Option<u32>,
) -> Result<(), CmdError> {
    let _ = (opener, data, path, file, line, end_line);
    Err(not_ready())
}

/// The opener plugin, called from Rust only; the webview has no permission
/// to call it.
#[allow(dead_code)]
struct PluginOpener<'a>(&'a AppHandle);

impl UrlOpener for PluginOpener<'_> {
    fn open(&self, url: &str) -> Result<(), CmdError> {
        use tauri_plugin_opener::OpenerExt;
        self.0
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| CmdError {
                code: "open_failed",
                detail: Some(e.to_string()),
            })
    }
}

#[tauri::command(async)]
pub fn worktree_log(
    state: State<'_, AppState>,
    path: PathBuf,
    limit: usize,
    skip: usize,
) -> Result<RepoLog, CmdError> {
    log_with(data_dir(&state)?, &path, limit, skip)
}

#[tauri::command(async)]
pub fn worktree_commit_files(
    state: State<'_, AppState>,
    path: PathBuf,
    id: String,
) -> Result<CommitFiles, CmdError> {
    commit_files_with(data_dir(&state)?, &path, &id)
}

#[tauri::command(async)]
pub fn worktree_commit_file(
    state: State<'_, AppState>,
    path: PathBuf,
    id: String,
    file: String,
) -> Result<WorktreeFileDiff, CmdError> {
    commit_file_with(data_dir(&state)?, &path, &id, &file)
}

#[tauri::command(async)]
pub fn worktree_open_commit(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
    id: String,
) -> Result<(), CmdError> {
    open_commit_with(&PluginOpener(&app), data_dir(&state)?, &path, &id)
}

#[tauri::command(async)]
pub fn worktree_open_file_on_host(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
    file: String,
    line: Option<u32>,
    end_line: Option<u32>,
) -> Result<(), CmdError> {
    open_file_with(
        &PluginOpener(&app),
        data_dir(&state)?,
        &path,
        &file,
        line,
        end_line,
    )
}
