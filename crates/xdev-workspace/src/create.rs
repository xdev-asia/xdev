//! A new project made from scratch: a folder, and for a Git project `git
//! init` and a first commit, then listed in the sidebar.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{FolderEntry, Registry, RepoView, WorkspaceError};

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

/// Makes `parent/name`, and for a Git project `git init` and, unless
/// `first_commit` is off, an empty first commit; then lists it.
pub fn create_project(
    _reg: &mut Registry,
    _req: &CreateProject,
    _now_ms: i64,
) -> Result<Created, WorkspaceError> {
    Err(WorkspaceError::NotFound("create_project".to_owned()))
}
