//! `xdev-ptyd`: holds the app's PTYs in a process of their own, so they
//! outlive a quit, an update or a crash of the UI.
//!
//! Each PTY's output goes to its ring first, then to the one client that is
//! attached. A client that leaves more than `window` bytes unacked stops
//! getting output (the ring keeps it); after `lag` like that it is detached,
//! and the child keeps running.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use xdev_ipc::{Endpoint, IpcError, Stream, endpoint, new_token, token_eq};

use crate::proto::{DATA_MAX, Frame, PROTOCOL, SessionInfo, read_frame, write_frame};
use crate::ring::Ring;
use crate::snapshot;
use crate::{Session, SpawnSpec, WINDOW};

/// The endpoint prefix; `xdev_ipc::endpoint` adds the user, channel and major.
pub const PREFIX: &str = "xdev-ptyd";
/// What the service writes on every spawn and exit, for a look from outside.
pub const SESSIONS_FILE: &str = "sessions.json";
/// The minor protocol version; a client may use what the Welcome lists.
pub const MINOR: u32 = 1;

/// A client that sends no Hello in this long is dropped.
const HELLO_WAIT: Duration = Duration::from_secs(5);
/// How often lag and idleness are looked at.
const TICK: Duration = Duration::from_millis(200);
/// The largest Output frame the service sends.
const CHUNK: usize = 256 * 1024;

pub struct Config {
    /// Holds the token, `sessions.json` and, off Windows, the socket.
    pub dir: PathBuf,
    pub endpoint: Endpoint,
    /// Ring bytes per PTY.
    pub ring: usize,
    /// Unacked bytes a client may have before its output pauses.
    pub window: u64,
    /// How long a paused client stays attached.
    pub lag: Duration,
    /// The service ends this long after it last had a client or a live PTY.
    pub idle_exit: Duration,
    pub version: String,
    /// Save the last output of each PTY under `dir` for a later restore.
    pub snapshots: bool,
    /// The least time between two snapshots of one PTY.
    pub snapshot_every: Duration,
}

impl Config {
    pub fn new(dir: PathBuf, ring: usize) -> Config {
        Config {
            endpoint: endpoint(&dir, PREFIX, PROTOCOL),
            dir,
            ring,
            window: WINDOW as u64,
            lag: Duration::from_secs(10),
            idle_exit: Duration::from_secs(15),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            snapshots: true,
            snapshot_every: Duration::from_secs(5),
        }
    }
}

/// What the Welcome lists: `clear` is `ClearScrollback`, `snapshot` is the
/// saved output.
fn features(snapshots: bool) -> Vec<String> {
    let mut f = vec!["ring".to_owned()];
    if snapshots {
        f.push("snapshot".to_owned());
    }
    f.push("clear".to_owned());
    f
}

/// A running service; `wait` blocks until it ends.
pub struct Service {
    shared: Arc<Shared>,
}

struct Shared {
    cfg: Config,
    token: String,
    ptys: Mutex<HashMap<String, Arc<Pty>>>,
    clients: AtomicUsize,
    next_conn: AtomicU64,
    quit: Mutex<bool>,
    done: Condvar,
}

struct Pty {
    id: String,
    program: String,
    cwd: String,
    started_ms: i64,
    meta: serde_json::Value,
    pid: OnceLock<Option<u32>>,
    session: Mutex<Option<Session>>,
    out: Mutex<Out>,
    /// Set by `Kill`: the person closed the tab, so no snapshot is kept.
    killed: AtomicBool,
    /// Held while a snapshot is written or removed, so a late write cannot
    /// bring back a file `Kill` just deleted.
    snap_io: Mutex<()>,
    last_input_ms: AtomicI64,
}

struct Out {
    ring: Ring,
    client: Option<Client>,
    exited: Option<Option<i32>>,
    last_output_ms: i64,
    /// Output since the last snapshot.
    dirty: bool,
    snap_at: Instant,
}

/// The connection a PTY's output goes to.
struct Client {
    conn: Arc<Conn>,
    /// The seq past the last byte sent.
    sent: u64,
    unacked: u64,
    /// Since when `unacked` has been a full window.
    behind_since: Option<Instant>,
}

struct Conn {
    id: u64,
    tx: Sender<Frame>,
}

impl Conn {
    fn send(&self, f: Frame) {
        // A closed writer means the client is gone; its reader detaches it.
        let _ = self.tx.send(f);
    }
}

/// Binds the endpoint, writes a fresh token and starts serving. `InUse` when
/// another service already answers there.
pub fn start(cfg: Config) -> Result<Service, IpcError> {
    let listener = cfg.endpoint.bind()?;
    // After the bind: a token written before it would lock out the clients
    // of a service that is still running.
    let token = new_token(&cfg.dir)?;
    let shared = Arc::new(Shared {
        cfg,
        token,
        ptys: Mutex::default(),
        clients: AtomicUsize::new(0),
        next_conn: AtomicU64::new(1),
        quit: Mutex::new(false),
        done: Condvar::new(),
    });
    if shared.cfg.snapshots {
        let _ = snapshot::prune(&shared.cfg.dir, SystemTime::now());
    } else {
        let _ = snapshot::clear_all(&shared.cfg.dir);
    }
    shared.save_sessions();
    {
        let shared = shared.clone();
        thread::spawn(move || {
            while let Ok(stream) = listener.accept() {
                if shared.quitting() {
                    break;
                }
                let shared = shared.clone();
                thread::spawn(move || serve(shared, stream));
            }
        });
    }
    {
        let shared = Arc::downgrade(&shared);
        thread::spawn(move || tick(shared));
    }
    Ok(Service { shared })
}

impl Service {
    /// Blocks until a QuitAll, or `idle_exit` with no client and no live PTY;
    /// then ends every PTY.
    pub fn wait(self) {
        let mut quit = lock(&self.shared.quit);
        while !*quit {
            quit = self
                .shared
                .done
                .wait(quit)
                .unwrap_or_else(PoisonError::into_inner);
        }
        drop(quit);
        self.shared.end_all();
        // Wakes the accept loop so it drops the listener and frees the name.
        let _ = self.shared.cfg.endpoint.connect();
    }
}

impl Shared {
    fn quitting(&self) -> bool {
        *lock(&self.quit)
    }

    fn quit(&self) {
        *lock(&self.quit) = true;
        self.done.notify_all();
    }

    fn get(&self, id: &str) -> Option<Arc<Pty>> {
        lock(&self.ptys).get(id).cloned()
    }

    fn end_all(&self) {
        // Taken out first, so killing never runs under the lock.
        let ptys = std::mem::take(&mut *lock(&self.ptys));
        for pty in ptys.values() {
            pty.end();
            self.snapshot(pty, true);
        }
        self.save_sessions();
    }

    fn infos(&self) -> Vec<SessionInfo> {
        let mut infos: Vec<SessionInfo> = lock(&self.ptys).values().map(|p| p.info()).collect();
        infos.sort_by_key(|i| i.started_ms);
        infos
    }

    /// Temp then rename, so a reader never sees half a file. Best effort.
    fn save_sessions(&self) {
        let Ok(json) = serde_json::to_vec_pretty(&self.infos()) else {
            return;
        };
        let tmp = self
            .cfg
            .dir
            .join(format!(".{SESSIONS_FILE}-{}.tmp", std::process::id()));
        if fs::write(&tmp, json)
            .and_then(|()| fs::rename(&tmp, self.cfg.dir.join(SESSIONS_FILE)))
            .is_err()
        {
            let _ = fs::remove_file(&tmp);
        }
    }

    /// Saves the tail of the ring of `pty` when it has new output (`force`
    /// skips the wait between two saves). The bytes are copied under the
    /// lock and written outside it. Best effort.
    fn snapshot(&self, pty: &Pty, force: bool) {
        if !self.cfg.snapshots || pty.killed.load(Ordering::SeqCst) {
            return;
        }
        let bytes = {
            let mut out = lock(&pty.out);
            if !out.dirty || !(force || out.snap_at.elapsed() >= self.cfg.snapshot_every) {
                return;
            }
            out.dirty = false;
            out.snap_at = Instant::now();
            out.ring.tail(snapshot::SNAPSHOT_MAX)
        };
        let _io = lock(&pty.snap_io);
        if !pty.killed.load(Ordering::SeqCst) {
            let _ = snapshot::write(&self.cfg.dir, &pty.id, &bytes);
        }
    }

    fn live(&self) -> bool {
        lock(&self.ptys)
            .values()
            .any(|p| lock(&p.out).exited.is_none())
    }
}

impl Pty {
    fn info(&self) -> SessionInfo {
        let out = lock(&self.out);
        SessionInfo {
            id: self.id.clone(),
            pid: self.pid.get().copied().flatten(),
            program: self.program.clone(),
            cwd: self.cwd.clone(),
            started_ms: self.started_ms,
            last_output_ms: out.last_output_ms,
            last_input_ms: self.last_input_ms.load(Ordering::Relaxed),
            meta: self.meta.clone(),
            attached: out.client.is_some(),
            exited: out.exited.flatten(),
        }
    }

    fn end(&self) {
        // Dropping the session kills the child.
        let session = lock(&self.session).take();
        drop(session);
    }

    fn write(&self, data: Vec<u8>) {
        if let Some(s) = lock(&self.session).as_ref() {
            s.write(data);
            self.last_input_ms.store(now_ms(), Ordering::Relaxed);
        }
    }
}

/// Sends the client what the ring holds past what it was sent, while its
/// window has room.
fn feed(id: &str, out: &mut Out, window: u64) {
    let Out { ring, client, .. } = out;
    let Some(c) = client.as_mut() else {
        return;
    };
    while c.sent < ring.end() && c.unacked < window {
        let room = (window - c.unacked).min(CHUNK as u64) as usize;
        let (data, lost) = ring.read(c.sent, room);
        if lost > 0 {
            c.conn.send(Frame::Gap {
                id: id.to_owned(),
                lost,
            });
            c.sent += lost;
        }
        if data.is_empty() {
            break;
        }
        let len = data.len() as u64;
        c.conn.send(Frame::Output {
            id: id.to_owned(),
            seq: c.sent,
            data,
        });
        c.sent += len;
        c.unacked += len;
    }
    c.behind_since = if c.unacked >= window {
        Some(c.behind_since.unwrap_or_else(Instant::now))
    } else {
        None
    };
}

/// Detaches clients that stayed a full window behind for `lag`, and ends the
/// service once it has been idle for `idle_exit`.
fn tick(shared: Weak<Shared>) {
    let mut idle_since: Option<Instant> = None;
    loop {
        thread::sleep(TICK);
        let Some(shared) = shared.upgrade() else {
            return;
        };
        if shared.quitting() {
            return;
        }
        let ptys: Vec<Arc<Pty>> = lock(&shared.ptys).values().cloned().collect();
        for pty in &ptys {
            shared.snapshot(pty, false);
            let mut out = lock(&pty.out);
            let lagging = out
                .client
                .as_ref()
                .and_then(|c| c.behind_since)
                .is_some_and(|since| since.elapsed() >= shared.cfg.lag);
            if lagging && let Some(c) = out.client.take() {
                c.conn.send(Frame::Detached {
                    id: pty.id.clone(),
                    reason: "lag".to_owned(),
                });
            }
        }
        if shared.clients.load(Ordering::SeqCst) > 0 || shared.live() {
            idle_since = None;
        } else if idle_since.get_or_insert_with(Instant::now).elapsed() >= shared.cfg.idle_exit {
            shared.quit();
            return;
        }
    }
}

/// One client connection: Hello first, then frames until it closes.
fn serve(shared: Arc<Shared>, stream: Stream) {
    let mut reader = stream;
    let Ok(mut writer) = reader.try_clone() else {
        return;
    };
    // A peer that says nothing is dropped, on every OS.
    if reader.set_read_deadline(Some(HELLO_WAIT)).is_err() {
        return;
    }
    // A wrong token ends the connection before any other frame is read.
    let Ok(Some(Frame::Hello {
        protocol, token, ..
    })) = read_frame(&mut reader)
    else {
        return;
    };
    if !token_eq(&shared.token, &token) {
        return;
    }
    if protocol != PROTOCOL {
        let _ = write_frame(
            &mut writer,
            &Frame::Error {
                id: None,
                code: "ptyd_version".to_owned(),
            },
        );
        return;
    }
    if reader.set_read_deadline(None).is_err() {
        return;
    }
    let (tx, rx) = mpsc::channel::<Frame>();
    let conn = Arc::new(Conn {
        id: shared.next_conn.fetch_add(1, Ordering::Relaxed),
        tx,
    });
    conn.send(Frame::Welcome {
        protocol: PROTOCOL,
        minor: MINOR,
        features: features(shared.cfg.snapshots),
        service_version: shared.cfg.version.clone(),
        pid: std::process::id(),
    });
    // Writes go through one thread, so a slow client never blocks a PTY.
    thread::spawn(move || {
        for frame in rx {
            if write_frame(&mut writer, &frame).is_err() {
                break;
            }
        }
    });
    shared.clients.fetch_add(1, Ordering::SeqCst);
    while let Ok(Some(frame)) = read_frame(&mut reader) {
        handle(&shared, &conn, frame);
    }
    // Gone: its PTYs keep running, detached.
    let ptys: Vec<Arc<Pty>> = lock(&shared.ptys).values().cloned().collect();
    for pty in ptys {
        let mut out = lock(&pty.out);
        if out.client.as_ref().is_some_and(|c| c.conn.id == conn.id) {
            out.client = None;
        }
    }
    shared.clients.fetch_sub(1, Ordering::SeqCst);
}

fn handle(shared: &Arc<Shared>, conn: &Arc<Conn>, frame: Frame) {
    let window = shared.cfg.window;
    match frame {
        Frame::Spawn {
            id,
            program,
            args,
            env,
            cwd,
            cols,
            rows,
            meta,
        } => {
            let spec = SpawnSpec {
                program,
                args,
                env: env
                    .into_iter()
                    .map(|(k, v)| (k, OsString::from(v)))
                    .collect(),
                cwd,
                cols,
                rows,
            };
            let reply = match spawn(shared, conn, id.clone(), spec, meta) {
                Ok(pid) => Frame::Spawned { id, pid },
                Err(code) => Frame::Error {
                    id: Some(id),
                    code: code.to_owned(),
                },
            };
            conn.send(reply);
        }
        Frame::Attach { id, from_seq } => attach(shared, conn, &id, from_seq),
        Frame::Detach { id } => {
            if let Some(pty) = shared.get(&id) {
                let mut out = lock(&pty.out);
                if out.client.as_ref().is_some_and(|c| c.conn.id == conn.id) {
                    out.client = None;
                }
            }
        }
        Frame::Write { id, data } => {
            if let Some(pty) = shared.get(&id) {
                pty.write(data);
            }
        }
        Frame::Resize { id, cols, rows } => {
            let resized = shared.get(&id).map(|pty| {
                lock(&pty.session)
                    .as_ref()
                    .map(|s| s.resize(cols, rows).map_err(|e| e.code()))
            });
            if let Some(Some(Err(code))) = resized {
                conn.send(Frame::Error {
                    id: Some(id),
                    code: code.to_owned(),
                });
            }
        }
        Frame::Ack { id, n } => {
            if let Some(pty) = shared.get(&id) {
                let mut out = lock(&pty.out);
                if let Some(c) = out.client.as_mut().filter(|c| c.conn.id == conn.id) {
                    c.unacked = c.unacked.saturating_sub(n);
                    feed(&id, &mut out, window);
                }
            }
        }
        Frame::Kill { id } => {
            let pty = lock(&shared.ptys).remove(&id);
            if let Some(pty) = pty {
                pty.killed.store(true, Ordering::SeqCst);
                pty.end();
                let _io = lock(&pty.snap_io);
                let _ = snapshot::remove(&shared.cfg.dir, &pty.id);
            }
            shared.save_sessions();
        }
        Frame::List => conn.send(Frame::Sessions {
            sessions: shared.infos(),
        }),
        Frame::QuitAll => {
            shared.end_all();
            shared.quit();
        }
        // Frames only the service sends, or ones this build does not act on.
        _ => {}
    }
}

/// Starts `spec` attached to `conn`; the error is a code the app knows.
fn spawn(
    shared: &Arc<Shared>,
    conn: &Arc<Conn>,
    id: String,
    spec: SpawnSpec,
    meta: serde_json::Value,
) -> Result<Option<u32>, &'static str> {
    let mut ptys = lock(&shared.ptys);
    if ptys.get(&id).is_some_and(|p| lock(&p.out).exited.is_none()) {
        return Err("pty_exists");
    }
    let now = now_ms();
    let pty = Arc::new(Pty {
        id: id.clone(),
        program: spec.program.display().to_string(),
        cwd: spec.cwd.display().to_string(),
        started_ms: now,
        meta,
        pid: OnceLock::new(),
        session: Mutex::new(None),
        out: Mutex::new(Out {
            ring: Ring::new(shared.cfg.ring),
            client: Some(Client {
                conn: conn.clone(),
                sent: 0,
                unacked: 0,
                behind_since: None,
            }),
            exited: None,
            last_output_ms: now,
            dirty: false,
            snap_at: Instant::now(),
        }),
        killed: AtomicBool::new(false),
        snap_io: Mutex::new(()),
        last_input_ms: AtomicI64::new(now),
    });
    let window = shared.cfg.window;
    // Strong refs: the callbacks live on the session's threads, which end
    // with the child, so a killed PTY still reports its exit.
    let on_output = {
        let pty = pty.clone();
        move |bytes: Vec<u8>| {
            let mut out = lock(&pty.out);
            out.ring.push(&bytes);
            out.last_output_ms = now_ms();
            out.dirty = true;
            feed(&pty.id, &mut out, window);
        }
    };
    let on_exit = {
        let (pty, shared) = (pty.clone(), Arc::downgrade(shared));
        move |code: Option<i32>| {
            {
                let mut out = lock(&pty.out);
                out.exited = Some(code);
                if let Some(c) = &out.client {
                    c.conn.send(Frame::Exited {
                        id: pty.id.clone(),
                        code,
                    });
                }
            }
            if let Some(shared) = shared.upgrade() {
                shared.snapshot(&pty, true);
                shared.save_sessions();
            }
        }
    };
    let session =
        Session::spawn_with_window(spec, usize::MAX, on_output, on_exit).map_err(|e| e.code())?;
    let pid = session.pid();
    let _ = pty.pid.set(pid);
    *lock(&pty.session) = Some(session);
    if let Some(old) = ptys.insert(id, pty) {
        old.killed.store(true, Ordering::SeqCst);
        old.end();
    }
    drop(ptys);
    shared.save_sessions();
    Ok(pid)
}

/// Moves `id` to `conn` and replays its ring from `from_seq`. The first
/// frame back is a Gap when output was lost, then always an Output (maybe
/// empty) whose seq is where the replay starts.
fn attach(shared: &Arc<Shared>, conn: &Arc<Conn>, id: &str, from_seq: u64) {
    let Some(pty) = shared.get(id) else {
        conn.send(Frame::Error {
            id: Some(id.to_owned()),
            code: "pty_gone".to_owned(),
        });
        return;
    };
    let mut out = lock(&pty.out);
    if let Some(old) = out.client.take()
        && old.conn.id != conn.id
    {
        old.conn.send(Frame::Detached {
            id: id.to_owned(),
            reason: "taken".to_owned(),
        });
    }
    let (data, lost) = out.ring.read(from_seq, CHUNK.min(DATA_MAX));
    if lost > 0 {
        conn.send(Frame::Gap {
            id: id.to_owned(),
            lost,
        });
    }
    let seq = from_seq.min(out.ring.end()) + lost;
    let len = data.len() as u64;
    conn.send(Frame::Output {
        id: id.to_owned(),
        seq,
        data,
    });
    out.client = Some(Client {
        conn: conn.clone(),
        sent: seq + len,
        unacked: len,
        behind_since: None,
    });
    feed(id, &mut out, shared.cfg.window);
    if let Some(code) = out.exited {
        conn.send(Frame::Exited {
            id: id.to_owned(),
            code,
        });
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}
