use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_core::{
    Change, ChangeKind, CoreError, GitError, Origin, Repo, Vault, Written, approve,
    default_message, history, list_changes, read_base, read_version, reject,
};
use xdev_vault::content_hash;

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

/// A repo with its own identity and no autocrlf, `a.md` and `b.md` committed.
fn setup() -> (TempDir, Vault, Repo) {
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
    write(dir.path(), "a.md", "a");
    write(dir.path(), "b.md", "b");
    git(dir.path(), &["add", "-A"]);
    git(dir.path(), &["commit", "-q", "-m", "init"]);
    let vault = Vault::open(dir.path()).unwrap();
    let repo = Repo::discover(vault.root()).unwrap();
    (dir, vault, repo)
}

fn change(path: &str, kind: ChangeKind, origin: Origin) -> Change {
    Change {
        path: path.to_owned(),
        kind,
        origin,
    }
}

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|p| (*p).to_owned()).collect()
}

fn subject(dir: &Path) -> String {
    git(dir, &["log", "-1", "--format=%s"]).trim().to_owned()
}

#[test]
fn list_changes_labels_origin() {
    let (dir, vault, repo) = setup();
    let mut written = Written::new();
    vault.write("a.md", "mine").unwrap();
    written.insert("a.md".into(), content_hash(b"mine"));
    write(dir.path(), "b.md", "theirs");
    assert_eq!(
        list_changes(&vault, &repo, &written).unwrap(),
        [
            change("a.md", ChangeKind::Modified, Origin::App),
            change("b.md", ChangeKind::Modified, Origin::Outside),
        ]
    );

    write(dir.path(), "a.md", "edited again");
    assert_eq!(
        list_changes(&vault, &repo, &written).unwrap()[0],
        change("a.md", ChangeKind::Modified, Origin::Outside)
    );

    // A deleted file has nothing to compare, even if xDev wrote it last.
    fs::remove_file(dir.path().join("a.md")).unwrap();
    assert_eq!(
        list_changes(&vault, &repo, &written).unwrap()[0],
        change("a.md", ChangeKind::Deleted, Origin::Outside)
    );
}

#[test]
fn list_changes_only_docs() {
    let (dir, vault, repo) = setup();
    write(dir.path(), "notes.txt", "x");
    write(dir.path(), "node_modules/x.md", "x");
    write(dir.path(), "n.md", "n");
    assert_eq!(
        list_changes(&vault, &repo, &Written::new()).unwrap(),
        [change("n.md", ChangeKind::Added, Origin::Outside)]
    );
}

#[test]
fn approve_ignores_paths_not_pending() {
    let (dir, vault, repo) = setup();
    write(dir.path(), "a.md", "a2");
    write(dir.path(), "notes.txt", "x");
    let written = Written::new();

    let id = approve(
        &vault,
        &repo,
        &written,
        &paths(&["a.md", "zzz.md", "../etc.md", "notes.txt", "b.md"]),
        "",
    )
    .unwrap()
    .unwrap();
    assert_eq!(id, git(dir.path(), &["rev-parse", "HEAD"]).trim());
    assert_eq!(
        git(dir.path(), &["show", "--name-only", "--format=", "HEAD"]),
        "a.md\n"
    );
    assert!(matches!(
        approve(&vault, &repo, &written, &paths(&["zzz.md"]), ""),
        Ok(None)
    ));
    assert!(matches!(
        approve(&vault, &repo, &written, &[], "m"),
        Ok(None)
    ));
}

#[test]
fn approve_uses_default_message() {
    let (dir, vault, repo) = setup();
    write(dir.path(), "a.md", "a2");
    approve(&vault, &repo, &Written::new(), &paths(&["a.md"]), "")
        .unwrap()
        .unwrap();
    assert_eq!(subject(dir.path()), "Update a.md");

    write(dir.path(), "a.md", "a3");
    approve(&vault, &repo, &Written::new(), &paths(&["a.md"]), " \n\t")
        .unwrap()
        .unwrap();
    assert_eq!(subject(dir.path()), "Update a.md");

    write(dir.path(), "a.md", "a4");
    approve(
        &vault,
        &repo,
        &Written::new(),
        &paths(&["a.md"]),
        "Own words",
    )
    .unwrap()
    .unwrap();
    assert_eq!(subject(dir.path()), "Own words");
}

#[test]
fn reject_restores_and_deletes() {
    let (dir, vault, repo) = setup();
    write(dir.path(), "a.md", "a2");
    write(dir.path(), "n.md", "n");
    git(dir.path(), &["add", "n.md"]);
    fs::remove_file(dir.path().join("b.md")).unwrap();
    write(dir.path(), "keep.md", "k");

    reject(
        &vault,
        &repo,
        &Written::new(),
        &paths(&["a.md", "n.md", "b.md", "zzz.md"]),
    )
    .unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(), "a");
    assert_eq!(fs::read_to_string(dir.path().join("b.md")).unwrap(), "b");
    assert!(!dir.path().join("n.md").exists());
    assert_eq!(
        list_changes(&vault, &repo, &Written::new()).unwrap(),
        [change("keep.md", ChangeKind::Added, Origin::Outside)]
    );
    assert_eq!(git(dir.path(), &["diff", "--cached", "--name-only"]), "");
}

#[test]
fn default_message_cases() {
    let one = |kind| default_message(&[change("d/x.md", kind, Origin::App)]);
    assert_eq!(one(ChangeKind::Added), "Add d/x.md");
    assert_eq!(one(ChangeKind::Modified), "Update d/x.md");
    assert_eq!(one(ChangeKind::Deleted), "Delete d/x.md");
    let three = [
        change("a.md", ChangeKind::Added, Origin::App),
        change("b.md", ChangeKind::Modified, Origin::Outside),
        change("c.md", ChangeKind::Deleted, Origin::Outside),
    ];
    assert_eq!(default_message(&three), "Update 3 docs");
}

#[test]
fn read_base_none_for_added() {
    let (dir, _vault, repo) = setup();
    write(dir.path(), "a.md", "a2");
    write(dir.path(), "n.md", "n");
    assert_eq!(read_base(&repo, "a.md").unwrap().as_deref(), Some("a"));
    assert_eq!(read_base(&repo, "n.md").unwrap(), None);
}

#[test]
fn read_version_and_errors() {
    let (dir, _vault, repo) = setup();
    let first = git(dir.path(), &["rev-parse", "HEAD"]).trim().to_owned();
    write(dir.path(), "a.md", "a2");
    git(dir.path(), &["commit", "-q", "-am", "two"]);

    assert_eq!(
        read_version(&repo, "a.md", &first).unwrap().as_deref(),
        Some("a")
    );
    assert_eq!(read_version(&repo, "n.md", &first).unwrap(), None);
    let err = read_version(&repo, "a.md", "--output=x").unwrap_err();
    assert!(matches!(err, CoreError::Git(GitError::BadId(_))));
    assert_eq!(err.code(), "git");

    fs::write(dir.path().join("bin.md"), [0xff, 0xfe]).unwrap();
    git(dir.path(), &["add", "bin.md"]);
    git(dir.path(), &["commit", "-q", "-m", "bin"]);
    assert_eq!(read_base(&repo, "bin.md").unwrap_err().code(), "not_utf8");

    // Reading through git must not reach past the vault folder.
    assert_eq!(
        read_base(&repo, "../x.md").unwrap_err().code(),
        "outside_vault"
    );
}

#[test]
fn history_newest_first_and_stays_in_vault() {
    let (dir, _vault, repo) = setup();
    write(dir.path(), "a.md", "a2");
    git(dir.path(), &["commit", "-q", "-am", "two"]);

    let log = history(&repo, "a.md", 50).unwrap();
    let messages: Vec<&str> = log.iter().map(|c| c.message.as_str()).collect();
    assert_eq!(messages, ["two", "init"]);
    assert_eq!(history(&repo, "a.md", 1).unwrap().len(), 1);
    assert_eq!(
        history(&repo, "../x.md", 50).unwrap_err().code(),
        "outside_vault"
    );
}

#[test]
fn git_error_codes_pass_through() {
    let dir = TempDir::new().unwrap();
    let err = CoreError::from(Repo::discover(dir.path()).unwrap_err());
    assert_eq!(err.code(), "no_repo");
    assert_eq!(CoreError::from(GitError::Identity).code(), "git_identity");
    assert_eq!(CoreError::from(GitError::NoGit).code(), "no_git");
}

/// The desktop UI parses this shape; see `Change` in the spec.
#[test]
fn change_serializes_like_the_ui_contract() {
    let json = serde_json::to_string(&change("a.md", ChangeKind::Added, Origin::App)).unwrap();
    assert_eq!(json, r#"{"path":"a.md","kind":"added","origin":"app"}"#);
}
