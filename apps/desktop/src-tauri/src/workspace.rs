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
use xdev_policy::{Action, Verdict};
use xdev_workspace::{
    Registry, RepoPatch, RepoView, VaultView, WorkspaceError, WorktreeStat, WorktreeView, add_repo,
    add_vault, adopt_worktree, create_worktree, forget_repo, forget_vault, list, list_vaults,
    path_key, remove_worktree, repo_docs_dir, set_pinned, stat, update_repo,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError, create_vault_at};
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
    let action = Action::Delete {
        path: path.to_owned(),
    };
    match gate(data)?.check_confirmed(&action, confirmed) {
        Verdict::Allow => {}
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
    let disk = inside(path, file).ok_or_else(|| bad_arg(file))?;
    if !parent_within(path, &disk)? {
        return Err(bad_arg(file));
    }
    let start = start_of(data, path)?;
    let repo = Repo::discover(path)?;
    // Sized before it is read, so a large old file never sits in memory.
    let old_size = repo.blob_size(&start, file)?;
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
        Some(_) => repo.show(&start, file)?,
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

#[tauri::command(async)]
pub fn repo_update(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    id: String,
    short_name: Option<String>,
    base_ref: Option<String>,
    worktree_root: Option<PathBuf>,
) -> Result<RepoView, CmdError> {
    let patch = RepoPatch {
        short_name,
        base_ref,
        worktree_root,
    };
    update(data_dir(&state)?, &lock, |reg| update_repo(reg, &id, patch))
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
    let key = path_key(path);
    let reg = Registry::load(data)?;
    let known = reg.repos.iter().any(|r| path_key(&r.path) == key)
        || reg.worktrees.iter().any(|m| path_key(&m.path) == key);
    if !known {
        return Err(WorkspaceError::WorktreeUnknown(path.to_owned()).into());
    }
    Ok(xdev_workspace::list_dir(&path.to_string_lossy(), dir)?)
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
}
