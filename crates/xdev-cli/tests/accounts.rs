use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tempfile::TempDir;

struct Env {
    tmp: TempDir,
    claude: PathBuf,
    codex: PathBuf,
    usage_url: String,
}

impl Env {
    /// No usage server unless a test starts one; port 9 refuses, so nothing
    /// can reach the real service.
    fn new() -> Env {
        let tmp = TempDir::new().unwrap();
        let claude = fake_claude(&tmp.path().join("bin"));
        let codex = fake_codex(&tmp.path().join("bin"));
        Env {
            tmp,
            claude,
            codex,
            usage_url: "http://127.0.0.1:9/api/oauth/usage".into(),
        }
    }

    fn data(&self) -> PathBuf {
        self.tmp.path().join("data")
    }

    fn xdev(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_xdev"))
            .env("XDEV_DATA_DIR", self.data())
            .env("XDEV_CLAUDE_BIN", &self.claude)
            .env("XDEV_CODEX_BIN", &self.codex)
            .env("XDEV_CLAUDE_USAGE_URL", &self.usage_url)
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("CODEX_HOME")
            .args(args)
            .output()
            .expect("run xdev")
    }

    /// An account folder that is already signed in.
    fn signed_in(&self, name: &str) -> PathBuf {
        let dir = self.tmp.path().join(format!("{name} dir"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("status.json"), LOGGED_IN).unwrap();
        dir
    }
}

const LOGGED_IN: &str =
    r#"{"loggedIn":true,"email":"me@example.com","subscriptionType":"max","orgName":"Acme"}"#;

/// A fake `claude`: `auth login` signs the folder in, `auth status` prints
/// what the folder holds.
fn fake_claude(dir: &Path) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    let login = r#"{"loggedIn":true,"email":"new@example.com","subscriptionType":"pro"}"#;
    if cfg!(windows) {
        let path = dir.join("claude.cmd");
        let script = format!(
            "@echo off\r\nif \"%2\"==\"login\" goto login\r\ntype \"%CLAUDE_CONFIG_DIR%\\status.json\"\r\nexit /b 0\r\n:login\r\necho {login}> \"%CLAUDE_CONFIG_DIR%\\status.json\"\r\nexit /b 0\r\n"
        );
        fs::write(&path, script).unwrap();
        path
    } else {
        let path = dir.join("claude");
        let script = format!(
            "#!/bin/sh\nif [ \"$2\" = login ]; then printf '%s\\n' '{login}' > \"$CLAUDE_CONFIG_DIR/status.json\"; exit 0; fi\nwhile IFS= read -r l || [ -n \"$l\" ]; do printf '%s\\n' \"$l\"; done < \"$CLAUDE_CONFIG_DIR/status.json\"\n"
        );
        fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }
}

/// A fake `codex`: `login` signs the folder in by making a `signed-in`
/// file, `login status` exits 0 only when it is there.
fn fake_codex(dir: &Path) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    if cfg!(windows) {
        let path = dir.join("codex.cmd");
        let script = "@echo off\r\nif \"%2\"==\"status\" goto status\r\necho.> \"%CODEX_HOME%\\signed-in\"\r\nexit /b 0\r\n:status\r\nif exist \"%CODEX_HOME%\\signed-in\" exit /b 0\r\nexit /b 1\r\n";
        fs::write(&path, script).unwrap();
        path
    } else {
        let path = dir.join("codex");
        let script = "#!/bin/sh\nif [ \"$2\" = status ]; then [ -f \"$CODEX_HOME/signed-in\" ]; exit $?; fi\n: > \"$CODEX_HOME/signed-in\"\n";
        fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }
}

/// One Codex session file whose last `token_count` event carries limits.
fn codex_session(home: &Path, five_hour: f64, resets_at: u64) {
    let dir = home.join("sessions").join("2026").join("11").join("02");
    fs::create_dir_all(&dir).unwrap();
    let line = format!(
        r#"{{"timestamp":"2026-11-02T08:01:30.000Z","type":"event_msg","payload":{{"type":"token_count","info":null,"rate_limits":{{"primary":{{"used_percent":{five_hour},"window_minutes":300,"resets_at":{resets_at}}},"secondary":{{"used_percent":20.0,"window_minutes":10080,"resets_at":{resets_at}}},"plan_type":"plus"}}}}}}"#
    );
    fs::write(
        dir.join("rollout-2026-11-02T08-00-00-t1.jsonl"),
        line + "\n",
    )
    .unwrap();
}

fn stdout(out: &Output) -> String {
    String::from_utf8(out.stdout.clone()).unwrap()
}

fn stderr(out: &Output) -> String {
    String::from_utf8(out.stderr.clone()).unwrap()
}

#[test]
fn add_dir_then_list() {
    let env = Env::new();
    let dir = env.signed_in("a");
    let out = env.xdev(&[
        "accounts",
        "add",
        "claude-3",
        "--dir",
        dir.to_str().unwrap(),
    ]);
    assert!(out.status.success(), "{out:?}");

    let out = env.xdev(&["accounts", "list"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        stdout(&out),
        "claude-3\tclaude\tlogged_in\tme@example.com\tmax\n"
    );
    // `--dir` registers only; the folder is not touched.
    assert!(!env.data().join("accounts").exists());
}

#[test]
fn list_marks_signed_out_and_empty_fields() {
    let env = Env::new();
    let dir = env.tmp.path().join("out");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("status.json"), r#"{"loggedIn":false}"#).unwrap();
    env.xdev(&["accounts", "add", "b", "--dir", dir.to_str().unwrap()]);
    let out = env.xdev(&["accounts", "list"]);
    assert_eq!(stdout(&out), "b\tclaude\tlogged_out\t-\t-\n");
}

#[test]
fn add_without_dir_creates_folder_and_logs_in() {
    let env = Env::new();
    let out = env.xdev(&["accounts", "add", "fresh"]);
    assert!(out.status.success(), "{out:?}");
    let dir = env.data().join("accounts").join("fresh");
    assert!(
        dir.join("status.json").is_file(),
        "login did not run in {dir:?}"
    );

    let out = env.xdev(&["accounts", "list"]);
    assert_eq!(
        stdout(&out),
        "fresh\tclaude\tlogged_in\tnew@example.com\tpro\n"
    );
}

#[test]
fn add_twice_and_bad_name() {
    let env = Env::new();
    let dir = env.signed_in("a");
    let dir = dir.to_str().unwrap();
    assert!(
        env.xdev(&["accounts", "add", "a", "--dir", dir])
            .status
            .success()
    );
    let out = env.xdev(&["accounts", "add", "a", "--dir", dir]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(stderr(&out), "error: exists\n");

    let out = env.xdev(&["accounts", "add", "A b"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(stderr(&out), "error: bad_name\n");
    assert!(!env.data().join("accounts").exists());
}

#[test]
fn remove_keeps_folder() {
    let env = Env::new();
    let dir = env.signed_in("a");
    env.xdev(&["accounts", "add", "a", "--dir", dir.to_str().unwrap()]);
    let out = env.xdev(&["accounts", "remove", "a"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        stdout(&out),
        format!("removed a (folder kept: {})\n", dir.display())
    );
    assert!(dir.join("status.json").is_file());
    assert_eq!(stdout(&env.xdev(&["accounts", "list"])), "");

    let out = env.xdev(&["accounts", "remove", "a"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(stderr(&out), "error: not_found\n");
}

#[test]
fn reserve_range() {
    let env = Env::new();
    let out = env.xdev(&["accounts", "reserve", "95"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(stderr(&out), "error: bad_reserve\n");
    let out = env.xdev(&["accounts", "reserve", "300"]);
    assert_eq!(stderr(&out), "error: bad_reserve\n");

    assert!(env.xdev(&["accounts", "reserve", "20"]).status.success());
    let text = fs::read_to_string(env.data().join("accounts.json")).unwrap();
    let json: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(json["reserve_percent"], 20);
}

#[test]
fn bad_registry_is_reported_and_kept() {
    let env = Env::new();
    fs::create_dir_all(env.data()).unwrap();
    let path = env.data().join("accounts.json");
    fs::write(&path, r#"{"version":2}"#).unwrap();
    let out = env.xdev(&["accounts", "reserve", "10"]);
    assert_eq!(stderr(&out), "error: bad_registry\n");
    assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"version":2}"#);
}

#[test]
fn quota_json_and_pick_without_usable_account() {
    let env = Env::new();
    let dir = env.signed_in("a");
    env.xdev(&["accounts", "add", "a", "--dir", dir.to_str().unwrap()]);

    let out = env.xdev(&["quota", "--json"]);
    assert!(out.status.success(), "{out:?}");
    let json: Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!(
        json,
        serde_json::json!([
            {
                "name": "a", "state": "unknown", "reason": "no_credentials",
                "windows": [], "asOf": null,
            }
        ])
    );

    let out = env.xdev(&["quota"]);
    assert_eq!(stdout(&out), "a\tclaude\tunknown\tno_credentials\n");

    let out = env.xdev(&["accounts", "pick"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(stdout(&out), "");
}

/// Serves `body` to every request, on a local port.
fn serve(body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://127.0.0.1:{}/api/oauth/usage",
        listener.local_addr().unwrap().port()
    );
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
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    url
}

#[test]
fn quota_text_and_pick() {
    let mut env = Env::new();
    env.usage_url = serve(
        r#"{"seven_day":{"utilization":40.5,"resets_at":null},"five_hour":{"utilization":12,"resets_at":null},"seven_day_opus":{"utilization":null,"resets_at":null}}"#,
    );
    let dir = env.signed_in("a");
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        + 3_600_000;
    fs::write(
        dir.join(".credentials.json"),
        format!(r#"{{"claudeAiOauth":{{"accessToken":"test-only","expiresAt":{expires}}}}}"#),
    )
    .unwrap();
    env.xdev(&["accounts", "add", "a", "--dir", dir.to_str().unwrap()]);

    let out = env.xdev(&["quota"]);
    assert_eq!(
        stdout(&out),
        "a\tclaude\tok\tfive_hour=12\tseven_day=40.5\tseven_day_opus=-\t-\n"
    );
    let out = env.xdev(&["accounts", "pick"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(stdout(&out), "a\n");

    // 40.5% is in a 60% reserve.
    env.xdev(&["accounts", "reserve", "60"]);
    let out = env.xdev(&["quota"]);
    assert!(stdout(&out).starts_with("a\tclaude\treserve\t"), "{out:?}");
    assert_eq!(env.xdev(&["accounts", "pick"]).status.code(), Some(1));
}

#[test]
fn add_without_claude_changes_nothing() {
    let mut env = Env::new();
    env.claude = env.tmp.path().join("missing");
    let out = env.xdev(&["accounts", "add", "a"]);
    assert_eq!(stderr(&out), "error: no_claude\n");
    assert!(!env.data().join("accounts").exists());
    assert!(!env.data().join("accounts.json").exists());

    let out = env.xdev(&["accounts", "list"]);
    assert!(out.status.success());
    assert_eq!(stdout(&out), "");
}

#[test]
fn login_unknown_account() {
    let env = Env::new();
    let out = env.xdev(&["accounts", "login", "nope"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(stderr(&out), "error: not_found\n");
}

#[test]
fn login_runs_claude_for_the_account() {
    let env = Env::new();
    let dir = env.tmp.path().join("new");
    fs::create_dir(&dir).unwrap();
    env.xdev(&["accounts", "add", "n", "--dir", dir.to_str().unwrap()]);
    let out = env.xdev(&["accounts", "login", "n"]);
    assert!(out.status.success(), "{out:?}");
    assert!(dir.join("status.json").is_file());
}

#[test]
fn codex_account_add_login_list_and_quota() {
    let env = Env::new();
    let out = env.xdev(&["accounts", "add", "codex-1", "--provider", "codex"]);
    assert!(out.status.success(), "{out:?}");
    let home = env.data().join("accounts").join("codex-1");
    assert!(home.join("signed-in").is_file(), "login did not run");

    let out = env.xdev(&["accounts", "list"]);
    assert_eq!(stdout(&out), "codex-1\tcodex\tlogged_in\t-\t-\n");

    let out = env.xdev(&["quota"]);
    assert_eq!(
        stdout(&out),
        "codex-1\tcodex\tunknown\tno_sessions\n",
        "{out:?}"
    );

    // Resets far ahead, so the windows still count.
    codex_session(&home, 30.0, 4_102_444_800);
    let out = env.xdev(&["quota"]);
    assert_eq!(
        stdout(&out),
        "codex-1\tcodex\tok\tfive_hour=30\tseven_day=20\tas_of=2026-11-02T08:01:30.000Z\t-\n"
    );
    let out = env.xdev(&["quota", "--json"]);
    let json: Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!(json[0]["asOf"], "2026-11-02T08:01:30.000Z");
}

#[test]
fn codex_login_and_signed_out_dir() {
    let env = Env::new();
    let dir = env.tmp.path().join("codex home");
    fs::create_dir(&dir).unwrap();
    let out = env.xdev(&[
        "accounts",
        "add",
        "c",
        "--provider",
        "codex",
        "--dir",
        dir.to_str().unwrap(),
    ]);
    assert!(out.status.success(), "{out:?}");
    let out = env.xdev(&["accounts", "list"]);
    assert_eq!(stdout(&out), "c\tcodex\tlogged_out\t-\t-\n");

    let out = env.xdev(&["accounts", "login", "c"]);
    assert!(out.status.success(), "{out:?}");
    assert!(dir.join("signed-in").is_file());
    let out = env.xdev(&["accounts", "list"]);
    assert_eq!(stdout(&out), "c\tcodex\tlogged_in\t-\t-\n");
}

#[test]
fn add_with_unknown_provider_or_without_codex() {
    let mut env = Env::new();
    let out = env.xdev(&["accounts", "add", "g", "--provider", "gemini"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(stderr(&out), "error: unknown_provider\n");

    env.codex = env.tmp.path().join("missing");
    let out = env.xdev(&["accounts", "add", "c", "--provider", "codex"]);
    assert_eq!(stderr(&out), "error: no_codex\n");
    assert!(!env.data().join("accounts").exists());
    assert!(!env.data().join("accounts.json").exists());
}

#[test]
fn pick_by_provider() {
    let mut env = Env::new();
    env.usage_url = serve(r#"{"five_hour":{"utilization":50,"resets_at":null}}"#);
    let dir = env.signed_in("a");
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        + 3_600_000;
    fs::write(
        dir.join(".credentials.json"),
        format!(r#"{{"claudeAiOauth":{{"accessToken":"test-only","expiresAt":{expires}}}}}"#),
    )
    .unwrap();
    env.xdev(&["accounts", "add", "a", "--dir", dir.to_str().unwrap()]);
    env.xdev(&["accounts", "add", "c", "--provider", "codex"]);
    codex_session(&env.data().join("accounts").join("c"), 10.0, 4_102_444_800);

    // The Codex account has more room.
    assert_eq!(stdout(&env.xdev(&["accounts", "pick"])), "c\n");
    let out = env.xdev(&["accounts", "pick", "--provider", "claude"]);
    assert_eq!(stdout(&out), "a\n");
    let out = env.xdev(&["accounts", "pick", "--provider", "codex"]);
    assert_eq!(stdout(&out), "c\n");
    let out = env.xdev(&["accounts", "pick", "--provider", "gemini"]);
    assert_eq!(stderr(&out), "error: unknown_provider\n");
}
