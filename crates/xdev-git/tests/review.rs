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

fn read(root: &Path, rel: &str) -> String {
    fs::read_to_string(root.join(rel)).unwrap()
}

fn status(dir: &Path) -> String {
    git(dir, &["status", "--porcelain"])
}

#[test]
fn discard_reverts_a_modified_file() {
    let dir = fixture();
    write(dir.path(), "a.txt", "changed\n");
    write(dir.path(), "b.txt", "keep me changed\n");
    let repo = Repo::discover(dir.path()).unwrap();
    repo.discard(&paths(&["a.txt"]), false).unwrap();
    assert_eq!(read(dir.path(), "a.txt"), "a\n");
    assert_eq!(read(dir.path(), "b.txt"), "keep me changed\n");
}

#[test]
fn discard_restores_a_deleted_file() {
    let dir = fixture();
    fs::remove_file(dir.path().join("a.txt")).unwrap();
    let repo = Repo::discover(dir.path()).unwrap();
    repo.discard(&paths(&["a.txt"]), false).unwrap();
    assert_eq!(read(dir.path(), "a.txt"), "a\n");
}

#[test]
fn discard_keeps_the_staged_version_unless_asked() {
    let dir = fixture();
    write(dir.path(), "a.txt", "staged\n");
    git(dir.path(), &["add", "a.txt"]);
    write(dir.path(), "a.txt", "worktree\n");
    let repo = Repo::discover(dir.path()).unwrap();

    repo.discard(&paths(&["a.txt"]), false).unwrap();
    assert_eq!(read(dir.path(), "a.txt"), "staged\n");
    let s = state(&repo, "a.txt").unwrap();
    assert!(s.staged && !s.unstaged);

    repo.discard(&paths(&["a.txt"]), true).unwrap();
    assert_eq!(read(dir.path(), "a.txt"), "a\n");
    assert_eq!(status(dir.path()), "");
}

#[test]
fn discard_deletes_untracked_files_only_those_listed() {
    let dir = fixture();
    write(dir.path(), "dir/one.txt", "1\n");
    write(dir.path(), "dir/two.txt", "2\n");
    write(dir.path(), "loose.txt", "x\n");
    let repo = Repo::discover(dir.path()).unwrap();
    repo.discard(&paths(&["dir/one.txt", "loose.txt"]), false)
        .unwrap();
    assert!(!dir.path().join("dir/one.txt").exists());
    assert!(!dir.path().join("loose.txt").exists());
    assert!(dir.path().join("dir/two.txt").exists());
}

#[test]
fn discard_staged_new_file_removes_it() {
    let dir = fixture();
    write(dir.path(), "new.txt", "n\n");
    git(dir.path(), &["add", "new.txt"]);
    let repo = Repo::discover(dir.path()).unwrap();
    repo.discard(&paths(&["new.txt"]), true).unwrap();
    assert!(!dir.path().join("new.txt").exists());
    assert_eq!(status(dir.path()), "");
}

#[test]
fn discard_a_rename_restores_both_sides() {
    let dir = fixture();
    git(dir.path(), &["mv", "a.txt", "c.txt"]);
    let repo = Repo::discover(dir.path()).unwrap();
    repo.discard(&paths(&["c.txt"]), true).unwrap();
    assert_eq!(read(dir.path(), "a.txt"), "a\n");
    assert!(!dir.path().join("c.txt").exists());
    assert_eq!(status(dir.path()), "");
}

#[test]
fn discard_refuses_a_path_outside_the_repo() {
    let dir = fixture();
    let outside = dir
        .path()
        .parent()
        .unwrap()
        .join("xdev-discard-outside.txt");
    fs::write(&outside, "keep\n").unwrap();
    let repo = Repo::discover(dir.path()).unwrap();
    for bad in ["../xdev-discard-outside.txt", "a/../../x"] {
        assert!(repo.discard(&paths(&[bad]), true).is_err(), "{bad}");
    }
    assert!(outside.exists());
    fs::remove_file(outside).unwrap();
}

#[test]
fn discard_leaves_ignored_files_alone() {
    let dir = fixture();
    write(dir.path(), ".gitignore", "*.log\n");
    commit_all(dir.path(), "ignore");
    write(dir.path(), "x.log", "log\n");
    let repo = Repo::discover(dir.path()).unwrap();
    repo.discard(&paths(&["x.log"]), true).unwrap();
    assert!(dir.path().join("x.log").exists());
}

#[test]
fn discard_with_no_paths_does_nothing() {
    let dir = fixture();
    write(dir.path(), "a.txt", "changed\n");
    let repo = Repo::discover(dir.path()).unwrap();
    repo.discard(&[], true).unwrap();
    assert_eq!(read(dir.path(), "a.txt"), "changed\n");
}

#[test]
fn discard_before_the_first_commit() {
    let dir = repo_dir();
    write(dir.path(), "a.txt", "a\n");
    write(dir.path(), "u.txt", "u\n");
    git(dir.path(), &["add", "a.txt"]);
    write(dir.path(), "a.txt", "a2\n");
    let repo = Repo::discover(dir.path()).unwrap();
    // Without staged_too the staged version stays.
    repo.discard(&paths(&["a.txt"]), false).unwrap();
    assert_eq!(read(dir.path(), "a.txt"), "a\n");
    repo.discard(&paths(&["a.txt", "u.txt"]), true).unwrap();
    assert!(!dir.path().join("a.txt").exists());
    assert!(!dir.path().join("u.txt").exists());
    assert_eq!(status(dir.path()), "");
}

#[test]
fn stage_state_flags_untracked_files() {
    let dir = fixture();
    write(dir.path(), "new.txt", "n\n");
    write(dir.path(), "a.txt", "a2\n");
    let repo = Repo::discover(dir.path()).unwrap();
    assert!(state(&repo, "new.txt").unwrap().untracked);
    assert!(!state(&repo, "a.txt").unwrap().untracked);
}

#[test]
fn discard_treats_glob_characters_literally() {
    let dir = fixture();
    write(dir.path(), "[ab].txt", "lit\n");
    commit_all(dir.path(), "bracket");
    write(dir.path(), "a.txt", "a2\n");
    write(dir.path(), "b.txt", "b2\n");
    write(dir.path(), "[ab].txt", "lit2\n");
    let repo = Repo::discover(dir.path()).unwrap();
    repo.discard(&paths(&["*.txt", "?.txt"]), true).unwrap();
    assert_eq!(read(dir.path(), "a.txt"), "a2\n");
    assert_eq!(read(dir.path(), "b.txt"), "b2\n");
    repo.discard(&paths(&["[ab].txt"]), true).unwrap();
    assert_eq!(read(dir.path(), "[ab].txt"), "lit\n");
    assert_eq!(read(dir.path(), "a.txt"), "a2\n");
    assert_eq!(read(dir.path(), "b.txt"), "b2\n");
}

#[test]
fn discard_never_removes_an_untracked_folder() {
    let dir = fixture();
    write(dir.path(), "new/one.txt", "1\n");
    write(dir.path(), "new/deep/two.txt", "2\n");
    let repo = Repo::discover(dir.path()).unwrap();
    repo.discard(&paths(&["new", "new/", "new/deep", "."]), true)
        .unwrap();
    assert!(dir.path().join("new/one.txt").exists());
    assert!(dir.path().join("new/deep/two.txt").exists());
}

#[test]
fn discard_leaves_a_nested_repository_alone() {
    let dir = fixture();
    let nested = dir.path().join("nested");
    fs::create_dir_all(&nested).unwrap();
    git(&nested, &["init", "-q"]);
    write(&nested, "inner.txt", "inner\n");
    let repo = Repo::discover(dir.path()).unwrap();
    let listed: Vec<String> = repo
        .stage_state()
        .unwrap()
        .into_iter()
        .map(|s| s.path)
        .collect();
    repo.discard(&listed, true).unwrap();
    repo.discard(&paths(&["nested", "nested/", "nested/inner.txt"]), true)
        .unwrap();
    assert!(nested.join("inner.txt").exists());
    assert!(nested.join(".git").exists());
}

#[test]
fn discard_leaves_a_submodule_checkout_alone() {
    let sub = fixture();
    let dir = fixture();
    let url = sub.path().to_string_lossy().replace('\\', "/");
    git(
        dir.path(),
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            &url,
            "sub",
        ],
    );
    commit_all(dir.path(), "add sub");
    write(&dir.path().join("sub"), "a.txt", "edited in sub\n");
    write(&dir.path().join("sub"), "fresh.txt", "fresh\n");
    let repo = Repo::discover(dir.path()).unwrap();
    let listed: Vec<String> = repo
        .stage_state()
        .unwrap()
        .into_iter()
        .map(|s| s.path)
        .collect();
    let _ = repo.discard(&listed, true);
    let _ = repo.discard(&paths(&["sub", "sub/a.txt", "sub/fresh.txt"]), true);
    assert_eq!(read(&dir.path().join("sub"), "a.txt"), "edited in sub\n");
    assert!(dir.path().join("sub/fresh.txt").exists());
}

#[test]
fn discard_through_a_symlink_never_touches_its_target() {
    let outside = TempDir::new().unwrap();
    write(outside.path(), "target.txt", "outside\n");
    write(outside.path(), "dir/inner.txt", "outside inner\n");
    let dir = fixture();
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(
        outside.path().join("target.txt"),
        dir.path().join("link.txt"),
    )
    .and_then(|()| {
        std::os::windows::fs::symlink_dir(outside.path().join("dir"), dir.path().join("linkdir"))
    });
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(
        outside.path().join("target.txt"),
        dir.path().join("link.txt"),
    )
    .and_then(|()| {
        std::os::unix::fs::symlink(outside.path().join("dir"), dir.path().join("linkdir"))
    });
    if made.is_err() {
        eprintln!("symlinks unavailable here; skipped");
        return;
    }
    let repo = Repo::discover(dir.path()).unwrap();
    let listed: Vec<String> = repo
        .stage_state()
        .unwrap()
        .into_iter()
        .map(|s| s.path)
        .collect();
    let _ = repo.discard(&paths(&["linkdir/inner.txt", "linkdir"]), true);
    let _ = repo.discard(&listed, true);
    assert_eq!(read(outside.path(), "target.txt"), "outside\n");
    assert_eq!(read(outside.path(), "dir/inner.txt"), "outside inner\n");
}

#[test]
fn discard_refuses_drive_and_absolute_paths() {
    let dir = fixture();
    write(dir.path(), "a.txt", "changed\n");
    let repo = Repo::discover(dir.path()).unwrap();
    let abs = dir.path().join("a.txt").to_string_lossy().into_owned();
    for bad in [abs.as_str(), "C:a.txt", "/a.txt", "\\a.txt"] {
        let _ = repo.discard(&paths(&[bad]), true);
    }
    assert_eq!(read(dir.path(), "a.txt"), "changed\n");
}
