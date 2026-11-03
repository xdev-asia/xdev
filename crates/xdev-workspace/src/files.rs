//! Reading, saving and managing the files of one worktree for the editor.
//! Every path is relative to the worktree and checked so it never leaves it.

use std::io;

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
    rel_under(worktree, rel)?;
    Err(todo("read_file"))
}

/// Writes atomically (a temp file in the same folder, then a rename).
/// `expected` is the hash the editor loaded; `None` means the file must not
/// exist yet.
pub fn write_file(
    worktree: &str,
    rel: &str,
    _text: &str,
    _eol: Eol,
    _expected: Option<&str>,
) -> Result<WriteOutcome, WorkspaceError> {
    rel_under(worktree, rel)?;
    Err(todo("write_file"))
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
    use super::*;

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
}
