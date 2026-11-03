use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use xdev_git::Repo;
use xdev_workspace::{
    Registry, WorktreeStat, add_repo, create_worktree, forget_repo, list, remove_worktree,
    set_pinned, stat,
};

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

/// A repo in `<tmp>/main`, so the worktree root `<tmp>/wt` stays inside the
/// temp dir. The temp dir lives as long as this value.
struct TestRepo {
    _tmp: TempDir,
    main: PathBuf,
}

impl TestRepo {
    fn path(&self) -> &Path {
        &self.main
    }
}

/// A fresh repo with its own identity, so tests never read the developer's
/// global config, and without autocrlf, which would rewrite line endings.
fn repo_dir() -> TestRepo {
    let tmp = TempDir::with_prefix("ws repo ").unwrap();
    let main = tmp.path().join("main");
    fs::create_dir(&main).unwrap();
    init(&main);
    TestRepo { _tmp: tmp, main }
}

fn init(dir: &Path) {
    git(dir, &["init", "-q"]);
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(dir, &["config", key, value]);
    }
}

fn commit_all(dir: &Path, message: &str) -> String {
    fs::write(dir.join("a.txt"), message).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
    git(dir, &["rev-parse", "HEAD"]).trim().to_owned()
}

/// A repo with one commit, added to a fresh registry.
fn registered() -> (Registry, String, TestRepo) {
    let main = repo_dir();
    commit_all(main.path(), "one");
    let mut reg = Registry::default();
    let id = add_repo(&mut reg, main.path(), 0).unwrap().id;
    (reg, id, main)
}

fn names(reg: &mut Registry) -> Vec<String> {
    list(reg).unwrap()[0]
        .worktrees
        .iter()
        .map(|w| w.name.clone())
        .collect()
}

#[test]
fn add_repo_imports_existing_worktrees() {
    let main = repo_dir();
    commit_all(main.path(), "one");
    git(
        main.path(),
        &["worktree", "add", "-q", "-b", "hand", "../hand"],
    );
    let mut reg = Registry::default();
    let view = add_repo(&mut reg, main.path(), 0).unwrap();
    assert_eq!(view.worktrees.len(), 2);
    assert!(view.worktrees[0].primary);
    assert_eq!(view.worktrees[1].branch.as_deref(), Some("hand"));
    assert!(!reg.worktrees[0].made_here);
}

#[test]
fn add_repo_twice_is_refused() {
    let main = repo_dir();
    commit_all(main.path(), "one");
    let mut reg = Registry::default();
    add_repo(&mut reg, main.path(), 0).unwrap();
    assert_eq!(
        add_repo(&mut reg, &main.path().join("."), 0)
            .unwrap_err()
            .code(),
        "repo_exists"
    );
}

#[test]
fn add_repo_names_it_after_its_folder_and_keeps_names_unique() {
    let tmp = TempDir::new().unwrap();
    let mut reg = Registry::default();
    let mut short_names = Vec::new();
    for parent in ["a", "b"] {
        let dir = tmp.path().join(parent).join("My Repo");
        fs::create_dir_all(&dir).unwrap();
        init(&dir);
        commit_all(&dir, "one");
        short_names.push(add_repo(&mut reg, &dir, 0).unwrap().short_name);
    }
    assert_eq!(short_names, ["my-repo", "my-repo-2"]);
    assert_eq!(reg.repos[0].worktree_root, tmp.path().join("a").join("wt"));
}

#[test]
fn create_worktree_from_base_ref_under_root() {
    let (mut reg, id, main) = registered();
    let wt = create_worktree(&mut reg, &id, "Fix login", None, 1, 0).unwrap();
    assert_eq!(wt.branch.as_deref(), Some("fix-login"));
    assert_eq!(wt.name, "fix-login");
    assert!(Path::new(&wt.path).starts_with(main.path().parent().unwrap().join("wt")));
    assert_eq!(
        wt.start,
        Repo::discover(main.path()).unwrap().head_id().unwrap()
    );
    assert!(reg.worktrees[0].made_here);
}

#[test]
fn blank_name_gets_a_free_word() {
    let (mut reg, id, _main) = registered();
    let a = create_worktree(&mut reg, &id, "  ", None, 1, 7).unwrap();
    let b = create_worktree(&mut reg, &id, "", None, 2, 7).unwrap();
    assert_ne!(a.branch, b.branch);
}

#[test]
fn create_refuses_existing_branch_bad_ref_and_bad_name() {
    let (mut reg, id, main) = registered();
    git(main.path(), &["branch", "taken"]);
    let code = |reg: &mut Registry, name: &str, from: Option<&str>| {
        create_worktree(reg, &id, name, from, 1, 0)
            .unwrap_err()
            .code()
    };
    assert_eq!(code(&mut reg, "taken", None), "branch_exists");
    assert_eq!(code(&mut reg, "x", Some("--upload-pack=y")), "bad_ref");
    assert_eq!(code(&mut reg, "x", Some("no-such")), "bad_ref");
    assert_eq!(code(&mut reg, "...", None), "bad_name");
    // `slug` collapses `a..b` to `a.b`; a part starting with `.` still
    // reaches git and is refused there.
    assert_eq!(code(&mut reg, "a/.b", None), "bad_name");
    assert!(reg.worktrees.is_empty());
}

#[test]
fn create_refuses_an_existing_folder() {
    let (mut reg, id, main) = registered();
    fs::create_dir_all(main.path().parent().unwrap().join("wt").join("main-here")).unwrap();
    assert_eq!(
        create_worktree(&mut reg, &id, "here", None, 1, 0)
            .unwrap_err()
            .code(),
        "worktree_exists"
    );
}

#[test]
fn create_from_another_branch_starts_at_that_commit() {
    let (mut reg, id, main) = registered();
    let first = git(main.path(), &["rev-parse", "HEAD"]).trim().to_owned();
    git(main.path(), &["branch", "side"]);
    let second = commit_all(main.path(), "two");
    let wt = create_worktree(&mut reg, &id, "from-side", Some("side"), 1, 0).unwrap();
    assert_eq!(wt.start.as_deref(), Some(first.as_str()));
    assert_ne!(wt.start.as_deref(), Some(second.as_str()));
}

#[test]
fn remove_refuses_primary() {
    let (mut reg, _id, main) = registered();
    assert_eq!(
        remove_worktree(&mut reg, main.path(), true)
            .unwrap_err()
            .code(),
        "primary_worktree"
    );
}

#[test]
fn unknown_paths_are_refused() {
    let (mut reg, _id, main) = registered();
    let nowhere = main.path().join("nowhere");
    assert_eq!(
        remove_worktree(&mut reg, &nowhere, true)
            .unwrap_err()
            .code(),
        "worktree_unknown"
    );
    assert_eq!(
        set_pinned(&mut reg, &nowhere, true).unwrap_err().code(),
        "worktree_unknown"
    );
}

#[test]
fn remove_dirty_needs_force_and_deletes_branch() {
    let (mut reg, id, main) = registered();
    let wt = create_worktree(&mut reg, &id, "dirty", None, 1, 0).unwrap();
    fs::write(Path::new(&wt.path).join("new.txt"), "x").unwrap();
    assert_eq!(
        remove_worktree(&mut reg, Path::new(&wt.path), false)
            .unwrap_err()
            .code(),
        "worktree_dirty"
    );
    remove_worktree(&mut reg, Path::new(&wt.path), true).unwrap();
    assert!(!Path::new(&wt.path).exists());
    assert!(reg.worktrees.is_empty());
    assert!(
        !Repo::discover(main.path())
            .unwrap()
            .branch_exists("dirty")
            .unwrap()
    );
}

#[test]
fn remove_clean_worktree_without_force() {
    let (mut reg, id, _main) = registered();
    let wt = create_worktree(&mut reg, &id, "clean", None, 1, 0).unwrap();
    remove_worktree(&mut reg, Path::new(&wt.path), false).unwrap();
    assert!(!Path::new(&wt.path).exists());
}

#[test]
fn remove_keeps_the_branch_of_an_imported_worktree() {
    let main = repo_dir();
    commit_all(main.path(), "one");
    git(
        main.path(),
        &["worktree", "add", "-q", "-b", "hand", "../hand"],
    );
    let mut reg = Registry::default();
    let view = add_repo(&mut reg, main.path(), 0).unwrap();
    let path = view.worktrees[1].path.clone();
    remove_worktree(&mut reg, Path::new(&path), false).unwrap();
    assert!(!Path::new(&path).exists());
    assert!(
        Repo::discover(main.path())
            .unwrap()
            .branch_exists("hand")
            .unwrap()
    );
}

#[test]
fn list_drops_meta_of_worktrees_removed_outside() {
    let (mut reg, id, main) = registered();
    let wt = create_worktree(&mut reg, &id, "gone", None, 1, 0).unwrap();
    git(main.path(), &["worktree", "remove", "--force", &wt.path]);
    let repos = list(&mut reg).unwrap();
    assert_eq!(repos[0].worktrees.len(), 1);
    assert_eq!(reg.worktrees.len(), 0);
}

#[test]
fn list_adopts_a_worktree_made_outside() {
    let (mut reg, _id, main) = registered();
    git(
        main.path(),
        &["worktree", "add", "-q", "-b", "late", "../late"],
    );
    let repos = list(&mut reg).unwrap();
    assert_eq!(repos[0].worktrees.len(), 2);
    assert_eq!(repos[0].worktrees[1].branch.as_deref(), Some("late"));
    assert_eq!(reg.worktrees.len(), 1);
    assert!(!reg.worktrees[0].made_here);
}

#[test]
fn list_shows_a_missing_repo_and_keeps_it() {
    let (mut reg, _id, main) = registered();
    reg.repos[0].path = main.path().parent().unwrap().join("nope");
    let repos = list(&mut reg).unwrap();
    assert!(repos[0].missing);
    assert!(repos[0].worktrees.is_empty());
    assert_eq!(reg.repos.len(), 1);
}

#[test]
fn pinned_sort_first() {
    let (mut reg, id, _main) = registered();
    let a = create_worktree(&mut reg, &id, "a", None, 1, 0).unwrap();
    create_worktree(&mut reg, &id, "b", None, 2, 0).unwrap();
    // Newest first until one is pinned.
    assert_eq!(names(&mut reg)[1], "b");
    set_pinned(&mut reg, Path::new(&a.path), true).unwrap();
    assert_eq!(names(&mut reg)[1], "a"); // [0] is the primary checkout
}

#[test]
fn forget_repo_drops_entry_and_metas_but_not_folders() {
    let (mut reg, id, _main) = registered();
    let wt = create_worktree(&mut reg, &id, "keep", None, 1, 0).unwrap();
    forget_repo(&mut reg, &id).unwrap();
    assert!(reg.repos.is_empty() && reg.worktrees.is_empty());
    assert!(Path::new(&wt.path).exists());
    assert_eq!(
        forget_repo(&mut reg, &id).unwrap_err().code(),
        "repo_unknown"
    );
}

/// A worktree with one commit of its own on branch `work`.
fn worktree_with_commit() -> (Registry, TestRepo, String, Repo) {
    let (mut reg, id, main) = registered();
    let wt = create_worktree(&mut reg, &id, "work", None, 1, 0).unwrap();
    commit_all(Path::new(&wt.path), "only here");
    let repo = Repo::discover(main.path()).unwrap();
    (reg, main, wt.path, repo)
}

#[test]
fn remove_without_force_keeps_a_branch_with_unmerged_commits() {
    let (mut reg, _main, path, repo) = worktree_with_commit();
    remove_worktree(&mut reg, Path::new(&path), false).unwrap();
    assert!(!Path::new(&path).exists());
    assert!(reg.worktrees.is_empty());
    assert!(repo.branch_exists("work").unwrap());
}

#[test]
fn remove_with_force_deletes_a_branch_with_unmerged_commits() {
    let (mut reg, _main, path, repo) = worktree_with_commit();
    remove_worktree(&mut reg, Path::new(&path), true).unwrap();
    assert!(!repo.branch_exists("work").unwrap());
}

#[test]
fn remove_without_force_deletes_a_merged_branch() {
    let (mut reg, main, path, repo) = worktree_with_commit();
    git(main.path(), &["merge", "-q", "--ff-only", "work"]);
    remove_worktree(&mut reg, Path::new(&path), false).unwrap();
    assert!(!repo.branch_exists("work").unwrap());
}

/// A directory link: a junction on Windows (no privilege needed), a symlink
/// elsewhere. `None` when the system refuses.
fn link_dir(target: &Path, link: &Path) -> Option<()> {
    #[cfg(windows)]
    let made = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .ok()?
        .status
        .success();
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target, link).is_ok();
    made.then_some(())
}

#[test]
fn records_survive_a_repo_added_through_a_link() {
    let tmp = TempDir::with_prefix("ws link ").unwrap();
    let real = tmp.path().join("real");
    let repo_path = real.join("main");
    fs::create_dir_all(&repo_path).unwrap();
    init(&repo_path);
    commit_all(&repo_path, "one");
    let link = tmp.path().join("link");
    if link_dir(&real, &link).is_none() {
        eprintln!("skipped: cannot make a directory link here");
        return;
    }
    // The caller's spelling goes through the link; git's does not.
    let mut reg = Registry::default();
    let id = add_repo(&mut reg, &link.join("main"), 0).unwrap().id;
    let wt = create_worktree(&mut reg, &id, "kept", None, 1, 0).unwrap();
    set_pinned(&mut reg, Path::new(&wt.path), true).unwrap();
    let repos = list(&mut reg).unwrap();
    assert!(!repos[0].missing);
    assert_eq!(reg.worktrees.len(), 1);
    assert!(reg.worktrees[0].made_here && reg.worktrees[0].pinned);
    assert_eq!(repos[0].worktrees[1].name, "kept");
    assert!(repos[0].worktrees[1].pinned);
    // Removing it still deletes the branch the app made.
    remove_worktree(&mut reg, Path::new(&wt.path), false).unwrap();
    assert!(
        !Repo::discover(&repo_path)
            .unwrap()
            .branch_exists("kept")
            .unwrap()
    );
}

#[test]
fn add_repo_from_a_linked_worktree_tracks_the_primary() {
    let (mut reg, id, main) = registered();
    let wt = create_worktree(&mut reg, &id, "side", None, 1, 0).unwrap();
    let mut other = Registry::default();
    let view = add_repo(&mut other, Path::new(&wt.path), 0).unwrap();
    assert_eq!(view.id, id);
    assert_eq!(view.short_name, "main");
    assert_eq!(Path::new(&view.path), main.path());
    assert!(view.worktrees[0].primary);
    assert_eq!(view.worktrees.len(), 2);
}

#[test]
fn a_repo_path_inside_another_repo_is_missing() {
    let (mut reg, _id, main) = registered();
    let inner = main.path().join("inner");
    fs::create_dir(&inner).unwrap();
    git(main.path(), &["worktree", "add", "-q", "-b", "x", "../x"]);
    reg.repos[0].path = inner;
    let repos = list(&mut reg).unwrap();
    assert!(repos[0].missing);
    assert!(repos[0].worktrees.is_empty());
    assert!(reg.worktrees.is_empty());
}

#[test]
fn stat_counts_added_removed_and_untracked() {
    let (mut reg, id, _main) = registered();
    let wt = create_worktree(&mut reg, &id, "work", None, 1, 0).unwrap();
    let dir = Path::new(&wt.path);
    // `a.txt` held one line; two replace it.
    fs::write(
        dir.join("a.txt"),
        "x
y
",
    )
    .unwrap();
    fs::write(
        dir.join("new.txt"),
        "1
2
3
",
    )
    .unwrap();
    assert_eq!(
        stat(&reg, dir).unwrap(),
        WorktreeStat {
            files: 2,
            added: 5,
            removed: 1
        }
    );
}

#[test]
fn stat_of_the_primary_checkout_is_against_head() {
    let (reg, _id, main) = registered();
    assert_eq!(
        stat(&reg, main.path()).unwrap(),
        WorktreeStat {
            files: 0,
            added: 0,
            removed: 0
        }
    );
    fs::write(
        main.path().join("a.txt"),
        "one
two
",
    )
    .unwrap();
    assert_eq!(stat(&reg, main.path()).unwrap().files, 1);
}

#[test]
fn stat_refuses_unknown_worktree() {
    let (reg, _id, main) = registered();
    let other = main.path().join("nowhere");
    let err = stat(&reg, &other).unwrap_err();
    assert_eq!(err.code(), "worktree_unknown");
}
