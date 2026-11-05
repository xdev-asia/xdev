//! The optional shell command that gates a run.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::model::{FailureCode, PRECHECK_OUTPUT_MAX_CHARS, Precheck, PrecheckResult};

#[derive(Debug, Clone)]
pub struct ShellLine {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, OsString)>,
}

/// Trims; an empty command is no precheck; the timeout is clamped to 1..=600 s.
pub fn normalize(p: Option<Precheck>) -> Option<Precheck> {
    let p = p?;
    let command = p.command.trim().to_string();
    if command.is_empty() {
        return None;
    }
    Some(Precheck {
        command,
        timeout_seconds: p
            .timeout_seconds
            .clamp(1, crate::model::PRECHECK_TIMEOUT_MAX_S),
    })
}

/// Output past this is dropped from the front while it is read, so a chatty command cannot grow
/// the process; the last `PRECHECK_OUTPUT_MAX_CHARS` characters are what is kept.
const READ_CAP_BYTES: usize = 256 * 1024;
const POLL: Duration = Duration::from_millis(20);
/// After the shell exits, how long to wait for its pipes to close (a background job may hold them).
const DRAIN: Duration = Duration::from_millis(500);

type Sink = Arc<Mutex<(Vec<u8>, bool)>>;

fn read_into(mut pipe: impl Read + Send + 'static, sink: Sink) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut buf) {
            if n == 0 {
                break;
            }
            let Ok(mut s) = sink.lock() else { break };
            s.0.extend_from_slice(&buf[..n]);
            if s.0.len() > READ_CAP_BYTES {
                let cut = s.0.len() - READ_CAP_BYTES;
                s.0.drain(..cut);
                s.1 = true;
            }
        }
    })
}

/// The last `PRECHECK_OUTPUT_MAX_CHARS` characters and whether anything was cut.
fn tail(sink: &Sink) -> (String, bool) {
    let (bytes, cut) = sink.lock().map(|s| (s.0.clone(), s.1)).unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes);
    let count = text.chars().count();
    if count > PRECHECK_OUTPUT_MAX_CHARS {
        (
            text.chars()
                .skip(count - PRECHECK_OUTPUT_MAX_CHARS)
                .collect(),
            true,
        )
    } else {
        (text.into_owned(), cut)
    }
}

/// Runs the line in `cwd` and waits up to `timeout`; on a timeout the whole process tree is killed.
/// The result's `command` is the line's last argument; the caller replaces it with what the person typed.
pub fn run(
    line: &ShellLine,
    cwd: &Path,
    timeout: Duration,
    now: &dyn Fn() -> i64,
) -> PrecheckResult {
    let started_at = now();
    let began = Instant::now();
    let mut result = PrecheckResult {
        command: line.args.last().cloned().unwrap_or_default(),
        exit_code: None,
        timed_out: false,
        duration_ms: 0,
        stdout: String::new(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
        error: None,
        started_at,
        completed_at: started_at,
    };
    let mut cmd = Command::new(&line.program);
    cmd.args(&line.args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in &line.env {
        cmd.env(k, v);
    }
    xdev_ai::process::own_group(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A GUI app must not flash a console window.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            result.error = Some(e.to_string());
            result.completed_at = now();
            return result;
        }
    };
    let (out, err): (Sink, Sink) = (Sink::default(), Sink::default());
    let readers: Vec<_> = [
        child.stdout.take().map(|p| read_into(p, out.clone())),
        child.stderr.take().map(|p| read_into(p, err.clone())),
    ]
    .into_iter()
    .flatten()
    .collect();

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                result.exit_code = status.code();
                break;
            }
            Ok(None) if began.elapsed() >= timeout => {
                // While the root is alive: Windows finds the tree by parent id.
                xdev_ai::process::kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                result.timed_out = true;
                break;
            }
            Ok(None) => thread::sleep(POLL),
            Err(e) => {
                result.error = Some(e.to_string());
                break;
            }
        }
    }
    let drain = Instant::now();
    while readers.iter().any(|r| !r.is_finished()) && drain.elapsed() < DRAIN {
        thread::sleep(Duration::from_millis(10));
    }
    (result.stdout, result.stdout_truncated) = tail(&out);
    (result.stderr, result.stderr_truncated) = tail(&err);
    result.duration_ms = i64::try_from(began.elapsed().as_millis()).unwrap_or(i64::MAX);
    result.completed_at = now();
    result
}

/// Exit 0, no timeout, no spawn error.
pub fn passed(r: &PrecheckResult) -> bool {
    r.exit_code == Some(0) && !r.timed_out && r.error.is_none()
}

/// Why a precheck did not pass, as a code and the values its text needs.
pub fn failure(r: &PrecheckResult) -> (FailureCode, BTreeMap<String, String>) {
    let mut params = BTreeMap::new();
    if r.timed_out {
        params.insert(
            "seconds".to_string(),
            ((r.duration_ms + 500) / 1000).to_string(),
        );
        return (FailureCode::PrecheckTimedOut, params);
    }
    if let Some(e) = &r.error {
        params.insert("error".to_string(), e.clone());
        return (FailureCode::PrecheckFailed, params);
    }
    match r.exit_code {
        Some(code) => {
            params.insert("code".to_string(), code.to_string());
            (FailureCode::PrecheckExit, params)
        }
        None => {
            params.insert(
                "error".to_string(),
                "the command was stopped by a signal".to_string(),
            );
            (FailureCode::PrecheckFailed, params)
        }
    }
}
