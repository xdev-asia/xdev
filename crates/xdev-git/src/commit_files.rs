//! The files one commit changed, against its first parent.

use crate::{GitError, Repo};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum CommitFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    /// The name before a rename or the source of a copy.
    pub old_path: Option<String>,
    pub status: CommitFileStatus,
    /// `None` for a binary file.
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    pub added: Option<u64>,
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    pub removed: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CommitFiles {
    pub id: String,
    /// The first parent; `None` for a root commit.
    pub parent: Option<String>,
    pub files: Vec<CommitFile>,
}

impl Repo {
    /// What commit `id` changed against its first parent.
    pub fn commit_files(&self, id: &str) -> Result<CommitFiles, GitError> {
        let _ = id;
        Err(GitError::Failed {
            args: "diff".to_owned(),
            status: None,
            stderr: "not implemented".to_owned(),
        })
    }

    /// The first parent of commit `id`; `None` for a root commit.
    pub fn first_parent(&self, id: &str) -> Result<Option<String>, GitError> {
        let _ = id;
        Err(GitError::Failed {
            args: "rev-list".to_owned(),
            status: None,
            stderr: "not implemented".to_owned(),
        })
    }
}
