//! The desktop app's list of repos and the worktrees made from them.

mod names;
mod ops;
mod registry;

use std::io;
use std::path::PathBuf;

use xdev_git::GitError;

pub use ops::{
    RepoView, WorktreeView, add_repo, create_worktree, forget_repo, list, path_key,
    remove_worktree, set_pinned,
};
pub use registry::{Registry, RepoEntry, WorktreeMeta, repo_id};

/// The UI translates `code()`, never the message.
#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("registry file is unusable: {0}")]
    Corrupt(String),
    #[error("repo already added: {0}")]
    RepoExists(String),
    #[error("unknown repo: {0}")]
    RepoUnknown(String),
    #[error("unknown worktree: {0}")]
    WorktreeUnknown(PathBuf),
    #[error("worktree folder already exists: {0}")]
    WorktreeExists(PathBuf),
    #[error("branch already exists: {0}")]
    BranchExists(String),
    #[error("not a commit: {0}")]
    BadRef(String),
    #[error("not a usable name: {0}")]
    BadName(String),
    #[error("worktree has uncommitted changes: {0}")]
    Dirty(PathBuf),
    #[error("the primary checkout cannot be removed: {0}")]
    Primary(PathBuf),
}

impl WorkspaceError {
    pub fn code(&self) -> &'static str {
        match self {
            WorkspaceError::Git(e) => e.code(),
            WorkspaceError::Io(_) => "io",
            WorkspaceError::Corrupt(_) => "registry_corrupt",
            WorkspaceError::RepoExists(_) => "repo_exists",
            WorkspaceError::RepoUnknown(_) => "repo_unknown",
            WorkspaceError::WorktreeUnknown(_) => "worktree_unknown",
            WorkspaceError::WorktreeExists(_) => "worktree_exists",
            WorkspaceError::BranchExists(_) => "branch_exists",
            WorkspaceError::BadRef(_) => "bad_ref",
            WorkspaceError::BadName(_) => "bad_name",
            WorkspaceError::Dirty(_) => "worktree_dirty",
            WorkspaceError::Primary(_) => "primary_worktree",
        }
    }
}
