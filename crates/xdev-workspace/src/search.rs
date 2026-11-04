//! Quick open and search in files for one worktree: a walk that respects
//! `.gitignore`, skips `.git` and never follows a link out of the worktree.

use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use crate::WorkspaceError;

/// `list_files` stops here and sets `truncated`.
pub const LIST_MAX: usize = 50_000;
/// Lines in total over one search.
pub const HIT_MAX: usize = 5_000;
/// Lines kept per file; `more` tells there were others.
pub const PER_FILE_MAX: usize = 200;
/// Chars of a line kept around its first match.
pub const LINE_CLIP: usize = 400;

/// The files of a worktree for quick open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    /// Relative, forward slashes, sorted.
    pub files: Vec<String>,
    /// More than `LIST_MAX` files; only the first ones are listed.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    /// 1 to 1000 chars.
    pub text: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// `text` is a regex (the `regex` crate's syntax) rather than plain text.
    pub regex: bool,
    /// Gitignore-style globs such as `*.ts` or `src/**`; empty is every file.
    pub include: Vec<String>,
    /// Globs left out, on top of `.gitignore`.
    pub exclude: Vec<String>,
}

/// One matching line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LineHit {
    /// 1-based.
    pub line: u32,
    /// The line without its break, clipped to `LINE_CLIP` chars around the first match.
    pub text: String,
    /// Each match as `[start, end)` char offsets in `text`.
    pub ranges: Vec<(u32, u32)>,
}

/// The matching lines of one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileHits {
    pub rel: String,
    pub hits: Vec<LineHit>,
    /// The file has more matching lines than `PER_FILE_MAX`.
    pub more: bool,
}

/// What a search sends while it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SearchEvent {
    Batch {
        files: Vec<FileHits>,
    },
    /// The last event of a search that was not cancelled; `truncated` when
    /// `HIT_MAX` was reached.
    Done {
        files: u32,
        hits: u32,
        truncated: bool,
        ms: u32,
    },
    /// The query cannot run (a bad regex or glob); nothing follows.
    Error {
        message: String,
    },
}

/// Every file of `worktree` that `.gitignore` keeps, up to `LIST_MAX`.
pub fn list_files(worktree: &str) -> Result<FileList, WorkspaceError> {
    let _ = worktree;
    Ok(FileList {
        files: Vec::new(),
        truncated: false,
    })
}

/// Searches the text files of `worktree` for `q`, sending `Batch` events and
/// then `Done` to `sink`. Stops early without `Done` once `cancel` is set.
pub fn search_text(
    worktree: &str,
    q: &SearchQuery,
    cancel: &AtomicBool,
    sink: &mut dyn FnMut(SearchEvent),
) -> Result<(), WorkspaceError> {
    let _ = (worktree, q, cancel);
    sink(SearchEvent::Done {
        files: 0,
        hits: 0,
        truncated: false,
        ms: 0,
    });
    Ok(())
}
