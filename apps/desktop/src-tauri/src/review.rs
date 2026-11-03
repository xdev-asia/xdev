//! The Review tab's commands: every change of a checkout against a base the
//! person picks, one file's two sides against that base, whole-file stage
//! and unstage, and the branches a base can be picked from.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use xdev_git::{ChangeKind, Repo};
use xdev_workspace::{Registry, WorkspaceError, path_key};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::workspace::{WorktreeFileDiff, bad_arg, file_diff_at, inside, parent_within};

/// The most branches the base picker lists.
const MAX_BRANCHES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum ReviewBaseKind {
    /// The worktree's start commit, or `HEAD` for the primary checkout.
    Start,
    /// A branch, ref or commit the person named.
    Ref,
}

/// What the old side is read at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ReviewBase {
    pub kind: ReviewBaseKind,
    /// The name the person picked; `None` for the start.
    pub name: Option<String>,
    /// The full commit id the old side is read at.
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub path: String,
    pub kind: ChangeKind,
    /// The index differs from `HEAD`.
    pub staged: bool,
    /// The disk differs from the index, or the file is untracked.
    pub unstaged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ReviewData {
    pub base: ReviewBase,
    /// The checked-out branch; `None` when `HEAD` is detached.
    pub branch: Option<String>,
    /// The repo's base ref, offered first in the picker.
    pub base_ref: String,
    pub files: Vec<ReviewFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ReviewBranch {
    pub name: String,
    pub remote: bool,
}

/// A checkout the registry knows: its start commit (`None` for a primary
/// checkout) and its repo's base ref.
fn known(data: &Path, path: &Path) -> Result<(Option<String>, String), CmdError> {
    let key = path_key(path);
    let reg = Registry::load(data)?;
    if let Some(m) = reg.worktrees.iter().find(|m| path_key(&m.path) == key) {
        let base_ref = reg
            .repos
            .iter()
            .find(|r| r.id == m.repo_id)
            .map(|r| r.base_ref.clone())
            .unwrap_or_default();
        return Ok((Some(m.start.clone()), base_ref));
    }
    if let Some(r) = reg.repos.iter().find(|r| path_key(&r.path) == key) {
        return Ok((None, r.base_ref.clone()));
    }
    Err(WorkspaceError::WorktreeUnknown(path.to_owned()).into())
}

fn bad_ref(name: &str) -> CmdError {
    WorkspaceError::BadRef(name.to_owned()).into()
}

fn is_hex_id(id: &str) -> bool {
    (4..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The base to compare with: the start as is, or the merge base of the
/// named ref and `HEAD`, so a base that moved on hides its own changes.
fn resolve_base(
    repo: &Repo,
    start: Option<String>,
    base: Option<&str>,
) -> Result<ReviewBase, CmdError> {
    let Some(name) = base else {
        let id = match start {
            Some(id) => id,
            None => repo.head_id()?.ok_or_else(|| bad_ref("HEAD"))?,
        };
        return Ok(ReviewBase {
            kind: ReviewBaseKind::Start,
            name: None,
            id,
        });
    };
    // `resolve_ref` refuses option-like names itself; its error is git's.
    let id = match repo.resolve_ref(name) {
        Ok(Some(_)) => repo.merge_base(name, "HEAD")?,
        Ok(None) | Err(xdev_git::GitError::BadId(_)) => None,
        Err(e) => return Err(e.into()),
    }
    .ok_or_else(|| bad_ref(name))?;
    Ok(ReviewBase {
        kind: ReviewBaseKind::Ref,
        name: Some(name.to_owned()),
        id,
    })
}

fn review(data: &Path, path: &Path, base: Option<&str>) -> Result<ReviewData, CmdError> {
    let (start, base_ref) = known(data, path)?;
    let repo = Repo::discover(path)?;
    let base = resolve_base(&repo, start, base)?;
    let states = repo.stage_state()?;
    let files = repo
        .changes_since(&base.id)?
        .into_iter()
        .map(|c| {
            let state = states.iter().find(|s| s.path == c.path);
            ReviewFile {
                staged: state.is_some_and(|s| s.staged),
                unstaged: state.is_some_and(|s| s.unstaged),
                path: c.path,
                kind: c.kind,
            }
        })
        .collect();
    Ok(ReviewData {
        base,
        branch: repo.current_branch()?,
        base_ref,
        files,
    })
}

fn review_file(
    data: &Path,
    path: &Path,
    base: &str,
    file: &str,
) -> Result<WorktreeFileDiff, CmdError> {
    known(data, path)?;
    // Only an id from `review`, so a name is never read as a rev expression.
    if !is_hex_id(base) {
        return Err(bad_ref(base));
    }
    file_diff_at(path, file, &base.to_ascii_lowercase())
}

fn stage(data: &Path, path: &Path, files: &[String], staged: bool) -> Result<(), CmdError> {
    known(data, path)?;
    for file in files {
        let disk = inside(path, file).ok_or_else(|| bad_arg(file))?;
        if !parent_within(path, &disk)? {
            return Err(bad_arg(file));
        }
    }
    let repo = Repo::discover(path)?;
    if staged {
        repo.stage(files)?;
    } else {
        repo.unstage_to_head(files)?;
    }
    Ok(())
}

fn branches(data: &Path, path: &Path) -> Result<Vec<ReviewBranch>, CmdError> {
    known(data, path)?;
    Ok(Repo::discover(path)?
        .branches(MAX_BRANCHES)?
        .into_iter()
        .map(|b| ReviewBranch {
            name: b.name,
            remote: b.remote,
        })
        .collect())
}

/// Read-only: loads the registry without the save lock.
#[tauri::command(async)]
pub fn worktree_review(
    state: State<'_, AppState>,
    path: PathBuf,
    base: Option<String>,
) -> Result<ReviewData, CmdError> {
    review(data_dir(&state)?, &path, base.as_deref())
}

#[tauri::command(async)]
pub fn worktree_review_file(
    state: State<'_, AppState>,
    path: PathBuf,
    base: String,
    file: String,
) -> Result<WorktreeFileDiff, CmdError> {
    review_file(data_dir(&state)?, &path, &base, &file)
}

#[tauri::command(async)]
pub fn worktree_stage(
    state: State<'_, AppState>,
    path: PathBuf,
    files: Vec<String>,
    staged: bool,
) -> Result<(), CmdError> {
    stage(data_dir(&state)?, &path, &files, staged)
}

#[tauri::command(async)]
pub fn worktree_branches(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<Vec<ReviewBranch>, CmdError> {
    branches(data_dir(&state)?, &path)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use tempfile::TempDir;
    use xdev_workspace::{Registry, add_repo, create_worktree};

    use super::*;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap()
    }

    struct Fixture {
        _tmp: TempDir,
        main: PathBuf,
        data: PathBuf,
        wt: PathBuf,
        start: String,
    }

    /// A repo on `main` with `a.txt`, registered, with one worktree made
    /// from it.
    fn fixture() -> Fixture {
        let tmp = crate::test_dirs::long_temp_dir("review cmd ");
        let main = tmp.path().join("main");
        let data = tmp.path().join("data");
        fs::create_dir(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&main, &["config", key, value]);
        }
        fs::write(main.join("a.txt"), "one\n").unwrap();
        git(&main, &["add", "-A"]);
        git(&main, &["commit", "-q", "-m", "one"]);
        let start = git(&main, &["rev-parse", "HEAD"]).trim().to_owned();

        let mut reg = Registry::load(&data).unwrap();
        let id = add_repo(&mut reg, &main, 0).unwrap().id;
        let wt = create_worktree(&mut reg, &id, "first", None, 1, 1).unwrap();
        reg.save(&data).unwrap();
        Fixture {
            _tmp: tmp,
            main,
            data,
            wt: PathBuf::from(wt.path),
            start,
        }
    }

    fn commit(dir: &Path, file: &str, content: &str, message: &str) -> String {
        fs::write(dir.join(file), content).unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", message]);
        git(dir, &["rev-parse", "HEAD"]).trim().to_owned()
    }

    fn paths(r: &ReviewData) -> Vec<&str> {
        r.files.iter().map(|f| f.path.as_str()).collect()
    }

    fn code<T: std::fmt::Debug>(r: Result<T, CmdError>) -> &'static str {
        r.unwrap_err().code
    }

    #[test]
    fn review_defaults_to_start() {
        let fx = fixture();
        commit(&fx.wt, "b.txt", "b\n", "b");
        fs::write(fx.wt.join("c.txt"), "c\n").unwrap();
        let r = review(&fx.data, &fx.wt, None).unwrap();
        assert_eq!(r.base.kind, ReviewBaseKind::Start);
        assert_eq!(r.base.id, fx.start);
        assert_eq!(paths(&r), ["b.txt", "c.txt"]);
        assert_eq!(r.base_ref, "main");
        assert!(r.branch.is_some());
    }

    #[test]
    fn review_primary_uses_head() {
        let fx = fixture();
        fs::write(fx.main.join("a.txt"), "two\n").unwrap();
        let r = review(&fx.data, &fx.main, None).unwrap();
        assert_eq!(r.base.id, fx.start);
        assert_eq!(paths(&r), ["a.txt"]);
        assert_eq!(r.branch.as_deref(), Some("main"));
    }

    #[test]
    fn review_branch_base_uses_merge_base() {
        let fx = fixture();
        // `main` moves on after the worktree forked: its own change must not show.
        commit(&fx.main, "m.txt", "m\n", "main moves");
        commit(&fx.wt, "b.txt", "b\n", "b");
        let r = review(&fx.data, &fx.wt, Some("main")).unwrap();
        assert_eq!(r.base.kind, ReviewBaseKind::Ref);
        assert_eq!(r.base.name.as_deref(), Some("main"));
        assert_eq!(r.base.id, fx.start);
        assert_eq!(paths(&r), ["b.txt"]);
    }

    #[test]
    fn review_commit_base() {
        let fx = fixture();
        let b = commit(&fx.wt, "b.txt", "b\n", "b");
        commit(&fx.wt, "c.txt", "c\n", "c");
        let r = review(&fx.data, &fx.wt, Some(&b[..10])).unwrap();
        assert_eq!(r.base.id, b);
        assert_eq!(paths(&r), ["c.txt"]);
    }

    #[test]
    fn review_refuses_option_like_ref() {
        let fx = fixture();
        assert_eq!(code(review(&fx.data, &fx.wt, Some("--x"))), "bad_ref");
        assert_eq!(code(review(&fx.data, &fx.wt, Some("-p"))), "bad_ref");
    }

    #[test]
    fn review_unknown_ref() {
        let fx = fixture();
        assert_eq!(code(review(&fx.data, &fx.wt, Some("nope"))), "bad_ref");
    }

    #[test]
    fn review_unknown_checkout() {
        let fx = fixture();
        let other = fx._tmp.path().join("other");
        fs::create_dir(&other).unwrap();
        assert_eq!(code(review(&fx.data, &other, None)), "worktree_unknown");
    }

    #[test]
    fn review_marks_stage_state() {
        let fx = fixture();
        fs::write(fx.wt.join("a.txt"), "two\n").unwrap();
        fs::write(fx.wt.join("n.txt"), "n\n").unwrap();
        git(&fx.wt, &["add", "a.txt"]);
        let r = review(&fx.data, &fx.wt, None).unwrap();
        let a = r.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert!(a.staged && !a.unstaged);
        let n = r.files.iter().find(|f| f.path == "n.txt").unwrap();
        assert!(!n.staged && n.unstaged);
        assert_eq!(n.kind, ChangeKind::Added);
    }

    #[test]
    fn review_file_reads_both_sides_at_base() {
        let fx = fixture();
        let b = commit(&fx.wt, "a.txt", "two\n", "two");
        fs::write(fx.wt.join("a.txt"), "three\n").unwrap();
        let at_start = review_file(&fx.data, &fx.wt, &fx.start, "a.txt").unwrap();
        assert_eq!(at_start.old.as_deref(), Some("one\n"));
        assert_eq!(at_start.new.as_deref(), Some("three\n"));
        let at_b = review_file(&fx.data, &fx.wt, &b, "a.txt").unwrap();
        assert_eq!(at_b.old.as_deref(), Some("two\n"));
    }

    #[test]
    fn review_file_refuses_non_id_base() {
        let fx = fixture();
        assert_eq!(
            code(review_file(&fx.data, &fx.wt, "main", "a.txt")),
            "bad_ref"
        );
        assert_eq!(
            code(review_file(&fx.data, &fx.wt, "HEAD~1", "a.txt")),
            "bad_ref"
        );
        assert_eq!(
            code(review_file(&fx.data, &fx.wt, &fx.start, "../x")),
            "bad_arg"
        );
    }

    #[test]
    fn stage_then_unstage_round_trip() {
        let fx = fixture();
        fs::write(fx.wt.join("a.txt"), "two\n").unwrap();
        let files = vec!["a.txt".to_owned()];
        stage(&fx.data, &fx.wt, &files, true).unwrap();
        let a = review(&fx.data, &fx.wt, None).unwrap().files.remove(0);
        assert!(a.staged && !a.unstaged);
        stage(&fx.data, &fx.wt, &files, false).unwrap();
        let a = review(&fx.data, &fx.wt, None).unwrap().files.remove(0);
        assert!(!a.staged && a.unstaged);
    }

    #[test]
    fn stage_refuses_path_outside_worktree() {
        let fx = fixture();
        for file in ["../x", "", "a/../../x"] {
            let r = stage(&fx.data, &fx.wt, &[file.to_owned()], true);
            assert_eq!(code(r), "bad_arg", "{file}");
        }
    }

    #[test]
    fn branches_lists_the_repo_branches() {
        let fx = fixture();
        let list = branches(&fx.data, &fx.wt).unwrap();
        assert!(list.iter().any(|b| b.name == "main" && !b.remote));
    }
}
