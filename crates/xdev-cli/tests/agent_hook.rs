use std::path::Path;
use std::process::{Command, Output};

const ID: &str = "0b3c9a52-6f1e-4d7a-9c1b-2e4f6a8b0c1d";

fn hook(local: &Path, pty_id: Option<&str>, args: &[&str]) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_xdev"));
    cmd.arg("agent-hook")
        .args(args)
        .env("XDEV_LOCAL_DIR", local)
        .env("XDEV_DATA_DIR", local.join("data"))
        .env_remove("XDEV_PTY_ID");
    if let Some(id) = pty_id {
        cmd.env("XDEV_PTY_ID", id);
    }
    cmd.output().expect("run xdev")
}

/// Every file under `dir`, as paths relative to it.
fn files(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let rel = path.strip_prefix(dir).unwrap();
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out
}

#[test]
fn hook_writes_line_and_ignores_extra_args() {
    let tmp = tempfile::tempdir().unwrap();
    let out = hook(
        tmp.path(),
        Some(ID),
        &[
            "turn-done",
            r#"{"type":"agent-turn-complete","x":"--flag"}"#,
        ],
    );
    assert!(out.status.success(), "{out:?}");
    assert!(out.stdout.is_empty());
    let text =
        std::fs::read_to_string(tmp.path().join("hooks").join(format!("{ID}.jsonl"))).unwrap();
    let lines: Vec<serde_json::Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["v"], 1);
    assert_eq!(lines[0]["event"], "turn-done");
    assert!(lines[0]["at"].as_i64().unwrap() > 0);
}

#[test]
fn hook_takes_every_event_and_hyphen_args() {
    let tmp = tempfile::tempdir().unwrap();
    for event in ["prompt", "needs-input", "turn-done"] {
        let out = hook(tmp.path(), Some(ID), &[event, "--weird", "-x"]);
        assert!(out.status.success(), "{out:?}");
        assert!(out.stdout.is_empty());
    }
    let text =
        std::fs::read_to_string(tmp.path().join("hooks").join(format!("{ID}.jsonl"))).unwrap();
    assert_eq!(text.lines().count(), 3);
}

#[test]
fn hook_refuses_bad_pty_id_and_exits_zero() {
    let tmp = tempfile::tempdir().unwrap();
    let local = tmp.path().join("a").join("b");
    std::fs::create_dir_all(&local).unwrap();
    for id in [Some("../../x"), Some(""), Some(r"a\b"), None] {
        let out = hook(&local, id, &["prompt"]);
        assert!(out.status.success(), "{id:?}: {out:?}");
        assert!(out.stdout.is_empty(), "{id:?}");
        assert!(!out.stderr.is_empty(), "{id:?}");
    }
    assert_eq!(files(tmp.path()), Vec::<String>::new());
}

#[test]
fn hook_with_unknown_event_exits_zero() {
    let tmp = tempfile::tempdir().unwrap();
    let out = hook(tmp.path(), Some(ID), &["bogus"]);
    assert!(out.status.success(), "{out:?}");
    assert!(out.stdout.is_empty());
    assert!(!out.stderr.is_empty());
    assert_eq!(files(tmp.path()), Vec::<String>::new());
}
