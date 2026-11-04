//! The verbs of the app endpoint, one function each, testable without a
//! socket; and the commands through which the UI feeds them.
// The contract lands before the verbs that use it.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use tauri::State;

/// One terminal tab as the UI sees it; the UI owns the state machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TabReport {
    pub id: String,
    /// The worktree's path.
    pub worktree: String,
    pub title: Option<String>,
    pub profile: String,
    pub agent: bool,
    /// `working`, `needs-you`, `done` or `idle`.
    pub status: String,
    /// Epoch ms of the last output; 0 when there was none.
    pub last_output_ms: i64,
    pub exited: bool,
}

/// Payload of `cli://open-tab`: open `profile` (empty: the default agent)
/// in `worktree` without focusing it, then type `prompt` once it is ready.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CliOpenTab {
    pub worktree: String,
    pub profile: String,
    pub prompt: Option<String>,
}

/// Payload of `cli://ask`: a CLI write that needs the person; answered with
/// `cli_approve(request, allow)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CliAsk {
    pub request: u64,
    /// The caller's worktree path; null for a caller outside the app.
    pub caller: Option<String>,
    /// `worktree.create` or `worktree.set`.
    pub verb: String,
    /// The worktree path the write is for.
    pub target: String,
}

/// What the endpoint shares with the UI's commands.
#[derive(Default)]
pub struct CliHub {}

/// The UI's tabs, replacing the last report; `selected` is the worktree in front.
#[tauri::command]
pub fn cli_tabs_report(hub: State<'_, CliHub>, tabs: Vec<TabReport>, selected: Option<String>) {
    let _ = (hub, tabs, selected);
}

/// The person's answer to a `cli://ask`.
#[tauri::command]
pub fn cli_approve(hub: State<'_, CliHub>, request: u64, allow: bool) {
    let _ = (hub, request, allow);
}
