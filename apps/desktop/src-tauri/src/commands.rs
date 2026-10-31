//! Thin Tauri wrappers over `session`. Commands run with `async` so indexing
//! a large vault never blocks the main (UI) thread.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, State};
use xdev_core::{Change, Commit, CoreError, DocEntry, SearchHit};

use crate::session::Shared;
use crate::settings;

pub const CHANGED_EVENT: &str = "vault://changed";

/// The UI translates `code`; `detail` is only for logs and bug reports.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct CmdError {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CmdError {
    pub fn no_vault() -> CmdError {
        CmdError {
            code: "no_vault",
            detail: None,
        }
    }
}

impl From<CoreError> for CmdError {
    fn from(e: CoreError) -> CmdError {
        CmdError {
            code: e.code(),
            detail: Some(e.to_string()),
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct Changed {
    paths: Vec<String>,
}

pub struct AppState {
    pub session: Shared,
    pub data_dir: Option<PathBuf>,
}

#[tauri::command(async)]
pub fn open_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<DocEntry>, CmdError> {
    let data_dir = state.data_dir.as_deref().ok_or(CmdError {
        code: "io",
        detail: Some("no data dir".into()),
    })?;
    let emitter = app.clone();
    let entries = state
        .session
        .open(data_dir, Path::new(&path), move |paths| {
            // Fails only once the app is shutting down; nobody is listening.
            let _ = emitter.emit(CHANGED_EVENT, Changed { paths });
        })?;

    // Losing this only costs the user one folder pick on the next launch,
    // so it must not fail an open that worked.
    if let Some(file) = settings_path(&app) {
        let mut saved = settings::load(&file);
        saved.last_vault = Some(path);
        let _ = settings::save(&file, &saved);
    }
    Ok(entries)
}

#[tauri::command(async)]
pub fn last_vault(app: AppHandle) -> Option<String> {
    settings::load(&settings_path(&app)?).last_vault
}

#[tauri::command(async)]
pub fn list_docs(state: State<'_, AppState>) -> Result<Vec<DocEntry>, CmdError> {
    state.session.with(|s| s.list())
}

#[tauri::command(async)]
pub fn read_doc(state: State<'_, AppState>, path: String) -> Result<String, CmdError> {
    state.session.with(|s| s.read(&path))
}

#[tauri::command(async)]
pub fn write_doc(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), CmdError> {
    state.session.with(|s| s.write(&path, &content))
}

#[tauri::command(async)]
pub fn search(
    state: State<'_, AppState>,
    query: String,
    limit: usize,
) -> Result<Vec<SearchHit>, CmdError> {
    state.session.with(|s| s.search(&query, limit))
}

#[derive(serde::Serialize)]
pub struct VcsState {
    status: &'static str,
}

#[tauri::command(async)]
pub fn vcs_state(state: State<'_, AppState>) -> Result<VcsState, CmdError> {
    Ok(VcsState {
        status: state.session.vcs_state()?,
    })
}

#[tauri::command(async)]
pub fn init_repo(state: State<'_, AppState>) -> Result<(), CmdError> {
    state.session.init_repo()
}

#[tauri::command(async)]
pub fn list_changes(state: State<'_, AppState>) -> Result<Vec<Change>, CmdError> {
    let r = state.session.review()?;
    Ok(xdev_core::list_changes(&r.vault, &r.repo, &r.written)?)
}

#[tauri::command(async)]
pub fn read_base(state: State<'_, AppState>, path: String) -> Result<Option<String>, CmdError> {
    let r = state.session.review()?;
    Ok(xdev_core::read_base(&r.repo, &path)?)
}

#[tauri::command(async)]
pub fn approve(
    state: State<'_, AppState>,
    paths: Vec<String>,
    message: String,
) -> Result<Option<String>, CmdError> {
    let r = state.session.review()?;
    let id = xdev_core::approve(&r.vault, &r.repo, &r.written, &paths, &message)?;
    state.session.forget(&r, &paths);
    Ok(id)
}

#[tauri::command(async)]
pub fn reject(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), CmdError> {
    let r = state.session.review()?;
    xdev_core::reject(&r.vault, &r.repo, &r.written, &paths)?;
    state.session.forget(&r, &paths);
    Ok(())
}

#[tauri::command(async)]
pub fn history(
    state: State<'_, AppState>,
    path: String,
    limit: usize,
) -> Result<Vec<Commit>, CmdError> {
    let r = state.session.review()?;
    Ok(xdev_core::history(&r.repo, &path, limit)?)
}

#[tauri::command(async)]
pub fn read_version(
    state: State<'_, AppState>,
    path: String,
    id: String,
) -> Result<Option<String>, CmdError> {
    let r = state.session.review()?;
    Ok(xdev_core::read_version(&r.repo, &path, &id)?)
}

#[tauri::command(async)]
pub fn restore_version(
    state: State<'_, AppState>,
    path: String,
    id: String,
) -> Result<(), CmdError> {
    state.session.restore_version(&path, &id)
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join(settings::FILE_NAME))
}

#[cfg(test)]
mod tests {
    use std::io;

    use xdev_core::{Store, StoreError, VaultError};

    use super::*;

    fn code_of(e: impl Into<CoreError>) -> &'static str {
        CmdError::from(e.into()).code
    }

    #[test]
    fn cmd_error_maps_codes() {
        let x = || "x.md".to_owned();
        assert_eq!(code_of(VaultError::NotFound(x())), "not_found");
        assert_eq!(code_of(VaultError::OutsideVault(x())), "outside_vault");
        assert_eq!(code_of(VaultError::NotUtf8(x())), "not_utf8");
        assert_eq!(code_of(VaultError::TooLarge(x())), "too_large");
        assert_eq!(code_of(VaultError::Io(io::Error::other("x"))), "io");
        assert_eq!(code_of(StoreError::Io(io::Error::other("x"))), "io");

        // A real SQLite failure, without depending on rusqlite here.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("index.db");
        std::fs::write(&file, vec![0xAB; 4096]).unwrap();
        let err = Store::open(&file)
            .err()
            .expect("garbage file opened as a db");
        assert!(matches!(err, StoreError::Sqlite(_)), "{err:?}");
        assert_eq!(code_of(err), "io");

        assert_eq!(CmdError::no_vault().code, "no_vault");
    }

    #[test]
    fn cmd_error_serializes_like_the_ui_expects() {
        let json = serde_json::to_value(CmdError::from(CoreError::from(VaultError::NotFound(
            "x.md".into(),
        ))))
        .unwrap();
        assert_eq!(json["code"], "not_found");
        assert!(json["detail"].as_str().unwrap().contains("x.md"));

        let json = serde_json::to_value(CmdError::no_vault()).unwrap();
        assert_eq!(json, serde_json::json!({ "code": "no_vault" }));
    }
}
