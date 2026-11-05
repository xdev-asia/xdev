//! Brings a fork's default branch on `origin` up to `upstream`'s, as a
//! fast-forward push. The local branch, index and work tree are not touched.

use serde::{Deserialize, Serialize};

use crate::remote::{failed, parse_counts, text};
use crate::run::{self, Output};
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

const ORIGIN: &str = "origin";
const UPSTREAM: &str = "upstream";

impl ForkSync {
    fn blocked(reason: ForkSyncBlock, branch: Option<String>, ahead: u32, behind: u32) -> ForkSync {
        ForkSync {
            status: ForkSyncStatus::Blocked,
            reason: Some(reason),
            branch,
            ahead,
            behind,
        }
    }
}

impl Repo {
    /// The repo has remotes named both `origin` and `upstream`.
    pub fn has_fork_upstream(&self) -> Result<bool, GitError> {
        let names = self.remote_names()?;
        Ok([ORIGIN, UPSTREAM]
            .iter()
            .all(|r| names.iter().any(|n| n == r)))
    }

    /// `upstream`'s default branch: what its `HEAD` points at, else
    /// `main`, else `master` when a remote-tracking ref for it was fetched.
    /// `None` when none is found or the name is not a valid branch name.
    pub fn upstream_default_branch(&self) -> Result<Option<String>, GitError> {
        let out = run::run_long(&self.workdir, &["ls-remote", "--symref", UPSTREAM, "HEAD"])?;
        if out.status == Some(0)
            && let Some(branch) = symref_branch(&text(&out.stdout))
        {
            return Ok(self.branch_name_ok(&branch)?.then_some(branch));
        }
        for branch in ["main", "master"] {
            if self
                .resolve_ref(&format!("refs/remotes/{UPSTREAM}/{branch}"))?
                .is_some()
            {
                return Ok(Some(branch.to_owned()));
            }
        }
        Ok(None)
    }

    /// `git check-ref-format --branch`, and no leading `-`, so the name can
    /// be put in a refspec.
    fn branch_name_ok(&self, branch: &str) -> Result<bool, GitError> {
        if branch.is_empty() || branch.starts_with('-') {
            return Ok(false);
        }
        let (status, _) = run::run_status(
            &self.workdir,
            &["check-ref-format", "--branch", branch],
            None,
        )?;
        Ok(status == Some(0))
    }

    /// Fetches `refs/heads/<branch>` of `remote` into its remote-tracking ref.
    fn fetch_branch(&self, remote: &str, branch: &str) -> Result<Output, GitError> {
        let spec = format!("+refs/heads/{branch}:refs/remotes/{remote}/{branch}");
        run::run_long(
            &self.workdir,
            &["fetch", "--no-tags", "--prune", remote, &spec],
        )
    }

    /// Fast-forwards `origin`'s copy of upstream's default branch to
    /// upstream's, with a plain push of that one ref: never forced, and the
    /// local branch, index and work tree are not touched. A fork whose
    /// branch has commits upstream lacks is `Diverged`, left as it is.
    pub fn sync_fork(&self) -> Result<ForkSync, GitError> {
        let names = self.remote_names()?;
        if !names.iter().any(|n| n == ORIGIN) {
            return Ok(ForkSync::blocked(ForkSyncBlock::MissingOrigin, None, 0, 0));
        }
        if !names.iter().any(|n| n == UPSTREAM) {
            return Ok(ForkSync::blocked(
                ForkSyncBlock::MissingUpstream,
                None,
                0,
                0,
            ));
        }
        let Some(branch) = self.upstream_default_branch()? else {
            return Ok(ForkSync::blocked(
                ForkSyncBlock::MissingUpstreamDefaultBranch,
                None,
                0,
                0,
            ));
        };
        let out = self.fetch_branch(UPSTREAM, &branch)?;
        if out.status != Some(0) {
            return Err(failed("fetch", &out));
        }
        let out = self.fetch_branch(ORIGIN, &branch)?;
        if out.status != Some(0) {
            let head = format!("refs/heads/{branch}");
            let missing = run::run_long(
                &self.workdir,
                &["ls-remote", "--exit-code", "--heads", ORIGIN, &head],
            )?;
            // `--exit-code` answers 2 when no ref matched.
            if missing.status == Some(2) {
                return Ok(ForkSync::blocked(
                    ForkSyncBlock::MissingOriginBranch,
                    Some(branch),
                    0,
                    0,
                ));
            }
            return Err(failed("fetch", &out));
        }

        let ours = format!("refs/remotes/{ORIGIN}/{branch}");
        let theirs = format!("refs/remotes/{UPSTREAM}/{branch}");
        let range = format!("{ours}...{theirs}");
        let (ahead, behind) = parse_counts(&run::run(
            &self.workdir,
            &["rev-list", "--left-right", "--count", &range],
            None,
        )?)?;
        let (status, _) = run::run_status(
            &self.workdir,
            &["merge-base", "--is-ancestor", &ours, &theirs],
            None,
        )?;
        if ahead > 0 || status != Some(0) {
            return Ok(ForkSync::blocked(
                ForkSyncBlock::Diverged,
                Some(branch),
                ahead,
                behind,
            ));
        }
        if behind == 0 {
            return Ok(ForkSync {
                status: ForkSyncStatus::UpToDate,
                reason: None,
                branch: Some(branch),
                ahead,
                behind,
            });
        }
        let id = self
            .resolve_ref(&theirs)?
            .ok_or_else(|| GitError::BadId(theirs.clone()))?;
        // No `+` and no `--force`: the remote refuses anything but a fast-forward.
        let refspec = format!("{id}:refs/heads/{branch}");
        self.push_with(&["push", "--porcelain", ORIGIN, &refspec])?;
        let out = self.fetch_branch(ORIGIN, &branch)?;
        if out.status != Some(0) {
            return Err(failed("fetch", &out));
        }
        Ok(ForkSync {
            status: ForkSyncStatus::Synced,
            reason: None,
            branch: Some(branch),
            ahead,
            behind,
        })
    }
}

/// The branch in `ref: refs/heads/<branch>\tHEAD` of `ls-remote --symref`.
fn symref_branch(out: &str) -> Option<String> {
    out.lines().find_map(|line| {
        let (target, name) = line.strip_prefix("ref: ")?.split_once('\t')?;
        (name == "HEAD").then_some(())?;
        target.strip_prefix("refs/heads/").map(str::to_owned)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_symref_line() {
        let out = "ref: refs/heads/trunk\tHEAD\n0123abcd\tHEAD";
        assert_eq!(symref_branch(out).as_deref(), Some("trunk"));
        assert_eq!(symref_branch("0123abcd\tHEAD"), None);
        assert_eq!(symref_branch("ref: refs/tags/v1\tHEAD"), None);
        assert_eq!(symref_branch("ref: refs/heads/x\trefs/heads/y"), None);
    }
}
