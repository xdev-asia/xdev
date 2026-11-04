//! A new project made from scratch: a folder, and for a Git project `git
//! init` and a first commit, then listed in the sidebar.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use xdev_git::Repo;

use crate::{FolderEntry, Registry, RepoView, WorkspaceError, add_repo, folder_add};

/// The longest project name, in characters.
pub const PROJECT_NAME_MAX: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum ProjectKind {
    Git,
    Folder,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CreateProject {
    #[cfg_attr(feature = "ts", ts(as = "String"))]
    pub parent: PathBuf,
    pub name: String,
    pub kind: ProjectKind,
    /// Git only. Empty = "main".
    pub branch: String,
    /// Git only. Default true: worktrees need a commit to start from.
    pub first_commit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Created {
    Git { repo: RepoView },
    Folder { folder: FolderEntry },
}

const DEFAULT_BRANCH: &str = "main";
const FIRST_COMMIT_MESSAGE: &str = "Initial commit";

/// Names Windows keeps for devices, with or without an extension.
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A project name that is one plain folder name on every system.
fn name_ok(name: &str) -> bool {
    let len = name.chars().count();
    if len == 0 || len > PROJECT_NAME_MAX || name == "." || name == ".." {
        return false;
    }
    if name.chars().any(|c| {
        c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return false;
    }
    // Windows drops a trailing dot, which would name another folder.
    if name.ends_with('.') {
        return false;
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    !RESERVED.contains(&stem.to_lowercase().as_str())
}

/// The target folder is free: absent, or an empty folder.
fn target_free(target: &Path) -> Result<(), WorkspaceError> {
    match fs::read_dir(target) {
        Ok(mut entries) => match entries.next() {
            None => Ok(()),
            Some(_) => Err(WorkspaceError::Exists(target.display().to_string())),
        },
        Err(_) if target.symlink_metadata().is_ok() => {
            // A file, or a folder that cannot be read.
            Err(WorkspaceError::Exists(target.display().to_string()))
        }
        Err(_) => Ok(()),
    }
}

/// Makes `parent/name`, and for a Git project `git init` and, unless
/// `first_commit` is off, an empty first commit; then lists it. Everything
/// is checked before anything is made. A first commit that fails (no git
/// identity) leaves the folder and `.git` and lists nothing.
pub fn create_project(
    reg: &mut Registry,
    req: &CreateProject,
    now_ms: i64,
) -> Result<Created, WorkspaceError> {
    let name = req.name.trim();
    if !name_ok(name) {
        return Err(WorkspaceError::BadName(req.name.clone()));
    }
    if !req.parent.is_dir() {
        return Err(WorkspaceError::NotFound(req.parent.display().to_string()));
    }
    let target = req.parent.join(name);
    target_free(&target)?;
    let branch = match req.branch.trim() {
        "" => DEFAULT_BRANCH,
        typed => typed,
    };
    if req.kind == ProjectKind::Git && !xdev_git::valid_branch_name(branch)? {
        return Err(WorkspaceError::BadName(branch.to_owned()));
    }
    fs::create_dir_all(&target)?;
    match req.kind {
        ProjectKind::Folder => Ok(Created::Folder {
            folder: folder_add(reg, &target)?,
        }),
        ProjectKind::Git => {
            let repo = Repo::init_on(&target, branch)?;
            if req.first_commit {
                repo.commit_empty(FIRST_COMMIT_MESSAGE)?;
            }
            Ok(Created::Git {
                repo: add_repo(reg, &target, now_ms)?,
            })
        }
    }
}
