//! The Review tab's commands: every change of a checkout against a base the
//! person picks, one file's two sides against that base, whole-file stage
//! and unstage, and the branches a base can be picked from.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use xdev_git::{ChangeKind, ConflictState, GitError, Repo};
use xdev_policy::{Action, Audited, Gate, Verdict};
use xdev_workspace::{Registry, WorkspaceError, path_key};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::tasks::gate;
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
    /// The commit `HEAD` is on; `None` in a repo without commits.
    pub head_oid: Option<String>,
    pub files: Vec<ReviewFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ReviewBranch {
    pub name: String,
    pub remote: bool,
}

/// Where one changed path stands against the index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StageState {
    pub path: String,
    /// The index differs from `HEAD`.
    pub staged: bool,
    /// The disk differs from the index, or the file is untracked.
    pub unstaged: bool,
    /// The file is not tracked at all.
    pub untracked: bool,
    /// Unmerged: a merge, rebase, cherry-pick or revert stopped on it.
    pub conflicted: bool,
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
        head_oid: repo.head_id()?,
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

fn stage_state(data: &Path, path: &Path) -> Result<Vec<StageState>, CmdError> {
    known(data, path)?;
    Ok(Repo::discover(path)?
        .stage_state()?
        .into_iter()
        .map(|s| StageState {
            path: s.path,
            staged: s.staged,
            unstaged: s.unstaged,
            untracked: s.untracked,
            conflicted: s.conflicted,
        })
        .collect())
}

fn discard(
    data: &Path,
    path: &Path,
    files: &[String],
    staged_too: bool,
    confirmed: bool,
) -> Result<(), CmdError> {
    known(data, path)?;
    for file in files {
        let disk = inside(path, file).ok_or_else(|| bad_arg(file))?;
        if !parent_within(path, &disk)? {
            return Err(bad_arg(file));
        }
    }
    let action = Action::Discard {
        worktree: path.to_owned(),
        paths: files.to_vec(),
    };
    match gate(data)?.check_confirmed(&action, confirmed) {
        Verdict::Allow => {}
        Verdict::Ask { reason } => {
            return Err(CmdError {
                code: "needs_approval",
                detail: Some(reason),
            });
        }
        Verdict::Deny { reason } => {
            return Err(CmdError {
                code: "denied",
                detail: Some(reason),
            });
        }
    }
    // Git's own error text reaches the person through `CmdError`; no retry.
    Repo::discover(path)?.discard(files, staged_too)?;
    Ok(())
}

fn conflicts(data: &Path, path: &Path) -> Result<Option<ConflictState>, CmdError> {
    known(data, path)?;
    Ok(Repo::discover(path)?.conflict_state()?)
}

fn conflict_continue(data: &Path, path: &Path) -> Result<(), CmdError> {
    known(data, path)?;
    let repo = Repo::discover(path)?;
    let state = repo.conflict_state()?.ok_or(GitError::NoConflict)?;
    // `still_conflicted` when a file is unmerged; git is not asked.
    repo.conflict_continue(state.op)?;
    Ok(())
}

/// Abort throws the resolution work in progress away, so it is a discard of
/// the unmerged files to the policy and needs the person's yes.
fn conflict_abort<G: Gate>(
    gate: &Audited<G>,
    data: &Path,
    path: &Path,
    confirmed: bool,
) -> Result<(), CmdError> {
    known(data, path)?;
    let repo = Repo::discover(path)?;
    // Nothing in progress is reported before anything is asked.
    let state = repo.conflict_state()?.ok_or(GitError::NoConflict)?;
    let action = Action::Discard {
        worktree: path.to_owned(),
        paths: state.files,
    };
    match gate.check_confirmed(&action, confirmed) {
        Verdict::Allow => {}
        Verdict::Ask { reason } => {
            return Err(CmdError {
                code: "needs_approval",
                detail: Some(reason),
            });
        }
        Verdict::Deny { reason } => {
            return Err(CmdError {
                code: "denied",
                detail: Some(reason),
            });
        }
    }
    repo.conflict_abort(state.op)?;
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

/// Throws away uncommitted changes. Always gated: `confirmed` is the person's yes.
#[tauri::command(async)]
pub fn worktree_discard(
    state: State<'_, AppState>,
    path: PathBuf,
    files: Vec<String>,
    staged_too: bool,
    confirmed: bool,
) -> Result<(), CmdError> {
    discard(data_dir(&state)?, &path, &files, staged_too, confirmed)
}

/// Read-only: where every changed path stands against the index.
#[tauri::command(async)]
pub fn worktree_stage_state(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<Vec<StageState>, CmdError> {
    stage_state(data_dir(&state)?, &path)
}

/// Read-only: the merge, rebase, cherry-pick or revert in progress, if any.
#[tauri::command(async)]
pub fn worktree_conflicts(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<Option<ConflictState>, CmdError> {
    conflicts(data_dir(&state)?, &path)
}

/// Finishes the operation in progress once no file is unmerged.
#[tauri::command(async)]
pub fn worktree_conflict_continue(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<(), CmdError> {
    conflict_continue(data_dir(&state)?, &path)
}

/// Gives the operation up. A discard of the resolution work in progress, so
/// gated and confirmed like `worktree_discard`.
#[tauri::command(async)]
pub fn worktree_conflict_abort(
    state: State<'_, AppState>,
    path: PathBuf,
    confirmed: bool,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    conflict_abort(&gate(data)?, data, &path, confirmed)
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
    fn review_reports_the_head_commit() {
        let fx = fixture();
        let head = commit(
            &fx.wt, "b.txt", "b
", "b",
        );
        let r = review(&fx.data, &fx.wt, None).unwrap();
        assert_eq!(r.head_oid.as_deref(), Some(head.as_str()));
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

    #[test]
    fn stage_state_lists_each_path() {
        let fx = fixture();
        fs::write(
            fx.wt.join("a.txt"),
            "two
",
        )
        .unwrap();
        fs::write(
            fx.wt.join("n.txt"),
            "n
",
        )
        .unwrap();
        stage(&fx.data, &fx.wt, &["a.txt".to_owned()], true).unwrap();
        let list = stage_state(&fx.data, &fx.wt).unwrap();
        let a = list.iter().find(|s| s.path == "a.txt").unwrap();
        assert!(a.staged && !a.unstaged && !a.untracked);
        let n = list.iter().find(|s| s.path == "n.txt").unwrap();
        assert!(!n.staged && n.unstaged && n.untracked);
        assert_eq!(
            code(stage_state(&fx.data, &fx.main.join("nope"))),
            "worktree_unknown"
        );
    }

    /// Makes `wt` stop in the middle of a merge of `topic` into its branch.
    fn merge_conflict(fx: &Fixture) {
        git(&fx.wt, &["checkout", "-q", "-b", "topic"]);
        fs::write(fx.wt.join("a.txt"), "topic\n").unwrap();
        git(&fx.wt, &["commit", "-q", "-am", "topic"]);
        git(&fx.wt, &["checkout", "-q", "-"]);
        fs::write(fx.wt.join("a.txt"), "mine\n").unwrap();
        git(&fx.wt, &["commit", "-q", "-am", "mine"]);
        let out = Command::new("git")
            .current_dir(&fx.wt)
            .args(["merge", "topic"])
            .output()
            .unwrap();
        assert!(!out.status.success());
    }

    struct FixedGate(Verdict);

    impl Gate for FixedGate {
        fn check(&self, _: &Action) -> Verdict {
            self.0.clone()
        }
    }

    #[test]
    fn conflicts_reports_the_operation_and_none_when_clean() {
        let fx = fixture();
        assert_eq!(conflicts(&fx.data, &fx.wt).unwrap(), None);
        merge_conflict(&fx);
        let state = conflicts(&fx.data, &fx.wt).unwrap().unwrap();
        assert_eq!(state.op, xdev_git::ConflictOp::Merge);
        assert_eq!(state.files, ["a.txt"]);
        assert_eq!(
            code(conflicts(&fx.data, &fx.main.join("nope"))),
            "worktree_unknown"
        );
    }

    #[test]
    fn stage_state_marks_the_conflicted_file() {
        let fx = fixture();
        merge_conflict(&fx);
        let list = stage_state(&fx.data, &fx.wt).unwrap();
        assert!(list.iter().find(|s| s.path == "a.txt").unwrap().conflicted);
    }

    #[test]
    fn continue_waits_for_the_last_file_then_finishes() {
        let fx = fixture();
        assert_eq!(code(conflict_continue(&fx.data, &fx.wt)), "no_conflict");
        merge_conflict(&fx);
        assert_eq!(
            code(conflict_continue(&fx.data, &fx.wt)),
            "still_conflicted"
        );
        assert!(conflicts(&fx.data, &fx.wt).unwrap().is_some());
        fs::write(fx.wt.join("a.txt"), "both\n").unwrap();
        git(&fx.wt, &["add", "a.txt"]);
        conflict_continue(&fx.data, &fx.wt).unwrap();
        assert_eq!(conflicts(&fx.data, &fx.wt).unwrap(), None);
    }

    #[test]
    fn abort_goes_through_the_gate_as_a_discard() {
        let fx = fixture();
        let ask = Audited::new(
            FixedGate(Verdict::Ask {
                reason: "discard asks".into(),
            }),
            &fx.data,
        );
        // Nothing in progress: no_conflict, and the gate is not asked.
        assert_eq!(
            code(conflict_abort(&ask, &fx.data, &fx.wt, false)),
            "no_conflict"
        );
        assert!(xdev_policy::read_audit(&fx.data).is_err());

        merge_conflict(&fx);
        let asked = conflict_abort(&ask, &fx.data, &fx.wt, false).unwrap_err();
        assert_eq!(asked.code, "needs_approval");
        assert_eq!(asked.detail.as_deref(), Some("discard asks"));
        assert!(conflicts(&fx.data, &fx.wt).unwrap().is_some());

        let deny = Audited::new(
            FixedGate(Verdict::Deny {
                reason: "no".into(),
            }),
            &fx.data,
        );
        assert_eq!(
            code(conflict_abort(&deny, &fx.data, &fx.wt, true)),
            "denied"
        );
        assert!(conflicts(&fx.data, &fx.wt).unwrap().is_some());

        conflict_abort(&ask, &fx.data, &fx.wt, true).unwrap();
        assert_eq!(conflicts(&fx.data, &fx.wt).unwrap(), None);
        assert_eq!(fs::read_to_string(fx.wt.join("a.txt")).unwrap(), "mine\n");
        let log = xdev_policy::read_audit(&fx.data).unwrap();
        assert!(log.iter().any(|e| matches!(
            &e.action,
            Action::Discard { paths, .. } if paths == &["a.txt".to_owned()]
        )));
    }

    #[test]
    fn discard_asks_then_runs_when_confirmed() {
        let fx = fixture();
        fs::write(
            fx.wt.join("a.txt"),
            "two
",
        )
        .unwrap();
        let files = vec!["a.txt".to_owned()];
        let asked = discard(&fx.data, &fx.wt, &files, false, false);
        let err = asked.unwrap_err();
        assert_eq!(err.code, "needs_approval");
        assert_eq!(
            fs::read_to_string(fx.wt.join("a.txt")).unwrap(),
            "two
"
        );

        discard(&fx.data, &fx.wt, &files, false, true).unwrap();
        assert_eq!(
            fs::read_to_string(fx.wt.join("a.txt")).unwrap(),
            "one
"
        );
        let log = xdev_policy::read_audit(&fx.data).unwrap();
        let verdicts: Vec<_> = log.iter().map(|e| &e.verdict).collect();
        assert!(matches!(
            verdicts[..],
            [Verdict::Ask { .. }, Verdict::Allow]
        ));
        assert!(matches!(
            &log[1].action,
            Action::Discard { paths, .. } if paths == &files
        ));
    }

    #[test]
    fn discard_with_staged_too_resets_the_index() {
        let fx = fixture();
        fs::write(
            fx.wt.join("a.txt"),
            "two
",
        )
        .unwrap();
        let files = vec!["a.txt".to_owned()];
        stage(&fx.data, &fx.wt, &files, true).unwrap();
        discard(&fx.data, &fx.wt, &files, true, true).unwrap();
        assert_eq!(
            fs::read_to_string(fx.wt.join("a.txt")).unwrap(),
            "one
"
        );
        assert!(stage_state(&fx.data, &fx.wt).unwrap().is_empty());
    }

    #[test]
    fn discard_refuses_path_outside_worktree_before_asking() {
        let fx = fixture();
        for file in ["../x", "", "a/../../x"] {
            let r = discard(&fx.data, &fx.wt, &[file.to_owned()], true, true);
            assert_eq!(code(r), "bad_arg", "{file}");
        }
        // Nothing was even checked against the policy.
        assert!(xdev_policy::read_audit(&fx.data).is_err());
    }

    #[test]
    fn discard_unknown_worktree() {
        let fx = fixture();
        let r = discard(
            &fx.data,
            &fx.main.join("nope"),
            &["a.txt".to_owned()],
            false,
            true,
        );
        assert_eq!(code(r), "worktree_unknown");
    }
}
