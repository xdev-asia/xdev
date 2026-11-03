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

impl Repo {
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
        Ok(Some(Upstream {
            remote,
            branch: merge
                .strip_prefix("refs/heads/")
                .unwrap_or(&merge)
                .to_owned(),
            id,
            ahead,
            behind,
        }))
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
        self.current_branch()?.ok_or(GitError::Detached)?;
        let up = self.upstream()?.ok_or(GitError::NoUpstream)?;
        // The upstream's own remote and branch name; the branch may be
        // called differently there.
        let remote = plain_remote(up.remote)?;
        let branch = format!("refs/heads/{}", up.branch);
        let out = run::run_long(&self.workdir, &["pull", "--ff-only", &remote, &branch])?;
        if out.status == Some(0) {
            return Ok(());
        }
        // The message is translated, so the history decides first: the pull
        // fetched before it failed, and a branch with commits on both sides
        // cannot fast-forward.
        let split = matches!(self.upstream(), Ok(Some(u)) if u.ahead > 0 && u.behind > 0);
        if split || text(&out.stderr).contains("Not possible to fast-forward") {
            return Err(GitError::Diverged);
        }
        Err(failed("pull --ff-only", &out))
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
fn plain_remote(name: String) -> Result<String, GitError> {
    if name.starts_with('-') || name.chars().any(char::is_control) {
        return Err(GitError::BadId(name));
    }
    Ok(name)
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_owned()
}

fn failed(args: &str, out: &Output) -> GitError {
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
