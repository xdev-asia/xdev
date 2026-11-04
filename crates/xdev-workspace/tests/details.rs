mod common;

use std::fs;
use std::path::{Path, PathBuf};

use common::{commit_all, git, long_temp_dir, registered, repo_named};
use xdev_workspace::{
    CreateOptions, DetailsPatch, MadeBy, Registry, ScriptSource, SetupPolicy, WorkItem,
    WorkItemKind, WorkStatus, WorkspaceError, add_repo, create_worktree, create_worktree_with,
    list, path_key, remove_worktree, set_details,
};

fn meta<'a>(reg: &'a Registry, path: &str) -> &'a xdev_workspace::WorktreeMeta {
    let key = path_key(Path::new(path));
    reg.worktrees
        .iter()
        .find(|m| path_key(&m.path) == key)
        .unwrap()
}

fn pr(url: &str) -> WorkItem {
    WorkItem {
        kind: WorkItemKind::Pr,
        url: url.to_owned(),
        title: None,
    }
}

fn parent(path: &str) -> DetailsPatch {
    DetailsPatch {
        parent: Some(Some(PathBuf::from(path))),
        ..DetailsPatch::default()
    }
}

#[test]
fn details_roundtrip_through_save_and_load() {
    let (mut reg, id, repo) = registered();
    let p = create_worktree(&mut reg, &id, "p", None, 1, 1).unwrap();
    let c = create_worktree(&mut reg, &id, "c", None, 2, 2).unwrap();
    let patch = DetailsPatch {
        title: Some(Some("🚀 login".to_owned())),
        comment: Some("line one\nline two".to_owned()),
        status: Some(Some(WorkStatus::InReview)),
        item: Some(Some(pr("https://x.test/o/r/pull/42"))),
        parent: Some(Some(PathBuf::from(&p.path))),
    };
    set_details(&mut reg, Path::new(&c.path), patch).unwrap();

    let data = repo.tmp.path().join("data");
    reg.save(&data).unwrap();
    let text = fs::read_to_string(data.join("workspace.json")).unwrap();
    assert!(text.contains("\"in-review\""), "{text}");
    assert!(text.contains("\"pr\""), "{text}");
    let mut back = Registry::load(&data).unwrap();
    assert_eq!(back.worktrees, reg.worktrees);

    let m = meta(&back, &c.path);
    assert_eq!(m.title.as_deref(), Some("🚀 login"));
    assert_eq!(m.comment, "line one\nline two");
    assert_eq!(m.status, Some(WorkStatus::InReview));
    assert_eq!(m.made_by, MadeBy::App);

    let view = list(&mut back).unwrap().remove(0);
    let row = view.worktrees.iter().find(|w| w.path == c.path).unwrap();
    assert_eq!(row.title.as_deref(), Some("🚀 login"));
    assert_eq!(row.status, Some(WorkStatus::InReview));
    assert_eq!(row.parent.as_deref(), Some(p.path.as_str()));
    assert_eq!(row.item, Some(pr("https://x.test/o/r/pull/42")));

    // Outer `None` leaves a field; inner `None` clears it.
    set_details(
        &mut back,
        Path::new(&c.path),
        DetailsPatch {
            title: Some(None),
            ..DetailsPatch::default()
        },
    )
    .unwrap();
    let m = meta(&back, &c.path);
    assert_eq!(m.title, None);
    assert_eq!(m.status, Some(WorkStatus::InReview));
}

#[test]
fn plan8_registry_loads_and_keeps_vaults() {
    let (_, _, repo) = registered();
    let data = repo.tmp.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let main = repo.path().to_string_lossy().replace('\\', "/");
    let json = format!(
        r#"{{
  "version": 1,
  "repos": [{{
    "id": "abc123abc123", "short_name": "main", "path": "{main}",
    "base_ref": "main", "worktree_root": "{main}/../wt",
    "setup_policy": "run", "script_source": "local",
    "local_setup": "npm i", "local_archive": ""
  }}],
  "worktrees": [{{
    "repo_id": "abc123abc123", "path": "{main}/../wt/main-x",
    "start": "0000000000000000000000000000000000000000",
    "pinned": true, "created_ms": 5, "made_here": true
  }}],
  "vaults": [{{ "id": "def456def456", "path": "{main}/docs" }}]
}}"#
    );
    fs::write(data.join("workspace.json"), json).unwrap();

    let reg = Registry::load(&data).unwrap();
    assert_eq!(reg.version, 1);
    assert_eq!(reg.vaults.len(), 1);
    assert_eq!(reg.repos[0].setup_policy, SetupPolicy::Run);
    assert_eq!(reg.repos[0].script_source, ScriptSource::Local);
    let m = &reg.worktrees[0];
    assert_eq!(m.comment, "");
    assert_eq!(m.title, None);
    assert_eq!(m.status, None);
    assert_eq!(m.parent, None);
    assert_eq!(m.item, None);
    assert_eq!(m.made_by, MadeBy::App);
    assert!(m.pinned);

    reg.save(&data).unwrap();
    let again = Registry::load(&data).unwrap();
    assert_eq!(again, reg);
    let text = fs::read_to_string(data.join("workspace.json")).unwrap();
    assert!(text.contains("def456def456"), "{text}");
    assert!(text.contains("\"version\": 1"), "{text}");
}

#[test]
fn details_refuse_long_text_and_bad_urls() {
    let (mut reg, id, _repo) = registered();
    let wt = create_worktree(&mut reg, &id, "w", None, 1, 1).unwrap();
    let path = Path::new(&wt.path);
    let code =
        |reg: &mut Registry, patch: DetailsPatch| set_details(reg, path, patch).unwrap_err().code();

    let long_comment = DetailsPatch {
        comment: Some("é".repeat(2001)),
        ..DetailsPatch::default()
    };
    assert_eq!(code(&mut reg, long_comment), "bad_details");
    let long_title = DetailsPatch {
        title: Some(Some("x".repeat(121))),
        ..DetailsPatch::default()
    };
    assert_eq!(code(&mut reg, long_title), "bad_details");
    // Counted in chars, not bytes.
    let ok = DetailsPatch {
        title: Some(Some("é".repeat(120))),
        comment: Some("é".repeat(2000)),
        ..DetailsPatch::default()
    };
    set_details(&mut reg, path, ok).unwrap();

    for url in [
        "javascript:x".to_owned(),
        "ftp://x".to_owned(),
        format!("https://x.test/{}", "a".repeat(2049 - 15)),
    ] {
        let patch = DetailsPatch {
            item: Some(Some(pr(&url))),
            ..DetailsPatch::default()
        };
        assert_eq!(code(&mut reg, patch), "bad_item", "{url}");
    }
    let ok = DetailsPatch {
        item: Some(Some(pr(&format!(
            "http://x.test/{}",
            "a".repeat(2048 - 14)
        )))),
        ..DetailsPatch::default()
    };
    set_details(&mut reg, path, ok).unwrap();
}

#[test]
fn parent_must_be_same_repo_and_one_level() {
    let (mut reg, id, repo) = registered();
    let a = create_worktree(&mut reg, &id, "a", None, 1, 1).unwrap();
    let b = create_worktree(&mut reg, &id, "b", None, 2, 2).unwrap();
    let c = create_worktree(&mut reg, &id, "c", None, 3, 3).unwrap();

    let other = repo_named(long_temp_dir("ws other "), "other");
    let other_id = add_repo(&mut reg, other.path(), 0).unwrap().id;
    let o = create_worktree(&mut reg, &other_id, "o", None, 4, 4).unwrap();

    let primary = repo.path().to_string_lossy().into_owned();
    let refuse = |reg: &mut Registry, child: &str, to: &str| {
        let err = set_details(reg, Path::new(child), parent(to)).unwrap_err();
        assert!(matches!(err, WorkspaceError::BadParent(_)), "{err:?}");
        assert_eq!(err.code(), "bad_parent");
    };
    refuse(&mut reg, &a.path, &a.path);
    refuse(&mut reg, &a.path, &primary);
    refuse(&mut reg, &a.path, &o.path);
    refuse(&mut reg, &a.path, "/no/such/worktree");

    // A sibling top-level worktree is fine.
    set_details(&mut reg, Path::new(&b.path), parent(&a.path)).unwrap();
    // b is a child now, so it cannot be a parent.
    refuse(&mut reg, &c.path, &b.path);
    // a has a child, so it cannot get a parent itself.
    refuse(&mut reg, &a.path, &c.path);
    // Clearing works.
    set_details(
        &mut reg,
        Path::new(&b.path),
        DetailsPatch {
            parent: Some(None),
            ..DetailsPatch::default()
        },
    )
    .unwrap();
    assert_eq!(meta(&reg, &b.path).parent, None);
}

#[test]
fn removing_parent_clears_children() {
    let (mut reg, id, _repo) = registered();
    let p = create_worktree(&mut reg, &id, "p", None, 1, 1).unwrap();
    let c = create_worktree(&mut reg, &id, "c", None, 2, 2).unwrap();
    set_details(&mut reg, Path::new(&c.path), parent(&p.path)).unwrap();
    assert!(meta(&reg, &c.path).parent.is_some());

    remove_worktree(&mut reg, Path::new(&p.path), false).unwrap();
    assert_eq!(meta(&reg, &c.path).parent, None);
}

#[test]
fn view_marks_default_branch() {
    let (mut reg, id, repo) = registered();
    let wt = create_worktree(&mut reg, &id, "feat/x", None, 1, 1).unwrap();
    let view = list(&mut reg).unwrap().remove(0);
    let primary = view.worktrees.iter().find(|w| w.primary).unwrap();
    assert_eq!(primary.branch.as_deref(), Some("main"));
    assert!(primary.default_branch);
    let row = view.worktrees.iter().find(|w| w.path == wt.path).unwrap();
    assert!(!row.default_branch);

    // A worktree checked out on the base branch counts too.
    git(repo.path(), &["checkout", "-q", "-b", "side"]);
    commit_all(repo.path(), "two");
    let base = list(&mut reg).unwrap().remove(0).base_ref;
    assert_eq!(base, "main");
    let view = list(&mut reg).unwrap().remove(0);
    let primary = view.worktrees.iter().find(|w| w.primary).unwrap();
    assert!(!primary.default_branch);
}

#[test]
fn create_records_made_by() {
    let (mut reg, id, _repo) = registered();
    let opts = CreateOptions {
        made_by: MadeBy::App,
        ..CreateOptions::default()
    };
    let wt = create_worktree_with(&mut reg, &id, "w", None, 1, 1, &opts).unwrap();
    assert_eq!(meta(&reg, &wt.path).made_by, MadeBy::App);
    assert_eq!(wt.made_by, MadeBy::App);

    let opts = CreateOptions {
        made_by: MadeBy::Cli,
        ..CreateOptions::default()
    };
    let wt = create_worktree_with(&mut reg, &id, "v", None, 2, 2, &opts).unwrap();
    assert_eq!(meta(&reg, &wt.path).made_by, MadeBy::Cli);
    let json = serde_json::to_string(&reg.worktrees).unwrap();
    assert!(json.contains("\"cli\""), "{json}");
}
