mod common;

use common::{Fixture, commit_file, git};
use tempfile::TempDir;
use xdev_git::{LOG_LIMIT, RefKind, Repo};

fn kinds(refs: &[xdev_git::CommitRef]) -> Vec<(String, RefKind)> {
    refs.iter().map(|r| (r.name.clone(), r.kind)).collect()
}

#[test]
fn a_merge_keeps_its_parents_in_order() {
    let fx = Fixture::new();
    let w = fx.w();
    let main = fx.head();
    git(w, &["switch", "-q", "-c", "side"]);
    let side = commit_file(w, "s.txt", "s\n");
    git(w, &["switch", "-q", "feat"]);
    let feat = commit_file(w, "f.txt", "f\n");
    git(w, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    let log = fx.repo.repo_log(None, LOG_LIMIT, 0).unwrap();
    let merge = &log.commits[0];
    assert_eq!(merge.parents, [feat, side]);
    assert_eq!(merge.subject, "merge side");
    assert_eq!(log.commits.last().unwrap().id, main);
    assert_eq!(log.head.as_deref(), Some(merge.id.as_str()));
    assert_eq!(log.branch.as_deref(), Some("feat"));
}

#[test]
fn refs_are_branches_remotes_and_tags_without_head() {
    let fx = Fixture::new();
    let w = fx.w();
    git(w, &["tag", "v1"]);
    git(w, &["remote", "set-head", "origin", "main"]);
    let refs = &fx.repo.repo_log(None, LOG_LIMIT, 0).unwrap().commits[0].refs;
    let got = kinds(refs);
    for want in [
        ("feat".to_owned(), RefKind::Branch),
        ("main".to_owned(), RefKind::Branch),
        ("origin/main".to_owned(), RefKind::Remote),
        ("v1".to_owned(), RefKind::Tag),
    ] {
        assert!(got.contains(&want), "{want:?} in {got:?}");
    }
    assert!(got.iter().all(|(n, _)| n != "HEAD" && n != "origin/HEAD"));
}

#[test]
fn limit_has_more_and_skip() {
    let fx = Fixture::new();
    let w = fx.w();
    let b = commit_file(w, "b.txt", "b\n");
    let c = commit_file(w, "c.txt", "c\n");
    let first = fx.repo.repo_log(None, 2, 0).unwrap();
    assert_eq!(
        first.commits.iter().map(|x| &x.id).collect::<Vec<_>>(),
        [&c, &b]
    );
    assert!(first.has_more);
    let rest = fx.repo.repo_log(None, 2, 2).unwrap();
    assert_eq!(rest.commits.len(), 1);
    assert!(!rest.has_more);
    let all = fx.repo.repo_log(None, 3, 0).unwrap();
    assert_eq!(all.commits.len(), 3);
    assert!(!all.has_more);
}

#[test]
fn an_unborn_head_is_an_empty_log() {
    let dir = TempDir::with_prefix("log unborn ").unwrap();
    git(dir.path(), &["init", "-q", "--initial-branch=main"]);
    let log = Repo::discover(dir.path())
        .unwrap()
        .repo_log(None, 50, 0)
        .unwrap();
    assert!(log.commits.is_empty());
    assert_eq!(log.head, None);
    assert_eq!(log.branch, None);
    assert!(!log.has_more && !log.incoming && !log.outgoing);
}

#[test]
fn a_detached_head_has_no_branch() {
    let fx = Fixture::new();
    git(fx.w(), &["switch", "-q", "--detach"]);
    let log = fx.repo.repo_log(None, 50, 0).unwrap();
    assert_eq!(log.branch, None);
    assert_eq!(log.head, Some(fx.head()));
}

#[test]
fn upstream_base_merge_base_incoming_and_outgoing() {
    let fx = Fixture::new();
    let main = fx.head();
    commit_file(fx.w(), "f.txt", "f\n");
    fx.publish();
    let pushed = fx.head();
    let theirs = fx.move_remote("g.txt");
    git(fx.w(), &["fetch", "-q", "origin"]);
    let mine = commit_file(fx.w(), "h.txt", "h\n");

    let log = fx.repo.repo_log(Some("main"), 50, 0).unwrap();
    let up = log.upstream.as_ref().unwrap();
    assert_eq!(
        (up.name.as_str(), up.id.as_str()),
        ("origin/feat", theirs.as_str())
    );
    let base = log.base.as_ref().unwrap();
    assert_eq!(
        (base.name.as_str(), base.id.as_str()),
        ("main", main.as_str())
    );
    assert_eq!(log.merge_base.as_deref(), Some(main.as_str()));
    assert!(log.incoming);
    assert!(log.outgoing);
    assert_eq!(log.head.as_deref(), Some(mine.as_str()));

    // Without a base the merge base is taken against the upstream.
    let log = fx.repo.repo_log(None, 50, 0).unwrap();
    assert!(log.base.is_none());
    assert_eq!(log.merge_base.as_deref(), Some(pushed.as_str()));
}

#[test]
fn a_base_equal_to_the_upstream_is_not_a_base() {
    let fx = Fixture::new();
    commit_file(fx.w(), "f.txt", "f\n");
    fx.publish();
    let log = fx.repo.repo_log(Some("origin/feat"), 50, 0).unwrap();
    assert!(log.base.is_none());
    assert!(log.upstream.is_some());
    assert!(!log.incoming);
    assert!(!log.outgoing);
}

#[test]
fn an_empty_message_has_an_empty_subject_and_a_body_keeps_blank_lines() {
    let fx = Fixture::new();
    let w = fx.w();
    std::fs::write(w.join("e.txt"), "e\n").unwrap();
    git(w, &["add", "-A"]);
    git(w, &["commit", "-q", "--allow-empty-message", "-m", ""]);
    let empty = fx.repo.repo_log(None, 1, 0).unwrap().commits.remove(0);
    assert_eq!(empty.subject, "");
    assert_eq!(empty.body, "");

    std::fs::write(w.join("m.txt"), "m\n").unwrap();
    git(w, &["add", "-A"]);
    git(
        w,
        &[
            "commit",
            "-q",
            "-m",
            "subject line",
            "-m",
            "first\n\nsecond",
        ],
    );
    let c = fx.repo.repo_log(None, 1, 0).unwrap().commits.remove(0);
    assert_eq!(c.subject, "subject line");
    assert_eq!(c.body, "first\n\nsecond");
    assert_eq!(c.author, "Test User");
    assert_eq!(c.email, "test@example.com");
    assert!(c.time > 0);
}
