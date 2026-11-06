//! How much disk the worktrees use, and removing their heavy build folders.
//!
//! Sizes are read without following links, and the main checkout's `.git`
//! is not counted. Only a folder with a heavy name, inside a known
//! worktree, is ever removed.

use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::WorkspaceError;

/// Folder names that hold what a build or an install makes again.
pub const HEAVY: [&str; 5] = ["node_modules", "target", "dist", ".next", "build"];

/// One heavy folder and the bytes in it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HeavyDir {
    pub path: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub size: u64,
}

/// A worktree's size and its heavy folders, the biggest first.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorktreeUsage {
    pub worktree: String,
    /// Everything in the worktree, heavy folders included.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub total: u64,
    pub heavy: Vec<HeavyDir>,
}

fn is_heavy(name: &OsStr) -> bool {
    HEAVY.iter().any(|h| name == *h)
}

/// Whether `name` inside `parent` is a build output, not a source folder that
/// happens to share the name: `node_modules` anywhere, `target` next to a
/// `Cargo.toml`, `dist`, `.next` and `build` next to a `package.json`.
fn is_heavy_in(parent: &Path, name: &OsStr) -> bool {
    if !is_heavy(name) {
        return false;
    }
    match name.to_str() {
        Some("node_modules") => true,
        Some("target") => parent.join("Cargo.toml").is_file(),
        _ => parent.join("package.json").is_file(),
    }
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), WorkspaceError> {
    if cancel.load(Ordering::Relaxed) {
        Err(WorkspaceError::Cancelled)
    } else {
        Ok(())
    }
}

/// Bytes under `dir`, links not followed, `skip` folders left out.
fn dir_size(dir: &Path, skip: &[PathBuf], cancel: &AtomicBool) -> Result<u64, WorkspaceError> {
    let mut total = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(0);
    };
    for entry in entries.flatten() {
        check_cancel(cancel)?;
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            if !skip.contains(&path) {
                total += dir_size(&path, skip, cancel)?;
            }
        } else {
            total += meta.len();
        }
    }
    Ok(total)
}

/// Walks a worktree: its total, with the heavy folders found collected and not looked into.
fn walk(
    dir: &Path,
    top: bool,
    others: &[PathBuf],
    cancel: &AtomicBool,
    heavy: &mut Vec<HeavyDir>,
) -> Result<u64, WorkspaceError> {
    let mut total = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(0);
    };
    for entry in entries.flatten() {
        check_cancel(cancel)?;
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if !meta.is_dir() {
            total += meta.len();
            continue;
        }
        // The main checkout's repository data is not the worktree's to clean.
        if top && entry.file_name() == ".git" {
            continue;
        }
        // A nested worktree has its own row.
        if others.contains(&path) {
            continue;
        }
        if is_heavy_in(dir, &entry.file_name()) {
            let size = dir_size(&path, others, cancel)?;
            total += size;
            heavy.push(HeavyDir {
                path: path.to_string_lossy().into_owned(),
                size,
            });
        } else {
            total += walk(&path, false, others, cancel, heavy)?;
        }
    }
    Ok(total)
}

/// The usage of each worktree, the biggest first. `Cancelled` when `cancel` is set while it runs.
pub fn disk_usage(
    worktrees: &[PathBuf],
    cancel: &AtomicBool,
) -> Result<Vec<WorktreeUsage>, WorkspaceError> {
    let mut rows = Vec::new();
    for wt in worktrees {
        check_cancel(cancel)?;
        let others: Vec<PathBuf> = worktrees.iter().filter(|o| *o != wt).cloned().collect();
        let mut heavy = Vec::new();
        let total = walk(wt, true, &others, cancel, &mut heavy)?;
        heavy.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
        rows.push(WorktreeUsage {
            worktree: wt.to_string_lossy().into_owned(),
            total,
            heavy,
        });
    }
    rows.sort_by(|a, b| {
        b.total
            .cmp(&a.total)
            .then_with(|| a.worktree.cmp(&b.worktree))
    });
    Ok(rows)
}

/// `BadPath` unless `target` is a heavy-named folder inside a known worktree, reached
/// through real folders only (a link could lead outside).
fn checked(worktrees: &[PathBuf], target: &Path) -> Result<(), WorkspaceError> {
    let bad = || WorkspaceError::BadPath(target.display().to_string());
    if target
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(bad());
    }
    let name = target.file_name().ok_or_else(bad)?;
    let parent = target.parent().ok_or_else(bad)?;
    if !is_heavy_in(parent, name) {
        return Err(bad());
    }
    let wt = worktrees
        .iter()
        .find(|w| target.starts_with(w) && target != w.as_path())
        .ok_or_else(bad)?;
    let rel = target.strip_prefix(wt).map_err(|_| bad())?;
    if rel.components().any(|c| c.as_os_str() == ".git") {
        return Err(bad());
    }
    let mut walked = wt.clone();
    for part in rel.components() {
        walked.push(part);
        let meta = fs::symlink_metadata(&walked).map_err(|_| bad())?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(bad());
        }
    }
    Ok(())
}

/// Removes each of `targets`; all must pass the check before any goes.
/// Returns the bytes freed.
pub fn remove_heavy(worktrees: &[PathBuf], targets: &[PathBuf]) -> Result<u64, WorkspaceError> {
    for t in targets {
        checked(worktrees, t)?;
    }
    let never = AtomicBool::new(false);
    let mut freed = 0u64;
    for t in targets {
        freed += dir_size(t, &[], &never)?;
        fs::remove_dir_all(t)?;
    }
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![b'x'; bytes]).unwrap();
    }

    fn no_cancel() -> AtomicBool {
        AtomicBool::new(false)
    }

    #[test]
    fn sums_a_worktree_and_lists_its_heavy_folders_biggest_first() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        write(&wt.join("src/a.ts"), 10);
        write(&wt.join("node_modules/p/x.js"), 300);
        write(&wt.join("packages/web/package.json"), 0);
        write(&wt.join("packages/web/dist/o.js"), 50);
        write(&wt.join("packages/web/node_modules/q.js"), 500);
        let rows = disk_usage(std::slice::from_ref(&wt), &no_cancel()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].total, 860);
        let sizes: Vec<u64> = rows[0].heavy.iter().map(|h| h.size).collect();
        assert_eq!(sizes, [500, 300, 50]);
    }

    #[test]
    fn skips_the_top_level_git_but_not_a_nested_one() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        write(&wt.join(".git/objects/pack"), 1000);
        write(&wt.join("lib/.git/x"), 7);
        write(&wt.join("a.txt"), 5);
        let rows = disk_usage(&[wt], &no_cancel()).unwrap();
        assert_eq!(rows[0].total, 12);
    }

    #[test]
    fn rows_are_sorted_by_size_and_a_nested_worktree_is_counted_once() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big");
        let small = dir.path().join("small");
        let inner = big.join("inner");
        write(&big.join("a"), 100);
        write(&inner.join("b"), 400);
        write(&small.join("c"), 50);
        let rows = disk_usage(&[small.clone(), big.clone(), inner.clone()], &no_cancel()).unwrap();
        let totals: Vec<(String, u64)> =
            rows.iter().map(|r| (r.worktree.clone(), r.total)).collect();
        assert_eq!(
            totals,
            [
                (inner.to_string_lossy().into_owned(), 400),
                (big.to_string_lossy().into_owned(), 100),
                (small.to_string_lossy().into_owned(), 50),
            ]
        );
    }

    #[test]
    fn a_cancelled_scan_says_so() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("wt/a"), 1);
        let flag = AtomicBool::new(true);
        let err = disk_usage(&[dir.path().join("wt")], &flag).unwrap_err();
        assert_eq!(err.code(), "cancelled");
    }

    #[cfg(unix)]
    #[test]
    fn links_are_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        write(&dir.path().join("outside/big"), 5000);
        write(&wt.join("a"), 3);
        std::os::unix::fs::symlink(dir.path().join("outside"), wt.join("node_modules")).unwrap();
        let rows = disk_usage(&[wt.clone()], &no_cancel()).unwrap();
        assert_eq!(rows[0].total, 3);
        assert!(rows[0].heavy.is_empty());
        let err = remove_heavy(&[wt.clone()], &[wt.join("node_modules")]).unwrap_err();
        assert_eq!(err.code(), "bad_path");
        assert!(dir.path().join("outside/big").exists());
    }

    #[test]
    fn removes_only_the_listed_heavy_folders() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        write(&wt.join("src/a.ts"), 1);
        write(&wt.join("node_modules/p/x.js"), 20);
        write(&wt.join("target/debug/y"), 30);
        let freed = remove_heavy(std::slice::from_ref(&wt), &[wt.join("node_modules")]).unwrap();
        assert_eq!(freed, 20);
        assert!(!wt.join("node_modules").exists());
        assert!(wt.join("target/debug/y").exists());
        assert!(wt.join("src/a.ts").exists());
    }

    #[test]
    fn refuses_anything_that_is_not_a_heavy_folder_in_a_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        write(&wt.join("src/a.ts"), 1);
        write(&wt.join(".git/node_modules/z"), 1);
        write(&dir.path().join("other/node_modules/z"), 1);
        write(&dir.path().join("wt-sibling/node_modules/z"), 1);
        let wts = std::slice::from_ref(&wt);
        for bad in [
            wt.join("src"),
            wt.clone(),
            wt.join(".git/node_modules"),
            wt.join("src/../src/node_modules"),
            dir.path().join("other/node_modules"),
            dir.path().join("wt-sibling/node_modules"),
            wt.join("missing/node_modules"),
        ] {
            let err = remove_heavy(wts, std::slice::from_ref(&bad)).unwrap_err();
            assert_eq!(err.code(), "bad_path", "{}", bad.display());
        }
        assert!(dir.path().join("other/node_modules/z").exists());
        assert!(wt.join("src/a.ts").exists());
    }

    #[test]
    fn a_source_folder_named_like_a_build_output_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        write(&wt.join("scripts/build/run.sh"), 40);
        write(&wt.join("docs/target/page.md"), 30);
        write(&wt.join("crate/Cargo.toml"), 0);
        write(&wt.join("crate/target/debug/x"), 20);
        let rows = disk_usage(std::slice::from_ref(&wt), &no_cancel()).unwrap();
        let heavy: Vec<String> = rows[0].heavy.iter().map(|h| h.path.clone()).collect();
        assert_eq!(
            heavy,
            [wt.join("crate")
                .join("target")
                .to_string_lossy()
                .into_owned()]
        );
        for bad in [wt.join("scripts/build"), wt.join("docs/target")] {
            let err =
                remove_heavy(std::slice::from_ref(&wt), std::slice::from_ref(&bad)).unwrap_err();
            assert_eq!(err.code(), "bad_path", "{}", bad.display());
        }
        assert!(wt.join("scripts/build/run.sh").exists());
    }

    #[test]
    fn one_bad_path_removes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().join("wt");
        write(&wt.join("node_modules/a"), 1);
        write(&wt.join("src/b"), 1);
        let result = remove_heavy(
            std::slice::from_ref(&wt),
            &[wt.join("node_modules"), wt.join("src")],
        );
        assert!(result.is_err());
        assert!(wt.join("node_modules/a").exists());
    }
}
