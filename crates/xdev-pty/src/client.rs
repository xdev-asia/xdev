//! The app's side of `xdev-ptyd`: one connection, requests that wait for
//! their reply, and per-PTY sinks the reader thread feeds. `ensure` starts
//! the service from a copy of its binary when nothing answers.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use xdev_ipc::{Endpoint, IpcError, Stream, endpoint, read_token};

use crate::SpawnSpec;
use crate::proto::{Frame, PROTOCOL, ProtoError, SessionInfo, read_frame, write_frame};
use crate::service::{MINOR, PREFIX};

/// How long a request waits for its reply.
const REPLY_WAIT: Duration = Duration::from_secs(10);
/// How long a fresh service has to answer.
const START_WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(50);

pub type OnOutput = Box<dyn FnMut(Vec<u8>) + Send>;
pub type OnExit = Box<dyn FnOnce(Option<i32>) + Send>;

/// Where one PTY's output and exit go.
pub struct Sink {
    pub on_output: OnOutput,
    pub on_exit: OnExit,
}

/// `code` is one the UI translates: `ptyd_unreachable`, `ptyd_auth`,
/// `ptyd_version`, `ptyd_start_failed`, or what the service answered
/// (`pty_gone`, `pty_exists`, `pty_spawn`, …).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}{}", detail.as_deref().map(|d| format!(": {d}")).unwrap_or_default())]
pub struct ClientError {
    pub code: String,
    pub detail: Option<String>,
}

impl ClientError {
    fn new(code: &str, detail: impl Into<Option<String>>) -> ClientError {
        ClientError {
            code: code.to_owned(),
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Welcome {
    pub service_version: String,
    pub pid: u32,
    pub minor: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Attached {
    /// Where the replay starts; the client counts bytes from here.
    pub seq: u64,
    /// The ring had dropped some of what was asked for.
    pub truncated: bool,
}

/// The service's folder under the app's local dir. A debug build has its own
/// (`ptyd-dev`), so it never reads a release service's token or sessions, nor
/// runs its binary copies, and the other way round.
pub fn service_dir(local: &Path) -> PathBuf {
    local.join(format!("ptyd{}", xdev_ipc::CHANNEL))
}

/// What `ensure` needs to find or start the service.
#[derive(Debug, Clone)]
pub struct StartOptions {
    /// `service_dir(<local dir>)`: token, socket, `sessions.json`, binary copies.
    pub dir: PathBuf,
    /// The `xdev-ptyd` next to the app.
    pub binary: PathBuf,
    pub app_version: String,
    pub ring_mb: u8,
    /// The endpoint prefix; tests pass their own.
    pub prefix: String,
}

impl StartOptions {
    pub fn endpoint(&self) -> Endpoint {
        endpoint(&self.dir, &self.prefix, PROTOCOL)
    }
}

impl Default for StartOptions {
    fn default() -> StartOptions {
        StartOptions {
            dir: PathBuf::new(),
            binary: PathBuf::new(),
            app_version: String::new(),
            ring_mb: 2,
            prefix: PREFIX.to_owned(),
        }
    }
}

pub struct Client {
    inner: Arc<Inner>,
    welcome: Welcome,
}

struct Inner {
    w: Mutex<Stream>,
    subs: Mutex<HashMap<String, Arc<Sub>>>,
    spawns: Mutex<HashMap<String, Sender<SpawnReply>>>,
    attaches: Mutex<HashMap<String, Pending>>,
    lists: Mutex<VecDeque<Sender<Vec<SessionInfo>>>>,
    alive: AtomicBool,
    /// Set once the reader has ended and every sink heard it.
    closed: AtomicBool,
    on_close: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

/// The pid, or the service's error code.
type SpawnReply = Result<Option<u32>, String>;

struct Pending {
    tx: Sender<Result<Attached, String>>,
    truncated: bool,
}

struct Sub {
    on_output: Mutex<OnOutput>,
    on_exit: Mutex<Option<OnExit>>,
    state: Mutex<SubState>,
}

#[derive(Default)]
struct SubState {
    /// The seq past the last byte received.
    seen: u64,
    /// Why the service detached it, if it did.
    detached: Option<String>,
}

impl Sub {
    fn new(sink: Sink) -> Arc<Sub> {
        Arc::new(Sub {
            on_output: Mutex::new(sink.on_output),
            on_exit: Mutex::new(Some(sink.on_exit)),
            state: Mutex::default(),
        })
    }

    fn exit(&self, code: Option<i32>) {
        let on_exit = lock(&self.on_exit).take();
        if let Some(f) = on_exit {
            f(code);
        }
    }
}

enum Hello {
    NotRunning,
    Auth,
    /// Another user's process holds the endpoint; never sent the token.
    Foreign(String),
    Version,
    Io(String),
}

/// Connects to the service at `opts`, starting it when nothing answers.
pub fn ensure(opts: &StartOptions) -> Result<Client, ClientError> {
    let endpoint = opts.endpoint();
    match retry_auth(&endpoint, opts) {
        Ok(client) => return Ok(client),
        Err(Hello::NotRunning) => {}
        Err(e) => return Err(hello_error(e)),
    }
    let exe = install(&opts.dir, &opts.binary, &opts.app_version)
        .map_err(|e| ClientError::new("ptyd_start_failed", e.to_string()))?;
    launch(&exe, opts).map_err(|e| ClientError::new("ptyd_start_failed", e.to_string()))?;
    let start = Instant::now();
    loop {
        match hello(&endpoint, &opts.dir, &opts.app_version) {
            Ok(client) => return Ok(client),
            Err(e @ (Hello::Version | Hello::Foreign(_))) => return Err(hello_error(e)),
            // Not bound yet, or bound with its token not written yet.
            Err(_) if start.elapsed() < START_WAIT => thread::sleep(POLL),
            Err(e) => {
                let detail = match e {
                    Hello::Io(d) => Some(d),
                    _ => None,
                };
                return Err(ClientError::new("ptyd_start_failed", detail));
            }
        }
    }
}

/// A service that has just bound may not have written its token yet.
fn retry_auth(endpoint: &Endpoint, opts: &StartOptions) -> Result<Client, Hello> {
    let mut tries = 0;
    loop {
        match hello(endpoint, &opts.dir, &opts.app_version) {
            Err(Hello::Auth) if tries < 5 => {
                tries += 1;
                thread::sleep(POLL * 2);
            }
            other => return other,
        }
    }
}

fn hello_error(e: Hello) -> ClientError {
    match e {
        Hello::NotRunning => ClientError::new("ptyd_unreachable", None),
        Hello::Auth => ClientError::new("ptyd_auth", None),
        Hello::Foreign(d) => ClientError::new("ptyd_auth", d),
        Hello::Version => ClientError::new("ptyd_version", None),
        Hello::Io(d) => ClientError::new("ptyd_unreachable", d),
    }
}

/// Connects to a running service; never starts one.
pub fn connect(dir: &Path, endpoint: &Endpoint, app_version: &str) -> Result<Client, ClientError> {
    hello(endpoint, dir, app_version).map_err(hello_error)
}

fn hello(endpoint: &Endpoint, dir: &Path, app_version: &str) -> Result<Client, Hello> {
    let mut r = endpoint.connect().map_err(|e| match e {
        IpcError::NotRunning => Hello::NotRunning,
        e @ IpcError::Foreign => Hello::Foreign(e.to_string()),
        e => Hello::Io(e.to_string()),
    })?;
    let token = match read_token(dir) {
        Ok(token) => token,
        Err(IpcError::NotRunning) => return Err(Hello::Auth),
        Err(e) => return Err(Hello::Io(e.to_string())),
    };
    let io = |e: io::Error| Hello::Io(e.to_string());
    let mut w = r.try_clone().map_err(io)?;
    r.set_read_deadline(Some(START_WAIT)).map_err(io)?;
    write_frame(
        &mut w,
        &Frame::Hello {
            protocol: PROTOCOL,
            minor: MINOR,
            token,
            app_version: app_version.to_owned(),
        },
    )
    .map_err(|_| Hello::Auth)?;
    let welcome = match read_frame(&mut r) {
        Ok(Some(Frame::Welcome {
            service_version,
            pid,
            minor,
            ..
        })) => Welcome {
            service_version,
            pid,
            minor,
        },
        Ok(Some(Frame::Error { code, .. })) if code == "ptyd_version" => {
            return Err(Hello::Version);
        }
        // A service that never answers is not one this client can use.
        Err(ProtoError::Io(e)) if e.kind() == io::ErrorKind::TimedOut => {
            return Err(Hello::Io(e.to_string()));
        }
        // Closed with no answer: the token was not the service's.
        Ok(_) | Err(ProtoError::Io(_)) => return Err(Hello::Auth),
        Err(e) => return Err(Hello::Io(e.to_string())),
    };
    r.set_read_deadline(None).map_err(io)?;
    let inner = Arc::new(Inner {
        w: Mutex::new(w),
        subs: Mutex::default(),
        spawns: Mutex::default(),
        attaches: Mutex::default(),
        lists: Mutex::default(),
        alive: AtomicBool::new(true),
        closed: AtomicBool::new(false),
        on_close: Mutex::new(None),
    });
    {
        let inner = inner.clone();
        thread::spawn(move || read_loop(inner, r));
    }
    Ok(Client { inner, welcome })
}

fn read_loop(inner: Arc<Inner>, mut r: Stream) {
    while let Ok(Some(frame)) = read_frame(&mut r) {
        inner.dispatch(frame);
    }
    inner.alive.store(false, Ordering::SeqCst);
    // The service is gone, and its PTYs with it.
    let subs = std::mem::take(&mut *lock(&inner.subs));
    for sub in subs.values() {
        sub.exit(None);
    }
    lock(&inner.spawns).clear();
    lock(&inner.attaches).clear();
    lock(&inner.lists).clear();
    let on_close = {
        let mut slot = lock(&inner.on_close);
        inner.closed.store(true, Ordering::SeqCst);
        slot.take()
    };
    if let Some(f) = on_close {
        f();
    }
}

impl Inner {
    fn sub(&self, id: &str) -> Option<Arc<Sub>> {
        lock(&self.subs).get(id).cloned()
    }

    fn dispatch(&self, frame: Frame) {
        match frame {
            Frame::Output { id, seq, data } => {
                if let Some(p) = lock(&self.attaches).remove(&id) {
                    let _ = p.tx.send(Ok(Attached {
                        seq,
                        truncated: p.truncated,
                    }));
                }
                let Some(sub) = self.sub(&id) else {
                    return;
                };
                lock(&sub.state).seen = seq + data.len() as u64;
                if !data.is_empty() {
                    (lock(&sub.on_output))(data);
                }
            }
            Frame::Gap { id, .. } => {
                // TODO: a Gap on a live tab is dropped here; the next Output's
                // seq keeps `seen` right, but the view never hears that bytes
                // were lost, and its own byte count (the next attach's
                // `from_seq`) falls behind. Telling it needs a Sink callback
                // and a Channel message the terminal client knows.
                if let Some(p) = lock(&self.attaches).get_mut(&id) {
                    p.truncated = true;
                }
            }
            Frame::Exited { id, code } => {
                let sub = lock(&self.subs).remove(&id);
                if let Some(sub) = sub {
                    sub.exit(code);
                }
            }
            Frame::Detached { id, reason } => {
                if let Some(sub) = self.sub(&id) {
                    lock(&sub.state).detached = Some(reason);
                }
            }
            Frame::Spawned { id, pid } => {
                if let Some(tx) = lock(&self.spawns).remove(&id) {
                    let _ = tx.send(Ok(pid));
                }
            }
            Frame::Error { id: Some(id), code } => {
                if let Some(tx) = lock(&self.spawns).remove(&id) {
                    let _ = tx.send(Err(code));
                } else if let Some(p) = lock(&self.attaches).remove(&id) {
                    let _ = p.tx.send(Err(code));
                }
            }
            Frame::Sessions { sessions } => {
                if let Some(tx) = lock(&self.lists).pop_front() {
                    let _ = tx.send(sessions);
                }
            }
            _ => {}
        }
    }

    fn send(&self, f: &Frame) -> Result<(), ClientError> {
        write_frame(&mut *lock(&self.w), f).map_err(|e| {
            self.alive.store(false, Ordering::SeqCst);
            ClientError::new("ptyd_unreachable", e.to_string())
        })
    }
}

fn wait<T>(rx: mpsc::Receiver<Result<T, String>>) -> Result<T, ClientError> {
    match rx.recv_timeout(REPLY_WAIT) {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(code)) => Err(ClientError::new(&code, None)),
        Err(_) => Err(ClientError::new("ptyd_unreachable", None)),
    }
}

impl Client {
    pub fn welcome(&self) -> &Welcome {
        &self.welcome
    }

    /// False once the connection has dropped.
    pub fn alive(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }

    /// True once the connection has dropped and every sink has heard it.
    pub fn closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// Runs `f` once the connection drops, after every sink heard it; at
    /// once when it already has.
    pub fn on_close(&self, f: impl FnOnce() + Send + 'static) {
        let mut slot = lock(&self.inner.on_close);
        if self.inner.closed.load(Ordering::SeqCst) {
            drop(slot);
            f();
        } else {
            *slot = Some(Box::new(f));
        }
    }

    /// Starts `spec` in the service as `id`, its output going to `sink`.
    pub fn spawn(
        &self,
        id: &str,
        spec: SpawnSpec,
        meta: serde_json::Value,
        sink: Sink,
    ) -> Result<Option<u32>, ClientError> {
        let (tx, rx) = mpsc::channel();
        // Before the request: output can arrive ahead of the Spawned reply.
        let sub = Sub::new(sink);
        let old = lock(&self.inner.subs).insert(id.to_owned(), sub);
        lock(&self.inner.spawns).insert(id.to_owned(), tx);
        let frame = Frame::Spawn {
            id: id.to_owned(),
            program: spec.program,
            args: spec.args,
            env: spec
                .env
                .into_iter()
                .map(|(k, v)| (k, v.to_string_lossy().into_owned()))
                .collect(),
            cwd: spec.cwd,
            cols: spec.cols,
            rows: spec.rows,
            meta,
        };
        let result = self.inner.send(&frame).and_then(|()| wait(rx));
        if result.is_err() {
            let mut subs = lock(&self.inner.subs);
            subs.remove(id);
            if let Some(old) = old {
                subs.insert(id.to_owned(), old);
            }
        }
        result
    }

    /// Takes `id` over and replays its ring from `from_seq` into `sink`.
    pub fn attach(&self, id: &str, from_seq: u64, sink: Sink) -> Result<Attached, ClientError> {
        let (tx, rx) = mpsc::channel();
        lock(&self.inner.subs).insert(id.to_owned(), Sub::new(sink));
        lock(&self.inner.attaches).insert(
            id.to_owned(),
            Pending {
                tx,
                truncated: false,
            },
        );
        let result = self
            .inner
            .send(&Frame::Attach {
                id: id.to_owned(),
                from_seq,
            })
            .and_then(|()| wait(rx));
        if result.is_err() {
            lock(&self.inner.subs).remove(id);
        }
        result
    }

    pub fn write(&self, id: &str, data: Vec<u8>) {
        let _ = self.inner.send(&Frame::Write {
            id: id.to_owned(),
            data,
        });
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), ClientError> {
        self.inner.send(&Frame::Resize {
            id: id.to_owned(),
            cols,
            rows,
        })
    }

    /// The UI drew `n` more bytes. A PTY the service detached for lag is
    /// attached again from what was received, so it catches up from the ring.
    pub fn ack(&self, id: &str, n: u64) {
        let Some(sub) = self.inner.sub(id) else {
            return;
        };
        let mut state = lock(&sub.state);
        match state.detached.as_deref() {
            Some("lag") => {
                state.detached = None;
                let from_seq = state.seen;
                drop(state);
                let _ = self.inner.send(&Frame::Attach {
                    id: id.to_owned(),
                    from_seq,
                });
            }
            Some(_) => {}
            None => {
                drop(state);
                let _ = self.inner.send(&Frame::Ack {
                    id: id.to_owned(),
                    n,
                });
            }
        }
    }

    /// Ends the PTY; its sink hears the exit.
    pub fn kill(&self, id: &str) {
        let _ = self.inner.send(&Frame::Kill { id: id.to_owned() });
    }

    /// Stops the output of `id` here; it keeps running in the service.
    pub fn detach(&self, id: &str) {
        lock(&self.inner.subs).remove(id);
        let _ = self.inner.send(&Frame::Detach { id: id.to_owned() });
    }

    pub fn list(&self) -> Result<Vec<SessionInfo>, ClientError> {
        let (tx, rx) = mpsc::channel();
        lock(&self.inner.lists).push_back(tx);
        self.inner.send(&Frame::List)?;
        rx.recv_timeout(REPLY_WAIT)
            .map_err(|_| ClientError::new("ptyd_unreachable", None))
    }

    /// Ends every PTY and the service.
    pub fn quit_all(&self) -> Result<(), ClientError> {
        self.inner.send(&Frame::QuitAll)
    }
}

/// Copies `binary` to `<dir>/<version>/` unless an up to date copy is there,
/// and keeps the two newest version folders. The service runs from the copy,
/// so an update can replace the app's own file while it runs.
pub fn install(dir: &Path, binary: &Path, version: &str) -> io::Result<PathBuf> {
    let name = binary
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no binary name"))?;
    let folder = dir.join(version);
    let target = folder.join(name);
    let src = fs::metadata(binary)?;
    let fresh = fs::metadata(&target).is_ok_and(|dst| {
        dst.len() == src.len()
            && match (src.modified(), dst.modified()) {
                (Ok(s), Ok(d)) => s <= d,
                _ => false,
            }
    });
    if !fresh {
        fs::create_dir_all(&folder)?;
        let tmp = folder.join(format!(
            ".{}-{}.tmp",
            name.to_string_lossy(),
            std::process::id()
        ));
        fs::copy(binary, &tmp)?;
        if let Err(e) = fs::rename(&tmp, &target) {
            let _ = fs::remove_file(&tmp);
            // A copy that runs right now cannot be replaced on Windows; it is
            // the same version, so it serves.
            if !target.is_file() {
                return Err(e);
            }
        }
    }
    prune(dir, version);
    Ok(target)
}

/// Removes version folders past the two newest; the current one always stays.
/// One still in use fails to go on Windows and is left for the next start.
fn prune(dir: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut folders: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| e.file_name() != keep)
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    folders.sort_by_key(|f| std::cmp::Reverse(f.0));
    for (_, path) in folders.into_iter().skip(1) {
        let _ = fs::remove_dir_all(path);
    }
}

/// Starts the service so it is not the app's child in any way the OS or an
/// updater would end with the app.
fn launch(exe: &Path, opts: &StartOptions) -> io::Result<()> {
    let mut cmd = Command::new(exe);
    cmd.arg("--dir")
        .arg(&opts.dir)
        .arg("--ring-mb")
        .arg(opts.ring_mb.to_string())
        .arg("--prefix")
        .arg(&opts.prefix)
        // Not a worktree: a service sitting in one would keep it from being removed.
        .current_dir(&opts.dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group: a Ctrl+C or a kill of the app's group misses it.
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let flags = DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
        // Out of the app's job, when the job allows it, so ending the job
        // does not end the service.
        cmd.creation_flags(flags | CREATE_BREAKAWAY_FROM_JOB);
        if let Ok(child) = cmd.spawn() {
            reap(child);
            return Ok(());
        }
        cmd.creation_flags(flags);
    }
    // A binary copied a moment ago can be busy while another thread of the
    // app forks; it clears once that child execs.
    let mut tries = 0;
    loop {
        match cmd.spawn() {
            Ok(child) => {
                reap(child);
                return Ok(());
            }
            Err(e) if is_busy(&e) && tries < 20 => {
                tries += 1;
                thread::sleep(POLL);
            }
            Err(e) => return Err(e),
        }
    }
}

fn is_busy(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::ExecutableFileBusy
}

/// Waits on the child, so a service that ends is not left a zombie.
fn reap(mut child: std::process::Child) {
    thread::spawn(move || {
        let _ = child.wait();
    });
}

fn lock<T: ?Sized>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_debug_build_keeps_its_own_service_dir() {
        let local = Path::new("local");
        let want = if cfg!(debug_assertions) {
            "ptyd-dev"
        } else {
            "ptyd"
        };
        assert_eq!(service_dir(local), local.join(want));
    }
}
