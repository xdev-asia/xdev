use std::fs;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use xdev_core::{CoreError, FileStatus, Vault, export_plan, export_root, export_write};

fn write(root: &Path, rel: &str, content: impl AsRef<[u8]>) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

/// A repo at the temp dir whose vault is `docs/`.
fn repo_with_docs_vault(files: &[(&str, &str)]) -> (TempDir, Vault) {
    let dir = TempDir::new().unwrap();
    let out = Command::new("git")
        .current_dir(dir.path())
        .args(["init", "-q"])
        .output()
        .expect("run git");
    assert!(out.status.success());
    for (rel, content) in files {
        write(&dir.path().join("docs"), rel, content);
    }
    let vault = Vault::open(dir.path().join("docs")).unwrap();
    (dir, vault)
}

fn expected(plan: &xdev_core::ExportPlan) -> Vec<(String, String)> {
    plan.files
        .iter()
        .filter(|f| matches!(f.status, FileStatus::New | FileStatus::Changed))
        .map(|f| (f.path.clone(), f.hash.clone()))
        .collect()
}

#[test]
fn export_plan_from_subfolder_vault() {
    let (dir, vault) = repo_with_docs_vault(&[
        ("guide.md", "---\nagents: true\n---\n# Guide\n\nUse pnpm."),
        ("notes.md", "# Notes\n\nNot for agents."),
        (
            "c.md",
            "---\nagents: [claude]\ntitle: Claude bits\n---\nOnly Claude.",
        ),
    ]);
    let root = export_root(&vault).unwrap();
    assert_eq!(
        fs::canonicalize(&root).unwrap(),
        fs::canonicalize(dir.path()).unwrap()
    );

    let plan = export_plan(&vault, &root).unwrap();
    let paths: Vec<&str> = plan.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
    assert!(plan.files.iter().all(|f| f.status == FileStatus::New));
    assert!(
        plan.files[0]
            .new
            .contains("## Guide\n_Source: `docs/guide.md`_\n\nUse pnpm.\n")
    );
    assert!(
        plan.files[1]
            .new
            .contains("## Claude bits\n_Source: `docs/c.md`_")
    );
    let docs: Vec<(&str, &str)> = plan
        .docs
        .iter()
        .map(|d| (d.path.as_str(), d.title.as_str()))
        .collect();
    assert_eq!(docs, [("c.md", "Claude bits"), ("guide.md", "Guide")]);
    assert_eq!(plan.tokens, plan.files[0].new.chars().count().div_ceil(4));

    let written = export_write(&vault, &root, &expected(&plan)).unwrap();
    assert_eq!(written, ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
    assert!(dir.path().join("AGENTS.md").is_file());
    let again = export_plan(&vault, &root).unwrap();
    assert!(
        again
            .files
            .iter()
            .all(|f| f.status == FileStatus::Unchanged)
    );
}

#[test]
fn export_root_without_repo_is_the_vault() {
    let dir = TempDir::new().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    assert_eq!(export_root(&vault).unwrap(), vault.root());
}

#[test]
fn export_write_rejects_stale_expectation() {
    let (dir, vault) = repo_with_docs_vault(&[("a.md", "---\nagents: true\n---\nOne")]);
    let root = export_root(&vault).unwrap();
    let plan = export_plan(&vault, &root).unwrap();
    write(
        &dir.path().join("docs"),
        "a.md",
        "---\nagents: true\n---\nTwo",
    );

    let err = export_write(&vault, &root, &expected(&plan)).unwrap_err();
    assert!(matches!(err, CoreError::Export(_)));
    assert_eq!(err.code(), "stale");
    assert!(!dir.path().join("AGENTS.md").exists());
}

#[test]
fn foreign_file_is_reported_and_kept() {
    let (dir, vault) = repo_with_docs_vault(&[("a.md", "---\nagents: true\n---\nOne")]);
    write(dir.path(), "AGENTS.md", "# Hand-written\n");
    let root = export_root(&vault).unwrap();
    let plan = export_plan(&vault, &root).unwrap();
    assert_eq!(plan.files[0].status, FileStatus::Foreign);

    let written = export_write(&vault, &root, &expected(&plan)).unwrap();
    assert_eq!(written, ["CLAUDE.md", "GEMINI.md"]);
    assert_eq!(
        fs::read_to_string(dir.path().join("AGENTS.md")).unwrap(),
        "# Hand-written\n"
    );
}

#[test]
fn export_skips_unreadable_docs() {
    let (_dir, vault) = repo_with_docs_vault(&[("a.md", "---\nagents: true\n---\nOne")]);
    write(vault.root(), "bad.md", b"---\nagents: true\n---\n\xff\xfe");
    let root = export_root(&vault).unwrap();
    let plan = export_plan(&vault, &root).unwrap();
    let docs: Vec<&str> = plan.docs.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(docs, ["a.md"]);
}

#[test]
fn nothing_marked_plans_no_files() {
    let (_dir, vault) = repo_with_docs_vault(&[("a.md", "# A")]);
    let root = export_root(&vault).unwrap();
    let plan = export_plan(&vault, &root).unwrap();
    assert!(plan.files.is_empty() && plan.docs.is_empty());
    assert_eq!(plan.tokens, 0);
}
