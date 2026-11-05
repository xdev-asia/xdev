//! The scan behind "Scan for repositories" in the add project dialog.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use tauri::State;
use xdev_workspace::{Registry, path_key};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};

/// One repo the scan met.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct NestedRepo {
    pub path: String,
    pub name: String,
    /// Already in the sidebar's repo list.
    pub registered: bool,
}

/// What `scan_nested_repos` returns; `cancelled` when `cancel_nested_scan` cut it short.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct NestedScanResult {
    pub repos: Vec<NestedRepo>,
    pub cancelled: bool,
}

/// The cancel flag of the scan running now; a new scan stops the one before it.
#[derive(Default)]
pub struct NestedScanState(Mutex<Option<Arc<AtomicBool>>>);

impl NestedScanState {
    fn begin(&self) -> Arc<AtomicBool> {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(old) = slot.as_ref() {
            old.store(true, Ordering::Relaxed);
        }
        let flag = Arc::new(AtomicBool::new(false));
        *slot = Some(flag.clone());
        flag
    }

    fn cancel(&self) {
        let slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(flag) = slot.as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

fn describe(found: Vec<PathBuf>, reg: &Registry) -> Vec<NestedRepo> {
    let known: Vec<String> = reg.repos.iter().map(|r| path_key(&r.path)).collect();
    found
        .into_iter()
        .map(|path| NestedRepo {
            name: path.file_name().map_or_else(
                || path.to_string_lossy().into_owned(),
                |n| n.to_string_lossy().into_owned(),
            ),
            registered: known.contains(&path_key(&path)),
            path: path.to_string_lossy().into_owned(),
        })
        .collect()
}

/// Looks for repos under `root`, a few folders deep. Read-only: nothing is added.
#[tauri::command(async)]
pub fn scan_nested_repos(
    state: State<'_, AppState>,
    scan: State<'_, NestedScanState>,
    root: PathBuf,
) -> Result<NestedScanResult, CmdError> {
    let reg = Registry::load(data_dir(&state)?)?;
    let flag = scan.begin();
    let found = xdev_workspace::scan_nested_repos(&root, &flag);
    Ok(NestedScanResult {
        repos: describe(found.repos, &reg),
        cancelled: found.cancelled,
    })
}

/// Stops the scan running now, if any; it returns what it has found.
#[tauri::command]
pub fn cancel_nested_scan(scan: State<'_, NestedScanState>) {
    scan.cancel();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_the_repos_the_registry_has_and_names_each_by_folder() {
        let dir = tempfile::tempdir().unwrap();
        let mut reg = Registry::default();
        reg.repos.push(
            serde_json::from_value(serde_json::json!({
                "id": "r", "short_name": "a", "path": dir.path().join("a"),
                "base_ref": "main", "worktree_root": dir.path().join("wt")
            }))
            .unwrap(),
        );
        let out = describe(vec![dir.path().join("a"), dir.path().join("b")], &reg);
        assert_eq!(out[0].name, "a");
        assert!(out[0].registered);
        assert!(!out[1].registered);
    }

    #[test]
    fn a_new_scan_cancels_the_one_before() {
        let state = NestedScanState::default();
        let first = state.begin();
        let second = state.begin();
        assert!(first.load(Ordering::Relaxed));
        assert!(!second.load(Ordering::Relaxed));
        state.cancel();
        assert!(second.load(Ordering::Relaxed));
    }
}
