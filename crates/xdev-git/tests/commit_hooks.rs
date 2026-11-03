use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_git::{GitError, Repo};

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

/// A repo with an identity and one commit.
fn fixture() -> (TempDir, Repo) {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    git(root, &["init", "-q"]);
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(root, &["config", key, value]);
    }
    fs::write(root.join("a.md"), "a\n").unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "-m", "first"]);
    let repo = Repo::discover(root).unwrap();
    (dir, repo)
}

fn head(dir: &Path) -> String {
    git(dir, &["rev-parse", "HEAD"])
}

fn subject(dir: &Path) -> String {
    git(dir, &["log", "-1", "--format=%s"])
}

/// A hook that prints a line to stderr and rejects.
fn failing_hook(dir: &Path, name: &str) {
    write_hook(
        dir,
        name,
        "#!/bin/sh\necho \"lint: bad thing\" >&2\nexit 1\n",
    );
}

fn write_hook(hooks: &Path, name: &str, body: &str) {
    fs::create_dir_all(hooks).unwrap();
    let path = hooks.join(name);
    fs::write(&path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|p| (*p).to_owned()).collect()
}

fn expect_hook(err: GitError) {
    match err {
        GitError::Hook { output } => assert!(output.contains("lint: bad thing"), "{output}"),
        other => panic!("expected Hook, got {other:?}"),
    }
}

#[test]
fn commit_reports_pre_commit_hook() {
    let (dir, repo) = fixture();
    failing_hook(&dir.path().join(".git/hooks"), "pre-commit");
    let before = head(dir.path());
    fs::write(dir.path().join("a.md"), "b\n").unwrap();
    let err = repo.commit(&paths(&["a.md"]), "second").unwrap_err();
    assert_eq!(err.code(), "hook_failed");
    expect_hook(err);
    assert_eq!(head(dir.path()), before);
}

#[test]
fn commit_reports_commit_msg_hook() {
    let (dir, repo) = fixture();
    failing_hook(&dir.path().join(".git/hooks"), "commit-msg");
    let before = head(dir.path());
    fs::write(dir.path().join("a.md"), "b\n").unwrap();
    expect_hook(repo.commit(&paths(&["a.md"]), "second").unwrap_err());
    assert_eq!(head(dir.path()), before);
}

#[test]
fn commit_reports_hooks_path_hook() {
    let (dir, repo) = fixture();
    git(dir.path(), &["config", "core.hooksPath", ".githooks"]);
    failing_hook(&dir.path().join(".githooks"), "pre-commit");
    assert_eq!(repo.hooks_dir().unwrap(), dir.path().join(".githooks"));
    let before = head(dir.path());
    fs::write(dir.path().join("a.md"), "b\n").unwrap();
    expect_hook(repo.commit(&paths(&["a.md"]), "second").unwrap_err());
    assert_eq!(head(dir.path()), before);
}

#[test]
fn commit_without_hook_failure_stays_git_error() {
    // No hook exists, so a failing commit (a stale index lock) is no hook
    // failure.
    let (dir, repo) = fixture();
    fs::write(
        dir.path().join("a.md"),
        "b
",
    )
    .unwrap();
    fs::write(dir.path().join(".git/index.lock"), "").unwrap();
    let err = repo.commit(&paths(&["a.md"]), "second").unwrap_err();
    assert!(matches!(err, GitError::Failed { .. }), "{err:?}");
    assert_eq!(err.code(), "git");
}

#[test]
fn amend_rewords_head() {
    let (dir, repo) = fixture();
    let before = head(dir.path());
    let id = repo.amend(&[], "reworded").unwrap();
    assert_eq!(id, head(dir.path()));
    assert_ne!(id, before);
    assert_eq!(subject(dir.path()), "reworded");
    assert_eq!(git(dir.path(), &["rev-list", "--count", "HEAD"]), "1");
}

#[test]
fn amend_adds_checked_paths() {
    let (dir, repo) = fixture();
    fs::write(dir.path().join("a.md"), "changed\n").unwrap();
    fs::write(dir.path().join("new.md"), "new\n").unwrap();
    fs::write(dir.path().join("other.md"), "other\n").unwrap();
    let id = repo
        .amend(
            &paths(&["a.md", "new.md", "unchanged-missing.md"]),
            "all in one",
        )
        .unwrap();
    assert_eq!(id, head(dir.path()));
    assert_eq!(git(dir.path(), &["rev-list", "--count", "HEAD"]), "1");
    let files = git(dir.path(), &["show", "--name-only", "--format=", "HEAD"]);
    assert_eq!(files.lines().collect::<Vec<_>>(), ["a.md", "new.md"]);
    // Unchecked files stay out.
    assert!(git(dir.path(), &["status", "--porcelain"]).contains("other.md"));
}

#[test]
fn amend_reports_hook() {
    let (dir, repo) = fixture();
    failing_hook(&dir.path().join(".git/hooks"), "pre-commit");
    let before = head(dir.path());
    expect_hook(repo.amend(&[], "reworded").unwrap_err());
    assert_eq!(head(dir.path()), before);
}
