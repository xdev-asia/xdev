//! The agent session history: the sessions of every agent home on this
//! machine, matched to the workspace's repos and worktrees, filtered and
//! sorted for the Sessions panel.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::State;
use xdev_kit::{Agent, AgentSession, Home, SessionIndex};
use xdev_workspace::{Registry, path_key};

use crate::commands::{AppState, CmdError};
use crate::kit::Ctx;
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

/// The index of the last data dir asked for, kept between calls so a list
/// does not read the file again; one refresh at a time.
static INDEX: Mutex<Option<(PathBuf, SessionIndex)>> = Mutex::new(None);

/// `refresh` reads the new log bytes first; it runs on a blocking thread.
#[tauri::command]
pub async fn agent_sessions(
    state: State<'_, AppState>,
    query: SessionQuery,
    refresh: bool,
) -> Result<Vec<SessionRow>, CmdError> {
    if query.limit > LIMIT_MAX {
        return Err(bad_arg("limit"));
    }
    let ctx = Ctx::of(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        sessions(&ctx.data, || ctx.homes(), &query, refresh)
    })
    .await
    .map_err(|e| CmdError {
        code: "io",
        detail: Some(e.to_string()),
    })?
}

/// Loads (or keeps) the index of `data`, refreshes it from `homes` when
/// asked, and answers `query`.
fn sessions(
    data: &Path,
    homes: impl FnOnce() -> Vec<Home>,
    query: &SessionQuery,
    refresh: bool,
) -> Result<Vec<SessionRow>, CmdError> {
    let mut guard = INDEX.lock().unwrap_or_else(PoisonError::into_inner);
    if guard.as_ref().is_none_or(|(dir, _)| dir != data) {
        *guard = Some((data.to_path_buf(), SessionIndex::load(data)));
    }
    let Some((_, index)) = guard.as_mut() else {
        unreachable!("set just above");
    };
    if refresh {
        index.refresh(&homes());
        index.save(data)?;
    }
    let folders = Folders::of(&Registry::load(data)?);
    Ok(select(&index.list(), &folders, query, &|p| {
        Path::new(p).is_dir()
    }))
}

/// The registry folder (worktree or repo checkout) a session ran in, and its
/// repo: the longest registry path that holds `cwd`.
struct Folders {
    /// `(key, folder, repo folder)`, longest key first.
    entries: Vec<(String, String, String)>,
}

impl Folders {
    fn of(registry: &Registry) -> Folders {
        let text = |p: &Path| p.to_string_lossy().into_owned();
        let mut entries: Vec<(String, String, String)> = Vec::new();
        for repo in &registry.repos {
            entries.push((path_key(&repo.path), text(&repo.path), text(&repo.path)));
        }
        for wt in &registry.worktrees {
            if let Some(repo) = registry.repos.iter().find(|r| r.id == wt.repo_id) {
                entries.push((path_key(&wt.path), text(&wt.path), text(&repo.path)));
            }
        }
        entries.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(&b.0)));
        Folders { entries }
    }

    fn find(&self, cwd: &str) -> Option<(&str, &str)> {
        let key = path_key(Path::new(cwd));
        self.entries
            .iter()
            .find(|(k, _, _)| inside(&key, k))
            .map(|(_, folder, repo)| (folder.as_str(), repo.as_str()))
    }
}

/// `key` is `folder` or under it; both in `path_key` form.
fn inside(key: &str, folder: &str) -> bool {
    key.strip_prefix(folder)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/') || folder.ends_with('/'))
}

/// A home xDev can launch: its own homes and account homes. An env home
/// (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) has no profile that picks it.
fn launchable(home_id: &str) -> bool {
    !home_id.starts_with("env-")
}

/// Every word, lowercased, is in one of the fields or starts the id.
fn matches(session: &AgentSession, words: &[String]) -> bool {
    let fields: Vec<String> = [
        &session.title,
        &session.cwd,
        &session.branch,
        &session.model,
    ]
    .into_iter()
    .flatten()
    .map(|f| f.to_lowercase())
    .collect();
    let id = session.id.to_lowercase();
    words
        .iter()
        .all(|w| id.starts_with(w.as_str()) || fields.iter().any(|f| f.contains(w.as_str())))
}

/// Filters, sorts and cuts `all` for `query`. `exists` tells whether a
/// folder is still on the disk.
fn select(
    all: &[&AgentSession],
    folders: &Folders,
    query: &SessionQuery,
    exists: &dyn Fn(&str) -> bool,
) -> Vec<SessionRow> {
    let words: Vec<String> = query
        .text
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_lowercase)
        .collect();
    let scope_key = match &query.scope {
        SessionScope::Worktree { path } | SessionScope::Repo { path } => {
            Some(path_key(Path::new(path)))
        }
        SessionScope::All => None,
    };
    let mut picked: Vec<(&AgentSession, Option<(&str, &str)>)> = all
        .iter()
        .copied()
        .filter(|s| query.agent.is_none_or(|a| s.agent == a))
        .filter(|s| query.home_id.as_ref().is_none_or(|h| s.home_id == *h))
        .filter(|s| matches(s, &words))
        .map(|s| (s, s.cwd.as_deref().and_then(|c| folders.find(c))))
        .filter(|(_, found)| {
            let Some(want) = scope_key.as_deref() else {
                return true;
            };
            let Some((folder, repo)) = found else {
                return false;
            };
            let have = match query.scope {
                SessionScope::Worktree { .. } => folder,
                _ => repo,
            };
            path_key(Path::new(have)) == want
        })
        .collect();
    picked.sort_by(|(a, _), (b, _)| {
        let (x, y) = match query.sort {
            SessionSort::LastDesc => (a.last, b.last),
            SessionSort::FirstDesc => (a.first, b.first),
        };
        y.cmp(&x).then_with(|| a.key.cmp(&b.key))
    });
    picked.truncate(query.limit as usize);
    picked
        .into_iter()
        .map(|(s, found)| SessionRow {
            resumable: launchable(&s.home_id) && s.cwd.as_deref().is_some_and(exists),
            session: s.clone(),
            worktree: found.map(|(f, _)| f.to_string()),
            repo: found.map(|(_, r)| r.to_string()),
        })
        .collect()
}

#[cfg(test)]
#[path = "agent_sessions_tests.rs"]
mod tests;
