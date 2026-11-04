//! The app's client against the service: in this process, and the real
//! binary started detached by `ensure`.

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use xdev_ipc::{IpcError, endpoint};
use xdev_pty::SpawnSpec;
use xdev_pty::client::{Client, Sink, StartOptions, connect, ensure, install};
use xdev_pty::proto::PROTOCOL;
use xdev_pty::service::{Config, start};

const DEADLINE: Duration = Duration::from_secs(10);

fn shell(script: &str) -> (PathBuf, Vec<String>) {
    if cfg!(windows) {
        (
            "cmd.exe".into(),
            ["/d", "/c", script].map(String::from).to_vec(),
        )
    } else {
        ("/bin/sh".into(), ["-c", script].map(String::from).to_vec())
    }
}

fn spec(script: &str) -> SpawnSpec {
    let (program, args) = shell(script);
    SpawnSpec {
        program,
        args,
        env: Vec::new(),
        cwd: std::env::temp_dir(),
        cols: 80,
        rows: 24,
    }
}

fn idle(first: &str) -> String {
    if cfg!(windows) {
        format!("echo {first}& ping -n 30 127.0.0.1 >nul")
    } else {
        format!("echo {first}; sleep 30")
    }
}

type Output = Arc<Mutex<Vec<u8>>>;

/// A sink that collects output and reports the exit.
fn sink() -> (Sink, Output, mpsc::Receiver<Option<i32>>) {
    let out = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = mpsc::channel();
    let o = out.clone();
    let sink = Sink {
        on_output: Box::new(move |b| o.lock().unwrap().extend(b)),
        on_exit: Box::new(move |c| {
            let _ = tx.send(c);
        }),
    };
    (sink, out, rx)
}

fn wait_for(out: &Mutex<Vec<u8>>, client: &Client, id: &str, text: &str) {
    let start = Instant::now();
    let mut answered = false;
    loop {
        let seen = String::from_utf8_lossy(&out.lock().unwrap()).into_owned();
        if seen.contains(text) {
            return;
        }
        if !answered && seen.contains("\x1b[6n") {
            answered = true;
            client.write(id, b"\x1b[1;1R".to_vec());
        }
        assert!(start.elapsed() < DEADLINE, "no {text:?} in {seen:?}");
        thread::sleep(Duration::from_millis(20));
    }
}

struct InProcess {
    dir: tempfile::TempDir,
    endpoint: xdev_ipc::Endpoint,
}

fn in_process(name: &str) -> InProcess {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = Config::new(dir.path().to_owned(), 64 * 1024);
    cfg.endpoint = endpoint(dir.path(), &format!("xdev-ptyd-ctest-{name}"), PROTOCOL);
    let ep = cfg.endpoint.clone();
    let service = start(cfg).unwrap();
    thread::spawn(move || service.wait());
    InProcess { dir, endpoint: ep }
}

impl InProcess {
    fn client(&self) -> Client {
        connect(self.dir.path(), &self.endpoint, "test").unwrap()
    }
}

#[test]
fn spawn_attach_list_and_kill() {
    let svc = in_process("basic");
    let a = svc.client();
    let (s, out, _) = sink();
    let pid = a
        .spawn(
            "p1",
            spec(&idle("from-client")),
            serde_json::json!({ "tabId": "p1" }),
            s,
        )
        .unwrap();
    assert!(pid.is_some());
    wait_for(&out, &a, "p1", "from-client");

    // Another app run takes it over and gets the ring from 0.
    let b = svc.client();
    let (s2, out2, exit2) = sink();
    let attached = b.attach("p1", 0, s2).unwrap();
    assert_eq!(attached.seq, 0);
    assert!(!attached.truncated);
    wait_for(&out2, &b, "p1", "from-client");

    let list = b.list().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].meta["tabId"], "p1");
    b.kill("p1");
    assert_eq!(exit2.recv_timeout(DEADLINE).map(|_| ()), Ok(()));
    a.quit_all().unwrap();
}

#[test]
fn attach_to_an_unknown_id_is_pty_gone() {
    let svc = in_process("gone");
    let c = svc.client();
    let (s, _, _) = sink();
    assert_eq!(c.attach("nope", 0, s).unwrap_err().code, "pty_gone");
    c.quit_all().unwrap();
}

#[test]
fn a_spawn_with_a_taken_id_is_refused() {
    let svc = in_process("dup");
    let c = svc.client();
    let (s, _, _) = sink();
    c.spawn("p1", spec(&idle("x")), serde_json::Value::Null, s)
        .unwrap();
    let (s, _, _) = sink();
    let err = c
        .spawn("p1", spec(&idle("x")), serde_json::Value::Null, s)
        .unwrap_err();
    assert_eq!(err.code, "pty_exists");
    c.quit_all().unwrap();
}

#[test]
fn a_service_that_ends_ends_every_sink() {
    // The real binary: its exit is what closes the connections.
    let local = tempfile::tempdir().unwrap();
    let opts = binary_opts(local.path(), "xdev-ptyd-drop-test");
    let c = ensure(&opts).unwrap();
    let (s, _, exit) = sink();
    c.spawn("p1", spec(&idle("x")), serde_json::Value::Null, s)
        .unwrap();
    // Another client ends the service; this one hears its PTY end.
    ensure(&opts).unwrap().quit_all().unwrap();
    exit.recv_timeout(DEADLINE).unwrap();
    let start = Instant::now();
    while c.alive() {
        assert!(start.elapsed() < DEADLINE);
        thread::sleep(Duration::from_millis(20));
    }
}

fn binary_opts(local: &std::path::Path, prefix: &str) -> StartOptions {
    StartOptions {
        dir: local.join("ptyd"),
        binary: PathBuf::from(env!("CARGO_BIN_EXE_xdev-ptyd")),
        app_version: "9.9.9-test".into(),
        ring_mb: 1,
        prefix: prefix.into(),
    }
}

#[test]
fn ensure_starts_the_service_detached_from_a_copy() {
    let local = tempfile::tempdir().unwrap();
    let opts = binary_opts(local.path(), "xdev-ptyd-ensure-test");
    let client = ensure(&opts).unwrap();
    assert_ne!(client.welcome().pid, std::process::id());
    assert!(
        opts.dir
            .join("9.9.9-test")
            .join(opts.binary.file_name().unwrap())
            .is_file()
    );
    // A second ensure finds the running one.
    let again = ensure(&opts).unwrap();
    assert_eq!(again.welcome().pid, client.welcome().pid);
    client.quit_all().unwrap();
    let start = Instant::now();
    while !matches!(opts.endpoint().connect(), Err(IpcError::NotRunning)) {
        assert!(start.elapsed() < DEADLINE, "the service is still up");
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn install_keeps_the_two_newest_version_folders() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("xdev-ptyd-bin");
    std::fs::write(&bin, b"binary").unwrap();
    let ptyd = dir.path().join("ptyd");
    for v in ["0.1.0", "0.2.0", "0.3.0"] {
        install(&ptyd, &bin, v).unwrap();
        // Folder times must differ for the order to show.
        thread::sleep(Duration::from_millis(20));
    }
    let mut left: Vec<String> = std::fs::read_dir(&ptyd)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    assert_eq!(left, ["0.2.0", "0.3.0"]);
    let copy = ptyd.join("0.3.0/xdev-ptyd-bin");
    assert_eq!(std::fs::read(&copy).unwrap(), b"binary");
    // A newer build of the same version replaces the copy.
    thread::sleep(Duration::from_millis(20));
    std::fs::write(&bin, b"binary-2").unwrap();
    install(&ptyd, &bin, "0.3.0").unwrap();
    assert_eq!(std::fs::read(&copy).unwrap(), b"binary-2");
}
