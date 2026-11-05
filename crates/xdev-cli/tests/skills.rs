use std::path::Path;
use std::process::{Command, Output, Stdio};

/// Runs `xdev skills <args>` with every folder inside `root`, so no real
/// agent home is read or written.
fn skills(root: &Path, args: &[&str]) -> Output {
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    Command::new(env!("CARGO_BIN_EXE_xdev"))
        .arg("skills")
        .args(args)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("XDEV_DATA_DIR", root.join("data"))
        .env("XDEV_LOCAL_DIR", root.join("local"))
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("CODEX_HOME")
        .current_dir(root)
        .stdin(Stdio::null())
        .output()
        .expect("run xdev")
}

fn text(out: &[u8]) -> String {
    String::from_utf8_lossy(out).into_owned()
}

#[test]
fn show_is_get() {
    let dir = tempfile::tempdir().unwrap();
    let get = skills(dir.path(), &["get", "cli"]);
    let show = skills(dir.path(), &["show", "cli"]);
    assert!(get.status.success() && show.status.success());
    assert_eq!(get.stdout, show.stdout);
    assert!(text(&get.stdout).starts_with("# xDev CLI"));
}

#[test]
fn unknown_topic_exits_5() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(skills(dir.path(), &["get", "nope"]).status.code(), Some(5));
    let r = skills(dir.path(), &["get", "cli", "--reference", "nope"]);
    assert_eq!(r.status.code(), Some(5));
}

#[test]
fn reference_and_full_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let out = skills(
        dir.path(),
        &["get", "cli", "--reference", "worktrees", "--full"],
    );
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn list_prints_a_line_per_guide_and_json() {
    let dir = tempfile::tempdir().unwrap();
    let out = skills(dir.path(), &["list"]);
    assert!(out.status.success());
    assert_eq!(text(&out.stdout).lines().count(), 2);
    let out = skills(dir.path(), &["list", "--json"]);
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["topics"][0]["name"], "orchestration");
}

#[test]
fn full_and_json_work_from_the_binary() {
    let dir = tempfile::tempdir().unwrap();
    let out = skills(dir.path(), &["get", "cli", "--full"]);
    assert!(text(&out.stdout).contains("# Exit codes"));
    let out = skills(
        dir.path(),
        &[
            "get",
            "cli",
            "--reference",
            "references/terminals.md",
            "--json",
        ],
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["topic"], "cli");
    assert!(v["content"].as_str().unwrap().starts_with("# Terminals"));
}

fn skill_file(root: &Path, name: &str) -> std::path::PathBuf {
    root.join("home/.agents/skills").join(name).join("SKILL.md")
}

#[test]
fn install_writes_both_skills_under_a_temp_home() {
    let dir = tempfile::tempdir().unwrap();
    let out = skills(dir.path(), &["install"]);
    assert!(out.status.success(), "{out:?}");
    assert!(skill_file(dir.path(), "xdev-cli").is_file());
    assert!(skill_file(dir.path(), "xdev-orchestration").is_file());
    let lines = text(&out.stdout);
    assert!(lines.lines().all(|l| l.split('\t').count() == 5), "{lines}");
}

#[test]
fn install_skill_narrows_it() {
    let dir = tempfile::tempdir().unwrap();
    let out = skills(dir.path(), &["install", "--skill", "cli"]);
    assert!(out.status.success());
    assert!(skill_file(dir.path(), "xdev-cli").is_file());
    assert!(!skill_file(dir.path(), "xdev-orchestration").exists());
}

#[test]
fn install_unknown_skill_exits_5() {
    let dir = tempfile::tempdir().unwrap();
    let out = skills(dir.path(), &["install", "--skill", "nope"]);
    assert_eq!(out.status.code(), Some(5));
    assert!(!dir.path().join("home/.agents").exists());
}

#[test]
fn update_on_a_clean_home_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let out = skills(dir.path(), &["update"]);
    assert!(out.status.success());
    assert!(
        text(&out.stdout)
            .lines()
            .all(|l| l.starts_with("unchanged\t"))
    );
    assert!(!dir.path().join("home/.agents/skills").exists());
    // After an install, an update is also a no-op.
    skills(dir.path(), &["install"]);
    let out = skills(dir.path(), &["update", "--json"]);
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(
        v["targets"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["action"] == "unchanged")
    );
}

#[test]
fn update_dry_run_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    skills(dir.path(), &["install", "--skill", "cli"]);
    let file = skill_file(dir.path(), "xdev-cli");
    std::fs::write(&file, "mine").unwrap();
    let out = skills(dir.path(), &["update", "--force", "--dry-run"]);
    assert!(out.status.success());
    assert!(text(&out.stdout).contains("replaced\t"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
    assert!(!dir.path().join("home/.agents/.xdev-skill-backups").exists());
    // Without --dry-run the edit is replaced after a backup.
    let out = skills(dir.path(), &["update", "--force"]);
    assert!(out.status.success());
    assert_ne!(std::fs::read_to_string(&file).unwrap(), "mine");
    assert!(dir.path().join("home/.agents/.xdev-skill-backups").is_dir());
    assert!(!skill_file(dir.path(), "xdev-orchestration").exists());
}
