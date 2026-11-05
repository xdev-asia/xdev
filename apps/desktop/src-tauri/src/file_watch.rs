//! Live file watching: one watcher per worktree root, shared by every
//! subscriber. Events are made worktree-relative, filtered, coalesced and
//! flushed in batches (75 ms leading, 100 ms cadence).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use notify_debouncer_full::notify::event::{ModifyKind, RenameMode};
use notify_debouncer_full::notify::{self, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::State;
use tauri::ipc::Channel;

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::workspace::known_checkout;

/// One watched path, relative to the worktree, `/`-separated.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FsEvent {
    pub kind: FsEventKind,
    /// "" for `Overflow` (the whole worktree).
    pub rel: String,
    /// From a stat after the event; None for deletes and overflow.
    pub dir: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum FsEventKind {
    Create,
    Update,
    Delete,
    Overflow,
}

/// One flushed batch for one worktree.
#[derive(Clone, Debug, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FsChanged {
    pub worktree: String,
    pub events: Vec<FsEvent>,
}

pub const IGNORED_DIRS: [&str; 9] = [
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".cache",
    "target",
    ".venv",
    "__pycache__",
];
/// The first event of a batch flushes after this long.
pub const LEADING: Duration = Duration::from_millis(75);
/// Flushes come at least this far apart.
pub const INTERVAL: Duration = Duration::from_millis(100);
/// A batch with more events than this becomes one `Overflow`.
pub const MAX_EVENTS: usize = 5000;

impl FsEvent {
    fn overflow() -> FsEvent {
        FsEvent {
            kind: FsEventKind::Overflow,
            rel: String::new(),
            dir: None,
        }
    }
}

/// True when any component of `rel` is in `IGNORED_DIRS`.
pub(crate) fn ignored(rel: &str) -> bool {
    rel.split(['/', '\\'])
        .any(|part| IGNORED_DIRS.contains(&part))
}

/// Per-path coalescing, in order of first appearance:
/// create then delete cancels out; delete then create keeps both; otherwise
/// the last kind wins (an update after a create stays a create). An `Overflow` swallows the whole batch.
pub(crate) fn coalesce(events: Vec<FsEvent>) -> Vec<FsEvent> {
    if events.iter().any(|e| e.kind == FsEventKind::Overflow) {
        return vec![FsEvent::overflow()];
    }
    let mut order: Vec<String> = Vec::new();
    let mut by_path: HashMap<String, Vec<FsEvent>> = HashMap::new();
    for e in events {
        let list = by_path.entry(e.rel.clone()).or_insert_with(|| {
            order.push(e.rel.clone());
            Vec::new()
        });
        let Some(last) = list.last().map(|l| l.kind) else {
            list.push(e);
            continue;
        };
        match (last, e.kind) {
            (FsEventKind::Create, FsEventKind::Delete) => {
                list.pop();
            }
            // The file is back after a delete: that is a create.
            (FsEventKind::Delete, FsEventKind::Create | FsEventKind::Update) => {
                list.push(FsEvent {
                    kind: FsEventKind::Create,
                    ..e
                });
            }
            (FsEventKind::Delete, FsEventKind::Delete) => {}
            // The file is still the one this batch created.
            (FsEventKind::Create, FsEventKind::Update) => {}
            _ => {
                list.pop();
                list.push(e);
            }
        }
    }
    order
        .into_iter()
        .flat_map(|rel| by_path.remove(&rel).unwrap_or_default())
        .collect()
}

/// The flush clock: no threads and no sleeping, it only takes `now`.
#[derive(Debug, Default)]
pub(crate) struct Batch {
    pending: Vec<FsEvent>,
    last_flush: Option<Instant>,
    armed: Option<Instant>,
}

impl Batch {
    /// Adds `e`. Returns the flush deadline when this push armed it; an
    /// armed timer is not reset by later pushes.
    pub(crate) fn push(&mut self, e: FsEvent, now: Instant) -> Option<Instant> {
        self.pending.push(e);
        if self.armed.is_some() {
            return None;
        }
        let mut deadline = now + LEADING;
        if let Some(last) = self.last_flush {
            deadline = deadline.max(last + INTERVAL);
        }
        self.armed = Some(deadline);
        Some(deadline)
    }

    /// When the next flush is due, if anything is waiting.
    pub(crate) fn due(&self) -> Option<Instant> {
        self.armed
    }

    /// Takes the batch: coalesced, or one `Overflow` when it is too big.
    pub(crate) fn flush(&mut self, now: Instant) -> Vec<FsEvent> {
        self.armed = None;
        self.last_flush = Some(now);
        let events = coalesce(std::mem::take(&mut self.pending));
        if events.len() > MAX_EVENTS {
            vec![FsEvent::overflow()]
        } else {
            events
        }
    }
}

/// Where a root's batches go: one per subscriber id.
type Sink = Box<dyn Fn(&[FsEvent]) + Send>;
type Sinks = Arc<Mutex<HashMap<String, Sink>>>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What the notify callback tells the flush thread.
enum Msg {
    Event(FsEvent),
    /// The watcher failed (a lost buffer, inotify limits): re-read everything.
    Failed,
    Stop,
}

/// `path` under `root` as `/`-separated components; None for the root
/// itself and for anything outside it.
fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rest = dunce::simplified(path).strip_prefix(root).ok()?;
    let parts: Vec<String> = rest
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// What the disk says about `path` after the event: `Some(is_dir)` when it
/// exists.
type Stat<'a> = &'a dyn Fn(&Path) -> Option<bool>;

/// The events one notify event stands for. A write can arrive as a create
/// on macOS, a rename as `From`/`To` halves on Windows and Linux, so kinds
/// that say "something is there" are checked with a stat: a path that is
/// gone is a delete, and a folder's own modify is noise.
fn map_event(root: &Path, event: &notify::Event, stat: Stat<'_>) -> Vec<FsEvent> {
    if event.need_rescan() {
        return vec![FsEvent::overflow()];
    }
    let present = |path: &Path, kind: FsEventKind| -> Option<FsEvent> {
        let rel = rel_of(root, path)?;
        if ignored(&rel) {
            return None;
        }
        match stat(path) {
            None => Some(FsEvent {
                kind: FsEventKind::Delete,
                rel,
                dir: None,
            }),
            // A folder changing (a child came or went) says nothing new.
            Some(true) if kind == FsEventKind::Update => None,
            Some(dir) => Some(FsEvent {
                kind,
                rel,
                dir: Some(dir),
            }),
        }
    };
    let gone = |path: &Path| -> Option<FsEvent> {
        let rel = rel_of(root, path)?;
        (!ignored(&rel)).then_some(FsEvent {
            kind: FsEventKind::Delete,
            rel,
            dir: None,
        })
    };
    let paths = &event.paths;
    match event.kind {
        EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            paths.iter().filter_map(|p| gone(p)).collect()
        }
        // A rename of unknown direction: the disk decides.
        EventKind::Create(_)
        | EventKind::Modify(ModifyKind::Name(
            RenameMode::To | RenameMode::Any | RenameMode::Other,
        )) => paths
            .iter()
            .filter_map(|p| present(p, FsEventKind::Create))
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            let mut out = Vec::new();
            out.extend(paths.first().and_then(|p| gone(p)));
            out.extend(paths.get(1).and_then(|p| present(p, FsEventKind::Create)));
            out
        }
        EventKind::Modify(_) | EventKind::Any | EventKind::Other => paths
            .iter()
            .filter_map(|p| present(p, FsEventKind::Update))
            .collect(),
        EventKind::Access(_) => Vec::new(),
    }
}

fn disk_stat(path: &Path) -> Option<bool> {
    std::fs::symlink_metadata(path).ok().map(|m| m.is_dir())
}

/// One watched root: its flush thread (which owns the notify watcher) and
/// the subscribers it sends to.
struct Root {
    sinks: Sinks,
    tx: Sender<Msg>,
    /// Set by the thread when the watcher failed and was dropped.
    dead: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Root {
    fn start(root: &Path) -> Result<Root, CmdError> {
        let (tx, rx) = mpsc::channel::<Msg>();
        let callback_tx = tx.clone();
        let base = root.to_path_buf();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            // The thread may be gone already; nobody needs the event then.
            match res {
                Ok(event) => {
                    for e in map_event(&base, &event, &disk_stat) {
                        let _ = callback_tx.send(Msg::Event(e));
                    }
                }
                Err(_) => {
                    let _ = callback_tx.send(Msg::Failed);
                }
            }
        })
        .map_err(io_error)?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(io_error)?;
        let sinks: Sinks = Arc::default();
        let dead = Arc::new(AtomicBool::new(false));
        let thread = {
            let (sinks, dead) = (Arc::clone(&sinks), Arc::clone(&dead));
            std::thread::Builder::new()
                .name("file-watch".into())
                .spawn(move || run(&rx, watcher, &sinks, &dead))
                .map_err(io_error)?
        };
        Ok(Root {
            sinks,
            tx,
            dead,
            thread: Some(thread),
        })
    }

    fn is_dead(&self) -> bool {
        self.dead.load(Ordering::SeqCst)
    }

    /// Tells the thread to end; the caller joins it outside the lock.
    fn stop(mut self) -> Option<JoinHandle<()>> {
        let _ = self.tx.send(Msg::Stop);
        self.thread.take()
    }
}

fn io_error(e: impl std::fmt::Display) -> CmdError {
    CmdError {
        code: "io",
        detail: Some(e.to_string()),
    }
}

fn deliver(sinks: &Sinks, events: &[FsEvent]) {
    for sink in lock(sinks).values() {
        sink(events);
    }
}

/// The flush thread of one root. It owns `watcher`, so ending the loop
/// (a stop, a failure) also ends the watch.
fn run(rx: &Receiver<Msg>, watcher: RecommendedWatcher, sinks: &Sinks, dead: &AtomicBool) {
    let mut batch = Batch::default();
    loop {
        let msg = match batch.due() {
            Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(msg) => Some(msg),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            },
            None => match rx.recv() {
                Ok(msg) => Some(msg),
                Err(_) => break,
            },
        };
        match msg {
            Some(Msg::Event(e)) => {
                batch.push(e, Instant::now());
            }
            Some(Msg::Failed) => {
                dead.store(true, Ordering::SeqCst);
                deliver(sinks, &[FsEvent::overflow()]);
                break;
            }
            Some(Msg::Stop) => break,
            None => {}
        }
        let now = Instant::now();
        if batch.due().is_some_and(|at| at <= now) {
            let events = batch.flush(now);
            if !events.is_empty() {
                deliver(sinks, &events);
            }
        }
    }
    drop(watcher);
}

#[derive(Default)]
struct Inner {
    roots: HashMap<PathBuf, Root>,
    /// Subscriber id -> the root it listens to.
    ids: HashMap<String, PathBuf>,
}

impl Inner {
    /// Removes `id`; a root left with no subscriber is taken out and
    /// returned for stopping.
    fn unsubscribe(&mut self, id: &str) -> Option<Root> {
        let key = self.ids.remove(id)?;
        let root = self.roots.get(&key)?;
        let empty = {
            let mut sinks = lock(&root.sinks);
            sinks.remove(id);
            sinks.is_empty()
        };
        if empty { self.roots.remove(&key) } else { None }
    }
}

/// Managed state: root -> (watcher, subscribers); id -> root.
#[derive(Default, Clone)]
pub struct FileWatches(Arc<Mutex<Inner>>);

impl FileWatches {
    /// Starts sending batches of `worktree` to `send` under `id`, replacing
    /// the subscription that had the id. A root already watched gains a
    /// listener; it does not get a second watcher.
    pub(crate) fn watch(
        &self,
        data: &Path,
        worktree: &Path,
        id: &str,
        send: Box<dyn Fn(FsChanged) + Send>,
    ) -> Result<(), CmdError> {
        known_checkout(data, worktree)?;
        let root = dunce::canonicalize(worktree).map_err(io_error)?;
        let name = worktree.to_string_lossy().into_owned();
        let sink: Sink = Box::new(move |events| {
            send(FsChanged {
                worktree: name.clone(),
                events: events.to_vec(),
            });
        });
        let mut stopped = Vec::new();
        let result = {
            let mut inner = lock(&self.0);
            stopped.extend(inner.unsubscribe(id));
            if inner.roots.get(&root).is_some_and(Root::is_dead) {
                // Its watcher is gone; the old listeners were told to re-read.
                inner.ids.retain(|_, r| *r != root);
                stopped.extend(inner.roots.remove(&root));
            }
            if !inner.roots.contains_key(&root) {
                match Root::start(&root) {
                    Ok(r) => {
                        inner.roots.insert(root.clone(), r);
                    }
                    Err(e) => {
                        drop(inner);
                        join_all(stopped);
                        return Err(e);
                    }
                }
            }
            if let Some(r) = inner.roots.get(&root) {
                lock(&r.sinks).insert(id.to_owned(), sink);
                inner.ids.insert(id.to_owned(), root.clone());
            }
            Ok(())
        };
        join_all(stopped);
        result
    }

    /// Ends the subscription `id`; the last one on a root stops its watcher.
    pub(crate) fn unwatch(&self, id: &str) {
        let stopped = lock(&self.0).unsubscribe(id);
        join_all(stopped);
    }

    #[cfg(test)]
    fn root_count(&self) -> usize {
        lock(&self.0).roots.len()
    }
}

/// Stops each root and waits for its thread, outside every lock.
fn join_all(roots: impl IntoIterator<Item = Root>) {
    let threads: Vec<_> = roots.into_iter().filter_map(Root::stop).collect();
    for t in threads {
        let _ = t.join();
    }
}

/// Starts sending `FsChanged` batches of `worktree` to `on_event` under `id`.
#[tauri::command(async)]
pub fn files_watch(
    state: State<'_, AppState>,
    watches: State<'_, FileWatches>,
    worktree: PathBuf,
    id: String,
    on_event: Channel<FsChanged>,
) -> Result<(), CmdError> {
    watches.watch(
        data_dir(&state)?,
        &worktree,
        &id,
        Box::new(move |batch| {
            // The window may be gone; nobody is listening then.
            let _ = on_event.send(batch);
        }),
    )
}

/// Stops the subscription `id`; nothing when it is not there.
#[tauri::command(async)]
pub fn files_unwatch(watches: State<'_, FileWatches>, id: String) -> Result<(), CmdError> {
    watches.unwatch(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: FsEventKind, rel: &str) -> FsEvent {
        FsEvent {
            kind,
            rel: rel.to_owned(),
            dir: None,
        }
    }

    fn kinds(events: &[FsEvent]) -> Vec<(FsEventKind, &str)> {
        events.iter().map(|e| (e.kind, e.rel.as_str())).collect()
    }

    use FsEventKind::{Create, Delete, Overflow, Update};

    #[test]
    fn ignored_matches_each_dir_at_any_depth() {
        for dir in IGNORED_DIRS {
            assert!(ignored(dir), "{dir}");
            assert!(ignored(&format!("{dir}/x.js")), "{dir}/x.js");
            assert!(ignored(&format!("a/b/c/{dir}/x.js")), "deep {dir}");
            assert!(ignored(&format!("a/b/{dir}")), "deep {dir} itself");
        }
        assert!(ignored("a\\node_modules\\x"));
    }

    #[test]
    fn ignored_leaves_lookalikes_alone() {
        for rel in [
            "src/build.rs",
            "src/target.txt",
            "dist-info/x",
            "gitignore",
            "a/b.git",
        ] {
            assert!(!ignored(rel), "{rel}");
        }
    }

    #[test]
    fn coalesce_create_then_delete_cancels_out() {
        let out = coalesce(vec![ev(Create, "a"), ev(Update, "a"), ev(Delete, "a")]);
        assert!(out.is_empty());
    }

    #[test]
    fn coalesce_delete_then_create_keeps_both() {
        let out = coalesce(vec![ev(Delete, "a"), ev(Create, "a")]);
        assert_eq!(kinds(&out), [(Delete, "a"), (Create, "a")]);
        let out = coalesce(vec![ev(Delete, "a"), ev(Create, "a"), ev(Update, "a")]);
        assert_eq!(kinds(&out), [(Delete, "a"), (Create, "a")]);
    }

    #[test]
    fn coalesce_otherwise_the_last_kind_wins_in_first_seen_order() {
        let out = coalesce(vec![
            ev(Update, "b"),
            ev(Create, "a"),
            ev(Update, "b"),
            ev(Update, "a"),
            ev(Update, "c"),
            ev(Delete, "c"),
        ]);
        assert_eq!(kinds(&out), [(Update, "b"), (Create, "a"), (Delete, "c")]);
    }

    #[test]
    fn coalesce_overflow_swallows_the_batch() {
        let out = coalesce(vec![ev(Update, "a"), ev(Overflow, ""), ev(Delete, "b")]);
        assert_eq!(kinds(&out), [(Overflow, "")]);
    }

    #[test]
    fn batch_flushes_the_first_event_after_the_leading_delay() {
        let t0 = Instant::now();
        let mut b = Batch::default();
        assert_eq!(b.due(), None);
        assert_eq!(b.push(ev(Update, "a"), t0), Some(t0 + LEADING));
        assert_eq!(b.due(), Some(t0 + LEADING));
    }

    #[test]
    fn batch_does_not_reset_an_armed_timer() {
        let t0 = Instant::now();
        let mut b = Batch::default();
        b.push(ev(Update, "a"), t0);
        assert_eq!(
            b.push(ev(Update, "b"), t0 + Duration::from_millis(60)),
            None
        );
        assert_eq!(b.due(), Some(t0 + LEADING));
        let out = b.flush(t0 + LEADING);
        assert_eq!(kinds(&out), [(Update, "a"), (Update, "b")]);
        assert_eq!(b.due(), None);
    }

    #[test]
    fn batch_keeps_flushes_an_interval_apart() {
        let t0 = Instant::now();
        let mut b = Batch::default();
        b.push(ev(Update, "a"), t0);
        b.flush(t0 + LEADING);
        // 10 ms after a flush: the interval (100 ms) is the later bound.
        let now = t0 + LEADING + Duration::from_millis(10);
        assert_eq!(b.push(ev(Update, "b"), now), Some(t0 + LEADING + INTERVAL));
        // Long after a flush: the leading delay applies again.
        b.flush(t0 + LEADING + INTERVAL);
        let late = t0 + Duration::from_secs(5);
        assert_eq!(b.push(ev(Update, "c"), late), Some(late + LEADING));
    }

    #[test]
    fn batch_turns_more_than_the_maximum_into_one_overflow() {
        let t0 = Instant::now();
        let mut b = Batch::default();
        for i in 0..=MAX_EVENTS {
            b.push(ev(Update, &format!("f{i}")), t0);
        }
        let out = b.flush(t0 + LEADING);
        assert_eq!(kinds(&out), [(Overflow, "")]);
    }

    #[test]
    fn batch_keeps_a_batch_of_exactly_the_maximum() {
        let t0 = Instant::now();
        let mut b = Batch::default();
        for i in 0..MAX_EVENTS {
            b.push(ev(Update, &format!("f{i}")), t0);
        }
        assert_eq!(b.flush(t0 + LEADING).len(), MAX_EVENTS);
    }

    // The real watcher, on a registered repo in a temp dir.

    use std::fs;
    use std::process::Command;
    use std::sync::mpsc::{Receiver, channel};

    use notify_debouncer_full::notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind};
    use tempfile::TempDir;
    use xdev_workspace::{Registry, add_repo};

    struct Fixture {
        _tmp: TempDir,
        repo: PathBuf,
        data: PathBuf,
        stranger: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = crate::test_dirs::long_temp_dir("file watch ");
        let repo = tmp.path().join("repo");
        let data = tmp.path().join("data");
        let stranger = tmp.path().join("stranger");
        fs::create_dir(&repo).unwrap();
        fs::create_dir(&stranger).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .current_dir(&repo)
                .args(args)
                .output()
                .expect("run git");
            assert!(out.status.success(), "git {args:?}: {out:?}");
        };
        git(&["init", "-q"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&["config", key, value]);
        }
        fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "one"]);
        let mut reg = Registry::load(&data).unwrap();
        add_repo(&mut reg, &repo, 0).unwrap();
        reg.save(&data).unwrap();
        Fixture {
            _tmp: tmp,
            repo,
            data,
            stranger,
        }
    }

    fn subscribe(watches: &FileWatches, fx: &Fixture, id: &str) -> Receiver<FsChanged> {
        let (tx, rx) = channel();
        let tx = Mutex::new(tx);
        watches
            .watch(
                &fx.data,
                &fx.repo,
                id,
                Box::new(move |batch| {
                    let _ = lock(&tx).send(batch);
                }),
            )
            .unwrap();
        rx
    }

    /// Collects batches until `done` holds for the events seen so far, or
    /// 5 s pass. Returns every event seen.
    fn collect_until(rx: &Receiver<FsChanged>, done: impl Fn(&[FsEvent]) -> bool) -> Vec<FsEvent> {
        let end = Instant::now() + Duration::from_secs(5);
        let mut seen = Vec::new();
        while Instant::now() < end && !done(&seen) {
            if let Ok(batch) = rx.recv_timeout(Duration::from_millis(100)) {
                seen.extend(batch.events);
            }
        }
        seen
    }

    fn has(seen: &[FsEvent], kind: FsEventKind, rel: &str) -> bool {
        seen.iter().any(|e| e.kind == kind && e.rel == rel)
    }

    #[test]
    fn a_created_changed_and_deleted_file_is_reported() {
        let fx = fixture();
        let watches = FileWatches::default();
        let rx = subscribe(&watches, &fx, "w1");

        fs::write(fx.repo.join("new.txt"), "x").unwrap();
        let seen = collect_until(&rx, |s| s.iter().any(|e| e.rel == "new.txt"));
        let e = seen.iter().find(|e| e.rel == "new.txt").expect("new.txt");
        assert!(matches!(e.kind, FsEventKind::Create | FsEventKind::Update));
        assert_eq!(e.dir, Some(false));

        fs::write(fx.repo.join("a.txt"), "two\n").unwrap();
        let seen = collect_until(&rx, |s| has(s, FsEventKind::Update, "a.txt"));
        assert!(has(&seen, FsEventKind::Update, "a.txt"), "{seen:?}");

        fs::remove_file(fx.repo.join("a.txt")).unwrap();
        let seen = collect_until(&rx, |s| has(s, FsEventKind::Delete, "a.txt"));
        assert!(has(&seen, FsEventKind::Delete, "a.txt"), "{seen:?}");

        fs::create_dir(fx.repo.join("sub")).unwrap();
        let seen = collect_until(&rx, |s| has(s, FsEventKind::Create, "sub"));
        let dir = seen.iter().find(|e| e.rel == "sub").expect("sub");
        assert_eq!(dir.dir, Some(true));
        watches.unwatch("w1");
    }

    #[test]
    fn ignored_folders_are_never_delivered() {
        let fx = fixture();
        let watches = FileWatches::default();
        let rx = subscribe(&watches, &fx, "w1");
        fs::create_dir_all(fx.repo.join("node_modules")).unwrap();
        fs::write(fx.repo.join("node_modules").join("x"), "1").unwrap();
        // Let a few batches pass, then prove the stream is alive.
        std::thread::sleep(Duration::from_secs(2));
        fs::write(fx.repo.join("real.txt"), "1").unwrap();
        let seen = collect_until(&rx, |s| s.iter().any(|e| e.rel == "real.txt"));
        assert!(seen.iter().any(|e| e.rel == "real.txt"), "{seen:?}");
        assert!(
            seen.iter().all(|e| !ignored(&e.rel)),
            "ignored path delivered: {seen:?}"
        );
        watches.unwatch("w1");
    }

    #[test]
    fn subscribers_of_one_root_share_one_watcher() {
        let fx = fixture();
        let watches = FileWatches::default();
        let first = subscribe(&watches, &fx, "w1");
        let second = subscribe(&watches, &fx, "w2");
        assert_eq!(watches.root_count(), 1);
        fs::write(fx.repo.join("shared.txt"), "1").unwrap();
        for rx in [&first, &second] {
            let seen = collect_until(rx, |s| s.iter().any(|e| e.rel == "shared.txt"));
            assert!(seen.iter().any(|e| e.rel == "shared.txt"), "{seen:?}");
        }
        // The same id again replaces its subscription: still one root.
        let _again = subscribe(&watches, &fx, "w2");
        assert_eq!(watches.root_count(), 1);
        watches.unwatch("w1");
        assert_eq!(watches.root_count(), 1);
        watches.unwatch("w2");
        assert_eq!(watches.root_count(), 0);
        // Nothing to unwatch: no harm.
        watches.unwatch("w2");
    }

    #[test]
    fn an_unknown_worktree_is_refused_before_anything_is_watched() {
        let fx = fixture();
        let watches = FileWatches::default();
        let err = watches
            .watch(&fx.data, &fx.stranger, "w", Box::new(|_| {}))
            .unwrap_err();
        assert_eq!(err.code, "worktree_unknown");
        assert_eq!(watches.root_count(), 0);
    }

    // The notify event -> FsEvent mapping, with a fake disk.

    fn notify_event(kind: EventKind, paths: &[&str]) -> notify::Event {
        let mut e = notify::Event::new(kind);
        for p in paths {
            e = e.add_path(PathBuf::from(p));
        }
        e
    }

    fn mapped(
        kind: EventKind,
        paths: &[&str],
        disk: &[(&str, bool)],
    ) -> Vec<(FsEventKind, String, Option<bool>)> {
        let root = Path::new("/r");
        let stat = |p: &Path| {
            disk.iter()
                .find(|(d, _)| Path::new(d) == p)
                .map(|(_, dir)| *dir)
        };
        map_event(root, &notify_event(kind, paths), &stat)
            .into_iter()
            .map(|e| (e.kind, e.rel, e.dir))
            .collect()
    }

    #[test]
    fn map_event_classifies_by_kind_and_by_stat() {
        let data = EventKind::Modify(ModifyKind::Data(DataChange::Any));
        // A write.
        assert_eq!(
            mapped(data, &["/r/src/a.rs"], &[("/r/src/a.rs", false)]),
            [(FsEventKind::Update, "src/a.rs".to_owned(), Some(false))]
        );
        // A write to a file that is already gone is a delete.
        assert_eq!(
            mapped(data, &["/r/a.rs"], &[]),
            [(FsEventKind::Delete, "a.rs".to_owned(), None)]
        );
        // A folder's own modify is noise.
        assert!(mapped(data, &["/r/src"], &[("/r/src", true)]).is_empty());
        // Creates carry the stat'd kind; removes carry none.
        assert_eq!(
            mapped(
                EventKind::Create(CreateKind::Any),
                &["/r/d"],
                &[("/r/d", true)]
            ),
            [(FsEventKind::Create, "d".to_owned(), Some(true))]
        );
        assert_eq!(
            mapped(
                EventKind::Remove(RemoveKind::File),
                &["/r/a.rs"],
                &[("/r/a.rs", false)]
            ),
            [(FsEventKind::Delete, "a.rs".to_owned(), None)]
        );
    }

    #[test]
    fn map_event_turns_a_rename_into_delete_and_create() {
        let both = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        assert_eq!(
            mapped(
                both,
                &["/r/old.txt", "/r/new.txt"],
                &[("/r/new.txt", false)]
            ),
            [
                (FsEventKind::Delete, "old.txt".to_owned(), None),
                (FsEventKind::Create, "new.txt".to_owned(), Some(false)),
            ]
        );
        let from = EventKind::Modify(ModifyKind::Name(RenameMode::From));
        assert_eq!(
            mapped(from, &["/r/old.txt"], &[]),
            [(FsEventKind::Delete, "old.txt".to_owned(), None)]
        );
        // A rename of unknown direction: the disk decides.
        let any = EventKind::Modify(ModifyKind::Name(RenameMode::Any));
        assert_eq!(
            mapped(any, &["/r/x"], &[("/r/x", false)]),
            [(FsEventKind::Create, "x".to_owned(), Some(false))]
        );
        assert_eq!(
            mapped(any, &["/r/x"], &[]),
            [(FsEventKind::Delete, "x".to_owned(), None)]
        );
    }

    #[test]
    fn map_event_skips_ignored_outside_and_access_and_flags_a_rescan() {
        let create = EventKind::Create(CreateKind::File);
        let disk = [
            ("/r/node_modules/x", false),
            ("/elsewhere/a", false),
            ("/r", true),
        ];
        assert!(mapped(create, &["/r/node_modules/x"], &disk).is_empty());
        assert!(mapped(create, &["/elsewhere/a"], &disk).is_empty());
        assert!(mapped(create, &["/r"], &disk).is_empty());
        assert!(
            mapped(
                EventKind::Access(notify::event::AccessKind::Any),
                &["/r/a"],
                &[("/r/a", false)]
            )
            .is_empty()
        );
        let rescan = notify::Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);
        let out = map_event(Path::new("/r"), &rescan, &|_| None);
        assert_eq!(out, [FsEvent::overflow()]);
    }
}
