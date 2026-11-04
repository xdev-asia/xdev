//! The app's own endpoint for the `xdev` CLI: a per-user pipe or socket
//! from `xdev-ipc`, a token file, and newline-delimited JSON frames.
//! The first line of a connection is a hello with the token; then each
//! line is a `Request` and gets one `Response` line, in order.

use std::fs;
use std::io::{self, BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use xdev_ipc::{IpcError, Stream};
use xdev_workspace::{Registry, path_key};

use crate::atomic::write_atomic;

/// The frames' version; a CLI with another one is refused at hello.
pub const APP_PROTOCOL: u32 = 1;
/// A request line longer than this is answered `too_large`.
pub const LINE_MAX: usize = 256 * 1024;
/// The longest `terminal.wait`, in seconds.
pub const WAIT_MAX_S: u64 = 86_400;
/// The `xdev-ipc` prefix; the terminal service uses `xdev-ptyd`.
pub const PREFIX: &str = "xdev-app";

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
    pub caller: Option<Caller>,
}

/// Who says it is calling: the PTY the CLI runs in (`XDEV_PTY_ID`). A
/// label for scope and audit, not an identity.
#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
pub struct Caller {
    pub pty: Option<String>,
}

/// Where a target stands from the caller's worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// The caller's own worktree.
    Own,
    /// The caller's parent or one of its children.
    Family,
    Other,
    /// No caller worktree: a script outside the app's terminals.
    External,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Own => "own",
            Scope::Family => "family",
            Scope::Other => "other",
            Scope::External => "external",
        }
    }
}

/// The first frame of a connection.
#[derive(Debug, Deserialize)]
pub struct Hello {
    pub protocol: u32,
    pub token: String,
    #[serde(default)]
    pub client: String,
    pub caller: Option<Caller>,
}

/// `<local_dir>/app/endpoint.json`, written at start and removed at a clean exit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointFile {
    pub name: String,
    pub pid: u32,
    pub version: String,
    pub started_ms: i64,
}

/// The recorded worktree or primary checkout that holds `cwd`: the
/// deepest one whose folder is `cwd` or one of its parents.
pub fn caller_worktree(reg: &Registry, cwd: &Path) -> Option<PathBuf> {
    let key = path_key(cwd);
    let holds = |p: &Path| {
        let k = path_key(p);
        key == k || key.starts_with(&format!("{k}/"))
    };
    reg.repos
        .iter()
        .map(|r| &r.path)
        .chain(reg.worktrees.iter().map(|m| &m.path))
        .filter(|p| holds(p))
        .max_by_key(|p| path_key(p).len())
        .cloned()
}

/// The scope of `target` for a caller in `caller_worktree`: its own, its
/// parent or child (`WorktreeMeta.parent`), another, or no caller at all.
pub fn scope_of(caller_worktree: Option<&Path>, target: &Path, reg: &Registry) -> Scope {
    let Some(caller) = caller_worktree else {
        return Scope::External;
    };
    let (me, it) = (path_key(caller), path_key(target));
    if me == it {
        return Scope::Own;
    }
    let parent_of = |key: &str| {
        reg.worktrees
            .iter()
            .find(|m| path_key(&m.path) == key)
            .and_then(|m| m.parent.as_deref())
            .map(path_key)
    };
    if parent_of(&it).as_deref() == Some(me.as_str())
        || parent_of(&me).as_deref() == Some(it.as_str())
    {
        Scope::Family
    } else {
        Scope::Other
    }
}

/// Requests per second a connection may send, and how many may come at once.
pub const RATE_PER_S: f64 = 50.0;
pub const RATE_BURST: f64 = 100.0;
/// How long a new connection has to send its hello.
const HELLO_WAIT: Duration = Duration::from_secs(5);
const ENDPOINT_FILE: &str = "endpoint.json";

/// An error a verb answers with; `code` is one of the spec's error codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> AppError {
        AppError {
            code,
            message: message.into(),
        }
    }
}

/// What answers the requests of every connection.
pub trait Handler: Send + Sync + 'static {
    /// `gone` turns true once the client has disconnected; a long call
    /// (`terminal.wait`) ends then.
    fn handle(
        &self,
        req: &Request,
        caller: &Caller,
        gone: &dyn Fn() -> bool,
    ) -> Result<Value, AppError>;
}

/// The folder of the endpoint's token and `endpoint.json`.
pub fn app_dir(local_dir: &Path) -> PathBuf {
    local_dir.join("app")
}

/// A listening endpoint; `stop` removes `endpoint.json`.
pub struct Running {
    file: PathBuf,
    pid: u32,
}

impl Running {
    /// Removes `endpoint.json` when it is still this run's. The listener
    /// thread ends with the process.
    pub fn stop(&self) {
        let ours = fs::read(&self.file)
            .ok()
            .and_then(|b| serde_json::from_slice::<EndpointFile>(&b).ok())
            .is_some_and(|f| f.pid == self.pid);
        if ours {
            let _ = fs::remove_file(&self.file);
        }
    }
}

/// Binds `<prefix>` in `dir`, writes a fresh token and `endpoint.json`, and
/// answers connections on threads of their own.
pub fn start(
    dir: &Path,
    prefix: &str,
    version: &str,
    now_ms: i64,
    handler: Arc<dyn Handler>,
) -> Result<Running, IpcError> {
    let endpoint = xdev_ipc::endpoint(dir, prefix, APP_PROTOCOL);
    let listener = endpoint.bind()?;
    let token = xdev_ipc::new_token(dir)?;
    let pid = std::process::id();
    let file = dir.join(ENDPOINT_FILE);
    let info = EndpointFile {
        name: endpoint.name().to_owned(),
        pid,
        version: version.to_owned(),
        started_ms: now_ms,
    };
    let bytes = serde_json::to_vec_pretty(&info).map_err(io::Error::other)?;
    write_atomic(&file, &bytes)?;
    let version = version.to_owned();
    thread::spawn(move || {
        loop {
            match listener.accept() {
                Ok(stream) => {
                    let handler = handler.clone();
                    let token = token.clone();
                    let version = version.clone();
                    thread::spawn(move || serve(stream, &token, &version, handler.as_ref()));
                }
                Err(e) => {
                    eprintln!("app endpoint: {e}");
                    thread::sleep(Duration::from_millis(200));
                }
            }
        }
    });
    Ok(Running { file, pid })
}

/// One line read with a cap.
enum Line {
    Text(Vec<u8>),
    TooLarge,
}

/// The next line without its newline; `None` at the end. A line over `max`
/// is read to its end and dropped, so the next one starts clean.
fn read_line(r: &mut impl BufRead, max: usize) -> io::Result<Option<Line>> {
    let mut line = Vec::new();
    let mut over = false;
    loop {
        let buf = match r.fill_buf() {
            Ok(buf) => buf,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if buf.is_empty() {
            return Ok(match (line.is_empty() && !over, over) {
                (true, _) => None,
                (_, true) => Some(Line::TooLarge),
                _ => Some(Line::Text(line)),
            });
        }
        let (part, end) = match buf.iter().position(|&b| b == b'\n') {
            Some(i) => (&buf[..i], Some(i + 1)),
            None => (buf, None),
        };
        if !over {
            if line.len() + part.len() > max {
                over = true;
                line = Vec::new();
            } else {
                line.extend_from_slice(part);
            }
        }
        let used = end.unwrap_or(buf.len());
        r.consume(used);
        if end.is_some() {
            return Ok(Some(if over {
                Line::TooLarge
            } else {
                Line::Text(line)
            }));
        }
    }
}

fn write_frame(w: &mut impl Write, value: &Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    bytes.push(b'\n');
    w.write_all(&bytes)?;
    w.flush()
}

fn error_frame(id: u64, e: &AppError) -> Value {
    json!({ "id": id, "ok": false, "error": { "code": e.code, "message": e.message } })
}

/// A token bucket: `take` says how long to wait before the next request.
struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn new(now: Instant) -> Bucket {
        Bucket {
            tokens: RATE_BURST,
            at: now,
        }
    }

    fn take(&mut self, now: Instant) -> Duration {
        let gained = now.saturating_duration_since(self.at).as_secs_f64() * RATE_PER_S;
        self.tokens = (self.tokens + gained).min(RATE_BURST);
        self.at = now;
        self.tokens -= 1.0;
        if self.tokens >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-self.tokens / RATE_PER_S)
        }
    }
}

/// One connection: the hello, then requests answered in order. A reader
/// thread notices a disconnect while a long call runs.
fn serve(stream: Stream, token: &str, version: &str, handler: &dyn Handler) {
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    let _ = stream.set_read_timeout(Some(HELLO_WAIT));
    let mut reader = BufReader::new(stream);
    let hello = match read_line(&mut reader, LINE_MAX) {
        Ok(Some(Line::Text(line))) => serde_json::from_slice::<Hello>(&line).ok(),
        _ => None,
    };
    // A wrong token learns nothing: the connection just closes.
    let Some(hello) = hello.filter(|h| xdev_ipc::token_eq(&h.token, token)) else {
        return;
    };
    if hello.protocol != APP_PROTOCOL {
        let e = AppError::new("bad_request", format!("protocol {APP_PROTOCOL} expected"));
        let _ = write_frame(
            &mut writer,
            &json!({ "ok": false, "error": { "code": e.code, "message": e.message } }),
        );
        return;
    }
    let ok = json!({ "ok": true, "protocol": APP_PROTOCOL, "version": version });
    if write_frame(&mut writer, &ok).is_err() {
        return;
    }
    let _ = reader.get_ref().set_read_timeout(None);
    let base = hello.caller.unwrap_or_default();
    let gone = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<Line>();
    {
        let gone = gone.clone();
        thread::spawn(move || {
            while let Ok(Some(line)) = read_line(&mut reader, LINE_MAX) {
                if tx.send(line).is_err() {
                    break;
                }
            }
            gone.store(true, Ordering::SeqCst);
        });
    }
    let is_gone = || gone.load(Ordering::SeqCst);
    let mut bucket = Bucket::new(Instant::now());
    for line in rx {
        let delay = bucket.take(Instant::now());
        if !delay.is_zero() {
            thread::sleep(delay);
        }
        let frame = match line {
            Line::TooLarge => error_frame(
                0,
                &AppError::new(
                    "too_large",
                    format!("a request is at most {LINE_MAX} bytes"),
                ),
            ),
            Line::Text(text) => match serde_json::from_slice::<Request>(&text) {
                Err(e) => error_frame(0, &AppError::new("bad_request", e.to_string())),
                Ok(req) => {
                    let caller = req.caller.clone().unwrap_or_else(|| base.clone());
                    match handler.handle(&req, &caller, &is_gone) {
                        Ok(result) => json!({ "id": req.id, "ok": true, "result": result }),
                        Err(e) => error_frame(req.id, &e),
                    }
                }
            },
        };
        if write_frame(&mut writer, &frame).is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::sync::Mutex;

    use super::*;

    /// Echoes the method and caller; `slow` sleeps a little first.
    struct Echo {
        seen: Mutex<Vec<String>>,
    }

    impl Handler for Echo {
        fn handle(
            &self,
            req: &Request,
            caller: &Caller,
            _gone: &dyn Fn() -> bool,
        ) -> Result<Value, AppError> {
            self.seen.lock().unwrap().push(req.method.clone());
            if req.method == "slow" {
                thread::sleep(Duration::from_millis(200));
            }
            if req.method == "fail" {
                return Err(AppError::new("not_found", "nothing"));
            }
            Ok(json!({ "method": req.method, "pty": caller.pty }))
        }
    }

    struct Fixture {
        dir: tempfile::TempDir,
        prefix: String,
        running: Running,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        // Windows pipe names are machine-wide: one per test.
        let prefix = format!(
            "xdev-app-test-{}",
            dir.path().file_name().unwrap().to_string_lossy()
        );
        let handler = Arc::new(Echo {
            seen: Mutex::default(),
        });
        let running = start(dir.path(), &prefix, "9.9.9", 42, handler).unwrap();
        Fixture {
            dir,
            prefix,
            running,
        }
    }

    fn connect(f: &Fixture) -> (Stream, BufReader<Stream>) {
        let s = xdev_ipc::endpoint(f.dir.path(), &f.prefix, APP_PROTOCOL)
            .connect()
            .unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let r = BufReader::new(s.try_clone().unwrap());
        (s, r)
    }

    fn send(w: &mut Stream, v: &Value) {
        write_frame(w, v).unwrap();
    }

    fn recv(r: &mut BufReader<Stream>) -> Value {
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }

    fn hello(f: &Fixture) -> (Stream, BufReader<Stream>) {
        let (mut w, mut r) = connect(f);
        let token = xdev_ipc::read_token(f.dir.path()).unwrap();
        send(
            &mut w,
            &json!({ "protocol": 1, "token": token, "client": "test", "caller": { "pty": "p1" } }),
        );
        assert_eq!(recv(&mut r)["ok"], true);
        (w, r)
    }

    #[test]
    fn endpoint_json_names_this_run_and_stop_removes_it() {
        let f = fixture();
        let file = f.dir.path().join(ENDPOINT_FILE);
        let info: EndpointFile = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(info.pid, std::process::id());
        assert_eq!(info.version, "9.9.9");
        assert_eq!(info.started_ms, 42);
        assert!(info.name.starts_with(&f.prefix), "{}", info.name);
        f.running.stop();
        assert!(!file.exists());
    }

    #[test]
    fn a_wrong_token_closes_the_connection() {
        let f = fixture();
        let (mut w, mut r) = connect(&f);
        send(
            &mut w,
            &json!({ "protocol": 1, "token": "nope", "client": "test" }),
        );
        let mut rest = Vec::new();
        // Closed without a word: the read ends at once with nothing.
        assert_eq!(r.read_to_end(&mut rest).unwrap_or(0), 0);
    }

    #[test]
    fn another_protocol_is_refused() {
        let f = fixture();
        let (mut w, mut r) = connect(&f);
        let token = xdev_ipc::read_token(f.dir.path()).unwrap();
        send(&mut w, &json!({ "protocol": 99, "token": token }));
        let back = recv(&mut r);
        assert_eq!(back["ok"], false);
        assert_eq!(back["error"]["code"], "bad_request");
    }

    #[test]
    fn an_oversize_line_is_too_large_and_the_next_one_works() {
        let f = fixture();
        let (mut w, mut r) = hello(&f);
        let big = format!("{{\"pad\":\"{}\"}}\n", "x".repeat(LINE_MAX + 10));
        w.write_all(big.as_bytes()).unwrap();
        let back = recv(&mut r);
        assert_eq!(back["ok"], false);
        assert_eq!(back["error"]["code"], "too_large");
        send(&mut w, &json!({ "id": 7, "method": "status" }));
        let back = recv(&mut r);
        assert_eq!(back["id"], 7);
        assert_eq!(back["result"]["method"], "status");
    }

    #[test]
    fn two_requests_are_answered_in_order() {
        let f = fixture();
        let (mut w, mut r) = hello(&f);
        send(&mut w, &json!({ "id": 1, "method": "slow" }));
        send(&mut w, &json!({ "id": 2, "method": "fail" }));
        let first = recv(&mut r);
        let second = recv(&mut r);
        assert_eq!(
            (first["id"].clone(), first["ok"].clone()),
            (json!(1), json!(true))
        );
        assert_eq!(second["id"], 2);
        assert_eq!(second["error"]["code"], "not_found");
        assert_eq!(second["error"]["message"], "nothing");
    }

    #[test]
    fn a_request_caller_overrides_the_hello_caller() {
        let f = fixture();
        let (mut w, mut r) = hello(&f);
        send(&mut w, &json!({ "id": 1, "method": "a" }));
        assert_eq!(recv(&mut r)["result"]["pty"], "p1");
        send(
            &mut w,
            &json!({ "id": 2, "method": "a", "caller": { "pty": "p2" } }),
        );
        assert_eq!(recv(&mut r)["result"]["pty"], "p2");
    }

    #[test]
    fn a_bad_frame_is_bad_request() {
        let f = fixture();
        let (mut w, mut r) = hello(&f);
        w.write_all(b"not json\n").unwrap();
        assert_eq!(recv(&mut r)["error"]["code"], "bad_request");
    }

    fn registry() -> Registry {
        let meta = |path: &str, parent: Option<&str>| xdev_workspace::WorktreeMeta {
            repo_id: "r".into(),
            path: path.into(),
            parent: parent.map(PathBuf::from),
            ..Default::default()
        };
        Registry {
            repos: vec![xdev_workspace::RepoEntry {
                id: "r".into(),
                path: "/src/repo".into(),
                ..Default::default()
            }],
            worktrees: vec![
                meta("/wt/lead", None),
                meta("/wt/child", Some("/wt/lead")),
                meta("/wt/lead-2", None),
            ],
            ..Default::default()
        }
    }

    #[test]
    fn the_caller_worktree_is_the_deepest_holder_of_its_cwd() {
        let reg = registry();
        let at = |p: &str| caller_worktree(&reg, Path::new(p)).map(|p| path_key(&p));
        assert_eq!(at("/wt/lead").as_deref(), Some("/wt/lead"));
        assert_eq!(at("/wt/lead/src/deep").as_deref(), Some("/wt/lead"));
        // A sibling whose name starts the same is not inside.
        assert_eq!(at("/wt/lead-2/x").as_deref(), Some("/wt/lead-2"));
        assert_eq!(at("/src/repo/a").as_deref(), Some("/src/repo"));
        assert_eq!(at("/elsewhere"), None);
    }

    #[test]
    fn scopes_are_own_family_other_and_external() {
        let reg = registry();
        let scope = |caller: Option<&str>, target: &str| {
            scope_of(caller.map(Path::new), Path::new(target), &reg)
        };
        assert_eq!(scope(Some("/wt/lead"), "/wt/lead/"), Scope::Own);
        assert_eq!(scope(Some("/wt/lead"), "/wt/child"), Scope::Family);
        assert_eq!(scope(Some("/wt/child"), "/wt/lead"), Scope::Family);
        assert_eq!(scope(Some("/wt/child"), "/wt/lead-2"), Scope::Other);
        assert_eq!(scope(Some("/src/repo"), "/wt/lead"), Scope::Other);
        assert_eq!(scope(None, "/wt/lead"), Scope::External);
        assert_eq!(Scope::Family.as_str(), "family");
    }

    #[test]
    fn read_line_caps_and_resyncs() {
        let mut r = io::Cursor::new(b"abc\ntoolongline\nok".to_vec());
        assert!(matches!(read_line(&mut r, 5).unwrap(), Some(Line::Text(t)) if t == b"abc"));
        assert!(matches!(
            read_line(&mut r, 5).unwrap(),
            Some(Line::TooLarge)
        ));
        assert!(matches!(read_line(&mut r, 5).unwrap(), Some(Line::Text(t)) if t == b"ok"));
        assert!(read_line(&mut r, 5).unwrap().is_none());
    }

    #[test]
    fn the_bucket_lets_a_burst_through_then_paces() {
        let t0 = Instant::now();
        let mut b = Bucket::new(t0);
        for _ in 0..100 {
            assert_eq!(b.take(t0), Duration::ZERO);
        }
        let wait = b.take(t0);
        assert!(
            wait > Duration::ZERO && wait <= Duration::from_millis(25),
            "{wait:?}"
        );
        // A second later 50 more are free.
        let t1 = t0 + Duration::from_secs(1);
        let mut b = Bucket::new(t0);
        for _ in 0..100 {
            b.take(t0);
        }
        for _ in 0..49 {
            assert_eq!(b.take(t1), Duration::ZERO);
        }
    }
}
