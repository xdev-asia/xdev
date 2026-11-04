//! The folder a worktree is made in before it moves to its real name, so a
//! half-made worktree never sits under the name the person will open.

use std::path::{Path, PathBuf};

use crate::Registry;

/// The folder under a repo's worktree root that holds worktrees in the making.
pub const STAGING: &str = ".xdev-preparing";

/// `<root>/.xdev-preparing/<pid>-<nonce>`.
pub fn staging_dir(root: &Path, pid: u32, nonce: u64) -> PathBuf {
    root.join(STAGING).join(format!("{pid}-{nonce:x}"))
}

/// Removes staging worktrees older than an hour: git's record first, then
/// the folder to the OS trash. Returns what it removed.
pub fn sweep(_reg: &Registry, _now_ms: i64) -> Vec<PathBuf> {
    Vec::new()
}
