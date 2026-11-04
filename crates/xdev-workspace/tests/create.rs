//! `create_project`. A commit needs a git identity, and the workspace forbids
//! the `unsafe` that `set_var` needs, so the cases that commit are `#[ignore]`
//! children that a driver runs again with a throwaway global config.

use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_workspace::{
    CreateProject, Created, ProjectKind, Registry, WorkspaceError, create_project, create_worktree,
};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8(out.stdout).unwrap()
}

fn req(parent: &Path, name: &str, kind: ProjectKind) -> CreateProject {
    CreateProject {
        parent: parent.to_owned(),
        name: name.to_owned(),
        kind,
        branch: String::new(),
        first_commit: true,
    }
}

fn code(err: WorkspaceError) -> &'static str {
    err.code()
}

#[test]
fn bad_names_are_refused() {
    let tmp = TempDir::new().unwrap();
    let mut reg = Registry::default();
    let long = "a".repeat(101);
    for name in [
        "", "   ", ".", "..", "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b",
        "a\u{7}b", "CON", "nul", "Com1", "lpt9", "con.txt", "dots.", &long,
    ] {
        let err = create_project(&mut reg, &req(tmp.path(), name, ProjectKind::Folder), 0)
            .expect_err(name);
        assert_eq!(code(err), "bad_name", "{name:?}");
    }
    assert!(reg.folders.is_empty());
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 0);
}

#[test]
fn name_is_trimmed_and_a_hundred_chars_fit() {
    let tmp = TempDir::new().unwrap();
    let mut reg = Registry::default();
    let Created::Folder { folder } = create_project(
        &mut reg,
        &req(tmp.path(), "  plain  ", ProjectKind::Folder),
        0,
    )
    .unwrap() else {
        panic!("folder expected");
    };
    assert_eq!(folder.name, "plain");
    let name = "b".repeat(100);
    create_project(&mut reg, &req(tmp.path(), &name, ProjectKind::Folder), 0).unwrap();
}

#[test]
fn missing_parent_is_not_found() {
    let tmp = TempDir::new().unwrap();
    let mut reg = Registry::default();
    let err = create_project(
        &mut reg,
        &req(&tmp.path().join("nope"), "x", ProjectKind::Folder),
        0,
    )
    .unwrap_err();
    assert_eq!(code(err), "not_found");
}

#[test]
fn existing_non_empty_folder_or_file_is_exists() {
    let tmp = TempDir::new().unwrap();
    let mut reg = Registry::default();
    fs::create_dir(tmp.path().join("full")).unwrap();
    fs::write(tmp.path().join("full/a.txt"), "a").unwrap();
    fs::write(tmp.path().join("file"), "f").unwrap();
    for name in ["full", "file"] {
        let err =
            create_project(&mut reg, &req(tmp.path(), name, ProjectKind::Git), 0).expect_err(name);
        assert_eq!(code(err), "exists", "{name}");
    }
    assert!(!tmp.path().join("full/.git").exists());
}

#[test]
fn empty_existing_folder_is_fine() {
    let tmp = TempDir::new().unwrap();
    let mut reg = Registry::default();
    fs::create_dir(tmp.path().join("empty")).unwrap();
    let mut r = req(tmp.path(), "empty", ProjectKind::Git);
    r.first_commit = false;
    create_project(&mut reg, &r, 0).unwrap();
    assert!(tmp.path().join("empty/.git").exists());
}

#[test]
fn folder_kind_lists_a_sidebar_folder() {
    let tmp = TempDir::new().unwrap();
    let mut reg = Registry::default();
    let Created::Folder { folder } =
        create_project(&mut reg, &req(tmp.path(), "notes", ProjectKind::Folder), 0).unwrap()
    else {
        panic!("folder expected");
    };
    assert_eq!(folder.name, "notes");
    assert!(tmp.path().join("notes").is_dir());
    assert!(!tmp.path().join("notes/.git").exists());
    assert_eq!(reg.folders.len(), 1);
    assert!(reg.repos.is_empty());
}

#[test]
fn bad_branch_names_are_refused_before_anything_is_made() {
    let tmp = TempDir::new().unwrap();
    let mut reg = Registry::default();
    for branch in ["a b", "-x", "a..b", "x.lock", "a~b"] {
        let mut r = req(tmp.path(), "demo", ProjectKind::Git);
        r.branch = branch.to_owned();
        let err = create_project(&mut reg, &r, 0).expect_err(branch);
        assert_eq!(code(err), "bad_name", "{branch}");
    }
    assert!(!tmp.path().join("demo").exists());
    assert!(reg.repos.is_empty());
}

#[test]
fn without_first_commit_the_repo_is_added_and_worktrees_fail_with_bad_ref() {
    let tmp = TempDir::new().unwrap();
    let mut reg = Registry::default();
    let mut r = req(tmp.path(), "bare", ProjectKind::Git);
    r.first_commit = false;
    r.branch = "trunk".to_owned();
    let Created::Git { repo } = create_project(&mut reg, &r, 0).unwrap() else {
        panic!("git expected");
    };
    assert_eq!(repo.base_ref, "trunk");
    assert_eq!(reg.repos.len(), 1);
    let target = tmp.path().join("bare");
    assert_eq!(git(&target, &["branch", "--show-current"]).trim(), "trunk");
    let err = create_worktree(&mut reg, &repo.id, "one", None, 0, 0).unwrap_err();
    assert_eq!(code(err), "bad_ref");
}

/// Runs the `#[ignore]` cases whose names start with `prefix` in a child
/// with `config` as the global git config and no identity in the environment.
fn run_children(prefix: &str, config: &str, count: usize) {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("gitconfig");
    fs::write(&file, config).unwrap();
    let out = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", prefix])
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
        out.status.success() && stdout.contains(&format!("{count} passed")),
        "{stdout}{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn with_an_identity_the_first_commit_is_made() {
    run_children(
        "idok_",
        "[user]\n\tname = Test User\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n",
        1,
    );
}

#[test]
fn without_an_identity_the_folder_stays_and_nothing_is_added() {
    run_children("idnone_", "", 1);
}

#[test]
#[ignore]
fn idok_git_project_has_one_commit_on_the_branch() {
    let tmp = TempDir::new().unwrap();
    let mut reg = Registry::default();
    let Created::Git { repo } =
        create_project(&mut reg, &req(tmp.path(), "demo", ProjectKind::Git), 5).unwrap()
    else {
        panic!("git expected");
    };
    let dir = tmp.path().join("demo");
    assert_eq!(repo.short_name, "demo");
    assert_eq!(repo.base_ref, "main");
    assert_eq!(repo.worktrees.len(), 1);
    assert_eq!(git(&dir, &["rev-list", "--count", "HEAD"]).trim(), "1");
    assert_eq!(git(&dir, &["branch", "--show-current"]).trim(), "main");
    // A worktree can start from it.
    let view = create_worktree(&mut reg, &repo.id, "one", None, 6, 0).unwrap();
    assert_eq!(view.branch.as_deref(), Some("one"));
}

#[test]
#[ignore]
fn idnone_first_commit_failure_keeps_the_folder_and_adds_nothing() {
    let tmp = TempDir::new().unwrap();
    let mut reg = Registry::default();
    let err = create_project(&mut reg, &req(tmp.path(), "demo", ProjectKind::Git), 0).unwrap_err();
    assert_eq!(code(err), "git_identity");
    assert!(tmp.path().join("demo/.git").exists());
    assert!(reg.repos.is_empty());
    assert!(reg.folders.is_empty());
}
