use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_core::{
    AiWrite, AiWrites, Change, ChangeKind, CoreError, Origin, Repo, Seen, Store, Vault, Written,
    ai_writes, approve, content_hash, forget_ai_writes, list_changes, propose_update, reject,
    search,
};

/// Runs setup commands; never used for the code under test.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8(out.stdout).unwrap()
}

fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

/// A repo with its own identity and no autocrlf; the vault is its `docs`
/// folder, so a path that escapes the vault still lands inside the temp dir.
/// `docs/a.md` and `docs/b.md` are committed.
fn setup() -> (TempDir, Vault, Repo, Store) {
    let dir = TempDir::new().unwrap();
    git(dir.path(), &["init", "-q"]);
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(dir.path(), &["config", key, value]);
    }
    write(dir.path(), "docs/a.md", "a");
    write(dir.path(), "docs/b.md", "b");
    git(dir.path(), &["add", "-A"]);
    git(dir.path(), &["commit", "-q", "-m", "init"]);
    let vault = Vault::open(dir.path().join("docs")).unwrap();
    let repo = Repo::discover(vault.root()).unwrap();
    (dir, vault, repo, Store::open_in_memory().unwrap())
}

fn docs(dir: &TempDir) -> std::path::PathBuf {
    dir.path().join("docs")
}

/// Without hashes, so a case reads as a table.
fn changes(vault: &Vault, repo: &Repo, store: &Store, written: &Written) -> Vec<Change> {
    list_changes(vault, repo, written, &ai_writes(store).unwrap())
        .unwrap()
        .into_iter()
        .map(|c| Change { hash: None, ..c })
        .collect()
}

fn change(path: &str, kind: ChangeKind, origin: Origin, note: Option<&str>) -> Change {
    Change {
        path: path.to_owned(),
        kind,
        origin,
        note: note.map(str::to_owned),
        hash: None,
    }
}

fn rows(store: &Store) -> Vec<(String, String)> {
    store
        .ai_writes()
        .unwrap()
        .into_iter()
        .map(|w| (w.path, w.hash))
        .collect()
}

fn row(path: &str, content: &str) -> (String, String) {
    (path.to_owned(), content_hash(content.as_bytes()))
}

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|p| (*p).to_owned()).collect()
}

/// What the review list shows right now, before the call under test.
fn seen(dir: &TempDir, list: &[&str]) -> Vec<Seen> {
    list.iter()
        .map(|p| Seen {
            path: (*p).to_owned(),
            hash: fs::read(docs(dir).join(p)).ok().map(|b| content_hash(&b)),
        })
        .collect()
}

#[test]
fn propose_writes_and_lists_as_ai() {
    let (dir, vault, repo, mut store) = setup();
    propose_update(
        &vault,
        &repo,
        &mut store,
        "a.md",
        "a2",
        Some("Fix the intro"),
    )
    .unwrap();
    assert_eq!(fs::read_to_string(docs(&dir).join("a.md")).unwrap(), "a2");
    assert_eq!(
        changes(&vault, &repo, &store, &Written::new()),
        [change(
            "a.md",
            ChangeKind::Modified,
            Origin::Ai,
            Some("Fix the intro")
        )]
    );
    let recorded = store.ai_writes().unwrap();
    assert_eq!(recorded.len(), 1);
    assert!(recorded[0].time_ms > 0);

    // Nothing reaches history until a person approves.
    assert_eq!(
        git(dir.path(), &["rev-list", "--count", "HEAD"]).trim(),
        "1"
    );
    assert_eq!(git(dir.path(), &["diff", "--cached", "--name-only"]), "");
}

#[test]
fn propose_new_doc() {
    let (dir, vault, repo, mut store) = setup();
    propose_update(&vault, &repo, &mut store, "./n.md", "# New", None).unwrap();
    assert_eq!(
        fs::read_to_string(docs(&dir).join("n.md")).unwrap(),
        "# New"
    );
    // Stored under the same key the review list uses.
    assert_eq!(rows(&store), [row("n.md", "# New")]);
    assert_eq!(
        changes(&vault, &repo, &store, &Written::new()),
        [change("n.md", ChangeKind::Added, Origin::Ai, None)]
    );
}

#[test]
fn propose_twice_replaces_own_proposal() {
    let (dir, vault, repo, mut store) = setup();
    propose_update(&vault, &repo, &mut store, "a.md", "a2", Some("one")).unwrap();
    propose_update(&vault, &repo, &mut store, "a.md", "a3", Some("two")).unwrap();
    assert_eq!(fs::read_to_string(docs(&dir).join("a.md")).unwrap(), "a3");
    assert_eq!(rows(&store), [row("a.md", "a3")]);
    assert_eq!(
        changes(&vault, &repo, &store, &Written::new()),
        [change(
            "a.md",
            ChangeKind::Modified,
            Origin::Ai,
            Some("two")
        )]
    );
}

#[test]
fn propose_refuses_pending_human_edit() {
    let (dir, vault, repo, mut store) = setup();
    let conflict = |store: &mut Store, path: &str| {
        let err = propose_update(&vault, &repo, store, path, "agent", None).unwrap_err();
        assert!(matches!(err, CoreError::Conflict), "{err:?}");
        assert_eq!(err.code(), "conflict");
    };

    write(&docs(&dir), "a.md", "person");
    conflict(&mut store, "a.md");
    assert_eq!(
        fs::read_to_string(docs(&dir).join("a.md")).unwrap(),
        "person"
    );

    // A new doc nobody committed yet, and a pending deletion.
    write(&docs(&dir), "n.md", "draft");
    conflict(&mut store, "n.md");
    assert_eq!(
        fs::read_to_string(docs(&dir).join("n.md")).unwrap(),
        "draft"
    );
    fs::remove_file(docs(&dir).join("b.md")).unwrap();
    conflict(&mut store, "b.md");
    assert!(!docs(&dir).join("b.md").exists());
    assert!(rows(&store).is_empty());

    // A person edits the agent's proposal: it is no longer the agent's own.
    propose_update(&vault, &repo, &mut store, "c.md", "c1", None).unwrap();
    write(&docs(&dir), "c.md", "c1 and mine");
    conflict(&mut store, "c.md");
    assert_eq!(
        fs::read_to_string(docs(&dir).join("c.md")).unwrap(),
        "c1 and mine"
    );
    assert_eq!(rows(&store), [row("c.md", "c1")]);
}

#[test]
fn propose_refuses_edit_hidden_from_git_status() {
    let (dir, vault, repo, mut store) = setup();
    git(
        dir.path(),
        &["update-index", "--skip-worktree", "docs/a.md"],
    );
    git(
        dir.path(),
        &["update-index", "--assume-unchanged", "docs/b.md"],
    );
    write(&docs(&dir), "a.md", "person");
    write(&docs(&dir), "b.md", "person");
    for path in ["a.md", "b.md"] {
        let err = propose_update(&vault, &repo, &mut store, path, "agent", None).unwrap_err();
        assert_eq!(err.code(), "conflict", "{path}");
        assert_eq!(fs::read_to_string(docs(&dir).join(path)).unwrap(), "person");
    }
    assert!(rows(&store).is_empty());
}

/// Windows and macOS folders ignore case, so `A.md` is the person's `a.md`.
#[cfg(any(windows, target_os = "macos"))]
#[test]
fn propose_refuses_pending_edit_under_other_case() {
    let (dir, vault, repo, mut store) = setup();
    write(&docs(&dir), "a.md", "person");
    let err = propose_update(&vault, &repo, &mut store, "A.md", "agent", None).unwrap_err();
    assert_eq!(err.code(), "conflict");
    assert_eq!(
        fs::read_to_string(docs(&dir).join("a.md")).unwrap(),
        "person"
    );

    fs::remove_file(docs(&dir).join("b.md")).unwrap();
    let err = propose_update(&vault, &repo, &mut store, "B.md", "agent", None).unwrap_err();
    assert_eq!(err.code(), "conflict");
    assert!(rows(&store).is_empty());
}

/// Needs a repo to review with; finding one is the caller's step.
#[test]
fn propose_refuses_without_repo() {
    let dir = TempDir::new().unwrap();
    let err = CoreError::from(Repo::discover(dir.path()).unwrap_err());
    assert_eq!(err.code(), "no_repo");
}

#[test]
fn propose_rejects_bad_paths() {
    let (dir, vault, repo, mut store) = setup();
    write(dir.path(), "outside.md", "o");
    let absolute = dir.path().join("x.md").to_string_lossy().into_owned();
    for path in [
        "../x.md",
        "../outside.md",
        absolute.as_str(),
        "/x.md",
        ".git/config",
        ".git/x.md",
        "node_modules/x.md",
        "a.txt",
        "sub",
        "",
    ] {
        let err = propose_update(&vault, &repo, &mut store, path, "agent", None).unwrap_err();
        assert!(
            ["outside_vault", "not_found"].contains(&err.code()),
            "{path}: {err:?}"
        );
    }
    assert!(!dir.path().join("x.md").exists());
    assert_eq!(
        fs::read_to_string(dir.path().join("outside.md")).unwrap(),
        "o"
    );
    assert!(!docs(&dir).join("a.txt").exists());
    assert!(!docs(&dir).join(".git").exists());
    assert!(!docs(&dir).join("node_modules").exists());
    assert!(rows(&store).is_empty());
    assert!(changes(&vault, &repo, &store, &Written::new()).is_empty());
}

#[test]
fn propose_respects_size_limit() {
    let (dir, vault, repo, mut store) = setup();
    let big = "x".repeat(5 * 1024 * 1024 + 1);
    let err = propose_update(&vault, &repo, &mut store, "a.md", &big, None).unwrap_err();
    assert_eq!(err.code(), "too_large");
    assert_eq!(fs::read_to_string(docs(&dir).join("a.md")).unwrap(), "a");
    assert!(rows(&store).is_empty());
}

#[test]
fn app_write_wins_over_ai_when_both_match() {
    let (_dir, vault, repo, mut store) = setup();
    propose_update(&vault, &repo, &mut store, "a.md", "same", Some("agent")).unwrap();
    let mut written = Written::new();
    written.insert("a.md".into(), content_hash(b"same"));
    assert_eq!(
        changes(&vault, &repo, &store, &written),
        [change("a.md", ChangeKind::Modified, Origin::App, None)]
    );
}

#[test]
fn outside_edit_after_proposal_is_outside() {
    let (dir, vault, repo, mut store) = setup();
    propose_update(&vault, &repo, &mut store, "a.md", "a2", Some("agent")).unwrap();
    write(&docs(&dir), "a.md", "a2 edited");
    assert_eq!(
        changes(&vault, &repo, &store, &Written::new()),
        [change("a.md", ChangeKind::Modified, Origin::Outside, None)]
    );
}

#[test]
fn approve_then_forget_clears_rows() {
    let (dir, vault, repo, mut store) = setup();
    propose_update(&vault, &repo, &mut store, "a.md", "a2", None).unwrap();
    propose_update(&vault, &repo, &mut store, "b.md", "b2", None).unwrap();
    let written = Written::new();
    let snapshot: AiWrites = ai_writes(&store).unwrap();
    assert_eq!(
        snapshot.get("a.md"),
        Some(&AiWrite {
            path: "a.md".into(),
            hash: content_hash(b"a2"),
            note: None,
            time_ms: snapshot["a.md"].time_ms,
        })
    );

    let selected = paths(&["a.md"]);
    approve(
        &vault,
        &repo,
        &written,
        &snapshot,
        &seen(&dir, &["a.md"]),
        "",
    )
    .unwrap()
    .expect("a commit");
    assert_eq!(
        git(dir.path(), &["log", "-1", "--format=%s"]).trim(),
        "Update a.md"
    );
    // The agent proposes again before the app drops the old rows.
    propose_update(&vault, &repo, &mut store, "a.md", "a3", None).unwrap();
    forget_ai_writes(&mut store, &snapshot, &selected).unwrap();
    assert_eq!(rows(&store), [row("a.md", "a3"), row("b.md", "b2")]);

    let selected = paths(&["a.md", "b.md"]);
    let snapshot = ai_writes(&store).unwrap();
    reject(
        &vault,
        &repo,
        &written,
        &snapshot,
        &seen(&dir, &["a.md", "b.md"]),
    )
    .unwrap();
    forget_ai_writes(&mut store, &snapshot, &selected).unwrap();
    assert!(rows(&store).is_empty());
    assert_eq!(fs::read_to_string(docs(&dir).join("a.md")).unwrap(), "a2");
    assert_eq!(fs::read_to_string(docs(&dir).join("b.md")).unwrap(), "b");
    assert!(changes(&vault, &repo, &store, &written).is_empty());
}

#[test]
fn reindexes_after_propose() {
    let (_dir, vault, repo, mut store) = setup();
    propose_update(
        &vault,
        &repo,
        &mut store,
        "n.md",
        "# Rollout\n\nzebracorn",
        None,
    )
    .unwrap();
    let hits: Vec<String> = search(&store, "zebracorn", 10)
        .unwrap()
        .into_iter()
        .map(|h| h.path)
        .collect();
    assert_eq!(hits, ["n.md"]);
}
