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

/// An empty folder with no identity of its own.
fn bare_dir() -> TempDir {
    TempDir::with_prefix("git new ").unwrap()
}

fn set_identity(dir: &Path) {
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
    ] {
        git(dir, &["config", key, value]);
    }
}

#[test]
fn init_on_names_the_first_branch() {
    let dir = bare_dir();
    let repo = Repo::init_on(dir.path(), "trunk").unwrap();
    assert_eq!(repo.current_branch().unwrap().as_deref(), Some("trunk"));
    let other = bare_dir();
    let repo = Repo::init_on(other.path(), "feature/x").unwrap();
    assert_eq!(repo.current_branch().unwrap().as_deref(), Some("feature/x"));
}

#[test]
fn commit_empty_makes_one_commit() {
    let dir = bare_dir();
    let repo = Repo::init_on(dir.path(), "main").unwrap();
    set_identity(dir.path());
    let id = repo.commit_empty("Initial commit").unwrap();
    assert_eq!(git(dir.path(), &["rev-parse", "HEAD"]).trim(), id);
    assert_eq!(
        git(dir.path(), &["rev-list", "--count", "HEAD"]).trim(),
        "1"
    );
    assert_eq!(
        git(dir.path(), &["log", "-1", "--format=%s"]).trim(),
        "Initial commit"
    );
    assert_eq!(
        git(dir.path(), &["show", "--stat", "--format=", "HEAD"]).trim(),
        ""
    );
}

/// Runs `commit_empty_without_identity_child` with a global config that has
/// no identity and forbids guessing one (macOS git guesses from the host
/// name), so a developer's own identity cannot make it pass.
#[test]
fn commit_empty_without_identity_is_identity() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("gitconfig");
    fs::write(
        &file,
        "[user]
	useConfigOnly = true
",
    )
    .unwrap();
    let out = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "commit_empty_without_identity_child",
        ])
        .env("GIT_CONFIG_GLOBAL", &file)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", dir.path())
        .env("XDG_CONFIG_HOME", dir.path())
        .env_remove("GIT_AUTHOR_NAME")
        .env_remove("GIT_AUTHOR_EMAIL")
        .env_remove("GIT_COMMITTER_NAME")
        .env_remove("GIT_COMMITTER_EMAIL")
        .env_remove("EMAIL")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success() && stdout.contains("1 passed"),
        "{stdout}{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
#[ignore]
fn commit_empty_without_identity_child() {
    let dir = bare_dir();
    let repo = Repo::init_on(dir.path(), "main").unwrap();
    assert!(matches!(
        repo.commit_empty("x").unwrap_err(),
        GitError::Identity
    ));
    // Nothing was committed.
    assert!(git(dir.path(), &["branch", "--list"]).trim().is_empty());
}

#[test]
fn move_worktree_changes_the_folder() {
    let (_dir, wt_parent, repo, base) = with_worktree();
    let from = wt_parent.path().join("stage");
    repo.add_worktree(&from, "moved", &base).unwrap();
    let to = wt_parent.path().join("final");
    repo.move_worktree(&from, &to).unwrap();
    assert!(!from.exists());
    assert!(to.join("a.txt").exists());
    let listed = repo.list_worktrees().unwrap();
    let entry = listed
        .iter()
        .find(|e| e.branch.as_deref() == Some("moved"))
        .unwrap();
    assert_eq!(entry.path.file_name().unwrap(), "final");
}

#[test]
fn move_worktree_onto_an_existing_folder_fails() {
    let (_dir, wt_parent, repo, base) = with_worktree();
    let from = wt_parent.path().join("stage");
    repo.add_worktree(&from, "moved", &base).unwrap();
    let to = wt_parent.path().join("taken");
    fs::create_dir(&to).unwrap();
    fs::write(to.join("x"), "x").unwrap();
    assert!(repo.move_worktree(&from, &to).is_err());
    assert!(from.exists());
}

#[test]
fn remove_fresh_worktree_leaves_no_record_or_folder() {
    let (_dir, wt_parent, repo, base) = with_worktree();
    let path = wt_parent.path().join("stage");
    repo.add_worktree(&path, "fresh", &base).unwrap();
    repo.remove_fresh_worktree(&path).unwrap();
    assert!(!path.exists());
    assert!(
        repo.list_worktrees()
            .unwrap()
            .iter()
            .all(|e| e.branch.as_deref() != Some("fresh"))
    );
    // Gone already is fine.
    repo.remove_fresh_worktree(&path).unwrap();
}

#[test]
fn fetch_pull_makes_the_local_branch_and_never_overwrites() {
    let remote = TempDir::with_prefix("remote ").unwrap();
    git(remote.path(), &["init", "-q", "--bare"]);
    let dir = repo_dir();
    fs::write(dir.path().join("a.txt"), "a\n").unwrap();
    let base = commit_all(dir.path(), "A");
    git(
        dir.path(),
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    git(
        dir.path(),
        &["push", "-q", "origin", "HEAD:refs/heads/main"],
    );
    fs::write(dir.path().join("b.txt"), "b\n").unwrap();
    let tip = commit_all(dir.path(), "B");
    git(
        dir.path(),
        &["push", "-q", "origin", &format!("{tip}:refs/pull/7/head")],
    );
    git(dir.path(), &["reset", "-q", "--hard", &base]);
    let repo = Repo::discover(dir.path()).unwrap();
    repo.fetch_pull(7, "feat/seven").unwrap();
    assert_eq!(git(dir.path(), &["rev-parse", "feat/seven"]).trim(), tip);
    // A branch that diverged is refused, not forced.
    git(dir.path(), &["branch", "-f", "other", &base]);
    fs::write(dir.path().join("c.txt"), "c\n").unwrap();
    let local = commit_all(dir.path(), "C");
    git(dir.path(), &["branch", "-f", "other", &local]);
    assert!(repo.fetch_pull(7, "other").is_err());
    assert_eq!(git(dir.path(), &["rev-parse", "other"]).trim(), local);
    assert!(repo.fetch_pull(7, "-bad").is_err());
}

#[test]
fn sparse_set_limits_a_linked_worktree_only() {
    let dir = repo_dir();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::create_dir_all(dir.path().join("docs")).unwrap();
    fs::write(dir.path().join("src/a.txt"), "a\n").unwrap();
    fs::write(dir.path().join("docs/d.txt"), "d\n").unwrap();
    fs::write(dir.path().join("root.txt"), "r\n").unwrap();
    let base = commit_all(dir.path(), "A");
    let parent = TempDir::with_prefix("wt parent ").unwrap();
    let wt = parent.path().join("wt");
    let repo = Repo::discover(dir.path()).unwrap();
    repo.add_worktree_no_checkout(&wt, Some("task"), Some(&base))
        .unwrap();
    let there = Repo::discover(&wt).unwrap();
    there.sparse_set(&["src".to_owned()]).unwrap();
    assert!(wt.join("src/a.txt").exists());
    assert!(wt.join("root.txt").exists());
    assert!(!wt.join("docs").exists());
    assert_eq!(git(&wt, &["status", "--porcelain"]).trim(), "");
    // The main checkout is still full.
    assert!(dir.path().join("docs/d.txt").exists());
    assert_eq!(git(dir.path(), &["status", "--porcelain"]).trim(), "");
    // An existing branch works without `-b`.
    git(dir.path(), &["branch", "old", &base]);
    let wt2 = parent.path().join("wt2");
    repo.add_worktree_no_checkout(&wt2, Some("old"), None)
        .unwrap();
    assert!(
        repo.add_worktree_no_checkout(&parent.path().join("w3"), Some("nope"), None)
            .is_err()
    );
}

/// The linked worktree of `with_worktree`, as its own `Repo`.
fn linked(wt_parent: &TempDir) -> (std::path::PathBuf, Repo) {
    let path = wt_parent.path().join("wt");
    let repo = Repo::discover(&path).unwrap();
    (path, repo)
}

#[test]
fn switch_branch_moves_a_worktree_to_a_local_branch() {
    let (dir, wt_parent, _, base) = with_worktree();
    git(dir.path(), &["branch", "other", &base]);
    let (path, wt) = linked(&wt_parent);
    wt.switch_branch("other").unwrap();
    assert_eq!(wt.current_branch().unwrap().as_deref(), Some("other"));
    // The same branch again is not an error.
    wt.switch_branch("other").unwrap();
    assert_eq!(
        git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "other"
    );
}

#[test]
fn switch_branch_tracks_a_branch_that_only_exists_on_a_remote() {
    let (dir, wt_parent, _, _) = with_worktree();
    let remote = TempDir::with_prefix("remote ").unwrap();
    git(remote.path(), &["init", "-q", "--bare"]);
    git(
        dir.path(),
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    git(
        dir.path(),
        &["push", "-q", "origin", "HEAD:refs/heads/feature"],
    );
    git(dir.path(), &["fetch", "-q", "origin"]);
    let (_, wt) = linked(&wt_parent);
    assert!(!wt.branch_exists("feature").unwrap());
    wt.switch_branch("origin/feature").unwrap();
    assert_eq!(wt.current_branch().unwrap().as_deref(), Some("feature"));
    assert_eq!(
        git(dir.path(), &["config", "branch.feature.remote"]).trim(),
        "origin"
    );
}

#[test]
fn switch_branch_refuses_a_dirty_worktree_and_leaves_it_alone() {
    let (dir, wt_parent, _, base) = with_worktree();
    git(dir.path(), &["branch", "other", &base]);
    let (path, wt) = linked(&wt_parent);
    fs::write(path.join("a.txt"), "edited\n").unwrap();
    let err = wt.switch_branch("other").unwrap_err();
    assert!(matches!(err, GitError::Dirty("checkout")), "{err:?}");
    assert_eq!(err.code(), "update_dirty");
    assert_eq!(wt.current_branch().unwrap().as_deref(), Some("task"));
    assert_eq!(fs::read_to_string(path.join("a.txt")).unwrap(), "edited\n");
}

#[test]
fn switch_branch_refuses_a_branch_another_worktree_has() {
    let (dir, wt_parent, main, _) = with_worktree();
    let held = main.current_branch().unwrap().unwrap();
    let (_, wt) = linked(&wt_parent);
    let err = wt.switch_branch(&held).unwrap_err();
    match &err {
        GitError::BranchInUse { branch, path } => {
            assert_eq!(branch, &held);
            assert!(!path.is_empty() && !path.contains('\''), "{path}");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(err.code(), "branch_in_use");
    assert_eq!(wt.current_branch().unwrap().as_deref(), Some("task"));
    drop(dir);
}

#[test]
fn switch_branch_rejects_names_that_are_not_branches() {
    let (_dir, wt_parent, _, _) = with_worktree();
    let (_, wt) = linked(&wt_parent);
    for name in ["", "nope", "-c", "origin/HEAD", "bad\nname"] {
        let err = wt.switch_branch(name).unwrap_err();
        assert!(matches!(err, GitError::NoSuchBranch(_)), "{name}: {err:?}");
        assert_eq!(err.code(), "no_such_branch");
    }
    assert_eq!(wt.current_branch().unwrap().as_deref(), Some("task"));
}
