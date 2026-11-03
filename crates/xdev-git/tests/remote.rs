use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_git::{GitError, Repo, Upstream};

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

fn commit_file(dir: &Path, name: &str, content: &str) -> String {
    fs::write(dir.join(name), content).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", &format!("add {name}")]);
    git(dir, &["rev-parse", "HEAD"])
}

/// A bare `origin` in a temp folder, a work repo on branch `feat` (cut from
/// `main`, which is on the remote) and a second clone to move the remote.
/// Nothing here touches the network.
struct Fixture {
    origin: TempDir,
    work: TempDir,
    other: TempDir,
    repo: Repo,
}

impl Fixture {
    fn new() -> Fixture {
        let origin = TempDir::with_prefix("remote origin ").unwrap();
        git(
            origin.path(),
            &["init", "-q", "--bare", "--initial-branch=main"],
        );
        let url = origin.path().to_str().unwrap().to_owned();

        let work = TempDir::with_prefix("remote work ").unwrap();
        git(work.path(), &["init", "-q", "--initial-branch=main"]);
        identity(work.path());
        commit_file(work.path(), "a.txt", "a\n");
        git(work.path(), &["remote", "add", "origin", &url]);
        git(work.path(), &["push", "-q", "origin", "main"]);
        git(work.path(), &["switch", "-q", "-c", "feat"]);

        let other = TempDir::with_prefix("remote other ").unwrap();
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

    /// Where the remote's branch points.
    fn remote_ref(&self, branch: &str) -> String {
        git(
            self.origin.path(),
            &["rev-parse", &format!("refs/heads/{branch}")],
        )
    }

    fn head(&self) -> String {
        git(self.work.path(), &["rev-parse", "HEAD"])
    }

    /// Publishes `feat` from the work repo, then lets the other clone check
    /// it out.
    fn publish(&self) {
        self.repo.push().unwrap();
        git(self.other.path(), &["fetch", "-q", "origin"]);
        git(self.other.path(), &["switch", "-q", "feat"]);
    }

    /// The other clone pushes a commit to `feat`; returns its id.
    fn move_remote(&self, name: &str) -> String {
        let id = commit_file(self.other.path(), name, "other\n");
        git(self.other.path(), &["push", "-q", "origin", "feat"]);
        id
    }
}

#[test]
fn remote_for_prefers_branch_config_then_origin() {
    let fx = Fixture::new();
    let w = fx.work.path();
    let up = TempDir::with_prefix("remote up ").unwrap();
    git(up.path(), &["init", "-q", "--bare"]);
    let up_url = up.path().to_str().unwrap();
    git(w, &["remote", "add", "up", up_url]);

    // No branch setting: origin.
    assert_eq!(fx.repo.remote_for("feat").unwrap(), "origin");
    // The branch's own remote wins.
    git(w, &["config", "branch.feat.remote", "up"]);
    assert_eq!(fx.repo.remote_for("feat").unwrap(), "up");
    assert_eq!(fx.repo.remote_for("other").unwrap(), "origin");

    // Without origin the only remote is used; two of them are ambiguous.
    git(w, &["config", "--unset", "branch.feat.remote"]);
    git(w, &["remote", "remove", "origin"]);
    assert_eq!(fx.repo.remote_for("feat").unwrap(), "up");
    git(w, &["remote", "add", "second", up_url]);
    assert!(matches!(
        fx.repo.remote_for("feat"),
        Err(GitError::NoRemote)
    ));
    // A name git could read as an option never reaches it.
    assert!(matches!(
        fx.repo.remote_for("--all"),
        Err(GitError::BadId(_))
    ));
}

#[test]
fn no_remote_is_reported() {
    let dir = TempDir::with_prefix("remote none ").unwrap();
    git(dir.path(), &["init", "-q", "--initial-branch=main"]);
    identity(dir.path());
    commit_file(dir.path(), "a.txt", "a\n");
    let repo = Repo::discover(dir.path()).unwrap();

    let err = repo.push().unwrap_err();
    assert!(matches!(err, GitError::NoRemote), "{err:?}");
    assert_eq!(err.code(), "no_remote");
    assert!(matches!(repo.fetch(), Err(GitError::NoRemote)));
    assert_eq!(repo.upstream().unwrap(), None);
}

#[test]
fn push_sets_upstream() {
    let fx = Fixture::new();
    let id = commit_file(fx.work.path(), "b.txt", "b\n");
    assert_eq!(fx.repo.upstream().unwrap(), None);
    assert!(!fx.repo.head_on_upstream().unwrap());

    fx.repo.push().unwrap();

    assert_eq!(fx.remote_ref("feat"), id);
    assert_eq!(
        fx.repo.upstream().unwrap(),
        Some(Upstream {
            remote: "origin".into(),
            branch: "feat".into(),
            id: Some(id),
            ahead: 0,
            behind: 0,
        })
    );
    assert!(fx.repo.head_on_upstream().unwrap());
    // Pushing what is already there is fine.
    fx.repo.push().unwrap();
}

#[test]
fn upstream_counts_ahead_and_behind() {
    let fx = Fixture::new();
    commit_file(fx.work.path(), "b.txt", "b\n");
    fx.publish();
    commit_file(fx.work.path(), "c.txt", "c\n");
    let seen = fx.move_remote("d.txt");

    // The remote moved, but nothing fetched it yet.
    let up = fx.repo.upstream().unwrap().unwrap();
    assert_eq!((up.ahead, up.behind), (1, 0));
    assert!(!fx.repo.head_on_upstream().unwrap());

    fx.repo.fetch().unwrap();
    let up = fx.repo.upstream().unwrap().unwrap();
    assert_eq!((up.ahead, up.behind), (1, 1));
    assert_eq!(up.id.as_deref(), Some(seen.as_str()));
}

#[test]
fn pull_fast_forwards() {
    let fx = Fixture::new();
    commit_file(fx.work.path(), "b.txt", "b\n");
    fx.publish();
    let moved = fx.move_remote("d.txt");

    fx.repo.pull().unwrap();

    assert_eq!(fx.head(), moved);
    assert!(fx.work.path().join("d.txt").exists());
    let up = fx.repo.upstream().unwrap().unwrap();
    assert_eq!((up.ahead, up.behind), (0, 0));
}

#[test]
fn pull_without_upstream_is_reported() {
    let fx = Fixture::new();
    let err = fx.repo.pull().unwrap_err();
    assert!(matches!(err, GitError::NoUpstream), "{err:?}");
    assert_eq!(err.code(), "no_upstream");
}

#[test]
fn pull_refuses_diverged() {
    let fx = Fixture::new();
    commit_file(fx.work.path(), "b.txt", "b\n");
    fx.publish();
    let mine = commit_file(fx.work.path(), "c.txt", "c\n");
    fx.move_remote("d.txt");

    let err = fx.repo.pull().unwrap_err();

    assert!(matches!(err, GitError::Diverged), "{err:?}");
    assert_eq!(err.code(), "pull_diverged");
    // No merge commit, no rebase, no file from the other side.
    assert_eq!(fx.head(), mine);
    assert!(!fx.work.path().join("d.txt").exists());
}

#[test]
fn push_rejected_when_behind() {
    let fx = Fixture::new();
    commit_file(fx.work.path(), "b.txt", "b\n");
    fx.publish();
    commit_file(fx.work.path(), "c.txt", "c\n");
    let moved = fx.move_remote("d.txt");

    let err = fx.repo.push().unwrap_err();

    assert!(
        matches!(&err, GitError::Rejected(d) if !d.is_empty()),
        "{err:?}"
    );
    assert_eq!(err.code(), "push_rejected");
    assert_eq!(fx.remote_ref("feat"), moved);
}

#[test]
fn force_push_replaces_with_matching_lease() {
    let fx = Fixture::new();
    commit_file(fx.work.path(), "b.txt", "b\n");
    fx.publish();
    fx.move_remote("d.txt");
    fx.repo.fetch().unwrap();
    // The id the person saw in the dialog.
    let seen = fx.repo.upstream().unwrap().unwrap().id.unwrap();
    let mine = commit_file(fx.work.path(), "c.txt", "c\n");

    fx.repo.force_push(&seen).unwrap();

    assert_eq!(fx.remote_ref("feat"), mine);
    assert!(fx.repo.head_on_upstream().unwrap());
}

#[test]
fn force_push_refuses_when_remote_moved() {
    let fx = Fixture::new();
    commit_file(fx.work.path(), "b.txt", "b\n");
    fx.publish();
    fx.move_remote("d.txt");
    fx.repo.fetch().unwrap();
    let seen = fx.repo.upstream().unwrap().unwrap().id.unwrap();
    commit_file(fx.work.path(), "c.txt", "c\n");
    // Someone else pushes after the lease id was read.
    let newest = commit_file(fx.other.path(), "e.txt", "e\n");
    git(fx.other.path(), &["push", "-q", "origin", "feat"]);

    let err = fx.repo.force_push(&seen).unwrap_err();

    assert!(matches!(err, GitError::Rejected(_)), "{err:?}");
    assert_eq!(err.code(), "push_rejected");
    assert_eq!(fx.remote_ref("feat"), newest);
}

#[test]
fn force_push_rejects_a_bad_lease_id() {
    let fx = Fixture::new();
    for bad in ["", "--delete", "HEAD", "ABCD1234", "abc"] {
        assert!(
            matches!(fx.repo.force_push(bad), Err(GitError::BadId(_))),
            "{bad:?}"
        );
    }
}

#[test]
fn branch_vs_base_counts_lines_and_commits() {
    let fx = Fixture::new();
    let base = fx.head();
    fs::write(fx.work.path().join("a.txt"), "a\nmore\n").unwrap();
    git(fx.work.path(), &["add", "-A"]);
    git(fx.work.path(), &["commit", "-q", "-m", "edit a"]);
    let second = commit_file(fx.work.path(), "b.txt", "1\n2\n3\n");

    let range = fx.repo.branch_vs_base("main", 10).unwrap();
    assert_eq!(range.merge_base, base);
    assert_eq!((range.added, range.removed), (4, 0));
    assert!(!range.truncated);
    assert_eq!(range.commits.len(), 2);
    assert_eq!(range.commits[0].id, second);
    assert_eq!(range.commits[0].message, "add b.txt");
    assert_eq!(range.commits[1].message, "edit a");

    let short = fx.repo.branch_vs_base("main", 1).unwrap();
    assert_eq!(short.commits.len(), 1);
    assert!(short.truncated);
    assert_eq!((short.added, short.removed), (4, 0));

    // Lines the branch replaces count as removed, and the sums cover the
    // whole range, not one commit.
    commit_file(fx.work.path(), "a.txt", "x\n");
    let range = fx.repo.branch_vs_base("main", 10).unwrap();
    assert_eq!((range.added, range.removed), (4, 1));
    assert_eq!(range.commits.len(), 3);

    // A branch with nothing new is empty.
    git(fx.work.path(), &["switch", "-q", "main"]);
    let empty = fx.repo.branch_vs_base("main", 10).unwrap();
    assert_eq!((empty.added, empty.removed), (0, 0));
    assert!(empty.commits.is_empty() && !empty.truncated);

    assert!(fx.repo.branch_vs_base("no-such-branch", 10).is_err());
    assert!(matches!(
        fx.repo.branch_vs_base("--all", 10),
        Err(GitError::BadId(_))
    ));
}

#[test]
fn detached_head_refuses_push() {
    let fx = Fixture::new();
    commit_file(fx.work.path(), "b.txt", "b\n");
    fx.publish();
    git(fx.work.path(), &["switch", "-q", "--detach"]);

    for result in [fx.repo.push(), fx.repo.pull(), fx.repo.force_push("abcd")] {
        let err = result.unwrap_err();
        assert!(matches!(err, GitError::Detached), "{err:?}");
        assert_eq!(err.code(), "detached");
    }
    assert_eq!(fx.repo.upstream().unwrap(), None);
    // A detached worktree can still fetch.
    fx.repo.fetch().unwrap();
}
