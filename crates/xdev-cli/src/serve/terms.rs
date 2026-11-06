//! The terminals `xdev serve` owns: one PTY each, the last `RING` bytes of
//! its output, and the peers watching it. A term stays listed after its
//! child exits, until `remove`.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
use std::time::{Duration, Instant};

use xdev_link::{PeerTerm, PeerTermState};
use xdev_pty::ring::Ring;
use xdev_pty::{Session, SpawnSpec};

/// What a watcher can catch up on, the desktop tap size.
pub const RING: usize = 256 * 1024;
/// The size a term starts at; nobody resizes a headless one.
pub const COLS: u16 = 120;
pub const ROWS: u16 = 32;
/// How long `kill_all` waits for each child.
pub const EXIT_WAIT: Duration = Duration::from_secs(5);
/// How long after an exit the last output may still come, when the console
/// does not report its end.
const DRAIN_WAIT: Duration = Duration::from_secs(2);

/// The cursor query ConPTY sends before it prints, and the answer a
/// terminal gives. Nobody draws a term no peer watches, so serve answers.
const DSR: &[u8] = b"\x1b[6n";
const DSR_ANSWER: &[u8] = b"\x1b[1;1R";

/// One event for a watcher, called with the terms locked: keep it short and
/// never call back into `Terms`.
pub enum Frame<'a> {
    /// `seq` is the offset of `bytes[0]` in all the term printed.
    Output { seq: u64, bytes: &'a [u8] },
    /// The last frame: `exited`, `killed` or `host_stopped`.
    Closed(&'static str),
}

pub type Watcher = Box<dyn FnMut(Frame<'_>) + Send>;

/// Called once per child exit, outside the lock, with the term id.
pub type OnExit = Arc<dyn Fn(&str, Option<i32>) + Send + Sync>;

/// A program to run in a project folder.
pub struct Start {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, OsString)>,
    pub cwd: PathBuf,
    pub project_id: String,
    pub title: String,
    pub agent: Option<String>,
    /// Typed once, right after the spawn.
    pub input_after: Option<Vec<u8>>,
}

struct Term {
    id: String,
    session: Arc<Session>,
    ring: Ring,
    state: PeerTermState,
    exited: bool,
    /// The output pump has ended: no byte comes after this.
    drained: bool,
    /// The watchers got their last frame; later ones only replay.
    ended: bool,
    project_id: String,
    title: String,
    agent: Option<String>,
    watchers: Vec<(u64, Watcher)>,
}

impl Term {
    fn info(&self) -> PeerTerm {
        PeerTerm {
            id: self.id.clone(),
            title: self.title.clone(),
            agent: self.agent.clone(),
            state: self.state,
            project_id: Some(self.project_id.clone()),
        }
    }

    fn close(&mut self, reason: &'static str) {
        for (_, w) in &mut self.watchers {
            w(Frame::Closed(reason));
        }
        self.watchers.clear();
    }

    /// Ends the watchers once the child is gone and its last output is in.
    fn end_if_done(&mut self) {
        if self.exited && self.drained && !self.ended {
            self.ended = true;
            self.close("exited");
        }
    }
}

/// Dropped with the output callback, when the pump has read the last byte.
struct Drained {
    shared: Weak<Shared>,
    id: String,
}

impl Drop for Drained {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.upgrade() {
            if let Some(term) = shared.lock().get(&self.id) {
                term.drained = true;
                term.end_if_done();
            }
            shared.changed.notify_all();
        }
    }
}

#[derive(Default)]
struct Inner {
    next: u64,
    terms: Vec<Term>,
}

impl Inner {
    fn get(&mut self, id: &str) -> Option<&mut Term> {
        self.terms.iter_mut().find(|t| t.id == id)
    }
}

#[derive(Default)]
struct Shared {
    inner: Mutex<Inner>,
    /// Signalled when a child exits or a pump ends.
    changed: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Clone)]
pub struct Terms {
    shared: Arc<Shared>,
    on_exit: OnExit,
}

impl Terms {
    pub fn new(on_exit: OnExit) -> Terms {
        Terms {
            shared: Arc::default(),
            on_exit,
        }
    }

    /// Starts `start` in a PTY; the new term, `Running`. The error is the
    /// PTY's code.
    pub fn open(&self, start: Start) -> Result<PeerTerm, &'static str> {
        let Start {
            program,
            args,
            env,
            cwd,
            project_id,
            title,
            agent,
            input_after,
        } = start;
        let spec = SpawnSpec {
            program,
            args,
            env,
            cwd,
            cols: COLS,
            rows: ROWS,
        };
        // Held across the spawn, so the callbacks find the term in the map.
        let mut inner = self.shared.lock();
        inner.next += 1;
        let id = format!("s{}", inner.next);

        let answer: Arc<OnceLock<Arc<Session>>> = Arc::default();
        let asked = Arc::new(AtomicBool::new(false));
        let on_output = {
            let shared = Arc::downgrade(&self.shared);
            let (id, answer, asked) = (id.clone(), answer.clone(), asked.clone());
            let drained = Drained {
                shared: shared.clone(),
                id: id.clone(),
            };
            move |bytes: Vec<u8>| {
                let _owned = &drained;
                let Some(shared) = shared.upgrade() else {
                    return;
                };
                let mut inner = shared.lock();
                let Some(term) = inner.get(&id) else {
                    return;
                };
                let seq = term.ring.end();
                term.ring.push(&bytes);
                if term.watchers.is_empty() && bytes.windows(DSR.len()).any(|w| w == DSR) {
                    match answer.get() {
                        Some(s) => s.write(DSR_ANSWER.to_vec()),
                        None => asked.store(true, Ordering::SeqCst),
                    }
                }
                for (_, w) in &mut term.watchers {
                    w(Frame::Output { seq, bytes: &bytes });
                }
            }
        };
        let on_exit = {
            let shared = Arc::downgrade(&self.shared);
            let cb = self.on_exit.clone();
            let id = id.clone();
            move |code: Option<i32>| {
                if let Some(shared) = shared.upgrade() {
                    let mut inner = shared.lock();
                    if let Some(term) = inner.get(&id) {
                        term.exited = true;
                        term.state = if code == Some(0) {
                            PeerTermState::Done
                        } else {
                            PeerTermState::Error
                        };
                        term.end_if_done();
                    }
                    shared.changed.notify_all();
                    // The last output can trail the exit; wait for the pump,
                    // then end the watchers even if it never reports.
                    let (mut inner, _) = shared
                        .changed
                        .wait_timeout_while(inner, DRAIN_WAIT, |i| {
                            i.get(&id).is_some_and(|t| !t.drained)
                        })
                        .unwrap_or_else(PoisonError::into_inner);
                    if let Some(term) = inner.get(&id) {
                        term.drained = true;
                        term.end_if_done();
                    }
                }
                cb(&id, code);
            }
        };
        let session = Session::spawn_with_window(spec, usize::MAX, on_output, on_exit)
            .map(Arc::new)
            .map_err(|e| e.code())?;
        let _ = answer.set(session.clone());
        if asked.swap(false, Ordering::SeqCst) {
            session.write(DSR_ANSWER.to_vec());
        }
        if let Some(input) = input_after {
            session.write(input);
        }
        let term = Term {
            id,
            session,
            ring: Ring::new(RING),
            state: PeerTermState::Running,
            exited: false,
            drained: false,
            ended: false,
            project_id,
            title,
            agent,
            watchers: Vec::new(),
        };
        let info = term.info();
        inner.terms.push(term);
        Ok(info)
    }

    pub fn list(&self) -> Vec<PeerTerm> {
        self.shared.lock().terms.iter().map(Term::info).collect()
    }

    pub fn write(&self, id: &str, data: Vec<u8>) -> Result<(), &'static str> {
        let mut inner = self.shared.lock();
        let term = inner.get(id).ok_or("no_term")?;
        term.session.write(data);
        Ok(())
    }

    /// Watches `id` from `from_seq`: what the ring holds from there is
    /// replayed first, then live output. Returns the watcher id and the seq
    /// the replay starts at. A term whose child has exited replays and closes.
    pub fn attach(
        &self,
        id: &str,
        from_seq: u64,
        mut watcher: Watcher,
    ) -> Result<(u64, u64), &'static str> {
        let mut inner = self.shared.lock();
        inner.next += 1;
        let wid = inner.next;
        let term = inner.get(id).ok_or("no_term")?;
        let (bytes, _gap) = term.ring.since(from_seq);
        let start = term.ring.end() - bytes.len() as u64;
        if !bytes.is_empty() {
            watcher(Frame::Output {
                seq: start,
                bytes: &bytes,
            });
        }
        if term.ended {
            watcher(Frame::Closed("exited"));
        } else {
            term.watchers.push((wid, watcher));
        }
        Ok((wid, start))
    }

    /// Stops watcher `wid`; nothing when it is already gone.
    pub fn detach(&self, id: &str, wid: u64) {
        if let Some(term) = self.shared.lock().get(id) {
            term.watchers.retain(|(w, _)| *w != wid);
        }
    }

    /// Ends the child; the term stays listed.
    #[cfg(test)]
    pub fn kill(&self, id: &str) -> Result<(), &'static str> {
        let session = self.shared.lock().get(id).ok_or("no_term")?.session.clone();
        session.kill();
        Ok(())
    }

    /// Ends the child and forgets the term.
    pub fn remove(&self, id: &str) -> Result<(), &'static str> {
        let mut term = {
            let mut inner = self.shared.lock();
            let i = inner
                .terms
                .iter()
                .position(|t| t.id == id)
                .ok_or("no_term")?;
            inner.terms.remove(i)
        };
        term.close("killed");
        term.session.kill();
        Ok(())
    }

    /// Closes every watcher with `host_stopped`, then ends every child and
    /// waits for each exit, `EXIT_WAIT` at most per child. False when one
    /// did not exit in time.
    pub fn kill_all(&self) -> bool {
        let sessions: Vec<(String, Arc<Session>)> = {
            let mut inner = self.shared.lock();
            inner
                .terms
                .iter_mut()
                .map(|t| {
                    t.ended = true;
                    t.close("host_stopped");
                    (t.id.clone(), t.session.clone())
                })
                .collect()
        };
        let mut all = true;
        for (id, session) in sessions {
            session.kill();
            all &= self.wait_exit(&id, EXIT_WAIT);
        }
        all
    }

    /// True once `id`'s child has exited (or the term is gone), within `limit`.
    pub fn wait_exit(&self, id: &str, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        let mut inner = self.shared.lock();
        loop {
            match inner.get(id) {
                None => return true,
                Some(t) if t.exited => return true,
                Some(_) => {}
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            inner = self
                .shared
                .changed
                .wait_timeout(inner, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    #[cfg(test)]
    fn feed(&self, id: &str, bytes: &[u8]) {
        if let Some(term) = self.shared.lock().get(id) {
            term.ring.push(bytes);
        }
    }

    #[cfg(test)]
    fn since(&self, id: &str, seq: u64) -> Vec<u8> {
        self.shared
            .lock()
            .get(id)
            .map(|t| t.ring.since(seq).0)
            .unwrap_or_default()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::mpsc;

    pub(crate) const DEADLINE: Duration = Duration::from_secs(5);

    /// Prints `ready` and exits 0.
    pub(crate) fn ready(project: &std::path::Path) -> Start {
        let (program, args) = if cfg!(windows) {
            ("cmd.exe", vec!["/d", "/c", "echo ready"])
        } else {
            ("/bin/sh", vec!["-c", "echo ready"])
        };
        start(program, &args, project)
    }

    /// An interactive shell.
    pub(crate) fn shell(project: &std::path::Path) -> Start {
        if cfg!(windows) {
            start("cmd.exe", &["/d", "/q"], project)
        } else {
            start("/bin/sh", &[], project)
        }
    }

    fn start(program: &str, args: &[&str], cwd: &std::path::Path) -> Start {
        Start {
            program: program.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: Vec::new(),
            cwd: cwd.to_path_buf(),
            project_id: "p1".into(),
            title: "shell".into(),
            agent: None,
            input_after: None,
        }
    }

    enum Ev {
        Out(u64, Vec<u8>),
        Closed(&'static str),
    }

    fn watcher() -> (Watcher, mpsc::Receiver<Ev>) {
        let (tx, rx) = mpsc::channel();
        let w: Watcher = Box::new(move |f| {
            let _ = tx.send(match f {
                Frame::Output { seq, bytes } => Ev::Out(seq, bytes.to_vec()),
                Frame::Closed(r) => Ev::Closed(r),
            });
        });
        (w, rx)
    }

    /// Collects output until `needle` shows, by `DEADLINE`; the first seq
    /// and the text. Answers the cursor query, as the watching terminal does.
    fn read_until(
        terms: &Terms,
        id: &str,
        rx: &mpsc::Receiver<Ev>,
        needle: &str,
    ) -> (Option<u64>, String) {
        let deadline = Instant::now() + DEADLINE;
        let (mut first, mut text) = (None, Vec::new());
        while !String::from_utf8_lossy(&text).contains(needle) {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(Ev::Out(seq, bytes)) => {
                    if bytes.windows(DSR.len()).any(|w| w == DSR) {
                        let _ = terms.write(id, DSR_ANSWER.to_vec());
                    }
                    first.get_or_insert(seq);
                    text.extend(bytes);
                }
                Ok(Ev::Closed(_)) => {}
                Err(_) => panic!("no {needle:?} in {:?}", String::from_utf8_lossy(&text)),
            }
        }
        (first, String::from_utf8_lossy(&text).into_owned())
    }

    fn terms() -> (Terms, mpsc::Receiver<(String, Option<i32>)>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let terms = Terms::new(Arc::new(move |id: &str, code| {
            let _ = tx.lock().unwrap().send((id.to_owned(), code));
        }));
        (terms, rx)
    }

    #[test]
    fn a_command_runs_to_done() {
        let dir = tempfile::tempdir().unwrap();
        let (terms, exits) = terms();
        let term = terms.open(ready(dir.path())).unwrap();
        assert_eq!(term.state, PeerTermState::Running);
        assert_eq!(term.project_id.as_deref(), Some("p1"));
        let (w, rx) = watcher();
        terms.attach(&term.id, 0, w).unwrap();
        read_until(&terms, &term.id, &rx, "ready");
        let (exited, code) = exits.recv_timeout(DEADLINE).expect("exit within 5 s");
        assert_eq!((exited.as_str(), code), (term.id.as_str(), Some(0)));
        assert!(terms.wait_exit(&term.id, DEADLINE));
        assert!(String::from_utf8_lossy(&terms.since(&term.id, 0)).contains("ready"));
        let listed = terms.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].state, PeerTermState::Done);
        // Attaching after the exit replays and closes at once.
        let (w, rx) = watcher();
        terms.attach(&term.id, 0, w).unwrap();
        let mut closed = false;
        while let Ok(ev) = rx.recv_timeout(DEADLINE) {
            if let Ev::Closed(r) = ev {
                assert_eq!(r, "exited");
                closed = true;
                break;
            }
        }
        assert!(closed);
    }

    #[test]
    fn attach_from_end_gets_only_new_output() {
        let dir = tempfile::tempdir().unwrap();
        let (terms, _exits) = terms();
        let term = terms.open(shell(dir.path())).unwrap();
        let (w, rx) = watcher();
        let (wid, start) = terms.attach(&term.id, u64::MAX, w).unwrap();
        terms.write(&term.id, b"echo hi\r".to_vec()).unwrap();
        let (first, text) = read_until(&terms, &term.id, &rx, "hi");
        assert!(first.unwrap() >= start, "{first:?} < {start}");
        assert!(text.contains("hi"));
        assert_eq!(terms.write("nope", b"x".to_vec()), Err("no_term"));
        // A detached watcher hears nothing more, not even the stop.
        terms.detach(&term.id, wid);
        assert!(terms.kill_all());
        while let Ok(ev) = rx.try_recv() {
            assert!(!matches!(ev, Ev::Closed(_)), "closed after detach");
        }
    }

    #[test]
    fn a_flood_replays_from_the_ring_start() {
        let dir = tempfile::tempdir().unwrap();
        let (terms, _exits) = terms();
        let term = terms.open(shell(dir.path())).unwrap();
        let line = [b"x".repeat(1023), b"\n".to_vec()].concat();
        for _ in 0..300 {
            terms.feed(&term.id, &line);
        }
        let (w, rx) = watcher();
        let (_, start) = terms.attach(&term.id, 0, w).unwrap();
        assert!(start > 0);
        assert!(start >= 300 * 1024 - RING as u64, "{start}");
        match rx.recv_timeout(DEADLINE).unwrap() {
            Ev::Out(seq, bytes) => {
                assert_eq!(seq, start);
                assert!(bytes.len() <= RING);
            }
            Ev::Closed(_) => panic!("closed"),
        }
        assert!(terms.kill_all());
    }

    #[test]
    fn kill_keeps_the_term_listed_until_removed() {
        let dir = tempfile::tempdir().unwrap();
        let (terms, exits) = terms();
        let term = terms.open(shell(dir.path())).unwrap();
        let (w, rx) = watcher();
        terms.attach(&term.id, 0, w).unwrap();
        terms.kill(&term.id).unwrap();
        let (id, _) = exits.recv_timeout(DEADLINE).expect("exit within 5 s");
        assert_eq!(id, term.id);
        let listed = terms.list();
        assert_eq!(listed.len(), 1);
        assert!(matches!(
            listed[0].state,
            PeerTermState::Error | PeerTermState::Done
        ));
        let deadline = Instant::now() + DEADLINE;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(Ev::Closed(r)) => {
                    assert_eq!(r, "exited");
                    break;
                }
                Ok(Ev::Out(..)) => {}
                Err(_) => panic!("no term.closed"),
            }
        }
        terms.remove(&term.id).unwrap();
        assert!(terms.list().is_empty());
        assert_eq!(terms.remove(&term.id), Err("no_term"));
        assert_eq!(terms.kill("nope"), Err("no_term"));
    }

    #[test]
    fn kill_all_waits_for_every_child() {
        let dir = tempfile::tempdir().unwrap();
        let (terms, exits) = terms();
        let a = terms.open(shell(dir.path())).unwrap();
        let b = terms.open(shell(dir.path())).unwrap();
        let (w, rx) = watcher();
        terms.attach(&a.id, 0, w).unwrap();
        assert!(terms.kill_all());
        for t in terms.list() {
            assert_ne!(t.state, PeerTermState::Running, "{}", t.id);
        }
        let mut ids: Vec<String> = (0..2)
            .map(|_| exits.recv_timeout(DEADLINE).unwrap().0)
            .collect();
        ids.sort();
        let mut want = vec![a.id, b.id];
        want.sort();
        assert_eq!(ids, want);
        let mut reason = None;
        while let Ok(ev) = rx.recv_timeout(DEADLINE) {
            if let Ev::Closed(r) = ev {
                reason = Some(r);
                break;
            }
        }
        assert_eq!(reason, Some("host_stopped"));
    }
}
