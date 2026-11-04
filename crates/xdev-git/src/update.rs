//! Updating a branch from its upstream or its base: fast-forward, the pull
//! policies and rebase from base.

use crate::remote::{failed, plain_remote, text};
use crate::run::{self, Output};
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

/// What git says when `pull` has no policy to reconcile two histories.
const NEEDS_POLICY: &str = "Need to specify how to reconcile divergent branches";

impl Repo {
    /// Fast-forwards the current branch to its upstream; never merges or
    /// rebases. Histories that split are `Diverged`.
    pub fn fast_forward(&self) -> Result<(), GitError> {
        self.pull_with(PullPolicy::FfOnly)
    }

    /// Pulls the upstream the way `policy` says. A pull that stops on
    /// conflicts is left in progress.
    pub fn pull_with(&self, policy: PullPolicy) -> Result<(), GitError> {
        self.current_branch()?.ok_or(GitError::Detached)?;
        let up = self.upstream()?.ok_or(GitError::NoUpstream)?;
        // The upstream's own remote and branch name; the branch may be
        // called differently there.
        let remote = plain_remote(up.remote)?;
        let branch = format!("refs/heads/{}", up.branch);
        if self.conflict_state()?.is_some() {
            return Err(GitError::Conflicted);
        }
        let mut flag = match policy {
            PullPolicy::FfOnly => Some("--ff-only"),
            PullPolicy::Merge => Some("--no-rebase"),
            PullPolicy::Rebase => Some("--rebase"),
            PullPolicy::GitConfig => None,
        };
        let mut out = self.pull_run(flag, &remote, &branch)?;
        if out.status != Some(0)
            && policy == PullPolicy::GitConfig
            && text(&out.stderr).contains(NEEDS_POLICY)
        {
            // The same fallback git's own advice suggests first.
            flag = Some("--no-rebase");
            out = self.pull_run(flag, &remote, &branch)?;
        }
        if out.status == Some(0) {
            return Ok(());
        }
        Err(self.pull_failure(policy, flag, &out))
    }

    fn pull_run(&self, flag: Option<&str>, remote: &str, branch: &str) -> Result<Output, GitError> {
        let mut args = vec!["pull", "--no-edit"];
        args.extend(flag);
        args.extend([remote, branch]);
        run::run_long_env(&self.workdir, &args, &[("LC_ALL", "C")])
    }

    /// Why a pull failed. The history and the repo state decide first; the
    /// message is read only because `pull_run` asked git for English.
    fn pull_failure(&self, policy: PullPolicy, flag: Option<&str>, out: &Output) -> GitError {
        if matches!(self.conflict_state(), Ok(Some(_))) {
            return GitError::StoppedOnConflicts;
        }
        let what = if policy == PullPolicy::Rebase {
            "rebase"
        } else {
            "fast-forward"
        };
        let stderr = text(&out.stderr);
        if stderr.contains("untracked working tree files would be overwritten") {
            return GitError::Untracked(what);
        }
        if stderr.contains("would be overwritten") || stderr.contains("commit or stash") {
            return GitError::Dirty(what);
        }
        let split = matches!(self.upstream(), Ok(Some(u)) if u.ahead > 0 && u.behind > 0);
        let cannot =
            stderr.contains("Not possible to fast-forward") || stderr.contains(NEEDS_POLICY);
        match policy {
            PullPolicy::FfOnly if split || cannot => return GitError::Diverged,
            PullPolicy::GitConfig if cannot => return GitError::PullPolicy,
            _ => {}
        }
        failed(format!("pull {}", flag.unwrap_or("")).trim_end(), out)
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
