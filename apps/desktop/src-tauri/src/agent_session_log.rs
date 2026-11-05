//! One session's log file: its latest turns, its path, opening, revealing and
//! deleting it. A log is only touched when it lies inside the session store
//! of an agent (`projects` of a Claude home, `sessions` of a Codex home).

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::State;
use xdev_kit::{Agent, Home, SessionIndex, TextRole, claude_window, context_usage, tail_turns};

use crate::agent_sessions::{index_copy, refresh_all};
use crate::commands::{AppState, CmdError};
use crate::kit::Ctx;

/// Turns the details pane shows.
pub const TAIL_TURNS: usize = 6;
/// The most characters of one turn the details pane gets.
pub const TURN_CHARS: usize = 1_200;
/// The most turns and characters per turn one tail call gives.
pub const TURNS_MAX: u32 = 200;
pub const CHARS_MAX: u32 = 8_000;
/// The most skipped paths listed.
pub const SKIPPED_LISTED: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SessionTurn {
    /// `user` or `assistant`.
    pub role: String,
    pub text: String,
    /// Unix ms; 0 when the line has no time.
    pub at: i64,
}

/// Logs the last scan did not read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SkippedLogs {
    pub count: u32,
    /// At most 20.
    pub paths: Vec<String>,
}

fn err(code: &'static str, detail: &str) -> CmdError {
    CmdError {
        code,
        detail: Some(detail.to_owned()),
    }
}

fn io_err(e: &std::io::Error) -> CmdError {
    err("io", &e.to_string())
}

/// The folder a home keeps its session logs in.
fn store_of(home: &Home) -> PathBuf {
    match home.agent {
        Agent::Claude => home.path.join("projects"),
        Agent::Codex => home.path.join("sessions"),
    }
}

/// True when `file` is a plain `.jsonl` log inside one of `stores`: no `..`
/// in the path, not a link itself, and its real location (links in the
/// folders above it followed) under the real location of a store.
pub(crate) fn log_in_store(file: &Path, stores: &[PathBuf]) -> bool {
    if file.components().any(|c| c == Component::ParentDir) {
        return false;
    }
    if file
        .extension()
        .is_none_or(|e| !e.eq_ignore_ascii_case("jsonl"))
    {
        return false;
    }
    let Ok(meta) = std::fs::symlink_metadata(file) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    let Ok(real) = std::fs::canonicalize(file) else {
        return false;
    };
    stores
        .iter()
        .filter_map(|s| std::fs::canonicalize(s).ok())
        .any(|store| real != store && real.starts_with(&store))
}

/// The log of session `key`, checked against the stores of the homes of its agent.
pub(crate) fn session_log(
    index: &SessionIndex,
    homes: &[Home],
    key: &str,
) -> Result<(Home, PathBuf), CmdError> {
    let file = index
        .file_of(key)
        .ok_or_else(|| err("not_found", "session"))?;
    let session = index
        .sessions
        .get(key)
        .ok_or_else(|| err("not_found", "session"))?;
    let home = homes
        .iter()
        .find(|h| h.id == session.home_id)
        .ok_or_else(|| err("not_found", "home"))?;
    let stores: Vec<PathBuf> = homes
        .iter()
        .filter(|h| h.agent == home.agent)
        .map(store_of)
        .collect();
    let file = PathBuf::from(file);
    if !log_in_store(&file, &stores) {
        return Err(err("bad_path", "log outside the session store"));
    }
    Ok((home.clone(), file))
}

fn turns_of(home: &Home, file: &Path, turns: usize, chars: usize) -> Vec<SessionTurn> {
    tail_turns(home, file, turns, chars)
        .into_iter()
        .map(|t| SessionTurn {
            role: match t.role {
                TextRole::User => "user",
                TextRole::Assistant => "assistant",
            }
            .to_owned(),
            text: t.text,
            at: t.at,
        })
        .collect()
}

pub(crate) fn skipped_of(index: &SessionIndex) -> SkippedLogs {
    SkippedLogs {
        count: u32::try_from(index.skipped.len()).unwrap_or(u32::MAX),
        paths: index.skipped.iter().take(SKIPPED_LISTED).cloned().collect(),
    }
}

/// Removes the log of `key` and returns its path.
pub(crate) fn remove_log(
    index: &SessionIndex,
    homes: &[Home],
    key: &str,
) -> Result<PathBuf, CmdError> {
    let (_, file) = session_log(index, homes, key)?;
    std::fs::remove_file(&file).map_err(|e| io_err(&e))?;
    Ok(file)
}

/// The last turns of a session, oldest first. `turns` (1-200, 6 when absent)
/// and `chars` per turn (1-8000, 1200 when absent) are held to their range.
#[tauri::command(async)]
pub fn agent_session_tail(
    state: State<'_, AppState>,
    key: String,
    turns: Option<u32>,
    chars: Option<u32>,
) -> Result<Vec<SessionTurn>, CmdError> {
    let ctx = Ctx::of(&state)?;
    let (home, file) = session_log(&index_copy(&ctx.data), &ctx.homes(), &key)?;
    let (turns, chars) = tail_bounds(turns, chars);
    Ok(turns_of(&home, &file, turns, chars))
}

/// `(turns, chars)` with the defaults filled and the range kept.
fn tail_bounds(turns: Option<u32>, chars: Option<u32>) -> (usize, usize) {
    (
        turns.unwrap_or(TAIL_TURNS as u32).clamp(1, TURNS_MAX) as usize,
        chars.unwrap_or(TURN_CHARS as u32).clamp(1, CHARS_MAX) as usize,
    )
}

/// How full the context of a session is: tokens used out of the model's window.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub tokens: f64,
    pub window: f64,
    pub model: Option<String>,
}

/// The context usage of one agent session, from the end of its log; `None`
/// when the session or its usage is unknown (shown as nothing, not as zero).
/// `session` is the CLI's session id or the full `<home id>:<id>` key.
#[tauri::command(async)]
pub fn agent_context_usage(
    state: State<'_, AppState>,
    session: String,
) -> Result<Option<ContextUsage>, CmdError> {
    let ctx = Ctx::of(&state)?;
    let index = index_copy(&ctx.data);
    let Some(key) = index
        .sessions
        .values()
        .find(|s| s.key == session || s.id == session)
        .map(|s| s.key.clone())
    else {
        return Ok(None);
    };
    let (home, file) = session_log(&index, &ctx.homes(), &key)?;
    Ok(usage_of(&home, &file))
}

fn usage_of(home: &Home, file: &Path) -> Option<ContextUsage> {
    let found = context_usage(home, file)?;
    let window = found.window.unwrap_or_else(|| match home.agent {
        Agent::Claude => claude_window(found.model.as_deref(), found.tokens),
        // A Codex log without a window: unknown, so the chip is hidden.
        Agent::Codex => 0,
    });
    (window > 0).then_some(ContextUsage {
        tokens: found.tokens as f64,
        window: window as f64,
        model: found.model,
    })
}

/// The path of a session's log.
#[tauri::command(async)]
pub fn agent_session_log_path(state: State<'_, AppState>, key: String) -> Result<String, CmdError> {
    let ctx = Ctx::of(&state)?;
    let (_, file) = session_log(&index_copy(&ctx.data), &ctx.homes(), &key)?;
    Ok(file.to_string_lossy().into_owned())
}

/// Opens a session's log with the OS.
#[tauri::command(async)]
pub fn agent_session_open_log(state: State<'_, AppState>, key: String) -> Result<(), CmdError> {
    let ctx = Ctx::of(&state)?;
    let (_, file) = session_log(&index_copy(&ctx.data), &ctx.homes(), &key)?;
    crate::reveal::reveal(&file, false).map_err(|e| io_err(&e))
}

/// Shows a session's log in the file manager.
#[tauri::command(async)]
pub fn agent_session_reveal_log(state: State<'_, AppState>, key: String) -> Result<(), CmdError> {
    let ctx = Ctx::of(&state)?;
    let (_, file) = session_log(&index_copy(&ctx.data), &ctx.homes(), &key)?;
    crate::reveal::reveal(&file, true).map_err(|e| io_err(&e))
}

/// Deletes a session's log file, then reads the logs again.
#[tauri::command(async)]
pub fn agent_session_delete(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<(), CmdError> {
    let ctx = Ctx::of(&state)?;
    remove_log(&index_copy(&ctx.data), &ctx.homes(), &key)?;
    refresh_all(&app, &ctx)
}

/// The logs the last scan could not read.
#[tauri::command(async)]
pub fn agent_sessions_skipped(state: State<'_, AppState>) -> Result<SkippedLogs, CmdError> {
    let ctx = Ctx::of(&state)?;
    Ok(skipped_of(&index_copy(&ctx.data)))
}

#[cfg(test)]
#[path = "agent_session_log_tests.rs"]
mod tests;
