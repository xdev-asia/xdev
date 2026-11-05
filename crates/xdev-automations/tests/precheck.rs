use std::collections::BTreeMap;
#[cfg(unix)]
use std::ffi::OsString;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

use xdev_automations::precheck::{ShellLine, failure, normalize, passed, run};
use xdev_automations::{FailureCode, Precheck};

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[cfg(unix)]
fn line(script: &str) -> ShellLine {
    ShellLine {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        env: vec![],
    }
}

#[cfg(windows)]
fn line(script: &str) -> ShellLine {
    ShellLine {
        program: "cmd".into(),
        args: vec!["/D".into(), "/C".into(), script.into()],
        env: vec![],
    }
}

fn go(script: &str, secs: u64) -> xdev_automations::PrecheckResult {
    let dir = tempfile::tempdir().unwrap();
    run(&line(script), dir.path(), Duration::from_secs(secs), &now)
}

#[test]
fn exit_zero_passes() {
    let r = go("exit 0", 5);
    assert!(passed(&r), "{r:?}");
    assert_eq!(
        (r.exit_code, r.timed_out, r.error.clone()),
        (Some(0), false, None)
    );
    assert!(r.completed_at >= r.started_at && r.started_at > 0);
}

#[test]
fn a_failing_exit_names_its_code() {
    let r = go("exit 3", 5);
    assert!(!passed(&r));
    assert_eq!(r.exit_code, Some(3));
    let (code, params) = failure(&r);
    assert_eq!(code, FailureCode::PrecheckExit);
    assert_eq!(code.english(&params), "Precheck exited with code 3.");
}

#[test]
fn a_spawn_error_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let l = ShellLine {
        program: "/nonexistent/xdev-sh".into(),
        args: vec![],
        env: vec![],
    };
    let r = run(&l, dir.path(), Duration::from_secs(5), &now);
    assert!(!passed(&r));
    assert!(r.error.is_some() && r.exit_code.is_none());
    let (code, params) = failure(&r);
    assert_eq!(code, FailureCode::PrecheckFailed);
    assert!(code.english(&params).starts_with("Precheck failed: "));
}

#[cfg(unix)]
#[test]
fn it_runs_in_the_folder_with_the_env() {
    let dir = tempfile::tempdir().unwrap();
    let mut l = line("pwd; echo \"$XDEV_PRECHECK_TEST\"; echo oops >&2");
    l.env = vec![("XDEV_PRECHECK_TEST".to_string(), OsString::from("yes"))];
    let r = run(&l, dir.path(), Duration::from_secs(5), &now);
    let want = dir.path().canonicalize().unwrap();
    let mut lines = r.stdout.lines();
    assert_eq!(
        std::path::Path::new(lines.next().unwrap())
            .canonicalize()
            .unwrap(),
        want
    );
    assert_eq!(lines.next(), Some("yes"));
    assert_eq!(r.stderr.trim(), "oops");
    assert!(!r.stdout_truncated && !r.stderr_truncated);
}

#[cfg(unix)]
#[test]
fn long_output_keeps_its_last_4000_characters() {
    let r = go(
        "i=0; while [ $i -lt 1000 ]; do printf '%010d' $i; i=$((i+1)); done",
        10,
    );
    assert!(passed(&r), "{r:?}");
    assert_eq!(r.stdout.chars().count(), 4000);
    assert!(r.stdout_truncated);
    assert!(r.stdout.starts_with("0000000600") && r.stdout.ends_with("0000000999"));
    assert!(!r.stderr_truncated);
}

#[cfg(unix)]
#[test]
fn a_timeout_kills_the_whole_tree() {
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pid");
    let script = format!("sleep 30 & echo $! > '{}'; wait", pidfile.display());
    let t = Instant::now();
    let r = run(&line(&script), dir.path(), Duration::from_secs(2), &now);
    assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
    assert!(r.timed_out && !passed(&r), "{r:?}");
    let (code, params) = failure(&r);
    assert_eq!(code, FailureCode::PrecheckTimedOut);
    assert_eq!(code.english(&params), "Precheck timed out after 2s.");

    let pid = std::fs::read_to_string(&pidfile)
        .unwrap()
        .trim()
        .to_string();
    let alive = || {
        std::process::Command::new("kill")
            .args(["-0", &pid])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(), "the grandchild sleep {pid} is still running");
}

#[test]
fn a_precheck_is_trimmed_and_clamped() {
    let p = |c: &str, t: u32| {
        normalize(Some(Precheck {
            command: c.into(),
            timeout_seconds: t,
        }))
    };
    assert_eq!(
        p("  gh pr list ", 60),
        Some(Precheck {
            command: "gh pr list".into(),
            timeout_seconds: 60
        })
    );
    assert_eq!(p("x", 0).unwrap().timeout_seconds, 1);
    assert_eq!(p("x", 601).unwrap().timeout_seconds, 600);
    assert_eq!(p("   ", 60), None);
    assert_eq!(normalize(None), None);
    let _: BTreeMap<String, String> = BTreeMap::new();
}
