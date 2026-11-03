//! The desktop app's list of repos and the worktrees made from them.

mod names;
mod ops;
mod registry;
mod vaults;

use std::io;
use std::path::PathBuf;

use xdev_git::GitError;

pub use names::{PrefixIssue, normalize_prefix, prefix_issue};
pub use ops::{
    BranchPrefix, CreateOptions, DirEntry, DirListing, RepoPatch, RepoView, WorktreeStat,
    WorktreeView, add_repo, adopt_worktree, create_worktree, create_worktree_with, forget_repo,
    list, list_dir, path_key, refresh_base, remove_worktree, set_pinned, stat, update_repo,
    valid_short_name,
};
pub use registry::{Registry, RepoEntry, VaultEntry, WorktreeMeta, repo_id};
pub use vaults::{VaultKind, VaultView, add_vault, forget_vault, list_vaults, repo_docs_dir};

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
    /// The custom branch prefix set in Settings, Git, cannot start a ref.
    #[error("the custom branch prefix is not usable: {0}")]
    BadPrefix(String),
    #[error("short name already used by another repo: {0}")]
    ShortNameTaken(String),
    #[error("vault already added: {0}")]
    VaultExists(String),
    #[error("unknown vault: {0}")]
    VaultUnknown(String),
    #[error("worktree has uncommitted changes: {0}")]
    Dirty(PathBuf),
    #[error("the primary checkout cannot be removed: {0}")]
    Primary(PathBuf),
    #[error("not a folder inside the worktree: {0}")]
    BadPath(String),
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
            WorkspaceError::BadPrefix(_) => "bad_branch_prefix",
            WorkspaceError::ShortNameTaken(_) => "short_name_taken",
            WorkspaceError::VaultExists(_) => "vault_exists",
            WorkspaceError::VaultUnknown(_) => "vault_unknown",
            WorkspaceError::Dirty(_) => "worktree_dirty",
            WorkspaceError::Primary(_) => "primary_worktree",
            WorkspaceError::BadPath(_) => "bad_path",
        }
    }
}
