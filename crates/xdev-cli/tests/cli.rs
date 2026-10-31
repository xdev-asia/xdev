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
