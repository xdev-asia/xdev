use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

const ID: &str = "0b3c9a52-6f1e-4d7a-9c1b-2e4f6a8b0c1d";

fn hook(local: &Path, pty_id: Option<&str>, args: &[&str]) -> Output {
    hook_with_stdin(local, pty_id, args, None)
}

/// `hook` with `stdin` piped in (`None`: stdin is null).
fn hook_with_stdin(
    local: &Path,
    pty_id: Option<&str>,
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_xdev"));
    cmd.arg("agent-hook")
        .args(args)
        .env("XDEV_LOCAL_DIR", local)
        .env("XDEV_DATA_DIR", local.join("data"))
        .env_remove("XDEV_PTY_ID");
    if let Some(id) = pty_id {
        cmd.env("XDEV_PTY_ID", id);
    }
    let Some(input) = stdin else {
        return cmd.stdin(Stdio::null()).output().expect("run xdev");
    };
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run xdev");
    let mut pipe = child.stdin.take().unwrap();
    let input = input.to_vec();
    // The hook may stop reading at its cap; a broken pipe is fine.
    let writer = std::thread::spawn(move || {
        let _ = pipe.write_all(&input);
    });
    let out = child.wait_with_output().expect("wait xdev");
    writer.join().unwrap();
    out
}

fn json_hook(local: &Path, event: &str, input: &serde_json::Value) -> Output {
    let out = hook_with_stdin(
        local,
        Some(ID),
        &[event],
        Some(input.to_string().as_bytes()),
    );
    assert!(out.status.success() && out.stdout.is_empty(), "{out:?}");
    out
}

fn hook_text(local: &Path) -> String {
    std::fs::read_to_string(local.join("hooks").join(format!("{ID}.jsonl"))).unwrap()
}

fn lines(local: &Path) -> Vec<serde_json::Value> {
    hook_text(local)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
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
    let lines = lines(tmp.path());
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["v"], 1);
    assert_eq!(lines[0]["event"], "turn-done");
    assert!(lines[0]["at"].as_i64().unwrap() > 0);
}

#[test]
fn hook_takes_every_event_and_hyphen_args() {
    let tmp = tempfile::tempdir().unwrap();
    let events = [
        "prompt",
        "needs-input",
        "resume",
        "turn-done",
        "turn-failed",
        "interrupt",
        "attention",
    ];
    for event in events {
        let out = hook(tmp.path(), Some(ID), &[event, "--weird", "-x"]);
        assert!(out.status.success(), "{out:?}");
        assert!(out.stdout.is_empty());
    }
    let written: Vec<String> = lines(tmp.path())
        .iter()
        .map(|l| l["event"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(written, events);
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

#[test]
fn hook_keeps_only_whitelisted_fields() {
    let tmp = tempfile::tempdir().unwrap();
    let local = tmp.path();
    let secret = "SECRET-PROMPT-TEXT";
    json_hook(
        local,
        "prompt",
        &serde_json::json!({
            "session_id": "s1",
            "turn_id": "t1",
            "transcript_path": "/home/me/.claude/x.jsonl",
            "cwd": "/work",
            "hook_event_name": "UserPromptSubmit",
            "prompt": secret,
        }),
    );
    json_hook(
        local,
        "needs-input",
        &serde_json::json!({
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "tool_input": { "command": secret },
            "permission_suggestions": [secret],
            "cwd": "/work",
        }),
    );
    json_hook(
        local,
        "turn-done",
        &serde_json::json!({
            "hook_event_name": "Stop",
            "last_assistant_message": "All tests pass.",
            "stop_hook_active": false,
            "prompt": secret,
        }),
    );
    json_hook(
        local,
        "turn-failed",
        &serde_json::json!({
            "hook_event_name": "StopFailure",
            "error": "model_not_found",
            "last_assistant_message": secret,
        }),
    );
    json_hook(
        local,
        "resume",
        &serde_json::json!({
            "hook_event_name": "ElicitationResult",
            "message": "Pick a colour",
            "requested_schema": { "secret": secret },
            "is_interrupt": true,
        }),
    );

    let text = hook_text(local);
    assert!(!text.contains(secret), "{text}");
    assert!(
        !text.contains("/work") && !text.contains("transcript"),
        "{text}"
    );
    let l = lines(local);
    assert_eq!(l.len(), 5);
    assert_eq!(l[0]["event"], "prompt");
    assert!(l[0].get("detail").is_none(), "{}", l[0]);
    assert_eq!(l[1]["detail"]["toolName"], "Bash");
    assert_eq!(l[2]["detail"]["message"], "All tests pass.");
    assert_eq!(l[3]["detail"]["error"], "model_not_found");
    assert!(l[3]["detail"]["message"].is_null());
    assert_eq!(l[4]["detail"]["message"], "Pick a colour");
    assert_eq!(l[4]["detail"]["isInterrupt"], true);
    for line in &l {
        let obj = line.as_object().unwrap();
        assert!(
            obj.keys()
                .all(|k| ["v", "event", "at", "detail"].contains(&k.as_str()))
        );
        if let Some(d) = line.get("detail") {
            let mut keys: Vec<&String> = d.as_object().unwrap().keys().collect();
            keys.sort();
            assert_eq!(keys, ["error", "isInterrupt", "message", "toolName"]);
        }
    }
}

#[test]
fn hook_reads_codex_notify_without_input_messages() {
    let tmp = tempfile::tempdir().unwrap();
    let payload = serde_json::json!({
        "type": "agent-turn-complete",
        "thread-id": "th",
        "turn-id": "t1",
        "cwd": "/work",
        "input-messages": ["SECRET-PROMPT"],
        "last-assistant-message": "Done here.",
    });
    let out = hook(tmp.path(), Some(ID), &["turn-done", &payload.to_string()]);
    assert!(out.status.success() && out.stdout.is_empty(), "{out:?}");
    assert!(!hook_text(tmp.path()).contains("SECRET-PROMPT"));
    assert_eq!(lines(tmp.path())[0]["detail"]["message"], "Done here.");
}

#[test]
fn hook_drops_a_notify_for_another_turn() {
    let tmp = tempfile::tempdir().unwrap();
    json_hook(
        tmp.path(),
        "prompt",
        &serde_json::json!({ "hook_event_name": "UserPromptSubmit", "turn_id": "user-turn", "prompt": "x" }),
    );
    // Codex's internal title turn, while the real turn waits on approval.
    let title = serde_json::json!({
        "type": "agent-turn-complete",
        "turn-id": "title-turn",
        "last-assistant-message": r#"{"title":"Run echo hi command"}"#,
    });
    hook(tmp.path(), Some(ID), &["turn-done", &title.to_string()]);
    let real = serde_json::json!({ "type": "agent-turn-complete", "turn-id": "user-turn" });
    hook(tmp.path(), Some(ID), &["turn-done", &real.to_string()]);
    let events: Vec<String> = lines(tmp.path())
        .iter()
        .map(|l| l["event"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(events, ["prompt", "turn-done"]);
}

#[test]
fn hook_caps_stdin_and_ignores_junk() {
    let tmp = tempfile::tempdir().unwrap();
    // Past the 64 KiB cap: cut, so it no longer parses and no detail is kept.
    let big = serde_json::json!({ "tool_name": "Bash", "pad": "x".repeat(70 * 1024) });
    let out = hook_with_stdin(
        tmp.path(),
        Some(ID),
        &["resume"],
        Some(big.to_string().as_bytes()),
    );
    assert!(out.status.success() && out.stdout.is_empty(), "{out:?}");
    for junk in [&b"not json"[..], b"[1,2]", b"", &[0xff, 0xfe, 0x00]] {
        let out = hook_with_stdin(tmp.path(), Some(ID), &["turn-done"], Some(junk));
        assert!(out.status.success() && out.stdout.is_empty(), "{out:?}");
    }
    let l = lines(tmp.path());
    assert_eq!(l.len(), 5);
    assert!(l.iter().all(|line| line.get("detail").is_none()));
}

#[test]
fn hook_does_not_wait_on_an_open_stdin() {
    let tmp = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_xdev"))
        .args(["agent-hook", "prompt"])
        .env("XDEV_LOCAL_DIR", tmp.path())
        .env("XDEV_DATA_DIR", tmp.path().join("data"))
        .env("XDEV_PTY_ID", ID)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Stdin stays open and silent; the hook gives up after its 1 s wait.
    let pipe = child.stdin.take().unwrap();
    let start = std::time::Instant::now();
    let out = child.wait_with_output().unwrap();
    drop(pipe);
    assert!(out.status.success() && out.stdout.is_empty(), "{out:?}");
    assert!(start.elapsed() < std::time::Duration::from_secs(5));
    assert_eq!(lines(tmp.path()).len(), 1);
}

#[test]
fn hook_drops_a_notify_that_stop_already_reported() {
    let tmp = tempfile::tempdir().unwrap();
    let local = tmp.path();
    let prompt = serde_json::json!({ "hook_event_name": "UserPromptSubmit", "turn_id": "t1" });
    json_hook(local, "prompt", &prompt);
    let stop = serde_json::json!({ "hook_event_name": "Stop", "turn_id": "t1" });
    json_hook(local, "turn-done", &stop);
    let notify = serde_json::json!({ "type": "agent-turn-complete", "turn-id": "t1" });
    hook(local, Some(ID), &["turn-done", &notify.to_string()]);
    // The next turn, with hooks that did not run its Stop: notify reports it.
    let next = serde_json::json!({ "hook_event_name": "UserPromptSubmit", "turn_id": "t2" });
    json_hook(local, "prompt", &next);
    let notify = serde_json::json!({ "type": "agent-turn-complete", "turn-id": "t2" });
    hook(local, Some(ID), &["turn-done", &notify.to_string()]);
    let events: Vec<String> = lines(local)
        .iter()
        .map(|l| l["event"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(events, ["prompt", "turn-done", "prompt", "turn-done"]);
}
