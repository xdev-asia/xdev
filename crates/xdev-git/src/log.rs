//! The commit graph of `HEAD` for the history panel.

use crate::{GitError, Repo};

/// Commits per page the UI asks for.
pub const LOG_LIMIT: usize = 50;
/// The most commits one call returns.
pub const LOG_LIMIT_MAX: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum RefKind {
    Branch,
    Remote,
    Tag,
}

/// A name that points at a commit, without `refs/heads/`, `refs/remotes/`
/// or `refs/tags/`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CommitRef {
    pub name: String,
    pub kind: RefKind,
}

/// A named ref and the commit it points at.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LogRef {
    pub name: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LogCommit {
    pub id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Author time, Unix seconds.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub time: i64,
    /// `""` when the message is empty.
    pub subject: String,
    pub body: String,
    pub refs: Vec<CommitRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RepoLog {
    /// `HEAD` first, in topological order.
    pub commits: Vec<LogCommit>,
    /// `None` when `HEAD` is unborn.
    pub head: Option<String>,
    /// `None` when `HEAD` is detached or unborn.
    pub branch: Option<String>,
    pub upstream: Option<LogRef>,
    /// `None` when there is no base, or it is the upstream itself.
    pub base: Option<LogRef>,
    pub merge_base: Option<String>,
    /// The upstream has commits `HEAD` lacks.
    pub incoming: bool,
    /// `HEAD` is not the merge base.
    pub outgoing: bool,
    pub has_more: bool,
}

impl Repo {
    /// The log of `HEAD`, `limit` commits after `skip`.
    pub fn repo_log(
        &self,
        base: Option<&str>,
        limit: usize,
        skip: usize,
    ) -> Result<RepoLog, GitError> {
        let _ = (base, limit, skip);
        Err(GitError::Failed {
            args: "log".to_owned(),
            status: None,
            stderr: "not implemented".to_owned(),
        })
    }
}
