//! One server per (worktree, language): started on the first open document,
//! restarted after a crash a few times, stopped when idle.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::conn::{OnClose, OnNotify};
use crate::docs::uri_of;
use crate::server::{Server, ServerCaps};
use crate::{LspError, LspLanguage, State};

/// A server with no open document stops after this long.
pub const NO_DOCS_STOP: Duration = Duration::from_secs(120);
/// How often idle servers are looked for.
pub const SWEEP_EVERY: Duration = Duration::from_secs(30);
/// Crashes inside this window count toward the restart limit.
pub const RESTART_WINDOW: Duration = Duration::from_secs(5 * 60);
/// Restarts allowed inside the window; the next crash is final.
pub const MAX_RESTARTS: usize = 3;

/// The program that serves one language, and its environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// PATH for the server, when the app overrides it.
    pub path_env: Option<OsString>,
}

impl Launch {
    /// The program's name without its directory.
    pub fn name(&self) -> String {
        self.program
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

/// One server's place in its life.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub worktree: PathBuf,
    pub language: LspLanguage,
    pub state: State,
    /// The program's name without its directory.
    pub program: String,
    pub open_docs: usize,
}

/// Starts a server for a launch in a worktree.
pub type Spawner =
    Box<dyn Fn(&Launch, &Path, OnNotify, OnClose) -> Result<Server, LspError> + Send + Sync>;
/// Told each state change, outside the pool's lock.
pub type StatusSink = Box<dyn Fn(Status) + Send + Sync>;
/// Told each notification a server sends, on that server's reader thread.
pub type NotifySink = Box<dyn Fn(&Path, LspLanguage, &str, Value) + Send + Sync>;

/// True when a server should stop: no document open for two minutes, or no
/// use for `idle`.
pub fn should_stop(now: Instant, last_used: Instant, open_docs: usize, idle: Duration) -> bool {
    let quiet = now.saturating_duration_since(last_used);
    (open_docs == 0 && quiet >= NO_DOCS_STOP) || quiet > idle
}

/// Starts real processes.
pub fn process_spawner() -> Spawner {
    Box::new(|launch, worktree, on_notify, on_close| {
        let args: Vec<&str> = launch.args.iter().map(String::as_str).collect();
        Server::spawn(
            &launch.program,
            &args,
            worktree,
            launch.path_env.clone(),
            on_notify,
            on_close,
        )
    })
}

type Key = (PathBuf, LspLanguage);

struct Doc {
    language_id: String,
    version: i32,
    text: String,
}

struct Entry {
    state: State,
    server: Option<Arc<Server>>,
    open: HashMap<String, Doc>,
    last_used: Instant,
    restarts: Vec<Instant>,
    launch: Launch,
    /// Bumped on every start and stop; a close from an older server is not
    /// a crash.
    generation: u64,
}

fn status_of(key: &Key, e: &Entry) -> Status {
    Status {
        worktree: key.0.clone(),
        language: key.1,
        state: e.state,
        program: e.launch.name(),
        open_docs: e.open.len(),
    }
}

fn uri(worktree: &Path, rel: &str) -> String {
    uri_of(worktree, rel).map(String::from).unwrap_or_default()
}

fn did_open(worktree: &Path, rel: &str, doc: &Doc) -> Value {
    json!({"textDocument": {
        "uri": uri(worktree, rel),
        "languageId": doc.language_id,
        "version": doc.version,
        "text": doc.text,
    }})
}

fn did_change(worktree: &Path, rel: &str, doc: &Doc) -> Value {
    json!({
        "textDocument": {"uri": uri(worktree, rel), "version": doc.version},
        "contentChanges": [{"text": doc.text}],
    })
}

struct Inner {
    entries: Mutex<HashMap<Key, Entry>>,
    spawner: Spawner,
    on_status: StatusSink,
    on_notify: NotifySink,
    idle: Mutex<Duration>,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, HashMap<Key, Entry>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn idle(&self) -> Duration {
        *self.idle.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn emit(&self, out: Vec<Status>) {
        for s in out {
            (self.on_status)(s);
        }
    }

    /// Marks the entry starting under a new generation and spawns its
    /// server on a thread. Called with the lock held.
    fn begin(self: &Arc<Self>, key: &Key, entry: &mut Entry) -> Status {
        entry.generation += 1;
        entry.state = State::Starting;
        entry.server = None;
        let generation = entry.generation;
        let launch = entry.launch.clone();
        let key2 = key.clone();
        let weak = Arc::downgrade(self);
        let _ = thread::Builder::new()
            .name("lsp-start".into())
            .spawn(move || {
                if let Some(inner) = weak.upgrade() {
                    inner.run_start(key2, generation, launch);
                }
            });
        status_of(key, entry)
    }

    fn run_start(self: &Arc<Self>, key: Key, generation: u64, launch: Launch) {
        let weak = Arc::downgrade(self);
        let (worktree, language) = key.clone();
        let on_notify: OnNotify = Box::new(move |method, params| {
            if let Some(inner) = weak.upgrade() {
                (inner.on_notify)(&worktree, language, method, params);
            }
        });
        let weak = Arc::downgrade(self);
        let close_key = key.clone();
        let on_close: OnClose = Box::new(move || {
            if let Some(inner) = weak.upgrade() {
                inner.closed(&close_key, generation);
            }
        });
        let result = (self.spawner)(&launch, &key.0, on_notify, on_close);
        let mut out = Vec::new();
        let mut stale = None;
        {
            let mut entries = self.lock();
            match (entries.get_mut(&key), result) {
                (Some(entry), Ok(server)) if entry.generation == generation => {
                    let server = Arc::new(server);
                    entry.server = Some(server.clone());
                    if server.is_closed() {
                        // It closed before it was stored, so `closed` did
                        // not see it.
                        out.extend(self.crash(&key, entry));
                    } else {
                        for (rel, doc) in &entry.open {
                            let _ =
                                server.notify("textDocument/didOpen", did_open(&key.0, rel, doc));
                        }
                        entry.state = State::Ready;
                        entry.last_used = Instant::now();
                        out.push(status_of(&key, entry));
                    }
                }
                (Some(entry), Err(_)) if entry.generation == generation => {
                    entry.state = State::Crashed;
                    out.push(status_of(&key, entry));
                }
                // Stopped or restarted while starting.
                (_, Ok(server)) => stale = Some(server),
                (_, Err(_)) => {}
            }
        }
        if let Some(server) = stale {
            server.stop();
        }
        self.emit(out);
    }

    /// A server's output ended.
    fn closed(self: &Arc<Self>, key: &Key, generation: u64) {
        let out = {
            let mut entries = self.lock();
            match entries.get_mut(key) {
                Some(entry) if entry.generation == generation && entry.server.is_some() => {
                    self.crash(key, entry)
                }
                _ => Vec::new(),
            }
        };
        self.emit(out);
    }

    /// Restarts a crashed server, or gives up after too many crashes.
    fn crash(self: &Arc<Self>, key: &Key, entry: &mut Entry) -> Vec<Status> {
        entry.server = None;
        entry.state = State::Crashed;
        let mut out = vec![status_of(key, entry)];
        let now = Instant::now();
        entry
            .restarts
            .retain(|t| now.saturating_duration_since(*t) < RESTART_WINDOW);
        if entry.restarts.len() < MAX_RESTARTS {
            entry.restarts.push(now);
            out.push(self.begin(key, entry));
        } else {
            entry.generation += 1;
        }
        out
    }
}

/// Takes the server out for stopping; its close is then not a crash.
fn take_for_stop(entry: &mut Entry) -> Option<Arc<Server>> {
    entry.generation += 1;
    entry.state = State::Stopped;
    entry.server.take()
}

/// Stops servers side by side and waits for all.
fn stop_servers(servers: Vec<Arc<Server>>) {
    let handles: Vec<_> = servers
        .into_iter()
        .map(|s| thread::spawn(move || s.stop()))
        .collect();
    for h in handles {
        let _ = h.join();
    }
}

fn find_doc<'a>(
    entries: &'a mut HashMap<Key, Entry>,
    worktree: &Path,
    rel: &str,
) -> Option<(&'a Key, &'a mut Entry)> {
    entries
        .iter_mut()
        .find(|(k, e)| k.0 == worktree && e.open.contains_key(rel))
}

pub struct Pool {
    inner: Arc<Inner>,
}

impl Pool {
    /// A pool that starts real processes.
    pub fn new(on_status: StatusSink, on_notify: NotifySink) -> Pool {
        Pool::with_spawner(process_spawner(), on_status, on_notify)
    }

    /// A pool with its own way to start servers; tests start fakes.
    pub fn with_spawner(spawner: Spawner, on_status: StatusSink, on_notify: NotifySink) -> Pool {
        let inner = Arc::new(Inner {
            entries: Mutex::new(HashMap::new()),
            spawner,
            on_status,
            on_notify,
            idle: Mutex::new(Duration::from_secs(10 * 60)),
        });
        let weak: Weak<Inner> = Arc::downgrade(&inner);
        let _ = thread::Builder::new()
            .name("lsp-sweeper".into())
            .spawn(move || {
                loop {
                    thread::sleep(SWEEP_EVERY);
                    let Some(inner) = weak.upgrade() else { break };
                    Pool { inner }.sweep(Instant::now());
                }
            });
        Pool { inner }
    }

    pub fn set_idle(&self, idle: Duration) {
        *self
            .inner
            .idle
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = idle;
    }

    /// Opens `rel` in the server for `language`, starting it when needed.
    /// The document is kept even when the server is not ready, and sent
    /// when it is.
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &self,
        worktree: &Path,
        language: LspLanguage,
        launch: Launch,
        rel: &str,
        language_id: &str,
        version: i32,
        text: String,
    ) -> Result<State, LspError> {
        uri_of(worktree, rel)?;
        let key = (worktree.to_path_buf(), language);
        let doc = Doc {
            language_id: language_id.to_owned(),
            version,
            text,
        };
        let mut out = Vec::new();
        let state = {
            let mut entries = self.inner.lock();
            let entry = entries.entry(key.clone()).or_insert_with(|| Entry {
                state: State::Stopped,
                server: None,
                open: HashMap::new(),
                last_used: Instant::now(),
                restarts: Vec::new(),
                launch,
                generation: 0,
            });
            entry.last_used = Instant::now();
            let reopened = entry.open.contains_key(rel);
            if let (State::Ready, Some(server)) = (entry.state, &entry.server) {
                let _ = if reopened {
                    server.notify("textDocument/didChange", did_change(worktree, rel, &doc))
                } else {
                    server.notify("textDocument/didOpen", did_open(worktree, rel, &doc))
                };
            }
            entry.open.insert(rel.to_owned(), doc);
            if entry.state == State::Stopped {
                out.push(self.inner.begin(&key, entry));
            } else {
                out.push(status_of(&key, entry));
            }
            entry.state
        };
        self.inner.emit(out);
        Ok(state)
    }

    /// Replaces the text of an open document.
    pub fn change(
        &self,
        worktree: &Path,
        rel: &str,
        version: i32,
        text: String,
    ) -> Result<(), LspError> {
        let mut entries = self.inner.lock();
        let (_, entry) = find_doc(&mut entries, worktree, rel).ok_or(LspError::NotOpen)?;
        entry.last_used = Instant::now();
        let doc = entry.open.get_mut(rel).ok_or(LspError::NotOpen)?;
        doc.version = version;
        doc.text = text;
        if let (State::Ready, Some(server)) = (entry.state, &entry.server)
            && server.caps().sync != 0
        {
            let _ = server.notify("textDocument/didChange", did_change(worktree, rel, doc));
        }
        Ok(())
    }

    /// Closes a document; closing one that is not open does nothing.
    pub fn close(&self, worktree: &Path, rel: &str) {
        let mut entries = self.inner.lock();
        let Some((_, entry)) = find_doc(&mut entries, worktree, rel) else {
            return;
        };
        entry.open.remove(rel);
        entry.last_used = Instant::now();
        if let (State::Ready, Some(server)) = (entry.state, &entry.server) {
            let _ = server.notify(
                "textDocument/didClose",
                json!({"textDocument": {"uri": uri(worktree, rel)}}),
            );
        }
    }

    /// The text the pool holds for an open document.
    pub fn text_of(&self, worktree: &Path, rel: &str) -> Option<String> {
        let mut entries = self.inner.lock();
        let (_, entry) = find_doc(&mut entries, worktree, rel)?;
        entry.open.get(rel).map(|d| d.text.clone())
    }

    /// The ready server of an open document. A stopped one is started, and
    /// the call says it is starting.
    fn server_for(&self, worktree: &Path, rel: &str) -> Result<Arc<Server>, LspError> {
        let mut out = Vec::new();
        let result = {
            let mut entries = self.inner.lock();
            let (key, entry) = find_doc(&mut entries, worktree, rel).ok_or(LspError::NotOpen)?;
            let key = key.clone();
            entry.last_used = Instant::now();
            match (entry.state, &entry.server) {
                (State::Ready, Some(server)) => Ok(server.clone()),
                (State::Stopped, _) => {
                    out.push(self.inner.begin(&key, entry));
                    Err(LspError::Starting)
                }
                (State::Crashed, _) => Err(LspError::Crashed),
                _ => Err(LspError::Starting),
            }
        };
        self.inner.emit(out);
        result
    }

    /// Sends a request about an open document; `params` get its
    /// `textDocument`. `Unsupported` when `needs` says the server lacks the
    /// capability.
    pub fn request(
        &self,
        worktree: &Path,
        rel: &str,
        method: &str,
        mut params: Value,
        timeout: Duration,
        needs: fn(&ServerCaps) -> bool,
    ) -> Result<Value, LspError> {
        let server = self.server_for(worktree, rel)?;
        if !needs(server.caps()) {
            return Err(LspError::Unsupported);
        }
        params["textDocument"] = json!({"uri": uri_of(worktree, rel)?.as_str()});
        server.request(method, params, timeout)
    }

    /// The ready servers of a worktree that have a capability.
    pub fn servers_of(&self, worktree: &Path, needs: fn(&ServerCaps) -> bool) -> Vec<Arc<Server>> {
        let mut entries = self.inner.lock();
        entries
            .iter_mut()
            .filter(|(k, _)| k.0 == worktree)
            .filter_map(|(_, e)| {
                let server = e.server.as_ref().filter(|s| needs(s.caps()))?.clone();
                e.last_used = Instant::now();
                Some(server)
            })
            .collect()
    }

    /// Stops what `should_stop` says and forgets stopped servers with no
    /// open document.
    pub fn sweep(&self, now: Instant) {
        let idle = self.inner.idle();
        let mut stopping = Vec::new();
        let mut out = Vec::new();
        {
            let mut entries = self.inner.lock();
            for (key, entry) in entries.iter_mut() {
                if entry.state == State::Ready
                    && should_stop(now, entry.last_used, entry.open.len(), idle)
                {
                    stopping.extend(take_for_stop(entry));
                    out.push(status_of(key, entry));
                }
            }
            entries.retain(|_, e| !(e.state == State::Stopped && e.open.is_empty()));
        }
        self.inner.emit(out);
        stop_servers(stopping);
    }

    /// Stops the servers of `worktree` (all when None) and starts again
    /// those with open documents, with the crash count cleared.
    pub fn restart(&self, worktree: Option<&Path>) {
        let mut stopping = Vec::new();
        let mut out = Vec::new();
        {
            let mut entries = self.inner.lock();
            for (key, entry) in entries.iter_mut() {
                if worktree.is_some_and(|w| w != key.0) {
                    continue;
                }
                stopping.extend(take_for_stop(entry));
                entry.restarts.clear();
                if entry.open.is_empty() {
                    out.push(status_of(key, entry));
                } else {
                    out.push(self.inner.begin(key, entry));
                }
            }
            entries.retain(|_, e| !(e.state == State::Stopped && e.open.is_empty()));
        }
        self.inner.emit(out);
        let _ = thread::Builder::new()
            .name("lsp-stop".into())
            .spawn(move || stop_servers(stopping));
    }

    /// Stops every server and forgets every document; for app exit.
    pub fn stop_all(&self) {
        let stopping: Vec<_> = {
            let mut entries = self.inner.lock();
            let all = entries.values_mut().filter_map(take_for_stop).collect();
            entries.clear();
            all
        };
        stop_servers(stopping);
    }

    pub fn status(&self) -> Vec<Status> {
        let entries = self.inner.lock();
        let mut all: Vec<_> = entries.iter().map(|(k, e)| status_of(k, e)).collect();
        all.sort_by(|a, b| (&a.worktree, a.language).cmp(&(&b.worktree, b.language)));
        all
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conn::Connection;
    use crate::framing::{read_message, write_message};
    use std::io::{BufReader, PipeWriter, pipe};
    use std::sync::{Condvar, mpsc};

    const WAIT: Duration = Duration::from_secs(5);

    fn eventually(what: &str, f: impl Fn() -> bool) {
        let deadline = Instant::now() + WAIT;
        while !f() {
            assert!(Instant::now() < deadline, "{what}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn should_stop_table() {
        let t0 = Instant::now();
        let idle = Duration::from_secs(600);
        let s = Duration::from_secs;
        let cases = [
            (s(0), 0, false),
            (s(119), 0, false),
            (s(120), 0, true),
            (s(119), 2, false),
            (s(600), 2, false),
            (s(601), 2, true),
            (s(601), 0, true),
        ];
        for (after, docs, want) in cases {
            assert_eq!(
                should_stop(t0 + after, t0, docs, idle),
                want,
                "{after:?} {docs}"
            );
        }
        // A clock that went back stops nothing.
        assert!(!should_stop(t0, t0 + s(5), 1, idle));
    }

    /// Fake servers over pipes: what each received, and a way to make the
    /// latest one crash.
    #[derive(Default)]
    struct Fakes {
        seen: Mutex<Vec<String>>,
        outs: Mutex<Vec<Arc<Mutex<Option<PipeWriter>>>>>,
        fail: Mutex<bool>,
        /// While set, spawns wait.
        hold: (Mutex<bool>, Condvar),
    }

    impl Fakes {
        fn seen(&self) -> Vec<String> {
            self.seen.lock().unwrap().clone()
        }

        fn count(&self, method: &str) -> usize {
            self.seen().iter().filter(|m| *m == method).count()
        }

        fn hold(&self, on: bool) {
            *self.hold.0.lock().unwrap() = on;
            self.hold.1.notify_all();
        }

        fn crash_latest(&self) {
            let out = self.outs.lock().unwrap().last().cloned().unwrap();
            *out.lock().unwrap() = None;
        }
    }

    fn spawner(fakes: Arc<Fakes>) -> Spawner {
        Box::new(move |_launch, worktree, on_notify, on_close| {
            let held = fakes.hold.0.lock().unwrap();
            drop(fakes.hold.1.wait_while(held, |on| *on).unwrap());
            if *fakes.fail.lock().unwrap() {
                return Err(LspError::Spawn("not found".into()));
            }
            let (client_in, server_out) = pipe().unwrap();
            let (server_in, client_out) = pipe().unwrap();
            let out = Arc::new(Mutex::new(Some(server_out)));
            fakes.outs.lock().unwrap().push(out.clone());
            let fakes2 = fakes.clone();
            thread::spawn(move || {
                let mut from = BufReader::new(server_in);
                while let Ok(Some(msg)) = read_message(&mut from) {
                    let method = msg["method"].as_str().unwrap_or_default().to_owned();
                    fakes2.seen.lock().unwrap().push(method.clone());
                    let reply = match method.as_str() {
                        "initialize" => Some(
                            json!({"capabilities": {"hoverProvider": true, "textDocumentSync": 1}}),
                        ),
                        "textDocument/hover" => {
                            Some(json!({"contents": msg["params"]["textDocument"]["uri"]}))
                        }
                        "shutdown" => Some(Value::Null),
                        "exit" => {
                            *out.lock().unwrap() = None;
                            break;
                        }
                        _ => None,
                    };
                    let mut guard = out.lock().unwrap();
                    let Some(w) = guard.as_mut() else { continue };
                    if let Some(result) = reply {
                        let _ = write_message(
                            w,
                            &json!({"jsonrpc": "2.0", "id": msg["id"], "result": result}),
                        );
                    } else if method == "textDocument/didOpen" {
                        let _ = write_message(
                            w,
                            &json!({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
                                "params": {"uri": msg["params"]["textDocument"]["uri"], "diagnostics": []}}),
                        );
                    }
                }
            });
            let conn = Connection::start_with_close(
                BufReader::new(client_in),
                client_out,
                on_notify,
                on_close,
            );
            Server::over(conn, worktree, "fake")
        })
    }

    struct Harness {
        pool: Pool,
        fakes: Arc<Fakes>,
        statuses: mpsc::Receiver<Status>,
        notes: mpsc::Receiver<(PathBuf, String)>,
        root: PathBuf,
        _dir: tempfile::TempDir,
    }

    impl Harness {
        fn new() -> Harness {
            let fakes = Arc::new(Fakes::default());
            let (st_tx, statuses) = mpsc::channel();
            let st_tx = Mutex::new(st_tx);
            let (n_tx, notes) = mpsc::channel();
            let n_tx = Mutex::new(n_tx);
            let pool = Pool::with_spawner(
                spawner(fakes.clone()),
                Box::new(move |s| {
                    let _ = st_tx.lock().unwrap().send(s);
                }),
                Box::new(move |w, _, m, _| {
                    let _ = n_tx.lock().unwrap().send((w.to_path_buf(), m.to_owned()));
                }),
            );
            let dir = tempfile::tempdir().unwrap();
            Harness {
                pool,
                fakes,
                statuses,
                notes,
                root: dir.path().join("w"),
                _dir: dir,
            }
        }

        fn launch() -> Launch {
            Launch {
                program: PathBuf::from("/bin/fake"),
                args: vec![],
                path_env: None,
            }
        }

        fn open(&self, rel: &str) -> State {
            self.pool
                .open(
                    &self.root,
                    LspLanguage::Rust,
                    Harness::launch(),
                    rel,
                    "rust",
                    1,
                    "fn a() {}".into(),
                )
                .unwrap()
        }

        fn wait_for(&self, state: State) -> Status {
            loop {
                let s = self.statuses.recv_timeout(WAIT).expect("a status");
                if s.state == state {
                    return s;
                }
            }
        }

        fn hover(&self, rel: &str) -> Result<Value, LspError> {
            self.pool.request(
                &self.root,
                rel,
                "textDocument/hover",
                json!({"position": {"line": 0, "character": 0}}),
                WAIT,
                |c| c.hover,
            )
        }
    }

    #[test]
    fn open_starts_once_and_sends_every_document() {
        let h = Harness::new();
        h.fakes.hold(true);
        assert_eq!(h.open("a.rs"), State::Starting);
        assert_eq!(h.open("b.rs"), State::Starting);
        assert_eq!(h.hover("a.rs"), Err(LspError::Starting));
        h.fakes.hold(false);
        let ready = h.wait_for(State::Ready);
        assert_eq!(ready.program, "fake");
        assert_eq!(ready.open_docs, 2);
        let (w, m) = h.notes.recv_timeout(WAIT).unwrap();
        assert_eq!(
            (w, m.as_str()),
            (h.root.clone(), "textDocument/publishDiagnostics")
        );
        let uri = h.hover("b.rs").unwrap();
        assert!(uri["contents"].as_str().unwrap().ends_with("/w/b.rs"));
        assert_eq!(h.fakes.count("initialize"), 1);
        assert_eq!(h.fakes.count("textDocument/didOpen"), 2);
        assert_eq!(
            h.pool.request(
                &h.root,
                "a.rs",
                "textDocument/definition",
                json!({}),
                WAIT,
                |c| c.definition
            ),
            Err(LspError::Unsupported)
        );
        assert_eq!(h.hover("c.rs"), Err(LspError::NotOpen));
        h.pool
            .change(&h.root, "a.rs", 2, "fn b() {}".into())
            .unwrap();
        assert_eq!(
            h.pool.text_of(&h.root, "a.rs").as_deref(),
            Some("fn b() {}")
        );
        h.pool.close(&h.root, "a.rs");
        h.pool.close(&h.root, "a.rs");
        assert_eq!(
            h.pool.change(&h.root, "a.rs", 3, String::new()),
            Err(LspError::NotOpen)
        );
        // The fake reads in order; a hover after them proves they arrived.
        h.hover("b.rs").unwrap();
        assert_eq!(h.fakes.count("textDocument/didChange"), 1);
        assert_eq!(h.fakes.count("textDocument/didClose"), 1);
        assert_eq!(h.pool.status()[0].open_docs, 1);
    }

    #[test]
    fn a_crash_restarts_and_reopens_then_gives_up() {
        let h = Harness::new();
        h.open("a.rs");
        h.wait_for(State::Ready);
        for round in 1..=MAX_RESTARTS {
            h.fakes.crash_latest();
            h.wait_for(State::Crashed);
            h.wait_for(State::Ready);
            assert_eq!(h.fakes.count("initialize"), round + 1);
        }
        h.hover("a.rs").unwrap();
        assert_eq!(h.fakes.count("textDocument/didOpen"), MAX_RESTARTS + 1);
        h.fakes.crash_latest();
        h.wait_for(State::Crashed);
        assert_eq!(h.hover("a.rs"), Err(LspError::Crashed));
        assert_eq!(h.open("b.rs"), State::Crashed);
        // A restart clears the count.
        h.pool.restart(Some(&h.root));
        h.wait_for(State::Ready);
        h.hover("b.rs").unwrap();
    }

    #[test]
    fn a_failed_spawn_is_crashed() {
        let h = Harness::new();
        *h.fakes.fail.lock().unwrap() = true;
        h.open("a.rs");
        h.wait_for(State::Crashed);
        assert_eq!(h.hover("a.rs"), Err(LspError::Crashed));
    }

    #[test]
    fn sweep_stops_idle_servers_and_reopen_restarts() {
        let h = Harness::new();
        h.open("a.rs");
        h.wait_for(State::Ready);
        // In use and a document open: kept.
        h.pool.sweep(Instant::now() + Duration::from_secs(150));
        assert_eq!(h.pool.status()[0].state, State::Ready);
        h.pool.set_idle(Duration::from_secs(60));
        h.pool.sweep(Instant::now() + Duration::from_secs(61));
        h.wait_for(State::Stopped);
        assert_eq!(h.fakes.count("shutdown"), 1);
        eventually("exit", || h.fakes.count("exit") == 1);
        // The document is still open: asking starts the server again.
        assert_eq!(h.hover("a.rs"), Err(LspError::Starting));
        h.wait_for(State::Ready);
        h.hover("a.rs").unwrap();
        // Closed and quiet for two minutes: stopped and forgotten.
        h.pool.close(&h.root, "a.rs");
        h.pool.set_idle(Duration::from_secs(600));
        h.pool.sweep(Instant::now() + Duration::from_secs(121));
        h.wait_for(State::Stopped);
        assert!(h.pool.status().is_empty());
    }

    #[test]
    fn stop_all_stops_every_server() {
        let h = Harness::new();
        h.open("a.rs");
        h.pool
            .open(
                &h.root,
                LspLanguage::Go,
                Harness::launch(),
                "m.go",
                "go",
                1,
                String::new(),
            )
            .unwrap();
        h.wait_for(State::Ready);
        h.wait_for(State::Ready);
        h.pool.stop_all();
        eventually("exit", || h.fakes.count("exit") == 2);
        assert!(h.pool.status().is_empty());
        assert!(h.statuses.try_iter().all(|s| s.state != State::Crashed));
    }

    #[test]
    fn open_refuses_paths_outside() {
        let h = Harness::new();
        assert_eq!(
            h.pool.open(
                &h.root,
                LspLanguage::Rust,
                Harness::launch(),
                "../x.rs",
                "rust",
                1,
                String::new()
            ),
            Err(LspError::Outside)
        );
    }
}
