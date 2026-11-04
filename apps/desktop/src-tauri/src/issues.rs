//! GitHub issues of a registered repo, read through `gh` in its main checkout.

use tauri::State;
use xdev_git::{Issue, IssueDetail, IssueQuery};

use crate::commands::{AppState, CmdError};

#[tauri::command(async)]
pub fn issues_list(
    _state: State<'_, AppState>,
    _repo_id: String,
    _query: IssueQuery,
) -> Result<Vec<Issue>, CmdError> {
    todo!("B4")
}

#[tauri::command(async)]
pub fn issue_view(
    _state: State<'_, AppState>,
    _repo_id: String,
    _number: u64,
) -> Result<IssueDetail, CmdError> {
    todo!("B4")
}

/// Parses `text` and reads the issue; an issue URL of another repo is
/// refused with `issue_other_repo`.
#[tauri::command(async)]
pub fn issue_resolve(
    _state: State<'_, AppState>,
    _repo_id: String,
    _text: String,
) -> Result<Option<Issue>, CmdError> {
    todo!("B4")
}
