use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_git::{Repo, StageState};

/// Runs setup commands; never used for the code under test.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8(out.stdout).unwrap()
}

fn repo_dir() -> TempDir {
    let dir = TempDir::new().unwrap();
    git(dir.path(), &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(dir.path(), &["config", key, value]);
    }
    dir
}

fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn commit_all(dir: &Path, message: &str) -> String {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
    git(dir, &["rev-parse", "HEAD"]).trim().to_owned()
}

fn fixture() -> TempDir {
    let dir = repo_dir();
    write(dir.path(), "a.txt", "a\n");
    write(dir.path(), "b.txt", "b\n");
    commit_all(dir.path(), "first");
    dir
}

fn state(repo: &Repo, path: &str) -> Option<StageState> {
    repo.stage_state()
        .unwrap()
        .into_iter()
        .find(|s| s.path == path)
}

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|p| (*p).to_owned()).collect()
}

#[test]
fn branches_lists_local_and_remote_newest_first() {
    let dir = fixture();
    git(dir.path(), &["branch", "older"]);
    // A later commit date on `newer` puts it first.
    git(dir.path(), &["checkout", "-q", "-b", "newer"]);
    write(dir.path(), "c.txt", "c\n");
    git(dir.path(), &["add", "-A"]);
    let out = Command::new("git")
        .current_dir(dir.path())
        .args(["commit", "-q", "-m", "later"])
        .env("GIT_COMMITTER_DATE", "2030-01-01T00:00:00")
        .output()
        .unwrap();
    assert!(out.status.success());
    git(
        dir.path(),
        &["update-ref", "refs/remotes/origin/main", "main"],
    );
    let repo = Repo::discover(dir.path()).unwrap();
    let list = repo.branches(50).unwrap();
    assert_eq!(list[0].name, "newer");
    assert!(!list[0].remote);
    let remote = list.iter().find(|b| b.name == "origin/main").unwrap();
    assert!(remote.remote);
    assert_eq!(remote.id.len(), 40);
    assert!(list.iter().any(|b| b.name == "older"));
    assert_eq!(repo.branches(1).unwrap().len(), 1);
}

#[test]
fn branches_skip_remote_head() {
    let dir = fixture();
    git(
        dir.path(),
        &["update-ref", "refs/remotes/origin/main", "main"],
    );
    git(
        dir.path(),
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ],
    );
    let repo = Repo::discover(dir.path()).unwrap();
    let names: Vec<String> = repo
        .branches(50)
        .unwrap()
        .into_iter()
        .map(|b| b.name)
        .collect();
    assert!(!names.iter().any(|n| n.ends_with("/HEAD")), "{names:?}");
    assert!(names.contains(&"origin/main".to_owned()));
}

#[test]
fn stage_state_reports_staged_and_unstaged() {
    let dir = fixture();
    write(dir.path(), "a.txt", "a2\n");
    git(dir.path(), &["add", "a.txt"]);
    write(dir.path(), "a.txt", "a3\n");
    write(dir.path(), "b.txt", "b2\n");
    let repo = Repo::discover(dir.path()).unwrap();
    let a = state(&repo, "a.txt").unwrap();
    assert!(a.staged && a.unstaged);
    let b = state(&repo, "b.txt").unwrap();
    assert!(!b.staged && b.unstaged);
}

#[test]
fn stage_state_counts_untracked_as_unstaged() {
    let dir = fixture();
    write(dir.path(), "dir/new.txt", "n\n");
    let repo = Repo::discover(dir.path()).unwrap();
    let n = state(&repo, "dir/new.txt").unwrap();
    assert!(!n.staged && n.unstaged);
    assert!(state(&repo, "a.txt").is_none());
}

#[test]
fn stage_adds_new_and_deleted() {
    let dir = fixture();
    write(dir.path(), "new.txt", "n\n");
    fs::remove_file(dir.path().join("b.txt")).unwrap();
    let repo = Repo::discover(dir.path()).unwrap();
    repo.stage(&paths(&["new.txt", "b.txt"])).unwrap();
    let n = state(&repo, "new.txt").unwrap();
    assert!(n.staged && !n.unstaged);
    let b = state(&repo, "b.txt").unwrap();
    assert!(b.staged && !b.unstaged);
}

#[test]
fn unstage_tracked_keeps_file_tracked() {
    let dir = fixture();
    write(dir.path(), "a.txt", "a2\n");
    let repo = Repo::discover(dir.path()).unwrap();
    repo.stage(&paths(&["a.txt"])).unwrap();
    repo.unstage_to_head(&paths(&["a.txt"])).unwrap();
    assert!(git(dir.path(), &["ls-files", "a.txt"]).contains("a.txt"));
    assert_eq!(git(dir.path(), &["diff", "--cached", "--name-only"]), "");
    let a = state(&repo, "a.txt").unwrap();
    assert!(!a.staged && a.unstaged);
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "a2\n"
    );
}

#[test]
fn unstage_before_first_commit() {
    let dir = repo_dir();
    write(dir.path(), "a.txt", "a\n");
    let repo = Repo::discover(dir.path()).unwrap();
    repo.stage(&paths(&["a.txt"])).unwrap();
    assert!(state(&repo, "a.txt").unwrap().staged);
    repo.unstage_to_head(&paths(&["a.txt"])).unwrap();
    let a = state(&repo, "a.txt").unwrap();
    assert!(!a.staged && a.unstaged);
    assert!(dir.path().join("a.txt").exists());
}

#[test]
fn stage_refuses_option_like_path_safely() {
    let dir = fixture();
    write(dir.path(), "-x.md", "x\n");
    let repo = Repo::discover(dir.path()).unwrap();
    repo.stage(&paths(&["-x.md"])).unwrap();
    assert!(state(&repo, "-x.md").unwrap().staged);
    repo.unstage_to_head(&paths(&["-x.md"])).unwrap();
    assert!(!state(&repo, "-x.md").unwrap().staged);
}

#[test]
fn stage_with_no_paths_does_nothing() {
    let dir = fixture();
    let repo = Repo::discover(dir.path()).unwrap();
    repo.stage(&[]).unwrap();
    repo.unstage_to_head(&[]).unwrap();
}

#[test]
fn current_branch_none_when_detached() {
    let dir = fixture();
    let repo = Repo::discover(dir.path()).unwrap();
    assert_eq!(repo.current_branch().unwrap().as_deref(), Some("main"));
    git(dir.path(), &["checkout", "-q", "--detach"]);
    assert_eq!(repo.current_branch().unwrap(), None);
}
