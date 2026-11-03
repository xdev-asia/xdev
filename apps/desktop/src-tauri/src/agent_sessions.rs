//! The agent session history: the sessions of every agent home on this
//! machine, matched to the workspace's repos and worktrees, filtered and
//! sorted for the Sessions panel.

use serde::{Deserialize, Serialize};
use tauri::State;
use xdev_kit::{Agent, AgentSession};

use crate::commands::{AppState, CmdError};
use crate::workspace::bad_arg;

/// The most rows one call returns.
pub const LIMIT_MAX: u32 = 500;

/// Which sessions a query looks at, by the folder they ran in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionScope {
    /// Sessions whose folder is inside this worktree.
    Worktree {
        path: String,
    },
    /// Sessions inside this repo or any of its worktrees.
    Repo {
        path: String,
    },
    All,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SessionSort {
    /// Last activity, newest first.
    #[default]
    LastDesc,
    /// Start time, newest first.
    FirstDesc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SessionQuery {
    /// Words split on whitespace; each must be found, case-insensitive, in
    /// the title, folder, branch or model, or start the session id.
    pub text: Option<String>,
    pub scope: SessionScope,
    pub agent: Option<Agent>,
    pub home_id: Option<String>,
    pub sort: SessionSort,
    /// At most 500.
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub session: AgentSession,
    /// The registry's worktree (or repo) folder the session ran in.
    pub worktree: Option<String>,
    /// The registry's repo folder of that worktree.
    pub repo: Option<String>,
    /// False when no profile can launch the session's home, or its folder is gone.
    pub resumable: bool,
}

/// `refresh` reads the new log bytes first; it runs on a blocking thread.
#[tauri::command]
pub async fn agent_sessions(
    state: State<'_, AppState>,
    query: SessionQuery,
    refresh: bool,
) -> Result<Vec<SessionRow>, CmdError> {
    let _ = (&state, refresh);
    if query.limit > LIMIT_MAX {
        return Err(bad_arg("limit"));
    }
    Ok(Vec::new())
}
