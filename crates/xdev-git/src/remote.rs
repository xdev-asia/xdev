use crate::history::is_commit_id;
use crate::run::{self, Output};
use crate::{Commit, GitError, Repo};

/// The branch's upstream and how far the two have drifted apart.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Upstream {
    pub remote: String,
    /// The branch name on the remote, without `refs/heads/`.
    pub branch: String,
    /// The commit the remote-tracking ref points at; `None` when that ref
    /// is gone (never fetched, or the remote branch was deleted).
    pub id: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Ahead and behind, and every commit only on the remote has a patch-equal copy in `HEAD`
    /// (`git rev-list --cherry-pick --right-only --no-merges HEAD...@{u}` is empty): the
    /// remote holds older copies of local commits, as after an amend.
    pub rewritten: bool,
}

/// What a branch adds to its base.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BaseRange {
    pub merge_base: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub added: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub removed: u64,
    /// Newest first, at most the caller's limit.
    pub commits: Vec<Commit>,
    pub truncated: bool,
}

/// What `refresh_local_base` did with the local copy of a base.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseRefresh {
    /// Fast-forwarded to the remote.
    Updated,
    /// Already at the remote.
    UpToDate,
    /// The base names no remote branch: a commit id, or a local branch
    /// without an upstream.
    NoRemote,
    /// The remote was fetched, but there is no local branch to move.
    NoLocal,
    /// The local branch has commits the remote does not; left alone.
    LocalCommits,
    /// The local branch is checked out with uncommitted changes; left alone.
    Dirty,
}

impl Repo {
    /// Fetches the remote branch behind `base` and fast-forwards the local
    /// branch of the same name to it. `base` is `<remote>/<branch>` (local
    /// `<branch>` is moved) or a local branch with an upstream. A local
    /// branch with its own commits, or checked out with changes, is never
    /// touched; a clean checkout of it is fast-forwarded in place.
    pub fn refresh_local_base(&self, base: &str) -> Result<BaseRefresh, GitError> {
        let Some((remote, remote_branch, local)) = self.base_source(base)? else {
            return Ok(BaseRefresh::NoRemote);
        };
        let spec = format!("refs/heads/{remote_branch}");
        // The configured refspec also moves `refs/remotes/<remote>/<branch>`.
        let out = run::run_long(&self.workdir, &["fetch", "-q", &remote, &spec])?;
        if out.status != Some(0) {
            return Err(failed("fetch", &out));
        }
        let fetched = self.resolve_ref("FETCH_HEAD")?.ok_or(GitError::NoRemote)?;
        let Some(current) = self.resolve_ref(&format!("refs/heads/{local}"))? else {
            return Ok(BaseRefresh::NoLocal);
        };
        if current == fetched {
            return Ok(BaseRefresh::UpToDate);
        }
        let (status, _) = run::run_status(
            &self.workdir,
            &["merge-base", "--is-ancestor", &current, &fetched],
            None,
        )?;
        if status != Some(0) {
            return Ok(BaseRefresh::LocalCommits);
        }
        let checkout = self
            .list_worktrees()?
            .into_iter()
            .find(|w| !w.prunable && w.branch.as_deref() == Some(local.as_str()));
        if let Some(checkout) = checkout {
            let there = Repo {
                workdir: checkout.path,
                prefix: String::new(),
            };
            if !there.is_clean()? {
                return Ok(BaseRefresh::Dirty);
            }
            let out = run::run_output(
                &there.workdir,
                &["merge", "--ff-only", "-q", &fetched],
                None,
            )?;
            if out.status != Some(0) {
                return Err(failed("merge --ff-only", &out));
            }
            return Ok(BaseRefresh::Updated);
        }
        let full = format!("refs/heads/{local}");
        run::run(
            &self.workdir,
            &["update-ref", &full, &fetched, &current],
            None,
        )?;
        Ok(BaseRefresh::Updated)
    }

    /// `(remote, branch on the remote, local branch)` behind a base, or
    /// `None` when it names no remote branch.
    fn base_source(&self, base: &str) -> Result<Option<(String, String, String)>, GitError> {
        if !self.valid_branch_name(base)? {
            return Ok(None);
        }
        if self.branch_exists(base)? {
            let remote = self.branch_config(base, "remote")?;
            let merge = self.branch_config(base, "merge")?;
            let (Some(remote), Some(merge)) = (remote, merge) else {
                return Ok(None);
            };
            let Some(branch) = merge.strip_prefix("refs/heads/") else {
                return Ok(None);
            };
            if remote == "." || !self.valid_branch_name(branch)? {
                return Ok(None);
            }
            return Ok(Some((
                plain_remote(remote)?,
                branch.to_owned(),
                base.to_owned(),
            )));
        }
        // The longest remote name wins: `a/b/c` with remotes `a` and `a/b`.
        let mut remotes = self.remote_names()?;
        remotes.sort_by_key(|r| std::cmp::Reverse(r.len()));
        for remote in remotes {
            let Some(branch) = base
                .strip_prefix(remote.as_str())
                .and_then(|rest| rest.strip_prefix('/'))
            else {
                continue;
            };
            if !self.valid_branch_name(branch)? {
                return Ok(None);
            }
            return Ok(Some((
                plain_remote(remote)?,
                branch.to_owned(),
                branch.to_owned(),
            )));
        }
        Ok(None)
    }

    /// The remote a branch pushes to: its own `branch.<name>.remote` when
    /// set, else `origin` when it exists, else the only remote.
    pub fn remote_for(&self, branch: &str) -> Result<String, GitError> {
        if !self.valid_branch_name(branch)? {
            return Err(GitError::BadId(branch.to_owned()));
        }
        match self.branch_config(branch, "remote")? {
            // `.` means "this repo" (a local upstream), not a remote.
            Some(remote) if remote != "." => plain_remote(remote),
            _ => self.default_remote(),
        }
    }

    /// The names of the configured remotes.
    pub fn remote_names(&self) -> Result<Vec<String>, GitError> {
        let out = run::run(&self.workdir, &["remote"], None)?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_owned)
            .collect())
    }

    fn default_remote(&self) -> Result<String, GitError> {
        let out = run::run(&self.workdir, &["remote"], None)?;
        let out = String::from_utf8_lossy(&out);
        let names: Vec<&str> = out
            .lines()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .collect();
        match names.as_slice() {
            [only] => plain_remote((*only).to_owned()),
            _ if names.contains(&"origin") => Ok("origin".to_owned()),
            _ => Err(GitError::NoRemote),
        }
    }

    /// `branch.<branch>.<name>` from the config; `None` when unset or empty.
    fn branch_config(&self, branch: &str, name: &str) -> Result<Option<String>, GitError> {
        let key = format!("branch.{branch}.{name}");
        let (status, out) = run::run_status(&self.workdir, &["config", "--get", &key], None)?;
        let value = String::from_utf8_lossy(&out).trim().to_owned();
        Ok((status == Some(0) && !value.is_empty()).then_some(value))
    }

    /// The upstream of the current branch, from `branch.<name>.remote` and
    /// `.merge`. `None` when `HEAD` is detached or unborn, or the branch has
    /// none. `ahead` and `behind` count against the remote-tracking ref as
    /// last fetched, and are 0 when that ref is gone.
    pub fn upstream(&self) -> Result<Option<Upstream>, GitError> {
        let Some(branch) = self.current_branch()? else {
            return Ok(None);
        };
        let (Some(remote), Some(merge)) = (
            self.branch_config(&branch, "remote")?,
            self.branch_config(&branch, "merge")?,
        ) else {
            return Ok(None);
        };
        if self.head()?.is_none() {
            return Ok(None);
        }

        let (status, out) = run::run_status(
            &self.workdir,
            &["rev-parse", "--verify", "-q", "@{u}^{commit}"],
            None,
        )?;
        let id = (status == Some(0)).then(|| text(&out));
        let (ahead, behind) = if id.is_some() {
            let out = run::run(
                &self.workdir,
                &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
                None,
            )?;
            parse_counts(&out)?
        } else {
            (0, 0)
        };
        let rewritten = ahead > 0 && behind > 0 && self.only_old_copies_remote()?;
        Ok(Some(Upstream {
            remote,
            branch: merge
                .strip_prefix("refs/heads/")
                .unwrap_or(&merge)
                .to_owned(),
            id,
            ahead,
            behind,
            rewritten,
        }))
    }

    /// Every commit only on the upstream has a patch-equal copy in `HEAD`.
    fn only_old_copies_remote(&self) -> Result<bool, GitError> {
        let out = run::run(
            &self.workdir,
            &[
                "rev-list",
                "--cherry-pick",
                "--right-only",
                "--no-merges",
                "HEAD...@{u}",
            ],
            None,
        )?;
        Ok(out.iter().all(u8::is_ascii_whitespace))
    }

    /// `HEAD` is already on the upstream (an ancestor of it, or equal).
    /// False without an upstream, or when its ref was never fetched.
    pub fn head_on_upstream(&self) -> Result<bool, GitError> {
        let (status, _) = run::run_status(
            &self.workdir,
            &["merge-base", "--is-ancestor", "HEAD", "@{u}"],
            None,
        )?;
        Ok(status == Some(0))
    }

    /// Pushes the current branch to the remote under the same name and sets
    /// it as the upstream. A refusal by the remote is `Rejected`.
    pub fn push(&self) -> Result<(), GitError> {
        let branch = self.current_branch()?.ok_or(GitError::Detached)?;
        let remote = self.remote_for(&branch)?;
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        self.push_with(&["push", "--porcelain", "--set-upstream", &remote, &refspec])
    }

    /// Fast-forwards the current branch to its upstream; never merges or
    /// rebases. Histories that split are `Diverged`.
    pub fn pull(&self) -> Result<(), GitError> {
        self.fast_forward()
    }

    /// Fetches the branch's remote. A detached `HEAD` uses `origin`, or the
    /// only remote.
    pub fn fetch(&self) -> Result<(), GitError> {
        let remote = match self.current_branch()? {
            Some(branch) => self.remote_for(&branch)?,
            None => self.default_remote()?,
        };
        let out = run::run_long(&self.workdir, &["fetch", &remote])?;
        if out.status == Some(0) {
            return Ok(());
        }
        Err(failed("fetch", &out))
    }

    /// Replaces the remote branch with the local one, but only while the
    /// remote still points at `expected`, the commit the person looked at.
    /// Someone else's push in between makes it `Rejected`. The caller owns
    /// the policy check; nothing here asks.
    pub fn force_push(&self, expected: &str) -> Result<(), GitError> {
        // Checked before git sees it, so `expected` can never be read as an
        // option or a rev expression.
        if !is_commit_id(expected) {
            return Err(GitError::BadId(expected.to_owned()));
        }
        let branch = self.current_branch()?.ok_or(GitError::Detached)?;
        let remote = self.remote_for(&branch)?;
        let lease = format!("--force-with-lease=refs/heads/{branch}:{expected}");
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        self.push_with(&["push", "--porcelain", &lease, &remote, &refspec])
    }

    fn push_with(&self, args: &[&str]) -> Result<(), GitError> {
        let out = run::run_long(&self.workdir, args)?;
        if out.status == Some(0) {
            return Ok(());
        }
        let stderr = text(&out.stderr);
        // `--porcelain` marks a refused ref with a leading `!`; the words
        // are translated, so they only back that up.
        let refused = text(&out.stdout).lines().any(|l| l.starts_with('!'))
            || ["[rejected]", "[remote rejected]", "stale info"]
                .iter()
                .any(|m| stderr.contains(m));
        if refused {
            let detail = if stderr.is_empty() {
                text(&out.stdout)
            } else {
                stderr
            };
            return Err(GitError::Rejected(detail));
        }
        Err(failed("push", &out))
    }

    /// What the current branch adds to `base`: the lines changed from the
    /// merge base to `HEAD`, and its commits, newest first, at most `limit`.
    pub fn branch_vs_base(&self, base: &str, limit: usize) -> Result<BaseRange, GitError> {
        let merge_base = self
            .merge_base(base, "HEAD")?
            .ok_or_else(|| GitError::BadId(base.to_owned()))?;
        let (mut added, mut removed) = (0, 0);
        // A binary file has no line counts and adds nothing.
        for stat in self.diff_numstat(&merge_base, "HEAD")? {
            added += stat.added.unwrap_or(0);
            removed += stat.removed.unwrap_or(0);
        }
        let (commits, total) = self.commits_since(&merge_base, &["**".to_owned()], limit)?;
        Ok(BaseRange {
            merge_base,
            added,
            removed,
            truncated: total > commits.len(),
            commits,
        })
    }
}

/// A remote name from the config; one that starts with `-` would be read
/// as an option.
pub(crate) fn plain_remote(name: String) -> Result<String, GitError> {
    if name.starts_with('-') || name.chars().any(char::is_control) {
        return Err(GitError::BadId(name));
    }
    Ok(name)
}

pub(crate) fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_owned()
}

pub(crate) fn failed(args: &str, out: &Output) -> GitError {
    GitError::Failed {
        args: args.to_owned(),
        status: out.status,
        stderr: text(&out.stderr),
    }
}

/// `rev-list --left-right --count` output: `<left><TAB><right>`.
fn parse_counts(out: &[u8]) -> Result<(u32, u32), GitError> {
    let out = text(out);
    let mut parts = out.split_whitespace().map(str::parse::<u32>);
    match (parts.next(), parts.next()) {
        (Some(Ok(ahead)), Some(Ok(behind))) => Ok((ahead, behind)),
        _ => Err(GitError::Failed {
            args: "rev-list --left-right --count".to_owned(),
            status: Some(0),
            stderr: out,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_counts() {
        assert_eq!(parse_counts(b"2\t5\n").unwrap(), (2, 5));
        assert!(parse_counts(b"").is_err());
        assert!(parse_counts(b"x\ty").is_err());
    }

    #[test]
    fn refuses_option_like_remote() {
        assert!(plain_remote("--all".into()).is_err());
        assert_eq!(plain_remote("up".into()).unwrap(), "up");
    }
}
