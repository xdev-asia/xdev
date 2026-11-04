//! Updating a branch from its upstream or its base: fast-forward, the pull
//! policies and rebase from base.

use crate::{GitError, Repo};

/// How Pull and Sync combine local and remote commits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum PullPolicy {
    /// `--ff-only`: never a merge or a rebase.
    #[default]
    FfOnly,
    /// `--no-rebase`.
    Merge,
    /// `--rebase`.
    Rebase,
    /// No flag: the repository's own pull settings decide.
    GitConfig,
}

/// An unknown value is the default, as for the settings enums in the app.
impl<'de> serde::Deserialize<'de> for PullPolicy {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let value = <serde_json::Value as serde::Deserialize>::deserialize(de)?;
        Ok(match value.as_str() {
            Some("merge") => PullPolicy::Merge,
            Some("rebase") => PullPolicy::Rebase,
            Some("git-config") => PullPolicy::GitConfig,
            _ => PullPolicy::FfOnly,
        })
    }
}

impl Repo {
    /// Fast-forwards the current branch to its upstream; never merges or
    /// rebases. Histories that split are `Diverged`.
    pub fn fast_forward(&self) -> Result<(), GitError> {
        self.pull()
    }

    /// Pulls the upstream the way `policy` says.
    pub fn pull_with(&self, policy: PullPolicy) -> Result<(), GitError> {
        match policy {
            PullPolicy::FfOnly => self.pull(),
            _ => Err(todo("pull")),
        }
    }

    /// Rebases the current branch onto the remote branch behind `base`.
    /// A conflicted rebase is left in progress.
    pub fn rebase_from_base(&self, base: &str) -> Result<(), GitError> {
        let _ = base;
        Err(todo("rebase"))
    }
}

fn todo(what: &str) -> GitError {
    GitError::Failed {
        args: what.to_owned(),
        status: None,
        stderr: "not implemented".to_owned(),
    }
}
