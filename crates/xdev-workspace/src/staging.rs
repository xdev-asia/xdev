//! The folder a worktree is made in before it moves to its real name, so a
//! half-made worktree never sits under the name the person will open.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use xdev_git::Repo;

use crate::Registry;
use crate::files::{OsTrash, Trash};
use crate::ops::{find_repo_entries, is_merged};

/// The folder under a repo's worktree root that holds worktrees in the making.
pub const STAGING: &str = ".xdev-preparing";

/// `<root>/.xdev-preparing/<pid>-<nonce>`.
pub fn staging_dir(root: &Path, pid: u32, nonce: u64) -> PathBuf {
    root.join(STAGING).join(format!("{pid}-{nonce:x}"))
}

/// How long a staging folder may sit before `sweep` takes it for a crash's.
const STALE_MS: i64 = 60 * 60 * 1000;

/// Whether `path` is in a staging folder.
pub(crate) fn in_staging(path: &Path) -> bool {
    path.components()
        .any(|c| matches!(c, Component::Normal(n) if n == STAGING))
}

/// Removes staging worktrees older than an hour: the folder to the OS trash,
/// then git's record, and the branch the add made when it holds nothing the
/// base does not. Returns the folders it removed.
pub fn sweep(reg: &Registry, now_ms: i64) -> Vec<PathBuf> {
    sweep_with(reg, now_ms, &OsTrash)
}

/// `sweep` with the trash given.
pub fn sweep_with(reg: &Registry, now_ms: i64, trash: &dyn Trash) -> Vec<PathBuf> {
    let mut swept = Vec::new();
    for entry in find_repo_entries(reg) {
        let dir = entry.worktree_root.join(STAGING);
        let Ok(children) = fs::read_dir(&dir) else {
            continue;
        };
        let Ok(repo) = Repo::discover(&entry.path) else {
            continue;
        };
        let listed = repo.list_worktrees().unwrap_or_default();
        for child in children.flatten() {
            let path = child.path();
            if !is_stale(&path, now_ms) {
                continue;
            }
            let branch = listed
                .iter()
                .find(|e| e.path == path)
                .and_then(|e| e.branch.clone());
            if trash.trash(&path).is_err() {
                continue;
            }
            let _ = repo.remove_fresh_worktree(&path);
            if let Some(branch) = branch
                && is_merged(&repo, &branch, &entry.base_ref).unwrap_or(false)
            {
                let _ = repo.delete_branch(&branch);
            }
            swept.push(path);
        }
        // Gone when empty; a fresh entry keeps it.
        let _ = fs::remove_dir(&dir);
    }
    swept
}

fn is_stale(path: &Path, now_ms: i64) -> bool {
    let Ok(modified) = fs::metadata(path).and_then(|m| m.modified()) else {
        return false;
    };
    let Ok(since_epoch) = modified.duration_since(UNIX_EPOCH) else {
        return false;
    };
    let modified_ms = i64::try_from(since_epoch.as_millis()).unwrap_or(i64::MAX);
    now_ms.saturating_sub(modified_ms) > STALE_MS
}
