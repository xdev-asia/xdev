//! What the review view needs from git beyond the diff itself: the
//! branches a base can be picked from, whether each changed path is staged,
//! and staging or unstaging whole files.

use std::collections::BTreeMap;

use crate::since::fields;
use crate::{GitError, Repo, run};

/// A local or remote-tracking branch, by its short name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Branch {
    /// `main`, or `origin/main` for a remote-tracking branch.
    pub name: String,
    pub remote: bool,
    pub id: String,
}

/// Where a changed path stands against the index. Paths are relative to
/// the repo's top folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageState {
    pub path: String,
    /// The index differs from `HEAD`.
    pub staged: bool,
    /// The disk differs from the index, or the file is untracked.
    pub unstaged: bool,
    /// The path is not tracked at all (also counted in `unstaged`).
    pub untracked: bool,
}

impl Repo {
    /// Local then remote-tracking branches, newest commit first, at most
    /// `limit`. A remote's `HEAD` alias is left out.
    pub fn branches(&self, limit: usize) -> Result<Vec<Branch>, GitError> {
        let out = run::run(
            &self.workdir,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname)%00%(objectname)",
                "refs/heads",
                "refs/remotes",
            ],
            None,
        )?;
        let text = String::from_utf8_lossy(&out);
        Ok(text
            .lines()
            .filter_map(|line| {
                let (refname, id) = line.split_once('\0')?;
                let (name, remote) = if let Some(n) = refname.strip_prefix("refs/heads/") {
                    (n, false)
                } else {
                    (refname.strip_prefix("refs/remotes/")?, true)
                };
                if remote && (name.ends_with("/HEAD") || name == "HEAD") {
                    return None;
                }
                Some(Branch {
                    name: name.to_owned(),
                    remote,
                    id: id.to_owned(),
                })
            })
            .take(limit)
            .collect())
    }

    /// Every path that is staged, unstaged or untracked, sorted by path.
    pub fn stage_state(&self) -> Result<Vec<StageState>, GitError> {
        let top = self.root();
        let mut found: BTreeMap<String, StageState> = BTreeMap::new();
        let mut mark = |path: &str, staged: bool, untracked: bool| {
            let entry = found.entry(path.to_owned()).or_insert_with(|| StageState {
                path: path.to_owned(),
                staged: false,
                unstaged: false,
                untracked: false,
            });
            entry.untracked |= untracked;
            if staged {
                entry.staged = true;
            } else {
                entry.unstaged = true;
            }
        };
        // Before the first commit there is no `HEAD`: everything in the
        // index is staged.
        let cached: Vec<&str> = if self.head()?.is_some() {
            vec!["diff", "--cached", "--name-only", "-z", "--no-renames"]
        } else {
            vec!["ls-files", "--cached", "-z"]
        };
        let staged = run::run(&top, &cached, None)?;
        for path in fields(&staged) {
            mark(path, true, false);
        }
        let unstaged = run::run(&top, &["diff", "--name-only", "-z", "--no-renames"], None)?;
        for path in fields(&unstaged) {
            mark(path, false, false);
        }
        let untracked = run::run(
            &top,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            None,
        )?;
        for path in fields(&untracked) {
            mark(path, false, true);
        }
        Ok(found.into_values().collect())
    }

    /// Puts the disk content of `paths` (repo-relative) in the index; a
    /// deleted file stages its deletion.
    pub fn stage(&self, paths: &[String]) -> Result<(), GitError> {
        self.at_top(&["add", "-A"], paths)
    }

    /// Puts the index entry of `paths` back to `HEAD`, leaving the disk as
    /// it is. Before the first commit the paths leave the index instead.
    pub fn unstage_to_head(&self, paths: &[String]) -> Result<(), GitError> {
        if self.head()?.is_some() {
            self.at_top(&["restore", "--staged"], paths)
        } else {
            self.at_top(&["rm", "--cached", "-q", "--ignore-unmatch"], paths)
        }
    }

    /// Puts tracked `paths` back to the index version and deletes untracked ones.
    /// `staged_too`: also reset the index to `HEAD` first, so staged edits are lost as well.
    pub fn discard(&self, paths: &[String], staged_too: bool) -> Result<(), GitError> {
        let _ = (paths, staged_too);
        todo!("discard")
    }

    /// Runs `args -- paths` from the top folder; nothing at all without paths.
    fn at_top(&self, args: &[&str], paths: &[String]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut all = args.to_vec();
        all.push("--");
        all.extend(paths.iter().map(String::as_str));
        run::run(&self.root(), &all, None).map(drop)
    }
}
