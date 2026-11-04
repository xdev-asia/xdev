use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use xdev_git::{BaseRefresh, Repo};
use xdev_workspace::{
    BranchPrefix, CreateOptions, GhAccount, ISSUE_COMMAND_MAX, Registry, RepoIcon, RepoPatch,
    STAGING, ScriptSource, SetupPolicy, Trash, WorkspaceError, WorktreeStat, add_repo,
    adopt_worktree, create_worktree, create_worktree_with, forget_repo, list, name_preview,
    path_key, refresh_base, remove_worktree, set_pinned, stat, sweep_with, update_repo,
    valid_short_name,
};
#[cfg(unix)]
use xdev_workspace::{archive_worktree, create_worktree_linked};

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

/// A temp dir under the long form of the temp path. Windows CI hands out
/// 8.3 names like `RUNNER~1`, while git reports long paths.
fn long_temp_dir(prefix: &str) -> TempDir {
    let base = dunce::canonicalize(std::env::temp_dir()).unwrap();
    TempDir::with_prefix_in(prefix, base).unwrap()
}

/// A fresh repo with its own identity, so tests never read the developer's
/// global config, and without autocrlf, which would rewrite line endings.
fn repo_dir() -> TestRepo {
    let tmp = long_temp_dir("ws repo ");
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
fn add_repo_still_imports_existing_worktrees() {
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
    assert!(view.found.is_empty());
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
    let tmp = long_temp_dir(".tmp");
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
fn only_a_blank_name_marks_the_worktree_auto_named() {
    let (mut reg, id, _main) = registered();
    let auto = create_worktree(&mut reg, &id, "", None, 1, 7).unwrap();
    assert!(auto.auto_name);
    assert!(reg.worktrees[0].auto_name);
    let typed = create_worktree(&mut reg, &id, "typed-name", None, 2, 7).unwrap();
    assert!(!typed.auto_name);
    assert!(!reg.worktrees[1].auto_name);
    // An older registry file has no such field and reads false.
    let old: xdev_workspace::WorktreeMeta = serde_json::from_str(
        r#"{"repo_id":"r","path":"/p","start":"s","pinned":false,"created_ms":0,"made_here":true}"#,
    )
    .unwrap();
    assert!(!old.auto_name);
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
        remove_worktree(&mut reg, main.path(), true, 0)
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
        remove_worktree(&mut reg, &nowhere, true, 0)
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
        remove_worktree(&mut reg, Path::new(&wt.path), false, 0)
            .unwrap_err()
            .code(),
        "worktree_dirty"
    );
    remove_worktree(&mut reg, Path::new(&wt.path), true, 0).unwrap();
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
    remove_worktree(&mut reg, Path::new(&wt.path), false, 0).unwrap();
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
    remove_worktree(&mut reg, Path::new(&path), false, 0).unwrap();
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

/// Makes a linked worktree the way a person does in a terminal; returns its
/// folder in git's spelling.
fn outside_worktree(main: &Path, branch: &str) -> PathBuf {
    git(
        main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            branch,
            &format!("../{branch}"),
        ],
    );
    Repo::discover(main)
        .unwrap()
        .list_worktrees()
        .unwrap()
        .into_iter()
        .find(|e| e.branch.as_deref() == Some(branch))
        .unwrap()
        .path
}

#[test]
fn list_reports_unknown_worktree_as_found() {
    let (mut reg, _id, main) = registered();
    let outside = outside_worktree(main.path(), "late");
    let key = path_key(&outside);
    let views = list(&mut reg).unwrap();
    assert_eq!(views[0].found.len(), 1);
    let found = &views[0].found[0];
    assert_eq!(found.branch.as_deref(), Some("late"));
    assert_eq!(found.start, None);
    assert!(!found.pinned);
    assert!(!found.primary);
    assert!(
        views[0]
            .worktrees
            .iter()
            .all(|w| path_key(Path::new(&w.path)) != key)
    );
    assert!(reg.worktrees.iter().all(|m| path_key(&m.path) != key));
    // Asking again still does not record it.
    assert_eq!(list(&mut reg).unwrap()[0].found.len(), 1);
    assert!(reg.worktrees.is_empty());
}

#[test]
fn found_is_sorted_by_path() {
    let (mut reg, _id, main) = registered();
    outside_worktree(main.path(), "zeta");
    outside_worktree(main.path(), "alpha");
    let found = &list(&mut reg).unwrap()[0].found;
    let paths: Vec<&str> = found.iter().map(|w| w.path.as_str()).collect();
    let mut sorted = paths.clone();
    sorted.sort();
    assert_eq!(paths.len(), 2);
    assert_eq!(paths, sorted);
}

#[test]
fn list_keeps_a_worktree_it_already_recorded_out_of_found() {
    let (mut reg, id, _main) = registered();
    create_worktree(&mut reg, &id, "mine", None, 1, 0).unwrap();
    let views = list(&mut reg).unwrap();
    assert!(views[0].found.is_empty());
    assert_eq!(views[0].worktrees.len(), 2);
}

#[test]
fn adopt_records_once() {
    let (mut reg, _id, main) = registered();
    let outside = outside_worktree(main.path(), "late");
    let wt = adopt_worktree(&mut reg, &outside, 42).unwrap();
    assert!(wt.start.is_some());
    assert!(!wt.primary);
    assert_eq!(wt.branch.as_deref(), Some("late"));
    assert_eq!(reg.worktrees.len(), 1);
    assert!(!reg.worktrees[0].made_here);
    assert_eq!(reg.worktrees[0].created_ms, 42);
    let views = list(&mut reg).unwrap();
    assert!(views[0].found.is_empty());
    assert_eq!(views[0].worktrees.len(), 2);
    assert!(matches!(
        adopt_worktree(&mut reg, &outside, 43),
        Err(WorkspaceError::WorktreeExists(_))
    ));
    assert_eq!(reg.worktrees.len(), 1);
}

#[test]
fn adopt_refuses_primary_and_unknown() {
    let (mut reg, _id, main) = registered();
    assert!(matches!(
        adopt_worktree(&mut reg, main.path(), 1),
        Err(WorkspaceError::Primary(_))
    ));
    let tmp = long_temp_dir(".tmp");
    assert!(matches!(
        adopt_worktree(&mut reg, tmp.path(), 1),
        Err(WorkspaceError::WorktreeUnknown(_))
    ));
    assert!(reg.worktrees.is_empty());
}

#[test]
fn adopted_worktree_keeps_its_branch_on_remove() {
    let (mut reg, _id, main) = registered();
    let outside = outside_worktree(main.path(), "late");
    adopt_worktree(&mut reg, &outside, 1).unwrap();
    remove_worktree(&mut reg, &outside, false, 0).unwrap();
    assert!(
        Repo::discover(main.path())
            .unwrap()
            .branch_exists("late")
            .unwrap()
    );
}

#[test]
fn update_does_not_import_a_worktree_made_outside() {
    let (mut reg, id, main) = registered();
    outside_worktree(main.path(), "late");
    let view = update_repo(
        &mut reg,
        &id,
        RepoPatch {
            short_name: Some("core".into()),
            ..RepoPatch::default()
        },
    )
    .unwrap();
    assert_eq!(view.found.len(), 1);
    assert!(reg.worktrees.is_empty());
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
    remove_worktree(&mut reg, Path::new(&path), false, 0).unwrap();
    assert!(!Path::new(&path).exists());
    assert!(reg.worktrees.is_empty());
    assert!(repo.branch_exists("work").unwrap());
}

#[test]
fn remove_with_force_deletes_a_branch_with_unmerged_commits() {
    let (mut reg, _main, path, repo) = worktree_with_commit();
    remove_worktree(&mut reg, Path::new(&path), true, 0).unwrap();
    assert!(!repo.branch_exists("work").unwrap());
}

#[test]
fn remove_without_force_deletes_a_merged_branch() {
    let (mut reg, main, path, repo) = worktree_with_commit();
    git(main.path(), &["merge", "-q", "--ff-only", "work"]);
    remove_worktree(&mut reg, Path::new(&path), false, 0).unwrap();
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
    remove_worktree(&mut reg, Path::new(&wt.path), false, 0).unwrap();
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

/// A second repo, added to `reg`; returns its id.
fn add_second(reg: &mut Registry) -> (String, TestRepo) {
    let other = repo_dir();
    commit_all(other.path(), "two");
    let id = add_repo(reg, other.path(), 0).unwrap().id;
    (id, other)
}

#[test]
fn update_changes_short_name_base_ref_and_root() {
    let (mut reg, id, main) = registered();
    git(main.path(), &["branch", "dev"]);
    let abs_root = main.path().parent().unwrap().join("elsewhere");
    let view = update_repo(
        &mut reg,
        &id,
        RepoPatch {
            short_name: Some("core".into()),
            base_ref: Some("dev".into()),
            worktree_root: Some(abs_root.clone()),
            ..RepoPatch::default()
        },
    )
    .unwrap();
    assert_eq!(view.short_name, "core");
    assert_eq!(view.base_ref, "dev");
    assert_eq!(view.worktree_root, abs_root.to_string_lossy());
    assert_eq!(reg.repos[0].short_name, "core");
    assert_eq!(reg.repos[0].base_ref, "dev");
    assert_eq!(reg.repos[0].worktree_root, abs_root);
}

#[test]
fn update_refuses_a_docs_dir_that_is_a_shared_vault() {
    let (mut reg, id, main) = registered();
    let shared = main.path().join("handbook");
    fs::create_dir(&shared).unwrap();
    xdev_workspace::add_vault(&mut reg, &shared).unwrap();
    let before = reg.clone();
    let err = update_repo(
        &mut reg,
        &id,
        RepoPatch {
            docs_dir: Some("handbook".into()),
            ..RepoPatch::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code(), "vault_exists");
    assert_eq!(reg, before);
    // A reset to the default folder is checked the same way.
    let default = main.path().join("docs");
    fs::create_dir(&default).unwrap();
    reg.repos[0].docs_dir = Some("other".into());
    reg.vaults.clear();
    reg.vaults.push(xdev_workspace::VaultEntry {
        id: "x".into(),
        path: default,
    });
    let before = reg.clone();
    let err = update_repo(
        &mut reg,
        &id,
        RepoPatch {
            docs_dir: Some(String::new()),
            ..RepoPatch::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code(), "vault_exists");
    assert_eq!(reg, before);
}

#[test]
fn update_with_an_empty_patch_changes_nothing() {
    let (mut reg, id, _main) = registered();
    let before = reg.clone();
    let view = update_repo(&mut reg, &id, RepoPatch::default()).unwrap();
    assert_eq!(reg, before);
    assert_eq!(view.id, id);
}

#[test]
fn update_keeps_the_own_short_name_and_refuses_unknown_repo() {
    let (mut reg, id, _main) = registered();
    let own = reg.repos[0].short_name.clone();
    let patch = RepoPatch {
        short_name: Some(own),
        ..RepoPatch::default()
    };
    assert!(update_repo(&mut reg, &id, patch.clone()).is_ok());
    assert_eq!(
        update_repo(&mut reg, "nope", patch).unwrap_err().code(),
        "repo_unknown"
    );
}

#[test]
fn update_refuses_taken_short_name() {
    let (mut reg, a, _main) = registered();
    let (b, _other) = add_second(&mut reg);
    let a_name = reg
        .repos
        .iter()
        .find(|r| r.id == a)
        .unwrap()
        .short_name
        .clone();
    let before = reg.clone();
    let err = update_repo(
        &mut reg,
        &b,
        RepoPatch {
            short_name: Some(a_name),
            ..RepoPatch::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code(), "short_name_taken");
    assert_eq!(reg, before);
}

#[test]
fn update_refuses_bad_short_name() {
    let (mut reg, id, _main) = registered();
    let before = reg.clone();
    let long = "a".repeat(41);
    for bad in ["", "Xdev", "x:y", "a b", "-x", "a/b", long.as_str()] {
        let err = update_repo(
            &mut reg,
            &id,
            RepoPatch {
                short_name: Some(bad.into()),
                ..RepoPatch::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.code(), "bad_name", "{bad:?}");
        assert_eq!(reg, before);
    }
}

#[test]
fn valid_short_names() {
    for good in ["a", "xdev", "x.y_z-1", "0ab", &"a".repeat(40)] {
        assert!(valid_short_name(good), "{good:?}");
    }
    for bad in ["", "Xdev", "x:y", "a b", "-x", ".x", "a/b", &"a".repeat(41)] {
        assert!(!valid_short_name(bad), "{bad:?}");
    }
}

#[test]
fn update_refuses_unresolved_base_ref() {
    let (mut reg, id, _main) = registered();
    let before = reg.clone();
    for bad in ["nope", "--upload-pack=x", ""] {
        let err = update_repo(
            &mut reg,
            &id,
            RepoPatch {
                base_ref: Some(bad.into()),
                ..RepoPatch::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.code(), "bad_ref", "{bad:?}");
        assert_eq!(reg, before);
    }
}

#[test]
fn update_refuses_root_inside_primary_or_relative() {
    let (mut reg, id, main) = registered();
    let before = reg.clone();
    for bad in [
        main.path().join("wt"),
        main.path().to_path_buf(),
        PathBuf::from("wt"),
    ] {
        let err = update_repo(
            &mut reg,
            &id,
            RepoPatch {
                worktree_root: Some(bad.clone()),
                ..RepoPatch::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.code(), "bad_path", "{bad:?}");
        assert_eq!(reg, before);
    }
}

#[test]
fn update_sets_the_script_settings() {
    let (mut reg, id, _main) = registered();
    let view = update_repo(
        &mut reg,
        &id,
        RepoPatch {
            setup_policy: Some(SetupPolicy::Skip),
            script_source: Some(ScriptSource::Both),
            local_setup: Some("pnpm install\nmake".into()),
            local_archive: Some("echo bye".into()),
            ..RepoPatch::default()
        },
    )
    .unwrap();
    assert_eq!(view.setup_policy, SetupPolicy::Skip);
    assert_eq!(view.script_source, ScriptSource::Both);
    assert_eq!(view.local_setup, "pnpm install\nmake");
    assert_eq!(view.local_archive, "echo bye");
    let entry = &reg.repos[0];
    assert_eq!(entry.setup_policy, SetupPolicy::Skip);
    assert_eq!(entry.script_source, ScriptSource::Both);
    assert_eq!(entry.local_setup, "pnpm install\nmake");
    assert_eq!(entry.local_archive, "echo bye");

    // Each field alone leaves the others; an empty script clears it.
    update_repo(
        &mut reg,
        &id,
        RepoPatch {
            local_archive: Some(String::new()),
            ..RepoPatch::default()
        },
    )
    .unwrap();
    let entry = &reg.repos[0];
    assert_eq!(entry.local_archive, "");
    assert_eq!(entry.local_setup, "pnpm install\nmake");
    assert_eq!(entry.setup_policy, SetupPolicy::Skip);
}

#[test]
fn update_writes_nothing_when_a_later_field_fails() {
    let (mut reg, id, _main) = registered();
    let before = reg.clone();
    let err = update_repo(
        &mut reg,
        &id,
        RepoPatch {
            short_name: Some("core".into()),
            base_ref: Some("nope".into()),
            worktree_root: None,
            ..RepoPatch::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code(), "bad_ref");
    assert_eq!(reg, before);
}

#[test]
fn update_root_applies_to_the_next_worktree_only() {
    let (mut reg, id, main) = registered();
    let first = create_worktree(&mut reg, &id, "one", None, 1, 0).unwrap();
    let root = main.path().parent().unwrap().join("moved");
    update_repo(
        &mut reg,
        &id,
        RepoPatch {
            worktree_root: Some(root.clone()),
            ..RepoPatch::default()
        },
    )
    .unwrap();
    let second = create_worktree(&mut reg, &id, "two", None, 2, 0).unwrap();
    assert!(Path::new(&second.path).starts_with(&root));
    assert!(Path::new(&first.path).exists());
}

fn with_prefix(prefix: BranchPrefix) -> CreateOptions {
    CreateOptions {
        prefix,
        ..CreateOptions::default()
    }
}

#[test]
fn custom_prefix_names_the_branch_but_not_the_folder() {
    let (mut reg, id, main) = registered();
    let opts = with_prefix(BranchPrefix::Custom(" /team//me/ ".into()));
    let wt = create_worktree_with(&mut reg, &id, "Fix login", None, 1, 0, &opts).unwrap();
    assert_eq!(wt.branch.as_deref(), Some("team/me/fix-login"));
    assert_eq!(wt.name, "fix-login");
    let folder = main
        .path()
        .parent()
        .unwrap()
        .join("wt")
        .join("main-fix-login");
    assert_eq!(path_key(Path::new(&wt.path)), path_key(&folder));
}

#[test]
fn a_blank_name_gets_a_free_word_under_the_prefix() {
    let (mut reg, id, main) = registered();
    let opts = with_prefix(BranchPrefix::Custom("me".into()));
    let a = create_worktree_with(&mut reg, &id, "", None, 1, 0, &opts).unwrap();
    assert_eq!(a.branch, Some(format!("me/{}", a.name)));
    let b = create_worktree_with(&mut reg, &id, "", None, 2, 0, &opts).unwrap();
    assert_ne!(b.name, a.name);
    // A word whose prefixed branch exists is skipped, even with its folder free.
    git(main.path(), &["branch", "me/ash"]);
    let c = create_worktree_with(&mut reg, &id, "", None, 3, 2, &opts).unwrap();
    assert_eq!(c.name, "fir");
}

#[test]
fn prefixed_branch_that_exists_is_refused() {
    let (mut reg, id, main) = registered();
    git(main.path(), &["branch", "me/taken"]);
    let opts = with_prefix(BranchPrefix::Custom("me".into()));
    let err = create_worktree_with(&mut reg, &id, "taken", None, 1, 0, &opts).unwrap_err();
    assert_eq!(err.code(), "branch_exists");
}

#[test]
fn a_bad_custom_prefix_is_refused_and_points_to_settings() {
    let (mut reg, id, _main) = registered();
    for bad in ["a b", "x..y", "-x", "x.", ".x", "x.lock", "a:b"] {
        let opts = with_prefix(BranchPrefix::Custom(bad.into()));
        let err = create_worktree_with(&mut reg, &id, "fix", None, 1, 0, &opts).unwrap_err();
        assert_eq!(err.code(), "bad_branch_prefix", "{bad}");
        assert!(
            matches!(&err, WorkspaceError::BadPrefix(p) if p == bad.trim()),
            "{bad}"
        );
    }
    assert!(reg.worktrees.is_empty());
}

#[test]
fn a_blank_custom_prefix_adds_nothing() {
    let (mut reg, id, _main) = registered();
    let opts = with_prefix(BranchPrefix::Custom(" / ".into()));
    let wt = create_worktree_with(&mut reg, &id, "fix", None, 1, 0, &opts).unwrap();
    assert_eq!(wt.branch.as_deref(), Some("fix"));
}

#[test]
fn git_username_prefix_uses_the_repo_user_name() {
    let (mut reg, id, main) = registered();
    git(main.path(), &["config", "user.name", "duy"]);
    let opts = with_prefix(BranchPrefix::GitUsername);
    let wt = create_worktree_with(&mut reg, &id, "fix", None, 1, 0, &opts).unwrap();
    assert_eq!(wt.branch.as_deref(), Some("duy/fix"));
}

#[test]
fn an_unusable_git_username_is_skipped_silently() {
    let (mut reg, id, main) = registered();
    // `Test User` has a space, which no ref may hold.
    let opts = with_prefix(BranchPrefix::GitUsername);
    let wt = create_worktree_with(&mut reg, &id, "fix", None, 1, 0, &opts).unwrap();
    assert_eq!(wt.branch.as_deref(), Some("fix"));
    git(main.path(), &["config", "user.name", ""]);
    let wt = create_worktree_with(&mut reg, &id, "two", None, 2, 0, &opts).unwrap();
    assert_eq!(wt.branch.as_deref(), Some("two"));
}

#[test]
fn no_prefix_strategy_adds_nothing() {
    let (mut reg, id, main) = registered();
    git(main.path(), &["config", "user.name", "duy"]);
    let wt = create_worktree_with(
        &mut reg,
        &id,
        "fix",
        None,
        1,
        0,
        &with_prefix(BranchPrefix::None),
    )
    .unwrap();
    assert_eq!(wt.branch.as_deref(), Some("fix"));
}

/// A registered repo whose base branch tracks a bare local `origin`, and a
/// second clone that has pushed one more commit to it. Returns that commit.
/// Nothing here touches the network.
fn behind_origin() -> (Registry, String, TestRepo, TempDir, String) {
    let (reg, id, main) = registered();
    let dir = main.path();
    let branch = git(dir, &["symbolic-ref", "--short", "HEAD"])
        .trim()
        .to_owned();
    let origin = long_temp_dir("ws origin ");
    let url = origin.path().to_str().unwrap().to_owned();
    git(origin.path(), &["init", "-q", "--bare"]);
    git(dir, &["remote", "add", "origin", &url]);
    git(dir, &["push", "-q", "-u", "origin", &branch]);

    let other = origin.path().join("other");
    git(origin.path(), &["clone", "-q", &url, "other"]);
    init(&other);
    let tip = commit_all(&other, "two");
    git(&other, &["push", "-q", "origin", &branch]);
    (reg, id, main, origin, tip)
}

#[test]
fn refresh_base_moves_the_base_a_new_worktree_starts_from() {
    let (mut reg, id, main, _origin, tip) = behind_origin();
    assert_eq!(refresh_base(&reg, &id, None).unwrap(), BaseRefresh::Updated);
    // The base checkout was clean, so it moved in place.
    assert_eq!(git(main.path(), &["rev-parse", "HEAD"]).trim(), tip);
    let wt = create_worktree(&mut reg, &id, "fresh", None, 0, 0).unwrap();
    assert_eq!(wt.head.as_deref(), Some(tip.as_str()));
}

#[test]
fn creating_a_worktree_fetches_nothing_by_itself() {
    let (mut reg, id, main, _origin, tip) = behind_origin();
    let before = git(main.path(), &["rev-parse", "HEAD"]).trim().to_owned();
    let wt = create_worktree(&mut reg, &id, "stale", None, 0, 0).unwrap();
    assert_eq!(wt.head.as_deref(), Some(before.as_str()));
    assert_ne!(before, tip);
}

#[test]
fn refresh_base_that_cannot_fetch_leaves_the_base_alone() {
    let (reg, id, main, origin, _tip) = behind_origin();
    let gone = origin.path().join("missing");
    git(
        main.path(),
        &["remote", "set-url", "origin", gone.to_str().unwrap()],
    );
    let before = git(main.path(), &["rev-parse", "HEAD"]).trim().to_owned();
    assert!(refresh_base(&reg, &id, None).is_err());
    assert_eq!(git(main.path(), &["rev-parse", "HEAD"]).trim(), before);
    assert!(matches!(
        refresh_base(&reg, "nope", None),
        Err(WorkspaceError::RepoUnknown(_))
    ));
}

/// A repo whose main checkout has `node_modules/x` and a `.env.local`, listed
/// as shared in its `xdev.toml`, and a worktree made with those linked.
#[cfg(unix)]
fn with_shared() -> (Registry, TestRepo, PathBuf) {
    let (mut reg, id, main) = registered();
    fs::create_dir_all(main.path().join("node_modules")).unwrap();
    fs::write(main.path().join("node_modules/x"), "dep").unwrap();
    fs::write(main.path().join(".env.local"), "KEY=1").unwrap();
    fs::write(
        main.path().join("xdev.toml"),
        "[worktree]\nshared = [\"node_modules\", \".env.local\"]\n",
    )
    .unwrap();
    let opts = CreateOptions {
        shared: vec!["node_modules".into(), ".env.local".into(), "gone".into()],
        ..CreateOptions::default()
    };
    let (wt, linked) = create_worktree_linked(&mut reg, &id, "work", None, 1, 0, &opts).unwrap();
    assert_eq!(
        linked.iter().map(|l| l.ok).collect::<Vec<_>>(),
        [true, true, false]
    );
    let path = PathBuf::from(wt.path);
    assert_eq!(
        fs::read_to_string(path.join("node_modules/x")).unwrap(),
        "dep"
    );
    (reg, main, path)
}

#[cfg(unix)]
fn main_is_intact(main: &TestRepo) {
    assert_eq!(
        fs::read_to_string(main.path().join("node_modules/x")).unwrap(),
        "dep"
    );
    assert_eq!(
        fs::read_to_string(main.path().join(".env.local")).unwrap(),
        "KEY=1"
    );
}

#[cfg(unix)]
#[test]
fn remove_keeps_the_shared_folder_of_the_main_checkout() {
    let (mut reg, main, path) = with_shared();
    // The links are untracked in the worktree, yet they are not changes.
    remove_worktree(&mut reg, &path, false, 0).unwrap();
    assert!(!path.exists());
    main_is_intact(&main);
}

#[cfg(unix)]
#[test]
fn forced_remove_keeps_the_shared_folder_too() {
    let (mut reg, main, path) = with_shared();
    remove_worktree(&mut reg, &path, true, 0).unwrap();
    assert!(!path.exists());
    main_is_intact(&main);
}

#[cfg(unix)]
#[test]
fn archive_keeps_the_shared_folder_too() {
    let (mut reg, main, path) = with_shared();
    archive_worktree(&mut reg, &path, false, 0).unwrap();
    assert!(!path.exists());
    main_is_intact(&main);
}

#[cfg(unix)]
#[test]
fn a_real_change_still_blocks_remove_and_keeps_the_links() {
    let (mut reg, main, path) = with_shared();
    fs::write(path.join("mine.txt"), "x").unwrap();
    let err = remove_worktree(&mut reg, &path, false, 0).unwrap_err();
    assert!(matches!(err, WorkspaceError::Dirty(_)));
    assert!(path.join("node_modules/x").is_file());
    main_is_intact(&main);
}

fn suffixing() -> CreateOptions {
    CreateOptions {
        suffix: true,
        ..CreateOptions::default()
    }
}

fn make(
    reg: &mut Registry,
    id: &str,
    name: &str,
    opts: &CreateOptions,
) -> xdev_workspace::WorktreeView {
    create_worktree_with(reg, id, name, None, 1, 0, opts).unwrap()
}

#[test]
fn taken_branch_gets_a_suffix_and_the_typed_title() {
    let (mut reg, id, _main) = registered();
    let first = make(&mut reg, &id, "feat one", &suffixing());
    assert_eq!(first.branch.as_deref(), Some("feat-one"));
    assert_eq!(first.title, None);
    let second = make(&mut reg, &id, "feat one", &suffixing());
    assert_eq!(second.branch.as_deref(), Some("feat-one-2"));
    assert!(second.path.ends_with("-feat-one-2"));
    assert_eq!(second.title.as_deref(), Some("feat one"));
    let third = make(&mut reg, &id, "feat one", &suffixing());
    assert_eq!(third.branch.as_deref(), Some("feat-one-3"));
    assert_eq!(third.title.as_deref(), Some("feat one"));
}

#[test]
fn taken_folder_only_gets_a_suffix() {
    let (mut reg, id, _main) = registered();
    let root = list(&mut reg).unwrap()[0].worktree_root.clone();
    let repo = list(&mut reg).unwrap()[0].short_name.clone();
    fs::create_dir_all(Path::new(&root).join(format!("{repo}-hand"))).unwrap();
    let view = make(&mut reg, &id, "hand", &suffixing());
    assert_eq!(view.branch.as_deref(), Some("hand-2"));
}

#[test]
fn a_branch_without_a_worktree_also_counts_as_taken() {
    let (mut reg, id, main) = registered();
    git(main.path(), &["branch", "side"]);
    let view = make(&mut reg, &id, "side", &suffixing());
    assert_eq!(view.branch.as_deref(), Some("side-2"));
}

#[test]
fn ninety_nine_taken_is_branch_exists() {
    let (mut reg, id, main) = registered();
    git(main.path(), &["branch", "busy"]);
    for n in 2..=99 {
        git(main.path(), &["branch", &format!("busy-{n}")]);
    }
    let err = create_worktree_with(&mut reg, &id, "busy", None, 1, 0, &suffixing()).unwrap_err();
    assert!(matches!(err, WorkspaceError::BranchExists(b) if b == "busy"));
}

#[test]
fn a_full_length_name_keeps_its_suffix() {
    let (mut reg, id, _main) = registered();
    let name = "a".repeat(60);
    let first = make(&mut reg, &id, &name, &suffixing());
    assert_eq!(first.branch.as_deref().map(str::len), Some(48));
    let second = make(&mut reg, &id, &name, &suffixing());
    let branch = second.branch.unwrap();
    assert_eq!(branch.len(), 48);
    assert!(branch.ends_with("-2"));
}

#[test]
fn suffix_off_keeps_the_errors() {
    let (mut reg, id, _main) = registered();
    make(&mut reg, &id, "dup", &CreateOptions::default());
    let err = create_worktree_with(&mut reg, &id, "dup", None, 1, 0, &CreateOptions::default())
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::BranchExists(_)));
}

#[test]
fn blank_name_still_picks_a_free_word_without_a_title() {
    let (mut reg, id, _main) = registered();
    let a = make(&mut reg, &id, "", &suffixing());
    let b = make(&mut reg, &id, "  ", &suffixing());
    assert_ne!(a.branch, b.branch);
    assert_eq!(a.title, None);
    assert_eq!(b.title, None);
}

#[test]
fn an_emoji_in_the_typed_name_is_kept_as_the_title() {
    let (mut reg, id, _main) = registered();
    let view = make(&mut reg, &id, "🚀 launch", &suffixing());
    assert_eq!(view.branch.as_deref(), Some("launch"));
    assert_eq!(view.title.as_deref(), Some("🚀 launch"));
}

#[test]
fn preview_shows_the_name_a_create_would_get_and_makes_nothing() {
    let (mut reg, id, _main) = registered();
    let free = name_preview(&reg, &id, "feat one", &suffixing()).unwrap();
    assert_eq!(free.branch, "feat-one");
    assert!(!free.suffixed);
    make(&mut reg, &id, "feat one", &suffixing());
    let taken = name_preview(&reg, &id, "feat one", &suffixing()).unwrap();
    assert_eq!(taken.branch, "feat-one-2");
    assert!(taken.folder.ends_with("-feat-one-2"));
    assert!(taken.suffixed);
    assert_eq!(list(&mut reg).unwrap()[0].worktrees.len(), 2);
    let blank = name_preview(&reg, &id, "  ", &suffixing()).unwrap();
    assert!(!blank.suffixed && blank.branch.is_empty());
    let err = name_preview(&reg, &id, "...", &suffixing()).unwrap_err();
    assert_eq!(err.code(), "bad_name");
    let err = name_preview(&reg, &id, "feat one", &CreateOptions::default()).unwrap_err();
    assert_eq!(err.code(), "branch_exists");
}

fn staging_root(reg: &mut Registry) -> PathBuf {
    Path::new(&list(reg).unwrap()[0].worktree_root).join(STAGING)
}

#[test]
fn a_made_worktree_leaves_no_staging_entry_and_git_lists_the_final_path() {
    let (mut reg, id, main) = registered();
    let view = make(&mut reg, &id, "final", &suffixing());
    assert!(!staging_root(&mut reg).exists());
    assert!(Path::new(&view.path).join("a.txt").exists());
    let listed = git(main.path(), &["worktree", "list", "--porcelain"]);
    assert!(
        listed.contains(&format!("worktree {}", view.path)),
        "{listed}"
    );
    assert!(!listed.contains(STAGING));
}

#[test]
fn the_staging_folder_is_never_found_or_imported() {
    let (mut reg, id, main) = registered();
    let stage = staging_root(&mut reg).join("123-abc");
    git(
        main.path(),
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "half",
            stage.to_str().unwrap(),
        ],
    );
    let view = &list(&mut reg).unwrap()[0];
    assert!(view.found.is_empty());
    assert_eq!(view.worktrees.len(), 1);
    // A repo added while a create is staging does not import it either.
    let mut fresh = Registry::default();
    let added = add_repo(&mut fresh, main.path(), 0).unwrap();
    assert_eq!(added.worktrees.len(), 1);
    assert!(fresh.worktrees.is_empty());
    assert!(!id.is_empty());
}

/// Deletes for real: the test has no trash.
struct Remove;

impl Trash for Remove {
    fn trash(&self, path: &Path) -> std::io::Result<()> {
        fs::remove_dir_all(path)
    }
}

#[test]
fn sweep_takes_stale_staging_worktrees_and_keeps_fresh_ones() {
    let (mut reg, _id, main) = registered();
    let stage = staging_root(&mut reg).join("123-abc");
    git(
        main.path(),
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "half",
            stage.to_str().unwrap(),
        ],
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    // Fresh: kept.
    assert!(sweep_with(&reg, now, &Remove).is_empty());
    assert!(stage.exists());
    // Two hours on: swept, its record and its empty branch with it.
    let swept = sweep_with(&reg, now + 2 * 60 * 60 * 1000, &Remove);
    assert_eq!(swept, vec![stage.clone()]);
    assert!(!stage.exists());
    assert!(!staging_root(&mut reg).exists());
    let listed = git(main.path(), &["worktree", "list", "--porcelain"]);
    assert!(!listed.contains(STAGING));
    assert!(
        git(main.path(), &["branch", "--list", "half"])
            .trim()
            .is_empty()
    );
}

#[test]
fn update_sets_and_resets_the_docs_dir() {
    let (mut reg, id, _main) = registered();
    assert_eq!(
        update_repo(&mut reg, &id, RepoPatch::default())
            .unwrap()
            .docs_dir,
        "docs"
    );
    let view = update_repo(
        &mut reg,
        &id,
        RepoPatch {
            docs_dir: Some(r"handbook\en".into()),
            ..RepoPatch::default()
        },
    )
    .unwrap();
    assert_eq!(view.docs_dir, "handbook/en");
    assert_eq!(reg.repos[0].docs_dir.as_deref(), Some("handbook/en"));

    let view = update_repo(
        &mut reg,
        &id,
        RepoPatch {
            docs_dir: Some(String::new()),
            ..RepoPatch::default()
        },
    )
    .unwrap();
    assert_eq!(view.docs_dir, "docs");
    assert_eq!(reg.repos[0].docs_dir, None);
}

#[test]
fn update_refuses_a_bad_docs_dir_and_writes_nothing() {
    let (mut reg, id, _main) = registered();
    let before = reg.clone();
    for bad in ["../x", "/x", r"C:\x"] {
        let err = update_repo(
            &mut reg,
            &id,
            RepoPatch {
                short_name: Some("other".into()),
                docs_dir: Some(bad.into()),
                ..RepoPatch::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.code(), "bad_path", "{bad:?}");
        assert_eq!(reg, before);
    }
}

fn patch_err(reg: &mut Registry, id: &str, patch: RepoPatch) -> String {
    let before = reg.clone();
    let err = update_repo(reg, id, patch).unwrap_err();
    assert_eq!(*reg, before, "a refused patch changes nothing");
    err.code().to_owned()
}

#[test]
fn update_sets_and_clears_identity() {
    let (mut reg, id, _main) = registered();
    assert_eq!(reg.repos[0].color, None);
    let view = update_repo(
        &mut reg,
        &id,
        RepoPatch {
            color: Some(Some("teal".into())),
            icon: Some(Some(RepoIcon::Emoji {
                value: "🚀".into()
            })),
            gh_account: Some(Some(GhAccount {
                host: "github.com".into(),
                user: "me".into(),
            })),
            local_issue_command: Some("Fix #{number}".into()),
            ..RepoPatch::default()
        },
    )
    .unwrap();
    assert_eq!(view.color.as_deref(), Some("teal"));
    assert_eq!(
        view.icon,
        Some(RepoIcon::Emoji {
            value: "🚀".into()
        })
    );
    assert_eq!(
        view.gh_account.as_ref().map(|a| a.user.as_str()),
        Some("me")
    );
    assert_eq!(view.local_issue_command, "Fix #{number}");

    // An absent field is left alone.
    update_repo(&mut reg, &id, RepoPatch::default()).unwrap();
    assert_eq!(reg.repos[0].color.as_deref(), Some("teal"));

    // `Some(None)` clears, an empty command clears.
    let view = update_repo(
        &mut reg,
        &id,
        RepoPatch {
            color: Some(None),
            icon: Some(None),
            gh_account: Some(None),
            local_issue_command: Some(String::new()),
            ..RepoPatch::default()
        },
    )
    .unwrap();
    assert_eq!(view.color, None);
    assert_eq!(view.icon, None);
    assert_eq!(view.gh_account, None);
    assert_eq!(view.local_issue_command, "");
}

#[test]
fn update_checks_the_colour() {
    let (mut reg, id, _main) = registered();
    for ok in ["slate", "pink", "#abc", "#aabbcc", "#ABC", "#A1b2C3"] {
        let patch = RepoPatch {
            color: Some(Some(ok.into())),
            ..RepoPatch::default()
        };
        update_repo(&mut reg, &id, patch).unwrap_or_else(|e| panic!("{ok}: {e}"));
    }
    for bad in [
        "",
        "#abcd",
        "#ab",
        "abc",
        "#ggg",
        "#aabbccdd",
        "blue",
        "Teal",
        "#abc ",
    ] {
        let patch = RepoPatch {
            color: Some(Some(bad.into())),
            ..RepoPatch::default()
        };
        assert_eq!(patch_err(&mut reg, &id, patch), "bad_color", "{bad:?}");
    }
}

#[test]
fn update_checks_the_icon() {
    let (mut reg, id, _main) = registered();
    let emoji = |v: &str| RepoPatch {
        icon: Some(Some(RepoIcon::Emoji { value: v.into() })),
        ..RepoPatch::default()
    };
    // One grapheme, however many scalars: a flag, a ZWJ pair, a keycap, a skin tone.
    for ok in ["🚀", "🇻🇳", "👩‍💻", "1️⃣", "👍🏽", "❤️"] {
        update_repo(&mut reg, &id, emoji(ok)).unwrap_or_else(|e| panic!("{ok}: {e}"));
    }
    update_repo(
        &mut reg,
        &id,
        RepoPatch {
            icon: Some(Some(RepoIcon::Letter)),
            ..RepoPatch::default()
        },
    )
    .unwrap();
    for bad in ["", "🚀🚀", "ab", "a", " ", "🚀 ", "x🚀"] {
        assert_eq!(patch_err(&mut reg, &id, emoji(bad)), "bad_icon", "{bad:?}");
    }
    // Over 16 bytes even as one cluster.
    let long = format!("🚀{}", "\u{200d}".repeat(10));
    assert_eq!(patch_err(&mut reg, &id, emoji(&long)), "bad_icon");
}

#[test]
fn update_caps_the_issue_command() {
    let (mut reg, id, _main) = registered();
    let cmd = |n: usize| RepoPatch {
        local_issue_command: Some("a".repeat(n)),
        ..RepoPatch::default()
    };
    update_repo(&mut reg, &id, cmd(ISSUE_COMMAND_MAX)).unwrap();
    assert_eq!(
        patch_err(&mut reg, &id, cmd(ISSUE_COMMAND_MAX + 1)),
        "too_large"
    );
}

#[test]
fn update_with_a_bad_identity_writes_nothing_else() {
    let (mut reg, id, _main) = registered();
    let code = patch_err(
        &mut reg,
        &id,
        RepoPatch {
            short_name: Some("renamed".into()),
            color: Some(Some("#abcd".into())),
            ..RepoPatch::default()
        },
    );
    assert_eq!(code, "bad_color");
}

#[test]
fn an_old_registry_file_loads_with_identity_defaults() {
    let (mut reg, id, _main) = registered();
    let mut json = serde_json::to_value(&reg).unwrap();
    json["version"] = 1.into();
    let repo = json["repos"][0].as_object_mut().unwrap();
    for key in ["color", "icon", "gh_account", "local_issue_command"] {
        repo.remove(key);
    }
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("workspace.json"), json.to_string()).unwrap();
    reg = Registry::load(dir.path()).unwrap();
    let repo = &reg.repos[0];
    assert_eq!(repo.id, id);
    assert_eq!(
        (&repo.color, &repo.icon, &repo.gh_account),
        (&None, &None, &None)
    );
    assert_eq!(repo.local_issue_command, "");
}
