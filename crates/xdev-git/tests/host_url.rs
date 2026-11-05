mod common;

use common::{Fixture, commit_file, git};
use xdev_git::HostKind;

const GITHUB: &str = "git@github.com:o/r.git";

/// The remote keeps its tracking refs, but its URL now names a host, so
/// nothing under test could reach a real server.
fn hosted(fx: &Fixture) {
    git(fx.w(), &["fetch", "-q", "origin"]);
    git(fx.w(), &["config", "remote.origin.url", GITHUB]);
}

fn target(fx: &Fixture) -> Option<(String, String)> {
    fx.repo
        .file_host_target()
        .unwrap()
        .map(|(host, git_ref)| (host.base, git_ref))
}

#[test]
fn origin_host_reads_the_origin_url() {
    let fx = Fixture::new();
    assert_eq!(fx.repo.origin_host().unwrap(), None);
    hosted(&fx);
    let host = fx.repo.origin_host().unwrap().unwrap();
    assert_eq!(host.kind, HostKind::Github);
    assert_eq!(host.base, "https://github.com/o/r");
}

#[test]
fn a_remote_that_is_not_a_hosted_one_has_no_target() {
    let fx = Fixture::new();
    assert_eq!(fx.repo.file_host_target().unwrap(), None);
    git(
        fx.w(),
        &["config", "remote.origin.url", "git@example.com:o/r.git"],
    );
    assert_eq!(fx.repo.file_host_target().unwrap(), None);
}

#[test]
fn a_pushed_head_links_by_its_id() {
    let fx = Fixture::new();
    commit_file(fx.w(), "f.txt", "f\n");
    fx.publish();
    hosted(&fx);
    assert_eq!(
        target(&fx),
        Some(("https://github.com/o/r".into(), fx.head()))
    );
}

#[test]
fn an_unpushed_head_links_by_the_upstream_branch() {
    let fx = Fixture::new();
    commit_file(fx.w(), "f.txt", "f\n");
    fx.publish();
    hosted(&fx);
    commit_file(fx.w(), "g.txt", "g\n");
    assert_eq!(
        target(&fx),
        Some(("https://github.com/o/r".into(), "feat".into()))
    );
}

#[test]
fn without_an_upstream_it_uses_the_remote_default_branch() {
    let fx = Fixture::new();
    git(fx.w(), &["fetch", "-q", "origin"]);
    git(fx.w(), &["remote", "set-head", "origin", "main"]);
    git(fx.w(), &["config", "remote.origin.url", GITHUB]);
    commit_file(fx.w(), "g.txt", "g\n");
    assert_eq!(
        target(&fx),
        Some(("https://github.com/o/r".into(), "main".into()))
    );
}

#[test]
fn without_a_default_branch_it_tries_main_then_master() {
    let fx = Fixture::new();
    git(fx.w(), &["fetch", "-q", "origin"]);
    git(fx.w(), &["config", "remote.origin.url", GITHUB]);
    commit_file(fx.w(), "g.txt", "g\n");
    assert_eq!(target(&fx).unwrap().1, "main");

    // No remote-tracking ref at all still names `main`.
    git(fx.w(), &["update-ref", "-d", "refs/remotes/origin/main"]);
    assert_eq!(target(&fx).unwrap().1, "main");
}
