//! Hub, store and routing tests with fake `ssh` processes: in-memory pipes,
//! an SFTP server and a shell that answer like a host, and a clock that
//! only moves when told. No network.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use xdev_ssh::{
    MAX_TRIES, RemoteConnState, RemoteError, RemoteProject, RemoteRef, RemoteState, RemoteTarget,
    SshHost,
};

use xdev_workspace::Eol;

use super::*;
use crate::ssh_connect::SshChild;

// Pipes.

type PipeState = (Mutex<(VecDeque<u8>, bool)>, Condvar);

/// One direction of a process's stdio: reads block until bytes come or
/// the pipe closes.
#[derive(Clone, Default)]
struct Pipe(Arc<PipeState>);

impl Pipe {
    fn push(&self, bytes: &[u8]) {
        let (m, cv) = &*self.0;
        m.lock().unwrap().0.extend(bytes);
        cv.notify_all();
    }

    fn close(&self) {
        let (m, cv) = &*self.0;
        m.lock().unwrap().1 = true;
        cv.notify_all();
    }
}

impl Read for Pipe {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let (m, cv) = &*self.0;
        let mut g = m.lock().unwrap();
        while g.0.is_empty() && !g.1 {
            g = cv.wait(g).unwrap();
        }
        let n = buf.len().min(g.0.len());
        for (i, b) in g.0.drain(..n).enumerate() {
            buf[i] = b;
        }
        Ok(n)
    }
}

impl Write for Pipe {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.0.0.lock().unwrap().1 {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        self.push(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// The host.

const ROOT: &str = "/home/dev/app";
const DIR: u32 = 0o040_755;
const FILE: u32 = 0o100_644;

/// The files on the fake host and what its shell answers.
#[derive(Default)]
struct Host {
    files: HashMap<String, Vec<u8>>,
    dirs: Vec<String>,
    tmux: bool,
    /// `git status --porcelain=v1 -z` output.
    status: Vec<u8>,
    /// Names the link check finds to be links.
    links: Vec<String>,
}

fn u32_at(b: &[u8], at: &mut usize) -> u32 {
    let v = u32::from_be_bytes(b[*at..*at + 4].try_into().unwrap());
    *at += 4;
    v
}

fn str_at(b: &[u8], at: &mut usize) -> Vec<u8> {
    let n = u32_at(b, at) as usize;
    let v = b[*at..*at + n].to_vec();
    *at += n;
    v
}

fn sstr(b: &[u8]) -> Vec<u8> {
    let mut out = (b.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(b);
    out
}

fn frame(kind: u8, id: Option<u32>, rest: &[u8]) -> Vec<u8> {
    let mut body = vec![kind];
    if let Some(id) = id {
        body.extend_from_slice(&id.to_be_bytes());
    }
    body.extend_from_slice(rest);
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend(body);
    out
}

fn status(id: u32, code: u32) -> Vec<u8> {
    let mut rest = code.to_be_bytes().to_vec();
    rest.extend(sstr(b"status"));
    rest.extend(sstr(b""));
    frame(101, Some(id), &rest)
}

fn attrs(size: u64, perms: u32) -> Vec<u8> {
    // Size, permissions, times.
    let mut a = (0x01u32 | 0x04 | 0x08).to_be_bytes().to_vec();
    a.extend(size.to_be_bytes());
    a.extend(perms.to_be_bytes());
    a.extend(7u32.to_be_bytes());
    a.extend(7u32.to_be_bytes());
    a
}

/// One SFTP reply: INIT, REALPATH, STAT/LSTAT, OPEN, READ and CLOSE; any
/// other request fails as unsupported.
fn sftp_reply(host: &Host, body: &[u8]) -> Vec<u8> {
    let kind = body[0];
    if kind == 1 {
        return frame(2, None, &3u32.to_be_bytes());
    }
    let mut at = 1;
    let id = u32_at(body, &mut at);
    let path = || String::from_utf8_lossy(&str_at(body, &mut 5)).into_owned();
    match kind {
        16 => {
            let p = path();
            let real = if p == "." { "/home/dev".to_owned() } else { p };
            let mut rest = 1u32.to_be_bytes().to_vec();
            rest.extend(sstr(real.as_bytes()));
            rest.extend(sstr(real.as_bytes()));
            rest.extend(attrs(0, DIR));
            frame(104, Some(id), &rest)
        }
        7 | 17 => {
            let p = path();
            if let Some(f) = host.files.get(&p) {
                frame(105, Some(id), &attrs(f.len() as u64, FILE))
            } else if host.dirs.contains(&p) {
                frame(105, Some(id), &attrs(0, DIR))
            } else {
                status(id, 2)
            }
        }
        3 => {
            let p = path();
            match host.files.contains_key(&p) {
                true => frame(102, Some(id), &sstr(p.as_bytes())),
                false => status(id, 2),
            }
        }
        5 => {
            let mut at = 5;
            let handle = String::from_utf8_lossy(&str_at(body, &mut at)).into_owned();
            let offset = u64::from_be_bytes(body[at..at + 8].try_into().unwrap()) as usize;
            let len = u32::from_be_bytes(body[at + 8..at + 12].try_into().unwrap()) as usize;
            let data = host.files.get(&handle).cloned().unwrap_or_default();
            if offset >= data.len() {
                status(id, 1)
            } else {
                let end = data.len().min(offset + len);
                frame(103, Some(id), &sstr(&data[offset..end]))
            }
        }
        4 => status(id, 0),
        _ => status(id, 8),
    }
}

fn serve_sftp(host: Arc<Mutex<Host>>, mut req: Pipe, resp: Pipe) {
    std::thread::spawn(move || {
        loop {
            let mut len = [0u8; 4];
            if req.read_exact(&mut len).is_err() {
                break;
            }
            let mut body = vec![0u8; u32::from_be_bytes(len) as usize];
            if req.read_exact(&mut body).is_err() {
                break;
            }
            let reply = sftp_reply(&host.lock().unwrap(), &body);
            resp.push(&reply);
        }
    });
}

/// A shell that answers each wrapped script: the probe, or `git status`.
fn serve_shell(host: Arc<Mutex<Host>>, mut req: Pipe, resp: Pipe) {
    std::thread::spawn(move || {
        let mut buf = String::new();
        let mut chunk = [0u8; 4096];
        loop {
            match req.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.push_str(&String::from_utf8_lossy(&chunk[..n])),
            }
            while let Some(end) = buf.find("$?\n") {
                let script: String = buf.drain(..end + 3).collect();
                let Some(at) = script.find("__XDEV_") else {
                    continue;
                };
                let rest = &script[at + 7..];
                let nonce = &rest[..rest.find("__").unwrap()];
                let host = host.lock().unwrap();
                let link = script.contains("[ -L ")
                    && host
                        .links
                        .iter()
                        .any(|l| script.contains(&format!("'{l}'")));
                let mut out = if script.contains("status --porcelain") {
                    host.status.clone()
                } else if script.contains("[ -L ") {
                    Vec::new()
                } else {
                    format!("/home/dev\ngit=1\ntmux={}", u8::from(host.tmux)).into_bytes()
                };
                let code = if link { 4 } else { 0 };
                out.extend(format!("\n__XDEV_{nonce}__{code}\n").into_bytes());
                resp.push(&out);
            }
        }
    });
}

// Processes.

#[derive(Clone, Default)]
struct Proc {
    exit: Arc<Mutex<Option<Option<i32>>>>,
    pipes: Vec<Pipe>,
}

impl Proc {
    /// The process ends with `code`, as when the link drops.
    fn exit(&self, code: i32) {
        *self.exit.lock().unwrap() = Some(Some(code));
        for p in &self.pipes {
            p.close();
        }
    }

    fn exited(&self) -> bool {
        self.exit.lock().unwrap().is_some()
    }
}

struct FakeChild(Proc);

impl SshChild for FakeChild {
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>> {
        Ok(*self.0.exit.lock().unwrap())
    }

    fn kill(&mut self) {
        // An `ssh` that already exited: its pipes close on their own.
        if self.0.exited() {
            return;
        }
        *self.0.exit.lock().unwrap() = Some(None);
        for p in &self.0.pipes {
            p.close();
        }
    }
}

/// Starts the fake host's `sftp` or `sh`; with `fail` set, an `ssh` that
/// prints it and exits 255 at once.
#[derive(Clone, Default)]
struct Spawner {
    host: Arc<Mutex<Host>>,
    fail: Arc<Mutex<Option<&'static str>>>,
    spawned: Arc<AtomicUsize>,
    args: Arc<Mutex<Vec<Vec<String>>>>,
    procs: Arc<Mutex<Vec<Proc>>>,
    /// With `fail`: the stderr text comes this long after the exit.
    late: Arc<Mutex<Option<Duration>>>,
    /// Runs before each spawn, with the spawns so far.
    on_spawn: Arc<Mutex<Option<Hook<usize>>>>,
}

type Hook<T> = Box<dyn Fn(T) + Send>;

impl PipeSpawner for Spawner {
    fn spawn(&self, args: &[String]) -> io::Result<Piped> {
        let n = self.spawned.fetch_add(1, Ordering::SeqCst);
        if let Some(f) = &*self.on_spawn.lock().unwrap() {
            f(n);
        }
        self.args.lock().unwrap().push(args.to_vec());
        let (stdin, stdout, stderr) = (Pipe::default(), Pipe::default(), Pipe::default());
        let proc = Proc {
            exit: Arc::default(),
            pipes: vec![stdin.clone(), stdout.clone(), stderr.clone()],
        };
        let late = *self.late.lock().unwrap();
        if let (Some(text), Some(after)) = (*self.fail.lock().unwrap(), late) {
            *proc.exit.lock().unwrap() = Some(Some(255));
            stdin.close();
            stdout.close();
            let err = stderr.clone();
            std::thread::spawn(move || {
                std::thread::sleep(after);
                err.push(text.as_bytes());
                err.close();
            });
        } else if let Some(text) = *self.fail.lock().unwrap() {
            stderr.push(text.as_bytes());
            proc.exit(255);
        } else if args.iter().any(|a| a == "sftp") {
            serve_sftp(Arc::clone(&self.host), stdin.clone(), stdout.clone());
        } else {
            serve_shell(Arc::clone(&self.host), stdin.clone(), stdout.clone());
        }
        self.procs.lock().unwrap().push(proc.clone());
        Ok(Piped {
            child: Box::new(FakeChild(proc)),
            stdin: Box::new(stdin),
            stdout: Box::new(stdout),
            stderr: Box::new(stderr),
        })
    }
}

impl Spawner {
    fn count(&self) -> usize {
        self.spawned.load(Ordering::SeqCst)
    }

    fn fail_with(&self, text: Option<&'static str>) {
        *self.fail.lock().unwrap() = text;
    }

    fn last_procs(&self) -> Vec<Proc> {
        self.procs.lock().unwrap().clone()
    }
}

#[derive(Clone)]
struct FakeClock {
    now: Arc<Mutex<Instant>>,
    slept: Arc<Mutex<Vec<Duration>>>,
    /// Runs during each sleep.
    on_sleep: Arc<Mutex<Option<Hook<Duration>>>>,
}

impl FakeClock {
    fn new() -> FakeClock {
        FakeClock {
            now: Arc::new(Mutex::new(Instant::now())),
            slept: Arc::default(),
            on_sleep: Arc::default(),
        }
    }

    fn advance(&self, d: Duration) {
        *self.now.lock().unwrap() += d;
    }
}

impl Clock for FakeClock {
    fn now(&self) -> Instant {
        *self.now.lock().unwrap()
    }

    fn sleep(&self, d: Duration) {
        self.slept.lock().unwrap().push(d);
        if let Some(f) = &*self.on_sleep.lock().unwrap() {
            f(d);
        }
        self.advance(d);
    }
}

struct Rig {
    hub: RemoteHub,
    spawner: Spawner,
    clock: FakeClock,
    seen: Arc<Mutex<Vec<RemoteConnState>>>,
    data: tempfile::TempDir,
}

fn devbox() -> SshHost {
    SshHost {
        id: "devbox".into(),
        alias: "devbox".into(),
        host_name: "devbox".into(),
        ..SshHost::default()
    }
}

fn project() -> RemoteProject {
    RemoteProject {
        id: "rp_000000000001".into(),
        host_id: "devbox".into(),
        path: ROOT.into(),
        name: "app".into(),
        keep_alive: true,
        added_ms: 1,
    }
}

fn rig() -> Rig {
    let spawner = Spawner::default();
    {
        let mut h = spawner.host.lock().unwrap();
        h.dirs = vec![ROOT.into(), "/home/dev".into()];
        h.files.insert(format!("{ROOT}/a.txt"), b"hello\n".to_vec());
        h.tmux = true;
        h.status = b" M a.txt\0?? b.txt\0".to_vec();
    }
    let clock = FakeClock::new();
    let seen: Arc<Mutex<Vec<RemoteConnState>>> = Arc::default();
    let sink = Arc::clone(&seen);
    let hub = RemoteHub::new(
        Box::new(spawner.clone()),
        Box::new(clock.clone()),
        Box::new(move |v: RemoteHostView| sink.lock().unwrap().push(v.conn)),
        None,
        false,
    );
    let data = tempfile::tempdir().unwrap();
    xdev_ssh::save(data.path(), &[devbox()]).unwrap();
    store::save_projects(data.path(), &[project()]).unwrap();
    Rig {
        hub,
        spawner,
        clock,
        seen,
        data,
    }
}

fn r() -> RemoteRef {
    RemoteRef::parse(&format!("ssh://devbox{ROOT}")).unwrap()
}

fn connected(state: &RemoteState) -> bool {
    matches!(state, RemoteState::Connected { .. })
}

// The hub.

#[test]
fn ensure_connects_once_for_two_callers() {
    let rig = rig();
    let a = {
        let hub = rig.hub.clone();
        std::thread::spawn(move || hub.ensure(&devbox()).map(|(_, p)| p))
    };
    let b = rig.hub.ensure(&devbox()).map(|(_, p)| p).unwrap();
    let a = a.join().unwrap().unwrap();
    assert_eq!(a, b);
    assert_eq!(b.home, "/home/dev");
    assert!(b.tmux && b.git);
    assert_eq!(rig.spawner.count(), 2, "one sftp and one sh");
    let args = rig.spawner.args.lock().unwrap().clone();
    assert_eq!(args[0][..2], ["-o", "BatchMode=yes"]);
    assert!(args[0].iter().any(|a| a == "sftp"));
    assert_eq!(args[1].last().map(String::as_str), Some("sh"));
    rig.hub.ensure(&devbox()).unwrap();
    assert_eq!(rig.spawner.count(), 2);
}

#[test]
fn a_dropped_link_reconnects_then_connects() {
    let rig = rig();
    let (s, _) = rig.hub.ensure(&devbox()).unwrap();
    let run = s.run_id();
    rig.seen.lock().unwrap().clear();
    rig.spawner.last_procs()[0].exit(255);
    assert!(rig.hub.tick(&s, run));
    let seen = rig.seen.lock().unwrap().clone();
    assert_eq!(
        seen,
        [
            RemoteConnState::Reconnecting {
                attempt: 1,
                next_in_secs: 1
            },
            RemoteConnState::Connected {
                tmux: true,
                git: true
            },
        ]
    );
    assert_eq!(rig.spawner.count(), 4);
    assert!(connected(&s.state()));
    // The old processes are gone.
    assert!(rig.spawner.last_procs()[..2].iter().all(Proc::exited));
}

#[test]
fn twenty_failed_tries_go_offline_and_connect_starts_over() {
    let rig = rig();
    let (s, _) = rig.hub.ensure(&devbox()).unwrap();
    let run = s.run_id();
    rig.spawner.fail_with(Some(
        "ssh: connect to host devbox port 22: Connection refused\n",
    ));
    rig.spawner.last_procs()[0].exit(255);
    assert!(!rig.hub.tick(&s, run));
    assert!(matches!(s.state(), RemoteState::Offline { .. }));
    assert_eq!(rig.clock.slept.lock().unwrap().len(), MAX_TRIES as usize);
    // Offline fails fast, without a spawn.
    let before = rig.spawner.count();
    let e = files::read(&rig.hub, rig.data.path(), &r(), "a.txt").unwrap_err();
    assert_eq!(e.code, "remote_offline");
    assert_eq!(rig.spawner.count(), before);
    // `remote_connect` clears it.
    rig.spawner.fail_with(None);
    let view = rig.hub.connect(&devbox());
    assert!(matches!(view.conn, RemoteConnState::Connected { .. }));
}

#[test]
fn an_idle_connection_stops() {
    let rig = rig();
    let (s, _) = rig.hub.ensure(&devbox()).unwrap();
    let run = s.run_id();
    rig.clock.advance(IDLE - Duration::from_secs(1));
    assert!(rig.hub.tick(&s, run));
    rig.clock.advance(Duration::from_secs(1));
    assert!(!rig.hub.tick(&s, run));
    assert_eq!(s.state(), RemoteState::Idle);
    assert!(rig.spawner.last_procs().iter().all(Proc::exited));
    // A stale watcher ends.
    assert!(!rig.hub.tick(&s, run));
}

#[test]
fn a_stopped_watcher_does_not_reconnect() {
    let rig = rig();
    let (s, _) = rig.hub.ensure(&devbox()).unwrap();
    let run = s.run_id();
    rig.hub.disconnect("devbox");
    assert!(!rig.hub.tick(&s, run));
    assert_eq!(rig.spawner.count(), 2);
}

#[test]
fn a_stop_while_connecting_leaves_no_connection() {
    let rig = rig();
    let hub = rig.hub.clone();
    // `remote_disconnect` lands between the sftp and the sh spawn.
    *rig.spawner.on_spawn.lock().unwrap() = Some(Box::new(move |n| {
        if n == 1 {
            hub.disconnect("devbox");
        }
    }));
    let e = rig
        .hub
        .ensure(&devbox())
        .err()
        .expect("connected after a stop");
    assert_eq!(e.code, "remote_offline");
    let s = rig.hub.session_of("devbox").unwrap();
    assert_eq!(s.state(), RemoteState::Idle);
    assert!(rig.spawner.last_procs().iter().all(Proc::exited));
}

#[test]
fn a_reconnect_does_not_hold_the_connect_lock_while_it_waits() {
    let rig = rig();
    let (s, _) = rig.hub.ensure(&devbox()).unwrap();
    let run = s.run_id();
    let free: Arc<Mutex<Vec<bool>>> = Arc::default();
    let (seen, held) = (Arc::clone(&free), Arc::clone(&s));
    *rig.clock.on_sleep.lock().unwrap() = Some(Box::new(move |_| {
        seen.lock()
            .unwrap()
            .push(held.connecting.try_lock().is_ok());
    }));
    rig.spawner.last_procs()[0].exit(255);
    assert!(rig.hub.tick(&s, run));
    let free = free.lock().unwrap();
    assert!(!free.is_empty());
    assert!(free.iter().all(|f| *f), "{free:?}");
}

#[test]
fn a_late_stderr_still_names_the_failure() {
    let rig = rig();
    rig.spawner
        .fail_with(Some("devbox: Permission denied (publickey).\n"));
    // Past the wait for the exit, well inside the wait for stderr.
    *rig.spawner.late.lock().unwrap() = Some(Duration::from_millis(1500));
    let e = rig.hub.ensure(&devbox()).err().expect("connected");
    assert_eq!(e.code, "remote_auth");
}

// Connect errors.

#[test]
fn connect_failures_map_to_codes() {
    for (stderr, code) in [
        ("devbox: Permission denied (publickey).\n", "remote_auth"),
        ("subsystem request failed on channel 0\n", "remote_no_sftp"),
        ("ssh: Could not resolve hostname devbox\n", "remote_offline"),
    ] {
        let rig = rig();
        rig.spawner.fail_with(Some(stderr));
        let Err(e) = rig.hub.ensure(&devbox()) else {
            panic!("{stderr} connected");
        };
        assert_eq!(e.code, code, "{stderr}");
        let s = rig.hub.session_of("devbox").unwrap();
        assert!(matches!(s.state(), RemoteState::Offline { .. }));
    }
}

#[test]
fn remote_errors_map_to_codes() {
    let table: [(RemoteError, &str); 10] = [
        (RemoteError::NotFound, "remote_path"),
        (RemoteError::Denied, "remote_denied"),
        (RemoteError::TooLarge, "remote_too_large"),
        (RemoteError::Timeout, "remote_offline"),
        (RemoteError::Io("eof".into()), "remote_offline"),
        (RemoteError::Closed, "remote_offline"),
        (RemoteError::NoGit, "remote_no_git"),
        (RemoteError::BadPath("x".into()), "bad_path"),
        (RemoteError::Exists, "exists"),
        (RemoteError::Protocol("x".into()), "io"),
    ];
    for (e, code) in table {
        assert_eq!(CmdError::from(e).code, code);
    }
    assert_eq!(unsupported("worktree_commit").code, "remote_unsupported");
}

// Stores.

#[test]
fn stores_round_trip_and_refuse_another_version() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    assert!(store::load_projects(data).unwrap().is_empty());
    assert!(store::load_targets(data).unwrap().is_empty());
    store::save_projects(data, &[project()]).unwrap();
    assert_eq!(store::load_projects(data).unwrap(), [project()]);
    let mut targets = std::collections::BTreeMap::new();
    targets.insert(
        "repo1".to_owned(),
        RemoteTarget {
            host_id: "devbox".into(),
            path: "/srv/app".into(),
        },
    );
    store::save_targets(data, &targets).unwrap();
    assert_eq!(store::load_targets(data).unwrap(), targets);
    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(data.join(store::TARGETS_FILE)).unwrap()).unwrap();
    assert_eq!(raw["v"], 1);

    std::fs::write(data.join(store::PROJECTS_FILE), br#"{"v":2,"projects":[]}"#).unwrap();
    let e = store::load_projects(data).unwrap_err();
    assert_eq!(e.code, "io");
    assert!(e.detail.unwrap().contains("version 2"));
    std::fs::write(data.join(store::TARGETS_FILE), br#"{"v":0}"#).unwrap();
    assert_eq!(store::load_targets(data).unwrap_err().code, "io");
}

#[test]
fn ids_are_rp_and_twelve_hex() {
    let id = store::new_id();
    assert_eq!(id.len(), 15);
    assert!(id.starts_with("rp_"));
    assert!(id[3..].chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(id, store::new_id());
}

// Routing.

#[test]
fn an_ssh_worktree_reads_through_the_hub() {
    let rig = rig();
    let worktree = PathBuf::from(format!("ssh://devbox{ROOT}"));
    let r = remote_ref(&worktree).expect("an ssh worktree");
    let text = files::read(&rig.hub, rig.data.path(), &r, "a.txt").unwrap();
    assert_eq!(text.text.as_deref(), Some("hello\n"));
    assert_eq!(rig.spawner.count(), 2);
    let e = files::read(&rig.hub, rig.data.path(), &r, "gone.txt").unwrap_err();
    assert_eq!(e.code, "remote_path");
    // A local path is not one.
    assert!(remote_ref(&rig.data.path().join("app")).is_none());
}

#[test]
fn an_unknown_remote_folder_is_refused_before_connecting() {
    let rig = rig();
    let other = RemoteRef::parse("ssh://devbox/srv/other").unwrap();
    let e = files::read(&rig.hub, rig.data.path(), &other, "a.txt").unwrap_err();
    assert_eq!(e.code, "worktree_unknown");
    assert_eq!(rig.spawner.count(), 0);
}

#[test]
fn changes_and_stat_come_from_git_status() {
    let rig = rig();
    let changes = crate::workspace::remote_changes(&rig.hub, rig.data.path(), &r()).unwrap();
    let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
    assert_eq!(paths, ["a.txt", "b.txt"]);
    let stat = crate::workspace::remote_stat(&rig.hub, rig.data.path(), &r()).unwrap();
    assert_eq!((stat.files, stat.added, stat.removed), (2, 0, 0));
}

#[test]
fn bytes_check_the_kind_and_the_cap() {
    let rig = rig();
    rig.spawner
        .host
        .lock()
        .unwrap()
        .files
        .insert(format!("{ROOT}/logo.png"), vec![1, 2, 3]);
    let got = files::bytes(&rig.hub, rig.data.path(), &r(), "logo.png").unwrap();
    assert_eq!(got, [1, 2, 3]);
    let e = files::bytes(&rig.hub, rig.data.path(), &r(), "a.txt").unwrap_err();
    assert_eq!(e.code, "bad_name");
}

#[test]
fn file_commands_refuse_links_and_git() {
    let rig = rig();
    {
        let mut h = rig.spawner.host.lock().unwrap();
        h.links.push("out".into());
        h.files.insert(format!("{ROOT}/out/logo.png"), vec![1]);
        h.files.insert(format!("{ROOT}/out/a.txt"), b"x".to_vec());
    }
    let (data, r) = (rig.data.path(), r());
    let codes = [
        files::read(&rig.hub, data, &r, "out/a.txt").map(|_| ()),
        files::bytes(&rig.hub, data, &r, "out/logo.png").map(|_| ()),
        files::write(&rig.hub, data, &r, "out/a.txt", "y", Eol::Lf, None).map(|_| ()),
        files::create(&rig.hub, data, &r, "out/n.txt", false),
        files::rename(&rig.hub, data, &r, "a.txt", "out/a.txt"),
        files::trash(&rig.hub, data, &r, "out"),
        files::read(&rig.hub, data, &r, ".git/config").map(|_| ()),
        files::write(&rig.hub, data, &r, ".GIT/hooks/x", "", Eol::Lf, None).map(|_| ()),
    ];
    for (i, c) in codes.into_iter().enumerate() {
        assert_eq!(c.unwrap_err().code, "bad_path", "call {i}");
    }
    assert_eq!(rig.spawner.host.lock().unwrap().files.len(), 3);
    // A plain path still reads.
    let t = files::read(&rig.hub, data, &r, "a.txt").unwrap();
    assert_eq!(t.text.as_deref(), Some("hello\n"));
}

#[test]
fn a_hand_edited_host_is_checked_before_ssh_runs() {
    let rig = rig();
    let evil = SshHost {
        id: "evil".into(),
        alias: "-oProxyCommand=touch /tmp/x".into(),
        host_name: "devbox".into(),
        ..SshHost::default()
    };
    xdev_ssh::save(rig.data.path(), &[devbox(), evil]).unwrap();
    let e = add_project(&rig.hub, rig.data.path(), "evil", "~", None).unwrap_err();
    assert_eq!(e.code, "bad_arg");
    let target = RemoteTarget {
        host_id: "evil".into(),
        path: "/srv".into(),
    };
    let e = set_target(&rig.hub, rig.data.path(), "repo1", Some(target)).unwrap_err();
    assert_eq!(e.code, "bad_arg");
    assert_eq!(rig.spawner.count(), 0);
}

/// The ControlPath `ssh` gets: no space (it would end the option) and short
/// enough for a socket path once `%C` grows to 40 hex digits.
#[test]
fn the_mux_folder_is_short_and_has_no_space() {
    if let Some(dir) = mux_dir() {
        let argv = xdev_ssh::exec_argv(&devbox(), Some(&dir));
        let path = argv
            .iter()
            .find_map(|a| a.strip_prefix("ControlPath="))
            .unwrap();
        assert!(!path.chars().any(char::is_whitespace), "{path}");
        assert!(path.len() <= 80, "{path} is {} bytes", path.len());
    }
    let tmp = tempfile::tempdir().unwrap();
    let spaced = tmp.path().join("Application Support");
    assert_eq!(mux_dir_in(&spaced), None);
    let long = tmp.path().join("x".repeat(80));
    assert_eq!(mux_dir_in(&long), None);
    let got = mux_dir_in(tmp.path());
    let want = tmp.path().join(".ssh").join("xdev-cm");
    let fits = want.join("cm-%C").to_string_lossy().len() <= 80;
    if cfg!(windows) || !fits {
        assert_eq!(got, None);
    } else {
        assert_eq!(got, Some(want));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(got.unwrap())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
    }
}

/// Each command with no remote form starts with a `local_only` guard.
#[test]
fn local_only_commands_are_guarded() {
    let ssh = Path::new("ssh://devbox/home/dev/app");
    let e = local_only(ssh, "worktree_commit").unwrap_err();
    assert_eq!(e.code, "remote_unsupported");
    assert_eq!(e.detail.as_deref(), Some("worktree_commit"));
    assert!(local_only(Path::new("/home/dev/app"), "worktree_commit").is_ok());

    let sources = [
        (
            include_str!("../workspace.rs"),
            &[
                "worktree_archive_run",
                "worktree_adopt",
                "worktree_create",
                "worktree_name_preview",
                "worktree_rename_branch",
                "worktree_pin",
                "worktree_remove",
                "worktree_archive",
                "worktree_details",
                "worktree_restore",
                "worktree_file_diff",
                "worktree_list_dir",
                "worktree_commit",
            ][..],
        ),
        (
            include_str!("../line_attribution.rs"),
            &["attribution_lines", "attribution_lines_head"][..],
        ),
        (
            include_str!("../files.rs"),
            &["file_reveal", "files_search"][..],
        ),
        (
            include_str!("../file_head.rs"),
            &["worktree_file_head", "worktree_file_head_bytes"][..],
        ),
        (
            include_str!("../review.rs"),
            &[
                "worktree_review",
                "worktree_review_file",
                "worktree_stage",
                "worktree_discard",
                "worktree_stage_state",
                "worktree_conflicts",
                "worktree_conflict_continue",
                "worktree_conflict_abort",
                "worktree_conflict_resolve",
                "worktree_branches",
                "worktree_checkout_branch",
            ][..],
        ),
        (
            include_str!("../ship.rs"),
            &[
                "worktree_pr",
                "worktree_pr_create",
                "worktree_pr_checks",
                "worktree_check_log",
                "worktree_pr_open",
                "worktree_draft_commit",
                "worktree_draft_pr",
                "worktree_suggest_branch",
                "worktree_ship",
                "worktree_push",
                "worktree_sync_fork",
                "worktree_pull",
                "worktree_fast_forward",
                "worktree_rebase_from_base",
                "worktree_sync",
                "worktree_fetch",
                "worktree_force_push",
                "worktree_amend",
            ][..],
        ),
        (
            include_str!("../gitlab.rs"),
            &["worktree_mr", "worktree_mr_create"][..],
        ),
        (
            include_str!("../history.rs"),
            &[
                "worktree_log",
                "worktree_commit_files",
                "worktree_commit_file",
                "worktree_open_commit",
                "worktree_open_file_on_host",
            ][..],
        ),
        (
            include_str!("../pr_review.rs"),
            &[
                "worktree_pr_comments",
                "worktree_pr_comment_post",
                "worktree_pr_head",
                "worktree_pr_thread_resolve",
                "worktree_pr_reaction",
                "worktree_pr_checks_rerun",
                "worktree_pr_merge_info",
                "worktree_pr_merge",
            ][..],
        ),
    ];
    for (src, names) in sources {
        for name in names {
            let at = src
                .find(&format!("fn {name}("))
                .unwrap_or_else(|| panic!("{name} not found"));
            let body = &src[at..];
            let end = body[1..].find("\npub ").map_or(body.len(), |i| i + 1);
            assert!(
                body[..end].contains("local_only(") && body[..end].contains(&format!("\"{name}\"")),
                "{name} has no remote_unsupported guard"
            );
        }
    }
}

#[test]
fn a_remote_project_launch_keeps_alive_only_with_tmux() {
    let rig = rig();
    let cwd = PathBuf::from(format!("ssh://devbox{ROOT}"));
    let spec = launch_spec(
        &rig.hub,
        rig.data.path(),
        &cwd,
        None,
        vec!["A".into()],
        &Default::default(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(spec.path, ROOT);
    assert_eq!(spec.worktree, format!("ssh://devbox{ROOT}"));
    assert!(spec.keep_alive);
    assert_eq!(spec.declared, ["A"]);

    let rig = rig_without_tmux();
    let spec = launch_spec(
        &rig.hub,
        rig.data.path(),
        &cwd,
        Some("devbox"),
        Vec::new(),
        &Default::default(),
    )
    .unwrap()
    .unwrap();
    assert!(!spec.keep_alive);
    let e = launch_spec(
        &rig.hub,
        rig.data.path(),
        &cwd,
        Some("other"),
        Vec::new(),
        &Default::default(),
    )
    .unwrap_err();
    assert_eq!(e.code, "bad_arg");
    assert!(
        launch_spec(
            &rig.hub,
            rig.data.path(),
            rig.data.path(),
            None,
            Vec::new(),
            &Default::default()
        )
        .unwrap()
        .is_none()
    );
}

fn rig_without_tmux() -> Rig {
    let rig = rig();
    rig.spawner.host.lock().unwrap().tmux = false;
    rig
}
