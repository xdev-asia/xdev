//! Signing an account in on this machine without a console: the CLI's login
//! runs with its output captured, the sign-in page and any device code it
//! prints go to the UI as `accounts://login` events, and the UI shows them in
//! a dialog. A login that prints no page in time, or fails before printing
//! one, is handed to the old console path.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use xdev_ai::process::{kill_tree, own_group};
use xdev_ai::{AccountEntry, AiError, LoginHint, Registry, scan_line, strip_escapes};

use crate::accounts::{data_dir, open_login};
use crate::commands::{AppState, CmdError};

/// Emitted with a `LoginEvent` as a login moves along.
pub const LOGIN_EVENT: &str = "accounts://login";

/// How long a login may run without printing a sign-in page before the
/// console path takes over.
const NO_URL_WAIT: Duration = Duration::from_secs(10);
/// A login nobody finishes is stopped after this.
const MAX_RUN: Duration = Duration::from_secs(10 * 60);
const TAIL_LINES: usize = 4;
const TAIL_CHARS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum LoginPhase {
    /// A sign-in page (and maybe a code) is known: show them.
    Prompt,
    /// The login exited OK.
    Done,
    /// The login failed after printing its page; `detail` is its last output.
    Failed,
    /// No captured flow: a console was opened (`opened`) or the person runs
    /// `command` themselves.
    Console,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LoginEvent {
    pub name: String,
    pub phase: LoginPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub opened: Option<bool>,
}

impl LoginEvent {
    fn new(name: &str, phase: LoginPhase) -> LoginEvent {
        LoginEvent {
            name: name.to_owned(),
            phase,
            url: None,
            code: None,
            detail: None,
            command: None,
            opened: None,
        }
    }
}

/// What the output so far says: the page and code to show, and the last
/// lines for an error.
#[derive(Default)]
struct Tracker {
    seen: LoginHint,
    shown: LoginHint,
    tail: VecDeque<String>,
}

impl Tracker {
    /// Takes one output line; returns the hint to show when it is new: the
    /// page first seen, or a code that came after it.
    fn line(&mut self, line: &str) -> Option<LoginHint> {
        let plain = strip_escapes(line);
        let plain = plain.trim();
        if !plain.is_empty() {
            if self.tail.len() == TAIL_LINES {
                self.tail.pop_front();
            }
            self.tail.push_back(plain.to_owned());
        }
        self.seen.merge(scan_line(line));
        (self.seen.url.is_some() && self.seen != self.shown).then(|| {
            self.shown = self.seen.clone();
            self.seen.clone()
        })
    }

    fn has_url(&self) -> bool {
        self.shown.url.is_some()
    }

    fn detail(&self) -> Option<String> {
        let text = self.tail.iter().cloned().collect::<Vec<_>>().join("\n");
        (!text.is_empty()).then(|| text.chars().take(TAIL_CHARS).collect())
    }
}

/// What a login that has ended should tell the UI.
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Done,
    Failed,
    Console,
}

/// `exit` is the exit status' success, or `None` when the login was stopped
/// for running too long. A failure before any page is the console's to
/// handle: the CLI probably wants a terminal. A login that was stopped after
/// its page was shown has simply timed out.
fn outcome(exit: Option<bool>, had_url: bool) -> Outcome {
    match (exit, had_url) {
        (Some(true), _) => Outcome::Done,
        (Some(false) | None, true) => Outcome::Failed,
        (Some(false) | None, false) => Outcome::Console,
    }
}

struct Running {
    pid: u32,
    stop: Arc<AtomicBool>,
}

static RUNNING: LazyLock<Mutex<HashMap<String, Running>>> = LazyLock::new(Mutex::default);

fn running() -> MutexGuard<'static, HashMap<String, Running>> {
    RUNNING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Stops the login of account `name`, if one runs; its whole process tree.
fn stop(name: &str) {
    if let Some(run) = running().remove(name) {
        run.stop.store(true, Ordering::SeqCst);
        kill_tree(run.pid);
    }
}

/// Pieces of `reader` split at line ends and carriage returns, sent as they
/// come.
fn pump(reader: impl Read + Send + 'static, tx: mpsc::Sender<String>) {
    thread::spawn(move || {
        for chunk in BufReader::new(reader).split(b'\n') {
            let Ok(chunk) = chunk else { return };
            for part in String::from_utf8_lossy(&chunk).split('\r') {
                if tx.send(part.to_owned()).is_err() {
                    return;
                }
            }
        }
    });
}

/// Starts the captured login of `entry`. Errors only when the CLI cannot be
/// started; everything after is reported by event.
pub fn begin(app: &AppHandle, entry: &AccountEntry, command: String) -> Result<(), CmdError> {
    stop(&entry.name);
    let mut cmd = xdev_ai::login_process(entry)?;
    // stdin stays open and unwritten, so a CLI that waits for a pasted code
    // waits instead of reading an end of file.
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    own_group(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(AiError::from)?;
    let (tx, rx) = mpsc::channel();
    if let Some(out) = child.stdout.take() {
        pump(out, tx.clone());
    }
    if let Some(err) = child.stderr.take() {
        pump(err, tx.clone());
    }
    drop(tx);
    let stdin = child.stdin.take();
    let stopped = Arc::new(AtomicBool::new(false));
    let pid = child.id();
    running().insert(
        entry.name.clone(),
        Running {
            pid,
            stop: Arc::clone(&stopped),
        },
    );
    let (app, entry) = (app.clone(), entry.clone());
    thread::spawn(move || {
        let _stdin = stdin;
        let name = entry.name.clone();
        let emit = |event: LoginEvent| {
            let _ = app.emit(LOGIN_EVENT, event);
        };
        let feed = |tracker: &mut Tracker, line: &str| {
            if let Some(hint) = tracker.line(line) {
                let mut event = LoginEvent::new(&name, LoginPhase::Prompt);
                event.url = hint.url;
                event.code = hint.code;
                emit(event);
            }
        };
        let mut tracker = Tracker::default();
        let started = Instant::now();
        let exit = loop {
            if let Ok(line) = rx.recv_timeout(Duration::from_millis(100)) {
                feed(&mut tracker, &line);
            } else {
                // Idle or the pipes closed; either way look at the child.
                thread::sleep(Duration::from_millis(50));
            }
            if stopped.load(Ordering::SeqCst) {
                let _ = child.wait();
                return;
            }
            if let Ok(Some(status)) = child.try_wait() {
                break Some(status.success());
            }
            let waited = started.elapsed();
            if (!tracker.has_url() && waited > NO_URL_WAIT) || waited > MAX_RUN {
                kill_tree(pid);
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        };
        // Output the CLI printed just before it ended.
        while let Ok(line) = rx.recv_timeout(Duration::from_millis(200)) {
            feed(&mut tracker, &line);
        }
        let mut registered = running();
        if registered.get(&name).is_some_and(|r| r.pid == pid) {
            registered.remove(&name);
        }
        drop(registered);
        match outcome(exit, tracker.has_url()) {
            Outcome::Done => emit(LoginEvent::new(&name, LoginPhase::Done)),
            Outcome::Failed => {
                let mut event = LoginEvent::new(&name, LoginPhase::Failed);
                event.detail = tracker.detail();
                emit(event);
            }
            Outcome::Console => {
                let mut event = LoginEvent::new(&name, LoginPhase::Console);
                event.opened = Some(open_login(&entry).unwrap_or(false));
                event.command = Some(command);
                emit(event);
            }
        }
    });
    Ok(())
}

/// Stops the login this app started for account `name`. Does nothing when
/// none runs.
#[tauri::command(async)]
pub fn account_login_cancel(state: State<'_, AppState>, name: String) -> Result<(), CmdError> {
    // Only a registered account has a login to stop.
    if Registry::load(data_dir(&state)?)?.get(&name).is_some() {
        stop(&name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shows_the_page_once_and_again_when_a_code_follows() {
        let mut t = Tracker::default();
        assert!(t.line("Opening browser to sign in...").is_none());
        assert!(!t.has_url());
        let first = t
            .line("Visit https://auth.example.com/device and enter the code")
            .unwrap();
        assert_eq!(
            first.url.as_deref(),
            Some("https://auth.example.com/device")
        );
        assert_eq!(first.code, None);
        assert!(t.has_url());
        assert!(t.line("waiting").is_none());
        let second = t.line("WDJB-MJHT").unwrap();
        assert_eq!(second.code.as_deref(), Some("WDJB-MJHT"));
        assert!(t.line("WDJB-MJHT").is_none(), "nothing new");
    }

    #[test]
    fn keeps_the_last_lines_for_an_error() {
        let mut t = Tracker::default();
        for n in 0..10 {
            t.line(&format!("\u{1b}[31mline {n}\u{1b}[0m"));
        }
        t.line("   ");
        assert_eq!(t.detail().unwrap(), "line 6\nline 7\nline 8\nline 9");
        assert_eq!(Tracker::default().detail(), None);
    }

    #[test]
    fn a_failed_login_without_a_page_goes_to_the_console() {
        assert_eq!(outcome(Some(true), false), Outcome::Done);
        assert_eq!(outcome(Some(true), true), Outcome::Done);
        assert_eq!(outcome(Some(false), true), Outcome::Failed);
        assert_eq!(outcome(Some(false), false), Outcome::Console);
        assert_eq!(outcome(None, false), Outcome::Console);
        assert_eq!(outcome(None, true), Outcome::Failed);
    }

    #[test]
    fn events_leave_out_what_they_lack() {
        let mut event = LoginEvent::new("a", LoginPhase::Prompt);
        event.url = Some("https://x.example".into());
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({ "name": "a", "phase": "prompt", "url": "https://x.example" })
        );
    }
}
