//! Local temp repos for the integration tests; nothing here touches the network.
#![allow(dead_code)]

use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_git::Repo;

/// Runs setup commands; never used for the code under test.
pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

pub fn identity(dir: &Path) {
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(dir, &["config", key, value]);
    }
}

pub fn commit_file(dir: &Path, name: &str, content: &str) -> String {
    fs::write(dir.join(name), content).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", &format!("add {name}")]);
    git(dir, &["rev-parse", "HEAD"])
}

/// A bare `origin`, a work repo on branch `feat` (cut from `main`, which is
/// on the remote) and a second clone to move the remote.
pub struct Fixture {
    pub origin: TempDir,
    pub work: TempDir,
    pub other: TempDir,
    pub repo: Repo,
}

impl Fixture {
    pub fn new() -> Fixture {
        let origin = TempDir::with_prefix("common origin ").unwrap();
        git(
            origin.path(),
            &["init", "-q", "--bare", "--initial-branch=main"],
        );
        let url = origin.path().to_str().unwrap().to_owned();

        let work = TempDir::with_prefix("common work ").unwrap();
        git(work.path(), &["init", "-q", "--initial-branch=main"]);
        identity(work.path());
        commit_file(work.path(), "a.txt", "a\n");
        git(work.path(), &["remote", "add", "origin", &url]);
        git(work.path(), &["push", "-q", "origin", "main"]);
        git(work.path(), &["switch", "-q", "-c", "feat"]);

        let other = TempDir::with_prefix("common other ").unwrap();
        git(other.path(), &["clone", "-q", &url, "."]);
        identity(other.path());

        let repo = Repo::discover(work.path()).unwrap();
        Fixture {
            origin,
            work,
            other,
            repo,
        }
    }

    pub fn w(&self) -> &Path {
        self.work.path()
    }

    pub fn head(&self) -> String {
        git(self.w(), &["rev-parse", "HEAD"])
    }

    /// Publishes `feat` from the work repo, then lets the other clone check
    /// it out.
    pub fn publish(&self) {
        self.repo.push().unwrap();
        git(self.other.path(), &["fetch", "-q", "origin"]);
        git(self.other.path(), &["switch", "-q", "feat"]);
    }

    /// The other clone pushes a commit to `feat`; returns its id.
    pub fn move_remote(&self, name: &str) -> String {
        let id = commit_file(self.other.path(), name, "other\n");
        git(self.other.path(), &["push", "-q", "origin", "feat"]);
        id
    }
}
