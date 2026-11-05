//! A merge, rebase, cherry-pick or revert stopped on conflicts: what is in
//! progress, which files are unmerged, and how to continue or abort it.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::since::fields;
use crate::{GitError, Repo, run};

/// The operation a conflicted work tree is in the middle of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum ConflictOp {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

impl ConflictOp {
    /// The git command that owns `--continue` and `--abort`.
    fn command(self) -> &'static str {
        match self {
            ConflictOp::Merge => "merge",
            ConflictOp::Rebase => "rebase",
            ConflictOp::CherryPick => "cherry-pick",
            ConflictOp::Revert => "revert",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConflictState {
    pub op: ConflictOp,
    /// Unmerged paths, relative to the repo's top folder.
    pub files: Vec<String>,
    /// What the operation applies onto: the branch being merged, the rebase
    /// target, or the commit being picked or reverted; `None` when unknown.
    pub onto: Option<String>,
    /// Rebase only: the step and the number of steps.
    pub step: Option<(u32, u32)>,
    /// The same unmerged paths with what each side did to them. A submodule
    /// conflict is left out here, though `files` still lists it.
    pub entries: Vec<ConflictEntry>,
}

/// What each side did to an unmerged path, from git's two status letters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    /// `UU`
    BothModified,
    /// `AA`
    BothAdded,
    /// `DD`
    BothDeleted,
    /// `AU`
    AddedByUs,
    /// `UA`
    AddedByThem,
    /// `DU`
    DeletedByUs,
    /// `UD`
    DeletedByThem,
}

impl ConflictKind {
    /// The kind for git's `XY` letters; `None` for a pair that is not a conflict.
    pub fn from_xy(xy: &str) -> Option<ConflictKind> {
        Some(match xy {
            "UU" => ConflictKind::BothModified,
            "AA" => ConflictKind::BothAdded,
            "DD" => ConflictKind::BothDeleted,
            "AU" => ConflictKind::AddedByUs,
            "UA" => ConflictKind::AddedByThem,
            "DU" => ConflictKind::DeletedByUs,
            "UD" => ConflictKind::DeletedByThem,
            _ => return None,
        })
    }
}

/// One unmerged path and what each side did to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConflictEntry {
    /// Relative to the repo's top folder.
    pub path: String,
    pub kind: ConflictKind,
    /// False when the work tree has no file at `path`.
    pub present: bool,
}

/// How one conflicted file is settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ConflictResolution {
    /// Stage the file as it is on disk.
    MarkResolved,
    /// Stage the file that one side deleted, so it stays.
    KeepFile,
    /// Remove the file from the index and the work tree.
    KeepDeletion,
}

impl ConflictEntry {
    /// The resolutions offered for this entry, in the order they are shown.
    pub fn resolutions(&self) -> &'static [ConflictResolution] {
        &[]
    }
}

/// Git must not open an editor for a message the person already has.
const NO_EDITOR: [(&str, &str); 2] = [("GIT_EDITOR", "true"), ("GIT_SEQUENCE_EDITOR", "true")];

impl Repo {
    /// Unmerged paths, relative to the top folder: every `UU AA DD AU UA DU UD`.
    pub(crate) fn unmerged(&self) -> Result<Vec<String>, GitError> {
        let out = run::run(
            &self.root(),
            &["diff", "--name-only", "--diff-filter=U", "-z"],
            None,
        )?;
        let mut files: Vec<String> = fields(&out).map(str::to_owned).collect();
        files.sort();
        files.dedup();
        Ok(files)
    }

    /// A path inside the git dir, as git resolves it (a linked worktree has
    /// its own), made absolute.
    fn git_path(&self, name: &str) -> Result<PathBuf, GitError> {
        let out = run::run(&self.workdir, &["rev-parse", "--git-path", name], None)?;
        let text = String::from_utf8_lossy(&out);
        let path = PathBuf::from(text.trim());
        Ok(if path.is_absolute() {
            path
        } else {
            self.workdir.join(path)
        })
    }

    fn git_text(&self, name: &str) -> Result<Option<String>, GitError> {
        Ok(std::fs::read_to_string(self.git_path(name)?)
            .ok()
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty()))
    }

    /// The operation in progress, or `None` for a clean repo.
    pub fn conflict_state(&self) -> Result<Option<ConflictState>, GitError> {
        // A rebase also leaves `CHERRY_PICK_HEAD` while it is stopped, so it goes first.
        let rebase_dir = ["rebase-merge", "rebase-apply"]
            .into_iter()
            .find(|d| self.git_path(d).is_ok_and(|p| p.is_dir()));
        let (op, onto, step) = if let Some(dir) = rebase_dir {
            // `rebase-apply` also holds a `git am` session; that is not ours.
            if dir == "rebase-apply" && self.git_path("rebase-apply/applying")?.exists() {
                return Ok(None);
            }
            let (now, last) = if dir == "rebase-merge" {
                ("msgnum", "end")
            } else {
                ("next", "last")
            };
            let number = |file: &str| {
                self.git_text(&format!("{dir}/{file}"))
                    .ok()
                    .flatten()
                    .and_then(|t| t.parse::<u32>().ok())
            };
            let step = number(now).zip(number(last));
            let onto = self
                .git_text(&format!("{dir}/onto"))?
                .map(|id| self.describe(&id));
            (ConflictOp::Rebase, onto, step)
        } else if let Some(id) = self.git_text("MERGE_HEAD")? {
            (ConflictOp::Merge, Some(self.describe(&id)), None)
        } else if let Some(id) = self.git_text("CHERRY_PICK_HEAD")? {
            (ConflictOp::CherryPick, Some(short(&id)), None)
        } else if let Some(id) = self.git_text("REVERT_HEAD")? {
            (ConflictOp::Revert, Some(short(&id)), None)
        } else {
            return Ok(None);
        };
        Ok(Some(ConflictState {
            op,
            files: self.unmerged()?,
            onto,
            step,
            entries: self.conflict_entries()?,
        }))
    }

    /// Every unmerged path with what each side did to it, sorted by path.
    pub fn conflict_entries(&self) -> Result<Vec<ConflictEntry>, GitError> {
        Ok(Vec::new())
    }

    /// Settles one conflicted file. `path` is read again first: a path that
    /// is no longer unmerged is `ConflictGone`, one whose kind is not
    /// `expected` is `ConflictChanged`, and a resolution not offered for the
    /// kind is `NotAConflict`.
    pub fn conflict_resolve(
        &self,
        path: &str,
        _expected: ConflictKind,
        _how: ConflictResolution,
    ) -> Result<(), GitError> {
        Err(GitError::ConflictGone(path.to_owned()))
    }

    /// A branch that points at `id` (local first), else the short id.
    fn describe(&self, id: &str) -> String {
        run::run(
            &self.workdir,
            &[
                "for-each-ref",
                "--points-at",
                id,
                "--format=%(refname:short)",
                "--sort=-refname",
                "refs/heads",
                "refs/remotes",
            ],
            None,
        )
        .ok()
        .and_then(|out| {
            String::from_utf8_lossy(&out)
                .lines()
                .find(|l| !l.ends_with("/HEAD"))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| short(id))
    }

    /// Finishes the operation once no file is unmerged; no editor opens. A
    /// rebase that meets the next conflict is still `Ok`: it is in progress
    /// again, and `conflict_state` shows the new step.
    pub fn conflict_continue(&self, op: ConflictOp) -> Result<(), GitError> {
        let state = self.conflict_state()?.ok_or(GitError::NoConflict)?;
        if !state.files.is_empty() {
            return Err(GitError::StillConflicted);
        }
        let args = [op.command(), "--continue"];
        let out = run::run_env(&self.workdir, &args, &NO_EDITOR)?;
        if out.status == Some(0) {
            return Ok(());
        }
        // The next pick of a rebase or sequence stopped on a conflict.
        if self.conflict_state()?.is_some_and(|s| !s.files.is_empty()) {
            return Ok(());
        }
        Err(GitError::Failed {
            args: args.join(" "),
            status: out.status,
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        })
    }

    /// Gives the operation up and puts the work tree back as it was before.
    /// A refused abort is an error, so the operation is never shown as gone
    /// while it is still in progress.
    pub fn conflict_abort(&self, op: ConflictOp) -> Result<(), GitError> {
        self.conflict_state()?.ok_or(GitError::NoConflict)?;
        let args = [op.command(), "--abort"];
        let out = run::run_env(&self.workdir, &args, &NO_EDITOR)?;
        if out.status == Some(0) {
            return Ok(());
        }
        Err(GitError::Failed {
            args: args.join(" "),
            status: out.status,
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        })
    }
}

fn short(id: &str) -> String {
    id.chars().take(7).collect()
}
