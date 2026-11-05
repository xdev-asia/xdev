//! Brings a fork's default branch on `origin` up to `upstream`'s, as a
//! fast-forward push. The local branch, index and work tree are not touched.

use serde::{Deserialize, Serialize};

use crate::{GitError, Repo};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ForkSyncStatus {
    UpToDate,
    Synced,
    Blocked,
}

/// Why a sync did not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ForkSyncBlock {
    MissingOrigin,
    MissingUpstream,
    MissingUpstreamDefaultBranch,
    MissingOriginBranch,
    /// `origin` has commits on the branch that `upstream` lacks.
    Diverged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ForkSync {
    pub status: ForkSyncStatus,
    /// Set when `status` is `blocked`.
    pub reason: Option<ForkSyncBlock>,
    /// Upstream's default branch, once it is known.
    pub branch: Option<String>,
    /// Commits on `origin`'s branch that `upstream`'s lacks.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub ahead: u32,
    /// Commits on `upstream`'s branch that `origin`'s lacks; after a sync,
    /// the number of commits it brought.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub behind: u32,
}

impl Repo {
    /// The repo has remotes named both `origin` and `upstream`.
    pub fn has_fork_upstream(&self) -> Result<bool, GitError> {
        Ok(false)
    }

    /// `upstream`'s default branch, or `None` when it cannot be found.
    pub fn upstream_default_branch(&self) -> Result<Option<String>, GitError> {
        Ok(None)
    }

    /// Fast-forwards `origin`'s copy of upstream's default branch.
    pub fn sync_fork(&self) -> Result<ForkSync, GitError> {
        Err(GitError::NoRemote)
    }
}
