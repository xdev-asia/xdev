//! The desktop app's list of repos and the worktrees made from them.

mod cleanup;
mod create;
pub mod deploy;
mod env;
mod files;
mod groups;
mod hooks;
mod kept;
mod names;
mod nested;
mod ops;
mod registry;
mod repo_commands;
mod search;
mod shared;
mod staging;
mod vaults;

use std::io;
use std::path::PathBuf;

pub use xdev_git::GhAccount;
use xdev_git::GitError;

pub use cleanup::{HEAVY, HeavyDir, WorktreeUsage, disk_usage, remove_heavy};
pub use create::{CreateProject, Created, PROJECT_NAME_MAX, ProjectKind, create_project};
pub use env::{
    ENV_KEY_MAX, ENV_MAX, ENV_VALUE_MAX, EnvPreviewRow, MASK, RESERVED_PREFIX, RepoEnvVar,
    SecretStore, clean_env, is_reserved, merge_env, preview_env, valid_key,
};
pub use files::{
    Eol, FileKind, FileText, IMAGE_MAX, MEDIA_MAX, MediaKind, OsTrash, READ_MAX, Trash,
    WriteOutcome, content_hash, create_entry, entry_path, file_text, link_rel, media_kind,
    read_bytes, read_file, rename_entry, text_with_eol, too_large_text, trash_entry,
    trash_entry_with, write_file,
};
pub use groups::{
    FolderEntry, RepoGroup, SidebarItem, folder_add, folder_forget, group_move, group_put,
    group_remove, set_order, sidebar,
};
pub use hooks::{
    DefaultTab, FILE_NAME, HookKind, HookRun, HookScript, RepoHooks, SHARED_MAX, TABS_MAX,
    TRUST_FILE, detect_setup, effective_issue_command, hook_env, hooks_for, issue_command_for,
    shared_to_link, trust, trust_hook,
};
pub use kept::{
    ARCHIVE_DAYS, KeptBranch, KeptReason, KeptView, archive_worktree, kept_delete, kept_keep,
    kept_list, restore_worktree,
};
pub use names::{PrefixIssue, SUFFIX_MAX, from_work, normalize_prefix, prefix_issue, suffixed};
pub use nested::{NESTED_SCAN_DEPTH, NestedScan, scan_nested_repos};
pub use ops::{
    BranchPrefix, COMMENT_MAX, CreateOptions, DetailsPatch, DirEntry, DirListing, ITEM_URL_MAX,
    NamePreview, Removed, RepoPatch, RepoView, TITLE_MAX, WorktreeStat, WorktreeView, add_repo,
    adopt_worktree, base_drift, clean_sparse_presets, create_worktree, create_worktree_linked,
    create_worktree_with, forget_repo, list, list_dir, name_preview, path_key, refresh_base,
    remote_branch_named, remove_worktree, rename_branch, set_details, set_pinned, stat,
    update_repo, valid_short_name, worktree_root_for,
};
pub use registry::{
    ISSUE_COMMAND_MAX, MadeBy, REPO_COLORS, Registry, RepoEntry, RepoIcon, SPARSE_PRESET_NAME_MAX,
    SPARSE_PRESETS_MAX, ScriptSource, SetupPolicy, SparsePreset, VaultEntry, WorkItem,
    WorkItemKind, WorkStatus, WorktreeMeta, repo_id,
};
pub use repo_commands::{
    COMMAND_LABEL_MAX, COMMAND_PROMPT_MAX, COMMAND_TEXT_MAX, RepoAction, RepoCommand, RepoCommands,
    repo_commands, trust_commands,
};
pub use search::{
    FileHits, FileList, HIT_MAX, LINE_CLIP, LIST_MAX, LineHit, PER_FILE_MAX, SearchEvent,
    SearchQuery, list_files, search_text,
};
pub use shared::{Linked, SharedError, link_shared, unlink_shared, validate as validate_shared};
pub use staging::{STAGING, staging_dir, sweep, sweep_with};
pub use vaults::{
    VaultKind, VaultView, add_vault, adopt_last_vault, forget_vault, list_vaults, repo_docs_dir,
    validate_docs_dir,
};

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
    /// The branch is already checked out in a worktree.
    #[error("the branch is checked out in a worktree: {0}")]
    BranchInUse(String),
    /// A sparse checkout list git would misread.
    #[error("not a usable sparse checkout list: {0}")]
    BadSparse(String),
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
    /// A file or folder of that name is already there.
    #[error("already exists: {0}")]
    Exists(String),
    #[error("not found: {0}")]
    NotFound(String),
    /// A shared script whose exact content the person has not trusted.
    #[error("the {0} script from xdev.toml is not trusted")]
    HookUntrusted(String),
    #[error("no {0} script")]
    NoHook(String),
    /// The repo's setup policy is Skip, so its setup never runs.
    #[error("setup is turned off for this repo")]
    SetupSkipped,
    #[error("the script failed with code {code:?}")]
    HookFailed { code: Option<i32>, output: String },
    /// A title or comment past its length limit.
    #[error("details too long: {0}")]
    BadDetails(String),
    /// Not a worktree that can hold this one: another repo, itself, the
    /// primary checkout, or one that is a child or has children.
    #[error("not a usable parent: {0}")]
    BadParent(String),
    #[error("not a usable work item link: {0}")]
    BadItem(String),
    /// A detached worktree has no branch to keep when archived.
    #[error("detached HEAD, no branch to keep: {0}")]
    Detached(PathBuf),
    #[error("no kept branch {branch} in repo {repo_id}")]
    KeptUnknown { repo_id: String, branch: String },
    #[error("unknown group: {0}")]
    GroupUnknown(String),
    #[error("unknown folder: {0}")]
    FolderUnknown(String),
    /// Already listed as a folder, a repo or a worktree.
    #[error("folder already listed: {0}")]
    FolderExists(String),
    /// The branch has an upstream; renaming it would break the pull request.
    #[error("the branch has an upstream: {0}")]
    BranchPushed(String),
    /// Not a colour name and not `#rgb` / `#rrggbb`.
    #[error("not a usable colour: {0}")]
    BadColor(String),
    /// Not one emoji.
    #[error("not a usable icon: {0}")]
    BadIcon(String),
    /// A text over its size cap.
    #[error("too large: {0}")]
    TooLarge(String),
    /// An environment row with a key that is not usable.
    #[error("not a usable environment variable: {0}")]
    BadEnv(String),
    /// A long run was stopped by the person.
    #[error("cancelled")]
    Cancelled,
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
            WorkspaceError::BranchInUse(_) => "branch_in_use",
            WorkspaceError::BadSparse(_) => "bad_sparse",
            WorkspaceError::BadName(_) => "bad_name",
            WorkspaceError::BadPrefix(_) => "bad_branch_prefix",
            WorkspaceError::ShortNameTaken(_) => "short_name_taken",
            WorkspaceError::VaultExists(_) => "vault_exists",
            WorkspaceError::VaultUnknown(_) => "vault_unknown",
            WorkspaceError::Dirty(_) => "worktree_dirty",
            WorkspaceError::Primary(_) => "primary_worktree",
            WorkspaceError::BadPath(_) => "bad_path",
            WorkspaceError::Exists(_) => "exists",
            WorkspaceError::NotFound(_) => "not_found",
            WorkspaceError::HookUntrusted(_) => "hook_untrusted",
            WorkspaceError::NoHook(_) => "hook_none",
            WorkspaceError::SetupSkipped => "setup_skipped",
            WorkspaceError::HookFailed { .. } => "hook_failed",
            WorkspaceError::BadDetails(_) => "bad_details",
            WorkspaceError::BadParent(_) => "bad_parent",
            WorkspaceError::BadItem(_) => "bad_item",
            WorkspaceError::Detached(_) => "detached",
            WorkspaceError::KeptUnknown { .. } => "kept_unknown",
            WorkspaceError::GroupUnknown(_) => "group_unknown",
            WorkspaceError::FolderUnknown(_) => "folder_unknown",
            WorkspaceError::FolderExists(_) => "folder_exists",
            WorkspaceError::BranchPushed(_) => "branch_pushed",
            WorkspaceError::BadColor(_) => "bad_color",
            WorkspaceError::BadIcon(_) => "bad_icon",
            WorkspaceError::TooLarge(_) => "too_large",
            WorkspaceError::BadEnv(_) => "bad_env",
            WorkspaceError::Cancelled => "cancelled",
        }
    }
}
