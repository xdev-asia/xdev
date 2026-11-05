//! A file at HEAD and on disk, for the editor's change markers.
//!
//! `worktree_file_diff` compares with the worktree's start commit; the editor
//! marks changes against HEAD, so it asks here.

use std::fs;
use std::io;
use std::path::Path;

use tauri::State;
use xdev_git::Repo;

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::workspace::{
    MAX_BYTES, Skip, WorktreeFileDiff, bad_arg, file_diff_at, inside, is_binary, known_checkout,
    parent_within, skipped,
};

/// `file` at HEAD and on disk now. Before the first commit there is no old side.
fn head_diff(data: &Path, path: &Path, file: &str) -> Result<WorktreeFileDiff, CmdError> {
    known_checkout(data, path)?;
    let disk = inside(path, file).ok_or_else(|| bad_arg(file))?;
    if !parent_within(path, &disk)? {
        return Err(bad_arg(file));
    }
    match Repo::discover(path)?.head_id()? {
        Some(head) => file_diff_at(path, file, &head),
        None => unborn(&disk),
    }
}

/// The disk side alone, read under the same limits as `file_diff_at`.
fn unborn(disk: &Path) -> Result<WorktreeFileDiff, CmdError> {
    let bytes = match fs::symlink_metadata(disk) {
        Ok(meta) if meta.is_symlink() => return Ok(skipped(Skip::Binary)),
        Ok(meta) if meta.is_file() => {
            if meta.len() > MAX_BYTES {
                return Ok(skipped(Skip::TooLarge));
            }
            Some(fs::read(disk)?)
        }
        Ok(_) => None,
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if bytes.as_deref().is_some_and(is_binary) {
        return Ok(skipped(Skip::Binary));
    }
    Ok(WorktreeFileDiff {
        old: None,
        new: bytes.and_then(|b| String::from_utf8(b).ok()),
        skip: None,
    })
}

#[tauri::command(async)]
pub fn worktree_file_head(
    state: State<'_, AppState>,
    path: std::path::PathBuf,
    file: String,
) -> Result<WorktreeFileDiff, CmdError> {
    head_diff(data_dir(&state)?, &path, &file)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::process::Command;

    use tempfile::TempDir;
    use xdev_workspace::{Registry, add_repo};

    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    struct Fixture {
        _tmp: TempDir,
        repo: PathBuf,
        data: PathBuf,
    }

    /// A registered repo; with a first commit when `commit` is set.
    fn fixture(commit: bool) -> Fixture {
        let tmp = crate::test_dirs::long_temp_dir("file head ");
        let repo = tmp.path().join("repo");
        let data = tmp.path().join("data");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&repo, &["config", key, value]);
        }
        if commit {
            fs::write(repo.join("a.txt"), "one").unwrap();
            fs::write(repo.join("bin.dat"), b"ab\0cd").unwrap();
            git(&repo, &["add", "-A"]);
            git(&repo, &["commit", "-q", "-m", "one"]);
        }
        let mut reg = Registry::load(&data).unwrap();
        add_repo(&mut reg, &repo, 0).unwrap();
        reg.save(&data).unwrap();
        Fixture {
            _tmp: tmp,
            repo,
            data,
        }
    }

    #[test]
    fn head_text_of_a_tracked_file() {
        let fx = fixture(true);
        fs::write(fx.repo.join("a.txt"), "two").unwrap();
        let d = head_diff(&fx.data, &fx.repo, "a.txt").unwrap();
        assert_eq!(d.old.as_deref(), Some("one"));
        assert_eq!(d.new.as_deref(), Some("two"));
        assert!(d.skip.is_none());
    }

    #[test]
    fn an_untracked_file_has_no_old() {
        let fx = fixture(true);
        fs::write(fx.repo.join("new.txt"), "fresh").unwrap();
        let d = head_diff(&fx.data, &fx.repo, "new.txt").unwrap();
        assert_eq!((d.old, d.new.as_deref()), (None, Some("fresh")));
    }

    #[test]
    fn an_unborn_head_has_no_old() {
        let fx = fixture(false);
        fs::write(fx.repo.join("a.txt"), "first").unwrap();
        let d = head_diff(&fx.data, &fx.repo, "a.txt").unwrap();
        assert_eq!(
            (d.old, d.new.as_deref(), d.skip),
            (None, Some("first"), None)
        );
    }

    #[test]
    fn an_unknown_folder_is_refused() {
        let fx = fixture(true);
        let other = fx._tmp.path().join("other");
        fs::create_dir(&other).unwrap();
        let err = head_diff(&fx.data, &other, "a.txt").unwrap_err();
        assert_eq!(err.code, "worktree_unknown");
        let err = head_diff(&fx.data, &fx.repo, "../a.txt").unwrap_err();
        assert_eq!(err.code, "bad_arg");
    }

    #[test]
    fn a_binary_file_is_skipped() {
        let fx = fixture(true);
        let d = head_diff(&fx.data, &fx.repo, "bin.dat").unwrap();
        assert_eq!(d.skip, Some(Skip::Binary));
        assert_eq!((d.old, d.new), (None, None));
    }
}
