//! Edit an issue, comment on it, list what can be set on it and read its timeline,
//! all through `gh` in the repo's main checkout.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::GitError;
use crate::gh::{GhExec, IssueState};

/// Most events one timeline read returns.
pub const ISSUE_TIMELINE_MAX: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum IssueCloseReason {
    Completed,
    NotPlanned,
}

/// The parts of an issue to change. Only what is set is sent; an empty edit
/// runs no `gh` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", default)]
pub struct IssueEdit {
    pub title: Option<String>,
    pub body: Option<String>,
    pub state: Option<IssueState>,
    /// Used only when `state` is closed.
    pub close_reason: Option<IssueCloseReason>,
    pub add_labels: Vec<String>,
    pub remove_labels: Vec<String>,
    pub add_assignees: Vec<String>,
    pub remove_assignees: Vec<String>,
}

/// What an edit left undone. Every requested part is tried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct IssueEditReport {
    /// Parts that failed: "state", "body" or "fields".
    pub failed: Vec<String>,
    /// The first error's text.
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct IssueLabel {
    pub name: String,
    /// Hex without `#`.
    pub color: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum IssueEventKind {
    Assigned,
    Unassigned,
    Closed,
    Reopened,
    Labeled,
    Unlabeled,
    Renamed,
    CrossReferenced,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct IssueEvent {
    pub kind: IssueEventKind,
    pub actor: Option<String>,
    /// The assignee login, label name, new title, or `#n title` of the source.
    pub subject: Option<String>,
    pub created_at: String,
}

fn not_built() -> GitError {
    GitError::Gh("not implemented".into())
}

/// Changes the parts named in `edit`: state, then body, then title, labels and
/// assignees in one `gh issue edit`.
pub fn issue_edit(
    _gh: &dyn GhExec,
    _cwd: &Path,
    _number: u64,
    _edit: &IssueEdit,
) -> Result<IssueEditReport, GitError> {
    Err(not_built())
}

/// Posts a comment; the body goes on stdin as JSON.
pub fn issue_comment(
    _gh: &dyn GhExec,
    _cwd: &Path,
    _number: u64,
    _body: &str,
) -> Result<(), GitError> {
    Err(not_built())
}

/// The repo's labels.
pub fn issue_labels(_gh: &dyn GhExec, _cwd: &Path) -> Result<Vec<IssueLabel>, GitError> {
    Err(not_built())
}

/// Logins an issue of the repo can be assigned to.
pub fn issue_assignable(_gh: &dyn GhExec, _cwd: &Path) -> Result<Vec<String>, GitError> {
    Err(not_built())
}

/// The issue's events, oldest first, known kinds only.
pub fn issue_timeline(
    _gh: &dyn GhExec,
    _cwd: &Path,
    _number: u64,
) -> Result<Vec<IssueEvent>, GitError> {
    Err(not_built())
}
