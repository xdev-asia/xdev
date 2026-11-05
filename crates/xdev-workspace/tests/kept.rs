mod common;

use std::fs;
use std::path::Path;

use common::{git, registered};
use xdev_workspace::{
    ARCHIVE_DAYS, DetailsPatch, KeptReason, Registry, WorkStatus, WorkspaceError, archive_worktree,
    create_worktree, kept_delete, kept_keep, kept_list, list, path_key, remove_worktree,
    restore_worktree, set_details,
};

const DAY_MS: i64 = 86_400_000;

fn branch_exists(repo: &Path, branch: &str) -> bool {
    !git(repo, &["branch", "--list", branch]).trim().is_empty()
}

/// One commit in the worktree that `main` does not have.
fn commit_in(path: &str, file: &str) {
    let dir = Path::new(path);
    fs::write(dir.join(file), "work").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", file]);
}

fn recorded(reg: &Registry, path: &str) -> bool {
    let key = path_key(Path::new(path));
    reg.worktrees.iter().any(|m| path_key(&m.path) == key)
}

#[test]
fn archive_keeps_unmerged_branch() {
    let (mut reg, id, repo) = registered();
    let wt = create_worktree(&mut reg, &id, "w", None, 1, 1).unwrap();
    commit_in(&wt.path, "b.txt");
    let branch = wt.branch.clone().unwrap();

    let removed = archive_worktree(&mut reg, Path::new(&wt.path), false, 10).unwrap();
    assert_eq!(removed.deleted_branch, None);
    let kept = removed.kept.unwrap();
    assert_eq!(kept.reason, KeptReason::Archived);
    assert_eq!(kept.branch, branch);
    assert!(!Path::new(&wt.path).exists());
    assert!(!recorded(&reg, &wt.path));
    assert!(branch_exists(repo.path(), &branch));

    let views = kept_list(&mut reg, 20).unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].ahead, 1);
    assert!(views[0].archived_shown);
    assert_eq!(views[0].entry.kept_ms, 10);
}

#[test]
fn archive_refuses_dirty_without_force() {
    let (mut reg, id, repo) = registered();
    let wt = create_worktree(&mut reg, &id, "w", None, 1, 1).unwrap();
    fs::write(Path::new(&wt.path).join("new.txt"), "x").unwrap();
    let err = archive_worktree(&mut reg, Path::new(&wt.path), false, 10).unwrap_err();
    assert!(matches!(err, WorkspaceError::Dirty(_)), "{err:?}");
    assert!(Path::new(&wt.path).exists());

    archive_worktree(&mut reg, Path::new(&wt.path), true, 10).unwrap();
    assert!(!Path::new(&wt.path).exists());
    assert!(branch_exists(repo.path(), wt.branch.as_deref().unwrap()));
}

#[test]
fn archive_detached_needs_force() {
    let (mut reg, id, _repo) = registered();
    let wt = create_worktree(&mut reg, &id, "w", None, 1, 1).unwrap();
    git(Path::new(&wt.path), &["checkout", "-q", "--detach"]);

    let err = archive_worktree(&mut reg, Path::new(&wt.path), false, 10).unwrap_err();
    assert!(matches!(err, WorkspaceError::Detached(_)), "{err:?}");
    assert_eq!(err.code(), "detached");
    assert!(Path::new(&wt.path).exists());

    let removed = archive_worktree(&mut reg, Path::new(&wt.path), true, 10).unwrap();
    assert_eq!(removed.kept, None);
    assert!(reg.kept.is_empty());
    assert!(!Path::new(&wt.path).exists());
}

#[test]
fn delete_that_keeps_branch_lists_it() {
    let (mut reg, id, repo) = registered();
    // Imported: made by hand, then adopted.
    let hand = repo.tmp.path().join("hand");
    git(
        repo.path(),
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "hand",
            hand.to_str().unwrap(),
        ],
    );
    let view = list(&mut reg).unwrap().remove(0);
    let found = view.found[0].path.clone();
    xdev_workspace::adopt_worktree(&mut reg, Path::new(&found), 1).unwrap();

    let removed = remove_worktree(&mut reg, Path::new(&found), false, false, 5).unwrap();
    assert_eq!(removed.deleted_branch, None);
    let kept = removed.kept.unwrap();
    assert_eq!(kept.reason, KeptReason::Deleted);
    assert_eq!(kept.branch, "hand");
    assert_eq!(reg.kept.len(), 1);
    assert!(branch_exists(repo.path(), "hand"));

    // Merged and made here: the branch goes, nothing is kept.
    let wt = create_worktree(&mut reg, &id, "m", None, 2, 2).unwrap();
    let removed = remove_worktree(&mut reg, Path::new(&wt.path), false, false, 6).unwrap();
    assert_eq!(removed.deleted_branch, wt.branch);
    assert_eq!(removed.kept, None);
    assert_eq!(reg.kept.len(), 1);

    // Unmerged and made here: kept as Deleted.
    let wt = create_worktree(&mut reg, &id, "u", None, 3, 3).unwrap();
    commit_in(&wt.path, "u.txt");
    let removed = remove_worktree(&mut reg, Path::new(&wt.path), false, false, 7).unwrap();
    assert_eq!(removed.deleted_branch, None);
    assert_eq!(removed.kept.unwrap().reason, KeptReason::Deleted);
    assert_eq!(reg.kept.len(), 2);
}

#[test]
fn restore_brings_back_branch_and_details() {
    let (mut reg, id, repo) = registered();
    let wt = create_worktree(&mut reg, &id, "w", None, 1, 1).unwrap();
    commit_in(&wt.path, "b.txt");
    let head = git(Path::new(&wt.path), &["rev-parse", "HEAD"]);
    set_details(
        &mut reg,
        Path::new(&wt.path),
        DetailsPatch {
            title: Some(Some("🚀 login".to_owned())),
            comment: Some("half done".to_owned()),
            status: Some(Some(WorkStatus::InProgress)),
            ..DetailsPatch::default()
        },
    )
    .unwrap();
    let branch = wt.branch.clone().unwrap();
    archive_worktree(&mut reg, Path::new(&wt.path), false, 10).unwrap();

    let back = restore_worktree(&mut reg, &id, &branch, 20).unwrap();
    assert_eq!(
        path_key(Path::new(&back.path)),
        path_key(Path::new(&wt.path))
    );
    assert_eq!(back.branch.as_deref(), Some(branch.as_str()));
    assert_eq!(back.title.as_deref(), Some("🚀 login"));
    assert_eq!(back.comment, "half done");
    assert_eq!(back.status, Some(WorkStatus::InProgress));
    assert!(reg.kept.is_empty());
    assert_eq!(git(Path::new(&back.path), &["rev-parse", "HEAD"]), head);
    let meta = reg
        .worktrees
        .iter()
        .find(|m| path_key(&m.path) == path_key(Path::new(&back.path)))
        .unwrap();
    assert!(meta.made_here);
    // It shows in the list like any other worktree.
    let view = list(&mut reg).unwrap().remove(0);
    assert!(view.worktrees.iter().any(|w| w.path == back.path));
    assert!(branch_exists(repo.path(), &branch));
}

#[test]
fn restore_picks_free_path() {
    let (mut reg, id, _repo) = registered();
    let wt = create_worktree(&mut reg, &id, "w", None, 1, 1).unwrap();
    let branch = wt.branch.clone().unwrap();
    commit_in(&wt.path, "b.txt");
    archive_worktree(&mut reg, Path::new(&wt.path), false, 10).unwrap();
    fs::create_dir(&wt.path).unwrap();
    fs::write(Path::new(&wt.path).join("keep.txt"), "mine").unwrap();

    let back = restore_worktree(&mut reg, &id, &branch, 20).unwrap();
    let expected = format!("{}-2", wt.path);
    assert_eq!(
        path_key(Path::new(&back.path)),
        path_key(Path::new(&expected))
    );
    // The folder that took the old path is untouched.
    assert_eq!(
        fs::read_to_string(Path::new(&wt.path).join("keep.txt")).unwrap(),
        "mine"
    );
}

#[test]
fn archived_older_than_seven_days_moves_to_review() {
    let (mut reg, id, _repo) = registered();
    let wt = create_worktree(&mut reg, &id, "w", None, 1, 1).unwrap();
    archive_worktree(&mut reg, Path::new(&wt.path), false, 0).unwrap();
    let now = (ARCHIVE_DAYS + 1) * DAY_MS;
    let views = kept_list(&mut reg, now).unwrap();
    assert_eq!(views.len(), 1);
    assert!(!views[0].archived_shown);
    let views = kept_list(&mut reg, ARCHIVE_DAYS * DAY_MS - 1).unwrap();
    assert!(views[0].archived_shown);
}

#[test]
fn kept_list_drops_gone_branches() {
    let (mut reg, id, repo) = registered();
    let wt = create_worktree(&mut reg, &id, "w", None, 1, 1).unwrap();
    let branch = wt.branch.clone().unwrap();
    archive_worktree(&mut reg, Path::new(&wt.path), false, 0).unwrap();
    git(repo.path(), &["branch", "-D", &branch]);
    assert!(kept_list(&mut reg, 1).unwrap().is_empty());
    assert!(reg.kept.is_empty());
}

#[test]
fn kept_keep_and_delete() {
    let (mut reg, id, repo) = registered();
    let a = create_worktree(&mut reg, &id, "a", None, 1, 1).unwrap();
    let b = create_worktree(&mut reg, &id, "b", None, 2, 2).unwrap();
    commit_in(&b.path, "b.txt");
    let (ab, bb) = (a.branch.unwrap(), b.branch.unwrap());
    archive_worktree(&mut reg, Path::new(&a.path), false, 0).unwrap();
    archive_worktree(&mut reg, Path::new(&b.path), false, 0).unwrap();

    kept_keep(&mut reg, &id, &ab).unwrap();
    assert!(branch_exists(repo.path(), &ab));
    assert_eq!(reg.kept.len(), 1);

    kept_delete(&mut reg, &id, &bb).unwrap();
    assert!(!branch_exists(repo.path(), &bb));
    assert!(reg.kept.is_empty());

    let err = kept_keep(&mut reg, &id, "nope").unwrap_err();
    assert_eq!(err.code(), "kept_unknown");
    let err = kept_delete(&mut reg, &id, &ab).unwrap_err();
    assert!(matches!(err, WorkspaceError::KeptUnknown { .. }), "{err:?}");
    assert!(branch_exists(repo.path(), &ab));
}

#[test]
fn removing_a_parent_with_archive_clears_children() {
    let (mut reg, id, _repo) = registered();
    let p = create_worktree(&mut reg, &id, "p", None, 1, 1).unwrap();
    let c = create_worktree(&mut reg, &id, "c", None, 2, 2).unwrap();
    set_details(
        &mut reg,
        Path::new(&c.path),
        DetailsPatch {
            parent: Some(Some(p.path.clone().into())),
            ..DetailsPatch::default()
        },
    )
    .unwrap();
    archive_worktree(&mut reg, Path::new(&p.path), false, 0).unwrap();
    let key = path_key(Path::new(&c.path));
    let child = reg
        .worktrees
        .iter()
        .find(|m| path_key(&m.path) == key)
        .unwrap();
    assert_eq!(child.parent, None);
}
