//! `rename_branch`: the branch and the shown title change, the folder never does.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use xdev_workspace::{
    BranchPrefix, CreateOptions, Registry, WorktreeView, add_repo, create_worktree_with,
    rename_branch,
};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

struct Fx {
    _tmp: TempDir,
    main: PathBuf,
    reg: Registry,
    id: String,
}

fn opts() -> CreateOptions {
    CreateOptions {
        prefix: BranchPrefix::Custom("me".to_owned()),
        suffix: true,
        ..CreateOptions::default()
    }
}

fn fixture() -> Fx {
    let base = dunce::canonicalize(std::env::temp_dir()).unwrap();
    let tmp = TempDir::with_prefix_in("ws rename ", base).unwrap();
    let main = tmp.path().join("main");
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
    fs::write(main.join("a.txt"), "a\n").unwrap();
    git(&main, &["add", "-A"]);
    git(&main, &["commit", "-q", "-m", "one"]);
    let mut reg = Registry::default();
    let id = add_repo(&mut reg, &main, 0).unwrap().id;
    Fx {
        _tmp: tmp,
        main,
        reg,
        id,
    }
}

fn auto(fx: &mut Fx) -> WorktreeView {
    create_worktree_with(&mut fx.reg, &fx.id, "", None, 1, 3, &opts()).unwrap()
}

#[test]
fn renames_under_the_same_prefix_and_leaves_the_folder() {
    let mut fx = fixture();
    let wt = auto(&mut fx);
    let old = wt.branch.clone().unwrap();
    assert!(old.starts_with("me/"));
    assert!(wt.auto_name);
    let path = PathBuf::from(&wt.path);
    let view = rename_branch(&mut fx.reg, &path, "fix-the-footer", &opts()).unwrap();
    assert_eq!(view.branch.as_deref(), Some("me/fix-the-footer"));
    assert_eq!(view.path, wt.path);
    assert!(path.is_dir());
    assert!(!view.auto_name);
    assert!(!fx.reg.worktrees[0].auto_name);
    assert_eq!(
        git(&path, &["symbolic-ref", "--short", "HEAD"]),
        "me/fix-the-footer"
    );
    assert_eq!(git(&fx.main, &["branch", "--list", &old]), "");
}

#[test]
fn sets_the_title_from_the_words_only_when_it_was_unset() {
    let mut fx = fixture();
    let wt = auto(&mut fx);
    let path = PathBuf::from(&wt.path);
    let view = rename_branch(&mut fx.reg, &path, "fix-the-footer", &opts()).unwrap();
    assert_eq!(view.title.as_deref(), Some("fix the footer"));

    // A title the person set stays.
    let mut fx = fixture();
    let wt = auto(&mut fx);
    let path = PathBuf::from(&wt.path);
    fx.reg.worktrees[0].title = Some("My title".to_owned());
    let view = rename_branch(&mut fx.reg, &path, "fix-the-footer", &opts()).unwrap();
    assert_eq!(view.title.as_deref(), Some("My title"));
}

#[test]
fn a_taken_name_gets_the_next_suffix() {
    let mut fx = fixture();
    git(&fx.main, &["branch", "me/fix-the-footer"]);
    let wt = auto(&mut fx);
    let path = PathBuf::from(&wt.path);
    let view = rename_branch(&mut fx.reg, &path, "fix-the-footer", &opts()).unwrap();
    assert_eq!(view.branch.as_deref(), Some("me/fix-the-footer-2"));
    assert_eq!(view.title.as_deref(), Some("fix the footer 2"));

    // Without the suffix rule the taken name is refused.
    let mut fx = fixture();
    git(&fx.main, &["branch", "me/taken"]);
    let wt = auto(&mut fx);
    let strict = CreateOptions {
        suffix: false,
        ..opts()
    };
    let err = rename_branch(&mut fx.reg, Path::new(&wt.path), "taken", &strict).unwrap_err();
    assert_eq!(err.code(), "branch_exists");
    assert!(fx.reg.worktrees[0].auto_name);
}

#[test]
fn a_branch_with_an_upstream_is_refused() {
    let mut fx = fixture();
    let wt = auto(&mut fx);
    let path = PathBuf::from(&wt.path);
    let old = wt.branch.clone().unwrap();
    // A local ref stands in for the remote.
    git(&path, &["branch", "--set-upstream-to=main"]);
    let err = rename_branch(&mut fx.reg, &path, "fix-the-footer", &opts()).unwrap_err();
    assert_eq!(err.code(), "branch_pushed");
    assert_eq!(git(&path, &["symbolic-ref", "--short", "HEAD"]), old);
    assert!(fx.reg.worktrees[0].auto_name);
    assert_eq!(fx.reg.worktrees[0].title, None);
}

#[test]
fn a_detached_worktree_is_refused() {
    let mut fx = fixture();
    let wt = auto(&mut fx);
    let path = PathBuf::from(&wt.path);
    git(&path, &["checkout", "-q", "--detach"]);
    let err = rename_branch(&mut fx.reg, &path, "fix-the-footer", &opts()).unwrap_err();
    assert_eq!(err.code(), "detached");
}

#[test]
fn bad_names_unknown_paths_and_the_primary_checkout_are_refused() {
    let mut fx = fixture();
    let wt = auto(&mut fx);
    let path = PathBuf::from(&wt.path);
    for bad in ["", "   ", "日本語", "..."] {
        let err = rename_branch(&mut fx.reg, &path, bad, &opts()).unwrap_err();
        assert_eq!(err.code(), "bad_name", "{bad:?}");
    }
    let err = rename_branch(&mut fx.reg, &fx.main.clone(), "x", &opts()).unwrap_err();
    assert_eq!(err.code(), "primary_worktree");
    let err = rename_branch(&mut fx.reg, Path::new("/nope/wt"), "x", &opts()).unwrap_err();
    assert_eq!(err.code(), "worktree_unknown");
}

#[test]
fn the_same_name_is_a_quiet_no_op_that_still_ends_auto_naming() {
    let mut fx = fixture();
    let wt = auto(&mut fx);
    let path = PathBuf::from(&wt.path);
    let leaf = wt
        .branch
        .as_deref()
        .unwrap()
        .strip_prefix("me/")
        .unwrap()
        .to_owned();
    let view = rename_branch(&mut fx.reg, &path, &leaf, &opts()).unwrap();
    assert_eq!(view.branch, wt.branch);
    assert!(!view.auto_name);
}

#[test]
fn kept_branches_are_left_alone() {
    let mut fx = fixture();
    let wt = auto(&mut fx);
    fx.reg.kept.push(xdev_workspace::KeptBranch {
        repo_id: fx.id.clone(),
        branch: "me/old-kept".to_owned(),
        path: PathBuf::from("/gone"),
        kept_ms: 5,
        reason: xdev_workspace::KeptReason::Archived,
        title: Some("old".to_owned()),
        comment: String::new(),
        status: None,
        item: None,
    });
    let kept = fx.reg.kept.clone();
    rename_branch(&mut fx.reg, Path::new(&wt.path), "fix-it", &opts()).unwrap();
    assert_eq!(fx.reg.kept, kept);
}
