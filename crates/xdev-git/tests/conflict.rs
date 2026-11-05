use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_git::{ConflictKind, ConflictOp, GitError, Repo};

/// Runs setup commands; never used for the code under test.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// Like `git`, for a command that is expected to stop on a conflict.
fn git_conflicts(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .env("GIT_EDITOR", "true")
        .args(args)
        .output()
        .expect("run git");
    assert!(
        !out.status.success(),
        "git {args:?} should conflict: {out:?}"
    );
}

fn write_commit(dir: &Path, file: &str, text: &str, message: &str) {
    fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
}

/// `main` and `topic` both changed `f.txt` from the same base; checked out on `main`.
fn fixture() -> (TempDir, Repo) {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    git(root, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(root, &["config", key, value]);
    }
    write_commit(root, "f.txt", "base\n", "base");
    git(root, &["checkout", "-q", "-b", "topic"]);
    write_commit(root, "f.txt", "topic\n", "topic change");
    git(root, &["checkout", "-q", "main"]);
    write_commit(root, "f.txt", "main\n", "main change");
    let repo = Repo::discover(root).unwrap();
    (dir, repo)
}

/// Resolves `f.txt` and stages it.
fn resolve(dir: &Path) {
    fs::write(dir.join("f.txt"), "resolved\n").unwrap();
    git(dir, &["add", "f.txt"]);
}

#[test]
fn a_clean_repo_has_no_conflict_state() {
    let (_dir, repo) = fixture();
    assert_eq!(repo.conflict_state().unwrap(), None);
}

#[test]
fn a_merge_in_progress_names_its_files_and_the_branch() {
    let (dir, repo) = fixture();
    git_conflicts(dir.path(), &["merge", "topic"]);
    let state = repo.conflict_state().unwrap().expect("merge state");
    assert_eq!(state.op, ConflictOp::Merge);
    assert_eq!(state.files, ["f.txt"]);
    assert_eq!(state.onto.as_deref(), Some("topic"));
    assert_eq!(state.step, None);
}

#[test]
fn a_rebase_reports_its_step_numbers_and_target() {
    let (dir, repo) = fixture();
    let root = dir.path();
    git(root, &["checkout", "-q", "topic"]);
    // Two commits on topic: the first conflicts with main, the second does not.
    write_commit(root, "g.txt", "g\n", "topic second");
    git_conflicts(root, &["rebase", "main"]);
    let state = repo.conflict_state().unwrap().expect("rebase state");
    assert_eq!(state.op, ConflictOp::Rebase);
    assert_eq!(state.files, ["f.txt"]);
    assert_eq!(state.onto.as_deref(), Some("main"));
    assert_eq!(state.step, Some((1, 2)));
    // Continue: the second step goes through, nothing is left.
    resolve(root);
    repo.conflict_continue(ConflictOp::Rebase).unwrap();
    assert_eq!(repo.conflict_state().unwrap(), None);
    assert_eq!(git(root, &["log", "-1", "--format=%s"]), "topic second");
}

#[test]
fn a_rebase_that_conflicts_again_stays_in_progress_with_the_next_step() {
    let (dir, repo) = fixture();
    let root = dir.path();
    git(root, &["checkout", "-q", "topic"]);
    write_commit(root, "f.txt", "topic two\n", "topic second");
    git_conflicts(root, &["rebase", "main"]);
    assert_eq!(repo.conflict_state().unwrap().unwrap().step, Some((1, 2)));
    resolve(root);
    repo.conflict_continue(ConflictOp::Rebase).unwrap();
    let state = repo.conflict_state().unwrap().expect("second stop");
    assert_eq!(state.step, Some((2, 2)));
    assert_eq!(state.files, ["f.txt"]);
}

#[test]
fn a_cherry_pick_in_progress_is_found() {
    let (dir, repo) = fixture();
    git_conflicts(dir.path(), &["cherry-pick", "topic"]);
    let state = repo.conflict_state().unwrap().expect("pick state");
    assert_eq!(state.op, ConflictOp::CherryPick);
    assert_eq!(state.files, ["f.txt"]);
    assert_eq!(state.step, None);
    assert!(state.onto.is_some());
}

#[test]
fn a_revert_in_progress_is_found() {
    let (dir, repo) = fixture();
    let root = dir.path();
    // Reverting the base change conflicts with the later main change.
    let base = git(root, &["rev-list", "--max-parents=0", "HEAD"]);
    write_commit(root, "f.txt", "later\n", "later");
    git_conflicts(root, &["revert", &base]);
    let state = repo.conflict_state().unwrap().expect("revert state");
    assert_eq!(state.op, ConflictOp::Revert);
    assert_eq!(state.files, ["f.txt"]);
}

#[test]
fn continue_finishes_a_merge_without_opening_an_editor() {
    let (dir, repo) = fixture();
    let root = dir.path();
    git_conflicts(root, &["merge", "topic"]);
    resolve(root);
    repo.conflict_continue(ConflictOp::Merge).unwrap();
    assert_eq!(repo.conflict_state().unwrap(), None);
    assert_eq!(
        git(root, &["rev-list", "--parents", "-n1", "HEAD"])
            .split(' ')
            .count(),
        3
    );
}

#[test]
fn continue_finishes_a_cherry_pick_and_a_revert() {
    let (dir, repo) = fixture();
    let root = dir.path();
    git_conflicts(root, &["cherry-pick", "topic"]);
    resolve(root);
    repo.conflict_continue(ConflictOp::CherryPick).unwrap();
    assert_eq!(repo.conflict_state().unwrap(), None);
    assert_eq!(git(root, &["log", "-1", "--format=%s"]), "topic change");

    let base = git(root, &["rev-list", "--max-parents=0", "HEAD"]);
    git_conflicts(root, &["revert", &base]);
    // Different from what the cherry-pick left, so the revert has something to commit.
    fs::write(root.join("f.txt"), "reverted\n").unwrap();
    git(root, &["add", "f.txt"]);
    repo.conflict_continue(ConflictOp::Revert).unwrap();
    assert_eq!(repo.conflict_state().unwrap(), None);
}

#[test]
fn continue_with_an_unmerged_file_is_still_conflicted() {
    let (dir, repo) = fixture();
    git_conflicts(dir.path(), &["merge", "topic"]);
    let err = repo.conflict_continue(ConflictOp::Merge).unwrap_err();
    assert!(matches!(err, GitError::StillConflicted), "{err:?}");
    assert_eq!(err.code(), "still_conflicted");
    assert!(repo.conflict_state().unwrap().is_some());
}

#[test]
fn continue_and_abort_with_nothing_in_progress_are_no_conflict() {
    let (_dir, repo) = fixture();
    let err = repo.conflict_continue(ConflictOp::Merge).unwrap_err();
    assert_eq!(err.code(), "no_conflict");
    let err = repo.conflict_abort(ConflictOp::Rebase).unwrap_err();
    assert_eq!(err.code(), "no_conflict");
}

#[test]
fn abort_puts_each_operation_back() {
    let (dir, repo) = fixture();
    let root = dir.path();
    let before = git(root, &["rev-parse", "HEAD"]);

    git_conflicts(root, &["merge", "topic"]);
    repo.conflict_abort(ConflictOp::Merge).unwrap();
    assert_eq!(repo.conflict_state().unwrap(), None);
    assert_eq!(git(root, &["rev-parse", "HEAD"]), before);
    assert_eq!(fs::read_to_string(root.join("f.txt")).unwrap(), "main\n");

    git_conflicts(root, &["cherry-pick", "topic"]);
    repo.conflict_abort(ConflictOp::CherryPick).unwrap();
    assert_eq!(repo.conflict_state().unwrap(), None);

    let base = git(root, &["rev-list", "--max-parents=0", "HEAD"]);
    git_conflicts(root, &["revert", &base]);
    repo.conflict_abort(ConflictOp::Revert).unwrap();
    assert_eq!(repo.conflict_state().unwrap(), None);

    git(root, &["checkout", "-q", "topic"]);
    let topic = git(root, &["rev-parse", "HEAD"]);
    git_conflicts(root, &["rebase", "main"]);
    repo.conflict_abort(ConflictOp::Rebase).unwrap();
    assert_eq!(repo.conflict_state().unwrap(), None);
    assert_eq!(git(root, &["rev-parse", "HEAD"]), topic);
    assert_eq!(git(root, &["symbolic-ref", "--short", "HEAD"]), "topic");
}

#[test]
fn an_abort_git_refuses_is_an_error_and_the_operation_stays() {
    let (dir, repo) = fixture();
    let root = dir.path();
    // A rebase whose state git cannot read back: `rebase --abort` fails.
    let state_dir = root.join(".git").join("rebase-merge");
    fs::create_dir(&state_dir).unwrap();
    fs::write(state_dir.join("onto"), git(root, &["rev-parse", "HEAD"])).unwrap();
    assert_eq!(
        repo.conflict_state().unwrap().map(|s| s.op),
        Some(ConflictOp::Rebase)
    );
    let err = repo.conflict_abort(ConflictOp::Rebase).unwrap_err();
    assert_eq!(err.code(), "git");
    assert!(repo.conflict_state().unwrap().is_some());
}

#[test]
fn stage_state_marks_the_unmerged_files() {
    let (dir, repo) = fixture();
    let root = dir.path();
    fs::write(root.join("other.txt"), "x\n").unwrap();
    git_conflicts(root, &["merge", "topic"]);
    let states = repo.stage_state().unwrap();
    let f = states.iter().find(|s| s.path == "f.txt").unwrap();
    assert!(f.conflicted);
    let other = states.iter().find(|s| s.path == "other.txt").unwrap();
    assert!(!other.conflicted);
    resolve(root);
    assert!(repo.stage_state().unwrap().iter().all(|s| !s.conflicted));
}

#[test]
fn stage_state_marks_delete_modify_conflicts() {
    let (dir, repo) = fixture();
    let root = dir.path();
    git(root, &["checkout", "-q", "-b", "del", "main~1"]);
    git(root, &["rm", "-q", "f.txt"]);
    git(root, &["commit", "-q", "-m", "delete"]);
    git_conflicts(root, &["merge", "main"]);
    let states = repo.stage_state().unwrap();
    assert!(
        states
            .iter()
            .find(|s| s.path == "f.txt")
            .unwrap()
            .conflicted
    );
}

#[test]
fn rename_branch_moves_the_checked_out_branch() {
    let (dir, repo) = fixture();
    let root = dir.path();
    repo.rename_branch("main", "trunk").unwrap();
    assert_eq!(repo.current_branch().unwrap().as_deref(), Some("trunk"));
    assert!(!repo.branch_exists("main").unwrap());
    // A taken name is refused and nothing moves.
    git(root, &["branch", "taken"]);
    assert!(repo.rename_branch("trunk", "taken").is_err());
    assert_eq!(repo.current_branch().unwrap().as_deref(), Some("trunk"));
}

#[test]
fn conflict_state_still_lists_files() {
    let (dir, repo) = fixture();
    git_conflicts(dir.path(), &["merge", "topic"]);
    let state = repo.conflict_state().unwrap().expect("merge state");
    // `files` stays next to `entries`, so older readers keep working.
    assert_eq!(state.files, ["f.txt"]);
    let json = serde_json::to_value(&state).unwrap();
    assert_eq!(json["files"], serde_json::json!(["f.txt"]));
    assert!(json["entries"].is_array());
}

#[test]
fn conflict_entries_reports_both_modified_and_deleted_by_them() {
    let (dir, repo) = fixture();
    let root = dir.path();
    // `topic` deletes `g.txt`, which `main` changes; both change `f.txt`.
    git(root, &["checkout", "-q", "main~1"]);
    write_commit(root, "g.txt", "g\n", "add g");
    let base = git(root, &["rev-parse", "HEAD"]);
    git(root, &["branch", "-f", "topic2", &base]);
    git(root, &["checkout", "-q", "topic2"]);
    write_commit(root, "f.txt", "topic2\n", "f on topic2");
    git(root, &["rm", "-q", "g.txt"]);
    git(root, &["commit", "-q", "-m", "drop g"]);
    git(root, &["checkout", "-q", "-B", "mine", &base]);
    write_commit(root, "f.txt", "mine\n", "f on mine");
    write_commit(root, "g.txt", "g changed\n", "g on mine");
    git_conflicts(root, &["merge", "topic2"]);

    let entries = repo.conflict_entries().unwrap();
    let got: Vec<_> = entries
        .iter()
        .map(|e| (e.path.as_str(), e.kind, e.present))
        .collect();
    assert_eq!(
        got,
        [
            ("f.txt", ConflictKind::BothModified, true),
            ("g.txt", ConflictKind::DeletedByThem, true),
        ]
    );
    let state = repo.conflict_state().unwrap().unwrap();
    assert_eq!(state.entries, entries);
    assert_eq!(state.files, ["f.txt", "g.txt"]);
}

#[test]
fn conflict_entries_are_relative_to_the_top_folder() {
    let (dir, _) = fixture();
    let root = dir.path();
    git_conflicts(root, &["merge", "topic"]);
    fs::create_dir(root.join("sub")).unwrap();
    let repo = Repo::discover(&root.join("sub")).unwrap();
    let paths: Vec<_> = repo
        .conflict_entries()
        .unwrap()
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert_eq!(paths, ["f.txt"]);
}
