//! `xdev serve` as a process: pairing over stdin, the log on stderr, and
//! the startup refusals. Loopback and port 0 only.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use serde_json::Value;
use xdev_link::{
    Clock, Dialer, FakeDiscover, HostKey, Link, NoRelay, PairCode, PairOffer, PairTarget, PeerCtx,
    PeerKind, PeerRole, PeerStore, RpcError, Serve, StoredPeer, SystemClock,
};

const T: Duration = Duration::from_secs(5);

fn xdev(root: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_xdev"));
    cmd.env("XDEV_DATA_DIR", root.join("data"))
        .env("XDEV_LOCAL_DIR", root.join("local"));
    cmd
}

fn run(root: &Path, args: &[&str]) -> Output {
    xdev(root)
        .arg("serve")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("run xdev")
}

fn peers_file(root: &Path) -> std::path::PathBuf {
    root.join("data").join("serve").join("peers.json")
}

/// Each line read on a thread, so every wait has a deadline.
fn lines(r: impl std::io::Read + Send + 'static) -> Receiver<String> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        for line in BufReader::new(r).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    rx
}

/// The next line starting with `prefix`, within 5 s.
fn wait_for(rx: &Receiver<String>, prefix: &str) -> String {
    let deadline = Instant::now() + T;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(line) if line.starts_with(prefix) => return line,
            Ok(_) => {}
            Err(e) => panic!("no `{prefix}` line: {e}"),
        }
    }
}

struct Quiet;

impl Serve for Quiet {
    fn call(&self, _: &PeerCtx, _: &str, _: Value) -> Result<Value, RpcError> {
        Err(RpcError::code("unsupported"))
    }
    fn on_stream(&self, _: &PeerCtx, _: u32, _: &[u8]) {}
    fn on_close(&self, _: &PeerCtx) {}
}

/// Stops the child: SIGINT on Unix, which runs the clean shutdown; a kill
/// on Windows, where a console interrupt cannot be aimed at one child.
fn stop(child: &mut Child) -> std::process::ExitStatus {
    #[cfg(unix)]
    {
        let sent = Command::new("kill")
            .args(["-INT", &child.id().to_string()])
            .status()
            .is_ok_and(|s| s.success());
        if sent {
            let deadline = Instant::now() + T;
            while Instant::now() < deadline {
                if let Some(status) = child.try_wait().unwrap() {
                    return status;
                }
                std::thread::yield_now();
            }
        }
    }
    let _ = child.kill();
    child.wait().unwrap()
}

#[test]
fn pairs_over_stdin_then_serves_the_project() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("app");
    std::fs::create_dir_all(project.join(".git")).unwrap();
    let mut child = xdev(tmp.path())
        .args(["serve", "--port", "0", "--pair", "--project"])
        .arg(&project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn xdev serve");
    let out = lines(child.stdout.take().unwrap());
    let err = lines(child.stderr.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();

    let listening = wait_for(&out, "listening on ");
    assert!(
        listening.starts_with("listening on 127.0.0.1:"),
        "{listening}"
    );
    let code_line = wait_for(&out, "pairing code: ");
    let code = code_line.strip_prefix("pairing code: ").unwrap().to_owned();
    let link = wait_for(&out, "pair link: ");
    let link = link.strip_prefix("pair link: ").unwrap().to_owned();

    let offer = PairOffer::from_uri(&link, SystemClock.now_ms()).unwrap();
    let target = PairTarget::from_offer(&offer);
    let parsed = PairCode::parse(&code).unwrap();
    let store = Arc::new(PeerStore::open(&tmp.path().join("mac.json")).unwrap());
    let key = Arc::new(HostKey::generate().unwrap());
    let mut dialer = Dialer::new(key, "mac", store.clone(), Arc::new(Quiet));
    dialer.handshake_timeout = T;
    dialer.confirm_timeout = T;
    let dialer = Arc::new(dialer);
    let (sas_tx, sas_rx) = channel();
    let pairing = {
        let dialer = dialer.clone();
        std::thread::spawn(move || {
            let pending = dialer.pair(&target, &parsed)?;
            let _ = sas_tx.send(pending.sas.clone());
            pending.finish(true)
        })
    };
    let prompt = wait_for(&out, "pair request from mac");
    let sas = sas_rx.recv_timeout(T).expect("the SAS");
    assert!(prompt.contains(&sas), "{prompt}");
    assert!(prompt.ends_with("Accept as operator? [y/N]"), "{prompt}");
    stdin.write_all(b"y\n").unwrap();
    stdin.flush().unwrap();
    let mut host = pairing.join().unwrap().expect("paired");
    assert_eq!(store.list().len(), 1);

    host.addrs = vec![listening.strip_prefix("listening on ").unwrap().to_owned()];
    let link: Arc<Link> = dialer
        .connect(&host, &FakeDiscover::default(), &NoRelay)
        .expect("connect over IK");
    let hello = link.call("hello", Value::Null, T).unwrap();
    assert_eq!(hello["yourRole"], "operator");
    let projects = link.call("projects.list", Value::Null, T).unwrap();
    assert_eq!(projects.as_array().map(Vec::len), Some(1), "{projects}");
    drop(link);

    let status = stop(&mut child);
    drop(stdin);
    if cfg!(unix) {
        assert!(status.success(), "{status:?}");
    }
    let log: Vec<String> = err.iter().collect();
    let log = log.join("\n");
    assert!(log.contains(" started"), "{log}");
    assert!(log.contains(" paired "), "{log}");
    assert!(log.contains(" as operator"), "{log}");
    if cfg!(unix) {
        assert!(log.contains(" stopped"), "{log}");
    }
    assert!(!log.contains(&code), "the code is never logged");
    assert!(!log.contains(&code.replace('-', "")));
    assert!(!log.contains("d="), "the offer is never logged");
    assert!(!log.contains(&sas), "the SAS is never logged");
}

#[test]
fn a_reachable_port_with_nobody_to_let_in_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let p = tmp.path().to_str().unwrap();
    let out = run(
        tmp.path(),
        &["--bind", "lan", "--port", "0", "--project", p],
    );
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("error: serve_no_peers"), "{err}");
    assert!(out.stdout.is_empty(), "never listened");
}

#[test]
fn no_flag_reaches_the_internet_or_turns_auth_off() {
    let tmp = tempfile::tempdir().unwrap();
    for args in [&["--bind", "wan"][..], &["--no-auth"], &["--role", "none"]] {
        let out = run(tmp.path(), args);
        assert_eq!(out.status.code(), Some(2), "{args:?} {out:?}");
    }
}

#[test]
fn no_project_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let out = xdev(tmp.path())
        .args(["serve", "--port", "0"])
        .current_dir(tmp.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert!(String::from_utf8_lossy(&out.stderr).contains("error: serve_no_project"));
}

#[test]
fn peers_lists_and_forget_removes() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(peers_file(tmp.path()).parent().unwrap()).unwrap();
    let store = PeerStore::open(&peers_file(tmp.path())).unwrap();
    let mut peer = StoredPeer::new("mac", PeerKind::Desktop, &[7; 32], 1);
    peer.role = PeerRole::Viewer;
    let id = peer.id.clone();
    store.add(peer).unwrap();

    let out = run(tmp.path(), &["--peers"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        format!("{id}\tmac\tviewer\n")
    );

    assert!(run(tmp.path(), &["--forget", &id]).status.success());
    let out = run(tmp.path(), &["--peers"]);
    assert!(out.stdout.is_empty(), "{out:?}");
    let again = run(tmp.path(), &["--forget", &id]);
    assert_eq!(again.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&again.stderr).contains("error: no_peer"));
}
