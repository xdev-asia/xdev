//! Settings, Repos: how much disk the worktrees use, and clearing their build folders.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use tauri::State;
use xdev_workspace::{Registry, WorktreeUsage, disk_usage, remove_heavy};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};

/// The flag of the scan running now; a new scan stops the one before it.
#[derive(Default)]
pub struct DiskScan(Mutex<Option<Arc<AtomicBool>>>);

impl DiskScan {
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

/// Every checkout the registry knows: each repo's own folder and its worktrees.
fn known_folders(data: &Path) -> Result<Vec<PathBuf>, CmdError> {
    let reg = Registry::load(data)?;
    let mut folders: Vec<PathBuf> = reg.repos.iter().map(|r| r.path.clone()).collect();
    for m in &reg.worktrees {
        if !folders.contains(&m.path) {
            folders.push(m.path.clone());
        }
    }
    Ok(folders)
}

/// Sizes the known worktrees, the biggest first. Fails with `cancelled` after
/// `disk_usage_cancel` or a newer scan.
#[tauri::command(async)]
pub fn disk_usage_scan(
    state: State<'_, AppState>,
    scan: State<'_, DiskScan>,
) -> Result<Vec<WorktreeUsage>, CmdError> {
    let folders = known_folders(data_dir(&state)?)?;
    let flag = scan.begin();
    Ok(disk_usage(&folders, &flag)?)
}

/// Stops the scan that is running; nothing when none is.
#[tauri::command]
pub fn disk_usage_cancel(scan: State<'_, DiskScan>) -> Result<(), CmdError> {
    scan.cancel();
    Ok(())
}

/// Removes the listed heavy folders, and only those. Returns the bytes freed.
#[tauri::command(async)]
pub fn disk_usage_clean(
    state: State<'_, AppState>,
    folders: Vec<PathBuf>,
) -> Result<u64, CmdError> {
    let known = known_folders(data_dir(&state)?)?;
    Ok(remove_heavy(&known, &folders)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_scan_stops_the_one_before_and_cancel_stops_the_current() {
        let scan = DiskScan::default();
        let first = scan.begin();
        let second = scan.begin();
        assert!(first.load(Ordering::Relaxed));
        assert!(!second.load(Ordering::Relaxed));
        scan.cancel();
        assert!(second.load(Ordering::Relaxed));
    }

    #[test]
    fn known_folders_lists_nothing_for_an_empty_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert!(known_folders(dir.path()).unwrap().is_empty());
    }
}
