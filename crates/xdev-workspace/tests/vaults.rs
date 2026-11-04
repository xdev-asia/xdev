use std::fs;
use std::path::Path;

use tempfile::TempDir;
use xdev_workspace::{
    Registry, RepoEntry, VaultKind, add_vault, forget_vault, list_vaults, repo_docs_dir, repo_id,
    validate_docs_dir,
};

/// A registry with one repo whose checkout is `<tmp>/main`.
fn with_repo() -> (TempDir, Registry, RepoEntry) {
    let tmp = TempDir::with_prefix("ws vaults ").unwrap();
    let main = tmp.path().join("main");
    fs::create_dir(&main).unwrap();
    let entry = RepoEntry {
        id: repo_id(&main),
        short_name: "main".into(),
        path: main,
        base_ref: "main".into(),
        worktree_root: tmp.path().join("wt"),
        ..RepoEntry::default()
    };
    let mut reg = Registry::default();
    reg.repos.push(entry.clone());
    (tmp, reg, entry)
}

#[test]
fn lists_repo_vault_when_docs_exists() {
    let (_tmp, reg, entry) = with_repo();
    fs::create_dir(repo_docs_dir(&entry)).unwrap();
    let views = list_vaults(&reg);
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].id, format!("repo:{}", entry.id));
    assert_eq!(views[0].kind, VaultKind::Repo);
    assert_eq!(views[0].name, "main");
    assert_eq!(views[0].repo_id.as_deref(), Some(entry.id.as_str()));
    assert_eq!(views[0].path, repo_docs_dir(&entry).to_string_lossy());
    assert!(views[0].exists);
}

#[test]
fn repo_without_docs_lists_not_existing() {
    let (_tmp, reg, _) = with_repo();
    let views = list_vaults(&reg);
    assert_eq!(views.len(), 1);
    assert!(!views[0].exists);
}

#[test]
fn add_shared_vault_then_list() {
    let (tmp, mut reg, entry) = with_repo();
    let shared = tmp.path().join("Shared Notes");
    fs::create_dir(&shared).unwrap();
    let other = tmp.path().join("alpha");
    fs::create_dir(&other).unwrap();
    let view = add_vault(&mut reg, &shared).unwrap();
    add_vault(&mut reg, &other).unwrap();
    assert_eq!(view.kind, VaultKind::Shared);
    assert_eq!(view.name, "Shared Notes");
    assert_eq!(view.id, repo_id(&shared));
    assert_eq!(view.id.len(), 12);
    assert_eq!(view.repo_id, None);
    assert!(view.exists);
    // Repo vaults first, then shared vaults by name.
    let views = list_vaults(&reg);
    let kinds: Vec<_> = views.iter().map(|v| (v.kind, v.name.as_str())).collect();
    assert_eq!(
        kinds,
        [
            (VaultKind::Repo, "main"),
            (VaultKind::Shared, "alpha"),
            (VaultKind::Shared, "Shared Notes"),
        ]
    );
    assert_eq!(views[0].repo_id.as_deref(), Some(entry.id.as_str()));
}

#[test]
fn shared_vault_whose_folder_is_gone_lists_not_existing() {
    let (tmp, mut reg, _) = with_repo();
    let shared = tmp.path().join("notes");
    fs::create_dir(&shared).unwrap();
    add_vault(&mut reg, &shared).unwrap();
    fs::remove_dir(&shared).unwrap();
    let views = list_vaults(&reg);
    assert!(!views[1].exists);
}

#[test]
fn add_refuses_missing_folder() {
    let (tmp, mut reg, _) = with_repo();
    let err = add_vault(&mut reg, &tmp.path().join("nope")).unwrap_err();
    assert_eq!(err.code(), "bad_path");
    assert!(reg.vaults.is_empty());
}

#[test]
fn add_refuses_same_path_twice() {
    let (tmp, mut reg, entry) = with_repo();
    let shared = tmp.path().join("notes");
    fs::create_dir(&shared).unwrap();
    add_vault(&mut reg, &shared).unwrap();
    let err = add_vault(&mut reg, &shared).unwrap_err();
    assert_eq!(err.code(), "vault_exists");

    // A repo's docs/ is already a vault, however it is spelled.
    let docs = repo_docs_dir(&entry);
    fs::create_dir(&docs).unwrap();
    let err = add_vault(&mut reg, &docs).unwrap_err();
    assert_eq!(err.code(), "vault_exists");
    if cfg!(windows) {
        let upper = docs.to_string_lossy().to_uppercase();
        let err = add_vault(&mut reg, Path::new(&upper)).unwrap_err();
        assert_eq!(err.code(), "vault_exists");
        let slashed = format!("{}/", docs.to_string_lossy().replace('\\', "/"));
        let err = add_vault(&mut reg, Path::new(&slashed)).unwrap_err();
        assert_eq!(err.code(), "vault_exists");
    }
    assert_eq!(reg.vaults.len(), 1);
}

#[test]
fn forget_drops_record_keeps_folder() {
    let (tmp, mut reg, _) = with_repo();
    let shared = tmp.path().join("notes");
    fs::create_dir(&shared).unwrap();
    fs::write(shared.join("a.md"), "x").unwrap();
    let id = add_vault(&mut reg, &shared).unwrap().id;
    forget_vault(&mut reg, &id).unwrap();
    assert!(reg.vaults.is_empty());
    assert!(shared.join("a.md").is_file());
    assert_eq!(
        forget_vault(&mut reg, &id).unwrap_err().code(),
        "vault_unknown"
    );
}

#[test]
fn forget_refuses_repo_vault_id() {
    let (_tmp, mut reg, entry) = with_repo();
    let err = forget_vault(&mut reg, &format!("repo:{}", entry.id)).unwrap_err();
    assert_eq!(err.code(), "vault_unknown");
    assert_eq!(reg.repos.len(), 1);
}

#[test]
fn repo_docs_dir_defaults_to_docs_and_honours_docs_dir() {
    let (_tmp, _reg, mut entry) = with_repo();
    assert_eq!(repo_docs_dir(&entry), entry.path.join("docs"));
    entry.docs_dir = Some("handbook/en".into());
    assert_eq!(repo_docs_dir(&entry), entry.path.join("handbook/en"));
}

#[test]
fn validate_docs_dir_accepts_relative_and_resets_on_empty() {
    assert_eq!(validate_docs_dir("").unwrap(), None);
    assert_eq!(validate_docs_dir("  ").unwrap(), None);
    assert_eq!(validate_docs_dir("docs").unwrap(), Some("docs".into()));
    assert_eq!(validate_docs_dir("a/b").unwrap(), Some("a/b".to_owned()));
    // Either separator reads the same.
    assert_eq!(validate_docs_dir(r"a\b").unwrap(), Some("a/b".to_owned()));
    assert_eq!(validate_docs_dir("./a/").unwrap(), Some("a".into()));
}

#[test]
fn validate_docs_dir_refuses_escapes_and_absolute_paths() {
    for bad in [
        "..",
        "../x",
        "a/../b",
        r"a\..\b",
        "/x",
        r"\x",
        r"C:\x",
        "C:/x",
        "c:x",
        r"\\host\share",
        ".",
        "a/./..",
    ] {
        let err = validate_docs_dir(bad).unwrap_err();
        assert_eq!(err.code(), "bad_path", "{bad:?}");
    }
}

#[test]
fn list_vaults_reports_the_custom_docs_path() {
    let (_tmp, mut reg, mut entry) = with_repo();
    entry.docs_dir = Some("handbook".into());
    reg.repos[0] = entry.clone();
    fs::create_dir(entry.path.join("handbook")).unwrap();
    let views = list_vaults(&reg);
    assert_eq!(views[0].path, entry.path.join("handbook").to_string_lossy());
    assert!(views[0].exists);
}

#[test]
fn add_refuses_a_custom_repo_docs_folder() {
    let (_tmp, mut reg, mut entry) = with_repo();
    entry.docs_dir = Some("handbook".into());
    reg.repos[0] = entry.clone();
    let custom = entry.path.join("handbook");
    fs::create_dir(&custom).unwrap();
    let err = add_vault(&mut reg, &custom).unwrap_err();
    assert_eq!(err.code(), "vault_exists");
}
