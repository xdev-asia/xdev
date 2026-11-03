//! The Workspace view's commands: the repos the app tracks, the worktrees
//! made from them, and what changed in each. Everything that saves the
//! registry holds `WorkspaceLock` from load to save, so two commands never
//! write over each other.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;
use xdev_git::{ChangeKind, GitError, Repo};
use xdev_policy::{Action, Gate, Verdict};
use xdev_workspace::{
    Registry, RepoView, WorkspaceError, WorktreeView, add_repo, create_worktree, forget_repo, list,
    remove_worktree, set_pinned,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
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

fn bad_arg(detail: &str) -> CmdError {
    CmdError {
        code: "bad_arg",
        detail: Some(detail.to_owned()),
    }
}

/// `root` joined with `file`, when `file` is a plain relative path that
/// stays under `root`.
fn inside(root: &Path, file: &str) -> Option<PathBuf> {
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
fn parent_within(root: &Path, disk: &Path) -> Result<bool, CmdError> {
    let Some(parent) = disk.parent() else {
        return Ok(false);
    };
    match fs::canonicalize(parent) {
        Ok(parent) => Ok(parent.starts_with(fs::canonicalize(root)?)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e.into()),
    }
}

/// Registry paths and the UI's agree in this form, as in the workspace crate.
fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.trim_end_matches('/');
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.to_owned()
    }
}

fn lock_guard(lock: &WorkspaceLock) -> std::sync::MutexGuard<'_, ()> {
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
fn clock() -> (i64, u64) {
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
) -> Result<(), CmdError> {
    match gate(data)?.check(&Action::Delete {
        path: path.to_owned(),
    }) {
        Verdict::Allow => {}
        Verdict::Ask { .. } if confirmed => {}
        Verdict::Ask { reason } => {
            return Err(CmdError {
                code: "needs_approval",
                detail: Some(reason),
            });
        }
        Verdict::Deny { reason } => {
            return Err(CmdError {
                code: "denied",
                detail: Some(reason),
            });
        }
    }
    update(data, lock, |reg| remove_worktree(reg, path, force))
}

/// The commit a linked worktree started from. The primary checkout has no
/// record, so it is as unknown as a folder the app never made.
fn start_of(data: &Path, path: &Path) -> Result<String, CmdError> {
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
    let disk = inside(path, file).ok_or_else(|| bad_arg(file))?;
    if !parent_within(path, &disk)? {
        return Err(bad_arg(file));
    }
    let start = start_of(data, path)?;
    let old = Repo::discover(path)?.show(&start, file)?;
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
    if old.as_ref().is_some_and(|b| b.len() as u64 > MAX_BYTES) {
        return Ok(skipped(Skip::TooLarge));
    }
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

#[tauri::command(async)]
pub fn worktree_create(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    repo_id: String,
    name: String,
    from: Option<String>,
) -> Result<WorktreeView, CmdError> {
    let (now_ms, seed) = clock();
    update(data_dir(&state)?, &lock, |reg| {
        create_worktree(reg, &repo_id, &name, from.as_deref(), now_ms, seed)
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
) -> Result<(), CmdError> {
    remove_with(data_dir(&state)?, &lock, &path, force, confirmed)
}

#[tauri::command(async)]
pub fn worktree_changes(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<Vec<WorktreeChange>, CmdError> {
    changes(data_dir(&state)?, &path)
}

#[tauri::command(async)]
pub fn worktree_file_diff(
    state: State<'_, AppState>,
    path: PathBuf,
    file: String,
) -> Result<WorktreeFileDiff, CmdError> {
    file_diff(data_dir(&state)?, &path, &file)
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
    use xdev_workspace::{Registry, add_repo, create_worktree};

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
        let tmp = TempDir::with_prefix("ws cmd ").unwrap();
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
    fn worktree_remove_asks_then_runs_when_confirmed() {
        let fx = fixture();
        let lock = WorkspaceLock::default();
        let asked = remove_with(&fx.data, &lock, &fx.first, false, false);
        assert_eq!(code(asked), "needs_approval");
        assert!(fx.first.exists());

        remove_with(&fx.data, &lock, &fx.first, false, true).unwrap();
        assert!(!fx.first.exists());
        let audit = fs::read_to_string(fx.data.join("audit.jsonl")).unwrap();
        assert_eq!(audit.lines().count(), 2);
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
}
