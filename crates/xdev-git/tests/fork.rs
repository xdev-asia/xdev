//! Fork sync against local bare repos standing in for `origin` and
//! `upstream`; nothing here touches the network.

use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_git::{ForkSync, ForkSyncBlock, ForkSyncStatus, Repo};

/// Runs setup commands; never used for the code under test.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

fn identity(dir: &Path) {
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(dir, &["config", key, value]);
    }
}

fn commit(dir: &Path, name: &str) -> String {
    fs::write(dir.join(name), format!("{name}\n")).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", name]);
    git(dir, &["rev-parse", "HEAD"])
}

fn url(dir: &TempDir) -> String {
    dir.path().to_str().unwrap().to_owned()
}

/// A bare `upstream` on `branch`, a bare `origin` cloned from it, a work
/// clone of `origin` with `upstream` added, and a seed clone that moves
/// `upstream`.
struct Fork {
    upstream: TempDir,
    origin: TempDir,
    work: TempDir,
    seed: TempDir,
    branch: String,
    repo: Repo,
}

impl Fork {
    fn new(branch: &str) -> Fork {
        let upstream = TempDir::with_prefix("fork upstream ").unwrap();
        let flag = format!("--initial-branch={branch}");
        git(upstream.path(), &["init", "-q", "--bare", &flag]);
        let seed = TempDir::with_prefix("fork seed ").unwrap();
        git(seed.path(), &["init", "-q", &flag]);
        identity(seed.path());
        commit(seed.path(), "a.txt");
        git(seed.path(), &["remote", "add", "upstream", &url(&upstream)]);
        git(seed.path(), &["push", "-q", "upstream", branch]);

        let origin = TempDir::with_prefix("fork origin ").unwrap();
        git(
            origin.path(),
            &["clone", "-q", "--bare", &url(&upstream), "."],
        );
        let work = TempDir::with_prefix("fork work ").unwrap();
        // A runner's global `core.autocrlf=true` would check `a.txt` out with CRLF.
        git(
            work.path(),
            &[
                "clone",
                "-q",
                "-c",
                "core.autocrlf=false",
                &url(&origin),
                ".",
            ],
        );
        identity(work.path());
        git(work.path(), &["remote", "add", "upstream", &url(&upstream)]);
        let repo = Repo::discover(work.path()).unwrap();
        Fork {
            upstream,
            origin,
            work,
            seed,
            branch: branch.to_owned(),
            repo,
        }
    }

    fn w(&self) -> &Path {
        self.work.path()
    }

    /// Commits `name` upstream; returns the new tip.
    fn upstream_commit(&self, name: &str) -> String {
        let id = commit(self.seed.path(), name);
        git(self.seed.path(), &["push", "-q", "upstream", &self.branch]);
        id
    }

    fn tip(&self, dir: &TempDir) -> String {
        git(
            dir.path(),
            &["rev-parse", &format!("refs/heads/{}", self.branch)],
        )
    }
}

fn blocked(reason: ForkSyncBlock, branch: Option<&str>, ahead: u32, behind: u32) -> ForkSync {
    ForkSync {
        status: ForkSyncStatus::Blocked,
        reason: Some(reason),
        branch: branch.map(str::to_owned),
        ahead,
        behind,
    }
}

#[test]
fn sync_fork_fast_forwards_origin() {
    let fx = Fork::new("main");
    assert!(fx.repo.has_fork_upstream().unwrap());
    let head = git(fx.w(), &["rev-parse", "HEAD"]);
    fs::write(fx.w().join("local.txt"), "mine\n").unwrap();
    fx.upstream_commit("b.txt");
    let tip = fx.upstream_commit("c.txt");

    let done = fx.repo.sync_fork().unwrap();
    assert_eq!(
        done,
        ForkSync {
            status: ForkSyncStatus::Synced,
            reason: None,
            branch: Some("main".into()),
            ahead: 0,
            behind: 2,
        }
    );
    assert_eq!(fx.tip(&fx.origin), tip);
    assert_eq!(git(fx.w(), &["rev-parse", "refs/remotes/origin/main"]), tip);
    // The local branch, index and work tree are left alone.
    assert_eq!(git(fx.w(), &["rev-parse", "HEAD"]), head);
    assert_eq!(git(fx.w(), &["status", "--porcelain"]), "?? local.txt");
}

#[test]
fn sync_fork_up_to_date() {
    let fx = Fork::new("main");
    let before = fx.tip(&fx.origin);
    let done = fx.repo.sync_fork().unwrap();
    assert_eq!(done.status, ForkSyncStatus::UpToDate);
    assert_eq!((done.ahead, done.behind), (0, 0));
    assert_eq!(done.branch.as_deref(), Some("main"));
    assert_eq!(fx.tip(&fx.origin), before);
}

#[test]
fn sync_fork_blocks_when_origin_diverged() {
    let fx = Fork::new("main");
    // The fork has its own commit on main.
    commit(fx.w(), "fork.txt");
    git(fx.w(), &["push", "-q", "origin", "main"]);
    let fork_tip = fx.tip(&fx.origin);

    // Only ahead: still not a fast-forward from upstream's side.
    let done = fx.repo.sync_fork().unwrap();
    assert_eq!(done, blocked(ForkSyncBlock::Diverged, Some("main"), 1, 0));

    fx.upstream_commit("b.txt");
    let done = fx.repo.sync_fork().unwrap();
    assert_eq!(done, blocked(ForkSyncBlock::Diverged, Some("main"), 1, 1));
    assert_eq!(fx.tip(&fx.origin), fork_tip);
}

#[test]
fn sync_fork_blocks_without_upstream_remote() {
    let fx = Fork::new("main");
    git(fx.w(), &["remote", "remove", "upstream"]);
    assert!(!fx.repo.has_fork_upstream().unwrap());
    let done = fx.repo.sync_fork().unwrap();
    assert_eq!(done, blocked(ForkSyncBlock::MissingUpstream, None, 0, 0));

    git(fx.w(), &["remote", "rename", "origin", "fork"]);
    git(fx.w(), &["remote", "add", "upstream", &url(&fx.upstream)]);
    assert!(!fx.repo.has_fork_upstream().unwrap());
    let done = fx.repo.sync_fork().unwrap();
    assert_eq!(done, blocked(ForkSyncBlock::MissingOrigin, None, 0, 0));
}

#[test]
fn upstream_default_branch_follows_upstream_head() {
    let fx = Fork::new("trunk");
    assert_eq!(
        fx.repo.upstream_default_branch().unwrap().as_deref(),
        Some("trunk")
    );
    let tip = fx.upstream_commit("b.txt");
    let done = fx.repo.sync_fork().unwrap();
    assert_eq!(done.status, ForkSyncStatus::Synced);
    assert_eq!(done.branch.as_deref(), Some("trunk"));
    assert_eq!(fx.tip(&fx.origin), tip);
}

#[test]
fn upstream_default_branch_falls_back_to_main() {
    let fx = Fork::new("main");
    // Upstream's HEAD names no branch, so `ls-remote` reports none.
    git(
        fx.upstream.path(),
        &["symbolic-ref", "HEAD", "refs/heads/gone"],
    );
    // Nothing fetched from upstream yet: no default.
    assert_eq!(fx.repo.upstream_default_branch().unwrap(), None);
    assert_eq!(
        fx.repo.sync_fork().unwrap(),
        blocked(ForkSyncBlock::MissingUpstreamDefaultBranch, None, 0, 0)
    );
    git(fx.w(), &["fetch", "-q", "upstream"]);
    assert_eq!(
        fx.repo.upstream_default_branch().unwrap().as_deref(),
        Some("main")
    );
}

#[test]
fn upstream_default_branch_falls_back_to_master() {
    let fx = Fork::new("master");
    git(
        fx.upstream.path(),
        &["symbolic-ref", "HEAD", "refs/heads/gone"],
    );
    git(fx.w(), &["fetch", "-q", "upstream"]);
    assert_eq!(
        fx.repo.upstream_default_branch().unwrap().as_deref(),
        Some("master")
    );
}

#[test]
fn sync_fork_blocks_when_origin_lacks_the_branch() {
    let fx = Fork::new("main");
    // Upstream moves its default to a branch the fork never had.
    git(fx.seed.path(), &["push", "-q", "upstream", "main:next"]);
    git(
        fx.upstream.path(),
        &["symbolic-ref", "HEAD", "refs/heads/next"],
    );
    let before = fx.tip(&fx.origin);
    let done = fx.repo.sync_fork().unwrap();
    assert_eq!(
        done,
        blocked(ForkSyncBlock::MissingOriginBranch, Some("next"), 0, 0)
    );
    assert_eq!(fx.tip(&fx.origin), before);
}
