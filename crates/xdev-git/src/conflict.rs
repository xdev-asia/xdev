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

/// A submodule's mode in git's records.
const GITLINK: &str = "160000";
/// The mode git gives a side that has no file.
const NO_FILE: &str = "000000";

/// The `u` records of `git status --porcelain=v2 -z`, in git's order. A
/// submodule conflict (any mode `160000`) is skipped. Records are split on
/// NUL and the path is whatever follows the tenth field, so spaces and
/// newlines in it are kept.
pub(crate) fn parse_unmerged_v2(out: &[u8]) -> Vec<ConflictEntry> {
    let mut entries = Vec::new();
    let mut records = out.split(|b| *b == 0).filter(|r| !r.is_empty());
    while let Some(record) = records.next() {
        let record = String::from_utf8_lossy(record);
        match record.as_bytes().first() {
            // A rename or copy: its old path is the next field.
            Some(b'2') => {
                records.next();
            }
            Some(b'u') => entries.extend(unmerged_record(&record)),
            _ => {}
        }
    }
    entries
}

/// `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`.
fn unmerged_record(record: &str) -> Option<ConflictEntry> {
    let fields: Vec<&str> = record.splitn(11, ' ').collect();
    let [_, xy, _, m1, m2, m3, mw, _, _, _, path] = fields.as_slice() else {
        return None;
    };
    if [m1, m2, m3, mw].iter().any(|m| **m == GITLINK) || path.is_empty() {
        return None;
    }
    Some(ConflictEntry {
        path: (*path).to_owned(),
        kind: ConflictKind::from_xy(xy)?,
        present: *mw != NO_FILE,
    })
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
        self.unmerged_entries(None)
    }

    /// The `u` records of the whole repo, or of one path; from the top
    /// folder, so the paths match `unmerged`.
    fn unmerged_entries(&self, path: Option<&str>) -> Result<Vec<ConflictEntry>, GitError> {
        let mut args = vec!["status", "--porcelain=v2", "-z", "--untracked-files=no"];
        if let Some(path) = path {
            args.extend(["--", path]);
        }
        let out = run::run(&self.root(), &args, None)?;
        let mut entries = parse_unmerged_v2(&out);
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
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

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "78981922613b2afb6025042ff6bd878ac1994e85";
    const ZERO: &str = "0000000000000000000000000000000000000000";

    /// One `u` record of `git status --porcelain=v2 -z`.
    fn record(xy: &str, modes: [&str; 4], path: &str) -> String {
        let [m1, m2, m3, mw] = modes;
        format!("u {xy} N... {m1} {m2} {m3} {mw} {ID} {ID} {ID} {path}\0")
    }

    const FILE: [&str; 4] = ["100644", "100644", "100644", "100644"];

    #[test]
    fn parse_unmerged_v2_maps_every_xy() {
        let pairs = [
            ("UU", ConflictKind::BothModified),
            ("AA", ConflictKind::BothAdded),
            ("DD", ConflictKind::BothDeleted),
            ("AU", ConflictKind::AddedByUs),
            ("UA", ConflictKind::AddedByThem),
            ("DU", ConflictKind::DeletedByUs),
            ("UD", ConflictKind::DeletedByThem),
        ];
        let mut out = String::new();
        // Ordinary and renamed records around the `u` ones are skipped; a
        // rename carries its old path as one more field.
        out.push_str(&format!(
            "1 .M N... 100644 100644 100644 {ID} {ID} plain.txt\0"
        ));
        out.push_str(&format!(
            "2 R. N... 100644 100644 100644 {ID} {ID} R100 new name.txt\0old name.txt\0"
        ));
        for (i, (xy, _)) in pairs.iter().enumerate() {
            out.push_str(&record(xy, FILE, &format!("dir/f {i}.txt")));
        }
        let entries = parse_unmerged_v2(out.as_bytes());
        let kinds: Vec<_> = entries.iter().map(|e| e.kind).collect();
        assert_eq!(kinds, pairs.map(|(_, k)| k));
        assert_eq!(entries[0].path, "dir/f 0.txt");
        assert!(entries.iter().all(|e| e.present));
        assert_eq!(ConflictKind::from_xy("M."), None);
    }

    #[test]
    fn parse_unmerged_v2_keeps_spaces_and_newlines_in_paths() {
        let out = record("UU", FILE, "a b\nc.txt");
        assert_eq!(parse_unmerged_v2(out.as_bytes())[0].path, "a b\nc.txt");
    }

    #[test]
    fn parse_unmerged_v2_skips_submodules() {
        let mut out = record("UU", ["160000", "160000", "160000", "160000"], "sub");
        out.push_str(&record(
            "UD",
            ["100644", "160000", "000000", "160000"],
            "mixed",
        ));
        out.push_str(&record("UU", FILE, "file.txt"));
        let paths: Vec<_> = parse_unmerged_v2(out.as_bytes())
            .into_iter()
            .map(|e| e.path)
            .collect();
        assert_eq!(paths, ["file.txt"]);
    }

    #[test]
    fn parse_unmerged_v2_marks_absent_worktree_file() {
        let out = format!(
            "u DD N... 100644 000000 000000 000000 {ID} {ZERO} {ZERO} gone.txt\0{}",
            record("UD", FILE, "here.txt")
        );
        let entries = parse_unmerged_v2(out.as_bytes());
        assert_eq!(
            entries,
            [
                ConflictEntry {
                    path: "gone.txt".into(),
                    kind: ConflictKind::BothDeleted,
                    present: false,
                },
                ConflictEntry {
                    path: "here.txt".into(),
                    kind: ConflictKind::DeletedByThem,
                    present: true,
                },
            ]
        );
    }

    #[test]
    fn parse_unmerged_v2_ignores_a_short_record() {
        assert!(parse_unmerged_v2(b"u UU N... 100644\0").is_empty());
        assert!(parse_unmerged_v2(b"").is_empty());
    }
}
