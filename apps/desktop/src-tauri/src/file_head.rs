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

/// Most bytes of an image's old side the viewer reads.
pub(crate) const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

fn code_err(code: &'static str) -> CmdError {
    CmdError { code, detail: None }
}

/// What the size of the old blob allows: no blob is `not_found`, one over the limit `too_large`.
fn within_limit(size: Option<u64>, max: u64) -> Result<(), CmdError> {
    match size {
        None => Err(code_err("not_found")),
        Some(n) if n > max => Err(code_err("too_large")),
        Some(_) => Ok(()),
    }
}

/// The bytes of `file` at the commit `at` (HEAD when `None`), at most `MAX_IMAGE_BYTES`.
/// Sized before it is read, so a large blob is never loaded.
fn head_bytes(data: &Path, path: &Path, file: &str, at: Option<&str>) -> Result<Vec<u8>, CmdError> {
    known_checkout(data, path)?;
    let disk = inside(path, file).ok_or_else(|| bad_arg(file))?;
    if !parent_within(path, &disk)? {
        return Err(bad_arg(file));
    }
    let repo = Repo::discover(path)?;
    let rev = match at {
        Some(id) if id.len() >= 4 && id.bytes().all(|b| b.is_ascii_hexdigit()) => {
            id.to_ascii_lowercase()
        }
        Some(other) => return Err(bad_arg(other)),
        None => repo.head_id()?.ok_or_else(|| code_err("not_found"))?,
    };
    within_limit(repo.blob_size(&rev, file)?, MAX_IMAGE_BYTES)?;
    repo.show(&rev, file)?.ok_or_else(|| code_err("not_found"))
}

/// The old side of an image: the bytes of `file` at `base` (a commit id) or at HEAD.
/// Rejects with `not_found` when the file is not there and `too_large` over 20 MB.
#[tauri::command(async)]
pub fn worktree_file_head_bytes(
    state: State<'_, AppState>,
    path: std::path::PathBuf,
    file: String,
    base: Option<String>,
) -> Result<tauri::ipc::Response, CmdError> {
    let bytes = head_bytes(data_dir(&state)?, &path, &file, base.as_deref())?;
    Ok(tauri::ipc::Response::new(
        tauri::ipc::InvokeResponseBody::Raw(bytes),
    ))
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

    #[test]
    fn the_size_limit_of_the_old_side() {
        let code = |r: Result<(), CmdError>| r.unwrap_err().code;
        assert_eq!(code(within_limit(None, 10)), "not_found");
        assert_eq!(code(within_limit(Some(11), 10)), "too_large");
        assert!(within_limit(Some(10), 10).is_ok());
        assert_eq!(MAX_IMAGE_BYTES, 20 * 1024 * 1024);
    }

    #[test]
    fn head_bytes_reads_the_committed_side() {
        let fx = fixture(true);
        fs::write(fx.repo.join("a.txt"), "two").unwrap();
        assert_eq!(
            head_bytes(&fx.data, &fx.repo, "a.txt", None).unwrap(),
            b"one"
        );
        // Binary content is returned as it is.
        assert_eq!(
            head_bytes(&fx.data, &fx.repo, "bin.dat", None).unwrap(),
            b"ab\0cd"
        );
        let head = Repo::discover(&fx.repo)
            .unwrap()
            .head_id()
            .unwrap()
            .unwrap();
        assert_eq!(
            head_bytes(&fx.data, &fx.repo, "a.txt", Some(&head)).unwrap(),
            b"one"
        );
    }

    #[test]
    fn head_bytes_says_not_found_and_refuses_odd_names() {
        let fx = fixture(true);
        fs::write(fx.repo.join("new.png"), "x").unwrap();
        let code = |r: Result<Vec<u8>, CmdError>| r.unwrap_err().code;
        assert_eq!(
            code(head_bytes(&fx.data, &fx.repo, "new.png", None)),
            "not_found"
        );
        assert_eq!(
            code(head_bytes(&fx.data, &fx.repo, "../x", None)),
            "bad_arg"
        );
        assert_eq!(
            code(head_bytes(&fx.data, &fx.repo, "a.txt", Some("main"))),
            "bad_arg"
        );
        let unborn = fixture(false);
        assert_eq!(
            code(head_bytes(&unborn.data, &unborn.repo, "a.txt", None)),
            "not_found"
        );
    }
}
