use std::io;
use std::path::Path;

use crate::{GitError, Repo, run};

/// One line of `git diff --numstat`. Binary files have no line counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumStat {
    pub path: String,
    pub added: Option<u64>,
    pub removed: Option<u64>,
}

impl Repo {
    /// The branch `HEAD` is on, or `None` when it is detached.
    pub fn current_branch(&self) -> Result<Option<String>, GitError> {
        let (status, out) = run::run_status(
            &self.workdir,
            &["symbolic-ref", "-q", "--short", "HEAD"],
            None,
        )?;
        Ok((status == Some(0)).then(|| String::from_utf8_lossy(&out).trim().to_owned()))
    }

    /// No tracked file differs from `HEAD`, in the index or on disk, across
    /// the whole repo. Untracked files do not count: a merge that would
    /// overwrite one fails on its own.
    pub fn is_clean(&self) -> Result<bool, GitError> {
        let out = run::run(
            &self.workdir,
            &["status", "--porcelain", "--untracked-files=no"],
            None,
        )?;
        Ok(out.iter().all(u8::is_ascii_whitespace))
    }

    /// `git worktree add -b <branch> <path> <base>`.
    pub fn add_worktree(&self, path: &Path, branch: &str, base: &str) -> Result<(), GitError> {
        let path = utf8(path)?;
        run::run(
            &self.workdir,
            &["worktree", "add", "-q", "-b", branch, path, base],
            None,
        )
        .map(drop)
    }

    /// Removes a worktree even with changes in it. A folder already gone is
    /// only pruned from git's list.
    pub fn remove_worktree(&self, path: &Path) -> Result<(), GitError> {
        if path.exists() {
            run::run(
                &self.workdir,
                &["worktree", "remove", "--force", utf8(path)?],
                None,
            )?;
        }
        run::run(&self.workdir, &["worktree", "prune"], None).map(drop)
    }

    /// Deletes a local branch whether or not it is merged; a missing branch
    /// is not an error.
    pub fn delete_branch(&self, branch: &str) -> Result<(), GitError> {
        let full = format!("refs/heads/{branch}");
        let (status, _) =
            run::run_status(&self.workdir, &["rev-parse", "-q", "--verify", &full], None)?;
        if status != Some(0) {
            return Ok(());
        }
        run::run(&self.workdir, &["branch", "-D", branch], None).map(drop)
    }

    /// Commits every change in the work tree, new files included, and
    /// returns the new `HEAD`, or `None` when nothing changed. Hooks are
    /// skipped: this records what an agent left, and a hook that rejects it
    /// would lose that record.
    pub fn commit_all(&self, message: &str) -> Result<Option<String>, GitError> {
        run::run(&self.workdir, &["add", "-A"], None)?;
        let (status, _) = run::run_status(&self.workdir, &["diff", "--cached", "--quiet"], None)?;
        if status == Some(0) {
            return Ok(None);
        }
        let (status, _) = run::run_status(&self.workdir, &["var", "GIT_AUTHOR_IDENT"], None)?;
        if status != Some(0) {
            return Err(GitError::Identity);
        }
        run::run(
            &self.workdir,
            &["commit", "-q", "--no-verify", "-F", "-"],
            Some(message.as_bytes()),
        )?;
        self.head()
    }

    /// Files changed between two commits, renames shown as delete plus add.
    pub fn diff_numstat(&self, base: &str, head: &str) -> Result<Vec<NumStat>, GitError> {
        let range = format!("{base}..{head}");
        let out = run::run(
            &self.workdir,
            &["diff", "--numstat", "-z", "--no-renames", &range],
            None,
        )?;
        Ok(parse_numstat(&out))
    }

    /// `git merge --no-ff` of `branch` into the current branch; returns the
    /// merge commit. On a conflict the merge is aborted and `None` returned,
    /// so the repo is as it was.
    pub fn merge_no_ff(&self, branch: &str, message: &str) -> Result<Option<String>, GitError> {
        let args = ["merge", "--no-ff", "-q", "-m", message, branch];
        let (status, _) = run::run_status(&self.workdir, &args, None)?;
        if status == Some(0) {
            return self.head();
        }
        // Git's messages are translated; a pending `MERGE_HEAD` is what tells
        // a conflict apart from a merge that never started.
        let (pending, _) = run::run_status(
            &self.workdir,
            &["rev-parse", "-q", "--verify", "MERGE_HEAD"],
            None,
        )?;
        if pending == Some(0) {
            run::run(&self.workdir, &["merge", "--abort"], None)?;
            return Ok(None);
        }
        Err(GitError::Failed {
            args: args.join(" "),
            status,
            stderr: String::new(),
        })
    }
}

fn utf8(path: &Path) -> Result<&str, GitError> {
    path.to_str().ok_or_else(|| {
        GitError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path is not UTF-8",
        ))
    })
}

/// `-z` output: `added<TAB>removed<TAB>path<NUL>`, `-` for binary counts.
pub(crate) fn parse_numstat(out: &[u8]) -> Vec<NumStat> {
    out.split(|b| *b == 0)
        .filter(|rec| !rec.is_empty())
        .filter_map(|rec| {
            let rec = String::from_utf8_lossy(rec);
            let mut parts = rec.splitn(3, '\t');
            let added = parts.next()?;
            let removed = parts.next()?;
            let path = parts.next()?;
            Some(NumStat {
                path: path.to_owned(),
                added: added.parse().ok(),
                removed: removed.parse().ok(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_counts_binary_and_odd_names() {
        let out = b"3\t1\tsrc/a b.rs\x00-\t-\timg.png\x000\t2\ttab\there.txt\x00";
        assert_eq!(
            parse_numstat(out),
            vec![
                NumStat {
                    path: "src/a b.rs".into(),
                    added: Some(3),
                    removed: Some(1),
                },
                NumStat {
                    path: "img.png".into(),
                    added: None,
                    removed: None,
                },
                NumStat {
                    path: "tab\there.txt".into(),
                    added: Some(0),
                    removed: Some(2),
                },
            ]
        );
    }

    #[test]
    fn empty_output_is_no_files() {
        assert!(parse_numstat(b"").is_empty());
    }
}
