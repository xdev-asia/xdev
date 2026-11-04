//! `CodexRunner` against a fake `codex`. The runner reads `XDEV_CODEX_BIN`,
//! and the workspace forbids the `unsafe` that `set_var` needs, so each case
//! runs an ignored `child_*` test in a child process with its own
//! environment.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::TempDir;
use xdev_agent::{Cancel, CodexRunner, RunRequest, Runner};

const EVENTS: &str = include_str!("fixtures/codex-exec.jsonl");
const ROLLOUT: &str = include_str!("fixtures/codex-rollout.jsonl");
const THREAD: &str = "0199a000-0000-7000-8000-00000000c0de";

fn var(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).expect("run by a parent"))
}

#[test]
#[ignore = "run by a parent test in a child process"]
fn child_codex_run() {
    let runner = CodexRunner {
        account_dir: Some(var("XDEV_TEST_ACCOUNT_DIR")),
        timeout: Duration::from_secs(60),
    };
    let tools = std::env::var("XDEV_TEST_TOOLS").unwrap_or_default();
    let req = RunRequest {
        worktree: var("XDEV_TEST_WORKTREE"),
        prompt: "Fix the bug\nthen stop".into(),
        resume: std::env::var("XDEV_TEST_RESUME").ok(),
        tools: tools
            .split(',')
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .collect(),
        model: std::env::var("XDEV_TEST_MODEL").ok(),
        args: std::env::var("XDEV_TEST_ARGS")
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
        cancel: Cancel::new(),
    };
    let result = match runner.run(&req) {
        Ok(out) => json!({
            "provider": runner.provider(),
            "session": out.session_id,
            "cost": out.cost_usd,
            "error": out.is_error,
            "result": out.result,
            "context": out.context.map(|c| json!([c.used, c.window])),
        }),
        Err(e) => json!({ "err": e.code(), "text": e.to_string() }),
    };
    println!("RESULT:{result}");
}

fn child(envs: &[(&str, OsString)]) -> Value {
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.args([
        "child_codex_run",
        "--exact",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
    ]);
    for v in [
        "XDEV_CODEX_BIN",
        "XDEV_TEST_RESUME",
        "XDEV_TEST_TOOLS",
        "XDEV_TEST_MODEL",
        "XDEV_TEST_ARGS",
    ] {
        cmd.env_remove(v);
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
        .find_map(|l| l.split_once("RESULT:").map(|(_, json)| json))
        .unwrap_or_else(|| panic!("no result: {text}"));
    serde_json::from_str(result).unwrap()
}

/// A fake `codex` that records its arguments, working folder and
/// `CODEX_HOME` next to itself, prints `events.jsonl` and exits with the
/// code in `exit.txt` (0 when absent).
fn fake_codex(dir: &Path, events: &str) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join("events.jsonl"), events).unwrap();
    if cfg!(windows) {
        let path = dir.join("fake-codex.cmd");
        fs::write(
            &path,
            "@echo off\r\n\
             echo %*>\"%~dp0args.txt\"\r\n\
             echo %CD%>\"%~dp0cwd.txt\"\r\n\
             echo %CODEX_HOME%>\"%~dp0home.txt\"\r\n\
             type \"%~dp0events.jsonl\"\r\n\
             echo Reading additional input from stdin... 1>&2\r\n\
             set code=0\r\n\
             if exist \"%~dp0exit.txt\" set /p code=<\"%~dp0exit.txt\"\r\n\
             exit /b %code%\r\n",
        )
        .unwrap();
        path
    } else {
        let path = dir.join("fake-codex");
        fs::write(
            &path,
            "#!/bin/sh\nd=$(dirname \"$0\")\n\
             echo \"$*\" > \"$d/args.txt\"\npwd > \"$d/cwd.txt\"\n\
             echo \"$CODEX_HOME\" > \"$d/home.txt\"\ncat \"$d/events.jsonl\"\n\
             echo 'Reading additional input from stdin...' >&2\n\
             [ -f \"$d/exit.txt\" ] && exit $(cat \"$d/exit.txt\")\nexit 0\n",
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

struct Setup {
    _tmp: TempDir,
    bin_dir: PathBuf,
    worktree: PathBuf,
    home: PathBuf,
    envs: Vec<(&'static str, OsString)>,
}

fn setup(events: &str) -> Setup {
    let tmp = TempDir::new().unwrap();
    let bin_dir = tmp.path().join("bin");
    let bin = fake_codex(&bin_dir, events);
    let worktree = tmp.path().join("wt");
    fs::create_dir_all(&worktree).unwrap();
    let home = tmp.path().join("home");
    let sessions = home.join("sessions").join("2026").join("11").join("02");
    fs::create_dir_all(&sessions).unwrap();
    fs::write(
        sessions.join(format!("rollout-2026-11-02T08-00-00-{THREAD}.jsonl")),
        ROLLOUT,
    )
    .unwrap();
    let envs = vec![
        ("XDEV_CODEX_BIN", bin.into_os_string()),
        ("XDEV_TEST_WORKTREE", worktree.clone().into_os_string()),
        ("XDEV_TEST_ACCOUNT_DIR", home.clone().into_os_string()),
    ];
    Setup {
        _tmp: tmp,
        bin_dir,
        worktree,
        home,
        envs,
    }
}

/// The prompt as the fake saw it: a batch file gets it on one line, other
/// systems keep the newline.
const PROMPT: &str = if cfg!(windows) {
    "Fix the bug then stop"
} else {
    "Fix the bug
then stop"
};

fn read(path: PathBuf) -> String {
    fs::read_to_string(path).unwrap().trim().to_owned()
}

/// The arguments the fake got, without the quotes Windows adds for a batch
/// file.
fn args(s: &Setup) -> String {
    read(s.bin_dir.join("args.txt")).replace('"', "")
}

#[test]
fn new_run_parses_the_stream_and_reads_context() {
    let s = setup(EVENTS);
    let mut envs = s.envs.clone();
    envs.push(("XDEV_TEST_TOOLS", "Read,Edit,Write".into()));
    let got = child(&envs);
    assert_eq!(
        got,
        json!({
            "provider": "codex", "session": THREAD, "cost": null, "error": false,
            "result": "ok", "context": [17077, 475000],
        })
    );
    assert_eq!(
        args(&s),
        format!(
            "exec --json --skip-git-repo-check -s workspace-write -C {} -- {PROMPT}",
            s.worktree.display()
        )
    );
    assert_eq!(read(s.bin_dir.join("home.txt")), s.home.to_string_lossy());
    assert_eq!(
        Path::new(&read(s.bin_dir.join("cwd.txt")))
            .canonicalize()
            .unwrap(),
        s.worktree.canonicalize().unwrap()
    );
}

#[test]
fn resume_passes_sandbox_as_config_and_read_only_tools() {
    let s = setup(EVENTS);
    let mut envs = s.envs.clone();
    envs.push(("XDEV_TEST_TOOLS", "Read,Grep".into()));
    envs.push(("XDEV_TEST_RESUME", THREAD.into()));
    let got = child(&envs);
    assert_eq!(got["session"], THREAD);
    assert_eq!(
        args(&s),
        format!(
            "exec resume --json --skip-git-repo-check -c sandbox_mode=read-only -- {THREAD} {PROMPT}"
        )
    );

    // A routed model goes in before `--` on both paths.
    envs.push(("XDEV_TEST_MODEL", "gpt-mini".into()));
    child(&envs);
    assert_eq!(
        args(&s),
        format!(
            "exec resume --json --skip-git-repo-check -c sandbox_mode=read-only -m gpt-mini -- {THREAD} {PROMPT}"
        )
    );
    envs.retain(|(k, _)| *k != "XDEV_TEST_RESUME");
    child(&envs);
    assert_eq!(
        args(&s),
        format!(
            "exec --json --skip-git-repo-check -s read-only -m gpt-mini -C {} -- {PROMPT}",
            s.worktree.display()
        )
    );
    assert_eq!(
        Path::new(&read(s.bin_dir.join("cwd.txt")))
            .canonicalize()
            .unwrap(),
        s.worktree.canonicalize().unwrap()
    );
}

#[test]
fn extra_args_go_after_the_model_and_before_the_prompt() {
    let s = setup(EVENTS);
    let mut envs = s.envs.clone();
    envs.push(("XDEV_TEST_MODEL", "gpt-mini".into()));
    envs.push(("XDEV_TEST_ARGS", "-c model_reasoning_effort=low".into()));
    child(&envs);
    assert_eq!(
        args(&s),
        format!(
            "exec --json --skip-git-repo-check -s read-only -m gpt-mini -c model_reasoning_effort=low -C {} -- {PROMPT}",
            s.worktree.display()
        )
    );
}

#[test]
fn non_zero_exit_is_an_error_outcome_with_stderr() {
    let s = setup("{\"type\":\"thread.started\",\"thread_id\":\"t9\"}\n");
    fs::write(s.bin_dir.join("exit.txt"), "1").unwrap();
    let got = child(&s.envs);
    assert_eq!(got["error"], true);
    assert_eq!(got["session"], "t9");
    assert_eq!(got["context"], Value::Null);
    assert!(
        got["result"]
            .as_str()
            .unwrap()
            .contains("Reading additional input"),
        "{got}"
    );
}

#[test]
fn no_events_is_a_runner_error() {
    let s = setup("not json\n");
    fs::write(s.bin_dir.join("exit.txt"), "2").unwrap();
    let got = child(&s.envs);
    assert_eq!(got["err"], "runner");
    assert!(
        got["text"].as_str().unwrap().contains("exit Some(2)"),
        "{got}"
    );
}

#[test]
fn missing_codex_is_no_codex() {
    let s = setup(EVENTS);
    let mut envs = s.envs.clone();
    envs[0].1 = s.bin_dir.join("missing").into_os_string();
    let got = child(&envs);
    assert_eq!(got["err"], "runner");
    assert_eq!(got["text"], "agent failed: no_codex");
}
