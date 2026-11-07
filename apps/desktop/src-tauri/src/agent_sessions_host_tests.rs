use std::cell::Cell;

use xdev_kit::{Agent, AgentSession, SessionIndex};
use xdev_ssh::RemoteProject;

use super::*;

fn query(scope: SessionScope, host: Option<&str>) -> SessionQuery {
    SessionQuery {
        text: None,
        scope,
        agent: None,
        home_id: None,
        sort: SessionSort::LastDesc,
        limit: 100,
        host: host.map(str::to_owned),
    }
}

fn host_session(id: &str, cwd: &str, title: &str, last: i64) -> AgentSession {
    AgentSession {
        key: format!("ssh-a-claude:{id}"),
        id: id.into(),
        home_id: "ssh-a-claude".into(),
        agent: Agent::Claude,
        cwd: Some(cwd.into()),
        branch: None,
        title: Some(title.into()),
        model: None,
        first: last - 10,
        last,
        messages: 2,
    }
}

/// A data dir with host `ssh-a`: one saved project `/srv/p`, and mirrored
/// sessions in it, in a subfolder of it and in `/srv/other`.
fn data_with_host() -> tempfile::TempDir {
    let data = tempfile::tempdir().unwrap();
    crate::remote_ssh::store::save_projects(
        data.path(),
        &[RemoteProject {
            id: "p1".into(),
            host_id: "ssh-a".into(),
            path: "/srv/p".into(),
            name: "p".into(),
            keep_alive: false,
            added_ms: 0,
        }],
    )
    .unwrap();
    let mut index = SessionIndex::default();
    for s in [
        host_session("h1", "/srv/p", "Fix the parser", 50),
        host_session("h2", "/srv/p/src", "Add a panel", 40),
        host_session("h3", "/srv/other", "Unrelated work", 30),
    ] {
        index.sessions.insert(s.key.clone(), s);
    }
    index
        .save(&crate::hosts::host_dir(data.path(), "ssh-a"))
        .unwrap();
    data
}

fn ids(rows: &[SessionRow]) -> Vec<&str> {
    rows.iter().map(|r| r.session.id.as_str()).collect()
}

#[test]
fn an_ssh_scope_is_routed_to_its_host_and_all_needs_the_host_field() {
    let wt = SessionScope::Worktree {
        path: "ssh://ssh-a/srv/p".into(),
    };
    assert_eq!(route(&query(wt, None)).as_deref(), Some("ssh-a"));
    let repo = SessionScope::Repo {
        path: "ssh://ssh-b/srv/p".into(),
    };
    assert_eq!(route(&query(repo, Some("ssh-a"))).as_deref(), Some("ssh-b"));
    assert_eq!(
        route(&query(SessionScope::All, Some("ssh-a"))).as_deref(),
        Some("ssh-a")
    );
    assert_eq!(route(&query(SessionScope::All, None)), None);
    let local = SessionScope::Worktree {
        path: "/home/u/repo".into(),
    };
    assert_eq!(route(&query(local, Some("ssh-a"))), None);
}

#[test]
fn a_worktree_scope_of_a_host_folder_lists_its_sessions() {
    let data = data_with_host();
    let q = query(
        SessionScope::Worktree {
            path: "ssh://ssh-a/srv/p".into(),
        },
        None,
    );
    let rows = host_sessions(data.path(), "ssh-a", &q, None).unwrap();
    assert_eq!(ids(&rows), ["h1", "h2"]);
    for row in &rows {
        assert_eq!(row.worktree.as_deref(), Some("ssh://ssh-a/srv/p"));
        assert_eq!(row.repo.as_deref(), Some("ssh://ssh-a/srv/p"));
        assert!(row.resumable);
    }
}

#[test]
fn scope_all_with_a_host_lists_every_row_of_that_host_only() {
    let data = data_with_host();
    let rows = host_sessions(
        data.path(),
        "ssh-a",
        &query(SessionScope::All, Some("ssh-a")),
        None,
    )
    .unwrap();
    assert_eq!(ids(&rows), ["h1", "h2", "h3"]);
    // Outside every saved project: no folder, and it cannot be resumed.
    assert_eq!(rows[2].worktree, None);
    assert!(!rows[2].resumable);
    // Another host has no mirror here.
    let none = host_sessions(
        data.path(),
        "ssh-b",
        &query(SessionScope::All, Some("ssh-b")),
        None,
    )
    .unwrap();
    assert!(none.is_empty());
}

#[test]
fn a_scope_outside_the_saved_projects_still_filters() {
    let data = data_with_host();
    let q = query(
        SessionScope::Worktree {
            path: "ssh://ssh-a/srv/other".into(),
        },
        None,
    );
    let rows = host_sessions(data.path(), "ssh-a", &q, None).unwrap();
    assert_eq!(ids(&rows), ["h3"]);
    assert!(!rows[0].resumable);
}

#[test]
fn a_failed_sync_leaves_the_cached_rows_without_an_error() {
    let data = data_with_host();
    let calls = Cell::new(0);
    let sync = || {
        calls.set(calls.get() + 1);
        Err(crate::remote_ssh::offline("not connected"))
    };
    let rows = host_sessions(
        data.path(),
        "ssh-a",
        &query(SessionScope::All, Some("ssh-a")),
        Some(&sync),
    )
    .unwrap();
    assert_eq!((calls.get(), rows.len()), (1, 3));
}

#[test]
fn a_text_query_matches_the_metadata_only() {
    let data = data_with_host();
    let mut q = query(SessionScope::All, Some("ssh-a"));
    q.text = Some("parser".into());
    let rows = host_sessions(data.path(), "ssh-a", &q, None).unwrap();
    assert_eq!(ids(&rows), ["h1"]);
    assert_eq!(rows[0].hit, None);
}

#[test]
fn a_saved_index_is_read_again() {
    let data = data_with_host();
    let q = query(SessionScope::All, Some("ssh-a"));
    assert_eq!(
        host_sessions(data.path(), "ssh-a", &q, None).unwrap().len(),
        3
    );
    let dir = crate::hosts::host_dir(data.path(), "ssh-a");
    let mut index = SessionIndex::load(&dir);
    index.sessions.remove("ssh-a-claude:h3");
    index.save(&dir).unwrap();
    // Make sure the file time moved even on a coarse clock.
    let file = dir.join("kit").join("sessions.json");
    let later = std::time::SystemTime::now() + Duration::from_secs(5);
    std::fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(later)
        .unwrap();
    assert_eq!(
        host_sessions(data.path(), "ssh-a", &q, None).unwrap().len(),
        2
    );
}
