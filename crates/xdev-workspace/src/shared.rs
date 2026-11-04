//! `[worktree] shared` of `xdev.toml`: paths of the main checkout linked into
//! each new worktree, so they share dependency folders and local files.

use std::fs;
use std::io;
use std::path::Path;

use serde::Serialize;

use crate::WorkspaceError;

/// What linking one shared path did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Linked {
    /// The entry, as `xdev.toml` spells it after normalizing.
    pub path: String,
    pub ok: bool,
    /// Why it was not linked; `None` when `ok`.
    pub error: Option<String>,
}

/// Why a shared path is refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SharedError {
    #[error("the path is empty")]
    Empty,
    #[error("the path must be relative to the repo")]
    Absolute,
    #[error("the path has an empty segment")]
    EmptySegment,
    #[error("`.` and `..` are not allowed")]
    Dots,
    #[error(".git cannot be shared")]
    Git,
}

/// The repo-relative path an entry names, spelled with `/`. A backslash
/// counts as a separator; a trailing separator is dropped.
pub fn validate(entry: &str) -> Result<String, SharedError> {
    let text = entry.trim().replace('\\', "/");
    let text = text.strip_suffix('/').unwrap_or(&text);
    if text.is_empty() {
        return Err(SharedError::Empty);
    }
    let bytes = text.as_bytes();
    if text.starts_with('/')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    {
        return Err(SharedError::Absolute);
    }
    for segment in text.split('/') {
        match segment {
            "" => return Err(SharedError::EmptySegment),
            "." | ".." => return Err(SharedError::Dots),
            s if s.eq_ignore_ascii_case(".git") => return Err(SharedError::Git),
            _ => {}
        }
    }
    Ok(text.to_owned())
}

/// Links each `shared` path of `main` into `worktree`: a junction for a
/// folder on Windows, a hard link for a file (a file symlink needs developer
/// mode there), a symlink elsewhere. A path missing in `main`, or already in
/// `worktree` (git put a tracked file there), is left alone and reported not
/// ok, as is one that fails; the others still link.
pub fn link_shared(main: &Path, worktree: &Path, shared: &[String]) -> Vec<Linked> {
    shared
        .iter()
        .map(|path| {
            let result = link_one(main, worktree, path);
            Linked {
                path: path.clone(),
                ok: result.is_ok(),
                error: result.err(),
            }
        })
        .collect()
}

fn link_one(main: &Path, worktree: &Path, path: &str) -> Result<(), String> {
    let from = main.join(path);
    let to = worktree.join(path);
    let meta = match fs::symlink_metadata(&from) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err("missing in the main checkout".into());
        }
        Err(e) => return Err(e.to_string()),
    };
    if fs::symlink_metadata(&to).is_ok() {
        return Err("already exists in the worktree".into());
    }
    // A parent that is itself a link would put the new link in the main
    // checkout.
    let mut parent = worktree.to_owned();
    let mut segments: Vec<&str> = path.split('/').collect();
    segments.pop();
    for segment in segments {
        parent.push(segment);
        match fs::symlink_metadata(&parent) {
            Ok(m) if is_link(&m) => return Err("a parent folder is a link".into()),
            Ok(m) if !m.is_dir() => return Err("a parent is a file".into()),
            Ok(_) => {}
            Err(_) => fs::create_dir(&parent).map_err(|e| e.to_string())?,
        }
    }
    link(&from, &to, meta.is_dir()).map_err(|e| e.to_string())
}

/// Removes the links of `shared` from `worktree`, so removing the folder
/// cannot reach what they point at. Only a link is removed (a symlink on
/// Unix, a junction or symlink on Windows) and never followed: a real folder
/// or file at the path stays, and so does a path below a link. A hard link
/// on Windows is a plain file; deleting it with the folder only drops that
/// name, so it is left to git. Every path is tried; the first failure is
/// returned.
pub fn unlink_shared(worktree: &Path, shared: &[String]) -> Result<(), WorkspaceError> {
    let mut first = None;
    for path in shared {
        if let Err(e) = unlink_one(worktree, path) {
            first.get_or_insert(e);
        }
    }
    first.map_or(Ok(()), |e| Err(e.into()))
}

fn unlink_one(worktree: &Path, path: &str) -> io::Result<()> {
    let mut at = worktree.to_owned();
    let mut segments = path.split('/').peekable();
    while let Some(segment) = segments.next() {
        at.push(segment);
        let meta = match fs::symlink_metadata(&at) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        if segments.peek().is_some() {
            // A link on the way: what is below it is not this worktree's.
            if is_link(&meta) || !meta.is_dir() {
                return Ok(());
            }
        } else if is_link(&meta) {
            // A symlink goes with `remove_file`, a junction with `remove_dir`.
            return fs::remove_file(&at).or_else(|_| fs::remove_dir(&at));
        }
    }
    Ok(())
}

/// A symlink, or on Windows any reparse point (a junction too).
fn is_link(meta: &fs::Metadata) -> bool {
    if meta.is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        meta.file_attributes() & REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(unix)]
fn link(from: &Path, to: &Path, _dir: bool) -> io::Result<()> {
    std::os::unix::fs::symlink(from, to)
}

#[cfg(windows)]
fn link(from: &Path, to: &Path, dir: bool) -> io::Result<()> {
    if dir {
        junction(from, to)
    } else {
        fs::hard_link(from, to)
    }
}

#[cfg(not(any(unix, windows)))]
fn link(_from: &Path, _to: &Path, _dir: bool) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

/// A directory junction needs no privilege, unlike a symlink. Copied from
/// the one `xdev-agent` keeps for its sessions folder; that crate does not
/// depend on this one.
#[cfg(windows)]
fn junction(real: &Path, link: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(link)
        .arg(real)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("mklink /J failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_relative_paths() {
        assert_eq!(validate("node_modules").unwrap(), "node_modules");
        assert_eq!(
            validate("apps/desktop/node_modules").unwrap(),
            "apps/desktop/node_modules"
        );
        assert_eq!(validate(".env.local").unwrap(), ".env.local");
        assert_eq!(validate(" target/ ").unwrap(), "target");
    }

    #[test]
    fn a_backslash_becomes_a_slash() {
        assert_eq!(
            validate("apps\\desktop\\node_modules").unwrap(),
            "apps/desktop/node_modules"
        );
    }

    #[test]
    fn refuses_what_leaves_the_repo_or_touches_git() {
        assert_eq!(validate(""), Err(SharedError::Empty));
        assert_eq!(validate("  "), Err(SharedError::Empty));
        assert_eq!(validate("/etc"), Err(SharedError::Absolute));
        assert_eq!(validate("C:\\x"), Err(SharedError::Absolute));
        assert_eq!(validate("c:x"), Err(SharedError::Absolute));
        assert_eq!(validate("\\\\server\\share"), Err(SharedError::Absolute));
        assert_eq!(validate("//server/share"), Err(SharedError::Absolute));
        assert_eq!(validate("../x"), Err(SharedError::Dots));
        assert_eq!(validate("a/../b"), Err(SharedError::Dots));
        assert_eq!(validate("."), Err(SharedError::Dots));
        assert_eq!(validate("./a"), Err(SharedError::Dots));
        assert_eq!(validate("a//b"), Err(SharedError::EmptySegment));
        assert_eq!(validate(".git"), Err(SharedError::Git));
        assert_eq!(validate("a/.git/hooks"), Err(SharedError::Git));
        assert_eq!(validate(".GIT"), Err(SharedError::Git));
    }

    fn pair() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        let wt = tmp.path().join("wt");
        fs::create_dir_all(&main).unwrap();
        fs::create_dir_all(&wt).unwrap();
        (tmp, main, wt)
    }

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn links_a_folder_and_a_file() {
        let (_tmp, main, wt) = pair();
        fs::create_dir_all(main.join("node_modules")).unwrap();
        fs::write(main.join("node_modules/x"), "1").unwrap();
        fs::write(main.join(".env.local"), "KEY=1").unwrap();
        let out = link_shared(&main, &wt, &list(["node_modules", ".env.local"].as_slice()));
        assert!(out.iter().all(|l| l.ok && l.error.is_none()), "{out:?}");
        assert_eq!(fs::read_to_string(wt.join("node_modules/x")).unwrap(), "1");
        assert_eq!(fs::read_to_string(wt.join(".env.local")).unwrap(), "KEY=1");
        // A write through the link lands in the main checkout.
        fs::write(wt.join("node_modules/y"), "2").unwrap();
        assert!(main.join("node_modules/y").is_file());
    }

    #[test]
    fn creates_parents_for_a_nested_path() {
        let (_tmp, main, wt) = pair();
        fs::create_dir_all(main.join("apps/web/node_modules")).unwrap();
        let out = link_shared(&main, &wt, &list(["apps/web/node_modules"].as_slice()));
        assert!(out[0].ok, "{out:?}");
        assert!(wt.join("apps/web").is_dir());
        assert!(wt.join("apps/web/node_modules").is_dir());
    }

    #[test]
    fn a_missing_or_existing_path_is_reported_and_the_rest_link() {
        let (_tmp, main, wt) = pair();
        fs::create_dir_all(main.join("target")).unwrap();
        fs::create_dir_all(main.join("tracked")).unwrap();
        fs::create_dir_all(wt.join("tracked")).unwrap();
        fs::write(wt.join("tracked/mine"), "").unwrap();
        let out = link_shared(&main, &wt, &list(["gone", "tracked", "target"].as_slice()));
        assert!(!out[0].ok);
        assert!(out[0].error.as_deref().unwrap().contains("missing"));
        assert!(!out[1].ok);
        assert!(out[1].error.as_deref().unwrap().contains("already exists"));
        assert!(wt.join("tracked/mine").is_file());
        assert!(out[2].ok);
    }

    #[cfg(unix)]
    #[test]
    fn a_parent_that_is_a_link_is_refused() {
        let (tmp, main, wt) = pair();
        fs::create_dir_all(main.join("a/c")).unwrap();
        let elsewhere = tmp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, wt.join("a")).unwrap();
        let out = link_shared(&main, &wt, &list(["a/c"].as_slice()));
        assert!(!out[0].ok);
        assert!(out[0].error.as_deref().unwrap().contains("link"));
        assert!(fs::read_dir(&elsewhere).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn unlink_removes_the_link_and_keeps_the_target() {
        let (_tmp, main, wt) = pair();
        fs::create_dir_all(main.join("node_modules")).unwrap();
        fs::write(main.join("node_modules/x"), "1").unwrap();
        fs::write(main.join(".env.local"), "K").unwrap();
        link_shared(&main, &wt, &list(["node_modules", ".env.local"].as_slice()));
        unlink_shared(
            &wt,
            &list(["node_modules", ".env.local", "gone"].as_slice()),
        )
        .unwrap();
        assert!(fs::symlink_metadata(wt.join("node_modules")).is_err());
        assert!(fs::symlink_metadata(wt.join(".env.local")).is_err());
        assert_eq!(
            fs::read_to_string(main.join("node_modules/x")).unwrap(),
            "1"
        );
        assert_eq!(fs::read_to_string(main.join(".env.local")).unwrap(), "K");
    }

    #[test]
    fn unlink_leaves_a_real_folder_and_file_alone() {
        let (_tmp, _main, wt) = pair();
        fs::create_dir_all(wt.join("node_modules")).unwrap();
        fs::write(wt.join("node_modules/x"), "1").unwrap();
        fs::write(wt.join(".env.local"), "K").unwrap();
        unlink_shared(&wt, &list(["node_modules", ".env.local"].as_slice())).unwrap();
        assert!(wt.join("node_modules/x").is_file());
        assert!(wt.join(".env.local").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn unlink_does_not_reach_through_a_linked_parent() {
        let (_tmp, main, wt) = pair();
        fs::create_dir_all(main.join("a")).unwrap();
        std::os::unix::fs::symlink(main.join("a"), wt.join("a")).unwrap();
        std::os::unix::fs::symlink(wt.join("nowhere"), main.join("a/b")).unwrap();
        unlink_shared(&wt, &list(["a/b"].as_slice())).unwrap();
        assert!(fs::symlink_metadata(main.join("a/b")).is_ok());
    }
}
