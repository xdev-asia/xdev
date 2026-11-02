use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;
use tempfile::TempDir;

/// Runs setup commands; never used for the code under test.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(out.status.success(), "git {args:?}: {out:?}");
    String::from_utf8(out.stdout).unwrap()
}

/// A repo with one commit, a data dir with one registered account and a
/// fake `claude`, all under paths with spaces. The real `claude` is never
/// reachable.
struct Env {
    tmp: TempDir,
}

impl Env {
    fn new() -> Env {
        let tmp = TempDir::with_prefix("xdev squad ").unwrap();
        let repo = tmp.path().join("my repo");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&repo, &["config", key, value]);
        }
        fs::write(repo.join("README.md"), "hello\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let env = Env { tmp };
        fake_claude(&env.tmp.path().join("bin"));
        let account = env.tmp.path().join("dev account");
        fs::create_dir(&account).unwrap();
        let out = env.xdev(&["accounts", "add", "dev", "--dir", account.to_str().unwrap()]);
        assert!(out.status.success(), "{out:?}");
        env
    }

    fn repo(&self) -> PathBuf {
        self.tmp.path().join("my repo")
    }

    fn claude(&self) -> PathBuf {
        let name = if cfg!(windows) {
            "claude.cmd"
        } else {
            "claude"
        };
        self.tmp.path().join("bin").join(name)
    }

    /// Runs in the temp folder, where the fake's quota check writes.
    fn xdev(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_xdev"))
            .current_dir(self.tmp.path())
            .env("XDEV_DATA_DIR", self.tmp.path().join("data dir"))
            .env("XDEV_CLAUDE_BIN", self.claude())
            .env_remove("CLAUDE_CONFIG_DIR")
            .args(args)
            .output()
            .expect("run xdev")
    }

    fn new_squad(&self, seats: &[&str]) -> String {
        let repo = self.repo();
        let mut args = vec!["squad", "new", repo.to_str().unwrap(), "Team"];
        args.extend_from_slice(seats);
        let out = self.xdev(&args);
        assert!(out.status.success(), "{out:?}");
        stdout(&out).trim().to_owned()
    }
}

/// Writes `agent.txt` in its working folder and approves as any seat.
fn fake_claude(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    let json = r#"{"type":"result","session_id":"fake-1","is_error":false,"result":"Done.\nXDEV-REVIEW: approve"}"#;
    if cfg!(windows) {
        let script =
            format!("@echo off\r\necho from fake> agent.txt\r\necho {json}\r\nexit /b 0\r\n");
        fs::write(dir.join("claude.cmd"), script).unwrap();
    } else {
        let path = dir.join("claude");
        let script =
            format!("#!/bin/sh\nprintf 'from fake\\n' > agent.txt\nprintf '%s\\n' '{json}'\n");
        fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
}

fn stdout(out: &Output) -> String {
    String::from_utf8(out.stdout.clone()).unwrap()
}

fn stderr(out: &Output) -> String {
    String::from_utf8(out.stderr.clone()).unwrap()
}

fn json(out: &Output) -> Value {
    serde_json::from_slice(&out.stdout).unwrap()
}

fn fails_with(out: &Output, code: &str) {
    assert!(!out.status.success(), "{out:?}");
    assert_eq!(stderr(out).trim(), format!("error: {code}"));
}

#[test]
fn new_list_show_seat_and_remove() {
    let env = Env::new();
    let repo = env.repo();
    let repo = repo.to_str().unwrap();
    fails_with(
        &env.xdev(&["squad", "new", repo, "Team", "--implement", "nobody"]),
        "unknown_account",
    );
    let id = env.new_squad(&[
        "--implement",
        "dev",
        "--review",
        "dev",
        "--test",
        "git --version",
    ]);

    let out = env.xdev(&["squad", "list"]);
    assert!(out.status.success(), "{out:?}");
    let line = stdout(&out);
    assert!(line.starts_with(&format!("{id}\tidle\tTeam\t")), "{line}");

    let out = env.xdev(&["squad", "show", &id, "--json"]);
    assert!(out.status.success(), "{out:?}");
    let view = json(&out);
    assert_eq!(view["squad"]["seats"][0]["role"], "lead");
    assert_eq!(view["squad"]["seats"][0]["account"], Value::Null);
    assert_eq!(view["squad"]["seats"][1]["account"], "dev");
    assert_eq!(
        view["squad"]["test"],
        serde_json::json!(["git", "--version"])
    );
    assert_eq!(view["run"], Value::Null);

    let out = env.xdev(&["squad", "seat", &id, "lead", "dev"]);
    assert!(out.status.success(), "{out:?}");
    fails_with(
        &env.xdev(&["squad", "seat", &id, "boss", "dev"]),
        "bad_role",
    );
    fails_with(
        &env.xdev(&["squad", "seat", &id, "tests", "nobody"]),
        "unknown_account",
    );
    let out = env.xdev(&["squad", "seat", &id, "review", "none"]);
    assert!(out.status.success(), "{out:?}");
    let out = env.xdev(&["squad", "show", &id]);
    let text = stdout(&out);
    assert!(text.contains("seat\tlead\tdev\tidle\n"), "{text}");
    assert!(text.contains("seat\treview\t-\tidle\n"), "{text}");

    let out = env.xdev(&["squad", "list", "--json"]);
    assert_eq!(json(&out)[0]["squad"]["id"], id.as_str());

    let out = env.xdev(&["squad", "remove", &id]);
    assert!(out.status.success(), "{out:?}");
    fails_with(&env.xdev(&["squad", "show", &id]), "not_found");
}

#[test]
fn run_goes_to_review() {
    let env = Env::new();
    let id = env.new_squad(&[
        "--implement",
        "dev",
        "--lead",
        "dev",
        "--tests",
        "dev",
        "--review",
        "dev",
        "--test",
        "git --version",
    ]);
    // The default policy asks before any command runs.
    let out = env.xdev(&["squad", "run", &id, "Add a file"]);
    assert_eq!(out.status.code(), Some(3), "{out:?}");
    assert!(stdout(&out).starts_with("ask\t"), "{out:?}");
    let out = env.xdev(&["task", "list"]);
    assert_eq!(stdout(&out), "");

    fs::write(
        env.tmp.path().join("data dir").join("policy.json"),
        r#"{"commands": ["git"]}"#,
    )
    .unwrap();
    let out = env.xdev(&["squad", "run", &id, "Add a file"]);
    assert!(out.status.success(), "{out:?}");
    let text = stdout(&out);
    assert!(text.starts_with("start\t-\tAdd a file\n"), "{text}");
    assert!(text.contains("step\tlead\tplan\n"), "{text}");
    assert!(text.contains("review\treview\tapprove\n"), "{text}");
    assert!(text.contains("status\tdone\n"), "{text}");

    let out = env.xdev(&["squad", "show", &id, "--json"]);
    let run = &json(&out)["run"];
    assert_eq!(run["step"], "done");
    assert_eq!(run["seats"]["implement"]["state"], "done");
    assert_eq!(run["seats"]["implement"]["session"], "fake-1");
    let task = run["task"].as_str().unwrap().to_owned();

    let out = env.xdev(&["task", "show", &task, "--json"]);
    let task = json(&out);
    assert_eq!(task["state"], "review");
    assert_eq!(task["evidence"]["files"][0]["path"], "agent.txt");
    assert_eq!(task["evidence"]["test"]["exit"], 0);

    let out = env.xdev(&["squad", "list"]);
    assert!(stdout(&out).starts_with(&format!("{id}\tdone\t")));
}

#[test]
fn errors_name_their_code() {
    let env = Env::new();
    let id = env.new_squad(&["--implement", "dev"]);
    fails_with(&env.xdev(&["squad", "answer", &id, "e1", "yes"]), "no_run");
    fails_with(
        &env.xdev(&["squad", "steer", &id, "implement", "hi"]),
        "no_run",
    );
    fails_with(
        &env.xdev(&["squad", "steer", &id, "lead", "hi"]),
        "seat_vacant",
    );
    fails_with(&env.xdev(&["squad", "resume", &id]), "no_run");
    fails_with(&env.xdev(&["squad", "stop", &id]), "no_run");
    fails_with(&env.xdev(&["squad", "run", &id, " "]), "empty_goal");
    fails_with(&env.xdev(&["squad", "run", "nope", "goal"]), "not_found");

    let out = env.xdev(&["squad", "seat", &id, "implement", "none"]);
    assert!(out.status.success(), "{out:?}");
    fails_with(
        &env.xdev(&["squad", "run", &id, "Add a file"]),
        "seat_vacant",
    );
}
