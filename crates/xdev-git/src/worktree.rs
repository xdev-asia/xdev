use std::io;
use std::path::{Path, PathBuf};

use crate::{GitError, Repo, run};

/// One line of `git diff --numstat`. Binary files have no line counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumStat {
    pub path: String,
    pub added: Option<u64>,
    pub removed: Option<u64>,
}

/// One entry of `git worktree list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: PathBuf,
    pub head: Option<String>,
    /// Without `refs/heads/`; `None` when detached or bare.
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    /// The folder is gone or no longer a worktree; `git worktree prune`
    /// would drop the entry.
    pub prunable: bool,
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

    /// `git branch -m old new`. The branch may be checked out.
    pub fn rename_branch(&self, old: &str, new: &str) -> Result<(), GitError> {
        run::run(&self.workdir, &["branch", "-m", "--", old, new], None).map(drop)
    }

    /// `user.name` as this repo sees it (its own config, then the global
    /// one), trimmed; `None` when unset or blank.
    pub fn user_name(&self) -> Result<Option<String>, GitError> {
        let (status, out) =
            run::run_status(&self.workdir, &["config", "--get", "user.name"], None)?;
        let name = String::from_utf8_lossy(&out).trim().to_owned();
        Ok((status == Some(0) && !name.is_empty()).then_some(name))
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

    /// Every worktree of the repo; the first entry is the primary checkout.
    pub fn list_worktrees(&self) -> Result<Vec<WorktreeEntry>, GitError> {
        let out = run::run(
            &self.workdir,
            &["worktree", "list", "--porcelain", "-z"],
            None,
        )?;
        Ok(parse_worktrees(&out))
    }

    /// `origin/<name>` when `refs/remotes/origin/HEAD` points at a branch
    /// that exists; else local `main`, then `master`; else the branch `HEAD`
    /// is on; else `None`.
    pub fn default_branch(&self) -> Result<Option<String>, GitError> {
        let (status, out) = run::run_status(
            &self.workdir,
            &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
            None,
        )?;
        if status == Some(0) {
            let target = String::from_utf8_lossy(&out).trim().to_owned();
            if let Some(name) = target.strip_prefix("refs/remotes/")
                && self.ref_exists(&target)?
            {
                return Ok(Some(name.to_owned()));
            }
        }
        for name in ["main", "master"] {
            if self.branch_exists(name)? {
                return Ok(Some(name.to_owned()));
            }
        }
        self.current_branch()
    }

    /// Whether a local branch of that name exists.
    pub fn branch_exists(&self, name: &str) -> Result<bool, GitError> {
        if name.is_empty() || name.chars().any(char::is_control) {
            return Ok(false);
        }
        self.ref_exists(&format!("refs/heads/{name}"))
    }

    /// Whether `name` can be a new branch name: git's own rules, and not
    /// something a command would read as an option or as `@{-1}`.
    pub fn valid_branch_name(&self, name: &str) -> Result<bool, GitError> {
        branch_name_ok(&self.workdir, name)
    }

    /// `full` is a complete ref name such as `refs/heads/x`.
    fn ref_exists(&self, full: &str) -> Result<bool, GitError> {
        let (status, _) =
            run::run_status(&self.workdir, &["rev-parse", "-q", "--verify", full], None)?;
        Ok(status == Some(0))
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

    /// `git worktree add <path> <branch>`: a worktree on a local branch
    /// that already exists.
    pub fn add_worktree_on(&self, path: &Path, branch: &str) -> Result<(), GitError> {
        if !self.branch_exists(branch)? || branch.starts_with('-') {
            return Err(GitError::BadId(branch.to_owned()));
        }
        let path = utf8(path)?;
        run::run(
            &self.workdir,
            &["worktree", "add", "-q", path, branch],
            None,
        )
        .map(drop)
    }

    /// Commits on local branch `branch` that `base` does not have; every
    /// commit on the branch when `base` names no commit.
    pub fn count_ahead(&self, branch: &str, base: &str) -> Result<u32, GitError> {
        let Some(tip) = self.resolve_ref(&format!("refs/heads/{branch}"))? else {
            return Err(GitError::BadId(branch.to_owned()));
        };
        let range = match self.resolve_ref(base) {
            Ok(Some(base)) => format!("{base}..{tip}"),
            Ok(None) | Err(GitError::BadId(_)) => tip,
            Err(e) => return Err(e),
        };
        let out = run::run(&self.workdir, &["rev-list", "--count", &range], None)?;
        let out = String::from_utf8_lossy(&out);
        out.trim().parse().map_err(|_| GitError::Failed {
            args: "rev-list --count".to_owned(),
            status: Some(0),
            stderr: out.trim().to_owned(),
        })
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

    /// `git worktree move`: a worktree to a new folder. Git moves into a
    /// folder that exists, as `mv` does, so one that is there is refused
    /// here instead of getting the worktree inside it.
    pub fn move_worktree(&self, from: &Path, to: &Path) -> Result<(), GitError> {
        if to.symlink_metadata().is_ok() {
            return Err(GitError::Io(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "the target folder exists",
            )));
        }
        run::run(
            &self.workdir,
            &["worktree", "move", utf8(from)?, utf8(to)?],
            None,
        )
        .map(drop)
    }

    /// Takes back a worktree this run just added and nothing was done in:
    /// git's record and the folder go, and a folder git cannot remove is
    /// deleted outright, since only this run ever wrote to it.
    pub fn remove_fresh_worktree(&self, path: &Path) -> Result<(), GitError> {
        if path.exists() && self.remove_worktree(path).is_err() {
            std::fs::remove_dir_all(path)?;
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

/// `Repo::valid_branch_name` for a branch that has no repo yet: git runs in
/// the temp folder, so no repo's own config is read.
pub fn valid_branch_name(name: &str) -> Result<bool, GitError> {
    branch_name_ok(&std::env::temp_dir(), name)
}

fn branch_name_ok(dir: &Path, name: &str) -> Result<bool, GitError> {
    if name.is_empty() || name.starts_with('-') || name.chars().any(char::is_control) {
        return Ok(false);
    }
    let (status, out) = run::run_status(dir, &["check-ref-format", "--branch", name], None)?;
    // `--branch` expands `@{-1}` to a branch name; a name that comes back
    // changed was not a plain name.
    Ok(status == Some(0) && String::from_utf8_lossy(&out).trim() == name)
}

/// The global `user.name`, trimmed; `None` when unset or blank. Run from
/// the temp folder, so no repo's own config is read.
pub fn global_user_name() -> Result<Option<String>, GitError> {
    let (status, out) = run::run_status(
        &std::env::temp_dir(),
        &["config", "--global", "--get", "user.name"],
        None,
    )?;
    let name = String::from_utf8_lossy(&out).trim().to_owned();
    Ok((status == Some(0) && !name.is_empty()).then_some(name))
}

fn utf8(path: &Path) -> Result<&str, GitError> {
    path.to_str().ok_or_else(|| {
        GitError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path is not UTF-8",
        ))
    })
}

/// `-z` output: one field per NUL (`worktree <path>`, `HEAD <id>`,
/// `branch refs/heads/x`, `detached`, `bare`, `locked [reason]`,
/// `prunable [reason]`), and an empty field after each entry.
fn parse_worktrees(out: &[u8]) -> Vec<WorktreeEntry> {
    let mut entries = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for field in out.split(|b| *b == 0) {
        let field = String::from_utf8_lossy(field);
        if field.is_empty() {
            entries.extend(current.take());
            continue;
        }
        let (key, value) = field.split_once(' ').unwrap_or((&field, ""));
        if key == "worktree" {
            entries.extend(current.take());
            current = Some(WorktreeEntry {
                path: PathBuf::from(value),
                head: None,
                branch: None,
                detached: false,
                bare: false,
                locked: false,
                prunable: false,
            });
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        match key {
            "HEAD" => entry.head = Some(value.to_owned()),
            "branch" => {
                entry.branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_owned(),
                );
            }
            "detached" => entry.detached = true,
            "bare" => entry.bare = true,
            "locked" => entry.locked = true,
            "prunable" => entry.prunable = true,
            _ => {}
        }
    }
    entries.extend(current);
    entries
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
    fn parses_worktree_records() {
        let out = b"worktree C:/r\0HEAD aaaa\0branch refs/heads/main\0\0\
                    worktree C:/w x\0HEAD bbbb\0detached\0locked why\0prunable gone\0\0\
                    worktree C:/bare\0bare\0\0";
        let list = parse_worktrees(out);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].path, PathBuf::from("C:/r"));
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[0].head.as_deref(), Some("aaaa"));
        assert_eq!(list[1].path, PathBuf::from("C:/w x"));
        assert!(list[1].detached && list[1].locked && list[1].prunable);
        assert_eq!(list[1].branch, None);
        assert!(list[2].bare && list[2].head.is_none());
        assert!(parse_worktrees(b"").is_empty());
    }

    #[test]
    fn empty_output_is_no_files() {
        assert!(parse_numstat(b"").is_empty());
    }
}
