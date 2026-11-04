//! The Workspace view's commands: the repos the app tracks, the worktrees
//! made from them, and what changed in each. Everything that saves the
//! registry holds `WorkspaceLock` from load to save, so two commands never
//! write over each other.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use xdev_ai::process::{kill_tree, own_group};
use xdev_git::{ChangeKind, GitError, Repo};
use xdev_policy::{Action, Verdict};
use xdev_workspace::{
    DetailsPatch, FolderEntry, HookKind, HookRun, Registry, Removed, RepoHooks, RepoPatch,
    RepoView, ScriptSource, SetupPolicy, SidebarItem, VaultView, WorkspaceError, WorktreeStat,
    WorktreeView, add_repo, add_vault, adopt_worktree, archive_worktree, create_worktree_with,
    forget_repo, forget_vault, hooks_for, kept_delete, list, list_vaults, path_key, refresh_base,
    remove_worktree, repo_docs_dir, restore_worktree, set_details, set_order, set_pinned, sidebar,
    stat, trust_hook, update_repo,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError, create_vault_at, load_git_settings};
use crate::pty::{HookCommand, hook_command};
use crate::settings::GitSettings;
use crate::tasks::gate;

/// Files bigger than this are not read into the diff view.
const MAX_BYTES: u64 = 1 << 20;
/// Git's own look for binary: a NUL in the first 8 KiB.
const SNIFF_BYTES: usize = 8 << 10;

#[derive(Default)]
pub struct WorkspaceLock(Mutex<()>);

impl From<WorkspaceError> for CmdError {
    fn from(e: WorkspaceError) -> CmdError {
        CmdError {
            code: e.code(),
            detail: Some(e.to_string()),
        }
    }
}

impl From<GitError> for CmdError {
    fn from(e: GitError) -> CmdError {
        WorkspaceError::from(e).into()
    }
}

impl From<io::Error> for CmdError {
    fn from(e: io::Error) -> CmdError {
        WorkspaceError::from(e).into()
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorktreeChange {
    pub path: String,
    pub kind: ChangeKind,
}

/// Why a file's two sides are not sent. Named apart in TypeScript from the
/// index's `Skip`, which has other values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "WorktreeSkip"))]
#[serde(rename_all = "snake_case")]
pub enum Skip {
    Binary,
    TooLarge,
}

/// A file at the worktree's start and on disk now; `None` where it is
/// absent, or both `None` with a `skip` reason when it cannot be shown.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct WorktreeFileDiff {
    pub old: Option<String>,
    pub new: Option<String>,
    pub skip: Option<Skip>,
}

pub(crate) fn bad_arg(detail: &str) -> CmdError {
    CmdError {
        code: "bad_arg",
        detail: Some(detail.to_owned()),
    }
}

/// `root` joined with `file`, when `file` is a plain relative path that
/// stays under `root`.
pub(crate) fn inside(root: &Path, file: &str) -> Option<PathBuf> {
    let rel = Path::new(file);
    let plain = rel
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    // `a.txt:stream` would name a stream of the file, not a path.
    let stream = cfg!(windows) && file.contains(':');
    let named = rel.components().any(|c| matches!(c, Component::Normal(_)));
    if !plain || !named || stream {
        return None;
    }
    let joined = root.join(rel);
    joined.starts_with(root).then_some(joined)
}

/// Whether the folder holding `disk` is really inside `root`, links
/// resolved. A folder that does not exist holds nothing to read, so it passes.
pub(crate) fn parent_within(root: &Path, disk: &Path) -> Result<bool, CmdError> {
    let Some(parent) = disk.parent() else {
        return Ok(false);
    };
    match fs::canonicalize(parent) {
        Ok(parent) => Ok(parent.starts_with(fs::canonicalize(root)?)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn lock_guard(lock: &WorkspaceLock) -> std::sync::MutexGuard<'_, ()> {
    // The guard protects no data, only the load-to-save span, so a panic in
    // another command leaves nothing to distrust.
    lock.0.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Loads the registry, runs `f`, and saves when `f` changed it. A failing
/// `f` saves nothing.
fn update<T>(
    data: &Path,
    lock: &WorkspaceLock,
    f: impl FnOnce(&mut Registry) -> Result<T, WorkspaceError>,
) -> Result<T, CmdError> {
    let _guard = lock_guard(lock);
    let mut reg = Registry::load(data)?;
    let before = reg.clone();
    let out = f(&mut reg)?;
    if reg != before {
        reg.save(data)?;
    }
    Ok(out)
}

/// Milliseconds since the epoch, and the nanoseconds as a seed for names.
pub(crate) fn clock() -> (i64, u64) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    (
        i64::try_from(now.as_millis()).unwrap_or(i64::MAX),
        u64::try_from(now.as_nanos()).unwrap_or_default(),
    )
}

fn pin_with(data: &Path, lock: &WorkspaceLock, path: &Path, pinned: bool) -> Result<(), CmdError> {
    update(data, lock, |reg| set_pinned(reg, path, pinned))
}

fn remove_with(
    data: &Path,
    lock: &WorkspaceLock,
    path: &Path,
    force: bool,
    confirmed: bool,
) -> Result<Removed, CmdError> {
    let action = Action::Delete {
        path: path.to_owned(),
    };
    allowed(data, &action, confirmed)?;
    let now = clock().0;
    update(data, lock, |reg| remove_worktree(reg, path, force, now))
}

/// Removes the folder and keeps the branch; the same delete gate as
/// `remove_with`, since the folder goes either way.
fn archive_with(
    data: &Path,
    lock: &WorkspaceLock,
    path: &Path,
    force: bool,
    confirmed: bool,
) -> Result<Removed, CmdError> {
    let action = Action::Delete {
        path: path.to_owned(),
    };
    allowed(data, &action, confirmed)?;
    let now = clock().0;
    update(data, lock, |reg| archive_worktree(reg, path, force, now))
}

/// Deletes a kept branch from git. The gate sees the branch as the ref file
/// it lives in, `<repo>/.git/refs/heads/<branch>`, since `Action` has no
/// branch kind. An unknown repo or branch fails before the gate asks.
fn branch_delete_with(
    data: &Path,
    lock: &WorkspaceLock,
    repo_id: &str,
    branch: &str,
    confirmed: bool,
) -> Result<(), CmdError> {
    let reg = Registry::load(data)?;
    let repo = reg
        .repos
        .iter()
        .find(|r| r.id == repo_id)
        .ok_or_else(|| WorkspaceError::RepoUnknown(repo_id.to_owned()))?;
    if !reg
        .kept
        .iter()
        .any(|k| k.repo_id == repo_id && k.branch == branch)
    {
        return Err(WorkspaceError::KeptUnknown {
            repo_id: repo_id.to_owned(),
            branch: branch.to_owned(),
        }
        .into());
    }
    let action = Action::Delete {
        path: repo
            .path
            .join(".git")
            .join("refs")
            .join("heads")
            .join(branch),
    };
    allowed(data, &action, confirmed)?;
    update(data, lock, |reg| kept_delete(reg, repo_id, branch))
}

/// `Ok` when the policy gate lets `action` run; `confirmed` says the user
/// already said yes to it. The gate writes the audit line.
pub(crate) fn allowed(data: &Path, action: &Action, confirmed: bool) -> Result<(), CmdError> {
    match gate(data)?.check_confirmed(action, confirmed) {
        Verdict::Allow => Ok(()),
        Verdict::Ask { reason } => Err(CmdError {
            code: "needs_approval",
            detail: Some(reason),
        }),
        Verdict::Deny { reason } => Err(CmdError {
            code: "denied",
            detail: Some(reason),
        }),
    }
}

/// The commit a linked worktree started from. The primary checkout has no
/// record, so it is as unknown as a folder the app never made.
pub(crate) fn start_of(data: &Path, path: &Path) -> Result<String, CmdError> {
    let key = path_key(path);
    Registry::load(data)?
        .worktrees
        .into_iter()
        .find(|m| path_key(&m.path) == key)
        .map(|m| m.start)
        .ok_or_else(|| WorkspaceError::WorktreeUnknown(path.to_owned()).into())
}

fn changes(data: &Path, path: &Path) -> Result<Vec<WorktreeChange>, CmdError> {
    let start = start_of(data, path)?;
    Ok(Repo::discover(path)?
        .changes_since(&start)?
        .into_iter()
        .map(|c| WorktreeChange {
            path: c.path,
            kind: c.kind,
        })
        .collect())
}

fn skipped(why: Skip) -> WorktreeFileDiff {
    WorktreeFileDiff {
        old: None,
        new: None,
        skip: Some(why),
    }
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(SNIFF_BYTES)].contains(&0) || std::str::from_utf8(bytes).is_err()
}

fn file_diff(data: &Path, path: &Path, file: &str) -> Result<WorktreeFileDiff, CmdError> {
    inside(path, file).ok_or_else(|| bad_arg(file))?;
    let start = start_of(data, path)?;
    file_diff_at(path, file, &start)
}

/// `file` at the commit `start` and on disk now. The caller has checked
/// that `path` is a known checkout and `start` a commit id.
pub(crate) fn file_diff_at(
    path: &Path,
    file: &str,
    start: &str,
) -> Result<WorktreeFileDiff, CmdError> {
    let disk = inside(path, file).ok_or_else(|| bad_arg(file))?;
    if !parent_within(path, &disk)? {
        return Err(bad_arg(file));
    }
    let repo = Repo::discover(path)?;
    // Sized before it is read, so a large old file never sits in memory.
    let old_size = repo.blob_size(start, file)?;
    if old_size.is_some_and(|n| n > MAX_BYTES) {
        return Ok(skipped(Skip::TooLarge));
    }
    // A link is not followed: it could point anywhere on the disk.
    let new = match fs::symlink_metadata(&disk) {
        Ok(meta) if meta.is_symlink() => return Ok(skipped(Skip::Binary)),
        Ok(meta) if meta.is_file() => {
            if meta.len() > MAX_BYTES {
                return Ok(skipped(Skip::TooLarge));
            }
            Some(fs::read(&disk)?)
        }
        Ok(_) => None,
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let old = match old_size {
        Some(_) => repo.show(start, file)?,
        None => None,
    };
    if [&old, &new].into_iter().flatten().any(|b| is_binary(b)) {
        return Ok(skipped(Skip::Binary));
    }
    // Both sides passed the UTF-8 check in `is_binary`.
    let text = |bytes: Option<Vec<u8>>| bytes.and_then(|b| String::from_utf8(b).ok());
    Ok(WorktreeFileDiff {
        old: text(old),
        new: text(new),
        skip: None,
    })
}

fn commit_files(path: &Path, files: &[String], message: &str) -> Result<Option<String>, CmdError> {
    if message.trim().is_empty() {
        return Err(CmdError {
            code: "empty_message",
            detail: None,
        });
    }
    for file in files {
        let disk = inside(path, file).ok_or_else(|| bad_arg(file))?;
        if !parent_within(path, &disk)? {
            return Err(bad_arg(file));
        }
    }
    Ok(Repo::discover(path)?.commit(files, message)?)
}

#[tauri::command(async)]
pub fn workspace_list(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
) -> Result<Vec<RepoView>, CmdError> {
    update(data_dir(&state)?, &lock, list)
}

#[tauri::command(async)]
pub fn repo_add(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    path: PathBuf,
) -> Result<RepoView, CmdError> {
    let (now_ms, _) = clock();
    update(data_dir(&state)?, &lock, |reg| add_repo(reg, &path, now_ms))
}

#[tauri::command(async)]
pub fn repo_forget(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    id: String,
) -> Result<(), CmdError> {
    update(data_dir(&state)?, &lock, |reg| forget_repo(reg, &id))
}

/// What `repo_clone` sends on its channel while git runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CloneProgress {
    /// A git progress phase such as `Receiving objects`.
    Phase {
        phase: String,
        percent: Option<u8>,
    },
    /// Cloned and added to the workspace.
    Done {
        repo: RepoView,
    },
    Error {
        message: String,
    },
}

/// Clones `url` into `parent/name` (the name from the URL when `None`) and
/// adds it as a repo. `id` names the run for `repo_clone_cancel`.
/// Every event goes on the channel, `Error` too, and the call also fails
/// with the error's code: `bad_arg`, `exists`, `busy`, `cancelled` or git's.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn repo_clone(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    clones: State<'_, Clones>,
    url: String,
    parent: PathBuf,
    name: Option<String>,
    id: String,
    on_event: Channel<CloneProgress>,
) -> Result<(), CmdError> {
    let mut send = |event: CloneProgress| {
        // The window may be gone; the clone still finishes and is added.
        let _ = on_event.send(event);
    };
    let request = CloneRequest {
        url: &url,
        parent: &parent,
        name: name.as_deref(),
    };
    let result = clones.begin(&id).and_then(|run| {
        let data = data_dir(&state)?;
        clone_with(data, &lock, &request, &run.cancel, &mut send, &trash_folder)
    });
    if let Err(e) = &result {
        send(CloneProgress::Error {
            message: e.detail.clone().unwrap_or_else(|| e.code.to_owned()),
        });
    }
    result.map(drop)
}

/// Stops the clone named `id`; nothing when it is not running.
#[tauri::command]
pub fn repo_clone_cancel(clones: State<'_, Clones>, id: String) -> Result<(), CmdError> {
    clones.cancel(&id);
    Ok(())
}

/// The folder name a clone of `url` gets: `xdev` for `.../xdev.git`.
#[tauri::command]
pub fn repo_clone_name(url: String) -> Result<String, CmdError> {
    xdev_git::clone_name(&url).ok_or_else(|| bad_arg("no folder name in the URL"))
}

/// The clones running now, by the id the UI gave each.
#[derive(Default)]
pub struct Clones(Mutex<HashMap<String, Arc<AtomicBool>>>);

/// A running clone's cancel flag; leaving the list when dropped.
pub struct CloneRun<'a> {
    clones: &'a Clones,
    id: String,
    cancel: Arc<AtomicBool>,
}

impl Clones {
    /// `busy` when a clone with this id is running.
    fn begin(&self, id: &str) -> Result<CloneRun<'_>, CmdError> {
        let mut runs = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if runs.contains_key(id) {
            return Err(CmdError {
                code: "busy",
                detail: Some(format!("clone {id} is running")),
            });
        }
        let cancel = Arc::new(AtomicBool::new(false));
        runs.insert(id.to_owned(), cancel.clone());
        Ok(CloneRun {
            clones: self,
            id: id.to_owned(),
            cancel,
        })
    }

    fn cancel(&self, id: &str) {
        let runs = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(flag) = runs.get(id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

impl Drop for CloneRun<'_> {
    fn drop(&mut self) {
        let mut runs = self.clones.0.lock().unwrap_or_else(PoisonError::into_inner);
        runs.remove(&self.id);
    }
}

struct CloneRequest<'a> {
    url: &'a str,
    parent: &'a Path,
    name: Option<&'a str>,
}

/// Progress at most every 100 ms, but always on a new phase or at 100 %.
const CLONE_EVENT_GAP: Duration = Duration::from_millis(100);

/// The clone behind `repo_clone`: checks the URL, the name and the folder,
/// makes the empty folder (so a failure can only trash what this run
/// made), clones into it, then adds it as a repo under the workspace lock
/// and sends `Done`. On a failure or a cancel the folder goes to `trash`.
fn clone_with(
    data: &Path,
    lock: &WorkspaceLock,
    request: &CloneRequest<'_>,
    cancel: &AtomicBool,
    send: &mut dyn FnMut(CloneProgress),
    trash: &dyn Fn(&Path) -> io::Result<()>,
) -> Result<RepoView, CmdError> {
    let dest = clone_dest(request)?;
    let cloned = {
        let mut last: Option<(String, Instant)> = None;
        let mut on_event = |event: xdev_git::CloneEvent| {
            let xdev_git::CloneEvent::Progress { phase, percent } = event else {
                return;
            };
            let due = match &last {
                Some((was, at)) => {
                    *was != phase || percent == Some(100) || at.elapsed() >= CLONE_EVENT_GAP
                }
                None => true,
            };
            if due {
                last = Some((phase.clone(), Instant::now()));
                send(CloneProgress::Phase { phase, percent });
            }
        };
        xdev_git::clone_repo(request.url, &dest, cancel, &mut on_event)
    };
    let added = cloned.map_err(CmdError::from).and_then(|()| {
        let (now_ms, _) = clock();
        update(data, lock, |reg| add_repo(reg, &dest, now_ms))
    });
    match added {
        Ok(repo) => {
            send(CloneProgress::Done { repo: repo.clone() });
            Ok(repo)
        }
        Err(mut e) => {
            if dest.exists()
                && let Err(t) = trash(&dest)
            {
                let detail = e.detail.take().unwrap_or_default();
                e.detail = Some(format!(
                    "{detail}; the folder was left at {}: {t}",
                    dest.display()
                ));
            }
            Err(e)
        }
    }
}

/// `parent/name` made as an empty folder; `exists` when something is there.
fn clone_dest(request: &CloneRequest<'_>) -> Result<PathBuf, CmdError> {
    xdev_git::check_clone_url(request.url)?;
    let name = match request.name {
        Some(name) => name.trim().to_owned(),
        None => {
            xdev_git::clone_name(request.url).ok_or_else(|| bad_arg("no folder name in the URL"))?
        }
    };
    let plain = !name.is_empty()
        && name.chars().count() <= 255
        && name != "."
        && name != ".."
        && !name.starts_with('-')
        && !name
            .chars()
            .any(|c| c.is_control() || r#"/\:*?"<>|"#.contains(c));
    if !plain {
        return Err(bad_arg("folder name"));
    }
    if !request.parent.is_absolute() || !request.parent.is_dir() {
        return Err(bad_arg("parent folder"));
    }
    let dest = request.parent.join(&name);
    match fs::create_dir(&dest) {
        Ok(()) => Ok(dest),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(CmdError {
            code: "exists",
            detail: Some(dest.display().to_string()),
        }),
        Err(e) => Err(e.into()),
    }
}

/// A failed clone's folder goes to the OS trash, never a hard delete.
fn trash_folder(path: &Path) -> io::Result<()> {
    trash::delete(path).map_err(|e| io::Error::other(e.to_string()))
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn repo_update(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    id: String,
    short_name: Option<String>,
    base_ref: Option<String>,
    worktree_root: Option<PathBuf>,
    setup_policy: Option<SetupPolicy>,
    script_source: Option<ScriptSource>,
    local_setup: Option<String>,
    local_archive: Option<String>,
) -> Result<RepoView, CmdError> {
    let patch = RepoPatch {
        short_name,
        base_ref,
        worktree_root,
        setup_policy,
        script_source,
        local_setup,
        local_archive,
    };
    update(data_dir(&state)?, &lock, |reg| update_repo(reg, &id, patch))
}

/// The setup and archive scripts of the worktree at `path`. Read only.
#[tauri::command(async)]
pub fn repo_hooks(state: State<'_, AppState>, path: PathBuf) -> Result<RepoHooks, CmdError> {
    let data = data_dir(&state)?;
    Ok(hooks_for(&Registry::load(data)?, data, &path)?)
}

/// Trusts the shared script of `kind` whose hash is `hash`; `hook_untrusted`
/// when the file no longer holds that script.
#[tauri::command(async)]
pub fn repo_hook_trust(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    path: PathBuf,
    kind: HookKind,
    hash: String,
) -> Result<RepoHooks, CmdError> {
    let data = data_dir(&state)?;
    let (now_ms, _) = clock();
    // The trust store is not the registry, but one writer at a time keeps
    // two approvals from racing on it too.
    let _guard = lock_guard(&lock);
    let reg = Registry::load(data)?;
    Ok(trust_hook(&reg, data, &path, kind, &hash, now_ms)?)
}

/// Runs the worktree's archive script headless before it is removed.
#[tauri::command(async)]
pub fn worktree_archive_run(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<HookRun, CmdError> {
    archive_run(data_dir(&state)?, &path, ARCHIVE_TIMEOUT)
}

/// How long an archive script may run before it is killed.
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(120);
/// The most of its output kept.
const MAX_HOOK_OUTPUT: usize = 64 * 1024;
/// How long the output is still read after the shell has ended.
const READ_GRACE: Duration = Duration::from_secs(2);

/// `worktree_archive_run` with the timeout as a parameter.
fn archive_run(data: &Path, path: &Path, timeout: Duration) -> Result<HookRun, CmdError> {
    match hook_command(data, path, HookKind::Archive)? {
        None => Ok(HookRun {
            ran: false,
            code: None,
            output: String::new(),
        }),
        Some(hook) => Ok(run_headless(hook, path, timeout)?),
    }
}

/// Runs `hook` in `cwd` with no window and no input, stdout and stderr
/// together in one buffer of at most `MAX_HOOK_OUTPUT` bytes. Past
/// `timeout` the shell and everything it started are killed (a process
/// group on Unix, `taskkill /T` on Windows) and `code` is `None`.
fn run_headless(hook: HookCommand, cwd: &Path, timeout: Duration) -> io::Result<HookRun> {
    let mut cmd = Command::new(&hook.program);
    cmd.args(&hook.args)
        .envs(hook.env.iter().map(|(k, v)| (k, v)))
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // Its own process group on Unix, so the timeout reaches what it started.
    own_group(&mut cmd);
    let mut child = cmd.spawn()?;
    let out = Arc::new(Mutex::new(Vec::new()));
    let pipes: [Option<Box<dyn Read + Send>>; 2] = [
        child
            .stdout
            .take()
            .map(|r| Box::new(r) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|r| Box::new(r) as Box<dyn Read + Send>),
    ];
    let (done, finished) = mpsc::channel::<()>();
    let mut readers = 0;
    for mut pipe in pipes.into_iter().flatten() {
        let out = Arc::clone(&out);
        let done = done.clone();
        readers += 1;
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            // Reads to the end past the cap, so the shell never blocks on a
            // full pipe.
            while let Ok(n @ 1..) = pipe.read(&mut buf) {
                let mut out = out.lock().unwrap_or_else(PoisonError::into_inner);
                let room = MAX_HOOK_OUTPUT.saturating_sub(out.len());
                out.extend_from_slice(&buf[..n.min(room)]);
            }
            let _ = done.send(());
        });
    }
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if Instant::now() >= deadline {
            // The tree first: Windows finds it by parent id, so the shell
            // must still be alive.
            kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        thread::sleep(Duration::from_millis(20));
    };
    // A child the shell left running may still hold the pipes: the readers
    // get `READ_GRACE` to reach the end, then are left to finish on their
    // own and what they read by then is the output.
    let grace = Instant::now() + READ_GRACE;
    for _ in 0..readers {
        let left = grace.saturating_duration_since(Instant::now());
        if finished.recv_timeout(left).is_err() {
            break;
        }
    }
    let bytes = out.lock().unwrap_or_else(PoisonError::into_inner).clone();
    let mut output = String::from_utf8_lossy(&bytes).trim_end().to_owned();
    if status.is_none() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&format!("(stopped after {} s)", timeout.as_secs()));
    }
    Ok(HookRun {
        ran: true,
        code: status.and_then(|s| s.code()),
        output,
    })
}

#[tauri::command(async)]
pub fn worktree_adopt(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    path: PathBuf,
) -> Result<WorktreeView, CmdError> {
    let (now_ms, _) = clock();
    update(data_dir(&state)?, &lock, |reg| {
        adopt_worktree(reg, &path, now_ms)
    })
}

/// Read-only: loads the registry without the save lock, like `worktree_stat`.
#[tauri::command(async)]
pub fn vault_list(state: State<'_, AppState>) -> Result<Vec<VaultView>, CmdError> {
    Ok(list_vaults(&Registry::load(data_dir(&state)?)?))
}

#[tauri::command(async)]
pub fn vault_add(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    path: PathBuf,
) -> Result<VaultView, CmdError> {
    update(data_dir(&state)?, &lock, |reg| add_vault(reg, &path))
}

#[tauri::command(async)]
pub fn vault_forget(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    id: String,
) -> Result<(), CmdError> {
    update(data_dir(&state)?, &lock, |reg| forget_vault(reg, &id))
}

/// Makes `<primary checkout>/docs` for a repo without one, with the starter
/// doc; a folder that already has anything in it is left alone. Writes no
/// registry data, so it needs no lock.
fn vault_create_docs_in(
    data: &Path,
    repo_id: &str,
    file: &str,
    content: &str,
) -> Result<VaultView, CmdError> {
    let reg = Registry::load(data)?;
    let entry = reg
        .repos
        .iter()
        .find(|r| r.id == repo_id)
        .ok_or_else(|| WorkspaceError::RepoUnknown(repo_id.to_owned()))?;
    create_vault_at(&repo_docs_dir(entry), file, content)?;
    let id = format!("repo:{repo_id}");
    list_vaults(&reg)
        .into_iter()
        .find(|v| v.id == id)
        .ok_or_else(|| WorkspaceError::RepoUnknown(repo_id.to_owned()).into())
}

#[tauri::command(async)]
pub fn vault_create_docs(
    state: State<'_, AppState>,
    repo_id: String,
    file: String,
    content: String,
) -> Result<VaultView, CmdError> {
    vault_create_docs_in(data_dir(&state)?, &repo_id, &file, &content)
}

/// Names the branch and, when asked, refreshes the base first, as
/// Settings → Git says.
#[tauri::command(async)]
pub fn worktree_create(
    app: AppHandle,
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    repo_id: String,
    name: String,
    from: Option<String>,
) -> Result<WorktreeView, CmdError> {
    let git = load_git_settings(&app);
    create_with(
        data_dir(&state)?,
        &lock,
        &git,
        &repo_id,
        &name,
        from.as_deref(),
    )
}

fn create_with(
    data: &Path,
    lock: &WorkspaceLock,
    git: &GitSettings,
    repo_id: &str,
    name: &str,
    from: Option<&str>,
) -> Result<WorktreeView, CmdError> {
    if git.refresh_local_base_on_create {
        // The fetch can take long, so the lock is held only to read the
        // registry. A refresh that fails leaves the base as it was, and the
        // worktree starts from that.
        let reg = {
            let _guard = lock_guard(lock);
            Registry::load(data)?
        };
        let _ = refresh_base(&reg, repo_id, from);
    }
    let opts = git.create_options();
    let (now_ms, seed) = clock();
    update(data, lock, |reg| {
        create_worktree_with(reg, repo_id, name, from, now_ms, seed, &opts)
    })
}

#[tauri::command(async)]
pub fn worktree_pin(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    path: PathBuf,
    pinned: bool,
) -> Result<(), CmdError> {
    pin_with(data_dir(&state)?, &lock, &path, pinned)
}

#[tauri::command(async)]
pub fn worktree_remove(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    path: PathBuf,
    force: bool,
    confirmed: bool,
) -> Result<Removed, CmdError> {
    remove_with(data_dir(&state)?, &lock, &path, force, confirmed)
}

#[tauri::command(async)]
pub fn worktree_archive(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    path: PathBuf,
    force: bool,
    confirmed: bool,
) -> Result<Removed, CmdError> {
    archive_with(data_dir(&state)?, &lock, &path, force, confirmed)
}

#[tauri::command(async)]
pub fn worktree_details(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    path: PathBuf,
    patch: DetailsPatch,
) -> Result<(), CmdError> {
    update(data_dir(&state)?, &lock, |reg| {
        set_details(reg, &path, patch)
    })
}

#[tauri::command(async)]
pub fn worktree_restore(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    repo_id: String,
    branch: String,
) -> Result<WorktreeView, CmdError> {
    let now = clock().0;
    update(data_dir(&state)?, &lock, |reg| {
        restore_worktree(reg, &repo_id, &branch, now)
    })
}

/// Stops listing a kept branch; the branch stays in git.
#[tauri::command(async)]
pub fn kept_keep(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    repo_id: String,
    branch: String,
) -> Result<(), CmdError> {
    update(data_dir(&state)?, &lock, |reg| {
        xdev_workspace::kept_keep(reg, &repo_id, &branch)
    })
}

#[tauri::command(async)]
pub fn branch_delete(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    repo_id: String,
    branch: String,
    confirmed: bool,
) -> Result<(), CmdError> {
    branch_delete_with(data_dir(&state)?, &lock, &repo_id, &branch, confirmed)
}

/// Repos with their kept branches, folders and groups in shown order.
#[tauri::command(async)]
pub fn workspace_sidebar(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
) -> Result<Vec<SidebarItem>, CmdError> {
    let now = clock().0;
    update(data_dir(&state)?, &lock, |reg| sidebar(reg, now))
}

#[tauri::command(async)]
pub fn sidebar_order(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    ids: Vec<String>,
) -> Result<(), CmdError> {
    update(data_dir(&state)?, &lock, |reg| set_order(reg, &ids))
}

/// Creates a group (no `id`) or renames one; returns its id.
#[tauri::command(async)]
pub fn group_put(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    id: Option<String>,
    name: String,
) -> Result<String, CmdError> {
    update(data_dir(&state)?, &lock, |reg| {
        xdev_workspace::group_put(reg, id.as_deref(), &name)
    })
}

#[tauri::command(async)]
pub fn group_remove(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    id: String,
) -> Result<(), CmdError> {
    update(data_dir(&state)?, &lock, |reg| {
        xdev_workspace::group_remove(reg, &id)
    })
}

#[tauri::command(async)]
pub fn group_move(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    member: String,
    group: Option<String>,
    index: usize,
) -> Result<(), CmdError> {
    update(data_dir(&state)?, &lock, |reg| {
        xdev_workspace::group_move(reg, &member, group.as_deref(), index)
    })
}

#[tauri::command(async)]
pub fn folder_add(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    path: PathBuf,
) -> Result<FolderEntry, CmdError> {
    update(data_dir(&state)?, &lock, |reg| {
        xdev_workspace::folder_add(reg, &path)
    })
}

/// Drops the folder from the sidebar; nothing on disk is touched.
#[tauri::command(async)]
pub fn folder_forget(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    id: String,
) -> Result<(), CmdError> {
    update(data_dir(&state)?, &lock, |reg| {
        xdev_workspace::folder_forget(reg, &id)
    })
}

#[tauri::command(async)]
pub fn worktree_changes(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<Vec<WorktreeChange>, CmdError> {
    changes(data_dir(&state)?, &path)
}

/// Read-only: loads the registry without the save lock, like `worktree_changes`.
#[tauri::command(async)]
pub fn worktree_stat(state: State<'_, AppState>, path: PathBuf) -> Result<WorktreeStat, CmdError> {
    Ok(stat(&Registry::load(data_dir(&state)?)?, &path)?)
}

#[tauri::command(async)]
pub fn worktree_file_diff(
    state: State<'_, AppState>,
    path: PathBuf,
    file: String,
) -> Result<WorktreeFileDiff, CmdError> {
    file_diff(data_dir(&state)?, &path, &file)
}

/// One folder of a worktree, for the file tree. Any checkout the registry
/// knows, the primary one too; `dir` is relative to it.
fn dir_listing(
    data: &Path,
    path: &Path,
    dir: &str,
) -> Result<xdev_workspace::DirListing, CmdError> {
    known_checkout(data, path)?;
    Ok(xdev_workspace::list_dir(&path.to_string_lossy(), dir)?)
}

/// `Ok` when `path` is a repo or a worktree the registry knows, the primary
/// checkout too; `worktree_unknown` otherwise.
pub(crate) fn known_checkout(data: &Path, path: &Path) -> Result<(), CmdError> {
    let key = path_key(path);
    let reg = Registry::load(data)?;
    let known = reg.repos.iter().any(|r| path_key(&r.path) == key)
        || reg.worktrees.iter().any(|m| path_key(&m.path) == key);
    if !known {
        return Err(WorkspaceError::WorktreeUnknown(path.to_owned()).into());
    }
    Ok(())
}

#[tauri::command(async)]
pub fn worktree_list_dir(
    state: State<'_, AppState>,
    path: PathBuf,
    dir: String,
) -> Result<xdev_workspace::DirListing, CmdError> {
    dir_listing(data_dir(&state)?, &path, &dir)
}

#[tauri::command(async)]
pub fn worktree_commit(
    path: PathBuf,
    files: Vec<String>,
    message: String,
) -> Result<Option<String>, CmdError> {
    commit_files(&path, &files, &message)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use tempfile::TempDir;
    use xdev_workspace::{Registry, VaultKind, add_repo, create_worktree};

    use super::*;

    /// Runs setup commands; never used for the code under test.
    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap()
    }

    /// A repo with one commit, added to the registry in `data`, with two
    /// worktrees made from it. The temp dir lives as long as this value.
    struct Fixture {
        _tmp: TempDir,
        main: PathBuf,
        data: PathBuf,
        first: PathBuf,
        second: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = crate::test_dirs::long_temp_dir("ws cmd ");
        let main = tmp.path().join("main");
        let data = tmp.path().join("data");
        fs::create_dir(&main).unwrap();
        git(&main, &["init", "-q"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&main, &["config", key, value]);
        }
        fs::write(main.join("a.txt"), "one").unwrap();
        git(&main, &["add", "-A"]);
        git(&main, &["commit", "-q", "-m", "one"]);

        let mut reg = Registry::load(&data).unwrap();
        let id = add_repo(&mut reg, &main, 0).unwrap().id;
        let first = create_worktree(&mut reg, &id, "first", None, 1, 1).unwrap();
        let second = create_worktree(&mut reg, &id, "second", None, 2, 2).unwrap();
        reg.save(&data).unwrap();
        Fixture {
            _tmp: tmp,
            main,
            data,
            first: PathBuf::from(first.path),
            second: PathBuf::from(second.path),
        }
    }

    fn code<T: std::fmt::Debug>(r: Result<T, CmdError>) -> &'static str {
        r.unwrap_err().code
    }

    #[test]
    fn create_with_names_the_branch_as_git_settings_say() {
        use crate::settings::BranchPrefixMode;
        let fx = fixture();
        let lock = WorkspaceLock::default();
        let id = Registry::load(&fx.data).unwrap().repos[0].id.clone();
        let mut git = GitSettings {
            branch_prefix: BranchPrefixMode::Custom,
            branch_prefix_custom: "a b".into(),
            ..GitSettings::default()
        };
        let err = create_with(&fx.data, &lock, &git, &id, "x", None).unwrap_err();
        assert_eq!(err.code, "bad_branch_prefix");

        git.branch_prefix_custom = "team".into();
        let wt = create_with(&fx.data, &lock, &git, &id, "x", None).unwrap();
        assert_eq!(wt.branch.as_deref(), Some("team/x"));

        // `Test User` cannot start a branch name, so it is left out.
        git.branch_prefix = BranchPrefixMode::GitUsername;
        let wt = create_with(&fx.data, &lock, &git, &id, "y", None).unwrap();
        assert_eq!(wt.branch.as_deref(), Some("y"));

        // No remote to fetch from: the create still goes ahead.
        git.branch_prefix = BranchPrefixMode::None;
        git.refresh_local_base_on_create = true;
        let wt = create_with(&fx.data, &lock, &git, &id, "z", None).unwrap();
        assert_eq!(wt.branch.as_deref(), Some("z"));
    }
    #[test]
    fn worktree_remove_asks_then_runs_when_confirmed() {
        let fx = fixture();
        let lock = WorkspaceLock::default();
        let asked = remove_with(&fx.data, &lock, &fx.first, false, false);
        assert_eq!(code(asked), "needs_approval");
        assert!(fx.first.exists());

        remove_with(&fx.data, &lock, &fx.first, false, true).unwrap();
        assert!(!fx.first.exists());
        let verdicts: Vec<_> = xdev_policy::read_audit(&fx.data)
            .unwrap()
            .into_iter()
            .map(|entry| entry.verdict)
            .collect();
        assert!(matches!(
            verdicts[..],
            [Verdict::Ask { .. }, Verdict::Allow]
        ));
    }

    fn verdicts(data: &Path) -> Vec<Verdict> {
        xdev_policy::read_audit(data)
            .unwrap()
            .into_iter()
            .map(|entry| entry.verdict)
            .collect()
    }

    #[test]
    fn archive_goes_through_the_delete_gate() {
        let fx = fixture();
        let lock = WorkspaceLock::default();
        let asked = archive_with(&fx.data, &lock, &fx.first, false, false);
        assert_eq!(code(asked), "needs_approval");
        assert!(fx.first.exists());

        let removed = archive_with(&fx.data, &lock, &fx.first, false, true).unwrap();
        assert!(!fx.first.exists());
        assert!(removed.kept.is_some());
        assert!(matches!(
            verdicts(&fx.data)[..],
            [Verdict::Ask { .. }, Verdict::Allow]
        ));

        fs::write(fx.data.join("policy.json"), r#"{"delete":"deny"}"#).unwrap();
        let err = archive_with(&fx.data, &lock, &fx.second, false, true).unwrap_err();
        assert_eq!(err.code, "denied");
        assert!(fx.second.exists());
    }

    #[test]
    fn branch_delete_goes_through_the_delete_gate() {
        let fx = fixture();
        let lock = WorkspaceLock::default();
        let removed = archive_with(&fx.data, &lock, &fx.first, false, true).unwrap();
        let kept = removed.kept.unwrap();
        let has_branch = || {
            !git(&fx.main, &["branch", "--list", &kept.branch])
                .trim()
                .is_empty()
        };

        let asked = branch_delete_with(&fx.data, &lock, &kept.repo_id, &kept.branch, false);
        assert_eq!(code(asked), "needs_approval");
        assert!(has_branch());

        branch_delete_with(&fx.data, &lock, &kept.repo_id, &kept.branch, true).unwrap();
        assert!(!has_branch());
        assert!(Registry::load(&fx.data).unwrap().kept.is_empty());
        let audit = verdicts(&fx.data);
        assert!(matches!(
            audit[audit.len() - 2..],
            [Verdict::Ask { .. }, Verdict::Allow]
        ));

        // Gone from the list: refused before the gate is asked.
        let before = verdicts(&fx.data).len();
        let gone = branch_delete_with(&fx.data, &lock, &kept.repo_id, &kept.branch, true);
        assert_eq!(code(gone), "kept_unknown");
        assert_eq!(verdicts(&fx.data).len(), before);
    }

    #[test]
    fn worktree_remove_denied_by_policy() {
        let fx = fixture();
        fs::write(fx.data.join("policy.json"), r#"{"delete":"deny"}"#).unwrap();
        let lock = WorkspaceLock::default();
        let err = remove_with(&fx.data, &lock, &fx.first, false, true).unwrap_err();
        assert_eq!(err.code, "denied");
        assert_eq!(err.detail.as_deref(), Some("delete denied by policy"));
        assert!(fx.first.exists());
    }

    #[test]
    fn file_diff_refuses_path_outside_worktree() {
        let fx = fixture();
        let mut bad = vec!["../x", "/etc/passwd", "a/../../x", "", "a/../b"];
        if cfg!(windows) {
            bad.extend(["C:\\x", "C:x", "..\\x"]);
        }
        for file in bad {
            let r = file_diff(&fx.data, &fx.first, file);
            assert_eq!(code(r), "bad_arg", "{file}");
        }
    }

    /// A folder link `<worktree>/link` to a folder outside it holding `x.txt`;
    /// `None` when the system would not make one.
    fn linked_outside(fx: &Fixture) -> Option<()> {
        let outside = fx.first.parent().unwrap().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("x.txt"), "secret").unwrap();
        let link = fx.first.join("link");
        #[cfg(windows)]
        let made = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&link)
            .arg(&outside)
            .output()
            .is_ok_and(|o| o.status.success());
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&outside, &link).is_ok();
        made.then_some(())
    }

    #[test]
    fn paths_through_a_linked_folder_are_refused() {
        let fx = fixture();
        if linked_outside(&fx).is_none() {
            eprintln!("skipped: cannot make a folder link here");
            return;
        }
        assert_eq!(
            code(file_diff(&fx.data, &fx.first, "link/x.txt")),
            "bad_arg"
        );
        let files = ["link/x.txt".to_owned()];
        assert_eq!(code(commit_files(&fx.first, &files, "m")), "bad_arg");
    }

    #[test]
    fn file_diff_reads_both_sides() {
        let fx = fixture();
        fs::write(fx.first.join("a.txt"), "two").unwrap();
        fs::write(fx.first.join("new.txt"), "fresh").unwrap();
        let d = file_diff(&fx.data, &fx.first, "a.txt").unwrap();
        assert_eq!(d.old.as_deref(), Some("one"));
        assert_eq!(d.new.as_deref(), Some("two"));
        assert!(d.skip.is_none());
        let d = file_diff(&fx.data, &fx.first, "new.txt").unwrap();
        assert_eq!((d.old, d.new.as_deref()), (None, Some("fresh")));
    }

    #[test]
    fn file_diff_for_the_primary_checkout_is_refused() {
        let fx = fixture();
        let r = file_diff(&fx.data, &fx.main, "a.txt");
        assert_eq!(code(r), "worktree_unknown");
    }

    #[test]
    fn file_diff_marks_binary_and_large() {
        let fx = fixture();
        fs::write(fx.first.join("bin.dat"), b"ab\0cd").unwrap();
        fs::write(fx.first.join("latin.txt"), [0xff, 0xfe, b'a']).unwrap();
        fs::write(fx.first.join("big.txt"), "a".repeat(2 << 20)).unwrap();
        let diff = |file: &str| file_diff(&fx.data, &fx.first, file).unwrap();
        assert_eq!(diff("bin.dat").skip, Some(Skip::Binary));
        assert_eq!(diff("latin.txt").skip, Some(Skip::Binary));
        let big = diff("big.txt");
        assert_eq!(big.skip, Some(Skip::TooLarge));
        assert_eq!((big.old, big.new), (None, None));
    }

    #[test]
    fn file_diff_skips_a_large_old_side() {
        let fx = fixture();
        fs::write(fx.main.join("big.txt"), "a".repeat(2 << 20)).unwrap();
        git(&fx.main, &["add", "big.txt"]);
        git(&fx.main, &["commit", "-q", "-m", "big"]);
        let mut reg = Registry::load(&fx.data).unwrap();
        let id = reg.repos[0].id.clone();
        let third = create_worktree(&mut reg, &id, "third", None, 3, 3).unwrap();
        reg.save(&fx.data).unwrap();
        let third = PathBuf::from(third.path);

        // Small now, and gone: the old side alone is too large to read.
        fs::write(third.join("big.txt"), "small").unwrap();
        let d = file_diff(&fx.data, &third, "big.txt").unwrap();
        assert_eq!(d.skip, Some(Skip::TooLarge));
        assert_eq!((d.old, d.new), (None, None));
        fs::remove_file(third.join("big.txt")).unwrap();
        let d = file_diff(&fx.data, &third, "big.txt").unwrap();
        assert_eq!(d.skip, Some(Skip::TooLarge));
    }

    #[test]
    fn changes_list_files_since_the_start() {
        let fx = fixture();
        fs::write(fx.first.join("a.txt"), "two").unwrap();
        fs::write(fx.first.join("b.txt"), "x").unwrap();
        let found = changes(&fx.data, &fx.first).unwrap();
        let paths: Vec<_> = found.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "b.txt"]);
        assert_eq!(code(changes(&fx.data, &fx.main)), "worktree_unknown");
    }

    #[test]
    fn commit_selected_files_only() {
        let fx = fixture();
        fs::write(fx.first.join("a.txt"), "two").unwrap();
        fs::write(fx.first.join("b.txt"), "x").unwrap();
        let id = commit_files(&fx.first, &["a.txt".to_owned()], "change a").unwrap();
        assert_eq!(
            id.as_deref(),
            Some(git(&fx.first, &["rev-parse", "HEAD"]).trim())
        );
        // Both still differ from the start, but only `b.txt` is uncommitted.
        let left = changes(&fx.data, &fx.first).unwrap();
        assert!(left.iter().any(|c| c.path == "b.txt"));
        assert_eq!(
            git(&fx.first, &["status", "--porcelain"]).trim(),
            "?? b.txt"
        );
    }

    #[test]
    fn commit_refuses_blank_message_and_outside_paths() {
        let fx = fixture();
        fs::write(fx.first.join("a.txt"), "two").unwrap();
        let files = ["a.txt".to_owned()];
        assert_eq!(code(commit_files(&fx.first, &files, "  ")), "empty_message");
        let outside = ["../x".to_owned()];
        assert_eq!(code(commit_files(&fx.first, &outside, "m")), "bad_arg");
    }

    #[test]
    fn path_key_is_the_workspace_crates() {
        let key = |p: &str| xdev_workspace::path_key(Path::new(p));
        assert_eq!(key("/r/wt/a/"), "/r/wt/a");
        assert_eq!(key("/r/wt/a//"), "/r/wt/a");
        if cfg!(windows) {
            assert_eq!(key("C:\\R\\Wt\\A\\"), "c:/r/wt/a");
        } else {
            assert_eq!(key("/R/Wt"), "/R/Wt");
        }
    }

    #[test]
    fn repo_update_saves_through_lock() {
        let fx = fixture();
        let lock = WorkspaceLock::default();
        let id = Registry::load(&fx.data).unwrap().repos[0].id.clone();
        let patch = RepoPatch {
            short_name: Some("renamed".to_owned()),
            ..RepoPatch::default()
        };
        let view = update(&fx.data, &lock, |reg| update_repo(reg, &id, patch)).unwrap();
        assert_eq!(view.short_name, "renamed");
        assert_eq!(
            Registry::load(&fx.data).unwrap().repos[0].short_name,
            "renamed"
        );

        // A refused patch saves nothing.
        let bad = RepoPatch {
            short_name: Some("Bad Name".to_owned()),
            ..RepoPatch::default()
        };
        let err = update(&fx.data, &lock, |reg| update_repo(reg, &id, bad)).unwrap_err();
        assert_eq!(err.code, "bad_name");
        assert_eq!(
            Registry::load(&fx.data).unwrap().repos[0].short_name,
            "renamed"
        );
    }

    #[test]
    fn new_workspace_errors_map_to_codes() {
        let code_of = |e: WorkspaceError| CmdError::from(e).code;
        assert_eq!(
            code_of(WorkspaceError::ShortNameTaken("x".into())),
            "short_name_taken"
        );
        assert_eq!(
            code_of(WorkspaceError::VaultExists("x".into())),
            "vault_exists"
        );
        assert_eq!(
            code_of(WorkspaceError::VaultUnknown("x".into())),
            "vault_unknown"
        );
    }

    #[test]
    fn vault_add_and_forget_keep_the_folder() {
        let fx = fixture();
        let lock = WorkspaceLock::default();
        let shared = fx.main.parent().unwrap().join("shared");
        fs::create_dir(&shared).unwrap();
        fs::write(shared.join("a.md"), "# a").unwrap();
        let view = update(&fx.data, &lock, |reg| add_vault(reg, &shared)).unwrap();
        assert_eq!(view.kind, VaultKind::Shared);
        let listed = list_vaults(&Registry::load(&fx.data).unwrap());
        assert!(listed.iter().any(|v| v.id == view.id));
        let again = update(&fx.data, &lock, |reg| add_vault(reg, &shared));
        assert_eq!(code(again), "vault_exists");

        update(&fx.data, &lock, |reg| forget_vault(reg, &view.id)).unwrap();
        assert!(shared.join("a.md").is_file());
        let gone = update(&fx.data, &lock, |reg| forget_vault(reg, &view.id));
        assert_eq!(code(gone), "vault_unknown");
    }

    #[test]
    fn vault_create_docs_writes_starter_once() {
        let fx = fixture();
        let id = Registry::load(&fx.data).unwrap().repos[0].id.clone();
        let docs = fx.main.join("docs");
        assert!(!docs.exists());

        let view = vault_create_docs_in(&fx.data, &id, "Start.md", "# Hi").unwrap();
        assert_eq!(view.id, format!("repo:{id}"));
        assert!(view.exists);
        assert_eq!(fs::read_to_string(docs.join("Start.md")).unwrap(), "# Hi");

        // A second call leaves what is there alone.
        fs::write(docs.join("Start.md"), "mine").unwrap();
        let view = vault_create_docs_in(&fx.data, &id, "Start.md", "# Hi").unwrap();
        assert!(view.exists);
        assert_eq!(fs::read_to_string(docs.join("Start.md")).unwrap(), "mine");

        let unknown = vault_create_docs_in(&fx.data, "nope", "Start.md", "x");
        assert_eq!(code(unknown), "repo_unknown");
        let bad = vault_create_docs_in(&fx.data, &id, "../x.md", "x");
        assert_eq!(code(bad), "bad_path");
    }

    #[test]
    fn adopt_through_lock_records_the_worktree_once() {
        let fx = fixture();
        let lock = WorkspaceLock::default();
        let out = fx.main.parent().unwrap().join("outside-wt");
        git(
            &fx.main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "outside",
                out.to_str().unwrap(),
            ],
        );
        let view = update(&fx.data, &lock, |reg| adopt_worktree(reg, &out, 9)).unwrap();
        assert_eq!(path_key(Path::new(&view.path)), path_key(&out));
        let again = update(&fx.data, &lock, |reg| adopt_worktree(reg, &out, 9));
        assert_eq!(code(again), "worktree_exists");
    }

    #[test]
    fn concurrent_pins_both_land() {
        let fx = fixture();
        let lock = WorkspaceLock::default();
        std::thread::scope(|s| {
            for path in [&fx.first, &fx.second] {
                let (data, lock) = (&fx.data, &lock);
                s.spawn(move || pin_with(data, lock, path, true).unwrap());
            }
        });
        let reg = Registry::load(&fx.data).unwrap();
        assert_eq!(reg.worktrees.len(), 2);
        assert!(reg.worktrees.iter().all(|m| m.pinned));
    }

    #[test]
    fn list_dir_serves_known_checkouts_only() {
        let fx = fixture();
        fs::create_dir(fx.first.join("src")).unwrap();
        fs::write(fx.first.join("src").join("m.rs"), "x").unwrap();
        let top = dir_listing(&fx.data, &fx.first, "").unwrap();
        assert_eq!(top.entries.iter().filter(|e| e.dir).count(), 1);
        assert!(top.entries.iter().any(|e| e.name == "a.txt" && !e.dir));
        assert!(top.entries.iter().all(|e| e.name != ".git"));
        let sub = dir_listing(&fx.data, &fx.first, "src").unwrap();
        assert_eq!(sub.entries.len(), 1);
        // The primary checkout is listed too.
        assert!(dir_listing(&fx.data, &fx.main, "").is_ok());
        assert_eq!(code(dir_listing(&fx.data, &fx.first, "../x")), "bad_path");
        let stranger = fx.first.parent().unwrap();
        assert_eq!(
            code(dir_listing(&fx.data, stranger, "")),
            "worktree_unknown"
        );
    }

    /// A data dir and a tracked repo at `<tmp>/xdev` with `archive` as its
    /// local archive script.
    fn archive_repo(archive: &str) -> (TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let repo = tmp.path().join("xdev");
        fs::create_dir_all(&repo).unwrap();
        let mut reg = Registry::load(&data).unwrap();
        reg.repos.push(xdev_workspace::RepoEntry {
            id: "abc".into(),
            short_name: "xdev".into(),
            path: repo.clone(),
            base_ref: "main".into(),
            worktree_root: tmp.path().join("wt"),
            local_archive: archive.into(),
            ..xdev_workspace::RepoEntry::default()
        });
        reg.save(&data).unwrap();
        // A plain `sh`, so no login profile runs; Windows' own default
        // PowerShell already runs with `-NoProfile`.
        if cfg!(unix) {
            use_shell(&data, "sh");
        }
        (tmp, data, repo)
    }

    /// Makes `id` the default shell in `data`; `sh` is added as a custom
    /// shell running `/bin/sh`.
    fn use_shell(data: &Path, id: &str) {
        let mut profiles = xdev_agent::Profiles::load(data).unwrap();
        if id == "sh" {
            profiles.shells.push(xdev_agent::CustomShell {
                id: "sh".into(),
                name: "sh".into(),
                program: "/bin/sh".into(),
                args: Vec::new(),
            });
        }
        profiles.default_shell = Some(id.into());
        profiles.save(data).unwrap();
    }

    #[test]
    fn archive_run_runs_the_script_and_keeps_its_output() {
        let (_tmp, data, repo) = archive_repo("echo hi");
        let run = archive_run(&data, &repo, ARCHIVE_TIMEOUT).unwrap();
        assert_eq!((run.ran, run.code), (true, Some(0)));
        assert_eq!(run.output, "hi");
    }

    #[cfg(windows)]
    #[test]
    fn archive_run_in_cmd_runs_a_script_of_several_lines() {
        // Joined into one line with ` & `, the block would not parse.
        let (_tmp, data, repo) = archive_repo("if 1==1 (\n  echo yes\n)\nexit /b 3\n");
        use_shell(&data, "cmd");
        let run = archive_run(&data, &repo, ARCHIVE_TIMEOUT).unwrap();
        assert_eq!(run.output, "yes");
        assert_eq!(run.code, Some(3));
    }

    #[test]
    fn archive_run_without_a_script_does_not_run() {
        let (_tmp, data, repo) = archive_repo("");
        let run = archive_run(&data, &repo, ARCHIVE_TIMEOUT).unwrap();
        assert_eq!((run.ran, run.code, run.output.as_str()), (false, None, ""));
    }

    #[test]
    fn archive_run_refuses_an_untrusted_shared_script() {
        let (_tmp, data, repo) = archive_repo("");
        fs::write(
            repo.join("xdev.toml"),
            "[scripts]\narchive = \"echo bye\"\n",
        )
        .unwrap();
        let err = archive_run(&data, &repo, ARCHIVE_TIMEOUT).unwrap_err();
        assert_eq!(err.code, "hook_untrusted");
    }

    #[test]
    fn run_headless_stops_a_script_past_its_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let (program, args) = if cfg!(windows) {
            (
                "powershell.exe",
                ["-NoProfile", "-Command", "Start-Sleep 30"],
            )
        } else {
            ("/bin/sh", ["-c", "sleep 30", "sh"])
        };
        let hook = HookCommand {
            program: program.into(),
            args: args.map(String::from).to_vec(),
            env: Vec::new(),
        };
        let run = run_headless(hook, dir.path(), Duration::from_millis(300)).unwrap();
        assert!(run.ran);
        assert_eq!(run.code, None);
        assert!(
            run.output.ends_with("(stopped after 0 s)"),
            "{}",
            run.output
        );
    }

    /// A shell line for the platform's own shell, without any profile.
    fn plain_hook(unix: &str, windows: &str) -> HookCommand {
        let (program, args) = if cfg!(windows) {
            (
                "powershell.exe",
                vec!["-NoProfile", "-NonInteractive", "-Command", windows],
            )
        } else {
            ("/bin/sh", vec!["-c", unix])
        };
        HookCommand {
            program: program.into(),
            args: args.into_iter().map(String::from).collect(),
            env: Vec::new(),
        }
    }

    #[test]
    fn run_headless_returns_while_a_background_child_holds_the_output() {
        let dir = tempfile::tempdir().unwrap();
        // The background child inherits stdout and outlives the shell.
        let hook = plain_hook(
            "sleep 20 & echo hi",
            "Start-Process -FilePath ping -ArgumentList '-n','20','127.0.0.1' -NoNewWindow; \
             [Console]::Out.WriteLine('hi')",
        );
        let started = Instant::now();
        let run = run_headless(hook, dir.path(), ARCHIVE_TIMEOUT).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(12),
            "waited {:?}",
            started.elapsed()
        );
        assert_eq!((run.ran, run.code), (true, Some(0)));
        assert!(run.output.contains("hi"), "{}", run.output);
    }

    fn alive(pid: u32) -> bool {
        if cfg!(windows) {
            let out = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
        } else {
            Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        }
    }

    #[test]
    fn run_headless_timeout_ends_the_whole_process_tree() {
        let dir = tempfile::tempdir().unwrap();
        // Prints the grandchild's pid as `pid=<n>`, then waits on it.
        let hook = plain_hook(
            "sleep 30 & echo pid=$!; wait",
            "$p = Start-Process -FilePath ping -ArgumentList '-n','30','127.0.0.1' \
             -NoNewWindow -PassThru; [Console]::Out.WriteLine(\"pid=$($p.Id)\"); \
             [Console]::Out.Flush(); $p.WaitForExit()",
        );
        let run = run_headless(hook, dir.path(), Duration::from_secs(5)).unwrap();
        assert_eq!(run.code, None, "{}", run.output);
        let grandchild: u32 = run
            .output
            .lines()
            .find_map(|l| l.trim().strip_prefix("pid=")?.parse().ok())
            .unwrap_or_else(|| panic!("no pid printed: {}", run.output));
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(grandchild) {
            assert!(
                Instant::now() < deadline,
                "grandchild {grandchild} survived"
            );
            thread::sleep(Duration::from_millis(100));
        }
    }

    /// A bare copy of the fixture's repo to clone from, by absolute path.
    fn bare(fx: &Fixture) -> PathBuf {
        let bare = fx.main.parent().unwrap().join("origin.git");
        git(
            fx.main.parent().unwrap(),
            &["clone", "-q", "--bare", "main", "origin.git"],
        );
        bare
    }

    struct Trashed(std::cell::RefCell<Vec<PathBuf>>);

    impl Trashed {
        fn new() -> Self {
            Trashed(std::cell::RefCell::new(Vec::new()))
        }
        fn seam(&self) -> impl Fn(&Path) -> io::Result<()> + '_ {
            |path: &Path| {
                self.0.borrow_mut().push(path.to_path_buf());
                Ok(())
            }
        }
    }

    fn clone_into(
        fx: &Fixture,
        url: &str,
        parent: &Path,
        name: Option<&str>,
        cancel: bool,
        trash: &dyn Fn(&Path) -> io::Result<()>,
    ) -> (Result<RepoView, CmdError>, Vec<CloneProgress>) {
        let mut events = Vec::new();
        let request = CloneRequest { url, parent, name };
        let result = clone_with(
            &fx.data,
            &WorkspaceLock::default(),
            &request,
            &AtomicBool::new(cancel),
            &mut |e| events.push(e),
            trash,
        );
        (result, events)
    }

    #[test]
    fn repo_clone_name_takes_the_last_part_of_the_url() {
        for url in [
            "https://example.com/team/xdev.git",
            "git@example.com:team/xdev.git",
            "ssh://git@example.com/team/xdev",
        ] {
            assert_eq!(repo_clone_name(url.into()).unwrap(), "xdev", "{url}");
        }
        assert_eq!(code(repo_clone_name("".into())), "bad_arg");
    }

    #[test]
    fn a_clone_is_added_to_the_workspace_and_sends_done() {
        let fx = fixture();
        let origin = bare(&fx);
        let parent = fx.main.parent().unwrap().join("clones");
        fs::create_dir(&parent).unwrap();
        let trashed = Trashed::new();
        let (result, events) = clone_into(
            &fx,
            origin.to_str().unwrap(),
            &parent,
            None,
            false,
            &trashed.seam(),
        );
        let repo = result.unwrap();
        let dest = parent.join("origin");
        assert!(dest.join("a.txt").is_file());
        assert_eq!(repo.short_name, "origin");
        let reg = Registry::load(&fx.data).unwrap();
        assert!(reg.repos.iter().any(|r| r.id == repo.id));
        assert_eq!(events.last(), Some(&CloneProgress::Done { repo }));
        assert!(trashed.0.borrow().is_empty());
    }

    #[test]
    fn a_clone_takes_the_given_folder_name() {
        let fx = fixture();
        let origin = bare(&fx);
        let parent = fx.main.parent().unwrap();
        let trashed = Trashed::new();
        let (result, _) = clone_into(
            &fx,
            origin.to_str().unwrap(),
            parent,
            Some(" copy "),
            false,
            &trashed.seam(),
        );
        result.unwrap();
        assert!(parent.join("copy").join("a.txt").is_file());
    }

    #[test]
    fn a_clone_refuses_bad_input_before_making_anything() {
        let fx = fixture();
        let origin = bare(&fx);
        let origin = origin.to_str().unwrap();
        let parent = fx.main.parent().unwrap();
        let trashed = Trashed::new();
        let seam = trashed.seam();
        let try_clone = |url: &str, parent: &Path, name: Option<&str>| {
            code(clone_into(&fx, url, parent, name, false, &seam).0)
        };
        assert_eq!(try_clone("-uevil", parent, Some("x")), "bad_arg");
        assert_eq!(try_clone("ext::sh -c x", parent, Some("x")), "bad_arg");
        assert_eq!(try_clone(origin, parent, Some("-x")), "bad_arg");
        assert_eq!(try_clone(origin, parent, Some("a/b")), "bad_arg");
        assert_eq!(try_clone(origin, parent, Some("..")), "bad_arg");
        assert_eq!(try_clone(origin, Path::new("rel"), Some("x")), "bad_arg");
        assert_eq!(try_clone(origin, parent, Some("main")), "exists");
        assert!(!parent.join("x").exists());
        assert!(fx.main.join("a.txt").is_file());
        assert!(trashed.0.borrow().is_empty());
        assert_eq!(Registry::load(&fx.data).unwrap().repos.len(), 1);
    }

    #[test]
    fn a_failed_clone_sends_its_folder_to_the_trash() {
        let fx = fixture();
        let parent = fx.main.parent().unwrap();
        let missing = parent.join("nothing.git");
        let trashed = Trashed::new();
        let (result, events) = clone_into(
            &fx,
            missing.to_str().unwrap(),
            parent,
            Some("broken"),
            false,
            &trashed.seam(),
        );
        assert!(result.is_err());
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, CloneProgress::Done { .. }))
        );
        assert_eq!(*trashed.0.borrow(), vec![parent.join("broken")]);
        assert_eq!(Registry::load(&fx.data).unwrap().repos.len(), 1);
    }

    #[test]
    fn a_cancelled_clone_is_trashed_and_says_cancelled() {
        let fx = fixture();
        let origin = bare(&fx);
        let parent = fx.main.parent().unwrap();
        let trashed = Trashed::new();
        let (result, _) = clone_into(
            &fx,
            origin.to_str().unwrap(),
            parent,
            Some("stopped"),
            true,
            &trashed.seam(),
        );
        assert_eq!(code(result), "cancelled");
        assert_eq!(*trashed.0.borrow(), vec![parent.join("stopped")]);
    }

    #[test]
    fn a_trash_failure_names_the_folder_left_behind() {
        let fx = fixture();
        let parent = fx.main.parent().unwrap();
        let missing = parent.join("nothing.git");
        let refuse = |_: &Path| Err(io::Error::other("no trash"));
        let (result, _) = clone_into(
            &fx,
            missing.to_str().unwrap(),
            parent,
            Some("kept"),
            false,
            &refuse,
        );
        let detail = result.unwrap_err().detail.unwrap();
        assert!(detail.contains("the folder was left at"), "{detail}");
        assert!(detail.contains("kept"), "{detail}");
        assert!(detail.contains("no trash"), "{detail}");
    }

    #[test]
    fn clones_refuse_a_second_run_with_the_same_id_and_cancel_by_id() {
        let clones = Clones::default();
        let run = clones.begin("a").unwrap();
        assert_eq!(code(clones.begin("a").map(drop)), "busy");
        let other = clones.begin("b").unwrap();
        clones.cancel("a");
        clones.cancel("gone");
        assert!(run.cancel.load(Ordering::Relaxed));
        assert!(!other.cancel.load(Ordering::Relaxed));
        drop(run);
        clones.begin("a").unwrap();
    }

    #[test]
    fn repo_forget_drops_the_repo_and_its_worktrees_but_keeps_the_folders() {
        let fx = fixture();
        let lock = WorkspaceLock::default();
        let id = Registry::load(&fx.data).unwrap().repos[0].id.clone();
        // The body of `repo_forget`, without the Tauri state.
        update(&fx.data, &lock, |reg| forget_repo(reg, &id)).unwrap();
        let reg = Registry::load(&fx.data).unwrap();
        assert!(reg.repos.is_empty());
        assert!(reg.worktrees.is_empty());
        for dir in [&fx.main, &fx.first, &fx.second] {
            assert!(dir.join("a.txt").is_file(), "{}", dir.display());
        }
        assert!(git(&fx.main, &["worktree", "list"]).lines().count() >= 3);
        assert_eq!(
            code(update(&fx.data, &lock, |reg| forget_repo(reg, &id))),
            "repo_unknown"
        );
    }
}
