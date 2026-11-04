//! A merge, rebase, cherry-pick or revert stopped on conflicts: what is in
//! progress, which files are unmerged, and how to continue or abort it.

use serde::Serialize;

use crate::{GitError, Repo};

/// The operation a conflicted work tree is in the middle of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum ConflictOp {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConflictState {
    pub op: ConflictOp,
    /// Unmerged paths, relative to the repo's top folder.
    pub files: Vec<String>,
    /// What the operation applies onto: the branch being merged, the rebase
    /// target, or the commit being picked or reverted; `None` when unknown.
    pub onto: Option<String>,
    /// Rebase only: the step and the number of steps.
    pub step: Option<(u32, u32)>,
}

impl Repo {
    /// The operation in progress, or `None` for a clean repo.
    pub fn conflict_state(&self) -> Result<Option<ConflictState>, GitError> {
        // Contract stub; B1 fills it in.
        Ok(None)
    }

    /// Finishes the operation once no file is unmerged; no editor opens.
    pub fn conflict_continue(&self, _op: ConflictOp) -> Result<(), GitError> {
        // Contract stub; B1 fills it in.
        Err(GitError::NoRepo)
    }

    /// Gives the operation up and puts the work tree back as it was before.
    pub fn conflict_abort(&self, _op: ConflictOp) -> Result<(), GitError> {
        // Contract stub; B1 fills it in.
        Err(GitError::NoRepo)
    }
}
