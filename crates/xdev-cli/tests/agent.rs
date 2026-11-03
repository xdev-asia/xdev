use std::path::Path;
use std::process::{Command, Output, Stdio};

const ID: &str = "0b3c9a52-6f1e-4d7a-9c1b-2e4f6a8b0c1d";

/// Runs `xdev <args>` with every folder inside `root`.
fn xdev(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_xdev"))
        .args(args)
        .env("XDEV_DATA_DIR", root.join("data"))
        .env("XDEV_LOCAL_DIR", root.join("local"))
        .env("XDEV_PTY_ID", ID)
        .stdin(Stdio::null())
        .output()
        .expect("run xdev")
}

fn hooks_json(root: &Path, action: &str) -> serde_json::Value {
    let out = xdev(root, &["agent", "hooks", action, "--json"]);
    assert!(out.status.success(), "{out:?}");
    serde_json::from_slice(&out.stdout).unwrap()
}

fn settings(root: &Path) -> serde_json::Value {
    let text = std::fs::read_to_string(root.join("data").join("settings.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn marker(root: &Path) -> std::path::PathBuf {
    root.join("local").join("hooks").join(".off")
}

#[test]
fn hooks_status_defaults_to_on_and_writes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let got = hooks_json(tmp.path(), "status");
    assert_eq!(
        got,
        serde_json::json!({ "on": true, "setting": true, "marker": false })
    );
    assert!(!tmp.path().join("data").exists());
    assert!(!tmp.path().join("local").join("hooks").exists());
}

#[test]
fn hooks_off_and_on_set_the_setting_and_the_marker() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let before = serde_json::json!({
        "last_vault": "D:/docs",
        "status": { "os": false, "volume": 7 },
        "future": [1, 2]
    });
    std::fs::write(data.join("settings.json"), before.to_string()).unwrap();

    let off = hooks_json(tmp.path(), "off");
    assert_eq!(
        off,
        serde_json::json!({ "on": false, "setting": false, "marker": true })
    );
    assert!(marker(tmp.path()).is_file());
    let mut want = before.clone();
    want["status"]["hooks"] = false.into();
    assert_eq!(settings(tmp.path()), want);

    let on = hooks_json(tmp.path(), "on");
    assert_eq!(
        on,
        serde_json::json!({ "on": true, "setting": true, "marker": false })
    );
    assert!(!marker(tmp.path()).exists());
    want["status"]["hooks"] = true.into();
    assert_eq!(settings(tmp.path()), want);
}

#[test]
fn hooks_status_prints_tab_lines() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(marker(tmp.path()).parent().unwrap()).unwrap();
    std::fs::write(marker(tmp.path()), b"").unwrap();
    let out = xdev(tmp.path(), &["agent", "hooks", "status"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        String::from_utf8(out.stdout).unwrap().replace("\r\n", "\n"),
        "on\toff\nsetting\ton\nmarker\ton\n"
    );
}

#[test]
fn hooks_off_refuses_a_settings_file_it_cannot_read() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("settings.json"), "{ not json").unwrap();
    let out = xdev(tmp.path(), &["agent", "hooks", "on"]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert!(String::from_utf8_lossy(&out.stderr).contains("bad_settings"));
    assert_eq!(
        std::fs::read_to_string(data.join("settings.json")).unwrap(),
        "{ not json"
    );
}

#[test]
fn agent_hook_is_a_silent_no_op_while_the_marker_is_there() {
    let tmp = tempfile::tempdir().unwrap();
    hooks_json(tmp.path(), "off");
    let out = xdev(tmp.path(), &["agent-hook", "turn-done"]);
    assert!(
        out.status.success() && out.stdout.is_empty() && out.stderr.is_empty(),
        "{out:?}"
    );
    let file = tmp
        .path()
        .join("local")
        .join("hooks")
        .join(format!("{ID}.jsonl"));
    assert!(!file.exists());

    hooks_json(tmp.path(), "on");
    let out = xdev(tmp.path(), &["agent-hook", "turn-done"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(std::fs::read_to_string(&file).unwrap().lines().count(), 1);
}
