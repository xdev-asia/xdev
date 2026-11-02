use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_git::Repo;

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

/// `docs/a.md` plus code in `src/`, `src/sub/` and `lib/`; returns the repo
/// and the id of the first commit.
fn fixture() -> (TempDir, String) {
    let dir = repo_dir();
    write(dir.path(), "docs/a.md", "# A\n");
    write(dir.path(), "src/x.rs", "x");
    write(dir.path(), "src/sub/y.rs", "y");
    write(dir.path(), "lib/z.rs", "z");
    let first = commit_all(dir.path(), "A");
    (dir, first)
}

fn covers(entries: &[&str]) -> Vec<String> {
    entries.iter().map(|e| (*e).to_owned()).collect()
}

/// Run from the vault folder, so `:(top)` is what makes entries repo-relative.
fn vault_repo(dir: &Path) -> Repo {
    Repo::discover(&dir.join("docs")).unwrap()
}

fn subjects(commits: &[xdev_git::Commit]) -> Vec<&str> {
    commits.iter().map(|c| c.message.as_str()).collect()
}

#[test]
fn commits_since_filters_by_covers() {
    let (dir, a) = fixture();
    write(dir.path(), "src/x.rs", "x2");
    commit_all(dir.path(), "B");
    write(dir.path(), "lib/z.rs", "z2");
    commit_all(dir.path(), "C");
    let repo = vault_repo(dir.path());
    let (commits, total) = repo.commits_since(&a, &covers(&["src/**"]), 20).unwrap();
    assert_eq!(subjects(&commits), ["B"]);
    assert_eq!(total, 1);
    assert_eq!(commits[0].author, "Test User");
    assert_eq!(commits[0].id.len(), 40);
}

#[test]
fn folder_entry_matches_files_under_it() {
    let (dir, a) = fixture();
    write(dir.path(), "src/sub/y.rs", "y2");
    commit_all(dir.path(), "B");
    let repo = vault_repo(dir.path());
    for entry in [
        "src",
        "src/",
        "src/sub",
        "src/**",
        "src/sub/y.rs",
        "**/y.rs",
    ] {
        let (_, total) = repo.commits_since(&a, &covers(&[entry]), 20).unwrap();
        assert_eq!(total, 1, "{entry}");
    }
    for entry in ["src/*.rs", "src/x.rs", "sub", "y.rs", "*.rs", "lib", "sr"] {
        let (_, total) = repo.commits_since(&a, &covers(&[entry]), 20).unwrap();
        assert_eq!(total, 0, "{entry}");
    }
}

#[test]
fn single_star_stays_in_folder() {
    let (dir, a) = fixture();
    write(dir.path(), "src/x.rs", "x2");
    commit_all(dir.path(), "B");
    let repo = vault_repo(dir.path());
    let (_, total) = repo.commits_since(&a, &covers(&["src/*.rs"]), 20).unwrap();
    assert_eq!(total, 1);
    let (_, total) = repo.commits_since(&a, &covers(&["*/x.rs"]), 20).unwrap();
    assert_eq!(total, 1);
}

#[test]
fn entries_are_not_pathspec_magic_or_options() {
    let (dir, a) = fixture();
    write(dir.path(), "src/x.rs", "x2");
    commit_all(dir.path(), "B");
    let repo = vault_repo(dir.path());
    // Would match everything if read as an exclude or as an option.
    for entry in [":!lib", ":(exclude)lib", "--all", "-p"] {
        let (_, total) = repo.commits_since(&a, &covers(&[entry]), 20).unwrap();
        assert_eq!(total, 0, "{entry}");
    }
}

#[test]
fn any_entry_counts_once_per_commit() {
    let (dir, a) = fixture();
    write(dir.path(), "src/x.rs", "x2");
    write(dir.path(), "lib/z.rs", "z2");
    commit_all(dir.path(), "B");
    let repo = vault_repo(dir.path());
    let (commits, total) = repo
        .commits_since(&a, &covers(&["src/x.rs", "lib", "nothing/here"]), 20)
        .unwrap();
    assert_eq!(subjects(&commits), ["B"]);
    assert_eq!(total, 1);
}

#[test]
fn no_covers_means_no_commits() {
    let (dir, a) = fixture();
    write(dir.path(), "src/x.rs", "x2");
    commit_all(dir.path(), "B");
    let repo = vault_repo(dir.path());
    assert_eq!(repo.commits_since(&a, &[], 20).unwrap(), (Vec::new(), 0));
}

#[test]
fn limit_keeps_newest_and_total() {
    let (dir, a) = fixture();
    for (i, name) in ["B", "C", "D"].into_iter().enumerate() {
        write(dir.path(), "src/x.rs", &format!("x{i}"));
        commit_all(dir.path(), name);
    }
    let repo = vault_repo(dir.path());
    let (commits, total) = repo.commits_since(&a, &covers(&["src"]), 2).unwrap();
    assert_eq!(subjects(&commits), ["D", "C"]);
    assert_eq!(total, 3);
}

#[test]
fn commits_since_head_is_empty() {
    let (dir, _) = fixture();
    write(dir.path(), "src/x.rs", "x2");
    let head = commit_all(dir.path(), "B");
    let repo = vault_repo(dir.path());
    assert_eq!(
        repo.commits_since(&head, &covers(&["src"]), 20).unwrap(),
        (Vec::new(), 0)
    );
}

#[test]
fn commits_since_rejects_non_ids() {
    let (dir, _) = fixture();
    let repo = vault_repo(dir.path());
    for since in ["HEAD", "--all", "main", ""] {
        assert!(
            repo.commits_since(since, &covers(&["src"]), 20).is_err(),
            "{since}"
        );
    }
}

#[test]
fn resolve_commit_rejects_non_hex_and_unknown() {
    let (dir, a) = fixture();
    let repo = vault_repo(dir.path());
    let branch = git(dir.path(), &["branch", "--show-current"]);
    assert_eq!(repo.resolve_commit(branch.trim()).unwrap(), None);
    assert_eq!(repo.resolve_commit("main").unwrap(), None);
    assert_eq!(repo.resolve_commit("HEAD").unwrap(), None);
    assert_eq!(repo.resolve_commit("abc").unwrap(), None);
    assert_eq!(repo.resolve_commit(&"0".repeat(40)).unwrap(), None);
    assert_eq!(repo.resolve_commit(&"0".repeat(41)).unwrap(), None);
    assert_eq!(repo.resolve_commit(&a[..7]).unwrap(), Some(a.clone()));
    assert_eq!(
        repo.resolve_commit(&a.to_uppercase()).unwrap(),
        Some(a.clone())
    );
    // A tree id is an object but not a commit.
    let tree = git(dir.path(), &["rev-parse", "HEAD^{tree}"]);
    assert_eq!(repo.resolve_commit(tree.trim()).unwrap(), None);
}

#[test]
fn head_id_before_and_after_first_commit() {
    let dir = repo_dir();
    let repo = Repo::discover(dir.path()).unwrap();
    assert_eq!(repo.head_id().unwrap(), None);
    write(dir.path(), "a.md", "a");
    let head = commit_all(dir.path(), "A");
    assert_eq!(repo.head_id().unwrap(), Some(head));
}
