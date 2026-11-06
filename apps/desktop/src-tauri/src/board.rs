//! The task board of a repo: Markdown files in `.xdev/tasks`, read and
//! written by `xdev-board`. These commands only check the repo, map errors
//! and keep each task's link to the tab working on it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;
use xdev_board::{
    Board, BoardError, BoardList, BoardTask, TaskDraft, TaskFull, TaskPatch, TaskStatus, sync,
};
use xdev_workspace::{DetailsPatch, WorkStatus, path_key};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::workspace::{WorkspaceLock, known_checkout, update};

const LINKS_FILE: &str = "board-links.json";
static LINKS_LOCK: Mutex<()> = Mutex::new(());

/// The tab working on a task. Tab ids belong to one machine, so this lives
/// in the app data and never in the repo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TaskLink {
    pub id: String,
    pub worktree: PathBuf,
    pub tab_id: String,
    pub tab_title: String,
}

impl From<BoardError> for CmdError {
    fn from(e: BoardError) -> CmdError {
        match e {
            BoardError::NotFound => CmdError {
                code: "not_found",
                detail: Some(e.to_string()),
            },
            BoardError::BadId => CmdError {
                code: "board_bad_id",
                detail: None,
            },
            // The current task, as JSON, so the editor can show what is there.
            BoardError::Conflict { current } => CmdError {
                code: "board_conflict",
                detail: serde_json::to_string(&current).ok(),
            },
            BoardError::TooLarge => CmdError {
                code: "board_too_large",
                detail: None,
            },
            BoardError::Parse(reason) => CmdError {
                code: "io",
                detail: Some(reason),
            },
            BoardError::Io(reason) => CmdError {
                code: "io",
                detail: Some(reason),
            },
        }
    }
}

/// Milliseconds so two saves in one second still differ.
fn now() -> String {
    let t = time::OffsetDateTime::now_utc();
    let ms = u32::from(t.millisecond());
    t.replace_nanosecond(ms * 1_000_000)
        .unwrap_or(t)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn board(data: &Path, repo: &Path) -> Result<Board, CmdError> {
    known_checkout(data, repo)?;
    Ok(Board::open(repo))
}

type Links = BTreeMap<String, BTreeMap<String, TaskLink>>;

fn load_links(data: &Path) -> Links {
    std::fs::read(data.join(LINKS_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_links(data: &Path, links: &Links) -> Result<(), CmdError> {
    let bytes = serde_json::to_vec_pretty(links).map_err(|e| CmdError {
        code: "io",
        detail: Some(e.to_string()),
    })?;
    crate::atomic::write_atomic(&data.join(LINKS_FILE), &bytes).map_err(|e| CmdError {
        code: "io",
        detail: Some(e.to_string()),
    })
}

fn guard() -> std::sync::MutexGuard<'static, ()> {
    LINKS_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// The links of `repo`; those for tasks no longer in the repo are dropped
/// from the file.
fn links_of(data: &Path, repo: &Path, ids: &[String]) -> Result<Vec<TaskLink>, CmdError> {
    let _guard = guard();
    let key = path_key(repo);
    let mut all = load_links(data);
    let Some(mine) = all.get_mut(&key) else {
        return Ok(Vec::new());
    };
    let before = mine.len();
    mine.retain(|id, _| ids.contains(id));
    let out: Vec<TaskLink> = mine.values().cloned().collect();
    if mine.len() != before {
        if mine.is_empty() {
            all.remove(&key);
        }
        save_links(data, &all)?;
    }
    Ok(out)
}

fn set_link(data: &Path, repo: &Path, id: &str, link: Option<TaskLink>) -> Result<(), CmdError> {
    if !xdev_board::valid_id(id) {
        return Err(BoardError::BadId.into());
    }
    let _guard = guard();
    let key = path_key(repo);
    let mut all = load_links(data);
    match link {
        Some(mut link) => {
            link.id = id.to_owned();
            all.entry(key).or_default().insert(id.to_owned(), link);
        }
        None => {
            if let Some(mine) = all.get_mut(&key) {
                mine.remove(id);
                if mine.is_empty() {
                    all.remove(&key);
                }
            }
        }
    }
    save_links(data, &all)
}

/// Gives the worktree of `repo` on `branch` the status the task now has.
/// The file is the truth, so a worktree that cannot be found or saved is not
/// an error.
fn sync_worktree(data: &Path, lock: &WorkspaceLock, repo: &Path, branch: &str, status: TaskStatus) {
    let work: Option<WorkStatus> = match sync::status_to_work(status) {
        "none" => None,
        name => serde_json::from_value(serde_json::Value::String(name.to_owned())).ok(),
    };
    let key = path_key(repo);
    let _ = update(data, lock, |reg| {
        let views = xdev_workspace::list(reg)?;
        let found = views
            .into_iter()
            .find(|v| path_key(Path::new(&v.path)) == key)
            .and_then(|v| {
                v.worktrees
                    .into_iter()
                    .find(|w| !w.primary && w.branch.as_deref() == Some(branch))
            });
        if let Some(w) = found {
            xdev_workspace::set_details(
                reg,
                Path::new(&w.path),
                DetailsPatch {
                    status: Some(work),
                    ..DetailsPatch::default()
                },
            )?;
        }
        Ok(())
    });
}

#[tauri::command(async)]
pub fn board_list(state: State<'_, AppState>, repo: PathBuf) -> Result<BoardList, CmdError> {
    Ok(board(data_dir(&state)?, &repo)?.list())
}

#[tauri::command(async)]
pub fn board_get(
    state: State<'_, AppState>,
    repo: PathBuf,
    id: String,
) -> Result<TaskFull, CmdError> {
    Ok(board(data_dir(&state)?, &repo)?.get(&id)?)
}

#[tauri::command(async)]
pub fn board_create(
    state: State<'_, AppState>,
    repo: PathBuf,
    draft: TaskDraft,
) -> Result<BoardTask, CmdError> {
    Ok(board(data_dir(&state)?, &repo)?.create(&draft, &now())?)
}

#[tauri::command(async)]
pub fn board_update(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    repo: PathBuf,
    id: String,
    patch: TaskPatch,
    expected_updated: Option<String>,
) -> Result<BoardTask, CmdError> {
    let data = data_dir(&state)?;
    let task = board(data, &repo)?.update(&id, &patch, expected_updated.as_deref(), &now())?;
    if let (Some(status), Some(branch)) = (patch.status, task.branch.as_deref()) {
        sync_worktree(data, &lock, &repo, branch, status);
    }
    Ok(task)
}

#[tauri::command(async)]
pub fn board_delete(state: State<'_, AppState>, repo: PathBuf, id: String) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    board(data, &repo)?.delete(&id)?;
    set_link(data, &repo, &id, None)
}

#[tauri::command(async)]
pub fn board_create_many(
    state: State<'_, AppState>,
    repo: PathBuf,
    drafts: Vec<TaskDraft>,
) -> Result<Vec<BoardTask>, CmdError> {
    Ok(board(data_dir(&state)?, &repo)?.create_many(&drafts, &now())?)
}

#[tauri::command(async)]
pub fn board_links(state: State<'_, AppState>, repo: PathBuf) -> Result<Vec<TaskLink>, CmdError> {
    let data = data_dir(&state)?;
    let ids: Vec<String> = board(data, &repo)?
        .list()
        .tasks
        .into_iter()
        .map(|t| t.id)
        .collect();
    links_of(data, &repo, &ids)
}

#[tauri::command(async)]
pub fn board_link_set(
    state: State<'_, AppState>,
    repo: PathBuf,
    id: String,
    link: Option<TaskLink>,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    known_checkout(data, &repo)?;
    set_link(data, &repo, &id, link)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(id: &str, tab: &str) -> TaskLink {
        TaskLink {
            id: id.into(),
            worktree: "/w/oak".into(),
            tab_id: tab.into(),
            tab_title: "claude".into(),
        }
    }

    #[test]
    fn links_round_trip_and_drop_gone_tasks() {
        let data = tempfile::tempdir().unwrap();
        let repo = Path::new("/r/app");
        set_link(data.path(), repo, "taaaaaa", Some(link("x", "1"))).unwrap();
        set_link(data.path(), repo, "tbbbbbb", Some(link("x", "2"))).unwrap();
        set_link(
            data.path(),
            Path::new("/r/other"),
            "taaaaaa",
            Some(link("x", "3")),
        )
        .unwrap();
        let ids = vec!["taaaaaa".to_owned(), "tbbbbbb".to_owned()];
        let got = links_of(data.path(), repo, &ids).unwrap();
        assert_eq!(
            got,
            vec![link("taaaaaa", "1"), link("tbbbbbb", "2")],
            "the id comes from the call"
        );
        // tbbbbbb is gone from the repo: its link is dropped, in the file too.
        let got = links_of(data.path(), repo, &["taaaaaa".to_owned()]).unwrap();
        assert_eq!(got, vec![link("taaaaaa", "1")]);
        let all = load_links(data.path());
        assert_eq!(all[&path_key(repo)].len(), 1);
        assert_eq!(all[&path_key(Path::new("/r/other"))].len(), 1);
        // A set to None removes it.
        set_link(data.path(), repo, "taaaaaa", None).unwrap();
        assert!(links_of(data.path(), repo, &ids).unwrap().is_empty());
        assert!(set_link(data.path(), repo, "../x", None).is_err_and(|e| e.code == "board_bad_id"));
    }

    #[test]
    fn errors_map_to_codes() {
        let task = BoardTask {
            id: "taaaaaa".into(),
            title: "A".into(),
            status: TaskStatus::Todo,
            priority: xdev_board::Priority::P2,
            assignee: None,
            labels: vec![],
            created: "c".into(),
            updated: "u".into(),
            branch: None,
            file: ".xdev/tasks/taaaaaa.md".into(),
            body_preview: String::new(),
        };
        let e: CmdError = BoardError::Conflict {
            current: Box::new(task.clone()),
        }
        .into();
        assert_eq!(e.code, "board_conflict");
        let back: BoardTask = serde_json::from_str(&e.detail.unwrap()).unwrap();
        assert_eq!(back, task);
        assert_eq!(CmdError::from(BoardError::TooLarge).code, "board_too_large");
        assert_eq!(CmdError::from(BoardError::NotFound).code, "not_found");
    }

    #[test]
    fn the_stamp_is_rfc3339_and_keeps_milliseconds() {
        let a = now();
        assert!(a.ends_with('Z') && a.contains('T'), "{a}");
    }
}
