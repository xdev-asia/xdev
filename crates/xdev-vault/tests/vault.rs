use std::fs;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use tempfile::TempDir;
use xdev_vault::{MAX_DOC_BYTES, Vault, VaultError, content_hash, extract_title, is_doc_path};

fn vault_with(files: &[(&str, &str)]) -> (TempDir, Vault) {
    let dir = TempDir::new().unwrap();
    for (rel, content) in files {
        let path = dir.path().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}

fn paths(vault: &Vault) -> Vec<String> {
    vault.list().unwrap().into_iter().map(|d| d.path).collect()
}

#[test]
fn lists_md_sorted_with_forward_slashes() {
    let (_dir, vault) = vault_with(&[("b.md", "b"), ("a/c.md", "c"), ("notes.txt", "x")]);
    assert_eq!(paths(&vault), ["a/c.md", "b.md"]);
    let meta = &vault.list().unwrap()[1];
    assert_eq!(meta.size, 1);
    assert!(meta.mtime_ms > 0);
}

#[test]
fn skips_gitignored_and_builtin_dirs() {
    let (_dir, vault) = vault_with(&[
        (".gitignore", "drafts/\n"),
        ("drafts/x.md", "x"),
        (".git/y.md", "y"),
        ("node_modules/p/z.md", "z"),
        ("target/t.md", "t"),
        (".xdev/i.md", "i"),
        ("docs/keep.md", "k"),
    ]);
    assert_eq!(paths(&vault), ["docs/keep.md"]);
}

#[test]
fn rejects_parent_dir() {
    let (_dir, vault) = vault_with(&[("a.md", "a")]);
    for rel in ["../outside.md", "a/../../outside.md", "./../a.md"] {
        assert!(
            matches!(vault.read(rel), Err(VaultError::OutsideVault(_))),
            "{rel}"
        );
        assert!(
            matches!(vault.write(rel, "x"), Err(VaultError::OutsideVault(_))),
            "{rel}"
        );
    }
}

#[test]
fn rejects_absolute() {
    let (dir, vault) = vault_with(&[("a.md", "a")]);
    let abs = dir.path().join("a.md");
    let abs = abs.to_str().unwrap();
    assert!(matches!(vault.read(abs), Err(VaultError::OutsideVault(_))));
    assert!(matches!(
        vault.read("/a.md"),
        Err(VaultError::OutsideVault(_))
    ));
    assert!(matches!(
        vault.write(abs, "x"),
        Err(VaultError::OutsideVault(_))
    ));
}

#[cfg(unix)]
#[test]
fn rejects_symlink_escape() {
    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("secret.md"), "s").unwrap();
    let (dir, vault) = vault_with(&[("a.md", "a")]);
    std::os::unix::fs::symlink(outside.path().join("secret.md"), dir.path().join("link.md"))
        .unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("out")).unwrap();
    assert!(matches!(
        vault.read("link.md"),
        Err(VaultError::OutsideVault(_))
    ));
    assert!(matches!(
        vault.write("link.md", "x"),
        Err(VaultError::OutsideVault(_))
    ));
    assert!(matches!(
        vault.write("out/new.md", "x"),
        Err(VaultError::OutsideVault(_))
    ));
    assert_eq!(
        fs::read_to_string(outside.path().join("secret.md")).unwrap(),
        "s"
    );
}

#[test]
fn write_is_atomic_and_readable() {
    let (dir, vault) = vault_with(&[("a/b.md", "old")]);
    vault.write("a/b.md", "new content").unwrap();
    vault.write("a/fresh.md", "fresh").unwrap();
    assert_eq!(vault.read("a/b.md").unwrap(), "new content");
    assert_eq!(vault.read("a/fresh.md").unwrap(), "fresh");
    // No temp file may be left next to the target.
    let names: Vec<_> = fs::read_dir(dir.path().join("a"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(matches!(
        vault.write("missing/x.md", "x"),
        Err(VaultError::NotFound(_))
    ));
}

#[test]
fn write_rejects_non_md() {
    let (dir, vault) = vault_with(&[]);
    assert!(vault.write("x.txt", "x").is_err());
    assert!(vault.write("x", "x").is_err());
    assert!(!dir.path().join("x.txt").exists());
}

#[test]
fn create_makes_a_new_doc() {
    let (dir, vault) = vault_with(&[("a/keep.md", "k")]);
    vault.create("a/new.md", "# New").unwrap();
    vault.create("top.md", "").unwrap();
    assert_eq!(vault.read("a/new.md").unwrap(), "# New");
    assert_eq!(fs::read_to_string(dir.path().join("top.md")).unwrap(), "");
    assert_eq!(paths(&vault), ["a/keep.md", "a/new.md", "top.md"]);
}

#[test]
fn create_refuses_an_existing_file() {
    let (dir, vault) = vault_with(&[("a.md", "old")]);
    let err = vault.create("a.md", "new").unwrap_err();
    assert!(matches!(err, VaultError::Exists(_)), "{err:?}");
    assert_eq!(err.code(), "exists");
    assert_eq!(fs::read_to_string(dir.path().join("a.md")).unwrap(), "old");
}

#[test]
fn create_rejects_non_md_outside_and_missing_parent() {
    let outside = TempDir::new().unwrap();
    let (dir, vault) = vault_with(&[]);
    let escape = format!(
        "../{}/x.md",
        outside.path().file_name().unwrap().to_str().unwrap()
    );
    let abs = dir.path().join("abs.md");
    for rel in [
        "x.txt",
        "x",
        "../x.md",
        escape.as_str(),
        abs.to_str().unwrap(),
    ] {
        assert!(
            matches!(vault.create(rel, "x"), Err(VaultError::OutsideVault(_))),
            "{rel}"
        );
    }
    assert!(matches!(
        vault.create("missing/x.md", "x"),
        Err(VaultError::NotFound(_))
    ));
    let big = "a".repeat(MAX_DOC_BYTES as usize + 1);
    assert!(matches!(
        vault.create("big.md", &big),
        Err(VaultError::TooLarge(_))
    ));
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[test]
fn remove_deletes_file() {
    let (dir, vault) = vault_with(&[("a/b.md", "b"), ("c.md", "c")]);
    vault.remove("a/b.md").unwrap();
    assert!(!dir.path().join("a/b.md").exists());
    assert_eq!(paths(&vault), ["c.md"]);
}

#[test]
fn remove_rejects_outside_and_non_md() {
    let outside = TempDir::new().unwrap();
    let (dir, vault) = vault_with(&[("a.txt", "t")]);
    fs::write(outside.path().join("x.md"), "x").unwrap();
    let escape = format!(
        "../{}/x.md",
        outside.path().file_name().unwrap().to_str().unwrap()
    );
    for rel in ["../x.md", escape.as_str(), "a.txt"] {
        assert!(
            matches!(vault.remove(rel), Err(VaultError::OutsideVault(_))),
            "{rel}"
        );
    }
    assert!(dir.path().join("a.txt").exists());
    assert!(outside.path().join("x.md").exists());
}

#[test]
fn remove_missing_is_not_found() {
    let (_dir, vault) = vault_with(&[]);
    assert!(matches!(
        vault.remove("nope.md"),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        vault.remove("no/such/dir.md"),
        Err(VaultError::NotFound(_))
    ));
}

#[test]
fn doc_path_is_md_outside_builtin_dirs() {
    assert!(is_doc_path("a.md"));
    assert!(is_doc_path("docs/A.MD"));
    assert!(is_doc_path(".github/x.md"));
    assert!(!is_doc_path("notes.txt"));
    assert!(!is_doc_path("node_modules/x.md"));
    assert!(!is_doc_path("a/target/x.md"));
    assert!(!is_doc_path(".xdev/x.md"));
}

#[test]
fn read_rejects_too_large() {
    let (dir, vault) = vault_with(&[]);
    fs::write(
        dir.path().join("big.md"),
        vec![b'a'; MAX_DOC_BYTES as usize + 1],
    )
    .unwrap();
    let err = vault.read("big.md").unwrap_err();
    assert!(matches!(err, VaultError::TooLarge(_)));
    assert_eq!(err.code(), "too_large");
}

#[test]
fn read_rejects_not_utf8() {
    let (dir, vault) = vault_with(&[]);
    fs::write(dir.path().join("bin.md"), [0xff, 0xfe, 0x00]).unwrap();
    let err = vault.read("bin.md").unwrap_err();
    assert!(matches!(err, VaultError::NotUtf8(_)));
    assert_eq!(err.code(), "not_utf8");
}

#[test]
fn read_missing_is_not_found() {
    let (_dir, vault) = vault_with(&[]);
    let err = vault.read("nope.md").unwrap_err();
    assert_eq!(err.code(), "not_found");
    assert_eq!(
        Vault::open("definitely/not/here").err().map(|e| e.code()),
        Some("not_found")
    );
}

#[test]
fn list_fails_when_root_is_gone() {
    let (dir, vault) = vault_with(&[("a.md", "a")]);
    fs::remove_dir_all(dir.path()).unwrap();
    assert_eq!(vault.list().unwrap_err().code(), "not_found");
}

#[test]
fn title_from_first_h1_else_file_stem() {
    assert_eq!(extract_title("a.md", "x\n# Hello\n"), "Hello");
    assert_eq!(extract_title("a/b-c.md", "no heading\n## Sub\n"), "b-c");
    assert_eq!(
        extract_title("a.md", "```sh\n# comment\n```\n# Real\n"),
        "Real"
    );
    assert_eq!(extract_title("a.md", "\u{feff}# Bom\r\n"), "Bom");
}

#[test]
fn id_is_16_hex_and_stable() {
    let (dir, vault) = vault_with(&[]);
    let id = vault.id();
    assert_eq!(id.len(), 16);
    assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(Vault::open(dir.path()).unwrap().id(), id);
    assert_eq!(content_hash(b"abc").len(), 64);
}

#[test]
fn watch_reports_changed_md() {
    let (_dir, vault) = vault_with(&[]);
    let (tx, rx) = mpsc::channel();
    let _watcher = vault
        .watch(move |paths| {
            tx.send(paths).ok();
        })
        .unwrap();
    fs::write(vault.root().join("ignored.txt"), "x").unwrap();
    fs::write(vault.root().join("note.md"), "# Note").unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let batch: Vec<String> = rx.recv_timeout(left).expect("no change reported in 5 s");
        assert!(batch.iter().all(|p| p.ends_with(".md")), "{batch:?}");
        if batch.iter().any(|p| p == "note.md") {
            break;
        }
    }
}
