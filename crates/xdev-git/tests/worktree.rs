use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_git::{ChangeKind, GitError, NumStat, Repo};

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

/// A fresh repo with its own identity, so tests never read the developer's
/// global config, and without autocrlf, which would rewrite line endings.
fn repo_dir() -> TempDir {
    let dir = TempDir::with_prefix("git repo ").unwrap();
    git(dir.path(), &["init", "-q"]);
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

fn commit_all(dir: &Path, message: &str) -> String {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
    git(dir, &["rev-parse", "HEAD"]).trim().to_owned()
}

/// A repo with one commit, and a worktree on branch `task` from it.
fn with_worktree() -> (TempDir, TempDir, Repo, String) {
    let dir = repo_dir();
    fs::write(dir.path().join("a.txt"), "a\n").unwrap();
    let base = commit_all(dir.path(), "A");
    let wt_parent = TempDir::with_prefix("wt parent ").unwrap();
    let repo = Repo::discover(dir.path()).unwrap();
    repo.add_worktree(&wt_parent.path().join("wt"), "task", &base)
        .unwrap();
    (dir, wt_parent, repo, base)
}

#[test]
fn current_branch_and_detached() {
    let dir = repo_dir();
    fs::write(dir.path().join("a.txt"), "a\n").unwrap();
    let id = commit_all(dir.path(), "A");
    git(dir.path(), &["switch", "-q", "-c", "work"]);
    let repo = Repo::discover(dir.path()).unwrap();
    assert_eq!(repo.current_branch().unwrap().as_deref(), Some("work"));
    git(dir.path(), &["switch", "-q", "--detach", &id]);
    assert_eq!(repo.current_branch().unwrap(), None);
}

#[test]
fn is_clean_ignores_untracked_only() {
    let dir = repo_dir();
    fs::write(dir.path().join("a.txt"), "a\n").unwrap();
    commit_all(dir.path(), "A");
    let repo = Repo::discover(dir.path()).unwrap();
    assert!(repo.is_clean().unwrap());
    fs::write(dir.path().join("new.txt"), "n\n").unwrap();
    assert!(repo.is_clean().unwrap());
    fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
    assert!(!repo.is_clean().unwrap());
}

#[test]
fn add_worktree_makes_branch_at_base() {
    let (_dir, wt_parent, _repo, base) = with_worktree();
    let wt = wt_parent.path().join("wt");
    assert_eq!(fs::read_to_string(wt.join("a.txt")).unwrap(), "a\n");
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]).trim(), base);
    assert_eq!(git(&wt, &["branch", "--show-current"]).trim(), "task");
}

#[test]
fn commit_all_takes_new_and_changed_files() {
    let (_dir, wt_parent, _repo, base) = with_worktree();
    let wt = Repo::discover(&wt_parent.path().join("wt")).unwrap();
    assert_eq!(wt.commit_all("nothing").unwrap(), None);

    fs::write(wt_parent.path().join("wt/a.txt"), "a\nb\n").unwrap();
    fs::write(wt_parent.path().join("wt/new file.txt"), "x\n").unwrap();
    let head = wt.commit_all("task: two files").unwrap().unwrap();
    assert_ne!(head, base);
    assert_eq!(wt.head_id().unwrap().as_deref(), Some(head.as_str()));
    assert!(wt.is_clean().unwrap());
    assert_eq!(
        git(&wt_parent.path().join("wt"), &["log", "-1", "--format=%s"]).trim(),
        "task: two files"
    );
}

#[test]
fn diff_numstat_lists_files_between_commits() {
    let (_dir, wt_parent, _repo, base) = with_worktree();
    let wt_path = wt_parent.path().join("wt");
    let wt = Repo::discover(&wt_path).unwrap();
    fs::write(wt_path.join("a.txt"), "a\nb\nc\n").unwrap();
    fs::write(wt_path.join("n.txt"), "n\n").unwrap();
    let head = wt.commit_all("two").unwrap().unwrap();
    let mut files = wt.diff_numstat(&base, &head).unwrap();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    assert_eq!(
        files,
        vec![
            NumStat {
                path: "a.txt".into(),
                added: Some(2),
                removed: Some(0),
            },
            NumStat {
                path: "n.txt".into(),
                added: Some(1),
                removed: Some(0),
            },
        ]
    );
}

#[test]
fn merge_no_ff_makes_a_merge_commit() {
    let (dir, wt_parent, repo, base) = with_worktree();
    let wt_path = wt_parent.path().join("wt");
    fs::write(wt_path.join("b.txt"), "b\n").unwrap();
    let head = Repo::discover(&wt_path)
        .unwrap()
        .commit_all("b")
        .unwrap()
        .unwrap();

    let merge = repo.merge_no_ff("task", "Merge task").unwrap().unwrap();
    let parents = git(dir.path(), &["rev-list", "--parents", "-n", "1", &merge]);
    assert_eq!(
        parents.split_whitespace().collect::<Vec<_>>(),
        [merge.as_str(), base.as_str(), head.as_str()]
    );
    assert_eq!(fs::read_to_string(dir.path().join("b.txt")).unwrap(), "b\n");
}

#[test]
fn merge_conflict_is_aborted() {
    let (dir, wt_parent, repo, _base) = with_worktree();
    let wt_path = wt_parent.path().join("wt");
    fs::write(wt_path.join("a.txt"), "theirs\n").unwrap();
    Repo::discover(&wt_path)
        .unwrap()
        .commit_all("theirs")
        .unwrap();
    fs::write(dir.path().join("a.txt"), "ours\n").unwrap();
    let ours = commit_all(dir.path(), "ours");

    assert_eq!(repo.merge_no_ff("task", "Merge task").unwrap(), None);
    assert_eq!(git(dir.path(), &["rev-parse", "HEAD"]).trim(), ours);
    assert!(repo.is_clean().unwrap());
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "ours\n"
    );
}

#[test]
fn remove_worktree_and_delete_branch() {
    let (dir, wt_parent, repo, _base) = with_worktree();
    let wt_path = wt_parent.path().join("wt");
    fs::write(wt_path.join("dirty.txt"), "x\n").unwrap();
    repo.remove_worktree(&wt_path).unwrap();
    assert!(!wt_path.exists());
    // Already gone: only pruned, no error.
    repo.remove_worktree(&wt_path).unwrap();

    repo.delete_branch("task").unwrap();
    assert_eq!(git(dir.path(), &["branch", "--list", "task"]), "");
    repo.delete_branch("task").unwrap();
}

#[test]
fn list_worktrees_reads_primary_and_linked() {
    let (_main, _wt, repo, _base) = with_worktree();
    let list = repo.list_worktrees().unwrap();
    assert_eq!(list.len(), 2);
    assert!(!list[0].detached);
    assert_eq!(list[1].branch.as_deref(), Some("task"));
    assert!(list[1].head.as_deref().is_some_and(|h| h.len() == 40));
}

#[test]
fn list_worktrees_marks_detached_and_missing() {
    let (main, wt, repo, base) = with_worktree();
    let det = wt.path().join("det");
    git(
        main.path(),
        &[
            "worktree",
            "add",
            "--detach",
            "-q",
            det.to_str().unwrap(),
            &base,
        ],
    );
    drop(wt); // folders gone, entries still in git's list
    let list = repo.list_worktrees().unwrap();
    assert!(list.iter().any(|w| w.detached));
    assert!(list.iter().any(|w| w.prunable));
}

#[test]
fn default_branch_prefers_origin_head_then_main() {
    let dir = repo_dir();
    fs::write(dir.path().join("a.txt"), "a\n").unwrap();
    commit_all(dir.path(), "one");
    let repo = Repo::discover(dir.path()).unwrap();
    git(dir.path(), &["branch", "-M", "main"]);
    assert_eq!(repo.default_branch().unwrap().as_deref(), Some("main"));
    git(
        dir.path(),
        &["update-ref", "refs/remotes/origin/trunk", "HEAD"],
    );
    git(
        dir.path(),
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/trunk",
        ],
    );
    assert_eq!(
        repo.default_branch().unwrap().as_deref(),
        Some("origin/trunk")
    );
}

#[test]
fn default_branch_falls_back_to_current_branch_then_none() {
    let dir = repo_dir();
    fs::write(dir.path().join("a.txt"), "a\n").unwrap();
    let id = commit_all(dir.path(), "one");
    let repo = Repo::discover(dir.path()).unwrap();
    git(dir.path(), &["branch", "-M", "work"]);
    assert_eq!(repo.default_branch().unwrap().as_deref(), Some("work"));
    git(dir.path(), &["switch", "-q", "--detach", &id]);
    assert_eq!(repo.default_branch().unwrap(), None);
}

#[test]
fn merge_base_of_branch_and_base() {
    let (main, wt, repo, base) = with_worktree();
    let w = wt.path().join("wt");
    fs::write(w.join("t.txt"), "t\n").unwrap();
    commit_all(&w, "on task");
    fs::write(main.path().join("m.txt"), "m\n").unwrap();
    commit_all(main.path(), "on main");
    assert_eq!(
        repo.merge_base("task", "HEAD").unwrap().as_deref(),
        Some(base.as_str())
    );
    assert_eq!(repo.merge_base("task", "nope").unwrap(), None);
}

#[test]
fn branch_name_checks() {
    let (_main, _wt, repo, _base) = with_worktree();
    assert!(repo.branch_exists("task").unwrap());
    assert!(!repo.branch_exists("nope").unwrap());
    assert!(repo.valid_branch_name("fix/login-2").unwrap());
    for bad in ["-b", "a..b", "a b", "a~1", "", "@{-1}", "a\0b"] {
        assert!(!repo.valid_branch_name(bad).unwrap(), "{bad:?}");
    }
}

#[test]
fn changes_since_takes_committed_staged_unstaged_and_untracked() {
    // `with_worktree` seeds only `a.txt`; this one also needs `seed.txt`.
    let dir = repo_dir();
    fs::write(dir.path().join("a.txt"), "a\n").unwrap();
    fs::write(dir.path().join("seed.txt"), "seed\n").unwrap();
    let base = commit_all(dir.path(), "A");
    let wt = TempDir::with_prefix("wt parent ").unwrap();
    let w = wt.path().join("wt");
    Repo::discover(dir.path())
        .unwrap()
        .add_worktree(&w, "task", &base)
        .unwrap();
    fs::write(w.join("a.txt"), "changed\n").unwrap();
    commit_all(&w, "committed on the branch");
    fs::write(w.join("b.txt"), "staged\n").unwrap();
    git(&w, &["add", "b.txt"]);
    fs::write(w.join("c.txt"), "untracked\n").unwrap();
    fs::remove_file(w.join("seed.txt")).unwrap();
    let repo = Repo::discover(&w).unwrap();
    let got: Vec<(String, ChangeKind)> = repo
        .changes_since(&base)
        .unwrap()
        .into_iter()
        .map(|s| (s.path, s.kind))
        .collect();
    assert_eq!(
        got,
        vec![
            ("a.txt".into(), ChangeKind::Modified),
            ("b.txt".into(), ChangeKind::Added),
            ("c.txt".into(), ChangeKind::Added),
            ("seed.txt".into(), ChangeKind::Deleted),
        ]
    );
}

#[test]
fn changes_since_refuses_a_name() {
    let (_main, wt, _repo, _base) = with_worktree();
    let repo = Repo::discover(&wt.path().join("wt")).unwrap();
    assert!(matches!(
        repo.changes_since("main"),
        Err(GitError::BadId(_))
    ));
}

#[test]
fn changes_since_from_a_subfolder_uses_top_relative_paths() {
    let (_main, wt, _repo, base) = with_worktree();
    let w = wt.path().join("wt");
    fs::create_dir_all(w.join("sub")).unwrap();
    fs::write(w.join("sub/n.txt"), "n\n").unwrap();
    fs::write(w.join("top.txt"), "t\n").unwrap();
    let repo = Repo::discover(&w.join("sub")).unwrap();
    let got: Vec<String> = repo
        .changes_since(&base)
        .unwrap()
        .into_iter()
        .map(|s| s.path)
        .collect();
    assert_eq!(got, ["sub/n.txt", "top.txt"]);
}
