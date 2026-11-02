use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_core::{
    DocState, FRESHNESS_COMMITS, Freshness, Repo, StaleDoc, Vault, freshness, stale_docs,
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

fn commit_all(dir: &Path, message: &str) -> String {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
    git(dir, &["rev-parse", "HEAD"]).trim().to_owned()
}

/// A repo with its own identity and no autocrlf, code in `src/` and `lib/`
/// committed, and the vault in `docs/`. Returns the first commit's id.
fn setup() -> (TempDir, String) {
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
    write(dir.path(), "src/x.rs", "x");
    write(dir.path(), "lib/z.rs", "z");
    write(dir.path(), "docs/plain.md", "# Plain\n");
    let first = commit_all(dir.path(), "code");
    (dir, first)
}

fn open(dir: &Path) -> (Vault, Option<Repo>) {
    let vault = Vault::open(dir.join("docs")).unwrap();
    let repo = Repo::discover(vault.root()).ok();
    (vault, repo)
}

fn doc(covers: &str, verified: Option<&str>, title: &str) -> String {
    let verified = verified.map_or(String::new(), |v| format!("verified: {v}\n"));
    format!("---\ncovers: {covers}\n{verified}---\n# {title}\n")
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn fresh_then_stale_after_covered_commit() {
    let (dir, first) = setup();
    write(
        dir.path(),
        "docs/a.md",
        &doc("[src/**]", Some(&first[..7]), "A"),
    );
    let docs_commit = commit_all(dir.path(), "docs");
    let (vault, repo) = open(dir.path());

    let got = freshness(&vault, repo.as_ref(), "a.md").unwrap();
    assert_eq!(
        got,
        Freshness {
            state: DocState::Fresh,
            covers: strings(&["src/**"]),
            verified: Some(first[..7].to_owned()),
            head: Some(docs_commit),
            commits: Vec::new(),
            count: 0,
        }
    );

    write(dir.path(), "lib/z.rs", "z2");
    commit_all(dir.path(), "not covered");
    assert_eq!(
        freshness(&vault, repo.as_ref(), "a.md").unwrap().state,
        DocState::Fresh
    );

    write(dir.path(), "src/x.rs", "x2");
    let covered = commit_all(dir.path(), "covered");
    let got = freshness(&vault, repo.as_ref(), "a.md").unwrap();
    assert_eq!(got.state, DocState::Stale);
    assert_eq!(got.count, 1);
    assert_eq!(got.head.as_deref(), Some(covered.as_str()));
    assert_eq!(got.commits.len(), 1);
    assert_eq!(got.commits[0].id, covered);
    assert_eq!(got.commits[0].message, "covered");
}

#[test]
fn stale_lists_at_most_the_newest_commits() {
    let (dir, first) = setup();
    write(dir.path(), "docs/a.md", &doc("src", Some(&first), "A"));
    for i in 0..FRESHNESS_COMMITS + 2 {
        write(dir.path(), "src/x.rs", &format!("x{i}"));
        commit_all(dir.path(), &format!("c{i}"));
    }
    let (vault, repo) = open(dir.path());
    let got = freshness(&vault, repo.as_ref(), "a.md").unwrap();
    assert_eq!(got.state, DocState::Stale);
    assert_eq!(got.count, FRESHNESS_COMMITS + 2);
    assert_eq!(got.commits.len(), FRESHNESS_COMMITS);
    assert_eq!(
        got.commits[0].message,
        format!("c{}", FRESHNESS_COMMITS + 1)
    );
}

#[test]
fn freshness_reads_the_saved_file() {
    let (dir, first) = setup();
    write(dir.path(), "docs/a.md", &doc("src", None, "A"));
    commit_all(dir.path(), "docs");
    write(dir.path(), "src/x.rs", "x2");
    let head = commit_all(dir.path(), "covered");
    let (vault, repo) = open(dir.path());
    assert_eq!(
        freshness(&vault, repo.as_ref(), "a.md").unwrap().state,
        DocState::Unverified
    );
    // Verified at HEAD without committing the doc: the saved file counts.
    vault.write("a.md", &doc("src", Some(&head), "A")).unwrap();
    assert_eq!(
        freshness(&vault, repo.as_ref(), "a.md").unwrap().state,
        DocState::Fresh
    );
    vault.write("a.md", &doc("src", Some(&first), "A")).unwrap();
    assert_eq!(
        freshness(&vault, repo.as_ref(), "a.md").unwrap().state,
        DocState::Stale
    );
}

#[test]
fn unverified_without_verified() {
    let (dir, _) = setup();
    write(dir.path(), "docs/a.md", &doc("src", None, "A"));
    write(dir.path(), "docs/b.md", &doc("src", Some("main"), "B"));
    let (vault, repo) = open(dir.path());
    for path in ["a.md", "b.md"] {
        for repo in [repo.as_ref(), None] {
            let got = freshness(&vault, repo, path).unwrap();
            assert_eq!(got.state, DocState::Unverified, "{path}");
            assert_eq!(got.verified, None);
            assert_eq!(got.count, 0);
        }
    }
}

#[test]
fn none_without_covers() {
    let (dir, first) = setup();
    let (vault, repo) = open(dir.path());
    assert_eq!(
        freshness(&vault, repo.as_ref(), "plain.md").unwrap(),
        Freshness {
            state: DocState::None,
            covers: Vec::new(),
            verified: None,
            head: Some(first),
            commits: Vec::new(),
            count: 0,
        }
    );
}

#[test]
fn unknown_outside_git() {
    let dir = TempDir::new().unwrap();
    write(dir.path(), "a.md", &doc("src", Some("abcdef0"), "A"));
    write(dir.path(), "b.md", "# B\n");
    let vault = Vault::open(dir.path()).unwrap();
    assert_eq!(
        freshness(&vault, None, "a.md").unwrap(),
        Freshness {
            state: DocState::Unknown,
            covers: strings(&["src"]),
            verified: Some("abcdef0".to_owned()),
            head: None,
            commits: Vec::new(),
            count: 0,
        }
    );
    assert_eq!(
        freshness(&vault, None, "b.md").unwrap().state,
        DocState::None
    );
}

#[test]
fn missing_verified_commit_is_unknown() {
    let (dir, first) = setup();
    write(
        dir.path(),
        "docs/a.md",
        &doc("src", Some(&"0".repeat(40)), "A"),
    );
    write(dir.path(), "docs/b.md", &doc("src", Some(&first), "B"));
    commit_all(dir.path(), "docs");
    write(dir.path(), "src/x.rs", "x2");
    commit_all(dir.path(), "covered");
    let (vault, repo) = open(dir.path());
    assert_eq!(
        freshness(&vault, repo.as_ref(), "a.md").unwrap().state,
        DocState::Unknown
    );
    assert_eq!(
        freshness(&vault, repo.as_ref(), "b.md").unwrap().state,
        DocState::Stale
    );

    // A shallow clone, as CI makes, does not have the verified commit.
    let clone = TempDir::new().unwrap();
    let source = dir.path().to_string_lossy().replace('\\', "/");
    let url = format!(
        "file://{}{source}",
        if source.starts_with('/') { "" } else { "/" }
    );
    git(
        clone.path(),
        &[
            "-c",
            "core.autocrlf=false",
            "clone",
            "-q",
            "--depth",
            "1",
            &url,
            "repo",
        ],
    );
    let (vault, repo) = open(&clone.path().join("repo"));
    assert!(repo.is_some());
    let got = freshness(&vault, repo.as_ref(), "b.md").unwrap();
    assert_eq!(got.state, DocState::Unknown);
    assert_eq!(got.count, 0);
}

#[test]
fn missing_doc_is_not_found() {
    let (dir, _) = setup();
    let (vault, repo) = open(dir.path());
    let err = freshness(&vault, repo.as_ref(), "nope.md").unwrap_err();
    assert_eq!(err.code(), "not_found");
}

#[test]
fn stale_docs_lists_only_problem_docs() {
    let (dir, first) = setup();
    write(
        dir.path(),
        "docs/fresh.md",
        &doc("lib", Some(&first), "Fresh"),
    );
    write(
        dir.path(),
        "docs/sub/stale.md",
        &doc("src", Some(&first), "Stale"),
    );
    write(
        dir.path(),
        "docs/unverified.md",
        &doc("src", None, "Unverified"),
    );
    write(
        dir.path(),
        "docs/unknown.md",
        &doc("src", Some("abcd"), "Unknown"),
    );
    commit_all(dir.path(), "docs");
    write(dir.path(), "src/x.rs", "x2");
    commit_all(dir.path(), "one");
    write(dir.path(), "src/x.rs", "x3");
    commit_all(dir.path(), "two");
    let (vault, repo) = open(dir.path());

    let stale = |path: &str, title: &str, state, count| StaleDoc {
        path: path.to_owned(),
        title: title.to_owned(),
        state,
        count,
    };
    assert_eq!(
        stale_docs(&vault, repo.as_ref()).unwrap(),
        [
            stale("sub/stale.md", "Stale", DocState::Stale, 2),
            stale("unknown.md", "Unknown", DocState::Unknown, 0),
            stale("unverified.md", "Unverified", DocState::Unverified, 0),
        ]
    );
    assert_eq!(
        stale_docs(&vault, None).unwrap(),
        [
            stale("fresh.md", "Fresh", DocState::Unknown, 0),
            stale("sub/stale.md", "Stale", DocState::Unknown, 0),
            stale("unknown.md", "Unknown", DocState::Unknown, 0),
            stale("unverified.md", "Unverified", DocState::Unverified, 0),
        ]
    );
}

#[test]
fn git_failing_for_one_doc_makes_only_that_doc_unknown() {
    let (dir, first) = setup();
    write(dir.path(), "src/x.rs", "x2");
    let lost = commit_all(dir.path(), "lost");
    write(dir.path(), "src/x.rs", "x3");
    let kept = commit_all(dir.path(), "kept");
    write(dir.path(), "src/x.rs", "x4");
    commit_all(dir.path(), "after");
    write(dir.path(), "docs/a.md", &doc("src", Some(&first), "A"));
    write(dir.path(), "docs/b.md", &doc("src", Some(&kept), "B"));
    // Walking from HEAD back to `first` now fails; back to `kept` does not.
    let object = dir
        .path()
        .join(".git/objects")
        .join(&lost[..2])
        .join(&lost[2..]);
    let mut perms = fs::metadata(&object).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    fs::set_permissions(&object, perms).unwrap();
    fs::remove_file(&object).unwrap();
    let (vault, repo) = open(dir.path());

    let got = freshness(&vault, repo.as_ref(), "a.md").unwrap();
    assert_eq!((got.state, got.count), (DocState::Unknown, 0));
    assert!(got.commits.is_empty());
    assert_eq!(
        stale_docs(&vault, repo.as_ref()).unwrap(),
        [
            StaleDoc {
                path: "a.md".to_owned(),
                title: "A".to_owned(),
                state: DocState::Unknown,
                count: 0,
            },
            StaleDoc {
                path: "b.md".to_owned(),
                title: "B".to_owned(),
                state: DocState::Stale,
                count: 1,
            },
        ]
    );
}

#[test]
fn states_serialize_lowercase() {
    let states = [
        DocState::None,
        DocState::Fresh,
        DocState::Stale,
        DocState::Unverified,
        DocState::Unknown,
    ];
    assert_eq!(
        serde_json::to_value(states).unwrap(),
        serde_json::json!(["none", "fresh", "stale", "unverified", "unknown"])
    );
}
