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

    /// Conflicts left in progress, or local changes or untracked files in the
    /// way: what a failed update says about itself. The message is read only
    /// because the caller asked git for English.
    fn stopped_by(&self, out: &Output, what: &'static str) -> Option<GitError> {
        if matches!(self.conflict_state(), Ok(Some(_))) {
            return Some(GitError::StoppedOnConflicts);
        }
        let stderr = text(&out.stderr);
        if stderr.contains("untracked working tree files would be overwritten") {
            return Some(GitError::Untracked(what));
        }
        let dirty = [
            "would be overwritten",
            "commit or stash",
            "unstaged changes",
        ];
        dirty
            .iter()
            .any(|m| stderr.contains(m))
            .then_some(GitError::Dirty(what))
    }

    /// Why a pull failed. The history and the repo state decide first; the
    /// message is read only because `pull_run` asked git for English.
    fn pull_failure(&self, policy: PullPolicy, flag: Option<&str>, out: &Output) -> GitError {
        let what = if policy == PullPolicy::Rebase {
            "rebase"
        } else {
            "fast-forward"
        };
        if let Some(e) = self.stopped_by(out, what) {
            return e;
        }
        let stderr = text(&out.stderr);
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
    /// A conflicted rebase is left in progress; local changes are never
    /// stashed.
    pub fn rebase_from_base(&self, base: &str) -> Result<(), GitError> {
        let (remote, branch, _) = self.base_source(base)?.ok_or(GitError::BaseNotRemote)?;
        if self.conflict_state()?.is_some() {
            return Err(GitError::Conflicted);
        }
        if !self.is_clean()? {
            return Err(GitError::Dirty("rebase"));
        }
        let tracking = format!("refs/remotes/{remote}/{branch}");
        // Read before the fetch moves the tracking ref.
        let head = self.head()?;
        let fork = match head {
            Some(_) => {
                let (status, out) = run::run_status(
                    &self.workdir,
                    &["merge-base", "--fork-point", &tracking, "HEAD"],
                    None,
                )?;
                (status == Some(0))
                    .then(|| text(&out))
                    .filter(|id| !id.is_empty())
            }
            None => None,
        };
        let tmp = temp_ref();
        let result = self.fetch_and_rebase(
            &remote,
            &branch,
            &tracking,
            &tmp,
            fork.as_deref(),
            head.is_some(),
        );
        // Deleted on every path, a failed rebase and a timeout included.
        let _ = run::run_status(&self.workdir, &["update-ref", "-d", &tmp], None);
        result
    }

    fn fetch_and_rebase(
        &self,
        remote: &str,
        branch: &str,
        tracking: &str,
        tmp: &str,
        fork: Option<&str>,
        has_head: bool,
    ) -> Result<(), GitError> {
        let mut out = self.git_english(&fetch_args(remote, branch, tracking, tmp, true))?;
        if out.status == Some(129) {
            // Git before 2.29 has no `--no-write-fetch-head`.
            out = self.git_english(&fetch_args(remote, branch, tracking, tmp, false))?;
        }
        if out.status != Some(0) {
            return Err(failed("fetch", &out));
        }
        let args = if has_head {
            rebase_args(fork, tmp)
        } else {
            vec!["merge".to_owned(), "--ff-only".to_owned(), tmp.to_owned()]
        };
        let out = self.git_english(&args)?;
        if out.status == Some(0) {
            return Ok(());
        }
        Err(self
            .stopped_by(&out, "rebase")
            .unwrap_or_else(|| failed(&args[..2.min(args.len())].join(" "), &out)))
    }

    fn git_english(&self, args: &[String]) -> Result<Output, GitError> {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run::run_long_env(&self.workdir, &args, &[("LC_ALL", "C")])
    }
}

/// A ref name no other run uses, so two updates never share one.
fn temp_ref() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("refs/xdev/rebase/{}-{nanos:x}-{n}", std::process::id())
}

/// Fetches the base branch into the temp ref and the tracking ref.
fn fetch_args(
    remote: &str,
    branch: &str,
    tracking: &str,
    tmp: &str,
    write_fetch_head: bool,
) -> Vec<String> {
    let mut args = vec!["fetch".to_owned()];
    if write_fetch_head {
        args.push("--no-write-fetch-head".to_owned());
    }
    args.push(remote.to_owned());
    args.push(format!("+refs/heads/{branch}:{tmp}"));
    args.push(format!("+refs/heads/{branch}:{tracking}"));
    args
}

/// `--onto` the fetched tip from the fork point; plain `rebase` without one.
fn rebase_args(fork: Option<&str>, tmp: &str) -> Vec<String> {
    match fork {
        Some(fork) => vec!["rebase".into(), "--onto".into(), tmp.into(), fork.into()],
        None => vec!["rebase".into(), tmp.into()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_writes_both_refs_and_can_skip_fetch_head() {
        let tmp = "refs/xdev/rebase/x";
        let args = fetch_args("origin", "main", "refs/remotes/origin/main", tmp, true);
        assert_eq!(
            args,
            [
                "fetch",
                "--no-write-fetch-head",
                "origin",
                "+refs/heads/main:refs/xdev/rebase/x",
                "+refs/heads/main:refs/remotes/origin/main",
            ]
        );
        let args = fetch_args("origin", "main", "refs/remotes/origin/main", tmp, false);
        assert!(!args.iter().any(|a| a == "--no-write-fetch-head"));
        assert_eq!(args.len(), 4);
    }

    #[test]
    fn rebase_uses_the_fork_point_when_there_is_one() {
        assert_eq!(
            rebase_args(Some("abc"), "refs/xdev/rebase/x"),
            ["rebase", "--onto", "refs/xdev/rebase/x", "abc"]
        );
        assert_eq!(
            rebase_args(None, "refs/xdev/rebase/x"),
            ["rebase", "refs/xdev/rebase/x"]
        );
    }

    #[test]
    fn temp_refs_differ() {
        assert_ne!(temp_ref(), temp_ref());
        assert!(temp_ref().starts_with("refs/xdev/rebase/"));
    }
}
