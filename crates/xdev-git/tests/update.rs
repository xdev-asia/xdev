mod common;

use std::fs;

use common::{Fixture, commit_file, git};
use xdev_git::{ConflictOp, GitError, PullPolicy};

/// `feat` is published and the other clone has pushed `g.txt`.
fn behind() -> (Fixture, String) {
    let fx = Fixture::new();
    commit_file(fx.w(), "f.txt", "f\n");
    fx.publish();
    let theirs = fx.move_remote("g.txt");
    (fx, theirs)
}

/// Like `behind`, with a local commit `h.txt` too.
fn split() -> (Fixture, String, String) {
    let (fx, theirs) = behind();
    let mine = commit_file(fx.w(), "h.txt", "h\n");
    (fx, theirs, mine)
}

fn parents(fx: &Fixture, rev: &str) -> Vec<String> {
    git(fx.w(), &["rev-list", "--parents", "-n", "1", rev])
        .split_whitespace()
        .skip(1)
        .map(str::to_owned)
        .collect()
}

#[test]
fn fast_forward_moves_a_branch_that_is_behind() {
    let (fx, theirs) = behind();
    fx.repo.fast_forward().unwrap();
    assert_eq!(fx.head(), theirs);
    assert!(fx.w().join("g.txt").exists());
}

#[test]
fn fast_forward_on_a_split_is_diverged() {
    let (fx, _, mine) = split();
    assert!(matches!(fx.repo.fast_forward(), Err(GitError::Diverged)));
    assert_eq!(fx.head(), mine);
}

#[test]
fn fast_forward_without_an_upstream_or_on_a_detached_head() {
    let fx = Fixture::new();
    assert!(matches!(fx.repo.fast_forward(), Err(GitError::NoUpstream)));
    git(fx.w(), &["switch", "-q", "--detach"]);
    assert!(matches!(fx.repo.fast_forward(), Err(GitError::Detached)));
}

#[test]
fn a_dirty_file_the_pull_overwrites_is_dirty() {
    let (fx, _) = behind();
    let other = fx.other.path();
    fs::write(other.join("a.txt"), "remote\n").unwrap();
    git(other, &["commit", "-q", "-am", "edit a"]);
    git(other, &["push", "-q", "origin", "feat"]);
    fs::write(fx.w().join("a.txt"), "local\n").unwrap();
    let err = fx.repo.fast_forward().unwrap_err();
    assert!(matches!(err, GitError::Dirty("fast-forward")), "{err:?}");
    assert_eq!(err.code(), "update_dirty");
    assert_eq!(fs::read_to_string(fx.w().join("a.txt")).unwrap(), "local\n");
}

#[test]
fn an_untracked_file_in_the_way_is_untracked() {
    let (fx, _) = behind();
    fs::write(fx.w().join("g.txt"), "mine\n").unwrap();
    let err = fx.repo.fast_forward().unwrap_err();
    assert!(
        matches!(err, GitError::Untracked("fast-forward")),
        "{err:?}"
    );
    assert_eq!(err.code(), "update_untracked");
}

#[test]
fn merge_makes_a_merge_commit() {
    let (fx, theirs, mine) = split();
    fx.repo.pull_with(PullPolicy::Merge).unwrap();
    assert_eq!(parents(&fx, "HEAD"), [mine, theirs]);
    assert!(fx.w().join("g.txt").exists() && fx.w().join("h.txt").exists());
}

#[test]
fn rebase_puts_the_work_on_top() {
    let (fx, theirs, mine) = split();
    fx.repo.pull_with(PullPolicy::Rebase).unwrap();
    assert_eq!(parents(&fx, "HEAD"), [theirs]);
    assert_ne!(fx.head(), mine);
    assert!(fx.w().join("g.txt").exists() && fx.w().join("h.txt").exists());
}

#[test]
fn ff_only_on_a_split_is_diverged() {
    let (fx, _, _) = split();
    assert!(matches!(
        fx.repo.pull_with(PullPolicy::FfOnly),
        Err(GitError::Diverged)
    ));
}

#[test]
fn git_config_falls_back_to_a_merge_when_git_has_no_policy() {
    let (fx, theirs, mine) = split();
    // Whatever the machine's own config says, a split pull must end up
    // holding both sides.
    fx.repo.pull_with(PullPolicy::GitConfig).unwrap();
    assert!(fx.w().join("g.txt").exists() && fx.w().join("h.txt").exists());
    let merged = git(fx.w(), &["merge-base", "--is-ancestor", &theirs, "HEAD"]);
    assert!(merged.is_empty());
    assert_ne!(fx.head(), mine);
}

#[test]
fn git_config_that_forbids_a_merge_needs_a_policy() {
    let (fx, _, mine) = split();
    git(fx.w(), &["config", "pull.rebase", "false"]);
    git(fx.w(), &["config", "pull.ff", "only"]);
    let err = fx.repo.pull_with(PullPolicy::GitConfig).unwrap_err();
    assert!(matches!(err, GitError::PullPolicy), "{err:?}");
    assert_eq!(err.code(), "pull_policy");
    assert_eq!(fx.head(), mine);
}

#[test]
fn a_conflicting_merge_stops_and_stays_in_progress() {
    let (fx, _) = behind();
    let other = fx.other.path();
    fs::write(other.join("a.txt"), "remote\n").unwrap();
    git(other, &["commit", "-q", "-am", "remote a"]);
    git(other, &["push", "-q", "origin", "feat"]);
    commit_file(fx.w(), "a.txt", "local\n");
    let err = fx.repo.pull_with(PullPolicy::Merge).unwrap_err();
    assert!(matches!(err, GitError::StoppedOnConflicts), "{err:?}");
    assert_eq!(err.code(), "update_conflicts");
    let state = fx.repo.conflict_state().unwrap().unwrap();
    assert_eq!(state.op, ConflictOp::Merge);
    // A second pull will not start on top of the first.
    assert!(matches!(
        fx.repo.pull_with(PullPolicy::Merge),
        Err(GitError::Conflicted)
    ));
}

#[test]
fn a_conflicting_rebase_stops_in_progress() {
    let (fx, _) = behind();
    let other = fx.other.path();
    fs::write(other.join("a.txt"), "remote\n").unwrap();
    git(other, &["commit", "-q", "-am", "remote a"]);
    git(other, &["push", "-q", "origin", "feat"]);
    commit_file(fx.w(), "a.txt", "local\n");
    let err = fx.repo.pull_with(PullPolicy::Rebase).unwrap_err();
    assert!(matches!(err, GitError::StoppedOnConflicts), "{err:?}");
    let state = fx.repo.conflict_state().unwrap().unwrap();
    assert_eq!(state.op, ConflictOp::Rebase);
}

#[test]
fn an_amend_after_a_push_is_rewritten_and_a_real_split_is_not() {
    let fx = Fixture::new();
    commit_file(fx.w(), "f.txt", "f\n");
    fx.publish();
    let clean = fx.repo.upstream().unwrap().unwrap();
    assert!(!clean.rewritten);

    git(fx.w(), &["commit", "-q", "--amend", "-m", "reworded"]);
    let up = fx.repo.upstream().unwrap().unwrap();
    assert_eq!((up.ahead, up.behind), (1, 1));
    assert!(up.rewritten);

    // A remote commit that no local commit copies makes it a real split.
    let fx = Fixture::new();
    commit_file(fx.w(), "f.txt", "f\n");
    fx.publish();
    fx.move_remote("g.txt");
    git(fx.w(), &["fetch", "-q", "origin"]);
    commit_file(fx.w(), "h.txt", "h\n");
    let up = fx.repo.upstream().unwrap().unwrap();
    assert_eq!((up.ahead, up.behind), (1, 1));
    assert!(!up.rewritten);
}

// Rebase from base.

/// The other clone adds a commit to `main` on the remote.
fn move_main(fx: &Fixture, name: &str) -> String {
    let other = fx.other.path();
    git(other, &["fetch", "-q", "origin"]);
    git(other, &["switch", "-q", "main"]);
    git(other, &["reset", "-q", "--hard", "origin/main"]);
    let id = commit_file(other, name, "main\n");
    git(other, &["push", "-q", "origin", "main"]);
    id
}

fn rebase_refs(fx: &Fixture) -> String {
    git(fx.w(), &["for-each-ref", "refs/xdev/rebase"])
}

fn subjects(fx: &Fixture, range: &str) -> Vec<String> {
    git(fx.w(), &["log", "--format=%s", range])
        .lines()
        .map(str::to_owned)
        .collect()
}

#[test]
fn rebase_from_base_puts_the_branch_on_the_moved_base() {
    let fx = Fixture::new();
    commit_file(fx.w(), "f.txt", "f\n");
    let moved = move_main(&fx, "m.txt");
    fx.repo.rebase_from_base("origin/main").unwrap();
    assert_eq!(parents(&fx, "HEAD").len(), 1);
    assert_eq!(parents(&fx, "HEAD~1"), parents(&fx, &moved));
    assert!(git(fx.w(), &["merge-base", "--is-ancestor", &moved, "HEAD"]).is_empty());
    assert!(fx.w().join("m.txt").exists() && fx.w().join("f.txt").exists());
    assert_eq!(rebase_refs(&fx), "");
    // The tracking ref moved with it.
    assert_eq!(git(fx.w(), &["rev-parse", "origin/main"]), moved);
}

#[test]
fn the_fork_point_keeps_a_rewritten_base_from_being_replayed() {
    let fx = Fixture::new();
    move_main(&fx, "base.txt");
    // The branch starts on that base commit and adds its own.
    git(fx.w(), &["fetch", "-q", "origin"]);
    git(fx.w(), &["reset", "-q", "--hard", "origin/main"]);
    commit_file(
        fx.w(),
        "f.txt",
        "f
",
    );
    // The remote rewrites the base commit with other content.
    let other = fx.other.path();
    fs::write(
        other.join("base.txt"),
        "rewritten
",
    )
    .unwrap();
    git(
        other,
        &["commit", "-q", "-a", "--amend", "-m", "base again"],
    );
    git(other, &["push", "-q", "--force", "origin", "main"]);
    fx.repo.rebase_from_base("origin/main").unwrap();
    assert_eq!(
        subjects(&fx, "origin/main..HEAD"),
        ["add f.txt"],
        "only the branch's own commit is replayed"
    );
    assert_eq!(rebase_refs(&fx), "");
}

#[test]
fn without_a_fork_point_it_is_a_plain_rebase() {
    let fx = Fixture::new();
    commit_file(fx.w(), "f.txt", "f\n");
    let moved = move_main(&fx, "m.txt");
    git(fx.w(), &["reflog", "expire", "--expire=now", "--all"]);
    fx.repo.rebase_from_base("origin/main").unwrap();
    assert!(git(fx.w(), &["merge-base", "--is-ancestor", &moved, "HEAD"]).is_empty());
    assert_eq!(subjects(&fx, "origin/main..HEAD"), ["add f.txt"]);
}

#[test]
fn rebase_conflicts_are_left_in_progress() {
    let fx = Fixture::new();
    commit_file(fx.w(), "a.txt", "mine\n");
    let other = fx.other.path();
    git(other, &["switch", "-q", "main"]);
    fs::write(other.join("a.txt"), "theirs\n").unwrap();
    git(other, &["commit", "-q", "-am", "theirs"]);
    git(other, &["push", "-q", "origin", "main"]);
    let err = fx.repo.rebase_from_base("origin/main").unwrap_err();
    assert!(matches!(err, GitError::StoppedOnConflicts), "{err:?}");
    assert_eq!(
        fx.repo.conflict_state().unwrap().unwrap().op,
        ConflictOp::Rebase
    );
    assert_eq!(rebase_refs(&fx), "");
    assert!(matches!(
        fx.repo.rebase_from_base("origin/main"),
        Err(GitError::Conflicted)
    ));
}

#[test]
fn a_dirty_tree_starts_no_rebase() {
    let fx = Fixture::new();
    commit_file(fx.w(), "f.txt", "f\n");
    move_main(&fx, "m.txt");
    let before = fx.head();
    fs::write(fx.w().join("a.txt"), "dirty\n").unwrap();
    let err = fx.repo.rebase_from_base("origin/main").unwrap_err();
    assert!(matches!(err, GitError::Dirty("rebase")), "{err:?}");
    assert!(fx.repo.conflict_state().unwrap().is_none());
    assert_eq!(fx.head(), before);
    assert_eq!(rebase_refs(&fx), "");
}

#[test]
fn a_base_that_is_not_remote_is_refused() {
    let fx = Fixture::new();
    for base in ["main", "nope", "feat", ""] {
        assert!(
            matches!(fx.repo.rebase_from_base(base), Err(GitError::BaseNotRemote)),
            "{base:?}"
        );
    }
}

#[test]
fn a_local_base_that_tracks_a_remote_is_accepted() {
    let fx = Fixture::new();
    commit_file(fx.w(), "f.txt", "f\n");
    let moved = move_main(&fx, "m.txt");
    git(fx.w(), &["branch", "-q", "-u", "origin/main", "main"]);
    fx.repo.rebase_from_base("main").unwrap();
    assert!(git(fx.w(), &["merge-base", "--is-ancestor", &moved, "HEAD"]).is_empty());
}

#[test]
fn the_temp_ref_is_gone_after_a_failed_fetch() {
    let fx = Fixture::new();
    commit_file(fx.w(), "f.txt", "f\n");
    let missing = fx.work.path().join("no such remote");
    git(
        fx.w(),
        &["remote", "set-url", "origin", missing.to_str().unwrap()],
    );
    let before = fx.head();
    assert!(fx.repo.rebase_from_base("origin/main").is_err());
    assert_eq!(rebase_refs(&fx), "");
    assert_eq!(fx.head(), before);
}
