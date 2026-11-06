//! Who changed which file of a worktree, and a snapshot of each version an
//! agent wrote.
//!
//! A file change is attributed in this order: the agent tab whose hook
//! reported an edit or write tool on that path within a short window;
//! otherwise the only agent tab working in that worktree; otherwise unknown.
//! Events and snapshots live in the app data dir, never in the repo.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use xdev_agent::HookEvent;

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::file_watch::{FileWatches, FsChanged, FsEventKind};
use crate::pty::Ptys;
use crate::workspace::{inside, known_checkout, parent_within};

/// A hook and a file change this far apart (either way round) belong together.
pub const HOOK_WINDOW_MS: i64 = 5_000;
/// Events kept per worktree, oldest dropped first.
pub const MAX_EVENTS: usize = 5_000;
/// Versions kept per file, oldest dropped first.
pub const MAX_VERSIONS: usize = 20;
/// The largest file that is snapshotted.
pub const MAX_SNAPSHOT_BYTES: usize = 1_000_000;
/// Folders that are never tracked, at any depth.
const SKIPPED_DIRS: [&str; 3] = [".git", "node_modules", "target"];
/// Hook reports kept per worktree; only the last few seconds matter.
const MAX_HOOKS: usize = 200;
/// Two events of one tab on one file this close are one edit.
const MERGE_MS: i64 = 2_000;
/// Tools whose hook report names a file the agent wrote.
const WRITE_TOOLS: [&str; 4] = ["edit", "write", "multiedit", "notebookedit"];

/// How a change was attributed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum AttributionSource {
    /// A hook of that tab reported the edit.
    Hook,
    /// The only agent tab working in the worktree at the time.
    Single,
    /// Nobody could be named.
    Unknown,
}

/// One attributed file change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AttributionEvent {
    pub worktree: String,
    /// Relative to the worktree, `/`-separated.
    pub path: String,
    /// None when unknown.
    pub tab_id: Option<String>,
    pub agent: Option<String>,
    /// Unix time in milliseconds.
    pub at: i64,
    pub source: AttributionSource,
}

/// One agent tab that touched a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Toucher {
    pub tab_id: Option<String>,
    pub agent: Option<String>,
    /// The latest time this tab touched the file.
    pub at: i64,
}

/// The tabs that touched one file, most recent first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileAttribution {
    pub path: String,
    pub touched_by: Vec<Toucher>,
}

/// One snapshot of a file as an agent wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    /// The content hash.
    pub id: String,
    pub at: i64,
    pub size: u64,
    pub tab_id: Option<String>,
    pub agent: Option<String>,
}

/// An edit or write a hook reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookEdit {
    pub tab_id: String,
    pub agent: String,
    /// Relative to the worktree.
    pub path: String,
    pub at: i64,
}

/// An agent tab that is working.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkingTab {
    pub tab_id: String,
    pub agent: String,
}

/// The tab a change goes to, in the order the lane defines. The latest hook
/// on the path inside the window wins; with no hook, the one working tab;
/// with none or several, unknown.
pub fn attribute(
    path: &str,
    at: i64,
    hooks: &[HookEdit],
    working: &[WorkingTab],
) -> (Option<WorkingTab>, AttributionSource) {
    let hit = hooks
        .iter()
        .filter(|h| h.path == path && (h.at - at).abs() <= HOOK_WINDOW_MS)
        .max_by_key(|h| h.at);
    if let Some(h) = hit {
        let tab = WorkingTab {
            tab_id: h.tab_id.clone(),
            agent: h.agent.clone(),
        };
        return (Some(tab), AttributionSource::Hook);
    }
    match working {
        [only] => (Some(only.clone()), AttributionSource::Single),
        _ => (None, AttributionSource::Unknown),
    }
}

/// `path` relative to `root`, `/`-separated; a relative path stays as it is.
/// None when it leaves the root or names the root itself.
pub fn relative(root: &Path, path: &str) -> Option<String> {
    let p = Path::new(path);
    let rest = if p.is_absolute() {
        dunce::simplified(p).strip_prefix(root).ok()?
    } else {
        p
    };
    let mut parts = Vec::new();
    for c in rest.components() {
        match c {
            std::path::Component::Normal(n) => parts.push(n.to_string_lossy().into_owned()),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// True when `rel` is in a skipped folder or a `.gitignore` of the worktree
/// (or `.git/info/exclude`) ignores it.
pub fn skipped(root: &Path, rel: &str) -> bool {
    if rel.split('/').any(|part| SKIPPED_DIRS.contains(&part)) {
        return true;
    }
    let mut builder = ignore::gitignore::GitignoreBuilder::new(root);
    let mut dir = root.to_path_buf();
    let _ = builder.add(root.join(".git").join("info").join("exclude"));
    let parts: Vec<&str> = rel.split('/').collect();
    let _ = builder.add(dir.join(".gitignore"));
    for part in &parts[..parts.len().saturating_sub(1)] {
        dir.push(part);
        let _ = builder.add(dir.join(".gitignore"));
    }
    let Ok(matcher) = builder.build() else {
        return false;
    };
    matcher
        .matched_path_or_any_parents(root.join(rel), false)
        .is_ignore()
}

fn key_of(text: &str) -> String {
    blake3::hash(text.as_bytes()).to_hex()[..16].to_owned()
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn io_error(e: impl std::fmt::Display) -> CmdError {
    CmdError {
        code: "io",
        detail: Some(e.to_string()),
    }
}

/// The last `MAX_EVENTS` events of one worktree, in memory and in a
/// JSON-lines file.
#[derive(Debug)]
pub struct EventLog {
    file: PathBuf,
    events: VecDeque<AttributionEvent>,
}

impl EventLog {
    /// Reads `file`; a line that does not parse is skipped.
    pub fn open(file: PathBuf) -> EventLog {
        let mut events: VecDeque<AttributionEvent> = fs::read_to_string(&file)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        while events.len() > MAX_EVENTS {
            events.pop_front();
        }
        EventLog { file, events }
    }

    pub fn events(&self) -> impl DoubleEndedIterator<Item = &AttributionEvent> {
        self.events.iter()
    }

    /// Adds `e`; the oldest event goes when the log is full. The same tab on
    /// the same path within `MERGE_MS` is one edit: its time moves.
    pub fn push(&mut self, e: AttributionEvent) -> io::Result<()> {
        let merged = self
            .events
            .iter_mut()
            .rev()
            .find(|o| o.path == e.path)
            .is_some_and(|o| {
                let same = o.tab_id == e.tab_id && e.at - o.at <= MERGE_MS && e.at >= o.at;
                if same {
                    o.at = e.at;
                    o.source = e.source;
                }
                same
            });
        if merged {
            return self.rewrite();
        }
        self.events.push_back(e.clone());
        if self.events.len() > MAX_EVENTS {
            while self.events.len() > MAX_EVENTS {
                self.events.pop_front();
            }
            return self.rewrite();
        }
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut line = serde_json::to_string(&e).map_err(io::Error::other)?;
        line.push('\n');
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file)?
            .write_all(line.as_bytes())
    }

    /// A hook that arrived after its file change: the latest event of `path`
    /// within the window that was not hook-attributed now names the hook's tab.
    /// Returns true when an event changed.
    pub fn upgrade(&mut self, hook: &HookEdit) -> io::Result<bool> {
        let found = self
            .events
            .iter_mut()
            .rev()
            .find(|o| o.path == hook.path && (o.at - hook.at).abs() <= HOOK_WINDOW_MS);
        let Some(o) = found else {
            return Ok(false);
        };
        if o.source == AttributionSource::Hook {
            return Ok(false);
        }
        o.tab_id = Some(hook.tab_id.clone());
        o.agent = Some(hook.agent.clone());
        o.source = AttributionSource::Hook;
        self.rewrite()?;
        Ok(true)
    }

    fn rewrite(&self) -> io::Result<()> {
        let mut text = String::new();
        for e in &self.events {
            text.push_str(&serde_json::to_string(e).map_err(io::Error::other)?);
            text.push('\n');
        }
        crate::atomic::write_atomic(&self.file, text.as_bytes())
    }
}

/// The per-file touchers of `events`: each tab once with its latest time,
/// most recent first; an unknown change counts as one anonymous toucher.
pub fn files_of<'a>(events: impl Iterator<Item = &'a AttributionEvent>) -> Vec<FileAttribution> {
    let mut order: Vec<String> = Vec::new();
    let mut by_path: HashMap<String, Vec<Toucher>> = HashMap::new();
    for e in events {
        let list = by_path.entry(e.path.clone()).or_insert_with(|| {
            order.push(e.path.clone());
            Vec::new()
        });
        match list.iter_mut().find(|t| t.tab_id == e.tab_id) {
            Some(t) => t.at = t.at.max(e.at),
            None => list.push(Toucher {
                tab_id: e.tab_id.clone(),
                agent: e.agent.clone(),
                at: e.at,
            }),
        }
    }
    order
        .into_iter()
        .filter_map(|path| {
            let mut touched_by = by_path.remove(&path)?;
            touched_by.sort_by_key(|t| std::cmp::Reverse(t.at));
            Some(FileAttribution { path, touched_by })
        })
        .collect()
}

/// What a snapshot is refused for.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    TooLarge,
    NotText,
}

/// `Ok(text)` when `bytes` may be snapshotted: at most 1 MB of UTF-8 with no NUL.
pub fn snapshot_text(bytes: &[u8]) -> Result<&str, Refused> {
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(Refused::TooLarge);
    }
    if bytes.contains(&0) {
        return Err(Refused::NotText);
    }
    std::str::from_utf8(bytes).map_err(|_| Refused::NotText)
}

/// The snapshots of one worktree: `<dir>/<key of path>/index.json` lists the
/// versions, `<dir>/<key of path>/<id>` holds each one's text.
#[derive(Debug, Clone)]
pub struct Snapshots {
    dir: PathBuf,
}

#[derive(Default, Serialize, Deserialize)]
struct Index {
    path: String,
    versions: Vec<FileVersion>,
}

impl Snapshots {
    pub fn new(dir: PathBuf) -> Snapshots {
        Snapshots { dir }
    }

    fn folder(&self, rel: &str) -> PathBuf {
        self.dir.join(key_of(rel))
    }

    fn index(&self, rel: &str) -> Index {
        fs::read_to_string(self.folder(rel).join("index.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| Index {
                path: rel.to_owned(),
                versions: Vec::new(),
            })
    }

    fn save(&self, rel: &str, index: &Index) -> io::Result<()> {
        let text = serde_json::to_string(index).map_err(io::Error::other)?;
        crate::atomic::write_atomic(&self.folder(rel).join("index.json"), text.as_bytes())
    }

    /// Keeps `bytes` as a version of `rel`. The same content already kept is
    /// not stored twice: its entry moves to the newest place. At most
    /// `MAX_VERSIONS` stay. Refuses what is not small text.
    pub fn record(
        &self,
        rel: &str,
        bytes: &[u8],
        at: i64,
        tab_id: Option<String>,
        agent: Option<String>,
    ) -> io::Result<Result<FileVersion, Refused>> {
        let text = match snapshot_text(bytes) {
            Ok(t) => t,
            Err(r) => return Ok(Err(r)),
        };
        let id = blake3::hash(text.as_bytes()).to_hex()[..32].to_owned();
        let mut index = self.index(rel);
        index.versions.retain(|v| v.id != id);
        let version = FileVersion {
            id: id.clone(),
            at,
            size: bytes.len() as u64,
            tab_id,
            agent,
        };
        let folder = self.folder(rel);
        let blob = folder.join(&id);
        if !blob.is_file() {
            crate::atomic::write_atomic(&blob, bytes)?;
        }
        index.versions.push(version.clone());
        while index.versions.len() > MAX_VERSIONS {
            let old = index.versions.remove(0);
            let _ = fs::remove_file(folder.join(old.id));
        }
        self.save(rel, &index)?;
        Ok(Ok(version))
    }

    /// The versions of `rel`, newest first.
    pub fn versions(&self, rel: &str) -> Vec<FileVersion> {
        let mut v = self.index(rel).versions;
        v.reverse();
        v
    }

    /// The text of version `id` of `rel`; None when it is not kept.
    pub fn read(&self, rel: &str, id: &str) -> Option<String> {
        let known = self.index(rel).versions.iter().any(|v| v.id == id);
        known
            .then(|| fs::read_to_string(self.folder(rel).join(id)).ok())
            .flatten()
    }
}

/// Writes version `id` of `rel` back into `root`. Refuses a path that is not
/// plain, a version that is not kept, and a folder that leaves the root
/// through a link.
pub fn restore(root: &Path, snaps: &Snapshots, rel: &str, id: &str) -> Result<String, CmdError> {
    let bad = |code: &'static str| CmdError {
        code,
        detail: Some(rel.to_owned()),
    };
    let disk = inside(root, rel).ok_or_else(|| bad("bad_path"))?;
    if !parent_within(root, &disk)? {
        return Err(bad("bad_path"));
    }
    let text = snaps.read(rel, id).ok_or_else(|| bad("not_found"))?;
    crate::atomic::write_atomic(&disk, text.as_bytes()).map_err(io_error)?;
    Ok(text)
}

/// A tab the hub knows from its hooks.
#[derive(Debug, Clone)]
struct Tab {
    agent: String,
    worktree: String,
    working: bool,
}

#[derive(Default)]
struct Inner {
    tabs: HashMap<String, Tab>,
    hooks: HashMap<String, VecDeque<HookEdit>>,
    logs: HashMap<String, EventLog>,
    /// Content a restore wrote: (worktree, path, hash), skipped once when it shows up as a change.
    restored: Vec<(String, String, String)>,
}

/// Managed state: tabs, hook reports and the stores.
#[derive(Clone)]
pub struct Attribution {
    state: Arc<Mutex<Inner>>,
}

impl Default for Attribution {
    fn default() -> Attribution {
        Attribution {
            state: Arc::new(Mutex::new(Inner::default())),
        }
    }
}

/// A hook as the hub needs it.
#[derive(Debug, Clone)]
pub struct HookIn {
    pub tab_id: String,
    pub agent: String,
    pub worktree: String,
    pub event: HookEvent,
    pub tool: Option<String>,
    pub tool_input: Option<String>,
    pub at: i64,
}

fn folder_of(data: &Path, worktree: &str) -> PathBuf {
    data.join("attribution").join(key_of(worktree))
}

impl Attribution {
    fn log_of<'a>(s: &'a mut Inner, data: &Path, worktree: &str) -> &'a mut EventLog {
        s.logs
            .entry(worktree.to_owned())
            .or_insert_with(|| EventLog::open(folder_of(data, worktree).join("events.jsonl")))
    }

    /// Takes a hook: tracks whether the tab works, and remembers an edit.
    /// Returns true when it fixed up an earlier change.
    pub fn hook(&self, data: &Path, h: &HookIn) -> bool {
        let mut s = lock(&self.state);
        let tab = s.tabs.entry(h.tab_id.clone()).or_insert_with(|| Tab {
            agent: h.agent.clone(),
            worktree: h.worktree.clone(),
            working: false,
        });
        tab.working = match h.event {
            HookEvent::Prompt | HookEvent::Resume => true,
            HookEvent::NeedsInput
            | HookEvent::TurnDone
            | HookEvent::TurnFailed
            | HookEvent::Interrupt => false,
            HookEvent::Attention => tab.working,
        };
        let writes = h
            .tool
            .as_deref()
            .is_some_and(|t| WRITE_TOOLS.contains(&t.to_ascii_lowercase().as_str()));
        let (true, Some(input)) = (writes, h.tool_input.as_deref()) else {
            return false;
        };
        let Some(path) = relative(Path::new(&h.worktree), input) else {
            return false;
        };
        let edit = HookEdit {
            tab_id: h.tab_id.clone(),
            agent: h.agent.clone(),
            path,
            at: h.at,
        };
        let queue = s.hooks.entry(h.worktree.clone()).or_default();
        queue.push_back(edit.clone());
        while queue.len() > MAX_HOOKS {
            queue.pop_front();
        }
        let upgraded = Self::log_of(&mut s, data, &h.worktree)
            .upgrade(&edit)
            .unwrap_or(false);
        if upgraded {
            // The change had no owner when it was seen, so nothing was kept: keep
            // the file as it is now, under the hook's tab.
            if let Ok(bytes) = fs::read(Path::new(&h.worktree).join(&edit.path)) {
                let snaps = Snapshots::new(folder_of(data, &h.worktree).join("snaps"));
                let _ = snaps.record(
                    &edit.path,
                    &bytes,
                    edit.at,
                    Some(edit.tab_id),
                    Some(edit.agent),
                );
            }
        }
        upgraded
    }

    /// Takes the changes of one watcher batch: attributes each file, snapshots
    /// what an agent wrote, and logs it. Returns true when the log changed.
    pub fn changed(
        &self,
        data: &Path,
        root: &Path,
        worktree: &str,
        batch: &FsChanged,
        now: i64,
    ) -> bool {
        let mut any = false;
        for e in &batch.events {
            if !matches!(e.kind, FsEventKind::Create | FsEventKind::Update) || e.dir != Some(false)
            {
                continue;
            }
            if skipped(root, &e.rel) {
                continue;
            }
            let bytes = fs::read(root.join(&e.rel)).ok();
            let mut s = lock(&self.state);
            let hash = bytes
                .as_deref()
                .map(|b| blake3::hash(b).to_hex()[..32].to_owned());
            if let Some(at) = s
                .restored
                .iter()
                .position(|(w, p, h)| w == worktree && *p == e.rel && Some(h) == hash.as_ref())
            {
                s.restored.remove(at);
                continue;
            }
            let hooks: Vec<HookEdit> = s
                .hooks
                .get(worktree)
                .map(|q| q.iter().cloned().collect())
                .unwrap_or_default();
            let working: Vec<WorkingTab> = s
                .tabs
                .iter()
                .filter(|(_, t)| t.working && t.worktree == worktree)
                .map(|(id, t)| WorkingTab {
                    tab_id: id.clone(),
                    agent: t.agent.clone(),
                })
                .collect();
            let (who, source) = attribute(&e.rel, now, &hooks, &working);
            let (tab_id, agent) = who.map_or((None, None), |w| (Some(w.tab_id), Some(w.agent)));
            let event = AttributionEvent {
                worktree: worktree.to_owned(),
                path: e.rel.clone(),
                tab_id: tab_id.clone(),
                agent: agent.clone(),
                at: now,
                source,
            };
            if Self::log_of(&mut s, data, worktree).push(event).is_ok() {
                any = true;
            }
            if tab_id.is_some()
                && let Some(b) = bytes
            {
                let snaps = Snapshots::new(folder_of(data, worktree).join("snaps"));
                let _ = snaps.record(&e.rel, &b, now, tab_id, agent);
            }
        }
        any
    }

    /// Notes that a restore wrote `text` to `rel`, so the change it causes is not attributed.
    pub fn restored(&self, worktree: &str, rel: &str, text: &str) {
        let hash = blake3::hash(text.as_bytes()).to_hex()[..32].to_owned();
        let mut s = lock(&self.state);
        s.restored.push((worktree.to_owned(), rel.to_owned(), hash));
        let extra = s.restored.len().saturating_sub(100);
        s.restored.drain(..extra);
    }

    pub fn files(&self, data: &Path, worktree: &str) -> Vec<FileAttribution> {
        let mut s = lock(&self.state);
        files_of(Self::log_of(&mut s, data, worktree).events())
    }

    /// The latest `limit` events, newest first.
    pub fn recent(&self, data: &Path, worktree: &str, limit: usize) -> Vec<AttributionEvent> {
        let mut s = lock(&self.state);
        Self::log_of(&mut s, data, worktree)
            .events()
            .rev()
            .take(limit)
            .cloned()
            .collect()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The `pty://hook` payload, as far as attribution reads it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookPayload {
    id: String,
    event: HookEvent,
    at: i64,
    detail: Option<HookDetailIn>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct HookDetailIn {
    tool_name: Option<String>,
    tool_input: Option<String>,
}

/// Payload of the `attribution://changed` event: the worktree whose list moved.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AttributionChanged {
    pub worktree: String,
}

/// Starts listening to agent hooks. A tab's first hook starts the worktree's
/// file watch; changes that follow are attributed and announced with
/// `attribution://changed`.
pub fn listen(app: &AppHandle) {
    let handle = app.clone();
    app.listen("pty://hook", move |ev| {
        let Ok(p) = serde_json::from_str::<HookPayload>(ev.payload()) else {
            return;
        };
        on_hook(&handle, p);
    });
}

fn on_hook(app: &AppHandle, p: HookPayload) {
    let ptys = app.state::<Ptys>();
    let (Some(agent), Some(cwd)) = (ptys.agent_of(&p.id), ptys.cwd_of(&p.id)) else {
        return;
    };
    let state = app.state::<AppState>();
    let Some(data) = state.data_dir.clone() else {
        return;
    };
    let worktree = cwd.to_string_lossy().into_owned();
    let hub = app.state::<Attribution>();
    let detail = p.detail.unwrap_or_default();
    let upgraded = hub.hook(
        &data,
        &HookIn {
            tab_id: p.id,
            agent,
            worktree: worktree.clone(),
            event: p.event,
            tool: detail.tool_name,
            tool_input: detail.tool_input,
            at: p.at,
        },
    );
    if upgraded {
        let _ = app.emit(
            "attribution://changed",
            AttributionChanged {
                worktree: worktree.clone(),
            },
        );
    }
    track(app, &data, &cwd, &worktree);
}

/// One watch per worktree, started with the first agent hook there.
fn track(app: &AppHandle, data: &Path, cwd: &Path, worktree: &str) {
    let id = format!("attribution:{worktree}");
    let watches = app.state::<FileWatches>();
    if watches.has(&id) {
        return;
    }
    let Ok(root) = dunce::canonicalize(cwd) else {
        return;
    };
    let (app, owned, name) = (app.clone(), data.to_path_buf(), worktree.to_owned());
    let send = Box::new(move |batch: FsChanged| {
        let hub = app.state::<Attribution>();
        if hub.changed(&owned, &root, &name, &batch, now_ms()) {
            let _ = app.emit(
                "attribution://changed",
                AttributionChanged {
                    worktree: name.clone(),
                },
            );
        }
    });
    // A folder the registry does not know is simply not tracked.
    let _ = watches.watch(data, cwd, &id, send);
}

/// Who touched each file of the worktree.
#[tauri::command(async)]
pub fn attribution_files(
    state: State<'_, AppState>,
    hub: State<'_, Attribution>,
    worktree: String,
) -> Result<Vec<FileAttribution>, CmdError> {
    Ok(hub.files(data_dir(&state)?, &worktree))
}

/// The latest attributions of the worktree, newest first.
#[tauri::command(async)]
pub fn attribution_recent(
    state: State<'_, AppState>,
    hub: State<'_, Attribution>,
    worktree: String,
    limit: usize,
) -> Result<Vec<AttributionEvent>, CmdError> {
    Ok(hub.recent(data_dir(&state)?, &worktree, limit.min(200)))
}

/// The kept versions of a file, newest first.
#[tauri::command(async)]
pub fn attribution_versions(
    state: State<'_, AppState>,
    worktree: String,
    path: String,
) -> Result<Vec<FileVersion>, CmdError> {
    let snaps = Snapshots::new(folder_of(data_dir(&state)?, &worktree).join("snaps"));
    Ok(snaps.versions(&path))
}

/// The text of one kept version.
#[tauri::command(async)]
pub fn attribution_version_read(
    state: State<'_, AppState>,
    worktree: String,
    path: String,
    id: String,
) -> Result<String, CmdError> {
    let snaps = Snapshots::new(folder_of(data_dir(&state)?, &worktree).join("snaps"));
    snaps.read(&path, &id).ok_or(CmdError {
        code: "not_found",
        detail: Some(path),
    })
}

/// Writes a kept version back into the worktree. The caller has asked the
/// person to confirm.
#[tauri::command(async)]
pub fn attribution_restore(
    state: State<'_, AppState>,
    hub: State<'_, Attribution>,
    worktree: String,
    path: String,
    id: String,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    known_checkout(data, Path::new(&worktree))?;
    let root = dunce::canonicalize(&worktree).map_err(io_error)?;
    let snaps = Snapshots::new(folder_of(data, &worktree).join("snaps"));
    let text = restore(&root, &snaps, &path, &id)?;
    hub.restored(&worktree, &path, &text);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook(tab: &str, path: &str, at: i64) -> HookEdit {
        HookEdit {
            tab_id: tab.into(),
            agent: "claude".into(),
            path: path.into(),
            at,
        }
    }

    fn tab(id: &str) -> WorkingTab {
        WorkingTab {
            tab_id: id.into(),
            agent: "claude".into(),
        }
    }

    fn ev(path: &str, tab: Option<&str>, at: i64) -> AttributionEvent {
        AttributionEvent {
            worktree: "/w".into(),
            path: path.into(),
            tab_id: tab.map(str::to_owned),
            agent: tab.map(|_| "claude".to_owned()),
            at,
            source: AttributionSource::Hook,
        }
    }

    #[test]
    fn a_hook_on_the_path_wins_over_the_working_tab() {
        let (who, src) = attribute("a.ts", 10_000, &[hook("t2", "a.ts", 9_000)], &[tab("t1")]);
        assert_eq!(who.unwrap().tab_id, "t2");
        assert_eq!(src, AttributionSource::Hook);
    }

    #[test]
    fn the_latest_hook_in_the_window_wins() {
        let hooks = [hook("t1", "a.ts", 8_000), hook("t2", "a.ts", 9_500)];
        let (who, _) = attribute("a.ts", 10_000, &hooks, &[]);
        assert_eq!(who.unwrap().tab_id, "t2");
    }

    #[test]
    fn a_hook_outside_the_window_or_on_another_path_is_no_match() {
        let hooks = [hook("t1", "a.ts", 1_000), hook("t2", "b.ts", 9_900)];
        let (who, src) = attribute("a.ts", 10_000, &hooks, &[]);
        assert!(who.is_none());
        assert_eq!(src, AttributionSource::Unknown);
    }

    #[test]
    fn a_hook_just_after_the_change_still_matches() {
        let (who, src) = attribute("a.ts", 10_000, &[hook("t1", "a.ts", 10_400)], &[]);
        assert_eq!(who.unwrap().tab_id, "t1");
        assert_eq!(src, AttributionSource::Hook);
    }

    #[test]
    fn one_working_tab_gets_the_change() {
        let (who, src) = attribute("a.ts", 10_000, &[], &[tab("t1")]);
        assert_eq!(who.unwrap().tab_id, "t1");
        assert_eq!(src, AttributionSource::Single);
    }

    #[test]
    fn two_or_no_working_tabs_is_unknown() {
        for working in [vec![], vec![tab("t1"), tab("t2")]] {
            let (who, src) = attribute("a.ts", 10_000, &[], &working);
            assert!(who.is_none());
            assert_eq!(src, AttributionSource::Unknown);
        }
    }

    #[test]
    fn relative_handles_absolute_relative_and_outside() {
        let root = Path::new("/w/oak");
        assert_eq!(
            relative(root, "/w/oak/src/a.ts").as_deref(),
            Some("src/a.ts")
        );
        assert_eq!(relative(root, "src/a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(relative(root, "./a.ts").as_deref(), Some("a.ts"));
        assert_eq!(relative(root, "/w/other/a.ts"), None);
        assert_eq!(relative(root, "../a.ts"), None);
        assert_eq!(relative(root, "/w/oak"), None);
    }

    #[test]
    fn the_log_keeps_the_last_events_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("events.jsonl");
        let mut log = EventLog::open(file.clone());
        for i in 0..(MAX_EVENTS + 25) {
            log.push(ev(&format!("f{i}.ts"), Some("t1"), i as i64))
                .unwrap();
        }
        assert_eq!(log.events().count(), MAX_EVENTS);
        assert_eq!(log.events().next().unwrap().path, "f25.ts");
        // It reads back as it was kept.
        let again = EventLog::open(file);
        assert_eq!(again.events().count(), MAX_EVENTS);
        assert_eq!(
            again.events().last().unwrap().path,
            format!("f{}.ts", MAX_EVENTS + 24)
        );
    }

    #[test]
    fn the_same_tab_on_the_same_file_within_two_seconds_is_one_event() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = EventLog::open(dir.path().join("e.jsonl"));
        log.push(ev("a.ts", Some("t1"), 1_000)).unwrap();
        log.push(ev("a.ts", Some("t1"), 1_500)).unwrap();
        log.push(ev("a.ts", Some("t2"), 1_600)).unwrap();
        log.push(ev("a.ts", Some("t1"), 9_000)).unwrap();
        assert_eq!(log.events().count(), 3);
    }

    #[test]
    fn a_late_hook_upgrades_the_change() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = EventLog::open(dir.path().join("e.jsonl"));
        let mut e = ev("a.ts", None, 10_000);
        e.source = AttributionSource::Unknown;
        log.push(e).unwrap();
        assert!(log.upgrade(&hook("t2", "a.ts", 10_300)).unwrap());
        let got = log.events().next().unwrap();
        assert_eq!(
            (got.tab_id.as_deref(), got.source),
            (Some("t2"), AttributionSource::Hook)
        );
        // Already named by a hook: nothing to do.
        assert!(!log.upgrade(&hook("t3", "a.ts", 10_300)).unwrap());
    }

    #[test]
    fn files_list_each_tab_once_most_recent_first() {
        let events = [
            ev("a.ts", Some("t1"), 1_000),
            ev("a.ts", Some("t2"), 5_000),
            ev("a.ts", Some("t1"), 9_000),
            ev("b.ts", None, 2_000),
        ];
        let files = files_of(events.iter());
        assert_eq!(files.len(), 2);
        let a = &files[0];
        assert_eq!(a.path, "a.ts");
        let tabs: Vec<_> = a.touched_by.iter().map(|t| t.tab_id.as_deref()).collect();
        assert_eq!(tabs, [Some("t1"), Some("t2")]);
        assert_eq!(a.touched_by[0].at, 9_000);
        assert_eq!(files[1].touched_by[0].tab_id, None);
    }

    fn snaps() -> (tempfile::TempDir, Snapshots) {
        let dir = tempfile::tempdir().unwrap();
        let s = Snapshots::new(dir.path().join("snaps"));
        (dir, s)
    }

    fn put(s: &Snapshots, text: &str, at: i64) -> FileVersion {
        s.record(
            "a.ts",
            text.as_bytes(),
            at,
            Some("t1".into()),
            Some("claude".into()),
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn a_snapshot_is_kept_once_per_content() {
        let (_d, s) = snaps();
        let one = put(&s, "one", 1);
        put(&s, "two", 2);
        let again = put(&s, "one", 3);
        assert_eq!(one.id, again.id);
        let versions = s.versions("a.ts");
        assert_eq!(versions.len(), 2);
        // The repeat moved to the newest place.
        assert_eq!(versions[0].id, one.id);
        assert_eq!(versions[0].at, 3);
        assert_eq!(s.read("a.ts", &one.id).as_deref(), Some("one"));
    }

    #[test]
    fn at_most_twenty_versions_oldest_dropped_first() {
        let (_d, s) = snaps();
        let first = put(&s, "v0", 0);
        for i in 1..=MAX_VERSIONS {
            put(&s, &format!("v{i}"), i as i64);
        }
        let versions = s.versions("a.ts");
        assert_eq!(versions.len(), MAX_VERSIONS);
        assert_eq!(versions[0].at, MAX_VERSIONS as i64);
        assert!(versions.iter().all(|v| v.id != first.id));
        assert_eq!(s.read("a.ts", &first.id), None);
    }

    #[test]
    fn big_and_binary_files_are_refused() {
        let (_d, s) = snaps();
        let big = vec![b'a'; MAX_SNAPSHOT_BYTES + 1];
        let r = s.record("a.ts", &big, 1, None, None).unwrap();
        assert_eq!(r, Err(Refused::TooLarge));
        let r = s.record("a.ts", b"ab\0cd", 1, None, None).unwrap();
        assert_eq!(r, Err(Refused::NotText));
        let r = s
            .record("a.ts", &[0xff, 0xfe, 0x41], 1, None, None)
            .unwrap();
        assert_eq!(r, Err(Refused::NotText));
        assert!(s.versions("a.ts").is_empty());
        // Exactly 1 MB is fine.
        let max = vec![b'a'; MAX_SNAPSHOT_BYTES];
        assert!(s.record("a.ts", &max, 1, None, None).unwrap().is_ok());
    }

    #[test]
    fn skipped_folders_and_gitignored_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "*.log\nsecret/\n").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join(".gitignore"), "gen.ts\n").unwrap();
        assert!(skipped(root, ".git/HEAD"));
        assert!(skipped(root, "node_modules/x/index.js"));
        assert!(skipped(root, "crates/a/target/debug/x"));
        assert!(skipped(root, "run.log"));
        assert!(skipped(root, "secret/key.txt"));
        assert!(skipped(root, "src/gen.ts"));
        assert!(!skipped(root, "src/main.ts"));
        assert!(!skipped(root, "gen.ts"));
        assert!(!skipped(root, "README.md"));
    }

    #[test]
    fn restore_writes_the_version_back() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("wt");
        fs::create_dir_all(root.join("src")).unwrap();
        let s = Snapshots::new(dir.path().join("snaps"));
        let v = s
            .record("src/a.ts", b"old text", 1, Some("t1".into()), None)
            .unwrap()
            .unwrap();
        fs::write(root.join("src/a.ts"), "new text").unwrap();
        let text = restore(&root, &s, "src/a.ts", &v.id).unwrap();
        assert_eq!(text, "old text");
        assert_eq!(
            fs::read_to_string(root.join("src/a.ts")).unwrap(),
            "old text"
        );
    }

    #[test]
    fn restore_refuses_unknown_versions_and_paths_outside() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("wt");
        fs::create_dir_all(&root).unwrap();
        let s = Snapshots::new(dir.path().join("snaps"));
        assert_eq!(
            restore(&root, &s, "a.ts", "nope").unwrap_err().code,
            "not_found"
        );
        let v = s.record("../a.ts", b"x", 1, None, None).unwrap().unwrap();
        assert_eq!(
            restore(&root, &s, "../a.ts", &v.id).unwrap_err().code,
            "bad_path"
        );
        assert!(!dir.path().join("a.ts").exists());
    }

    fn changed_batch(rel: &str) -> FsChanged {
        use crate::file_watch::FsEvent;
        FsChanged {
            worktree: "w".into(),
            events: vec![FsEvent {
                kind: FsEventKind::Update,
                rel: rel.into(),
                dir: Some(false),
            }],
            failure: None,
        }
    }

    fn hook_in(
        tab: &str,
        wt: &str,
        event: HookEvent,
        tool: Option<&str>,
        input: Option<&str>,
        at: i64,
    ) -> HookIn {
        HookIn {
            tab_id: tab.into(),
            agent: "claude".into(),
            worktree: wt.into(),
            event,
            tool: tool.map(str::to_owned),
            tool_input: input.map(str::to_owned),
            at,
        }
    }

    #[test]
    fn the_hub_attributes_by_hook_then_by_the_one_working_tab() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let root = dir.path().join("wt");
        fs::create_dir_all(&root).unwrap();
        let wt = root.to_string_lossy().into_owned();
        fs::write(root.join("a.ts"), "A1").unwrap();
        fs::write(root.join("b.ts"), "B1").unwrap();
        let hub = Attribution::default();
        // Two tabs work; t2 reports the edit of a.ts.
        hub.hook(
            &data,
            &hook_in("t1", &wt, HookEvent::Prompt, None, None, 1_000),
        );
        hub.hook(
            &data,
            &hook_in("t2", &wt, HookEvent::Prompt, None, None, 1_000),
        );
        let abs = root.join("a.ts").to_string_lossy().into_owned();
        hub.hook(
            &data,
            &hook_in(
                "t2",
                &wt,
                HookEvent::Resume,
                Some("Edit"),
                Some(&abs),
                2_000,
            ),
        );
        assert!(hub.changed(&data, &root, &wt, &changed_batch("a.ts"), 2_100));
        // b.ts has no hook and two tabs work: unknown, no snapshot.
        assert!(hub.changed(&data, &root, &wt, &changed_batch("b.ts"), 2_200));
        // t1 finishes; now t2 alone works and gets b.ts.
        hub.hook(
            &data,
            &hook_in("t1", &wt, HookEvent::TurnDone, None, None, 3_000),
        );
        fs::write(root.join("b.ts"), "B2").unwrap();
        assert!(hub.changed(&data, &root, &wt, &changed_batch("b.ts"), 20_000));

        let recent = hub.recent(&data, &wt, 10);
        let got: Vec<_> = recent
            .iter()
            .map(|e| (e.path.as_str(), e.tab_id.as_deref(), e.source))
            .collect();
        assert_eq!(
            got,
            [
                ("b.ts", Some("t2"), AttributionSource::Single),
                ("b.ts", None, AttributionSource::Unknown),
                ("a.ts", Some("t2"), AttributionSource::Hook),
            ]
        );
        let snaps = Snapshots::new(folder_of(&data, &wt).join("snaps"));
        assert_eq!(snaps.versions("a.ts").len(), 1);
        // Only the attributed write of b.ts was kept.
        let b = snaps.versions("b.ts");
        assert_eq!(b.len(), 1);
        assert_eq!(snaps.read("b.ts", &b[0].id).as_deref(), Some("B2"));
    }

    #[test]
    fn the_hub_ignores_skipped_paths_and_its_own_restore() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let root = dir.path().join("wt");
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/x.js"), "x").unwrap();
        fs::write(root.join("a.ts"), "A").unwrap();
        let wt = root.to_string_lossy().into_owned();
        let hub = Attribution::default();
        hub.hook(
            &data,
            &hook_in("t1", &wt, HookEvent::Prompt, None, None, 1_000),
        );
        assert!(!hub.changed(
            &data,
            &root,
            &wt,
            &changed_batch("node_modules/x.js"),
            2_000
        ));
        hub.restored(&wt, "a.ts", "A");
        assert!(!hub.changed(&data, &root, &wt, &changed_batch("a.ts"), 2_000));
        // The mark is used up: the next change of that content counts.
        assert!(hub.changed(&data, &root, &wt, &changed_batch("a.ts"), 9_000));
    }

    #[test]
    fn a_hook_after_the_change_names_the_tab_late() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let root = dir.path().join("wt");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.ts"), "A").unwrap();
        let wt = root.to_string_lossy().into_owned();
        let hub = Attribution::default();
        // t1 works too, so the change is first attributed to nobody: t3 is not working.
        hub.hook(
            &data,
            &hook_in("t1", &wt, HookEvent::Prompt, None, None, 1_000),
        );
        hub.hook(
            &data,
            &hook_in("t2", &wt, HookEvent::Prompt, None, None, 1_000),
        );
        hub.changed(&data, &root, &wt, &changed_batch("a.ts"), 5_000);
        assert_eq!(hub.recent(&data, &wt, 1)[0].tab_id, None);
        let fixed = hub.hook(
            &data,
            &hook_in(
                "t2",
                &wt,
                HookEvent::Resume,
                Some("Write"),
                Some("a.ts"),
                5_100,
            ),
        );
        assert!(fixed);
        assert_eq!(hub.recent(&data, &wt, 1)[0].tab_id.as_deref(), Some("t2"));
        let snaps = Snapshots::new(folder_of(&data, &wt).join("snaps"));
        assert_eq!(snaps.versions("a.ts")[0].tab_id.as_deref(), Some("t2"));
    }
}
