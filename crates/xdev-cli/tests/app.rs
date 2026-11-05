use std::path::Path;
use std::process::{Command, Output, Stdio};

fn xdev(local: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_xdev"))
        .args(args)
        .env("XDEV_LOCAL_DIR", local)
        .env("XDEV_DATA_DIR", local.join("data"))
        .env_remove("XDEV_PTY_ID")
        .stdin(Stdio::null())
        .output()
        .expect("run xdev")
}

#[test]
fn without_the_app_the_app_verbs_exit_3() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        &["status", "--json"][..],
        &["worktree", "ps"],
        &["worktree", "current"],
        &["worktree", "set", "--status", "in-review"],
        &["terminal", "list"],
        &["terminal", "wait", "--tab", "t1", "--for", "done"],
        &["terminal", "show", "--tab", "t1"],
        &["terminal", "read", "--terminal", "t1", "--limit", "5"],
        &["terminal", "send", "--tab", "t1", "--text", "x", "--enter"],
    ] {
        let out = xdev(dir.path(), args);
        assert_eq!(out.status.code(), Some(3), "{args:?} {out:?}");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("app_not_running"),
            "{out:?}"
        );
    }
}

#[test]
fn a_bad_wait_state_is_a_usage_error() {
    let dir = tempfile::tempdir().unwrap();
    let out = xdev(
        dir.path(),
        &["terminal", "wait", "--tab", "t1", "--for", "soon"],
    );
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    let out = xdev(dir.path(), &["worktree", "nope"]);
    assert_eq!(out.status.code(), Some(2), "{out:?}");
}

#[test]
fn read_screen_with_cursor_is_a_usage_error() {
    let dir = tempfile::tempdir().unwrap();
    let args = [
        "terminal", "read", "--tab", "t1", "--screen", "--cursor", "3",
    ];
    let out = xdev(dir.path(), &args);
    assert_eq!(out.status.code(), Some(2), "{out:?}");
}

#[test]
fn send_without_text_enter_or_interrupt_is_a_usage_error() {
    let dir = tempfile::tempdir().unwrap();
    let out = xdev(dir.path(), &["terminal", "send", "--tab", "t1"]);
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    // Any one of them is enough to get as far as the app.
    let out = xdev(
        dir.path(),
        &["terminal", "send", "--tab", "t1", "--interrupt"],
    );
    assert_eq!(out.status.code(), Some(3), "{out:?}");
}

#[test]
fn the_old_subcommands_still_run_without_the_app() {
    let dir = tempfile::tempdir().unwrap();
    let out = xdev(dir.path(), &["agent", "hooks", "status"]);
    assert_ne!(out.status.code(), Some(3), "{out:?}");
}

#[test]
fn each_app_verb_has_its_own_help() {
    let dir = tempfile::tempdir().unwrap();
    let out = xdev(dir.path(), &["status", "--help"]);
    let help = String::from_utf8_lossy(&out.stdout);
    assert!(help.starts_with("The running app"), "{help}");
    assert!(!help.contains("agent CLI's hook"), "{help}");
    for (verb, first) in [
        ("show", "Metadata and the last lines"),
        ("read", "Output of one tab"),
        ("send", "Type into one tab"),
    ] {
        let out = xdev(dir.path(), &["terminal", verb, "--help"]);
        let help = String::from_utf8_lossy(&out.stdout);
        assert!(help.starts_with(first), "{verb}: {help}");
    }
    let out = xdev(dir.path(), &["terminal", "--help"]);
    let help = String::from_utf8_lossy(&out.stdout);
    for verb in ["show", "read", "send"] {
        assert!(help.contains(verb), "{help}");
    }
    let out = xdev(dir.path(), &["--help"]);
    let help = String::from_utf8_lossy(&out.stdout);
    assert!(!help.contains("agent CLI's hook"), "{help}");
    assert!(help.contains("The running app"), "{help}");
}
