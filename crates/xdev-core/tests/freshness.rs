use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_core::{
    DocState, FRESHNESS_COMMITS, Freshness, LinkedRepo, Links, Repo, StaleDoc, Vault, freshness,
    split_prefix, stale_docs,
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

/// An empty repo with its own identity and no autocrlf.
fn new_repo() -> TempDir {
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

/// A repo with code in `src/` and `lib/` committed, and the vault in
/// `docs/`. Returns the first commit's id.
fn setup() -> (TempDir, String) {
    let dir = new_repo();
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

    let got = freshness(&vault, repo.as_ref(), &Links::default(), "a.md").unwrap();
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
        freshness(&vault, repo.as_ref(), &Links::default(), "a.md")
            .unwrap()
            .state,
        DocState::Fresh
    );

    write(dir.path(), "src/x.rs", "x2");
    let covered = commit_all(dir.path(), "covered");
    let got = freshness(&vault, repo.as_ref(), &Links::default(), "a.md").unwrap();
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
    let got = freshness(&vault, repo.as_ref(), &Links::default(), "a.md").unwrap();
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
        freshness(&vault, repo.as_ref(), &Links::default(), "a.md")
            .unwrap()
            .state,
        DocState::Unverified
    );
    // Verified at HEAD without committing the doc: the saved file counts.
    vault.write("a.md", &doc("src", Some(&head), "A")).unwrap();
    assert_eq!(
        freshness(&vault, repo.as_ref(), &Links::default(), "a.md")
            .unwrap()
            .state,
        DocState::Fresh
    );
    vault.write("a.md", &doc("src", Some(&first), "A")).unwrap();
    assert_eq!(
        freshness(&vault, repo.as_ref(), &Links::default(), "a.md")
            .unwrap()
            .state,
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
            let got = freshness(&vault, repo, &Links::default(), path).unwrap();
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
        freshness(&vault, repo.as_ref(), &Links::default(), "plain.md").unwrap(),
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
        freshness(&vault, None, &Links::default(), "a.md").unwrap(),
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
        freshness(&vault, None, &Links::default(), "b.md")
            .unwrap()
            .state,
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
        freshness(&vault, repo.as_ref(), &Links::default(), "a.md")
            .unwrap()
            .state,
        DocState::Unknown
    );
    assert_eq!(
        freshness(&vault, repo.as_ref(), &Links::default(), "b.md")
            .unwrap()
            .state,
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
    let got = freshness(&vault, repo.as_ref(), &Links::default(), "b.md").unwrap();
    assert_eq!(got.state, DocState::Unknown);
    assert_eq!(got.count, 0);
}

#[test]
fn missing_doc_is_not_found() {
    let (dir, _) = setup();
    let (vault, repo) = open(dir.path());
    let err = freshness(&vault, repo.as_ref(), &Links::default(), "nope.md").unwrap_err();
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
        stale_docs(&vault, repo.as_ref(), &Links::default()).unwrap(),
        [
            stale("sub/stale.md", "Stale", DocState::Stale, 2),
            stale("unknown.md", "Unknown", DocState::Unknown, 0),
            stale("unverified.md", "Unverified", DocState::Unverified, 0),
        ]
    );
    assert_eq!(
        stale_docs(&vault, None, &Links::default()).unwrap(),
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

    let got = freshness(&vault, repo.as_ref(), &Links::default(), "a.md").unwrap();
    assert_eq!((got.state, got.count), (DocState::Unknown, 0));
    assert!(got.commits.is_empty());
    assert_eq!(
        stale_docs(&vault, repo.as_ref(), &Links::default()).unwrap(),
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
        DocState::Unlinked,
    ];
    assert_eq!(
        serde_json::to_value(states).unwrap(),
        serde_json::json!([
            "none",
            "fresh",
            "stale",
            "unverified",
            "unknown",
            "unlinked"
        ])
    );
}

/// Links for a repo vault whose own short name is `own`.
fn own_links(own: &str) -> Links {
    Links {
        own: Some(own.to_owned()),
        ..Links::default()
    }
}

/// Another repo with `api/` code: `c1` on `main`, then `c2` touching `api/`
/// on `main`, then `c3` touching `api/` on a checked-out side branch.
fn other_repo() -> (TempDir, [String; 3]) {
    let dir = new_repo();
    write(dir.path(), "api/a.rs", "a");
    let c1 = commit_all(dir.path(), "c1");
    git(dir.path(), &["branch", "-M", "main"]);
    write(dir.path(), "api/a.rs", "a2");
    let c2 = commit_all(dir.path(), "c2");
    git(dir.path(), &["checkout", "-q", "-b", "side"]);
    write(dir.path(), "api/a.rs", "a3");
    let c3 = commit_all(dir.path(), "c3");
    (dir, [c1, c2, c3])
}

fn linked(dir: &Path, base_ref: &str) -> Option<LinkedRepo> {
    Some(LinkedRepo {
        repo: Repo::discover(dir).unwrap(),
        base_ref: base_ref.to_owned(),
    })
}

#[test]
fn split_prefix_cases() {
    assert_eq!(split_prefix("xdev:crates/**"), (Some("xdev"), "crates/**"));
    assert_eq!(split_prefix("xdev:./src"), (Some("xdev"), "src"));
    assert_eq!(split_prefix("crates/**"), (None, "crates/**"));
    assert_eq!(split_prefix("xdev:"), (None, "xdev:"));
    assert_eq!(split_prefix("Bad:x"), (None, "Bad:x"));
    assert_eq!(split_prefix("a.b-c_1:/x"), (Some("a.b-c_1"), "x"));
    assert_eq!(split_prefix("-x:y"), (None, "-x:y"));
}

#[test]
fn unprefixed_repo_vault_keeps_head_behaviour() {
    let (dir, first) = setup();
    write(dir.path(), "docs/a.md", &doc("[src/**]", Some(&first), "A"));
    let (vault, repo) = open(dir.path());
    let got = freshness(&vault, repo.as_ref(), &Links::default(), "a.md").unwrap();
    assert_eq!(got.state, DocState::Fresh);
    assert_eq!(got.head.as_deref(), Some(first.as_str()));

    write(dir.path(), "src/x.rs", "x2");
    let covered = commit_all(dir.path(), "covered");
    let got = freshness(&vault, repo.as_ref(), &Links::default(), "a.md").unwrap();
    assert_eq!((got.state, got.count), (DocState::Stale, 1));
    assert_eq!(got.head.as_deref(), Some(covered.as_str()));
}

#[test]
fn own_prefix_reads_as_unprefixed() {
    let (dir, first) = setup();
    write(
        dir.path(),
        "docs/a.md",
        &doc("[app:src/**]", Some(&first), "A"),
    );
    let (vault, repo) = open(dir.path());
    let links = own_links("app");
    let got = freshness(&vault, repo.as_ref(), &links, "a.md").unwrap();
    assert_eq!(got.state, DocState::Fresh);
    assert_eq!(got.head.as_deref(), Some(first.as_str()));

    write(dir.path(), "src/x.rs", "x2");
    let covered = commit_all(dir.path(), "covered");
    let got = freshness(&vault, repo.as_ref(), &links, "a.md").unwrap();
    assert_eq!((got.state, got.count), (DocState::Stale, 1));
    assert_eq!(got.commits[0].id, covered);
    assert_eq!(got.head.as_deref(), Some(covered.as_str()));
}

#[test]
fn unknown_prefix_is_unlinked_not_fresh() {
    let (dir, first) = setup();
    write(
        dir.path(),
        "docs/a.md",
        &doc("[nobody:src/**]", Some(&first), "A"),
    );
    let (vault, repo) = open(dir.path());
    for links in [Links::default(), own_links("app")] {
        let got = freshness(&vault, repo.as_ref(), &links, "a.md").unwrap();
        assert_eq!((got.state, got.count), (DocState::Unlinked, 0));
        assert!(got.commits.is_empty());
    }
}

#[test]
fn shared_unprefixed_is_unlinked() {
    let (dir, first) = setup();
    write(dir.path(), "docs/a.md", &doc("[src/**]", Some(&first), "A"));
    let (vault, repo) = open(dir.path());
    let links = Links {
        shared: true,
        ..Links::default()
    };
    let got = freshness(&vault, repo.as_ref(), &links, "a.md").unwrap();
    assert_eq!((got.state, got.count), (DocState::Unlinked, 0));
    assert_eq!(got.head, None);
}

#[test]
fn prefixed_entry_counts_to_base_ref() {
    let (dir, _) = setup();
    let (api, [c1, c2, c3]) = other_repo();
    write(
        dir.path(),
        "docs/a.md",
        &doc("[api:api/**]", Some(&c1), "A"),
    );
    let (vault, repo) = open(dir.path());
    let mut links = own_links("app");
    links
        .repos
        .insert("api".to_owned(), linked(api.path(), "main"));
    let got = freshness(&vault, repo.as_ref(), &links, "a.md").unwrap();
    assert_eq!((got.state, got.count), (DocState::Stale, 1));
    assert_eq!(got.commits.len(), 1);
    assert_eq!(got.commits[0].id, c2);
    assert_eq!(got.head.as_deref(), Some(c2.as_str()));

    // Verified at the base-ref commit: fresh, although the checkout is ahead.
    vault
        .write("a.md", &doc("[api:api/**]", Some(&c2), "A"))
        .unwrap();
    let got = freshness(&vault, repo.as_ref(), &links, "a.md").unwrap();
    assert_eq!((got.state, got.count), (DocState::Fresh, 0));
    assert_ne!(got.head.as_deref(), Some(c3.as_str()));
}

/// A clone of `src` in `<tmp>/r`, with the same identity as `new_repo`.
fn clone(src: &Path) -> (TempDir, std::path::PathBuf) {
    let tmp = TempDir::new().unwrap();
    let src = src.to_string_lossy();
    git(
        tmp.path(),
        &["-c", "core.autocrlf=false", "clone", "-q", &src, "r"],
    );
    let dir = tmp.path().join("r");
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(&dir, &["config", key, value]);
    }
    (tmp, dir)
}

#[test]
fn parts_sum_counts_and_list_own_repo_first() {
    let (api, [c1, ..]) = other_repo();
    // All three share `api`'s history, so `verified` resolves in each.
    let (_own_tmp, own) = clone(api.path());
    let (_web_tmp, web) = clone(api.path());
    git(&web, &["checkout", "-q", "-B", "main", "origin/main"]);
    write(&web, "api/a.rs", "w");
    commit_all(&web, "w");

    // Listed in another order than the answer: own first, then by prefix.
    write(
        &own,
        "docs/a.md",
        &doc("[web:api/**, api/**, api:api/**]", Some(&c1), "A"),
    );
    let (vault, repo) = open(&own);
    let mut links = own_links("app");
    links.repos.insert("web".to_owned(), linked(&web, "main"));
    links
        .repos
        .insert("api".to_owned(), linked(api.path(), "main"));
    let got = freshness(&vault, repo.as_ref(), &links, "a.md").unwrap();
    assert_eq!((got.state, got.count), (DocState::Stale, 5));
    let messages: Vec<&str> = got.commits.iter().map(|c| c.message.as_str()).collect();
    assert_eq!(messages, ["c3", "c2", "c2", "w", "c2"]);
    // Own entries and another repo: no single commit to mark verified.
    assert_eq!(got.head, None);
}

#[test]
fn stale_wins_over_unlinked() {
    let (dir, first) = setup();
    write(
        dir.path(),
        "docs/a.md",
        &doc("[src/**, nobody:src/**]", Some(&first), "A"),
    );
    let (vault, repo) = open(dir.path());
    let links = Links::default();
    assert_eq!(
        freshness(&vault, repo.as_ref(), &links, "a.md")
            .unwrap()
            .state,
        DocState::Unlinked
    );
    write(dir.path(), "src/x.rs", "x2");
    commit_all(dir.path(), "covered");
    let got = freshness(&vault, repo.as_ref(), &links, "a.md").unwrap();
    assert_eq!((got.state, got.count), (DocState::Stale, 1));
}

#[test]
fn missing_registered_repo_is_unknown() {
    let (dir, first) = setup();
    write(
        dir.path(),
        "docs/a.md",
        &doc("[gone:src/**]", Some(&first), "A"),
    );
    write(
        dir.path(),
        "docs/b.md",
        &doc("[gone:src/**, nobody:src/**]", Some(&first), "B"),
    );
    let (vault, repo) = open(dir.path());
    let mut links = own_links("app");
    links.repos.insert("gone".to_owned(), None);
    let got = freshness(&vault, repo.as_ref(), &links, "a.md").unwrap();
    assert_eq!(
        (got.state, got.count, got.head),
        (DocState::Unknown, 0, None)
    );
    // Unlinked outranks Unknown.
    assert_eq!(
        freshness(&vault, repo.as_ref(), &links, "b.md")
            .unwrap()
            .state,
        DocState::Unlinked
    );
}

#[test]
fn unresolved_base_ref_or_verified_is_unknown() {
    let (dir, first) = setup();
    let (api, [c1, ..]) = other_repo();
    write(
        dir.path(),
        "docs/a.md",
        &doc("[api:api/**]", Some(&c1), "A"),
    );
    write(
        dir.path(),
        "docs/b.md",
        &doc("[api:api/**]", Some(&first), "B"),
    );
    let (vault, repo) = open(dir.path());
    let mut links = Links::default();
    links
        .repos
        .insert("api".to_owned(), linked(api.path(), "no-such"));
    let got = freshness(&vault, repo.as_ref(), &links, "a.md").unwrap();
    assert_eq!((got.state, got.head), (DocState::Unknown, None));
    links
        .repos
        .insert("api".to_owned(), linked(api.path(), "main"));
    // `first` is a commit of the vault's repo, not of `api`.
    assert_eq!(
        freshness(&vault, repo.as_ref(), &links, "b.md")
            .unwrap()
            .state,
        DocState::Unknown
    );
}

#[test]
fn stale_docs_lists_unlinked() {
    let (dir, first) = setup();
    write(
        dir.path(),
        "docs/fresh.md",
        &doc("[src/**]", Some(&first), "Fresh"),
    );
    write(
        dir.path(),
        "docs/unlinked.md",
        &doc("[nobody:src/**]", Some(&first), "Unlinked"),
    );
    let (vault, repo) = open(dir.path());
    assert_eq!(
        stale_docs(&vault, repo.as_ref(), &Links::default()).unwrap(),
        [StaleDoc {
            path: "unlinked.md".to_owned(),
            title: "Unlinked".to_owned(),
            state: DocState::Unlinked,
            count: 0,
        }]
    );
}

#[test]
fn prefix_without_path_is_unlinked() {
    let (dir, first) = setup();
    let (api, _) = other_repo();
    let mut registered = own_links("app");
    registered
        .repos
        .insert("api".to_owned(), linked(api.path(), "main"));
    for entry in ["api:", "api:/", "api:./"] {
        write(
            dir.path(),
            "docs/a.md",
            &doc(&format!("[\"{entry}\"]"), Some(&first), "A"),
        );
        let (vault, repo) = open(dir.path());
        for links in [&Links::default(), &registered] {
            let got = freshness(&vault, repo.as_ref(), links, "a.md").unwrap();
            assert_eq!(got.covers, [entry], "{entry}");
            assert_eq!(
                (got.state, got.count, got.head),
                (DocState::Unlinked, 0, None),
                "{entry}"
            );
        }
    }
}

#[test]
fn unlinked_entry_has_no_head() {
    let (dir, first) = setup();
    write(
        dir.path(),
        "docs/only.md",
        &doc("[nobody:src/**]", Some(&first), "Only"),
    );
    write(
        dir.path(),
        "docs/mixed.md",
        &doc("[src/**, nobody:src/**]", Some(&first), "Mixed"),
    );
    let (vault, repo) = open(dir.path());
    for path in ["only.md", "mixed.md"] {
        let got = freshness(&vault, repo.as_ref(), &Links::default(), path).unwrap();
        assert_eq!((got.state, got.head), (DocState::Unlinked, None), "{path}");
    }
}

#[test]
fn two_other_repos_have_no_head() {
    let (api, [c1, ..]) = other_repo();
    let (_own_tmp, own) = clone(api.path());
    let (_web_tmp, web) = clone(api.path());
    git(&web, &["checkout", "-q", "-B", "main", "origin/main"]);
    write(
        &own,
        "docs/a.md",
        &doc("[web:api/**, api:api/**]", Some(&c1), "A"),
    );
    let (vault, repo) = open(&own);
    let mut links = own_links("app");
    links.repos.insert("web".to_owned(), linked(&web, "main"));
    links
        .repos
        .insert("api".to_owned(), linked(api.path(), "main"));
    let got = freshness(&vault, repo.as_ref(), &links, "a.md").unwrap();
    assert_eq!((got.state, got.count), (DocState::Stale, 2));
    assert_eq!(got.head, None);
}

#[test]
fn linked_repo_moved_away_is_unknown() {
    let (dir, _) = setup();
    let (api, [c1, ..]) = other_repo();
    write(
        dir.path(),
        "docs/a.md",
        &doc("[api:api/**]", Some(&c1), "A"),
    );
    let (vault, repo) = open(dir.path());
    let mut links = own_links("app");
    links
        .repos
        .insert("api".to_owned(), linked(api.path(), "main"));
    // Gone after `links` was built; moved, not deleted.
    let away = TempDir::new().unwrap();
    fs::rename(api.path(), away.path().join("api")).unwrap();

    let got = freshness(&vault, repo.as_ref(), &links, "a.md").unwrap();
    assert_eq!(
        (got.state, got.count, got.head),
        (DocState::Unknown, 0, None)
    );
    let stale = stale_docs(&vault, repo.as_ref(), &links).unwrap();
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].state, DocState::Unknown);
}
