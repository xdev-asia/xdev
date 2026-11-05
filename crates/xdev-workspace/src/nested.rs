//! Finding repos inside a folder: the walk behind "Scan for repositories".

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// How many folders below the root the walk goes; the root is depth 0.
pub const NESTED_SCAN_DEPTH: usize = 4;

/// Folders that never hold a project of their own.
const SKIPPED: [&str; 3] = ["node_modules", "target", ".git"];

/// What a scan saw: the repos in the order met, and whether `cancel` cut it short.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct NestedScan {
    pub repos: Vec<PathBuf>,
    pub cancelled: bool,
}

/// The folders under `root` (and `root` itself) that hold a `.git` folder or file, down to
/// `NESTED_SCAN_DEPTH`. A repo is not entered, so what lives inside it is not listed. Symlinks are not
/// followed and `node_modules`, `target` and `.git` are not entered. `cancel` is read before each
/// folder; a scan that sees it set returns what it has with `cancelled` on. A folder that cannot be
/// read is passed over.
pub fn scan_nested_repos(root: &Path, cancel: &AtomicBool) -> NestedScan {
    let mut scan = NestedScan::default();
    walk(root, 0, cancel, &mut scan);
    scan
}

fn walk(dir: &Path, depth: usize, cancel: &AtomicBool, scan: &mut NestedScan) {
    if scan.cancelled || cancel.load(Ordering::Relaxed) {
        scan.cancelled = true;
        return;
    }
    if fs::symlink_metadata(dir.join(".git")).is_ok() {
        scan.repos.push(dir.to_path_buf());
        return;
    }
    if depth >= NESTED_SCAN_DEPTH {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut children: Vec<PathBuf> = read
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| !SKIPPED.iter().any(|s| e.file_name() == *s))
        .map(|e| e.path())
        .collect();
    children.sort();
    for child in children {
        walk(&child, depth + 1, cancel, scan);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(root: &Path, rel: &str) {
        fs::create_dir_all(root.join(rel).join(".git")).unwrap();
    }

    fn names(root: &Path, scan: &NestedScan) -> Vec<String> {
        scan.repos
            .iter()
            .map(|p| {
                p.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect()
    }

    #[test]
    fn finds_repos_and_gitfile_worktrees_without_entering_them() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repo(root, "a");
        repo(root, "group/b");
        repo(root, "a/inner");
        fs::create_dir_all(root.join("group/wt")).unwrap();
        fs::write(root.join("group/wt/.git"), "gitdir: ../b/.git/worktrees/wt").unwrap();
        let scan = scan_nested_repos(root, &AtomicBool::new(false));
        assert!(!scan.cancelled);
        assert_eq!(names(root, &scan), ["a", "group/b", "group/wt"]);
    }

    #[test]
    fn the_root_can_be_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        repo(dir.path(), "");
        repo(dir.path(), "child");
        let scan = scan_nested_repos(dir.path(), &AtomicBool::new(false));
        assert_eq!(scan.repos, [dir.path().to_path_buf()]);
    }

    #[test]
    fn stops_at_the_depth_limit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repo(root, "1/2/3/4");
        repo(root, "1/2/3/4/5");
        repo(root, "x/2/3/4/5");
        let scan = scan_nested_repos(root, &AtomicBool::new(false));
        assert_eq!(names(root, &scan), ["1/2/3/4"]);
    }

    #[test]
    fn skips_dependency_and_build_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        repo(root, "node_modules/pkg");
        repo(root, "target/debug/x");
        repo(root, "ok");
        let scan = scan_nested_repos(root, &AtomicBool::new(false));
        assert_eq!(names(root, &scan), ["ok"]);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let outside = tempfile::tempdir().unwrap();
        repo(outside.path(), "far");
        std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
        repo(root, "near");
        let scan = scan_nested_repos(root, &AtomicBool::new(false));
        assert_eq!(names(root, &scan), ["near"]);
    }

    #[test]
    fn a_set_cancel_flag_stops_the_walk() {
        let dir = tempfile::tempdir().unwrap();
        repo(dir.path(), "a");
        let scan = scan_nested_repos(dir.path(), &AtomicBool::new(true));
        assert!(scan.cancelled);
        assert!(scan.repos.is_empty());
    }

    #[test]
    fn a_missing_root_finds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let scan = scan_nested_repos(&dir.path().join("gone"), &AtomicBool::new(false));
        assert_eq!(scan, NestedScan::default());
    }
}
