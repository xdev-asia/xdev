//! The agent session history: the sessions of every agent home on this
//! machine, matched to the workspace's repos and worktrees, filtered and
//! sorted for the Sessions panel.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::State;
use xdev_kit::{
    Agent, AgentSession, FileMark, Home, SessionIndex, TextRole, TranscriptEvent, scan_transcripts,
};
use xdev_store::{SessionTextIndex, StoreError, StoredText, remove_session_index};
use xdev_workspace::{Registry, path_key};

use crate::commands::{AppState, CmdError};
use crate::kit::Ctx;
use crate::workspace::bad_arg;

/// The most rows one call returns.
pub const LIMIT_MAX: u32 = 500;

/// Sessions whose last activity is older are dropped on refresh. A constant
/// until the settings store carries `agent_sessions.history_days`.
pub const HISTORY_DAYS: u32 = 90;
const HISTORY_DAYS_RANGE: std::ops::RangeInclusive<u32> = 1..=3650;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// The unix ms before which a session falls out of a `days` window ending
/// at `now_ms`; `days` is held to 1-3650.
fn history_cutoff(now_ms: i64, days: u32) -> i64 {
    let days = days.clamp(*HISTORY_DAYS_RANGE.start(), *HISTORY_DAYS_RANGE.end());
    now_ms.saturating_sub(i64::from(days) * DAY_MS)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

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
    /// A snippet of the conversation text that matched, HTML-escaped with
    /// `<mark>` around the hits; `None` for a match in the metadata only.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub hit: Option<String>,
}

/// What the text index holds, for Settings → Agents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchStatus {
    pub enabled: bool,
    pub sessions: u32,
    pub messages: u32,
    /// Unix ms of the last index update.
    pub updated_at: Option<i64>,
    pub indexing: bool,
}

/// The text index file, apart from the doc store and the metadata index.
fn search_path(data: &Path) -> PathBuf {
    data.join("kit").join("session-search.sqlite")
}

fn store_err(e: StoreError) -> CmdError {
    CmdError {
        code: "io",
        detail: Some(e.to_string()),
    }
}

/// True while a refresh reads logs into the text index.
static INDEXING: AtomicBool = AtomicBool::new(false);

struct Indexing;

impl Indexing {
    fn begin() -> Indexing {
        INDEXING.store(true, Ordering::SeqCst);
        Indexing
    }
}

impl Drop for Indexing {
    fn drop(&mut self) {
        INDEXING.store(false, Ordering::SeqCst);
    }
}

/// The state of the text index. It never creates the index: with no consent
/// or no file the counts are zero.
#[tauri::command(async)]
pub fn session_search_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SessionSearchStatus, CmdError> {
    let enabled = crate::settings_store::read(&app).agents.session_search;
    let ctx = Ctx::of(&state)?;
    let path = search_path(&ctx.data);
    let (mut sessions, mut messages, mut updated_at) = (0, 0, None);
    if enabled && path.is_file() {
        let index = SessionTextIndex::open(&path).map_err(store_err)?;
        (sessions, messages) = index.counts().map_err(store_err)?;
        updated_at = index.updated_at().map_err(store_err)?;
    }
    Ok(SessionSearchStatus {
        enabled,
        sessions,
        messages,
        updated_at,
        indexing: INDEXING.load(Ordering::SeqCst),
    })
}

type Saved = Result<crate::settings::AgentsSettings, CmdError>;

/// Stores `settings` with the search off first, and only then deletes the
/// index, so a failed delete never leaves the search on over a half-removed
/// index. Returns what `store` returned.
fn clear_search(
    mut settings: crate::settings::AgentsSettings,
    store: impl FnOnce(crate::settings::AgentsSettings) -> Saved,
    path: &Path,
) -> Saved {
    settings.session_search = false;
    let saved = store(settings)?;
    remove_session_index(path).map_err(store_err)?;
    Ok(saved)
}

/// Turns the search off, then deletes the text index.
#[tauri::command(async)]
pub fn session_search_clear(app: tauri::AppHandle, state: State<'_, AppState>) -> Saved {
    let ctx = Ctx::of(&state)?;
    // A refresh holds this lock while it writes the index.
    let _guard = INDEX.lock().unwrap_or_else(PoisonError::into_inner);
    clear_search(
        crate::settings_store::read(&app).agents,
        |agents| {
            crate::settings_store::write(&app, &[crate::settings::SettingsSection::Agents], |s| {
                s.agents = agents
            })
            .map(|s| s.agents)
        },
        &search_path(&ctx.data),
    )
}

/// The index of the last data dir asked for, kept between calls so a list
/// does not read the file again; one refresh at a time.
static INDEX: Mutex<Option<(PathBuf, SessionIndex)>> = Mutex::new(None);

/// `refresh` reads the new log bytes first; it runs on a blocking thread.
#[tauri::command]
pub async fn agent_sessions(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    query: SessionQuery,
    refresh: bool,
) -> Result<Vec<SessionRow>, CmdError> {
    if query.limit > LIMIT_MAX {
        return Err(bad_arg("limit"));
    }
    let ctx = Ctx::of(&state)?;
    let cutoff = refresh.then(|| history_cutoff(now_ms(), HISTORY_DAYS));
    // Conversation text is read and searched only after the person agreed.
    let search = crate::settings_store::read(&app)
        .agents
        .session_search
        .then(|| search_path(&ctx.data));
    tauri::async_runtime::spawn_blocking(move || {
        sessions(&ctx.data, || ctx.homes(), &query, cutoff, search.as_deref())
    })
    .await
    .map_err(|e| CmdError {
        code: "io",
        detail: Some(e.to_string()),
    })?
}

/// Loads (or keeps) the index of `data`, and answers `query`. With
/// `refresh`, it first reads the logs of `homes`, drops the sessions last
/// active before that cutoff (unix ms) and saves the index.
fn sessions(
    data: &Path,
    homes: impl FnOnce() -> Vec<Home>,
    query: &SessionQuery,
    refresh: Option<i64>,
    search: Option<&Path>,
) -> Result<Vec<SessionRow>, CmdError> {
    let mut guard = INDEX.lock().unwrap_or_else(PoisonError::into_inner);
    if guard.as_ref().is_none_or(|(dir, _)| dir != data) {
        *guard = Some((data.to_path_buf(), SessionIndex::load(data)));
    }
    let Some((_, index)) = guard.as_mut() else {
        unreachable!("set just above");
    };
    if let Some(cutoff) = refresh {
        let homes = homes();
        index.refresh(&homes);
        index.prune(cutoff);
        index.save(data)?;
        if let Some(path) = search {
            let keep: HashSet<String> = index.list().iter().map(|s| s.key.clone()).collect();
            refresh_text(path, &homes, &keep)?;
        }
    }
    let hits = match (search, query.text.as_deref()) {
        (Some(path), Some(text)) if !text.trim().is_empty() && path.is_file() => {
            text_hits(path, text)?
        }
        _ => HashMap::new(),
    };
    let folders = Folders::of(&Registry::load(data)?);
    Ok(select(
        &index.list(),
        &folders,
        query,
        &|p| Path::new(p).is_dir(),
        &hits,
    ))
}

/// Reads what is new in the logs into the text index, then drops the texts
/// of sessions the metadata index no longer holds (`keep`). One transaction
/// per call; the caller holds the `INDEX` lock.
fn refresh_text(path: &Path, homes: &[Home], keep: &HashSet<String>) -> Result<(), CmdError> {
    let _busy = Indexing::begin();
    let mut index = SessionTextIndex::open(path).map_err(store_err)?;
    let mut marks: BTreeMap<String, FileMark> = index
        .marks()
        .map_err(store_err)?
        .into_iter()
        .filter_map(|(file, json)| Some((file, serde_json::from_str(&json).ok()?)))
        .collect();
    let before = marks.clone();
    let (mut texts, mut reset, mut gone) = (Vec::new(), Vec::new(), Vec::new());
    scan_transcripts(homes, &mut marks, &mut |event| match event {
        TranscriptEvent::Reset { file } => reset.push(file),
        TranscriptEvent::Gone { file } => gone.push(file),
        TranscriptEvent::Text(t) => texts.push(StoredText {
            file: t.file,
            session_key: t.session_key,
            role: u8::from(t.role == TextRole::Assistant),
            text: t.text,
            at: t.at,
        }),
    });
    let changed: Vec<(String, String)> = marks
        .iter()
        .filter(|(file, mark)| before.get(*file) != Some(*mark))
        .filter_map(|(file, mark)| Some((file.clone(), serde_json::to_string(mark).ok()?)))
        .collect();
    if !(texts.is_empty() && reset.is_empty() && gone.is_empty() && changed.is_empty()) {
        index
            .apply(texts, &changed, &reset, &gone)
            .map_err(store_err)?;
    }
    index.retain_sessions(keep).map_err(store_err)
}

/// The best snippet of each session whose messages hold the words of `text`.
fn text_hits(path: &Path, text: &str) -> Result<HashMap<String, String>, CmdError> {
    let index = SessionTextIndex::open(path).map_err(store_err)?;
    Ok(index
        .search(text, LIMIT_MAX as usize)
        .map_err(store_err)?
        .into_iter()
        .map(|h| (h.session_key, h.snippet))
        .collect())
}

/// The sessions that ran inside the worktree at `path`, newest first, after
/// reading the logs' new bytes. For naming a branch from the first prompt.
pub(crate) fn worktree_sessions(
    data: &Path,
    homes: impl FnOnce() -> Vec<Home>,
    path: &Path,
) -> Result<Vec<SessionRow>, CmdError> {
    let query = SessionQuery {
        text: None,
        scope: SessionScope::Worktree {
            path: path.to_string_lossy().into_owned(),
        },
        agent: None,
        home_id: None,
        sort: SessionSort::LastDesc,
        limit: 50,
    };
    sessions(
        data,
        homes,
        &query,
        Some(history_cutoff(now_ms(), HISTORY_DAYS)),
        None,
    )
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
/// folder is still on the disk. `hits` holds the snippet of each session
/// (by key) whose messages matched the text; such a session is picked even
/// when its metadata does not match.
fn select(
    all: &[&AgentSession],
    folders: &Folders,
    query: &SessionQuery,
    exists: &dyn Fn(&str) -> bool,
    hits: &HashMap<String, String>,
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
        .filter(|s| matches(s, &words) || hits.contains_key(&s.key))
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
            hit: hits.get(&s.key).cloned(),
        })
        .collect()
}

#[cfg(test)]
#[path = "agent_sessions_tests.rs"]
mod tests;
