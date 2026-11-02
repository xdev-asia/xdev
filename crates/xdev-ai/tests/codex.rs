//! Codex accounts. `status` reads `XDEV_CODEX_BIN` and `PATH`, so those
//! cases run an ignored `child_*` test in a child process with its own
//! environment (the workspace forbids the `unsafe` `set_var` needs). Quota
//! only reads files, so it runs in-process.

use std::ffi::OsString;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tempfile::TempDir;
use xdev_ai::{AccountEntry, AccountStatus, Provider, StatusState, quota, status};

const FIXTURE: &str = include_str!("fixtures/codex-rollout.jsonl");

fn entry(dir: PathBuf) -> AccountEntry {
    AccountEntry {
        name: "cx".into(),
        provider: Provider::Codex,
        dir,
    }
}

fn signed_in() -> AccountStatus {
    AccountStatus {
        state: StatusState::LoggedIn,
        email: None,
        plan: None,
        org: None,
    }
}

#[test]
#[ignore = "run by a parent test in a child process"]
fn child_codex_status() {
    let dir = PathBuf::from(std::env::var_os("XDEV_TEST_ACCOUNT_DIR").expect("run by a parent"));
    let got = status(&entry(dir));
    println!("RESULT:{}", serde_json::to_string(&got).unwrap());
}

fn child(envs: &[(&str, OsString)]) -> Value {
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.args([
        "child_codex_status",
        "--exact",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
    ]);
    cmd.env_remove("XDEV_CODEX_BIN");
    cmd.envs(envs.iter().map(|(k, v)| (k, v)));
    let out = cmd.output().unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.status.success(), "{text}");
    let result = text
        .lines()
        .find_map(|l| l.split_once("RESULT:").map(|(_, json)| json))
        .unwrap_or_else(|| panic!("no result: {text}"));
    serde_json::from_str(result).unwrap()
}

/// A fake `codex` that exits 0 for `login status` only when
/// `<CODEX_HOME>/signed-in` exists, so a right answer proves the variable
/// reached it. Only shell builtins, because a test empties `PATH`.
fn fake_codex(dir: &Path, file_stem: &str) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    if cfg!(windows) {
        let path = dir.join(format!("{file_stem}.cmd"));
        fs::write(
            &path,
            "@echo off\r\nif not \"%1 %2\"==\"login status\" exit /b 2\r\nif exist \"%CODEX_HOME%\\signed-in\" exit /b 0\r\necho Not logged in 1>&2\r\nexit /b 1\r\n",
        )
        .unwrap();
        path
    } else {
        let path = dir.join(file_stem);
        fs::write(
            &path,
            "#!/bin/sh\n[ \"$1 $2\" = \"login status\" ] || exit 2\n[ -f \"$CODEX_HOME/signed-in\" ] && exit 0\necho 'Not logged in' >&2\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }
}

#[test]
fn status_through_fake_codex() {
    let tmp = TempDir::new().unwrap();
    let bin = fake_codex(&tmp.path().join("bin"), "fake-codex");
    let dir = tmp.path().join("home");
    fs::create_dir_all(&dir).unwrap();
    let envs = [
        ("XDEV_CODEX_BIN", bin.into_os_string()),
        ("XDEV_TEST_ACCOUNT_DIR", dir.clone().into_os_string()),
    ];
    assert_eq!(
        child(&envs),
        json!({ "state": "logged_out", "email": null, "plan": null, "org": null })
    );
    fs::write(dir.join("signed-in"), "").unwrap();
    assert_eq!(
        child(&envs),
        json!({ "state": "logged_in", "email": null, "plan": null, "org": null })
    );
}

#[test]
fn status_without_codex() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("home");
    fs::create_dir_all(&dir).unwrap();
    let got = child(&[
        ("XDEV_CODEX_BIN", tmp.path().join("missing").into()),
        ("XDEV_TEST_ACCOUNT_DIR", dir.clone().into()),
    ]);
    assert_eq!(got["state"], "no_codex");

    let empty = tmp.path().join("empty");
    fs::create_dir(&empty).unwrap();
    let got = child(&[
        ("PATH", empty.into()),
        ("XDEV_TEST_ACCOUNT_DIR", dir.into()),
    ]);
    assert_eq!(got["state"], "no_codex");
}

/// npm on Windows installs `codex.cmd`; elsewhere it is `codex`.
#[test]
fn status_finds_codex_on_path() {
    let tmp = TempDir::new().unwrap();
    let bin = tmp.path().join("bin");
    fake_codex(&bin, "codex");
    let dir = tmp.path().join("home");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("signed-in"), "").unwrap();
    let got = child(&[("PATH", bin.into()), ("XDEV_TEST_ACCOUNT_DIR", dir.into())]);
    assert_eq!(got["state"], "logged_in");
}

fn session(home: &Path, rel: &str, text: &str, modified: SystemTime) -> PathBuf {
    let path = home.join("sessions").join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    path
}

fn ago(secs: u64) -> SystemTime {
    SystemTime::now() - Duration::from_secs(secs)
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn token_count(timestamp: &str, limits: Value) -> String {
    json!({
        "timestamp": timestamp,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": { "last_token_usage": { "input_tokens": 1 }, "model_context_window": 1000 },
            "rate_limits": limits,
        }
    })
    .to_string()
}

#[test]
fn quota_reads_last_rate_limits_of_newest_session() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();
    session(home, "2026/11/02/rollout-new.jsonl", FIXTURE, ago(60));
    let older = token_count(
        "2026-11-01T00:00:00Z",
        json!({ "primary": { "used_percent": 99.0, "window_minutes": 300, "resets_at": 4_102_444_800_i64 } }),
    );
    session(home, "2026/11/01/rollout-old.jsonl", &older, ago(86_400));

    let got = quota(&entry(home.to_path_buf()), &signed_in(), 30);
    assert_eq!(
        serde_json::to_value(&got).unwrap(),
        json!({
            "name": "cx", "state": "ok", "reason": null,
            "asOf": "2026-11-02T08:01:30.123Z",
            "windows": [
                { "key": "five_hour", "utilization": 37.0, "resetsAt": "2100-01-01T00:00:00Z" },
                { "key": "seven_day", "utilization": 12.5, "resetsAt": "2100-01-01T01:00:00Z" },
            ]
        })
    );
}

#[test]
fn quota_keeps_unknown_window_lengths_and_rolls_over_past_resets() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();
    let line = token_count(
        "2026-11-02T09:00:00Z",
        json!({
            "primary": { "used_percent": 95.0, "window_minutes": 60, "resets_at": unix_now() - 10 },
            "secondary": { "used_percent": 75.0, "window_minutes": 1440, "resets_at": 4_102_444_800_i64 },
        }),
    );
    session(home, "2026/11/02/rollout-a.jsonl", &line, ago(5));

    let got = quota(&entry(home.to_path_buf()), &signed_in(), 30);
    assert_eq!(
        serde_json::to_value(&got).unwrap(),
        json!({
            "name": "cx", "state": "reserve", "reason": null,
            "asOf": "2026-11-02T09:00:00Z",
            "windows": [
                { "key": "primary", "utilization": 0.0, "resetsAt": null },
                { "key": "secondary", "utilization": 75.0, "resetsAt": "2100-01-01T00:00:00Z" },
            ]
        })
    );
}

#[test]
fn quota_skips_sessions_without_limits_and_falls_back_to_mtime() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path();
    let no_limits = token_count("2026-11-02T10:00:00Z", Value::Null);
    session(home, "2026/11/02/rollout-new.jsonl", &no_limits, ago(10));
    let mut line: Value = serde_json::from_str(&token_count(
        "x",
        json!({ "primary": { "used_percent": 100.0, "window_minutes": 300, "resets_at": 4_102_444_800_i64 } }),
    ))
    .unwrap();
    line.as_object_mut().unwrap().remove("timestamp");
    let modified = UNIX_EPOCH + Duration::from_secs(1_793_600_000);
    session(
        home,
        "2026/11/01/rollout-old.jsonl",
        &line.to_string(),
        modified,
    );

    let got = quota(&entry(home.to_path_buf()), &signed_in(), 30);
    assert_eq!(got.state, xdev_ai::QuotaState::Full);
    assert_eq!(got.as_of.as_deref(), Some("2026-11-02T06:13:20Z"));
}

#[test]
fn quota_without_sessions_is_unknown() {
    let tmp = TempDir::new().unwrap();
    let got = quota(&entry(tmp.path().to_path_buf()), &signed_in(), 30);
    assert_eq!(
        serde_json::to_value(&got).unwrap(),
        json!({ "name": "cx", "state": "unknown", "reason": "no_sessions", "asOf": null, "windows": [] })
    );

    let no_codex = AccountStatus {
        state: StatusState::NoCodex,
        ..signed_in()
    };
    session(tmp.path(), "a.jsonl", FIXTURE, ago(1));
    let got = quota(&entry(tmp.path().to_path_buf()), &no_codex, 30);
    assert_eq!(got.reason, Some(xdev_ai::Reason::NoCodex));
}
