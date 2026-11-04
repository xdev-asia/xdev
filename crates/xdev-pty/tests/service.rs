//! The service on a loopback endpoint in a temp dir, with real children.

use std::path::PathBuf;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use xdev_ipc::{Endpoint, IpcError, Stream, endpoint, read_token};
use xdev_pty::proto::{Frame, PROTOCOL, read_frame, write_frame};
use xdev_pty::service::{Config, SESSIONS_FILE, start};

const DEADLINE: Duration = Duration::from_secs(10);

struct Svc {
    dir: tempfile::TempDir,
    endpoint: Endpoint,
    handle: Option<JoinHandle<()>>,
}

fn service(name: &str, tune: impl FnOnce(&mut Config)) -> Svc {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = Config::new(dir.path().to_owned(), 64 * 1024);
    // Windows pipes share one namespace: a name per test.
    cfg.endpoint = endpoint(dir.path(), &format!("xdev-ptyd-test-{name}"), PROTOCOL);
    tune(&mut cfg);
    let endpoint = cfg.endpoint.clone();
    let service = start(cfg).unwrap();
    let handle = thread::spawn(move || service.wait());
    Svc {
        dir,
        endpoint,
        handle: Some(handle),
    }
}

impl Svc {
    fn client(&self) -> Client {
        let token = read_token(self.dir.path()).unwrap();
        self.hello(&token).expect("welcome")
    }

    fn hello(&self, token: &str) -> Option<Client> {
        let mut c = Client::connect(&self.endpoint);
        c.send(Frame::Hello {
            protocol: PROTOCOL,
            minor: 0,
            token: token.to_owned(),
            app_version: "test".into(),
        });
        match c.next() {
            Some(Frame::Welcome { protocol, .. }) => {
                assert_eq!(protocol, PROTOCOL);
                Some(c)
            }
            _ => None,
        }
    }

    /// Joins the service thread; false when it is still running at the deadline.
    fn ended_within(&mut self, limit: Duration) -> bool {
        let start = Instant::now();
        let handle = self.handle.take().unwrap();
        while !handle.is_finished() {
            if start.elapsed() > limit {
                self.handle = Some(handle);
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
        handle.join().unwrap();
        true
    }
}

impl Drop for Svc {
    fn drop(&mut self) {
        if self.handle.is_some() {
            // Ends the children of a test that failed half way.
            if let Ok(token) = read_token(self.dir.path())
                && let Some(mut c) = self.hello(&token)
            {
                c.send(Frame::QuitAll);
            }
        }
    }
}

struct Client {
    r: Stream,
    w: Stream,
}

impl Client {
    fn connect(e: &Endpoint) -> Client {
        let r = e.connect().unwrap();
        r.set_read_timeout(Some(DEADLINE)).unwrap();
        let w = r.try_clone().unwrap();
        Client { r, w }
    }

    fn send(&mut self, f: Frame) {
        write_frame(&mut self.w, &f).unwrap();
    }

    fn next(&mut self) -> Option<Frame> {
        read_frame(&mut self.r).ok().flatten()
    }

    /// Frames until one matches `done` (included); panics at the deadline.
    fn until(&mut self, mut done: impl FnMut(&Frame, &[u8]) -> bool) -> (Vec<Frame>, Vec<u8>) {
        let start = Instant::now();
        let (mut frames, mut output) = (Vec::new(), Vec::new());
        loop {
            assert!(start.elapsed() < DEADLINE, "frames so far: {frames:?}");
            let f = self
                .next()
                .unwrap_or_else(|| panic!("closed after {frames:?}"));
            if let Frame::Output { data, .. } = &f {
                output.extend(data);
                // The console asks where the cursor is and waits for an answer.
                if contains(data, b"\x1b[6n") {
                    let id = match &f {
                        Frame::Output { id, .. } => id.clone(),
                        _ => unreachable!(),
                    };
                    self.send(Frame::Write {
                        id,
                        data: b"\x1b[1;1R".to_vec(),
                    });
                }
            }
            let stop = done(&f, &output);
            frames.push(f);
            if stop {
                return (frames, output);
            }
        }
    }

    fn spawn(&mut self, id: &str, script: &str) {
        let (program, args) = shell(script);
        self.send(Frame::Spawn {
            id: id.into(),
            program,
            args,
            env: vec![("XDEV_TEST".into(), "1".into())],
            cwd: std::env::temp_dir(),
            cols: 80,
            rows: 24,
            meta: serde_json::json!({ "worktree": "/w", "tabId": id, "profile": "shell" }),
        });
        let (frames, _) =
            self.until(|f, _| matches!(f, Frame::Spawned { .. } | Frame::Error { .. }));
        assert!(
            matches!(frames.last(), Some(Frame::Spawned { pid: Some(_), .. })),
            "{frames:?}"
        );
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

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

/// Prints `first`, waits for a line of input, prints `second`, then idles.
fn two_parts(first: &str, second: &str) -> String {
    if cfg!(windows) {
        format!("echo {first}& set /p x=& echo {second}& ping -n 30 127.0.0.1 >nul")
    } else {
        format!("echo {first}; read x; echo {second}; sleep 30")
    }
}

fn idle(first: &str) -> String {
    if cfg!(windows) {
        format!("echo {first}& ping -n 30 127.0.0.1 >nul")
    } else {
        format!("echo {first}; sleep 30")
    }
}

fn sessions(c: &mut Client) -> Vec<xdev_pty::proto::SessionInfo> {
    c.send(Frame::List);
    let (frames, _) = c.until(|f, _| matches!(f, Frame::Sessions { .. }));
    match frames.into_iter().last() {
        Some(Frame::Sessions { sessions }) => sessions,
        _ => unreachable!(),
    }
}

#[test]
fn spawn_then_a_new_client_attaches_from_zero_and_gets_the_output() {
    let svc = service("attach0", |_| {});
    let mut a = svc.client();
    a.spawn("p1", &idle("hello-ptyd"));
    a.until(|_, out| contains(out, b"hello-ptyd"));

    let mut b = svc.client();
    b.send(Frame::Attach {
        id: "p1".into(),
        from_seq: 0,
    });
    let (frames, out) = b.until(|_, out| contains(out, b"hello-ptyd"));
    assert!(
        matches!(frames.first(), Some(Frame::Output { seq: 0, .. })),
        "{frames:?}"
    );
    assert!(contains(&out, b"hello-ptyd"));
    // One client per session: the first one is told.
    let (frames, _) = a.until(|f, _| matches!(f, Frame::Detached { .. }));
    assert!(matches!(
        frames.last(),
        Some(Frame::Detached { reason, .. }) if reason == "taken"
    ));
}

#[test]
fn a_reattach_from_the_old_seq_gets_only_the_new_bytes() {
    let svc = service("reattach", |_| {});
    let mut c = svc.client();
    c.spawn("p1", &two_parts("part-one", "part-two"));
    let (_, out) = c.until(|_, out| contains(out, b"part-one"));
    // Everything up to here; a short wait lets the line end arrive too.
    thread::sleep(Duration::from_millis(300));
    c.send(Frame::Detach { id: "p1".into() });
    let mut seen = out.len() as u64;
    // Bytes that raced the detach still count as seen.
    c.r.set_read_timeout(Some(Duration::from_millis(300)))
        .unwrap();
    while let Some(f) = c.next() {
        if let Frame::Output { data, .. } = f {
            seen += data.len() as u64;
        }
    }
    c.r.set_read_timeout(Some(DEADLINE)).unwrap();
    let enter = if cfg!(windows) { "go\r\n" } else { "go\n" };
    c.send(Frame::Write {
        id: "p1".into(),
        data: enter.as_bytes().to_vec(),
    });
    thread::sleep(Duration::from_millis(500));

    let mut again = svc.client();
    again.send(Frame::Attach {
        id: "p1".into(),
        from_seq: seen,
    });
    let (frames, out) = again.until(|_, out| contains(out, b"part-two"));
    assert!(
        matches!(frames.first(), Some(Frame::Output { seq, .. }) if *seq == seen),
        "{frames:?}"
    );
    assert!(
        !contains(&out, b"part-one"),
        "{}",
        String::from_utf8_lossy(&out)
    );
}

#[test]
fn a_wrong_token_is_closed_without_a_welcome() {
    let svc = service("token", |_| {});
    assert!(svc.hello(&"00".repeat(32)).is_none());
    // The right one still works.
    svc.client();
}

#[test]
fn attach_to_an_unknown_id_is_pty_gone() {
    let svc = service("gone", |_| {});
    let mut c = svc.client();
    c.send(Frame::Attach {
        id: "nope".into(),
        from_seq: 0,
    });
    let (frames, _) = c.until(|f, _| matches!(f, Frame::Error { .. }));
    assert!(matches!(
        frames.last(),
        Some(Frame::Error { code, .. }) if code == "pty_gone"
    ));
}

#[test]
fn the_list_and_sessions_json_show_meta_and_attachment() {
    let svc = service("list", |_| {});
    let mut c = svc.client();
    c.spawn("p1", &idle("x"));
    let list = sessions(&mut c);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, "p1");
    assert_eq!(list[0].meta["tabId"], "p1");
    assert!(list[0].attached);
    assert_eq!(list[0].exited, None);
    c.send(Frame::Detach { id: "p1".into() });
    assert!(!sessions(&mut c)[0].attached);
    let file: serde_json::Value =
        serde_json::from_slice(&std::fs::read(svc.dir.path().join(SESSIONS_FILE)).unwrap())
            .unwrap();
    assert_eq!(file[0]["id"], "p1");
}

#[test]
fn a_child_that_ended_is_reported_on_attach() {
    let svc = service("exited", |_| {});
    let mut c = svc.client();
    c.spawn("p1", "echo bye");
    c.until(|f, _| matches!(f, Frame::Exited { .. }));
    drop(c);
    let mut again = svc.client();
    again.send(Frame::Attach {
        id: "p1".into(),
        from_seq: 0,
    });
    let (_, out) = again.until(|f, _| matches!(f, Frame::Exited { .. }));
    assert!(contains(&out, b"bye"));
}

#[test]
fn a_client_that_does_not_ack_is_detached_and_the_child_runs_on() {
    let mut svc = service("lag", |cfg| {
        cfg.window = 4 * 1024;
        cfg.lag = Duration::from_millis(300);
    });
    let mut c = svc.client();
    let flood = if cfg!(windows) {
        "for /l %i in (1,1,2000) do @echo line-%i".to_owned() + "& ping -n 30 127.0.0.1 >nul"
    } else {
        "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done; sleep 30".to_owned()
    };
    c.spawn("p1", &flood);
    let (frames, _) = c.until(|f, _| matches!(f, Frame::Detached { .. }));
    assert!(matches!(
        frames.last(),
        Some(Frame::Detached { reason, .. }) if reason == "lag"
    ));
    let list = sessions(&mut c);
    assert!(!list[0].attached);
    assert_eq!(list[0].exited, None);
    c.send(Frame::QuitAll);
    assert!(svc.ended_within(DEADLINE));
}

#[test]
fn quit_all_ends_the_children_and_the_service() {
    let mut svc = service("quit", |_| {});
    let mut c = svc.client();
    c.spawn("p1", &idle("x"));
    c.send(Frame::QuitAll);
    assert!(svc.ended_within(DEADLINE));
    assert!(matches!(svc.endpoint.connect(), Err(IpcError::NotRunning)));
}

#[test]
fn an_idle_service_ends_on_its_own() {
    let mut svc = service("idle", |cfg| cfg.idle_exit = Duration::from_millis(300));
    assert!(svc.ended_within(Duration::from_secs(5)));
}

#[test]
fn a_connected_client_keeps_an_idle_service_up() {
    let mut svc = service("held", |cfg| cfg.idle_exit = Duration::from_millis(300));
    let c = svc.client();
    assert!(!svc.ended_within(Duration::from_secs(1)));
    drop(c);
    assert!(svc.ended_within(Duration::from_secs(5)));
}
