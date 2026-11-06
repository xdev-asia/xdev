//! Remote projects: folders on saved SSH hosts. One `RemoteHub` keeps, per
//! host, an SFTP session and an exec channel (two `ssh` processes), probes
//! the host once, reconnects with backoff when either drops and stops after
//! five idle minutes. The `file*`, `filesList` and `worktreeChanges`
//! commands take an `ssh://<host id><path>` worktree and come here.
//!
//! The hub runs `ssh` with `BatchMode=yes`: keys and agents work, a
//! password or passphrase prompt fails as `remote_auth`.

pub(crate) mod files;
mod store;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};
use xdev_ssh::{
    Backoff, CMD_TIMEOUT, ExecChannel, MAX_TRIES, Probe, RemoteDirListing, RemoteError, RemoteFs,
    RemoteHostView, RemoteProject, RemoteProjectView, RemoteRef, RemoteState, RemoteTarget, Sftp,
    SshHost, SshTestOutcome, classify, exec_argv, sftp_argv,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::ssh_connect::SshChild;

/// A connection nothing used for this long is closed.
pub(crate) const IDLE: Duration = Duration::from_secs(5 * 60);
/// How often the watcher looks at a connection.
const POLL: Duration = Duration::from_secs(1);
/// How much of `ssh`'s stderr is kept to tell why it failed.
const STDERR_MAX: usize = 4096;
/// How long a failed connect waits for `ssh` to exit and say why.
const EXIT_WAIT: Duration = Duration::from_secs(1);

pub(crate) type Fs = RemoteFs<Box<dyn Write + Send>, Box<dyn Write + Send>>;

/// `NotFound` → `remote_path`; a dropped, slow or failing link →
/// `remote_offline` (the crate says `io` for `Io`).
impl From<RemoteError> for CmdError {
    fn from(e: RemoteError) -> Self {
        let code = match &e {
            RemoteError::Io(_) => "remote_offline",
            other => other.code(),
        };
        CmdError {
            code,
            detail: Some(e.to_string()),
        }
    }
}

pub(crate) fn offline(reason: &str) -> CmdError {
    CmdError {
        code: "remote_offline",
        detail: Some(reason.to_owned()),
    }
}

/// What a command answers for an `ssh://` worktree it has no remote form of.
pub(crate) fn unsupported(what: &str) -> CmdError {
    CmdError {
        code: "remote_unsupported",
        detail: Some(what.to_owned()),
    }
}

/// The remote folder `path` names, when it is an `ssh://` worktree.
pub(crate) fn remote_ref(path: &Path) -> Option<RemoteRef> {
    RemoteRef::parse(path.to_str()?)
}

/// `remote_unsupported` for an `ssh://` worktree: a command that only
/// works on a local checkout.
pub(crate) fn local_only(path: &Path, what: &str) -> Result<(), CmdError> {
    match path.to_str().is_some_and(|p| p.starts_with("ssh://")) {
        true => Err(unsupported(what)),
        false => Ok(()),
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

// Processes.

/// An `ssh` process with its pipes.
pub(crate) struct Piped {
    pub child: Box<dyn SshChild>,
    pub stdin: Box<dyn Write + Send>,
    pub stdout: Box<dyn Read + Send>,
    pub stderr: Box<dyn Read + Send>,
}

pub(crate) trait PipeSpawner: Send + Sync {
    fn spawn(&self, args: &[String]) -> io::Result<Piped>;
}

struct PipeChild(std::process::Child);

impl SshChild for PipeChild {
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>> {
        Ok(self.0.try_wait()?.map(|s| s.code()))
    }

    fn kill(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            xdev_ai::process::kill_tree(self.0.id());
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The system `ssh` with piped stdio.
struct SystemPipeSsh;

impl PipeSpawner for SystemPipeSsh {
    fn spawn(&self, args: &[String]) -> io::Result<Piped> {
        let mut cmd = Command::new(xdev_agent::system_ssh());
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        xdev_ai::process::own_group(&mut cmd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn()?;
        let missing = || io::Error::other("ssh pipe missing");
        let stdin = child.stdin.take().ok_or_else(missing)?;
        let stdout = child.stdout.take().ok_or_else(missing)?;
        let stderr = child.stderr.take().ok_or_else(missing)?;
        Ok(Piped {
            child: Box::new(PipeChild(child)),
            stdin: Box::new(stdin),
            stdout: Box::new(stdout),
            stderr: Box::new(stderr),
        })
    }
}

/// The last `STDERR_MAX` bytes a process wrote, and whether it closed the pipe.
#[derive(Clone, Default)]
struct Tail {
    bytes: Arc<Mutex<Vec<u8>>>,
    done: Arc<AtomicBool>,
}

/// The last `STDERR_MAX` bytes `r` wrote, read on a thread of its own.
fn drain(mut r: Box<dyn Read + Send>) -> Tail {
    let tail = Tail::default();
    let (out, done) = (Arc::clone(&tail.bytes), Arc::clone(&tail.done));
    let _ = std::thread::Builder::new()
        .name("ssh-stderr".into())
        .spawn(move || {
            let mut chunk = [0u8; 1024];
            while let Ok(n) = r.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let mut t = lock(&out);
                t.extend_from_slice(&chunk[..n]);
                let over = t.len().saturating_sub(STDERR_MAX);
                t.drain(..over);
            }
            done.store(true, Ordering::SeqCst);
        });
    tail
}

// Time.

pub(crate) trait Clock: Send + Sync {
    fn now(&self) -> Instant;
    /// The wait before a reconnect try.
    fn sleep(&self, d: Duration);
}

struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
    }
}

// The hub.

type Emit = Box<dyn Fn(RemoteHostView) + Send + Sync>;

/// One host's connection.
pub(crate) struct HostSession {
    host: Mutex<SshHost>,
    fs: Mutex<Option<Fs>>,
    children: Mutex<Vec<Box<dyn SshChild>>>,
    state: Mutex<RemoteState>,
    backoff: Mutex<Backoff>,
    probe: Mutex<Option<Probe>>,
    last_used: Mutex<Instant>,
    /// Held while connecting, so two callers connect once.
    connecting: Mutex<()>,
    /// An operation saw the link drop or stall.
    broken: AtomicBool,
    /// Bumped by every connect and stop; a watcher of an older run ends.
    run: AtomicU64,
}

struct Inner {
    spawner: Box<dyn PipeSpawner>,
    clock: Box<dyn Clock>,
    emit: Emit,
    /// The ControlMaster folder; `None` on Windows.
    mux: Option<PathBuf>,
    /// Start a watcher thread per connection (off in tests, which tick).
    watch: bool,
    hosts: Mutex<HashMap<String, Arc<HostSession>>>,
    /// Held across a read, change and write of the stores.
    store: Mutex<()>,
}

/// The remote connections, one per host id. Clones share them.
#[derive(Clone)]
pub struct RemoteHub {
    inner: Arc<Inner>,
}

/// `<dir>/ssh`, private to the user, for ControlMaster sockets; `None`
/// on Windows, where `ssh` has no multiplexing.
fn mux_dir(dir: Option<&Path>) -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    let dir = dir?.join("ssh");
    std::fs::create_dir_all(&dir).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).ok()?;
    }
    Some(dir)
}

impl RemoteHub {
    pub(crate) fn new(
        spawner: Box<dyn PipeSpawner>,
        clock: Box<dyn Clock>,
        emit: Emit,
        mux: Option<PathBuf>,
        watch: bool,
    ) -> RemoteHub {
        RemoteHub {
            inner: Arc::new(Inner {
                spawner,
                clock,
                emit,
                mux,
                watch,
                hosts: Mutex::new(HashMap::new()),
                store: Mutex::new(()),
            }),
        }
    }

    /// The real one: the system `ssh`, `remote://state` to the window.
    pub fn system(app: AppHandle) -> RemoteHub {
        let dir = app
            .try_state::<AppState>()
            .and_then(|s| s.local_dir.clone().or_else(|| s.data_dir.clone()));
        let emit: Emit = Box::new(move |view| {
            let _ = app.emit("remote://state", view);
        });
        RemoteHub::new(
            Box::new(SystemPipeSsh),
            Box::new(SystemClock),
            emit,
            mux_dir(dir.as_deref()),
            true,
        )
    }

    fn session(&self, host: &SshHost) -> Arc<HostSession> {
        let mut hosts = lock(&self.inner.hosts);
        let s = hosts.entry(host.id.clone()).or_insert_with(|| {
            Arc::new(HostSession {
                host: Mutex::new(host.clone()),
                fs: Mutex::new(None),
                children: Mutex::new(Vec::new()),
                state: Mutex::new(RemoteState::Idle),
                backoff: Mutex::new(Backoff::new(MAX_TRIES)),
                probe: Mutex::new(None),
                last_used: Mutex::new(self.inner.clock.now()),
                connecting: Mutex::new(()),
                broken: AtomicBool::new(false),
                run: AtomicU64::new(0),
            })
        });
        *lock(&s.host) = host.clone();
        Arc::clone(s)
    }

    fn existing(&self, host_id: &str) -> Option<Arc<HostSession>> {
        lock(&self.inner.hosts).get(host_id).cloned()
    }

    /// The host's state; `Idle` for one never connected.
    pub(crate) fn view(&self, host: &SshHost) -> RemoteHostView {
        let conn = self
            .existing(&host.id)
            .map(|s| lock(&s.state).view())
            .unwrap_or_default();
        RemoteHostView {
            host_id: host.id.clone(),
            alias: host.alias.clone(),
            conn,
        }
    }

    fn set(&self, s: &HostSession, next: RemoteState) {
        *lock(&s.state) = next;
        let host = lock(&s.host).clone();
        (self.inner.emit)(self.view(&host));
    }

    fn touch(&self, s: &HostSession) {
        *lock(&s.last_used) = self.inner.clock.now();
    }

    /// Fails for a host that is reconnecting or offline; `None` to connect.
    fn ready(&self, s: &HostSession) -> Option<Result<Probe, CmdError>> {
        match &*lock(&s.state) {
            RemoteState::Connected { .. } => lock(&s.probe).clone().map(Ok),
            RemoteState::Reconnecting { .. } => Some(Err(offline("reconnecting"))),
            RemoteState::Offline { reason } => Some(Err(offline(reason))),
            RemoteState::Idle | RemoteState::Connecting => None,
        }
    }

    /// The host's connection, opened and probed on first use.
    pub(crate) fn ensure(&self, host: &SshHost) -> Result<(Arc<HostSession>, Probe), CmdError> {
        let s = self.session(host);
        if let Some(r) = self.ready(&s) {
            self.touch(&s);
            return r.map(|p| (s, p));
        }
        let _connecting = lock(&s.connecting);
        if let Some(r) = self.ready(&s) {
            self.touch(&s);
            return r.map(|p| (Arc::clone(&s), p));
        }
        self.set(&s, RemoteState::Connecting);
        match self.open(&s) {
            Ok(probe) => {
                let run = s.run.fetch_add(1, Ordering::SeqCst) + 1;
                *lock(&s.probe) = Some(probe.clone());
                self.touch(&s);
                let next = RemoteState::after_connect(&mut lock(&s.backoff), probe.tmux, probe.git);
                self.set(&s, next);
                if self.inner.watch {
                    self.spawn_watcher(&s, run);
                }
                Ok((Arc::clone(&s), probe))
            }
            Err(e) => {
                let reason = e.detail.clone().unwrap_or_else(|| e.code.to_owned());
                self.set(&s, RemoteState::Offline { reason });
                Err(e)
            }
        }
    }

    /// Kills both processes and drops the session.
    fn drop_conn(&self, s: &HostSession) {
        *lock(&s.fs) = None;
        for mut c in lock(&s.children).drain(..) {
            c.kill();
        }
    }

    fn spawn(&self, s: &HostSession, argv: Vec<String>) -> Result<Piped, CmdError> {
        let mut args = vec!["-o".to_owned(), "BatchMode=yes".to_owned()];
        args.extend(argv);
        self.inner.spawner.spawn(&args).map_err(|e| {
            self.drop_conn(s);
            offline(&format!("spawn: {e}"))
        })
    }

    /// Starts `sftp` and `sh` on the host and probes it.
    fn open(&self, s: &HostSession) -> Result<Probe, CmdError> {
        self.drop_conn(s);
        let host = lock(&s.host).clone();
        let mux = self.inner.mux.as_deref();
        let sftp = self.spawn(s, sftp_argv(&host, mux))?;
        let sftp_err = drain(sftp.stderr);
        lock(&s.children).push(sftp.child);
        let session = Sftp::init(sftp.stdout, sftp.stdin, CMD_TIMEOUT)
            .map_err(|e| self.failed(s, &sftp_err, e))?;
        let exec = self.spawn(s, exec_argv(&host, mux))?;
        let exec_err = drain(exec.stderr);
        lock(&s.children).push(exec.child);
        let chan = ExecChannel::new(exec.stdout, exec.stdin as Box<dyn Write + Send>)
            .map_err(|e| self.failed(s, &exec_err, e))?;
        let mut fs: Fs = RemoteFs::new(session, chan);
        let probe = fs.probe().map_err(|e| self.failed(s, &exec_err, e))?;
        *lock(&s.fs) = Some(fs);
        s.broken.store(false, Ordering::SeqCst);
        Ok(probe)
    }

    /// Why a connect failed, from how `ssh` exited and what it printed.
    fn failed(&self, s: &HostSession, stderr: &Tail, e: RemoteError) -> CmdError {
        let deadline = Instant::now() + EXIT_WAIT;
        let exit = loop {
            let exited = lock(&s.children)
                .iter_mut()
                .find_map(|c| c.try_wait().ok().flatten());
            match exited {
                Some(code) => break code,
                None if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                None => break None,
            }
        };
        // What `ssh` printed before it exited: read once the pipe closes.
        while !stderr.done.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        self.drop_conn(s);
        let text = String::from_utf8_lossy(&lock(&stderr.bytes)).into_owned();
        connect_error(exit, &text, e)
    }

    /// `remote_connect`: clears `Offline` so the next try starts fresh.
    pub(crate) fn connect(&self, host: &SshHost) -> RemoteHostView {
        let s = self.session(host);
        if matches!(&*lock(&s.state), RemoteState::Offline { .. }) {
            lock(&s.backoff).reset();
            *lock(&s.state) = RemoteState::Idle;
        }
        let _ = self.ensure(host);
        self.view(host)
    }

    /// Closes the host's connection; `Idle`.
    pub(crate) fn disconnect(&self, host_id: &str) {
        if let Some(s) = self.existing(host_id) {
            self.stop(&s);
        }
    }

    fn stop(&self, s: &HostSession) {
        s.run.fetch_add(1, Ordering::SeqCst);
        self.drop_conn(s);
        lock(&s.backoff).reset();
        self.set(s, RemoteState::Idle);
    }

    /// Runs `f` on the host's session; a dropped or stalled link marks the
    /// connection for the watcher to reconnect.
    pub(crate) fn with_fs<T>(
        &self,
        host: &SshHost,
        f: impl FnOnce(&mut Fs) -> Result<T, RemoteError>,
    ) -> Result<T, CmdError> {
        let (s, _) = self.ensure(host)?;
        let mut guard = lock(&s.fs);
        let fs = guard.as_mut().ok_or_else(|| offline("closed"))?;
        let out = f(fs);
        drop(guard);
        self.touch(&s);
        out.map_err(|e| {
            if matches!(
                e,
                RemoteError::Closed | RemoteError::Timeout | RemoteError::Io(_)
            ) {
                s.broken.store(true, Ordering::SeqCst);
            }
            e.into()
        })
    }

    fn spawn_watcher(&self, s: &Arc<HostSession>, run: u64) {
        let hub = self.clone();
        let s = Arc::clone(s);
        let _ = std::thread::Builder::new()
            .name("remote-watch".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(POLL);
                    if !hub.tick(&s, run) {
                        break;
                    }
                }
            });
    }

    /// One look at a connection of run `run`: closes it when idle,
    /// reconnects it when it dropped. False once there is nothing to watch.
    pub(crate) fn tick(&self, s: &HostSession, run: u64) -> bool {
        if s.run.load(Ordering::SeqCst) != run
            || !matches!(&*lock(&s.state), RemoteState::Connected { .. })
        {
            return false;
        }
        let since = self
            .inner
            .clock
            .now()
            .saturating_duration_since(*lock(&s.last_used));
        if since >= IDLE {
            self.stop(s);
            return false;
        }
        let exited = lock(&s.children)
            .iter_mut()
            .any(|c| !matches!(c.try_wait(), Ok(None)));
        if exited || s.broken.load(Ordering::SeqCst) {
            return self.reconnect(s, run, "dropped");
        }
        true
    }

    /// Tries again after each `Backoff` delay until it connects (true) or
    /// the tries are spent (`Offline`, false).
    pub(crate) fn reconnect(&self, s: &HostSession, run: u64, reason: &str) -> bool {
        let _connecting = lock(&s.connecting);
        self.drop_conn(s);
        let mut reason = reason.to_owned();
        loop {
            if s.run.load(Ordering::SeqCst) != run {
                return false;
            }
            let next = RemoteState::after_drop(&mut lock(&s.backoff), &reason);
            let wait = match &next {
                RemoteState::Reconnecting { next_in, .. } => *next_in,
                _ => {
                    self.set(s, next);
                    return false;
                }
            };
            self.set(s, next);
            self.inner.clock.sleep(wait);
            if s.run.load(Ordering::SeqCst) != run {
                return false;
            }
            match self.open(s) {
                Ok(probe) => {
                    if s.run.load(Ordering::SeqCst) != run {
                        self.drop_conn(s);
                        return false;
                    }
                    *lock(&s.probe) = Some(probe.clone());
                    self.touch(s);
                    let next =
                        RemoteState::after_connect(&mut lock(&s.backoff), probe.tmux, probe.git);
                    self.set(s, next);
                    return true;
                }
                Err(e) => reason = e.detail.unwrap_or_else(|| e.code.to_owned()),
            }
        }
    }

    /// Closes every connection, at app exit.
    pub(crate) fn close_all(&self) {
        let all: Vec<_> = lock(&self.inner.hosts).values().cloned().collect();
        for s in all {
            s.run.fetch_add(1, Ordering::SeqCst);
            self.drop_conn(&s);
        }
    }

    #[cfg(test)]
    pub(crate) fn session_of(&self, host_id: &str) -> Option<Arc<HostSession>> {
        self.existing(host_id)
    }
}

#[cfg(test)]
impl HostSession {
    pub(crate) fn run_id(&self) -> u64 {
        self.run.load(Ordering::SeqCst)
    }

    pub(crate) fn state(&self) -> RemoteState {
        lock(&self.state).clone()
    }
}

/// The code a failed connect answers: SFTP refused, no key the host takes,
/// or the host out of reach.
pub(crate) fn connect_error(exit: Option<i32>, stderr: &str, e: RemoteError) -> CmdError {
    let line = stderr.lines().rev().find(|l| !l.trim().is_empty());
    let detail = line.map(|l| l.trim().to_owned());
    if stderr.contains("subsystem request failed") {
        return CmdError {
            code: "remote_no_sftp",
            detail,
        };
    }
    match classify(exit, stderr) {
        SshTestOutcome::AuthRequired => CmdError {
            code: "remote_auth",
            detail: Some("auth_required".to_owned()),
        },
        // Still running or no word from `ssh`: the session itself failed.
        SshTestOutcome::Ok => e.into(),
        _ if stderr.trim().is_empty() => e.into(),
        other => offline(&other.reason()),
    }
}

// Projects and targets.

/// The saved host `host_id`; `not_found` when there is none.
fn host_of(data: &Path, host_id: &str) -> Result<SshHost, CmdError> {
    xdev_ssh::load(data)
        .map_err(crate::ssh::cmd_error)?
        .into_iter()
        .find(|h| h.id == host_id)
        .ok_or_else(|| crate::ssh::cmd_error(xdev_ssh::SshError::NotFound))
}

/// The host of a known remote project at `r`; `worktree_unknown` for a
/// folder that is not one or a host that is gone.
pub(crate) fn project_host(data: &Path, r: &RemoteRef) -> Result<SshHost, CmdError> {
    let unknown = || CmdError {
        code: "worktree_unknown",
        detail: Some(r.to_string()),
    };
    let path = trim_slash(&r.path);
    let known = store::load_projects(data)?
        .iter()
        .any(|p| p.host_id == r.host_id && trim_slash(&p.path) == path);
    if !known {
        return Err(unknown());
    }
    host_of(data, &r.host_id).map_err(|_| unknown())
}

fn trim_slash(p: &str) -> &str {
    match p.trim_end_matches('/') {
        "" => "/",
        t => t,
    }
}

pub(crate) fn worktree_of(p: &RemoteProject) -> String {
    format!("ssh://{}{}", p.host_id, p.path)
}

fn project_view(hub: &RemoteHub, hosts: &[SshHost], p: RemoteProject) -> RemoteProjectView {
    let host = hosts.iter().find(|h| h.id == p.host_id);
    let (alias, state) = match host {
        Some(h) => (h.alias.clone(), hub.view(h).conn),
        None => (p.host_id.clone(), Default::default()),
    };
    RemoteProjectView {
        worktree: worktree_of(&p),
        host_alias: alias,
        state,
        project: p,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// `~` and `~/x` on the host; `None` for its home itself.
fn tilde(path: &str) -> Option<Option<&str>> {
    match path.trim() {
        "" | "~" | "~/" => Some(None),
        p => p.strip_prefix("~/").map(Some),
    }
}

/// `path` resolved on the host, when it is a folder.
fn resolve_dir(fs: &mut Fs, path: &str) -> Result<String, RemoteError> {
    let path = match tilde(path) {
        Some(rest) => {
            let home = fs.home()?;
            match rest {
                Some(rest) => format!("{}/{rest}", home.trim_end_matches('/')),
                None => home,
            }
        }
        None => path.to_owned(),
    };
    let real = fs.sftp.realpath(&path)?;
    if !fs.sftp.stat(&real)?.is_dir() {
        return Err(RemoteError::NotFound);
    }
    Ok(real)
}

fn last_segment(path: &str) -> String {
    match path.trim_end_matches('/').rsplit('/').next() {
        Some(s) if !s.is_empty() => s.to_owned(),
        _ => "/".to_owned(),
    }
}

pub(crate) fn add_project(
    hub: &RemoteHub,
    data: &Path,
    host_id: &str,
    path: &str,
    name: Option<&str>,
) -> Result<RemoteProjectView, CmdError> {
    let host = host_of(data, host_id)?;
    let real = hub.with_fs(&host, |fs| resolve_dir(fs, path))?;
    let _store = lock(&hub.inner.store);
    let mut projects = store::load_projects(data)?;
    let project = match projects
        .iter()
        .find(|p| p.host_id == host.id && p.path == real)
    {
        Some(p) => p.clone(),
        None => {
            let name = name
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map_or_else(|| last_segment(&real), str::to_owned);
            let p = RemoteProject {
                id: store::new_id(),
                host_id: host.id.clone(),
                path: real,
                name,
                keep_alive: true,
                added_ms: now_ms(),
            };
            projects.push(p.clone());
            store::save_projects(data, &projects)?;
            p
        }
    };
    Ok(project_view(hub, &[host], project))
}

pub(crate) fn remove_project(hub: &RemoteHub, data: &Path, id: &str) -> Result<(), CmdError> {
    let _store = lock(&hub.inner.store);
    let mut projects = store::load_projects(data)?;
    let before = projects.len();
    projects.retain(|p| p.id != id);
    if projects.len() == before {
        return Err(crate::ssh::cmd_error(xdev_ssh::SshError::NotFound));
    }
    store::save_projects(data, &projects)
}

/// The project stored for `r`, for its keep-alive setting.
pub(crate) fn project_at(data: &Path, r: &RemoteRef) -> Option<RemoteProject> {
    let path = trim_slash(&r.path).to_owned();
    store::load_projects(data)
        .ok()?
        .into_iter()
        .find(|p| p.host_id == r.host_id && trim_slash(&p.path) == path)
}

/// Where a terminal or agent runs on a host: a remote project (`cwd` is
/// its `ssh://` path) or, with `remote_host`, a local checkout's remote
/// target. `None` for a local launch. The host is connected and probed
/// first, so tmux is known.
pub(crate) fn launch_spec(
    hub: &RemoteHub,
    data: &Path,
    cwd: &Path,
    remote_host: Option<&str>,
    declared: Vec<String>,
) -> Result<Option<crate::remote_launch::RemoteSpec>, CmdError> {
    let (host, path, keep) = match (remote_ref(cwd), remote_host) {
        (Some(r), host_id) => {
            if host_id.is_some_and(|h| h != r.host_id) {
                return Err(crate::workspace::bad_arg("remote_host"));
            }
            let host = project_host(data, &r)?;
            let keep = project_at(data, &r).is_none_or(|p| p.keep_alive);
            (host, r.path, keep)
        }
        (None, Some(host_id)) => {
            let target = target_of(data, cwd)?
                .filter(|t| t.host_id == host_id)
                .ok_or_else(|| crate::workspace::bad_arg("remote_host"))?;
            (host_of(data, host_id)?, target.path, true)
        }
        (None, None) => return Ok(None),
    };
    let (_, probe) = hub.ensure(&host)?;
    Ok(Some(crate::remote_launch::RemoteSpec {
        worktree: format!("ssh://{}{path}", host.id),
        mux: hub.mux(),
        keep_alive: keep && probe.tmux,
        host,
        path,
        declared,
    }))
}

/// The remote target of the repo that `cwd` (the repo or one of its
/// worktrees) belongs to.
fn target_of(data: &Path, cwd: &Path) -> Result<Option<RemoteTarget>, CmdError> {
    let key = xdev_workspace::path_key(cwd);
    let reg = xdev_workspace::Registry::load(data)?;
    let repo = reg
        .repos
        .iter()
        .find(|r| xdev_workspace::path_key(&r.path) == key)
        .map(|r| r.id.clone())
        .or_else(|| {
            reg.worktrees
                .iter()
                .find(|m| xdev_workspace::path_key(&m.path) == key)
                .map(|m| m.repo_id.clone())
        });
    Ok(match repo {
        Some(id) => store::load_targets(data)?.remove(&id),
        None => None,
    })
}

impl RemoteHub {
    pub(crate) fn mux(&self) -> Option<PathBuf> {
        self.inner.mux.clone()
    }
}

// Commands.

#[tauri::command(async)]
pub fn remote_projects_list(
    state: State<'_, AppState>,
    hub: State<'_, RemoteHub>,
) -> Result<Vec<RemoteProjectView>, CmdError> {
    let data = data_dir(&state)?;
    let hosts = xdev_ssh::load(data).map_err(crate::ssh::cmd_error)?;
    Ok(store::load_projects(data)?
        .into_iter()
        .map(|p| project_view(&hub, &hosts, p))
        .collect())
}

/// Resolves `path` on the host (`~` is its home) and saves it as a project
/// when it is a folder.
#[tauri::command(async)]
pub fn remote_project_add(
    state: State<'_, AppState>,
    hub: State<'_, RemoteHub>,
    host_id: String,
    path: String,
    name: Option<String>,
) -> Result<RemoteProjectView, CmdError> {
    add_project(&hub, data_dir(&state)?, &host_id, &path, name.as_deref())
}

#[tauri::command(async)]
pub fn remote_project_remove(
    state: State<'_, AppState>,
    hub: State<'_, RemoteHub>,
    id: String,
) -> Result<(), CmdError> {
    remove_project(&hub, data_dir(&state)?, &id)
}

/// The subfolders of `path` on the host; its home when `None`.
#[tauri::command(async)]
pub fn remote_browse(
    state: State<'_, AppState>,
    hub: State<'_, RemoteHub>,
    host_id: String,
    path: Option<String>,
) -> Result<RemoteDirListing, CmdError> {
    let host = host_of(data_dir(&state)?, &host_id)?;
    let path = path.unwrap_or_default();
    hub.with_fs(&host, |fs| {
        let dir = resolve_dir(fs, &path)?;
        fs.list_dirs(&dir).map_err(|e| match e {
            RemoteError::BadPath(_) => RemoteError::NotFound,
            e => e,
        })
    })
}

#[tauri::command(async)]
pub fn remote_connect(
    state: State<'_, AppState>,
    hub: State<'_, RemoteHub>,
    host_id: String,
) -> Result<RemoteHostView, CmdError> {
    let host = host_of(data_dir(&state)?, &host_id)?;
    Ok(hub.connect(&host))
}

#[tauri::command(async)]
pub fn remote_disconnect(hub: State<'_, RemoteHub>, host_id: String) -> Result<(), CmdError> {
    hub.disconnect(&host_id);
    Ok(())
}

/// Every saved host with its connection state.
#[tauri::command(async)]
pub fn remote_hosts_state(
    state: State<'_, AppState>,
    hub: State<'_, RemoteHub>,
) -> Result<Vec<RemoteHostView>, CmdError> {
    let hosts = xdev_ssh::load(data_dir(&state)?).map_err(crate::ssh::cmd_error)?;
    Ok(hosts.iter().map(|h| hub.view(h)).collect())
}

#[tauri::command(async)]
pub fn remote_target_get(
    state: State<'_, AppState>,
    repo_id: String,
) -> Result<Option<RemoteTarget>, CmdError> {
    Ok(store::load_targets(data_dir(&state)?)?.remove(&repo_id))
}

/// `None` clears it. The host must be saved and the path absolute.
#[tauri::command(async)]
pub fn remote_target_set(
    state: State<'_, AppState>,
    hub: State<'_, RemoteHub>,
    repo_id: String,
    target: Option<RemoteTarget>,
) -> Result<(), CmdError> {
    set_target(&hub, data_dir(&state)?, &repo_id, target)
}

pub(crate) fn set_target(
    hub: &RemoteHub,
    data: &Path,
    repo_id: &str,
    target: Option<RemoteTarget>,
) -> Result<(), CmdError> {
    if let Some(t) = &target {
        host_of(data, &t.host_id)?;
        if !t.path.starts_with('/') {
            return Err(CmdError {
                code: "remote_path",
                detail: Some(t.path.clone()),
            });
        }
    }
    let _store = lock(&hub.inner.store);
    let mut targets = store::load_targets(data)?;
    match target {
        Some(t) => targets.insert(repo_id.to_owned(), t),
        None => targets.remove(repo_id),
    };
    store::save_targets(data, &targets)
}
