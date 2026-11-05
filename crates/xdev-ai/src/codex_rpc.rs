//! A short-lived JSON-RPC session with the user's own `codex app-server`,
//! to read the account's live rate limits.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::process::{kill_tree, own_group, term_group};
use crate::quota::QuotaWindow;

pub(crate) const PROBE_ARGS: [&str; 9] = [
    "-c",
    "approval_policy=never",
    "-c",
    "features.plugins=false",
    "-s",
    "read-only",
    "-a",
    "never",
    "app-server",
];
pub(crate) const SESSION_MINUTES: i64 = 300;
pub(crate) const WEEKLY_MINUTES: i64 = 10_080;

#[derive(Debug, Clone, Copy)]
pub(crate) struct ProbeTimeouts {
    pub init: Duration,
    pub rpc: Duration,
    pub drain: Duration,
}

impl Default for ProbeTimeouts {
    fn default() -> Self {
        ProbeTimeouts {
            init: Duration::from_secs(30),
            rpc: Duration::from_secs(10),
            drain: Duration::from_secs(5),
        }
    }
}

#[derive(Debug)]
/// The payloads are for `Debug` and the tests; callers branch on the variant.
#[allow(dead_code)]
pub(crate) enum ProbeError {
    /// The binary is not there.
    NoCodex,
    /// An RPC error, or stderr matched an auth phrase.
    Auth(String),
    Timeout,
    /// Closed before the answer.
    Exited(Option<i32>),
    Rpc(String),
    Io(io::Error),
}

/// A line from a pipe, or its end.
enum Ev {
    Out(String),
    Err(String),
    OutEof,
    ErrEof,
}

fn pump<R: Read + Send + 'static>(
    r: R,
    tx: mpsc::Sender<Ev>,
    line: fn(String) -> Ev,
    eof: fn() -> Ev,
) {
    thread::spawn(move || {
        for l in BufReader::new(r).lines() {
            let Ok(l) = l else { break };
            if tx.send(line(l)).is_err() {
                return;
            }
        }
        let _ = tx.send(eof());
    });
}

fn send(stdin: &mut ChildStdin, msg: &Value) {
    // A closed pipe shows as an early exit while waiting for the answer.
    let _ = writeln!(stdin, "{msg}").and_then(|()| stdin.flush());
}

/// Waits for the response to request `id`. Lines that are not JSON, and
/// other messages, are skipped.
fn await_response(
    rx: &mpsc::Receiver<Ev>,
    child: &mut Child,
    id: i64,
    timeout: Duration,
) -> Result<Value, ProbeError> {
    let deadline = Instant::now() + timeout;
    let mut stderr = String::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Err(mpsc::RecvTimeoutError::Timeout) => return Err(ProbeError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(exited(child, &stderr)),
            Ok(Ev::Err(l)) => {
                if is_auth_error(&l) {
                    return Err(ProbeError::Auth(l));
                }
                if stderr.len() < 16 << 10 {
                    stderr.push_str(&l);
                    stderr.push('\n');
                }
            }
            Ok(Ev::ErrEof) => {}
            Ok(Ev::OutEof) => {
                // The error text may still be in flight on the other pipe.
                let grace = Instant::now() + Duration::from_millis(500);
                while let Ok(ev) = rx.recv_timeout(grace.saturating_duration_since(Instant::now()))
                {
                    if let Ev::Err(l) = ev {
                        stderr.push_str(&l);
                        stderr.push('\n');
                    }
                }
                return Err(exited(child, &stderr));
            }
            Ok(Ev::Out(l)) => {
                let Ok(msg) = serde_json::from_str::<Value>(&l) else {
                    continue;
                };
                if msg.get("id").and_then(Value::as_i64) != Some(id) {
                    continue;
                }
                if let Some(e) = msg.get("error") {
                    let text = e
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("rpc error");
                    // A method the server does not know is not a sign-in problem.
                    return Err(if e.get("code").and_then(Value::as_i64) == Some(-32601) {
                        ProbeError::Rpc(text.to_owned())
                    } else {
                        ProbeError::Auth(text.to_owned())
                    });
                }
                return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }
}

fn exited(child: &mut Child, stderr: &str) -> ProbeError {
    if is_auth_error(stderr) {
        return ProbeError::Auth(stderr.trim().to_owned());
    }
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return ProbeError::Exited(status.code()),
            Ok(None) if Instant::now() < until => thread::sleep(Duration::from_millis(20)),
            _ => return ProbeError::Exited(None),
        }
    }
}

/// Closes stdin, asks the group to stop, waits `drain`, then kills the tree.
/// The kill comes last: a probe that is refreshing its token must be able to
/// finish writing it.
fn shutdown(mut child: Child, stdin: ChildStdin, drain: Duration) {
    drop(stdin);
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    term_group(child.id());
    let until = Instant::now() + drain;
    while Instant::now() < until {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    kill_tree(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

/// Spawns `cmd` (already carrying args, env, cwd), runs the handshake and
/// returns the windows.
pub(crate) fn read_rate_limits(
    mut cmd: Command,
    t: ProbeTimeouts,
    now: i64,
) -> Result<Vec<QuotaWindow>, ProbeError> {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    own_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            ProbeError::NoCodex
        } else {
            ProbeError::Io(e)
        }
    })?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let (tx, rx) = mpsc::channel();
    pump(
        child.stdout.take().expect("stdout is piped"),
        tx.clone(),
        Ev::Out,
        || Ev::OutEof,
    );
    pump(
        child.stderr.take().expect("stderr is piped"),
        tx,
        Ev::Err,
        || Ev::ErrEof,
    );

    let answer = (|| {
        send(
            &mut stdin,
            &json!({"id": 1, "method": "initialize", "params": {
                "clientInfo": {"name": "xdev", "version": env!("CARGO_PKG_VERSION")}
            }}),
        );
        await_response(&rx, &mut child, 1, t.init)?;
        send(&mut stdin, &json!({"method": "initialized"}));
        send(
            &mut stdin,
            &json!({"id": 2, "method": "account/rateLimits/read"}),
        );
        await_response(&rx, &mut child, 2, t.rpc)
    })();
    shutdown(child, stdin, t.drain);

    let windows = parse_rpc_rate_limits(&answer?, now);
    if windows.is_empty() {
        return Err(ProbeError::Rpc("no rate limits in the answer".into()));
    }
    Ok(windows)
}

/// `result.rateLimits` to windows keyed `five_hour` / `seven_day` (by
/// duration within a minute, else by slot). A slot with no finite
/// `usedPercent` is skipped.
pub(crate) fn parse_rpc_rate_limits(result: &Value, _now: i64) -> Vec<QuotaWindow> {
    let mut out: Vec<QuotaWindow> = Vec::new();
    for (slot, by_slot) in [("primary", "five_hour"), ("secondary", "seven_day")] {
        let Some(w) = result.get("rateLimits").and_then(|l| l.get(slot)) else {
            continue;
        };
        let Some(used) = w
            .get("usedPercent")
            .and_then(Value::as_f64)
            .filter(|u| u.is_finite())
        else {
            continue;
        };
        let key = match w.get("windowDurationMins").and_then(Value::as_i64) {
            Some(m) if (m - SESSION_MINUTES).abs() <= 1 => "five_hour",
            Some(m) if (m - WEEKLY_MINUTES).abs() <= 1 => "seven_day",
            _ => by_slot,
        };
        if out.iter().any(|o| o.key == key) {
            continue;
        }
        out.push(QuotaWindow {
            key: key.to_owned(),
            utilization: Some(used.clamp(0.0, 100.0)),
            resets_at: w
                .get("resetsAt")
                .and_then(Value::as_i64)
                .map(crate::codex::rfc3339),
        });
    }
    out.sort_by_key(|w| w.key != "five_hour");
    out
}

const AUTH_PHRASES: [&str; 16] = [
    "access token could not be refreshed",
    "authentication session could not be refreshed",
    "refresh token has expired",
    "refresh token was already used",
    "refresh token was revoked",
    "you have since logged out or signed in to another account",
    "please sign in again",
    "please log out and sign in again",
    "please reauthenticate",
    "not logged in",
    "sign in with chatgpt",
    "token data is not available",
    "auth is missing",
    "auth tokens are missing",
    "auth does not expose",
    "chatgpt authentication required",
];

/// Lower-cased phrase match with ANSI escapes stripped.
pub(crate) fn is_auth_error(text: &str) -> bool {
    let lower = strip_ansi(text).to_lowercase();
    AUTH_PHRASES.iter().any(|p| lower.contains(p))
}

/// Drops `ESC [ ... final-byte` sequences.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for n in chars.by_ref() {
                if ('@'..='~').contains(&n) {
                    break;
                }
            }
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn keys(w: &[QuotaWindow]) -> Vec<(&str, Option<f64>)> {
        w.iter().map(|w| (w.key.as_str(), w.utilization)).collect()
    }

    fn lim(p: Value, s: Value) -> Value {
        json!({ "rateLimits": { "primary": p, "secondary": s } })
    }

    fn win(used: Value, mins: Value, at: Value) -> Value {
        json!({ "usedPercent": used, "windowDurationMins": mins, "resetsAt": at })
    }

    #[test]
    fn classifies_by_duration() {
        let r = lim(
            win(json!(10.0), json!(300), json!(1000)),
            win(json!(20.0), json!(10080), json!(2000)),
        );
        let w = parse_rpc_rate_limits(&r, 0);
        assert_eq!(
            keys(&w),
            [("five_hour", Some(10.0)), ("seven_day", Some(20.0))]
        );
        assert_eq!(w[0].resets_at.as_deref(), Some("1970-01-01T00:16:40Z"));
    }

    #[test]
    fn duration_is_matched_within_a_minute() {
        let r = lim(
            win(json!(1.0), json!(299), Value::Null),
            win(json!(2.0), json!(10081), Value::Null),
        );
        let w = parse_rpc_rate_limits(&r, 0);
        assert_eq!(
            keys(&w),
            [("five_hour", Some(1.0)), ("seven_day", Some(2.0))]
        );
        assert_eq!(w[0].resets_at, None);
    }

    #[test]
    fn swapped_slots_follow_the_duration() {
        let r = lim(
            win(json!(5.0), json!(10080), Value::Null),
            win(json!(6.0), json!(300), Value::Null),
        );
        let w = parse_rpc_rate_limits(&r, 0);
        assert_eq!(
            keys(&w),
            [("five_hour", Some(6.0)), ("seven_day", Some(5.0))]
        );
    }

    #[test]
    fn unknown_durations_fall_back_by_slot() {
        let r = lim(
            win(json!(5.0), json!(60), Value::Null),
            win(json!(6.0), Value::Null, Value::Null),
        );
        let w = parse_rpc_rate_limits(&r, 0);
        assert_eq!(
            keys(&w),
            [("five_hour", Some(5.0)), ("seven_day", Some(6.0))]
        );
    }

    #[test]
    fn used_percent_is_clamped() {
        let r = lim(
            win(json!(130), json!(300), Value::Null),
            win(json!(-5), json!(10080), Value::Null),
        );
        assert_eq!(
            keys(&parse_rpc_rate_limits(&r, 0)),
            [("five_hour", Some(100.0)), ("seven_day", Some(0.0))]
        );
    }

    #[test]
    fn a_slot_without_a_finite_percent_is_skipped() {
        let r = lim(
            win(Value::Null, json!(300), Value::Null),
            win(json!("x"), json!(10080), Value::Null),
        );
        assert!(parse_rpc_rate_limits(&r, 0).is_empty());
        let r = json!({ "rateLimits": { "secondary": { "windowDurationMins": 10080 } } });
        assert!(parse_rpc_rate_limits(&r, 0).is_empty());
    }

    #[test]
    fn null_rate_limits_give_nothing() {
        assert!(parse_rpc_rate_limits(&json!({ "rateLimits": null }), 0).is_empty());
        assert!(parse_rpc_rate_limits(&json!({}), 0).is_empty());
    }

    #[test]
    fn every_auth_phrase_matches_through_ansi() {
        for p in AUTH_PHRASES {
            assert!(is_auth_error(p), "{p}");
            let wrapped = format!("\u{1b}[31mError:\u{1b}[0m {} \u{1b}[1m", p.to_uppercase());
            assert!(is_auth_error(&wrapped), "{p}");
        }
    }

    #[test]
    fn other_errors_are_not_auth() {
        assert!(!is_auth_error("rate limit reached"));
        assert!(!is_auth_error(""));
    }

    // ---- a fake `codex app-server`: this test binary, speaking the protocol ----

    const MODE: &str = "XDEV_FAKE_CODEX_MODE";
    /// Where the `slow` mode appends `s` (start) and `r` (reply) lines.
    pub(crate) const LOG: &str = "XDEV_FAKE_CODEX_LOG";
    const PID_FILE: &str = "XDEV_FAKE_CODEX_PID_FILE";

    /// Does nothing in a normal run. `fake()` starts the test binary on this
    /// test with a mode set, and it then plays the server.
    #[test]
    fn fake_app_server() {
        let Ok(mode) = std::env::var(MODE) else {
            return;
        };
        // libtest leaves "test name ... " unfinished on this line.
        println!();
        if let Some(f) = std::env::var_os(PID_FILE) {
            std::fs::write(f, std::process::id().to_string()).unwrap();
        }
        let sleep_forever = || loop {
            thread::sleep(Duration::from_secs(1));
        };
        match mode.as_str() {
            "exit3" => std::process::exit(3),
            "stderr-auth-exit" => {
                eprintln!("\u{1b}[31mError: Not logged in\u{1b}[0m");
                std::process::exit(1);
            }
            "hang" => sleep_forever(),
            _ => {}
        }
        let note = |what: &str| {
            if let Some(f) = std::env::var_os(LOG) {
                let mut f = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(f)
                    .unwrap();
                f.write_all(what.as_bytes()).unwrap();
            }
        };
        let mut seen: Vec<String> = Vec::new();
        for line in std::io::stdin().lock().lines() {
            let Ok(msg) = serde_json::from_str::<Value>(&line.unwrap()) else {
                continue;
            };
            let method = msg["method"].as_str().unwrap_or("").to_owned();
            let id = msg.get("id").cloned();
            // A notification has no id.
            if method == "initialized" && id.is_some() {
                seen.push("initialized-with-id".into());
            }
            let reply = |body: Value| {
                let mut m = json!({ "id": id });
                m.as_object_mut()
                    .unwrap()
                    .extend(body.as_object().unwrap().clone());
                println!("{m}");
            };
            match method.as_str() {
                "initialize" => {
                    if mode == "slow" {
                        note("s\n");
                        thread::sleep(Duration::from_millis(500));
                    }
                    reply(json!({ "result": {} }));
                }
                "account/rateLimits/read" => match mode.as_str() {
                    "rpc-auth" => reply(
                        json!({ "error": { "code": -32600, "message": "Please sign in again" } }),
                    ),
                    "rpc-missing" => {
                        reply(json!({ "error": { "code": -32601, "message": "method not found" } }))
                    }
                    "empty" => reply(json!({ "result": { "rateLimits": null } })),
                    _ if seen != ["initialize", "initialized"] => {
                        reply(
                            json!({ "error": { "code": -32600, "message": format!("bad order {seen:?}") } }),
                        );
                    }
                    _ => {
                        note("r\n");
                        reply(json!({ "result": { "rateLimits": {
                            "primary": { "usedPercent": 42.5, "windowDurationMins": 300, "resetsAt": 1000 },
                            "secondary": { "usedPercent": 7, "windowDurationMins": 10080, "resetsAt": 2000 },
                        }}}));
                        if mode == "ignore-eof" {
                            sleep_forever();
                        }
                    }
                },
                _ => {}
            }
            seen.push(method);
        }
    }

    pub(crate) fn fake(mode: &str) -> Command {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args([
            "--exact",
            "codex_rpc::tests::fake_app_server",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(MODE, mode);
        cmd
    }

    pub(crate) fn quick() -> ProbeTimeouts {
        ProbeTimeouts {
            init: Duration::from_secs(10),
            rpc: Duration::from_secs(10),
            drain: Duration::from_secs(5),
        }
    }

    #[test]
    fn reads_the_windows_in_protocol_order() {
        let w = read_rate_limits(fake("ok"), quick(), 0).unwrap();
        assert_eq!(
            keys(&w),
            [("five_hour", Some(42.5)), ("seven_day", Some(7.0))]
        );
    }

    #[test]
    fn an_rpc_error_means_sign_in_again() {
        let e = read_rate_limits(fake("rpc-auth"), quick(), 0).unwrap_err();
        assert!(matches!(e, ProbeError::Auth(_)), "{e:?}");
    }

    #[test]
    fn an_unknown_method_is_not_an_auth_error() {
        let e = read_rate_limits(fake("rpc-missing"), quick(), 0).unwrap_err();
        assert!(matches!(e, ProbeError::Rpc(_)), "{e:?}");
        let e = read_rate_limits(fake("empty"), quick(), 0).unwrap_err();
        assert!(matches!(e, ProbeError::Rpc(_)), "{e:?}");
    }

    #[test]
    fn auth_text_on_stderr_before_an_exit_is_auth() {
        let e = read_rate_limits(fake("stderr-auth-exit"), quick(), 0).unwrap_err();
        assert!(matches!(e, ProbeError::Auth(_)), "{e:?}");
    }

    #[test]
    fn an_early_exit_reports_the_code() {
        let e = read_rate_limits(fake("exit3"), quick(), 0).unwrap_err();
        assert!(matches!(e, ProbeError::Exited(Some(3))), "{e:?}");
    }

    #[test]
    fn a_silent_server_times_out() {
        let t = ProbeTimeouts {
            init: Duration::from_secs(2),
            rpc: Duration::from_secs(2),
            drain: Duration::from_secs(2),
        };
        let start = Instant::now();
        let e = read_rate_limits(fake("hang"), t, 0).unwrap_err();
        assert!(matches!(e, ProbeError::Timeout), "{e:?}");
        assert!(start.elapsed() < Duration::from_secs(8));
    }

    fn alive(pid: u32) -> bool {
        if cfg!(windows) {
            let out = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
        } else {
            Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        }
    }

    #[test]
    fn a_server_that_ignores_eof_is_stopped_after_the_drain() {
        let pid_file = std::env::temp_dir().join(format!("xdev-fake-codex-{}", std::process::id()));
        let _ = std::fs::remove_file(&pid_file);
        let mut cmd = fake("ignore-eof");
        cmd.env(PID_FILE, &pid_file);
        let t = ProbeTimeouts {
            drain: Duration::from_secs(2),
            ..quick()
        };
        assert!(read_rate_limits(cmd, t, 0).is_ok());
        let pid: u32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let _ = std::fs::remove_file(&pid_file);
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(pid) {
            assert!(Instant::now() < deadline, "server {pid} survived");
            thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn a_missing_binary_is_no_codex() {
        let e =
            read_rate_limits(Command::new("xdev-no-such-codex-binary"), quick(), 0).unwrap_err();
        assert!(matches!(e, ProbeError::NoCodex), "{e:?}");
    }
}
