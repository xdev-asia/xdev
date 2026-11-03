//! Reading, saving and managing the files of one worktree for the editor.
//! Every path is relative to the worktree and checked so it never leaves it.

use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};

use crate::WorkspaceError;
use crate::ops::rel_under;

/// Larger files open read-only as "too large"; nothing of them is read.
pub const READ_MAX: u64 = 2 * 1024 * 1024;

/// What the editor shows for a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    /// Forward slashes, as given.
    pub rel: String,
    /// `None` when the file is binary or too large.
    pub text: Option<String>,
    pub kind: FileKind,
    pub size: u64,
    /// blake3 hex of the bytes on disk; empty for a file too large to read.
    pub hash: String,
    /// From the first line break; `Lf` when there is none.
    pub eol: Eol,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    Text,
    /// A NUL byte in the first 8 KiB, or not UTF-8.
    Binary,
    /// Over `READ_MAX`.
    TooLarge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Eol {
    Lf,
    Crlf,
}

/// How a save ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WriteOutcome {
    #[serde(rename_all = "camelCase")]
    Saved { hash: String },
    /// The file changed since `expected`; nothing was written. `disk_hash`
    /// is empty when the file is gone.
    #[serde(rename_all = "camelCase")]
    Conflict { disk_hash: String },
}

fn todo(what: &str) -> WorkspaceError {
    WorkspaceError::Io(io::Error::new(
        io::ErrorKind::Unsupported,
        format!("{what} is not built yet"),
    ))
}

/// The file `rel` of `worktree`.
pub fn read_file(worktree: &str, rel: &str) -> Result<FileText, WorkspaceError> {
    let disk = rel_under(worktree, rel)?;
    let meta = fs::metadata(&disk).map_err(|e| missing(e, rel))?;
    if meta.is_dir() {
        return Err(WorkspaceError::BadPath(rel.to_owned()));
    }
    let too_large = |size| FileText {
        rel: rel.to_owned(),
        text: None,
        kind: FileKind::TooLarge,
        size,
        hash: String::new(),
        eol: Eol::Lf,
    };
    if meta.len() > READ_MAX {
        return Ok(too_large(meta.len()));
    }
    // One byte past the limit tells a file that grew since the check.
    let mut bytes = Vec::new();
    fs::File::open(&disk)
        .map_err(|e| missing(e, rel))?
        .take(READ_MAX + 1)
        .read_to_end(&mut bytes)?;
    let size = bytes.len() as u64;
    if size > READ_MAX {
        return Ok(too_large(size));
    }
    let hash = hash_of(&bytes);
    let eol = eol_of(&bytes);
    let head = &bytes[..bytes.len().min(BINARY_SNIFF)];
    let text = if head.contains(&0) {
        None
    } else {
        String::from_utf8(bytes).ok()
    };
    let kind = if text.is_some() {
        FileKind::Text
    } else {
        FileKind::Binary
    };
    Ok(FileText {
        rel: rel.to_owned(),
        text,
        kind,
        size,
        hash,
        eol,
    })
}

/// How much of a file is searched for a NUL byte.
const BINARY_SNIFF: usize = 8 * 1024;

fn hash_of(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// From the first line break; `Lf` when there is none.
fn eol_of(bytes: &[u8]) -> Eol {
    match bytes.iter().position(|&b| b == b'\n') {
        Some(at) if at > 0 && bytes[at - 1] == b'\r' => Eol::Crlf,
        _ => Eol::Lf,
    }
}

/// `NotFound` for a file that is not there; other errors as they are.
fn missing(e: io::Error, rel: &str) -> WorkspaceError {
    if e.kind() == io::ErrorKind::NotFound {
        WorkspaceError::NotFound(rel.to_owned())
    } else {
        e.into()
    }
}

/// Writes atomically (a temp file in the same folder, then a rename).
/// `expected` is the hash the editor loaded; `None` means the file must not
/// exist yet.
pub fn write_file(
    worktree: &str,
    rel: &str,
    text: &str,
    eol: Eol,
    expected: Option<&str>,
) -> Result<WriteOutcome, WorkspaceError> {
    let disk = rel_under(worktree, rel)?;
    let on_disk = match fs::metadata(&disk) {
        Ok(meta) if meta.is_dir() => return Err(WorkspaceError::BadPath(rel.to_owned())),
        Ok(_) => Some(hash_file(&disk)?),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if on_disk.as_deref() != expected {
        return Ok(WriteOutcome::Conflict {
            disk_hash: on_disk.unwrap_or_default(),
        });
    }
    let lf = text.replace("\r\n", "\n").replace('\r', "\n");
    let bytes = match eol {
        Eol::Lf => lf,
        Eol::Crlf => lf.replace('\n', "\r\n"),
    };
    replace(&disk, bytes.as_bytes(), |from, to| fs::rename(from, to))?;
    Ok(WriteOutcome::Saved {
        hash: hash_of(bytes.as_bytes()),
    })
}

/// blake3 of a file, read in pieces.
fn hash_file(path: &Path) -> io::Result<String> {
    let mut hasher = blake3::Hasher::new();
    io::copy(&mut fs::File::open(path)?, &mut hasher)?;
    Ok(hasher.finalize().to_hex().to_string())
}

/// Puts `bytes` at `path` through a new file in the same folder and a
/// `rename`, so a reader sees the old file or the new one, never half of
/// one. On Unix the new file takes the old one's mode. When anything fails
/// the temp file is removed and `path` is as it was.
fn replace(
    path: &Path,
    bytes: &[u8],
    rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let (tmp, mut file) = loop {
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = dir.join(format!(".{name}.{}-{seq}.xdev-tmp", std::process::id()));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(file) => break (tmp, file),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    };
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(unix)]
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        rename(&tmp, path)
    })();
    if result.is_err() {
        // Ours, never the user's file.
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// An empty file or a folder; fails with `Exists` when the name is taken.
pub fn create_entry(worktree: &str, rel: &str, _dir: bool) -> Result<(), WorkspaceError> {
    rel_under(worktree, rel)?;
    Err(todo("create_entry"))
}

/// Fails with `Exists` when `to` is taken.
pub fn rename_entry(worktree: &str, from: &str, to: &str) -> Result<(), WorkspaceError> {
    rel_under(worktree, from)?;
    rel_under(worktree, to)?;
    Err(todo("rename_entry"))
}

/// Moves the item to the OS trash; never a hard delete.
pub fn trash_entry(worktree: &str, rel: &str) -> Result<(), WorkspaceError> {
    rel_under(worktree, rel)?;
    Err(todo("trash_entry"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    fn root(tmp: &TempDir) -> &str {
        tmp.path().to_str().unwrap()
    }

    fn blake(bytes: &[u8]) -> String {
        blake3::hash(bytes).to_hex().to_string()
    }

    #[test]
    fn read_file_returns_text_with_hash_size_and_eol() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("src")).unwrap();
        fs::write(
            tmp.path().join("src").join("a.rs"),
            "fn a() {}\nfn b() {}\n",
        )
        .unwrap();
        let file = read_file(root(&tmp), "src/a.rs").unwrap();
        assert_eq!(
            file,
            FileText {
                rel: "src/a.rs".into(),
                text: Some("fn a() {}\nfn b() {}\n".into()),
                kind: FileKind::Text,
                size: 20,
                hash: blake(b"fn a() {}\nfn b() {}\n"),
                eol: Eol::Lf,
            }
        );
        fs::write(tmp.path().join("one.txt"), "no break").unwrap();
        assert_eq!(read_file(root(&tmp), "one.txt").unwrap().eol, Eol::Lf);
        fs::write(tmp.path().join("empty.txt"), "").unwrap();
        let empty = read_file(root(&tmp), "empty.txt").unwrap();
        assert_eq!(
            (empty.text.as_deref(), empty.kind),
            (Some(""), FileKind::Text)
        );
    }

    #[test]
    fn read_file_keeps_crlf_text_and_reports_crlf() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("w.txt"), "a\r\nb\r\n").unwrap();
        let file = read_file(root(&tmp), "w.txt").unwrap();
        assert_eq!(file.eol, Eol::Crlf);
        assert_eq!(file.text.as_deref(), Some("a\r\nb\r\n"));
    }

    #[test]
    fn read_file_flags_binary_without_text() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("zero.bin"), b"ab\0cd").unwrap();
        let file = read_file(root(&tmp), "zero.bin").unwrap();
        assert_eq!((file.kind, file.text), (FileKind::Binary, None));
        assert_eq!((file.size, file.hash), (5, blake(b"ab\0cd")));
        // Not UTF-8.
        fs::write(tmp.path().join("latin.txt"), b"caf\xe9").unwrap();
        let file = read_file(root(&tmp), "latin.txt").unwrap();
        assert_eq!((file.kind, file.text), (FileKind::Binary, None));
    }

    #[test]
    fn read_file_does_not_read_a_file_over_the_limit() {
        let tmp = TempDir::new().unwrap();
        let big = tmp.path().join("big.log");
        fs::File::create(&big)
            .unwrap()
            .set_len(READ_MAX + 1)
            .unwrap();
        let file = read_file(root(&tmp), "big.log").unwrap();
        assert_eq!(
            (file.kind, file.text, file.size, file.hash.as_str()),
            (FileKind::TooLarge, None, READ_MAX + 1, "")
        );
        // Exactly the limit still opens.
        fs::File::create(tmp.path().join("edge.log"))
            .unwrap()
            .set_len(READ_MAX)
            .unwrap();
        assert_eq!(
            read_file(root(&tmp), "edge.log").unwrap().kind,
            FileKind::Binary
        );
    }

    #[test]
    fn read_file_refuses_missing_files_folders_and_escapes() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("src")).unwrap();
        let code = |rel| read_file(root(&tmp), rel).unwrap_err().code();
        assert_eq!(code("missing.rs"), "not_found");
        assert_eq!(code("src/missing.rs"), "not_found");
        assert_eq!(code("src"), "bad_path");
        assert_eq!(code("../x"), "bad_path");
        assert_eq!(code(".git/config"), "bad_path");
    }

    #[test]
    fn outcomes_serialize_with_a_type_tag() {
        let saved = serde_json::to_string(&WriteOutcome::Saved { hash: "ab".into() }).unwrap();
        assert_eq!(saved, r#"{"type":"saved","hash":"ab"}"#);
        let conflict = serde_json::to_string(&WriteOutcome::Conflict {
            disk_hash: "cd".into(),
        })
        .unwrap();
        assert_eq!(conflict, r#"{"type":"conflict","diskHash":"cd"}"#);
        assert_eq!(
            serde_json::to_string(&FileKind::TooLarge).unwrap(),
            r#""tooLarge""#
        );
        assert_eq!(serde_json::from_str::<Eol>(r#""crlf""#).unwrap(), Eol::Crlf);
    }

    fn names_in(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn write_file_saves_against_the_loaded_hash() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.txt"), "old\n").unwrap();
        let loaded = read_file(root(&tmp), "a.txt").unwrap();
        let out = write_file(root(&tmp), "a.txt", "new\n", Eol::Lf, Some(&loaded.hash)).unwrap();
        assert_eq!(
            out,
            WriteOutcome::Saved {
                hash: blake(b"new\n")
            }
        );
        assert_eq!(fs::read(tmp.path().join("a.txt")).unwrap(), b"new\n");
        // The saved hash is what a read gives now, and no temp file is left.
        assert_eq!(
            read_file(root(&tmp), "a.txt").unwrap().hash,
            blake(b"new\n")
        );
        assert_eq!(names_in(tmp.path()), ["a.txt"]);
    }

    #[test]
    fn write_file_reports_a_conflict_and_writes_nothing() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("a.txt");
        fs::write(&path, "theirs\n").unwrap();
        let stale = blake(b"mine\n");
        let out = write_file(root(&tmp), "a.txt", "lost\n", Eol::Lf, Some(&stale)).unwrap();
        assert_eq!(
            out,
            WriteOutcome::Conflict {
                disk_hash: blake(b"theirs\n")
            }
        );
        // `None` means a new file, and this one exists.
        let out = write_file(root(&tmp), "a.txt", "lost\n", Eol::Lf, None).unwrap();
        assert!(matches!(out, WriteOutcome::Conflict { .. }));
        assert_eq!(fs::read(&path).unwrap(), b"theirs\n");
        // The file went away since it was loaded.
        let out = write_file(root(&tmp), "gone.txt", "x", Eol::Lf, Some(&stale)).unwrap();
        assert_eq!(
            out,
            WriteOutcome::Conflict {
                disk_hash: String::new()
            }
        );
        assert!(!tmp.path().join("gone.txt").exists());
        assert_eq!(names_in(tmp.path()), ["a.txt"]);
    }

    #[test]
    fn write_file_makes_a_new_file_when_none_is_expected() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("src")).unwrap();
        let out = write_file(root(&tmp), "src/new.rs", "fn x() {}", Eol::Lf, None).unwrap();
        assert!(matches!(out, WriteOutcome::Saved { .. }));
        assert_eq!(
            fs::read(tmp.path().join("src").join("new.rs")).unwrap(),
            b"fn x() {}"
        );
    }

    #[test]
    fn write_file_writes_every_line_break_as_the_chosen_eol() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("w.txt");
        fs::write(&path, "a\r\nb\r\n").unwrap();
        let loaded = read_file(root(&tmp), "w.txt").unwrap();
        assert_eq!(loaded.eol, Eol::Crlf);
        let out = write_file(
            root(&tmp),
            "w.txt",
            "a\nb\r\nc\rd\n",
            loaded.eol,
            Some(&loaded.hash),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"a\r\nb\r\nc\r\nd\r\n");
        let WriteOutcome::Saved { hash } = out else {
            panic!("not saved: {out:?}");
        };
        write_file(root(&tmp), "w.txt", "x\r\ny\r\n", Eol::Lf, Some(&hash)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"x\ny\n");
    }

    #[test]
    fn write_file_refuses_folders_missing_parents_and_escapes() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("src")).unwrap();
        let code = |rel| {
            write_file(root(&tmp), rel, "x", Eol::Lf, None)
                .unwrap_err()
                .code()
        };
        assert_eq!(code("src"), "bad_path");
        assert_eq!(code("nope/a.txt"), "not_found");
        assert_eq!(code("../a.txt"), "bad_path");
        assert_eq!(code(".git/config"), "bad_path");
        assert_eq!(names_in(tmp.path()), ["src"]);
    }

    #[test]
    fn a_failed_rename_leaves_the_file_and_no_temp_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("a.txt");
        fs::write(&path, "old").unwrap();
        let err =
            replace(&path, b"new", |_, _| Err(io::Error::other("rename failed"))).unwrap_err();
        assert_eq!(err.to_string(), "rename failed");
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(names_in(tmp.path()), ["a.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn write_file_keeps_the_file_mode() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("run.sh");
        fs::write(&path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
        let loaded = read_file(root(&tmp), "run.sh").unwrap();
        write_file(
            root(&tmp),
            "run.sh",
            "#!/bin/sh\necho\n",
            Eol::Lf,
            Some(&loaded.hash),
        )
        .unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o750);
    }
}
