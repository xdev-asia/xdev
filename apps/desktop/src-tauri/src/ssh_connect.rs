//! Testing a saved SSH host, keeping a connection to it (`ssh -N`, which holds
//! its local forwards up), and answering in the app what `ssh` asks while it
//! connects.
//!
//! A kept connection runs `ssh` with `SSH_ASKPASS` set to the `xdev` CLI and a
//! one-time token in `XDEV_SSH_ASKPASS_TOKEN`. When `ssh` needs a password,
//! passphrase or answer it runs `xdev <prompt>`, which asks the app through the
//! `ssh.askpass` verb; the app shows a dialog and sends the answer back on that
//! one reply. Answers are never logged, stored or put in an event.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use xdev_ssh::{
    Connection, SshConnState, SshHost, SshPromptKind, SshTestOutcome, classify, connect_argv,
    effective_timeout, prompt_kind, test_argv,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::endpoint::{AppError, Request};

/// The variable that carries a connection's askpass token to the CLI. Must
/// match `xdev-cli`'s `askpass::TOKEN_ENV`.
pub const TOKEN_ENV: &str = "XDEV_SSH_ASKPASS_TOKEN";
/// How long a prompt waits for the person before it counts as cancelled.
const ASK_LIMIT: Duration = Duration::from_secs(300);
/// How often a kept connection is checked.
const POLL: Duration = Duration::from_millis(200);
/// A test is killed this long after its own connect timeout.
const TEST_GRACE: Duration = Duration::from_secs(2);
/// How long the exit waits for the last of stderr.
const STDERR_DRAIN: Duration = Duration::from_secs(2);
/// The prompt text shown, at most.
const PROMPT_MAX: usize = 500;
/// The stderr a test keeps, at most.
const TEST_STDERR_MAX: usize = 16 * 1024;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A started `ssh`.
pub(crate) trait SshChild: Send {
    /// `Some(exit)` once it ended; `exit` is `None` when a signal ended it.
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>>;
    /// Ends it and whatever it started, and reaps it.
    fn kill(&mut self);
}

pub(crate) struct Spawned {
    pub child: Box<dyn SshChild>,
    pub stderr: Box<dyn Read + Send>,
}

/// Starts `ssh` with `args` and `env` added to the app's environment: no
/// stdin, no stdout, stderr piped. Tests put a fake in its place.
pub(crate) trait Spawner: Send + Sync {
    fn spawn(&self, args: &[String], env: &[(String, OsString)]) -> io::Result<Spawned>;
}

/// The system's OpenSSH client.
pub(crate) struct SystemSsh;

struct OsChild(std::process::Child);

impl SshChild for OsChild {
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>> {
        Ok(self.0.try_wait()?.map(|s| s.code()))
    }

    fn kill(&mut self) {
        // A jump host or proxy runs as a child of `ssh`; the tree goes too.
        if matches!(self.0.try_wait(), Ok(None)) {
            xdev_ai::process::kill_tree(self.0.id());
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Spawner for SystemSsh {
    fn spawn(&self, args: &[String], env: &[(String, OsString)]) -> io::Result<Spawned> {
        let mut cmd = Command::new(xdev_agent::system_ssh());
        cmd.args(args)
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_os_str())))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        xdev_ai::process::own_group(&mut cmd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // A GUI app must not flash a console window.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn()?;
        let Some(stderr) = child.stderr.take() else {
            let mut child = OsChild(child);
            child.kill();
            return Err(io::Error::other("no stderr pipe"));
        };
        Ok(Spawned {
            child: Box::new(OsChild(child)),
            stderr: Box::new(stderr),
        })
    }
}

/// Reads `stderr` to its end on a thread; the text comes on the channel.
fn read_all(mut stderr: Box<dyn Read + Send>, max: usize) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut buf = [0u8; 2048];
        loop {
            match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if kept.len() < max {
                        let take = n.min(max - kept.len());
                        kept.extend_from_slice(&buf[..take]);
                    }
                }
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&kept).into_owned());
    });
    rx
}

/// Runs `args` (a test) until it ends or `limit` passes, then classifies it.
/// A run past `limit` is killed and counts as unreachable.
pub(crate) fn run_test(spawner: &dyn Spawner, args: &[String], limit: Duration) -> SshTestOutcome {
    let Spawned { mut child, stderr } = match spawner.spawn(args, &[]) {
        Ok(spawned) => spawned,
        Err(e) => return SshTestOutcome::Failed(format!("spawn: {e}")),
    };
    let text = read_all(stderr, TEST_STDERR_MAX);
    let start = Instant::now();
    let exit = loop {
        match child.try_wait() {
            Ok(Some(exit)) => break exit,
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) | Err(_) => {
                child.kill();
                break None;
            }
        }
    };
    let stderr = text.recv_timeout(STDERR_DRAIN).unwrap_or_default();
    classify(exit, &stderr)
}

/// The command line and environment of a kept connection. With the CLI
/// (`askpass`) every prompt goes to the app with `token`; without it `ssh`
/// may not ask at all (`BatchMode`), so it never waits on a terminal.
pub(crate) fn connect_command(
    host: &SshHost,
    askpass: Option<&Path>,
    token: &str,
    display: Option<&OsStr>,
) -> (Vec<String>, Vec<(String, OsString)>) {
    let mut args = Vec::new();
    let mut env = Vec::new();
    match askpass {
        Some(cli) => {
            env.push(("SSH_ASKPASS".to_owned(), cli.as_os_str().to_owned()));
            env.push(("SSH_ASKPASS_REQUIRE".to_owned(), "force".into()));
            // Clients older than `SSH_ASKPASS_REQUIRE` use askpass only with a display.
            if display.is_none_or(OsStr::is_empty) {
                env.push(("DISPLAY".to_owned(), ":0".into()));
            }
            env.push((TOKEN_ENV.to_owned(), token.into()));
        }
        None => args.extend(["-o".to_owned(), "BatchMode=yes".to_owned()]),
    }
    args.extend(connect_argv(host));
    (args, env)
}

/// One host's kept connection, for the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionView {
    pub host_id: String,
    pub alias: String,
    pub state: SshConnState,
}

/// A question `ssh` asked, for the dialog. The answer goes back with
/// `ssh_auth_reply(requestId, ...)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshAuthPrompt {
    pub request_id: String,
    pub host_id: String,
    pub alias: String,
    pub kind: SshPromptKind,
    /// What `ssh` printed, as it printed it.
    pub prompt: String,
}

/// What the manager tells the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SshEvent {
    State(SshConnectionView),
    Prompt(SshAuthPrompt),
    /// The prompt was answered, cancelled, or its connection ended.
    PromptClosed(String),
}

/// Why `ssh.askpass` was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AskError {
    /// The token belongs to no live connection the app started.
    Denied,
}

struct Entry {
    alias: String,
    conn: Connection,
    child: Option<Box<dyn SshChild>>,
    /// Bumped by every start and stop; a thread of an older run leaves the entry alone.
    run: u64,
    /// The askpass token of the live run.
    token: Option<String>,
}

impl Entry {
    fn view(&self, id: &str) -> SshConnectionView {
        SshConnectionView {
            host_id: id.to_owned(),
            alias: self.alias.clone(),
            state: self.conn.state().clone(),
        }
    }
}

struct Pending {
    host_id: String,
    reply: mpsc::Sender<Option<String>>,
}

type Emit = Box<dyn Fn(SshEvent) + Send + Sync>;
type Clock = Box<dyn Fn() -> Instant + Send + Sync>;

struct Inner {
    spawner: Box<dyn Spawner>,
    emit: Emit,
    clock: Clock,
    /// The CLI `ssh` runs to ask; `None` when it is not beside the app.
    askpass: Option<PathBuf>,
    poll: Duration,
    hosts: Mutex<HashMap<String, Entry>>,
    prompts: Mutex<HashMap<String, Pending>>,
}

/// The kept connections, one per host id.
pub struct SshConnections {
    inner: Arc<Inner>,
}

impl SshConnections {
    pub(crate) fn new(
        spawner: Box<dyn Spawner>,
        emit: Emit,
        clock: Clock,
        askpass: Option<PathBuf>,
        poll: Duration,
    ) -> SshConnections {
        SshConnections {
            inner: Arc::new(Inner {
                spawner,
                emit,
                clock,
                askpass,
                poll,
                hosts: Mutex::new(HashMap::new()),
                prompts: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// The real one: the system `ssh`, events to the window, the CLI beside the app.
    pub fn system(app: AppHandle) -> SshConnections {
        let askpass = std::env::current_exe()
            .ok()
            .and_then(|exe| crate::cli_path::find(&exe));
        let emit = move |event: SshEvent| {
            let _ = match event {
                SshEvent::State(view) => app.emit("ssh://state", view),
                SshEvent::Prompt(prompt) => app.emit("ssh://auth-prompt", prompt),
                SshEvent::PromptClosed(id) => {
                    app.emit("ssh://auth-closed", serde_json::json!({ "requestId": id }))
                }
            };
        };
        SshConnections::new(
            Box::new(SystemSsh),
            Box::new(emit),
            Box::new(Instant::now),
            askpass,
            POLL,
        )
    }

    /// Every host that was connected since the app started, with its state.
    pub fn list(&self) -> Vec<SshConnectionView> {
        let hosts = lock(&self.inner.hosts);
        let mut out: Vec<_> = hosts.iter().map(|(id, e)| e.view(id)).collect();
        out.sort_by(|a, b| a.alias.cmp(&b.alias));
        out
    }

    /// Starts `ssh -N` for `host`. A host already connecting or connected is
    /// left as it is.
    pub fn connect(&self, host: &SshHost) -> SshConnectionView {
        Inner::connect(&self.inner, host)
    }

    /// Stops the host's connection; `None` when it was never connected.
    pub fn disconnect(&self, id: &str) -> Option<SshConnectionView> {
        self.inner.disconnect(id)
    }

    /// Stops every connection: the app is quitting.
    pub fn kill_all(&self) {
        let children: Vec<_> = {
            let mut hosts = lock(&self.inner.hosts);
            hosts
                .values_mut()
                .filter_map(|e| {
                    e.conn.stop();
                    e.run += 1;
                    e.token = None;
                    e.child.take()
                })
                .collect()
        };
        lock(&self.inner.prompts).clear();
        for mut child in children {
            child.kill();
        }
    }

    /// `ssh.askpass`: asks the person `prompt` for the connection holding
    /// `token`. `None` is a cancel (or no answer in time, or `gone`).
    pub(crate) fn askpass(
        &self,
        token: &str,
        prompt: &str,
        gone: &dyn Fn() -> bool,
    ) -> Result<Option<String>, AskError> {
        self.inner.askpass(token, prompt, gone)
    }

    /// The person's answer (`None` to cancel) to a prompt; false when no
    /// prompt has that id any more.
    pub fn reply(&self, request_id: &str, answer: Option<String>) -> bool {
        let Some(pending) = lock(&self.inner.prompts).remove(request_id) else {
            return false;
        };
        pending.reply.send(answer).is_ok()
    }
}

impl Inner {
    fn emit_view(&self, view: SshConnectionView) {
        (self.emit)(SshEvent::State(view));
    }

    /// Runs `f` on the host's entry if `run` is still its run; tells the UI
    /// when `f` says the state changed.
    fn with_run(&self, id: &str, run: u64, f: impl FnOnce(&mut Entry, Instant) -> bool) {
        let now = (self.clock)();
        let view = {
            let mut hosts = lock(&self.hosts);
            let Some(entry) = hosts.get_mut(id).filter(|e| e.run == run) else {
                return;
            };
            if !f(entry, now) {
                return;
            }
            entry.view(id)
        };
        self.emit_view(view);
    }

    /// Drops the prompts of `id`: their askpass call sees the channel close.
    fn cancel_prompts(&self, id: &str) {
        lock(&self.prompts).retain(|_, p| p.host_id != id);
    }

    fn connect(this: &Arc<Inner>, host: &SshHost) -> SshConnectionView {
        let id = host.id.clone();
        let now = (this.clock)();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let (view, started) = {
            let mut hosts = lock(&this.hosts);
            let entry = hosts.entry(id.clone()).or_insert_with(|| Entry {
                alias: host.alias.clone(),
                conn: Connection::default(),
                child: None,
                run: 0,
                token: None,
            });
            entry.alias.clone_from(&host.alias);
            if !entry.conn.start(now) {
                return entry.view(&id);
            }
            entry.run += 1;
            let display = std::env::var_os("DISPLAY");
            let (args, env) =
                connect_command(host, this.askpass.as_deref(), &token, display.as_deref());
            let started = match this.spawner.spawn(&args, &env) {
                Ok(Spawned { child, stderr }) => {
                    entry.child = Some(child);
                    entry.token = this.askpass.is_some().then_some(token);
                    Some((entry.run, stderr))
                }
                Err(e) => {
                    entry.conn.spawn_failed(&e.to_string());
                    None
                }
            };
            (entry.view(&id), started)
        };
        this.emit_view(view.clone());
        if let Some((run, stderr)) = started {
            let done = Inner::read_stderr(this, id.clone(), run, stderr);
            let watcher = Arc::clone(this);
            std::thread::spawn(move || watcher.watch(&id, run, &done));
        }
        view
    }

    /// Feeds stderr to the state machine on a thread; the channel closes at its end.
    fn read_stderr(
        this: &Arc<Inner>,
        id: String,
        run: u64,
        mut stderr: Box<dyn Read + Send>,
    ) -> mpsc::Receiver<()> {
        let (done, rx) = mpsc::channel::<()>();
        let inner = Arc::clone(this);
        std::thread::spawn(move || {
            let mut buf = [0u8; 2048];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]);
                        inner.with_run(&id, run, |e, _| e.conn.stderr(&text));
                    }
                }
            }
            drop(done);
        });
        rx
    }

    /// Polls the run's process: settles it as connected, or records its exit.
    fn watch(&self, id: &str, run: u64, stderr_done: &mpsc::Receiver<()>) {
        let exit = loop {
            std::thread::sleep(self.poll);
            let status = {
                let mut hosts = lock(&self.hosts);
                let Some(entry) = hosts.get_mut(id).filter(|e| e.run == run) else {
                    return;
                };
                let Some(child) = entry.child.as_mut() else {
                    return;
                };
                child.try_wait()
            };
            match status {
                Ok(None) => self.with_run(id, run, |e, now| e.conn.tick(now)),
                Ok(Some(exit)) => break exit,
                Err(_) => break None,
            }
        };
        // The reason is in the last lines `ssh` wrote.
        let _ = stderr_done.recv_timeout(STDERR_DRAIN);
        self.with_run(id, run, |e, _| {
            e.child = None;
            e.token = None;
            e.conn.exited(exit)
        });
        self.cancel_prompts(id);
    }

    fn disconnect(&self, id: &str) -> Option<SshConnectionView> {
        let (view, changed, child) = {
            let mut hosts = lock(&self.hosts);
            let entry = hosts.get_mut(id)?;
            let changed = entry.conn.stop();
            entry.run += 1;
            entry.token = None;
            (entry.view(id), changed, entry.child.take())
        };
        self.cancel_prompts(id);
        if let Some(mut child) = child {
            child.kill();
        }
        if changed {
            self.emit_view(view.clone());
        }
        Some(view)
    }

    fn askpass(
        &self,
        token: &str,
        prompt: &str,
        gone: &dyn Fn() -> bool,
    ) -> Result<Option<String>, AskError> {
        if token.is_empty() {
            return Err(AskError::Denied);
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        let (host_id, run, shown) = {
            let mut hosts = lock(&self.hosts);
            let Some((id, entry)) = hosts
                .iter_mut()
                .find(|(_, e)| e.conn.live() && e.token.as_deref() == Some(token))
            else {
                return Err(AskError::Denied);
            };
            entry.conn.prompt_opened();
            lock(&self.prompts).insert(
                request_id.clone(),
                Pending {
                    host_id: id.clone(),
                    reply: tx,
                },
            );
            let text: String = prompt.chars().take(PROMPT_MAX).collect();
            let shown = SshAuthPrompt {
                request_id: request_id.clone(),
                host_id: id.clone(),
                alias: entry.alias.clone(),
                kind: prompt_kind(&text),
                prompt: text.trim_end().to_owned(),
            };
            (id.clone(), entry.run, shown)
        };
        (self.emit)(SshEvent::Prompt(shown));
        let deadline = Instant::now() + ASK_LIMIT;
        let answer = loop {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(answer) => break answer,
                Err(RecvTimeoutError::Timeout) if !gone() && Instant::now() < deadline => {}
                Err(_) => break None,
            }
        };
        lock(&self.prompts).remove(&request_id);
        self.with_run(&host_id, run, |e, now| {
            e.conn.prompt_closed(now);
            false
        });
        (self.emit)(SshEvent::PromptClosed(request_id));
        Ok(answer)
    }
}

#[derive(Deserialize)]
struct AskParams {
    token: String,
    prompt: String,
}

/// `ssh.askpass {token, prompt}` → `{answer}`, `answer` null on a cancel.
/// Only a connection the app started holds a token that is let through.
pub(crate) fn askpass_answer(
    conns: &SshConnections,
    params: &Value,
    gone: &dyn Fn() -> bool,
) -> Result<Value, AppError> {
    let p: AskParams = serde_json::from_value(params.clone())
        .map_err(|e| AppError::new("bad_request", e.to_string()))?;
    match conns.askpass(&p.token, &p.prompt, gone) {
        Ok(answer) => Ok(json!({ "answer": answer })),
        Err(AskError::Denied) => Err(AppError::new(
            "denied",
            "not an ssh connection xDev started",
        )),
    }
}

/// The `ssh.askpass` arm of the app's verbs.
pub(crate) fn askpass_verb(
    app: &AppHandle,
    req: &Request,
    gone: &dyn Fn() -> bool,
) -> Result<Value, AppError> {
    match app.try_state::<SshConnections>() {
        Some(conns) => askpass_answer(&conns, &req.params, gone),
        None => Err(AppError::new("denied", "no ssh connections")),
    }
}

fn host_by_id(state: &State<'_, AppState>, id: &str) -> Result<SshHost, CmdError> {
    let hosts = xdev_ssh::load(data_dir(state)?).map_err(crate::ssh::cmd_error)?;
    hosts
        .into_iter()
        .find(|h| h.id == id)
        .ok_or_else(|| crate::ssh::cmd_error(xdev_ssh::SshError::NotFound))
}

/// Tries the host without asking anything (`BatchMode`) and says what happened.
#[tauri::command(async)]
pub fn ssh_host_test(state: State<'_, AppState>, id: String) -> Result<SshTestOutcome, CmdError> {
    let host = host_by_id(&state, &id)?;
    let limit = Duration::from_secs(u64::from(effective_timeout(&host))) + TEST_GRACE;
    Ok(run_test(&SystemSsh, &test_argv(&host), limit))
}

/// Starts keeping a connection to the host; its states come as `ssh://state`.
#[tauri::command(async)]
pub fn ssh_connect(
    state: State<'_, AppState>,
    conns: State<'_, SshConnections>,
    id: String,
) -> Result<SshConnectionView, CmdError> {
    let host = host_by_id(&state, &id)?;
    Ok(conns.connect(&host))
}

#[tauri::command(async)]
pub fn ssh_disconnect(conns: State<'_, SshConnections>, id: String) -> Result<(), CmdError> {
    conns
        .disconnect(&id)
        .map(|_| ())
        .ok_or_else(|| crate::ssh::cmd_error(xdev_ssh::SshError::NotFound))
}

#[tauri::command(async)]
pub fn ssh_connections_list(conns: State<'_, SshConnections>) -> Vec<SshConnectionView> {
    conns.list()
}

/// The answer to an `ssh://auth-prompt`; `None` cancels it.
#[tauri::command(async)]
pub fn ssh_auth_reply(
    conns: State<'_, SshConnections>,
    request_id: String,
    answer: Option<String>,
) -> Result<(), CmdError> {
    if conns.reply(&request_id, answer) {
        Ok(())
    } else {
        Err(crate::ssh::cmd_error(xdev_ssh::SshError::NotFound))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    fn host(alias: &str) -> SshHost {
        SshHost {
            id: format!("id-{alias}"),
            alias: alias.to_owned(),
            host_name: format!("{alias}.example.com"),
            ..SshHost::default()
        }
    }

    /// Bytes pushed by the test; the end of stderr when the sender drops.
    struct ChanReader {
        rx: mpsc::Receiver<Vec<u8>>,
        left: Vec<u8>,
    }

    impl Read for ChanReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.left.is_empty() {
                match self.rx.recv() {
                    Ok(bytes) => self.left = bytes,
                    Err(_) => return Ok(0),
                }
            }
            let n = buf.len().min(self.left.len());
            buf[..n].copy_from_slice(&self.left[..n]);
            self.left.drain(..n);
            Ok(n)
        }
    }

    /// The test's handle on one fake `ssh`.
    struct Fake {
        args: Vec<String>,
        env: Vec<(String, OsString)>,
        stderr: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
        exit: Arc<Mutex<Option<Option<i32>>>>,
        killed: Arc<AtomicBool>,
    }

    impl Fake {
        fn say(&self, text: &str) {
            if let Some(tx) = lock(&self.stderr).as_ref() {
                tx.send(text.as_bytes().to_vec()).unwrap();
            }
        }

        /// Writes its last words, closes stderr and exits with `code`.
        fn exit(&self, last: &str, code: i32) {
            self.say(last);
            lock(&self.stderr).take();
            *lock(&self.exit) = Some(Some(code));
        }

        fn killed(&self) -> bool {
            self.killed.load(Ordering::SeqCst)
        }
    }

    struct FakeChild {
        exit: Arc<Mutex<Option<Option<i32>>>>,
        killed: Arc<AtomicBool>,
    }

    impl SshChild for FakeChild {
        fn try_wait(&mut self) -> io::Result<Option<Option<i32>>> {
            if self.killed.load(Ordering::SeqCst) {
                return Ok(Some(None));
            }
            Ok(*lock(&self.exit))
        }

        fn kill(&mut self) {
            self.killed.store(true, Ordering::SeqCst);
        }
    }

    #[derive(Default)]
    struct FakeSsh {
        started: Mutex<Vec<Arc<Fake>>>,
        fail: AtomicBool,
    }

    impl FakeSsh {
        fn nth(&self, i: usize) -> Arc<Fake> {
            Arc::clone(&lock(&self.started)[i])
        }

        fn count(&self) -> usize {
            lock(&self.started).len()
        }
    }

    impl Spawner for Arc<FakeSsh> {
        fn spawn(&self, args: &[String], env: &[(String, OsString)]) -> io::Result<Spawned> {
            if self.fail.load(Ordering::SeqCst) {
                return Err(io::Error::new(io::ErrorKind::NotFound, "no ssh"));
            }
            let (tx, rx) = mpsc::channel();
            let fake = Arc::new(Fake {
                args: args.to_vec(),
                env: env.to_vec(),
                stderr: Mutex::new(Some(tx)),
                exit: Arc::new(Mutex::new(None)),
                killed: Arc::new(AtomicBool::new(false)),
            });
            let child = FakeChild {
                exit: Arc::clone(&fake.exit),
                killed: Arc::clone(&fake.killed),
            };
            lock(&self.started).push(fake);
            Ok(Spawned {
                child: Box::new(child),
                stderr: Box::new(ChanReader {
                    rx,
                    left: Vec::new(),
                }),
            })
        }
    }

    struct Rig {
        ssh: Arc<FakeSsh>,
        events: Arc<Mutex<Vec<SshEvent>>>,
        /// Added to the real clock: moves the settle time along.
        skew: Arc<Mutex<Duration>>,
        conns: SshConnections,
    }

    fn rig(askpass: Option<&str>) -> Rig {
        let ssh = Arc::new(FakeSsh::default());
        let events = Arc::new(Mutex::new(Vec::new()));
        let skew = Arc::new(Mutex::new(Duration::ZERO));
        let sink = Arc::clone(&events);
        let clock_skew = Arc::clone(&skew);
        let conns = SshConnections::new(
            Box::new(Arc::clone(&ssh)),
            Box::new(move |e| lock(&sink).push(e)),
            Box::new(move || Instant::now() + *lock(&clock_skew)),
            askpass.map(PathBuf::from),
            Duration::from_millis(20),
        );
        Rig {
            ssh,
            events,
            skew,
            conns,
        }
    }

    impl Rig {
        fn state(&self, id: &str) -> Option<SshConnState> {
            self.conns
                .list()
                .into_iter()
                .find(|v| v.host_id == id)
                .map(|v| v.state)
        }

        fn states(&self) -> Vec<SshConnState> {
            lock(&self.events)
                .iter()
                .filter_map(|e| match e {
                    SshEvent::State(v) => Some(v.state.clone()),
                    _ => None,
                })
                .collect()
        }

        fn prompts(&self) -> Vec<SshAuthPrompt> {
            lock(&self.events)
                .iter()
                .filter_map(|e| match e {
                    SshEvent::Prompt(p) => Some(p.clone()),
                    _ => None,
                })
                .collect()
        }

        fn token(&self, i: usize) -> String {
            let fake = self.ssh.nth(i);
            env_of(&fake.env, TOKEN_ENV)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        }
    }

    /// Waits up to five seconds for `ok`.
    fn until(what: &str, ok: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(5);
        while !ok() {
            assert!(Instant::now() < end, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn env_of<'a>(env: &'a [(String, OsString)], key: &str) -> Option<&'a OsStr> {
        env.iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_os_str())
    }

    #[test]
    fn the_child_gets_askpass_the_token_and_a_display() {
        let cli = Path::new("/opt/xdev/xdev");
        let (args, env) = connect_command(&host("web"), Some(cli), "tok", None);
        assert_eq!(args, connect_argv(&host("web")));
        assert_eq!(env_of(&env, "SSH_ASKPASS"), Some(cli.as_os_str()));
        assert_eq!(
            env_of(&env, "SSH_ASKPASS_REQUIRE"),
            Some(OsStr::new("force"))
        );
        assert_eq!(env_of(&env, "DISPLAY"), Some(OsStr::new(":0")));
        assert_eq!(env_of(&env, TOKEN_ENV), Some(OsStr::new("tok")));
        let (_, env) = connect_command(&host("web"), Some(cli), "tok", Some(OsStr::new(":1")));
        assert_eq!(
            env_of(&env, "DISPLAY"),
            None,
            "a display that is set is kept"
        );
    }

    #[test]
    fn without_the_cli_ssh_is_told_not_to_ask() {
        let (args, env) = connect_command(&host("web"), None, "tok", None);
        assert!(env.is_empty());
        assert_eq!(&args[..2], ["-o", "BatchMode=yes"]);
        assert_eq!(&args[2..], connect_argv(&host("web")).as_slice());
    }

    #[test]
    fn a_test_is_classified_from_its_exit_and_stderr() {
        let ssh = Arc::new(FakeSsh::default());
        let runner = Arc::clone(&ssh);
        let args = test_argv(&host("web"));
        let worker = std::thread::spawn(move || run_test(&runner, &args, Duration::from_secs(5)));
        until("the test to start", || ssh.count() == 1);
        let fake = ssh.nth(0);
        assert_eq!(fake.args, test_argv(&host("web")));
        assert!(fake.env.is_empty(), "a test never asks");
        fake.exit(
            "deploy@web: Permission denied (publickey,password).\r\n",
            255,
        );
        assert_eq!(worker.join().unwrap(), SshTestOutcome::AuthRequired);
    }

    #[test]
    fn a_test_past_its_limit_is_killed_and_unreachable() {
        let ssh = Arc::new(FakeSsh::default());
        let start = Instant::now();
        let outcome = run_test(&ssh, &[], Duration::from_secs(2));
        assert_eq!(outcome, SshTestOutcome::Unreachable);
        assert!(start.elapsed() >= Duration::from_secs(2));
        assert!(ssh.nth(0).killed());
    }

    #[test]
    fn a_test_that_cannot_start_says_why() {
        let ssh = Arc::new(FakeSsh::default());
        ssh.fail.store(true, Ordering::SeqCst);
        let outcome = run_test(&ssh, &[], Duration::from_secs(2));
        assert!(matches!(outcome, SshTestOutcome::Failed(m) if m.starts_with("spawn: ")));
    }

    #[test]
    fn connect_is_connecting_then_connected_once_authenticated() {
        let r = rig(Some("/x/xdev"));
        let view = r.conns.connect(&host("web"));
        assert_eq!(view.state, SshConnState::Connecting);
        assert_eq!(view.alias, "web");
        let fake = r.ssh.nth(0);
        assert_eq!(&fake.args[..1], ["-N"]);
        fake.say("Authenticated to web.example.com ([10.0.0.1]:22) using \"publickey\".\n");
        until("connected", || {
            r.state("id-web") == Some(SshConnState::Connected)
        });
        assert_eq!(
            r.states(),
            [SshConnState::Connecting, SshConnState::Connected]
        );
    }

    #[test]
    fn a_run_still_up_after_the_settle_time_is_connected() {
        let r = rig(None);
        r.conns.connect(&host("web"));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(r.state("id-web"), Some(SshConnState::Connecting));
        *lock(&r.skew) = xdev_ssh::SETTLE;
        until("connected", || {
            r.state("id-web") == Some(SshConnState::Connected)
        });
    }

    #[test]
    fn exit_while_connecting_is_failed_with_the_reason() {
        let r = rig(None);
        r.conns.connect(&host("web"));
        r.ssh.nth(0).exit(
            "ssh: Could not resolve hostname web.example.com: Name or service not known\n",
            255,
        );
        until("failed", || {
            r.state("id-web") == Some(SshConnState::Failed("unreachable".into()))
        });
        r.conns.connect(&host("web"));
        r.ssh
            .nth(1)
            .exit("deploy@web: Permission denied (publickey).\n", 255);
        until("failed again", || {
            r.state("id-web") == Some(SshConnState::Failed("auth_required".into()))
        });
    }

    #[test]
    fn a_second_connect_while_live_starts_nothing() {
        let r = rig(None);
        r.conns.connect(&host("web"));
        let again = r.conns.connect(&host("web"));
        assert_eq!(again.state, SshConnState::Connecting);
        assert_eq!(r.ssh.count(), 1);
    }

    #[test]
    fn disconnect_kills_the_process_and_is_no_failure() {
        let r = rig(None);
        r.conns.connect(&host("web"));
        let fake = r.ssh.nth(0);
        let view = r.conns.disconnect("id-web").unwrap();
        assert_eq!(view.state, SshConnState::Disconnected);
        assert!(fake.killed());
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(r.state("id-web"), Some(SshConnState::Disconnected));
        assert_eq!(
            r.states(),
            [SshConnState::Connecting, SshConnState::Disconnected]
        );
        assert_eq!(r.conns.disconnect("id-other"), None);
    }

    #[test]
    fn a_spawn_failure_is_failed() {
        let r = rig(None);
        r.ssh.fail.store(true, Ordering::SeqCst);
        let view = r.conns.connect(&host("web"));
        assert!(matches!(view.state, SshConnState::Failed(m) if m.starts_with("spawn: ")));
    }

    #[test]
    fn quitting_kills_every_connection() {
        let r = rig(None);
        r.conns.connect(&host("web"));
        r.conns.connect(&host("db"));
        r.conns.kill_all();
        assert!(r.ssh.nth(0).killed() && r.ssh.nth(1).killed());
        assert!(
            r.conns
                .list()
                .iter()
                .all(|v| v.state == SshConnState::Disconnected)
        );
    }

    #[test]
    fn askpass_needs_the_token_of_a_live_connection() {
        let r = rig(Some("/x/xdev"));
        let no = || false;
        assert_eq!(r.conns.askpass("", "Password:", &no), Err(AskError::Denied));
        assert_eq!(
            r.conns.askpass("guess", "Password:", &no),
            Err(AskError::Denied)
        );
        r.conns.connect(&host("web"));
        let token = r.token(0);
        r.conns.disconnect("id-web");
        assert_eq!(
            r.conns.askpass(&token, "Password:", &no),
            Err(AskError::Denied),
            "a token dies with its run"
        );
        r.conns.connect(&host("web"));
        assert_ne!(r.token(1), token, "each run gets a new token");
    }

    #[test]
    fn askpass_returns_the_answer_given_in_the_dialog() {
        let r = rig(Some("/x/xdev"));
        r.conns.connect(&host("web"));
        let token = r.token(0);
        let conns = Arc::new(r);
        let asker = Arc::clone(&conns);
        let worker = std::thread::spawn(move || {
            asker
                .conns
                .askpass(&token, "deploy@web.example.com's password: ", &|| false)
        });
        until("the prompt", || conns.prompts().len() == 1);
        let prompt = conns.prompts().remove(0);
        assert_eq!(prompt.kind, SshPromptKind::Password);
        assert_eq!(prompt.alias, "web");
        assert_eq!(prompt.prompt, "deploy@web.example.com's password:");
        assert!(conns.conns.reply(&prompt.request_id, Some("s3cret".into())));
        assert_eq!(worker.join().unwrap(), Ok(Some("s3cret".into())));
        assert!(
            !conns.conns.reply(&prompt.request_id, None),
            "one reply only"
        );
        let events = lock(&conns.events);
        assert!(events.contains(&SshEvent::PromptClosed(prompt.request_id.clone())));
        let text = format!("{:?}", *events);
        assert!(!text.contains("s3cret"), "the answer is in no event");
    }

    #[test]
    fn a_cancelled_prompt_is_none() {
        let r = Arc::new(rig(Some("/x/xdev")));
        r.conns.connect(&host("web"));
        let token = r.token(0);
        let asker = Arc::clone(&r);
        let worker = std::thread::spawn(move || {
            asker
                .conns
                .askpass(&token, "Enter passphrase for key 'k':", &|| false)
        });
        until("the prompt", || r.prompts().len() == 1);
        let prompt = r.prompts().remove(0);
        assert_eq!(prompt.kind, SshPromptKind::Passphrase);
        assert!(r.conns.reply(&prompt.request_id, None));
        assert_eq!(worker.join().unwrap(), Ok(None));
    }

    #[test]
    fn a_disconnect_cancels_the_open_prompt() {
        let r = Arc::new(rig(Some("/x/xdev")));
        r.conns.connect(&host("web"));
        let token = r.token(0);
        let asker = Arc::clone(&r);
        let worker =
            std::thread::spawn(move || asker.conns.askpass(&token, "Password:", &|| false));
        until("the prompt", || r.prompts().len() == 1);
        r.conns.disconnect("id-web");
        assert_eq!(worker.join().unwrap(), Ok(None));
    }

    #[test]
    fn a_prompt_holds_the_settle_clock() {
        let r = Arc::new(rig(Some("/x/xdev")));
        r.conns.connect(&host("web"));
        let token = r.token(0);
        let asker = Arc::clone(&r);
        let worker =
            std::thread::spawn(move || asker.conns.askpass(&token, "Password:", &|| false));
        until("the prompt", || r.prompts().len() == 1);
        *lock(&r.skew) = xdev_ssh::SETTLE * 2;
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(r.state("id-web"), Some(SshConnState::Connecting));
        let prompt = r.prompts().remove(0);
        r.conns.reply(&prompt.request_id, Some("pw".into()));
        worker.join().unwrap().unwrap();
        // The clock starts again at the answer.
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(r.state("id-web"), Some(SshConnState::Connecting));
        *lock(&r.skew) = xdev_ssh::SETTLE * 4;
        until("connected", || {
            r.state("id-web") == Some(SshConnState::Connected)
        });
    }

    #[test]
    fn the_verb_checks_its_params_and_the_token() {
        let r = rig(Some("/x/xdev"));
        let no = || false;
        let bad = askpass_answer(&r.conns, &json!({ "prompt": "Password:" }), &no).unwrap_err();
        assert_eq!(bad.code, "bad_request");
        let denied = askpass_answer(
            &r.conns,
            &json!({ "token": "guess", "prompt": "Password:" }),
            &no,
        )
        .unwrap_err();
        assert_eq!(denied.code, "denied");
        r.conns.connect(&host("web"));
        let token = r.token(0);
        let gone = || true;
        let cancelled = askpass_answer(
            &r.conns,
            &json!({ "token": token, "prompt": "Password:" }),
            &gone,
        );
        assert_eq!(cancelled, Ok(json!({ "answer": null })));
    }

    #[test]
    fn a_caller_that_goes_away_cancels_its_prompt() {
        let r = rig(Some("/x/xdev"));
        r.conns.connect(&host("web"));
        let token = r.token(0);
        let gone = AtomicBool::new(true);
        let answer = r
            .conns
            .askpass(&token, "Password:", &|| gone.load(Ordering::SeqCst));
        assert_eq!(answer, Ok(None));
        assert!(lock(&r.conns.inner.prompts).is_empty());
    }
}
