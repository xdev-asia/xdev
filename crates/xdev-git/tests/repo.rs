use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_git::{ChangeKind, FileStatus, GitError, Repo};

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

/// A fresh repo with its own identity, so tests never read the developer's
/// global config, and without autocrlf, which would rewrite line endings.
fn repo_dir() -> TempDir {
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
    dir
}

fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn commit_all(dir: &Path, message: &str) -> String {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
    git(dir, &["rev-parse", "HEAD"]).trim().to_owned()
}

fn status(repo: &Repo) -> Vec<(String, ChangeKind)> {
    repo.status()
        .unwrap()
        .into_iter()
        .map(|FileStatus { path, kind }| (path, kind))
        .collect()
}

fn entries(list: &[(&str, ChangeKind)]) -> Vec<(String, ChangeKind)> {
    list.iter().map(|(p, k)| ((*p).to_owned(), *k)).collect()
}

#[test]
fn discover_outside_repo_is_no_repo() {
    let dir = TempDir::new().unwrap();
    assert!(matches!(Repo::discover(dir.path()), Err(GitError::NoRepo)));
}

#[test]
fn init_then_discover() {
    let dir = TempDir::new().unwrap();
    Repo::init(dir.path()).unwrap();
    Repo::discover(dir.path()).unwrap();
}

#[test]
fn status_kinds() {
    let dir = repo_dir();
    write(dir.path(), "a.md", "a");
    write(dir.path(), "b.md", "b");
    commit_all(dir.path(), "init");
    write(dir.path(), "a.md", "a2");
    fs::remove_file(dir.path().join("b.md")).unwrap();
    write(dir.path(), "c.md", "c");
    write(dir.path(), "x/d.md", "d");

    let repo = Repo::discover(dir.path()).unwrap();
    assert_eq!(
        status(&repo),
        entries(&[
            ("a.md", ChangeKind::Modified),
            ("b.md", ChangeKind::Deleted),
            ("c.md", ChangeKind::Added),
            ("x/d.md", ChangeKind::Added),
        ])
    );
}

#[test]
fn status_ignores_gitignored() {
    let dir = repo_dir();
    write(dir.path(), ".gitignore", "ignored.md\n");
    commit_all(dir.path(), "init");
    write(dir.path(), "ignored.md", "x");
    let repo = Repo::discover(dir.path()).unwrap();
    assert_eq!(status(&repo), []);
}

#[test]
fn status_in_subfolder_is_vault_relative() {
    let dir = repo_dir();
    write(dir.path(), "outer.md", "o");
    write(dir.path(), "vault/in.md", "i");
    let repo = Repo::discover(&dir.path().join("vault")).unwrap();
    assert_eq!(status(&repo), entries(&[("in.md", ChangeKind::Added)]));
}

/// `Vault::root()` is canonical, which on Windows is a `\\?\C:\...` path.
#[test]
fn status_from_canonical_path() {
    let dir = repo_dir();
    write(dir.path(), "vault/in.md", "i");
    let root = fs::canonicalize(dir.path().join("vault")).unwrap();
    let repo = Repo::discover(&root).unwrap();
    assert_eq!(status(&repo), entries(&[("in.md", ChangeKind::Added)]));
}

#[test]
fn root_of_subfolder_vault() {
    let dir = repo_dir();
    let top = fs::canonicalize(dir.path()).unwrap();
    write(dir.path(), "docs/sub/a.md", "a");
    for vault in [
        dir.path().join("docs/sub"),
        fs::canonicalize(dir.path().join("docs/sub")).unwrap(),
        dir.path().to_path_buf(),
    ] {
        let root = Repo::discover(&vault).unwrap().root();
        assert_eq!(fs::canonicalize(&root).unwrap(), top, "{vault:?}");
    }
}

#[test]
fn status_staged_then_deleted_is_not_listed() {
    let dir = repo_dir();
    write(dir.path(), "n.md", "n");
    git(dir.path(), &["add", "n.md"]);
    fs::remove_file(dir.path().join("n.md")).unwrap();
    let repo = Repo::discover(dir.path()).unwrap();
    assert_eq!(status(&repo), []);
}

#[test]
fn status_unicode_path() {
    let dir = repo_dir();
    write(dir.path(), "tài liệu.md", "x");
    let repo = Repo::discover(dir.path()).unwrap();
    assert_eq!(
        status(&repo),
        entries(&[("tài liệu.md", ChangeKind::Added)])
    );
}

#[test]
fn status_untracked_after_rm_cached_is_one_modified_entry() {
    let dir = repo_dir();
    write(dir.path(), "a.md", "a");
    commit_all(dir.path(), "init");
    git(dir.path(), &["rm", "--cached", "-q", "a.md"]);
    let repo = Repo::discover(dir.path()).unwrap();
    assert_eq!(status(&repo), entries(&[("a.md", ChangeKind::Modified)]));
}

#[test]
fn codes_are_stable() {
    let cases = [
        (GitError::NoGit, "no_git"),
        (GitError::NoRepo, "no_repo"),
        (GitError::Identity, "git_identity"),
        (GitError::GhMissing, "gh_missing"),
        (GitError::GhAuth, "gh_auth"),
        (GitError::NotGithub, "not_github"),
        (GitError::Gh(String::new()), "gh_failed"),
        (GitError::IssueNotFound, "issue_not_found"),
        (GitError::IssueOtherRepo(String::new()), "issue_other_repo"),
        (GitError::BadId(String::new()), "git"),
        (GitError::Timeout, "git"),
        (
            GitError::Hook {
                output: String::new(),
            },
            "hook_failed",
        ),
        (
            GitError::Failed {
                args: String::new(),
                status: Some(1),
                stderr: String::new(),
            },
            "git",
        ),
        (GitError::Io(std::io::Error::other("x")), "io"),
    ];
    for (err, code) in cases {
        assert_eq!(err.code(), code);
    }
    assert_eq!(GitError::Timeout.to_string(), "timeout");
}

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|p| (*p).to_owned()).collect()
}

/// A repo with `a.md` and `b.md` committed.
fn committed() -> (TempDir, Repo) {
    let dir = repo_dir();
    write(dir.path(), "a.md", "a");
    write(dir.path(), "b.md", "b");
    commit_all(dir.path(), "init");
    let repo = Repo::discover(dir.path()).unwrap();
    (dir, repo)
}

#[test]
fn head_content_and_show() {
    let dir = repo_dir();
    write(dir.path(), "a.md", "v1");
    let id1 = commit_all(dir.path(), "one");
    write(dir.path(), "a.md", "v2");
    commit_all(dir.path(), "two");
    let repo = Repo::discover(dir.path()).unwrap();

    assert_eq!(
        repo.head_content("a.md").unwrap().as_deref(),
        Some(&b"v2"[..])
    );
    assert_eq!(
        repo.show(&id1, "a.md").unwrap().as_deref(),
        Some(&b"v1"[..])
    );
    assert_eq!(
        repo.show(&id1[..8], "a.md").unwrap().as_deref(),
        Some(&b"v1"[..])
    );
    assert_eq!(repo.show(&id1, "missing.md").unwrap(), None);
    assert_eq!(repo.head_content("missing.md").unwrap(), None);
}

#[test]
fn blob_size_without_reading_the_blob() {
    let dir = repo_dir();
    write(dir.path(), "a.md", "12345");
    write(dir.path(), "vault/a.md", "123");
    let id = commit_all(dir.path(), "one");
    let repo = Repo::discover(dir.path()).unwrap();
    assert_eq!(repo.blob_size(&id, "a.md").unwrap(), Some(5));
    assert_eq!(repo.blob_size(&id[..8], "a.md").unwrap(), Some(5));
    assert_eq!(repo.blob_size(&id, "missing.md").unwrap(), None);
    // A folder is not a file.
    assert_eq!(repo.blob_size(&id, "vault").unwrap(), None);
    let vault = Repo::discover(&dir.path().join("vault")).unwrap();
    assert_eq!(vault.blob_size(&id, "a.md").unwrap(), Some(3));
    for bad in ["--output=x", "HEAD", "abc", ""] {
        assert!(
            matches!(repo.blob_size(bad, "a.md"), Err(GitError::BadId(_))),
            "{bad}"
        );
    }
}

#[test]
fn show_in_subfolder_is_vault_relative() {
    let dir = repo_dir();
    write(dir.path(), "a.md", "outer");
    write(dir.path(), "vault/a.md", "inner");
    commit_all(dir.path(), "init");
    let repo = Repo::discover(&dir.path().join("vault")).unwrap();
    assert_eq!(
        repo.head_content("a.md").unwrap().as_deref(),
        Some(&b"inner"[..])
    );
    assert_eq!(repo.log("a.md", 50).unwrap().len(), 1);
}

#[test]
fn show_rejects_bad_id() {
    let (_dir, repo) = committed();
    for id in ["--output=x", "HEAD", "abc", "ABCDEF12", "abcd efgh", ""] {
        assert!(
            matches!(repo.show(id, "a.md"), Err(GitError::BadId(_))),
            "{id}"
        );
    }
    // Well-formed but unknown: git's own failure, not a bad id.
    assert!(matches!(
        repo.show("0123456789abcdef", "a.md"),
        Err(GitError::Failed { .. })
    ));
}

#[test]
fn log_newest_first() {
    let dir = repo_dir();
    write(dir.path(), "a.md", "1");
    commit_all(dir.path(), "one");
    write(dir.path(), "a.md", "2");
    commit_all(dir.path(), "two");
    let repo = Repo::discover(dir.path()).unwrap();

    let log = repo.log("a.md", 50).unwrap();
    let messages: Vec<_> = log.iter().map(|c| c.message.as_str()).collect();
    assert_eq!(messages, ["two", "one"]);
    assert_eq!(log[0].author, "Test User");
    assert!(log[0].time > 0);
    assert_eq!(log[0].id.len(), 40);
    assert_eq!(repo.log("a.md", 1).unwrap().len(), 1);
    assert_eq!(repo.log("other.md", 50).unwrap(), []);
}

#[test]
fn commit_only_given_paths() {
    let (dir, repo) = committed();
    write(dir.path(), "a.md", "a2");
    write(dir.path(), "b.md", "b2");
    let id = repo.commit(&paths(&["a.md"]), "msg").unwrap().unwrap();
    assert_eq!(id, git(dir.path(), &["rev-parse", "HEAD"]).trim());
    assert_eq!(status(&repo), entries(&[("b.md", ChangeKind::Modified)]));
    assert_eq!(repo.log("a.md", 1).unwrap()[0].message, "msg");
}

#[test]
fn commit_leaves_other_staged_files_alone() {
    let dir = repo_dir();
    write(dir.path(), "a.md", "a");
    write(dir.path(), "other.md", "o");
    commit_all(dir.path(), "init");
    write(dir.path(), "a.md", "a2");
    write(dir.path(), "other.md", "o2");
    git(dir.path(), &["add", "other.md"]);
    let repo = Repo::discover(dir.path()).unwrap();

    repo.commit(&paths(&["a.md"]), "m").unwrap().unwrap();
    assert_eq!(
        git(dir.path(), &["diff", "--cached", "--name-only"]),
        "other.md\n"
    );
    assert_eq!(
        git(dir.path(), &["show", "--name-only", "--format=", "HEAD"]),
        "a.md\n"
    );
}

#[test]
fn commit_added_and_deleted() {
    let (dir, repo) = committed();
    write(dir.path(), "n.md", "n");
    fs::remove_file(dir.path().join("b.md")).unwrap();
    repo.commit(&paths(&["n.md", "b.md"]), "m")
        .unwrap()
        .unwrap();
    assert_eq!(status(&repo), []);
    assert_eq!(repo.head_content("b.md").unwrap(), None);
}

/// `git rm` in a terminal leaves the path in neither the index nor the disk.
#[test]
fn commit_deletion_staged_by_git_rm() {
    let (dir, repo) = committed();
    git(dir.path(), &["rm", "-q", "b.md"]);
    repo.commit(&paths(&["b.md"]), "m").unwrap().unwrap();
    assert_eq!(status(&repo), []);
}

#[test]
fn commit_nothing_returns_none() {
    let (_dir, repo) = committed();
    assert!(matches!(repo.commit(&paths(&["a.md"]), "m"), Ok(None)));
    assert!(matches!(repo.commit(&[], "m"), Ok(None)));
    assert!(matches!(repo.commit(&paths(&["zzz.md"]), "m"), Ok(None)));
}

#[test]
fn commit_without_identity() {
    let (dir, repo) = committed();
    // Local config wins over the developer's global identity.
    git(dir.path(), &["config", "user.name", ""]);
    git(dir.path(), &["config", "user.email", ""]);
    write(dir.path(), "a.md", "a2");
    assert!(matches!(
        repo.commit(&paths(&["a.md"]), "m"),
        Err(GitError::Identity)
    ));
}

#[test]
fn commit_message_from_stdin_keeps_unicode() {
    let (dir, repo) = committed();
    write(dir.path(), "a.md", "a2");
    repo.commit(&paths(&["a.md"]), "Cập nhật tài liệu\n\nbody")
        .unwrap()
        .unwrap();
    assert_eq!(repo.log("a.md", 1).unwrap()[0].message, "Cập nhật tài liệu");
}

#[test]
fn restore_and_unstage() {
    let (dir, repo) = committed();
    write(dir.path(), "a.md", "a2");
    fs::remove_file(dir.path().join("b.md")).unwrap();
    repo.restore(&paths(&["a.md", "b.md"])).unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(), "a");
    assert_eq!(fs::read_to_string(dir.path().join("b.md")).unwrap(), "b");
    assert_eq!(status(&repo), []);

    write(dir.path(), "n.md", "n");
    git(dir.path(), &["add", "n.md"]);
    repo.unstage(&paths(&["n.md"])).unwrap();
    assert!(dir.path().join("n.md").exists());
    assert_eq!(status(&repo), entries(&[("n.md", ChangeKind::Added)]));
    assert_eq!(git(dir.path(), &["diff", "--cached", "--name-only"]), "");

    repo.restore(&[]).unwrap();
    repo.unstage(&[]).unwrap();
}

/// `git rm` in a terminal, then reject in xDev.
#[test]
fn restore_deletion_staged_by_git_rm() {
    let (dir, repo) = committed();
    git(dir.path(), &["rm", "-q", "b.md"]);
    repo.restore(&paths(&["b.md"])).unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("b.md")).unwrap(), "b");
    assert_eq!(status(&repo), []);
}

#[test]
fn paths_starting_with_dash_are_literal() {
    let (dir, repo) = committed();
    write(dir.path(), "-x.md", "x");
    repo.commit(&paths(&["-x.md"]), "m").unwrap().unwrap();
    assert_eq!(
        repo.head_content("-x.md").unwrap().as_deref(),
        Some(&b"x"[..])
    );
    assert_eq!(repo.log("-x.md", 50).unwrap().len(), 1);
}

#[test]
fn glob_characters_in_paths_are_literal() {
    let (dir, repo) = committed();
    write(dir.path(), "[a].md", "x");
    write(dir.path(), "a.md", "a2");
    repo.commit(&paths(&["[a].md"]), "m").unwrap().unwrap();
    assert_eq!(status(&repo), entries(&[("a.md", ChangeKind::Modified)]));
}

#[test]
fn empty_repo_flow() {
    let dir = repo_dir();
    write(dir.path(), "a.md", "a");
    let repo = Repo::discover(dir.path()).unwrap();
    assert_eq!(status(&repo), entries(&[("a.md", ChangeKind::Added)]));
    assert_eq!(repo.head_content("a.md").unwrap(), None);
    assert_eq!(repo.log("a.md", 50).unwrap(), []);
    repo.commit(&paths(&["a.md"]), "first").unwrap().unwrap();
    assert_eq!(repo.log("a.md", 50).unwrap().len(), 1);
    assert_eq!(status(&repo), []);
}
