//! Helpers shared by the lifecycle tests: real local repos in temp dirs.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use xdev_workspace::{Registry, add_repo};

/// Runs setup commands; never used for the code under test.
pub fn git(dir: &Path, args: &[&str]) -> String {
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
pub struct TestRepo {
    pub tmp: TempDir,
    pub main: PathBuf,
}

impl TestRepo {
    pub fn path(&self) -> &Path {
        &self.main
    }
}

/// Windows CI hands out 8.3 temp names while git reports long paths.
pub fn long_temp_dir(prefix: &str) -> TempDir {
    let base = dunce::canonicalize(std::env::temp_dir()).unwrap();
    TempDir::with_prefix_in(prefix, base).unwrap()
}

pub fn init(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(dir, &["config", key, value]);
    }
}

pub fn commit_all(dir: &Path, message: &str) -> String {
    fs::write(dir.join("a.txt"), message).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
    git(dir, &["rev-parse", "HEAD"]).trim().to_owned()
}

/// A repo with one commit on `main`, in `<tmp>/<name>`.
pub fn repo_named(tmp: TempDir, name: &str) -> TestRepo {
    let main = tmp.path().join(name);
    fs::create_dir(&main).unwrap();
    init(&main);
    commit_all(&main, "one");
    TestRepo { tmp, main }
}

/// A repo with one commit, added to a fresh registry.
pub fn registered() -> (Registry, String, TestRepo) {
    let repo = repo_named(long_temp_dir("ws life "), "main");
    let mut reg = Registry::default();
    let id = add_repo(&mut reg, repo.path(), 0).unwrap().id;
    (reg, id, repo)
}
