//! Branches whose worktree was archived or deleted while the branch stayed
//! in git, and bringing such a worktree back. xDev never deletes a kept
//! branch on its own; the person reviews them.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use xdev_git::{GitError, Repo};

use crate::ops::{
    Removed, WorktreeView, default_short, drop_folder, find_repo, leaving, path_key, start_of,
    view_of,
};
use crate::{Registry, WorkItem, WorkStatus, WorkspaceError, WorktreeMeta};

/// Archived entries show under "Archived" this long; after that they are
/// offered in the branch review only.
pub const ARCHIVE_DAYS: i64 = 7;
const DAY_MS: i64 = 86_400_000;

/// Why a branch outlived its worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum KeptReason {
    Archived,
    Deleted,
}

/// A branch left in git when its worktree went, with the details the
/// worktree had so a restore brings them back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct KeptBranch {
    pub repo_id: String,
    pub branch: String,
    /// Where the worktree was.
    #[cfg_attr(feature = "ts", ts(as = "String"))]
    pub path: PathBuf,
    pub kept_ms: i64,
    pub reason: KeptReason,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub status: Option<WorkStatus>,
    #[serde(default)]
    pub item: Option<WorkItem>,
}

/// A kept branch as the sidebar and the review dialog show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct KeptView {
    pub entry: KeptBranch,
    /// Commits on the branch that the repo's base ref does not have.
    pub ahead: u32,
    /// Archived less than `ARCHIVE_DAYS` ago: listed under "Archived".
    pub archived_shown: bool,
}

/// Records `branch` of the worktree `meta` described as kept, replacing an
/// older entry for the same branch.
pub(crate) fn keep(
    reg: &mut Registry,
    meta: &WorktreeMeta,
    branch: String,
    reason: KeptReason,
    now_ms: i64,
) -> KeptBranch {
    let kept = KeptBranch {
        repo_id: meta.repo_id.clone(),
        branch,
        path: meta.path.clone(),
        kept_ms: now_ms,
        reason,
        title: meta.title.clone(),
        comment: meta.comment.clone(),
        status: meta.status,
        item: meta.item.clone(),
    };
    reg.kept
        .retain(|k| !(k.repo_id == kept.repo_id && k.branch == kept.branch));
    reg.kept.push(kept.clone());
    kept
}

/// Removes a linked worktree's folder and keeps its branch. Without
/// `force` it must have no changes; a detached worktree has no branch to
/// keep and needs `force` too. The branch is never deleted.
pub fn archive_worktree(
    reg: &mut Registry,
    path: &Path,
    force: bool,
    now_ms: i64,
) -> Result<Removed, WorkspaceError> {
    let l = leaving(reg, path, force)?;
    if l.branch.is_none() && !force {
        return Err(WorkspaceError::Detached(path.to_owned()));
    }
    drop_folder(reg, &l)?;
    let kept = l
        .branch
        .clone()
        .map(|b| keep(reg, &l.meta, b, KeptReason::Archived, now_ms));
    Ok(Removed {
        deleted_branch: None,
        kept,
    })
}

fn kept_index(reg: &Registry, repo_id: &str, branch: &str) -> Result<usize, WorkspaceError> {
    reg.kept
        .iter()
        .position(|k| k.repo_id == repo_id && k.branch == branch)
        .ok_or_else(|| WorkspaceError::KeptUnknown {
            repo_id: repo_id.to_owned(),
            branch: branch.to_owned(),
        })
}

/// `wanted` when no file or folder is there, else `<root>/<leaf>-2`, `-3`, …
fn free_path(wanted: &Path, root: &Path) -> PathBuf {
    if !wanted.exists() {
        return wanted.to_owned();
    }
    let leaf = wanted
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "worktree".to_owned());
    (2..)
        .map(|n| root.join(format!("{leaf}-{n}")))
        .find(|p| !p.exists())
        .expect("some suffix is free")
}

/// Brings back a kept branch's worktree at its old path (or a free one
/// beside it) with the details it had, and drops the entry.
pub fn restore_worktree(
    reg: &mut Registry,
    repo_id: &str,
    branch: &str,
    now_ms: i64,
) -> Result<WorktreeView, WorkspaceError> {
    let idx = kept_index(reg, repo_id, branch)?;
    let kept = reg.kept[idx].clone();
    let entry = find_repo(reg, repo_id)?;
    let repo = Repo::discover(&entry.path)?;
    if !repo.branch_exists(branch)? {
        return Err(WorkspaceError::KeptUnknown {
            repo_id: repo_id.to_owned(),
            branch: branch.to_owned(),
        });
    }
    let folder = free_path(&kept.path, &entry.worktree_root);
    if let Some(parent) = folder.parent() {
        fs::create_dir_all(parent)?;
    }
    repo.add_worktree_on(&folder, branch)?;
    let key = path_key(&folder);
    let listed = repo.list_worktrees()?;
    let git_entry = listed
        .iter()
        .find(|e| e.branch.as_deref() == Some(branch) && !e.detached)
        .or_else(|| listed.iter().find(|e| path_key(&e.path) == key))
        .cloned()
        .ok_or_else(|| WorkspaceError::WorktreeUnknown(folder.clone()))?;
    let meta = WorktreeMeta {
        repo_id: entry.id.clone(),
        path: git_entry.path.clone(),
        start: start_of(&repo, &git_entry, &entry.base_ref)?,
        created_ms: now_ms,
        made_here: true,
        title: kept.title,
        comment: kept.comment,
        status: kept.status,
        item: kept.item,
        ..WorktreeMeta::default()
    };
    let default = default_short(&repo, &entry.base_ref)?;
    let view = view_of(
        &git_entry,
        &entry.short_name,
        Some(&meta),
        default.as_deref(),
    );
    reg.worktrees.push(meta);
    reg.kept.remove(idx);
    Ok(view)
}

/// Every kept branch with its commits ahead of the base, oldest first.
/// Entries whose repo was forgotten or whose branch is gone from git are
/// dropped; a repo that cannot be opened now keeps its entries unlisted.
pub fn kept_list(reg: &mut Registry, now_ms: i64) -> Result<Vec<KeptView>, WorkspaceError> {
    let mut views = Vec::new();
    let mut gone = Vec::new();
    for (i, kept) in reg.kept.iter().enumerate() {
        let Ok(entry) = find_repo(reg, &kept.repo_id) else {
            gone.push(i);
            continue;
        };
        let Ok(repo) = Repo::discover(&entry.path) else {
            continue;
        };
        if !repo.branch_exists(&kept.branch)? {
            gone.push(i);
            continue;
        }
        let ahead = match repo.count_ahead(&kept.branch, &entry.base_ref) {
            Ok(n) => n,
            Err(GitError::BadId(_)) => {
                gone.push(i);
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        views.push(KeptView {
            entry: kept.clone(),
            ahead,
            archived_shown: kept.reason == KeptReason::Archived
                && now_ms - kept.kept_ms < ARCHIVE_DAYS * DAY_MS,
        });
    }
    for i in gone.into_iter().rev() {
        reg.kept.remove(i);
    }
    views.sort_by_key(|v| v.entry.kept_ms);
    Ok(views)
}

/// Drops the entry; the branch stays in git.
pub fn kept_keep(reg: &mut Registry, repo_id: &str, branch: &str) -> Result<(), WorkspaceError> {
    let idx = kept_index(reg, repo_id, branch)?;
    reg.kept.remove(idx);
    Ok(())
}

/// Deletes the kept branch from git, merged or not, then drops the entry.
/// The policy check and the person's confirmation are the caller's.
pub fn kept_delete(reg: &mut Registry, repo_id: &str, branch: &str) -> Result<(), WorkspaceError> {
    let idx = kept_index(reg, repo_id, branch)?;
    let entry = find_repo(reg, repo_id)?;
    Repo::discover(&entry.path)?.delete_branch(branch)?;
    reg.kept.remove(idx);
    Ok(())
}
