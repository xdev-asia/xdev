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

/// A repo with one commit, a data dir and a fake `claude`, all under paths
/// with spaces. The real `claude` is never reachable.
struct Env {
    tmp: TempDir,
}

impl Env {
    fn new() -> Env {
        let tmp = TempDir::with_prefix("xdev task ").unwrap();
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
        fake_codex(&env.tmp.path().join("bin"));
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

    fn codex(&self) -> PathBuf {
        let name = if cfg!(windows) { "codex.cmd" } else { "codex" };
        self.tmp.path().join("bin").join(name)
    }

    fn xdev(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_xdev"))
            .env("XDEV_DATA_DIR", self.tmp.path().join("data dir"))
            .env("XDEV_CLAUDE_BIN", self.claude())
            .env("XDEV_CODEX_BIN", self.codex())
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("CODEX_HOME")
            .args(args)
            .output()
            .expect("run xdev")
    }

    fn new_task(&self) -> String {
        let repo = self.repo();
        let out = self.xdev(&["task", "new", repo.to_str().unwrap(), "Add a file"]);
        assert!(out.status.success(), "{out:?}");
        stdout(&out).trim().to_owned()
    }
}

/// Writes `agent.txt` in its working folder and prints a result object.
fn fake_claude(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    let json = r#"{"type":"result","session_id":"fake-1","total_cost_usd":0.5,"is_error":false,"result":"done"}"#;
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

/// Writes `codex.txt` in its working folder and prints a short
/// `codex exec --json` stream.
fn fake_codex(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    let events = [
        r#"{"type":"thread.started","thread_id":"thread-1"}"#,
        r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}"#,
        r#"{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":2}}"#,
    ];
    if cfg!(windows) {
        let lines: String = events.iter().map(|e| format!("echo {e}\r\n")).collect();
        let script = format!("@echo off\r\necho from codex> codex.txt\r\n{lines}exit /b 0\r\n");
        fs::write(dir.join("codex.cmd"), script).unwrap();
    } else {
        let path = dir.join("codex");
        let lines: String = events
            .iter()
            .map(|e| format!("printf '%s\\n' '{e}'\n"))
            .collect();
        let script = format!("#!/bin/sh\nprintf 'from codex\\n' > codex.txt\n{lines}");
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

fn json(out: &Output) -> Value {
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn new_list_and_show() {
    let env = Env::new();
    let id = env.new_task();

    let out = env.xdev(&["task", "list"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(stdout(&out), format!("{id}\tready\tAdd a file\n"));

    let out = env.xdev(&["task", "show", &id, "--json"]);
    assert!(out.status.success(), "{out:?}");
    let task = json(&out);
    assert_eq!(task["state"], "ready");
    assert_eq!(task["branch"], format!("xdev/task-{id}"));

    let out = env.xdev(&["task", "show", &id]);
    assert!(stdout(&out).starts_with(&format!("id\t{id}\nstate\tready\n")));

    let out = env.xdev(&["task", "show", "20200101-000000-0000"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("not_found"));
}

#[test]
fn new_outside_a_repo_is_no_repo() {
    let env = Env::new();
    let plain = env.tmp.path().join("plain");
    fs::create_dir(&plain).unwrap();
    let out = env.xdev(&["task", "new", plain.to_str().unwrap(), "x"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim(),
        "error: no_repo"
    );
}

#[test]
fn extra_tools_or_a_test_need_approval() {
    let env = Env::new();
    let id = env.new_task();

    let out = env.xdev(&["task", "run", &id, "--tools", "Read,Bash"]);
    assert_eq!(out.status.code(), Some(3), "{out:?}");
    assert!(stdout(&out).starts_with("ask\t"), "{out:?}");

    let out = env.xdev(&["task", "run", &id, "--test", "cargo test"]);
    assert_eq!(out.status.code(), Some(3), "{out:?}");
    assert!(stdout(&out).contains("cargo"), "{out:?}");

    // Nothing ran: no agent output, task still ready.
    let out = env.xdev(&["task", "show", &id, "--json"]);
    assert_eq!(json(&out)["state"], "ready");
}

#[test]
fn run_approve_and_discard() {
    let env = Env::new();
    let id = env.new_task();

    let out = env.xdev(&["task", "run", &id]);
    assert!(out.status.success(), "{out:?}");
    let text = stdout(&out);
    assert!(text.contains("state\treview\n"), "{text}");
    assert!(text.contains("file\t1\t0\tagent.txt\n"), "{text}");
    assert!(text.contains("\tfake-1\t0.5000\tok\n"), "{text}");

    let out = env.xdev(&["task", "approve", &id]);
    assert!(out.status.success(), "{out:?}");
    let merge = stdout(&out).trim().to_owned();
    assert_eq!(git(&env.repo(), &["rev-parse", "HEAD"]).trim(), merge);
    // `echo` in a batch file ends its line with CRLF.
    let want = if cfg!(windows) {
        "from fake\r\n"
    } else {
        "from fake\n"
    };
    assert_eq!(
        fs::read_to_string(env.repo().join("agent.txt")).unwrap(),
        want
    );

    let other = env.new_task();
    let out = env.xdev(&["task", "discard", &other]);
    assert!(out.status.success(), "{out:?}");
    let out = env.xdev(&["task", "list", "--json"]);
    let states: Vec<String> = json(&out)
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["state"].as_str().unwrap().to_owned())
        .collect();
    let mut sorted = states.clone();
    sorted.sort();
    assert_eq!(sorted, ["discarded", "merged"]);
}

#[test]
fn the_policy_file_decides_and_every_verdict_is_audited() {
    let env = Env::new();
    let data = env.tmp.path().join("data dir");
    fs::create_dir_all(&data).unwrap();
    fs::write(
        data.join("policy.json"),
        r#"{"commands": ["git"], "merge": "deny"}"#,
    )
    .unwrap();
    let id = env.new_task();

    let out = env.xdev(&["task", "run", &id, "--test", "git status --short"]);
    assert!(out.status.success(), "{out:?}");
    let text = stdout(&out);
    assert!(text.contains("state\treview\n"), "{text}");
    assert!(text.contains("test\t0\tgit status --short\n"), "{text}");

    let out = env.xdev(&["task", "approve", &id]);
    assert_eq!(out.status.code(), Some(3), "{out:?}");
    assert!(stdout(&out).starts_with("deny\t"), "{out:?}");
    assert_eq!(git(&env.repo(), &["log", "--oneline"]).lines().count(), 1);

    let audit = fs::read_to_string(data.join("audit.jsonl")).unwrap();
    let kinds: Vec<String> = audit
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap()["action"]["kind"].to_string())
        .collect();
    assert_eq!(
        kinds,
        [r#""spawn_agent""#, r#""run_command""#, r#""merge""#]
    );
}

#[test]
fn a_broken_policy_stops_every_step() {
    let env = Env::new();
    let data = env.tmp.path().join("data dir");
    let id = env.new_task();
    fs::write(data.join("policy.json"), r#"{"merge": "allow"}"#).unwrap();

    let out = env.xdev(&["task", "run", &id]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "error: policy_invalid\n"
    );
}

#[test]
fn a_codex_account_runs_codex() {
    let env = Env::new();
    let home = env.tmp.path().join("codex home");
    fs::create_dir(&home).unwrap();
    let out = env.xdev(&[
        "accounts",
        "add",
        "cx",
        "--provider",
        "codex",
        "--dir",
        home.to_str().unwrap(),
    ]);
    assert!(out.status.success(), "{out:?}");
    let id = env.new_task();

    let out = env.xdev(&["task", "run", &id, "--account", "cx"]);
    assert!(out.status.success(), "{out:?}");
    let text = stdout(&out);
    assert!(text.contains("state\treview\n"), "{text}");
    assert!(text.contains("file\t1\t0\tcodex.txt\n"), "{text}");
    assert!(text.contains("\tthread-1\t-\tok\n"), "{text}");

    let audit = fs::read_to_string(env.tmp.path().join("data dir").join("audit.jsonl")).unwrap();
    let first: Value = serde_json::from_str(audit.lines().next().unwrap()).unwrap();
    assert_eq!(first["action"]["provider"], "codex");
}
