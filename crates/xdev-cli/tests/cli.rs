use std::fs;
use std::path::Path;
use std::process::{Command, Output};

use tempfile::TempDir;

fn xdev(data_dir: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_xdev"))
        .env("XDEV_DATA_DIR", data_dir)
        .args(args)
        .output()
        .expect("run xdev")
}

fn vault() -> TempDir {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("a.md"), "# Tài liệu\nKiến trúc hệ thống").unwrap();
    fs::create_dir(dir.path().join("sub")).unwrap();
    fs::write(dir.path().join("sub/b.md"), "plain notes").unwrap();
    fs::write(dir.path().join("bin.md"), [0xff, 0xfe]).unwrap();
    dir
}

fn stdout(out: &Output) -> String {
    String::from_utf8(out.stdout.clone()).unwrap()
}

#[test]
fn index_counts_docs() {
    let (vault, data) = (vault(), TempDir::new().unwrap());
    let out = xdev(data.path(), &["index", vault.path().to_str().unwrap()]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(stdout(&out).trim(), "indexed 2 docs, skipped 1");
    // The index lives under the data dir, not in the vault.
    assert!(data.path().join("vaults").is_dir());
    assert!(!vault.path().join(".xdev").exists());
}

#[test]
fn search_prints_hits() {
    let (vault, data) = (vault(), TempDir::new().unwrap());
    let dir = vault.path().to_str().unwrap();
    let out = xdev(data.path(), &["search", dir, "tai lieu"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(stdout(&out), "a.md\tTài liệu\n");

    let out = xdev(data.path(), &["search", dir, "notes", "--limit", "5"]);
    assert_eq!(stdout(&out), "sub/b.md\tb\n");

    let out = xdev(data.path(), &["search", dir, "nothing-matches"]);
    assert!(out.status.success());
    assert_eq!(stdout(&out), "");
}

/// Runs setup commands in the test repo.
fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?}: {out:?}");
}

#[test]
fn changes_prints_kind_and_path() {
    let (vault, data) = (vault(), TempDir::new().unwrap());
    let dir = vault.path();
    git(dir, &["init", "-q"]);
    // Local identity and no autocrlf, so the developer's global config
    // plays no part.
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(dir, &["config", key, value]);
    }
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", "init"]);
    fs::write(dir.join("a.md"), "changed").unwrap();

    let out = xdev(data.path(), &["changes", dir.to_str().unwrap()]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(stdout(&out), "modified\ta.md\n");
}

#[test]
fn changes_outside_repo_fails_with_no_repo() {
    let (vault, data) = (vault(), TempDir::new().unwrap());
    let out = xdev(data.path(), &["changes", vault.path().to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        "error: no_repo"
    );
}

#[test]
fn check_prints_broken_links_and_fails() {
    let (vault, data) = (vault(), TempDir::new().unwrap());
    let dir = vault.path().to_str().unwrap();
    let out = xdev(data.path(), &["check", dir]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(stdout(&out), "");

    fs::write(
        vault.path().join("sub/b.md"),
        "[[a]] [[nope]] [x](../gone.md)",
    )
    .unwrap();
    let out = xdev(data.path(), &["check", dir]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert_eq!(
        stdout(&out),
        "broken\tsub/b.md\tnope\nbroken\tsub/b.md\t../gone.md\n"
    );
    assert!(out.stderr.is_empty());
}

/// Local identity and no autocrlf, so the developer's global config plays
/// no part.
fn init_repo(dir: &Path) {
    git(dir, &["init", "-q"]);
    for (key, value) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(dir, &["config", key, value]);
    }
}

fn commit_all(dir: &Path, message: &str) -> String {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
    let out = Command::new("git")
        .current_dir(dir)
        .args(["rev-parse", "HEAD"])
        .output()
        .expect("run git");
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

fn covered(covers: &str, verified: Option<&str>) -> String {
    let verified = verified.map_or(String::new(), |v| format!("verified: {v}\n"));
    format!("---\ncovers: {covers}\n{verified}---\n# D\n")
}

#[test]
fn check_reports_stale_unverified_unknown() {
    let (vault, data) = (vault(), TempDir::new().unwrap());
    let dir = vault.path();
    init_repo(dir);
    fs::create_dir(dir.join("src")).unwrap();
    fs::write(dir.join("src/x.rs"), "x").unwrap();
    let first = commit_all(dir, "code");
    fs::write(dir.join("fresh.md"), covered("src", Some(&first))).unwrap();
    fs::write(dir.join("stale.md"), covered("[src/**]", Some(&first))).unwrap();
    fs::write(dir.join("unverified.md"), covered("src", None)).unwrap();
    fs::write(dir.join("main.md"), covered("src", Some("main"))).unwrap();
    fs::write(dir.join("unknown.md"), covered("src", Some("ABCDEF0"))).unwrap();
    fs::write(dir.join("zz.md"), "[[nope]]").unwrap();
    commit_all(dir, "docs");
    fs::write(dir.join("src/x.rs"), "x2").unwrap();
    let head = commit_all(dir, "covered");
    // Verified in the saved file, not yet committed.
    fs::write(dir.join("fresh.md"), covered("src", Some(&head))).unwrap();

    let out = xdev(data.path(), &["check", dir.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert_eq!(
        stdout(&out),
        "broken\tzz.md\tnope\n\
         unverified\tmain.md\t-\n\
         stale\tstale.md\t1\n\
         unknown\tunknown.md\tabcdef0\n\
         unverified\tunverified.md\t-\n"
    );
    assert!(out.stderr.is_empty(), "{out:?}");
}

#[test]
fn check_outside_git_reports_unknown() {
    let (vault, data) = (vault(), TempDir::new().unwrap());
    let dir = vault.path();
    fs::write(dir.join("a.md"), covered("src", Some("abcdef0"))).unwrap();
    fs::write(dir.join("c.md"), covered("src", None)).unwrap();
    let out = xdev(data.path(), &["check", dir.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert_eq!(
        stdout(&out),
        "unknown\ta.md\tabcdef0\nunverified\tc.md\t-\n"
    );
}

#[test]
fn check_passes_when_covered_docs_are_fresh() {
    let (vault, data) = (vault(), TempDir::new().unwrap());
    let dir = vault.path();
    init_repo(dir);
    fs::create_dir(dir.join("src")).unwrap();
    fs::write(dir.join("src/x.rs"), "x").unwrap();
    let first = commit_all(dir, "code");
    fs::write(dir.join("a.md"), covered("src", Some(&first))).unwrap();
    let out = xdev(data.path(), &["check", dir.to_str().unwrap()]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(stdout(&out), "");
}

#[test]
fn search_missing_dir_fails_with_not_found() {
    let data = TempDir::new().unwrap();
    let missing = data.path().join("no-such-vault");
    let out = xdev(data.path(), &["search", missing.to_str().unwrap(), "x"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        "error: not_found"
    );
    assert!(out.stdout.is_empty());
}

#[test]
fn export_check_then_write() {
    let (vault, data) = (vault(), TempDir::new().unwrap());
    let out_dir = TempDir::new().unwrap();
    let dir = vault.path().to_str().unwrap();
    let out = out_dir.path().to_str().unwrap();
    fs::write(
        vault.path().join("a.md"),
        "---\nagents: true\n---\n# A\nBody",
    )
    .unwrap();

    let res = xdev(data.path(), &["export", dir, "--out", out, "--check"]);
    assert_eq!(res.status.code(), Some(1), "{res:?}");
    assert_eq!(
        stdout(&res),
        "new\tAGENTS.md\nnew\tCLAUDE.md\nnew\tGEMINI.md\n"
    );
    assert!(!out_dir.path().join("AGENTS.md").exists());

    let res = xdev(data.path(), &["export", dir, "--out", out]);
    assert!(res.status.success(), "{res:?}");
    assert!(out_dir.path().join("AGENTS.md").is_file());

    let res = xdev(data.path(), &["export", dir, "--out", out, "--check"]);
    assert!(res.status.success(), "{res:?}");
    assert_eq!(
        stdout(&res),
        "unchanged\tAGENTS.md\nunchanged\tCLAUDE.md\nunchanged\tGEMINI.md\n"
    );

    // A hand-written file is never overwritten, and --check flags it.
    fs::write(out_dir.path().join("CLAUDE.md"), "mine\n").unwrap();
    let res = xdev(data.path(), &["export", dir, "--out", out]);
    assert!(res.status.success(), "{res:?}");
    assert!(stdout(&res).contains("foreign\tCLAUDE.md\n"));
    assert_eq!(
        fs::read_to_string(out_dir.path().join("CLAUDE.md")).unwrap(),
        "mine\n"
    );
    let res = xdev(data.path(), &["export", dir, "--out", out, "--check"]);
    assert_eq!(res.status.code(), Some(1));
}
