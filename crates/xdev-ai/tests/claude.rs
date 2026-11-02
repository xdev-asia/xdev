//! `status` and `quota` read `XDEV_CLAUDE_BIN`, `XDEV_CLAUDE_USAGE_URL` and
//! `PATH`, and the workspace forbids the `unsafe` that `set_var` needs, so
//! each case runs an ignored `child_*` test in a child process with its own
//! environment. The usage server stays in the parent so it can tell whether
//! a request arrived at all.

use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tempfile::TempDir;
use xdev_ai::{AccountEntry, AccountStatus, Provider, StatusState, quota, status};

const TOKEN: &str = "sk-ant-oat01-TEST-ONLY-not-a-real-token";

fn entry() -> AccountEntry {
    AccountEntry {
        name: "acct".into(),
        provider: Provider::Claude,
        dir: PathBuf::from(std::env::var_os("XDEV_TEST_ACCOUNT_DIR").expect("run by a parent")),
    }
}

#[test]
#[ignore = "run by a parent test in a child process"]
fn child_status() {
    let got = status(&entry());
    println!("RESULT:{}", serde_json::to_string(&got).unwrap());
}

#[test]
#[ignore = "run by a parent test in a child process"]
fn child_quota() {
    let state = match std::env::var("XDEV_TEST_STATE").as_deref() {
        Ok("logged_out") => StatusState::LoggedOut,
        Ok("no_claude") => StatusState::NoClaude,
        _ => StatusState::LoggedIn,
    };
    let account = AccountStatus {
        state,
        email: None,
        plan: None,
        org: None,
    };
    let got = quota(&entry(), &account, 30);
    println!("DEBUG:{got:?}");
    println!("RESULT:{}", serde_json::to_string(&got).unwrap());
}

/// Runs `test` in a child with only the given variables changed, and returns
/// its `RESULT:` JSON and everything it printed.
fn child(test: &str, envs: &[(&str, OsString)]) -> (Value, String) {
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.args([
        test,
        "--exact",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
    ]);
    for var in [
        "XDEV_CLAUDE_BIN",
        "XDEV_CLAUDE_USAGE_URL",
        "XDEV_TEST_STATE",
    ] {
        cmd.env_remove(var);
    }
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
        // The harness prints `test <name> ... ` first on the same line.
        .find_map(|l| l.split_once("RESULT:").map(|(_, json)| json))
        .unwrap_or_else(|| panic!("no result: {text}"));
    (serde_json::from_str(result).unwrap(), text)
}

/// A fake `claude` that prints `<CLAUDE_CONFIG_DIR>/status.json`, so a right
/// answer proves the variable reached it. Only shell builtins, because some
/// tests empty `PATH`.
fn fake_claude(dir: &Path, file_stem: &str) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    if cfg!(windows) {
        let path = dir.join(format!("{file_stem}.cmd"));
        fs::write(
            &path,
            "@echo off\r\ntype \"%CLAUDE_CONFIG_DIR%\\status.json\"\r\n",
        )
        .unwrap();
        path
    } else {
        let path = dir.join(file_stem);
        fs::write(
            &path,
            "#!/bin/sh\nwhile IFS= read -r l || [ -n \"$l\" ]; do printf '%s\\n' \"$l\"; done < \"$CLAUDE_CONFIG_DIR/status.json\"\n",
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

fn account(tmp: &TempDir, status_json: Option<&str>) -> PathBuf {
    let dir = tmp.path().join("acct");
    fs::create_dir_all(&dir).unwrap();
    if let Some(text) = status_json {
        fs::write(dir.join("status.json"), text).unwrap();
    }
    dir
}

const LOGGED_IN: &str = r#"{"loggedIn":true,"email":"dir-ok@example.com","subscriptionType":"max","orgName":"Acme","authMethod":"claude.ai"}"#;

#[test]
fn status_through_fake_claude() {
    let tmp = TempDir::new().unwrap();
    let fake = fake_claude(&tmp.path().join("bin"), "fake-claude");
    let dir = account(&tmp, Some(LOGGED_IN));
    let (got, _) = child(
        "child_status",
        &[
            ("XDEV_CLAUDE_BIN", fake.into()),
            ("XDEV_TEST_ACCOUNT_DIR", dir.into()),
        ],
    );
    assert_eq!(
        got,
        json!({ "state": "logged_in", "email": "dir-ok@example.com", "plan": "max", "org": "Acme" })
    );
}

#[test]
fn status_logged_out_and_garbage() {
    let tmp = TempDir::new().unwrap();
    let fake = fake_claude(&tmp.path().join("bin"), "fake-claude");
    let dir = account(&tmp, Some(r#"{"loggedIn":false}"#));
    let envs = [
        ("XDEV_CLAUDE_BIN", fake.clone().into()),
        ("XDEV_TEST_ACCOUNT_DIR", dir.clone().into()),
    ];
    let (got, _) = child("child_status", &envs);
    assert_eq!(
        got,
        json!({ "state": "logged_out", "email": null, "plan": null, "org": null })
    );

    fs::remove_file(dir.join("status.json")).unwrap();
    let (got, _) = child("child_status", &envs);
    assert_eq!(got["state"], "error");
}

#[test]
fn status_without_claude() {
    let tmp = TempDir::new().unwrap();
    let dir = account(&tmp, Some(LOGGED_IN));
    let (got, _) = child(
        "child_status",
        &[
            ("XDEV_CLAUDE_BIN", tmp.path().join("missing").into()),
            ("XDEV_TEST_ACCOUNT_DIR", dir.clone().into()),
        ],
    );
    assert_eq!(got["state"], "no_claude");

    let empty = tmp.path().join("empty");
    fs::create_dir(&empty).unwrap();
    let (got, _) = child(
        "child_status",
        &[
            ("PATH", empty.into()),
            ("XDEV_TEST_ACCOUNT_DIR", dir.into()),
        ],
    );
    assert_eq!(got["state"], "no_claude");
}

/// npm on Windows installs only `claude.cmd` (plus a shell script named
/// `claude` that Windows cannot run); elsewhere it is `claude`.
#[test]
fn status_finds_claude_on_path() {
    let tmp = TempDir::new().unwrap();
    let bin = tmp.path().join("bin");
    fake_claude(&bin, "claude");
    if cfg!(windows) {
        fs::write(bin.join("claude"), "#!/bin/sh\nexit 3\n").unwrap();
    }
    let dir = account(&tmp, Some(LOGGED_IN));
    let (got, _) = child(
        "child_status",
        &[("PATH", bin.into()), ("XDEV_TEST_ACCOUNT_DIR", dir.into())],
    );
    assert_eq!(got["state"], "logged_in");
}

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<String>>>,
}

/// Answers every request with `status` and `body`, and keeps each request's
/// head.
fn serve(status: u16, body: &'static str) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://127.0.0.1:{}/api/oauth/usage",
        listener.local_addr().unwrap().port()
    );
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut head = Vec::new();
            let mut buf = [0u8; 1024];
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => head.extend_from_slice(&buf[..n]),
                }
            }
            seen.lock()
                .unwrap()
                .push(String::from_utf8_lossy(&head).into_owned());
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    Server { url, requests }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn credentials(dir: &Path, expires_at: i64) {
    let text = json!({ "claudeAiOauth": { "accessToken": TOKEN, "expiresAt": expires_at } });
    fs::write(dir.join(".credentials.json"), text.to_string()).unwrap();
}

fn quota_child(server: &Server, dir: &Path, state: &str) -> Value {
    let (got, text) = child(
        "child_quota",
        &[
            ("XDEV_CLAUDE_USAGE_URL", server.url.clone().into()),
            ("XDEV_TEST_ACCOUNT_DIR", dir.into()),
            ("XDEV_TEST_STATE", state.into()),
        ],
    );
    assert!(text.contains("DEBUG:Quota"), "{text}");
    assert!(!text.contains(TOKEN), "token printed: {text}");
    assert!(!text.contains("TEST-ONLY"), "token printed: {text}");
    got
}

const USAGE: &str = r#"{
  "seven_day_opus": {"utilization": null, "resets_at": null},
  "extra_usage": {"is_enabled": false},
  "seven_day": {"utilization": 40.5, "resets_at": "2026-11-08T00:00:00Z"},
  "a_window": {"utilization": 3, "resets_at": null},
  "seven_day_sonnet": null,
  "five_hour": {"utilization": 12.0, "resets_at": "2026-11-02T10:00:00Z"}
}"#;

#[test]
fn usage_ok_orders_windows_and_keeps_nulls() {
    let tmp = TempDir::new().unwrap();
    let dir = account(&tmp, None);
    credentials(&dir, now_ms() + 3_600_000);
    let server = serve(200, USAGE);
    let got = quota_child(&server, &dir, "logged_in");
    assert_eq!(
        got,
        json!({
            "name": "acct", "state": "ok", "reason": null, "asOf": null,
            "windows": [
                { "key": "five_hour", "utilization": 12.0, "resetsAt": "2026-11-02T10:00:00Z" },
                { "key": "seven_day", "utilization": 40.5, "resetsAt": "2026-11-08T00:00:00Z" },
                { "key": "a_window", "utilization": 3.0, "resetsAt": null },
                { "key": "seven_day_opus", "utilization": null, "resetsAt": null },
            ]
        })
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let head = requests[0].to_ascii_lowercase();
    assert!(head.starts_with("get /api/oauth/usage "), "{head}");
    assert!(
        head.contains(&format!(
            "authorization: bearer {}",
            TOKEN.to_ascii_lowercase()
        )),
        "{head}"
    );
    assert!(head.contains("anthropic-beta: oauth-2025-04-20"), "{head}");
}

#[test]
fn usage_401_is_expired() {
    let tmp = TempDir::new().unwrap();
    let dir = account(&tmp, None);
    credentials(&dir, now_ms() + 3_600_000);
    // A server that echoes the token must not get it into any output.
    let server = serve(
        401,
        r#"{"error":"bad sk-ant-oat01-TEST-ONLY-not-a-real-token"}"#,
    );
    let got = quota_child(&server, &dir, "logged_in");
    assert_eq!(got["state"], "unknown");
    assert_eq!(got["reason"], "expired");
    assert_eq!(got["windows"], json!([]));
}

#[test]
fn usage_500_is_unavailable() {
    let tmp = TempDir::new().unwrap();
    let dir = account(&tmp, None);
    credentials(&dir, now_ms() + 3_600_000);
    let server = serve(500, "oops");
    let got = quota_child(&server, &dir, "logged_in");
    assert_eq!(got["state"], "unknown");
    assert_eq!(got["reason"], "unavailable");
}

#[test]
fn usage_bad_json_is_unavailable() {
    let tmp = TempDir::new().unwrap();
    let dir = account(&tmp, None);
    credentials(&dir, now_ms() + 3_600_000);
    let server = serve(200, "{not json");
    let got = quota_child(&server, &dir, "logged_in");
    assert_eq!(got["reason"], "unavailable");
}

#[test]
fn expired_token_makes_no_request() {
    let tmp = TempDir::new().unwrap();
    let dir = account(&tmp, None);
    credentials(&dir, now_ms() - 1);
    let server = serve(200, USAGE);
    let got = quota_child(&server, &dir, "logged_in");
    assert_eq!(got["state"], "unknown");
    assert_eq!(got["reason"], "expired");
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]
fn missing_credentials() {
    let tmp = TempDir::new().unwrap();
    let dir = account(&tmp, None);
    let server = serve(200, USAGE);
    let got = quota_child(&server, &dir, "logged_in");
    assert_eq!(got["reason"], "no_credentials");

    // A file without a token is the same.
    fs::write(dir.join(".credentials.json"), r#"{"claudeAiOauth":{}}"#).unwrap();
    let got = quota_child(&server, &dir, "logged_in");
    assert_eq!(got["reason"], "no_credentials");
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]
fn signed_out_or_no_claude_makes_no_request() {
    let tmp = TempDir::new().unwrap();
    let dir = account(&tmp, None);
    credentials(&dir, now_ms() + 3_600_000);
    let server = serve(200, USAGE);
    let got = quota_child(&server, &dir, "logged_out");
    assert_eq!(got["reason"], "logged_out");
    let got = quota_child(&server, &dir, "no_claude");
    assert_eq!(got["reason"], "no_claude");
    assert!(server.requests.lock().unwrap().is_empty());
}
