//! What the review view needs from git beyond the diff itself: the
//! branches a base can be picked from, whether each changed path is staged,
//! and staging or unstaging whole files.

use std::collections::BTreeMap;
use std::path::Path;

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
    /// The path is unmerged: both sides changed it and no one resolved it.
    pub conflicted: bool,
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
                conflicted: false,
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
        if paths.is_empty() {
            return Ok(());
        }
        for path in paths {
            let escapes = path.is_empty()
                || Path::new(path).is_absolute()
                || path.split(['/', '\\']).any(|part| part == "..");
            if escapes {
                return Err(GitError::Failed {
                    args: "discard".to_owned(),
                    status: None,
                    stderr: format!("{path} is outside the repository"),
                });
            }
        }
        let states: BTreeMap<String, StageState> = self
            .stage_state()?
            .into_iter()
            .map(|s| (s.path.clone(), s))
            .collect();
        let has_head = self.head()?.is_some();
        // Paths git does not report (clean or ignored) are left alone.
        let mut wanted: Vec<String> = paths
            .iter()
            .filter(|p| states.contains_key(p.as_str()))
            .cloned()
            .collect();
        if staged_too && has_head {
            // A rename is two index entries; losing one side alone would
            // leave the other behind.
            let renames = self.staged_renames()?;
            for (old, new) in renames {
                if wanted.contains(&new) && !wanted.contains(&old) {
                    wanted.push(old);
                } else if wanted.contains(&old) && !wanted.contains(&new) {
                    wanted.push(new);
                }
            }
        }
        // A file on disk whose deletion is staged (`rm --cached`) is both
        // untracked and staged; with `staged_too` it goes back to `HEAD`
        // instead of being deleted.
        let untracked: Vec<String> = wanted
            .iter()
            .filter(|p| {
                states
                    .get(p.as_str())
                    .is_some_and(|s| s.untracked && !(staged_too && s.staged))
            })
            .cloned()
            .collect();
        let tracked: Vec<String> = wanted
            .iter()
            .filter(|p| !untracked.contains(p))
            .cloned()
            .collect();
        if !tracked.is_empty() {
            if staged_too {
                // Entries that `HEAD` does not have leave the index and the disk.
                let in_head = self.in_head(&tracked, has_head)?;
                let (known, added): (Vec<String>, Vec<String>) =
                    tracked.into_iter().partition(|p| in_head.contains(p));
                self.literal(
                    &["restore", "--staged", "--worktree", "--source=HEAD"],
                    &known,
                )?;
                self.literal(&["rm", "-f", "-q", "--ignore-unmatch"], &added)?;
            } else {
                // A file with only staged changes has nothing to discard, and
                // a staged deletion is not in the index for `restore` to find.
                let changed: Vec<String> = tracked
                    .into_iter()
                    .filter(|p| states.get(p.as_str()).is_some_and(|s| s.unstaged))
                    .collect();
                self.literal(&["restore", "--worktree"], &changed)?;
            }
        }
        // Never `-d`: only the files that were named.
        self.literal(&["clean", "-f", "-q"], &untracked)
    }

    /// `(old, new)` for each rename in the index, against `HEAD`.
    fn staged_renames(&self) -> Result<Vec<(String, String)>, GitError> {
        let out = run::run(
            &self.root(),
            &["diff", "--cached", "--name-status", "-M", "-z"],
            None,
        )?;
        let mut parts = fields(&out);
        let mut renames = Vec::new();
        while let Some(status) = parts.next() {
            if status.starts_with('R') || status.starts_with('C') {
                if let (Some(old), Some(new)) = (parts.next(), parts.next())
                    && status.starts_with('R')
                {
                    renames.push((old.to_owned(), new.to_owned()));
                }
            } else {
                parts.next();
            }
        }
        Ok(renames)
    }

    /// Which of `paths` are in `HEAD`.
    fn in_head(&self, paths: &[String], has_head: bool) -> Result<Vec<String>, GitError> {
        if !has_head {
            return Ok(Vec::new());
        }
        let mut args = vec![
            "--literal-pathspecs",
            "ls-tree",
            "-r",
            "--name-only",
            "-z",
            "HEAD",
            "--",
        ];
        args.extend(paths.iter().map(String::as_str));
        let out = run::run(&self.root(), &args, None)?;
        Ok(fields(&out).map(str::to_owned).collect())
    }

    /// `git --literal-pathspecs args -- paths` from the top folder; nothing without paths.
    fn literal(&self, args: &[&str], paths: &[String]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut all = vec!["--literal-pathspecs"];
        all.extend_from_slice(args);
        all.push("--");
        all.extend(paths.iter().map(String::as_str));
        run::run(&self.root(), &all, None).map(drop)
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
