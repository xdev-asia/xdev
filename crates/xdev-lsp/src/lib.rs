//! A language server client for the desktop app: finds the servers a person
//! installed, runs one per (worktree, language) over stdio JSON-RPC and keeps
//! a pool that stops idle ones. Threads only, no async runtime; the few
//! protocol shapes used are plain structs and `serde_json::Value`.

pub mod catalog;
pub mod conn;
pub mod convert;
pub mod docs;
pub mod framing;
pub mod pool;
pub mod server;

pub use catalog::{LspLanguage, candidates, detect, language_of};
pub use conn::Connection;
pub use pool::{Launch, Pool, Status, should_stop};
pub use server::{Server, ServerCaps};

use serde::{Deserialize, Serialize};

/// Why a call to a server gave no answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LspError {
    /// The server's output ended (it exited or crashed).
    #[error("the language server closed")]
    Closed,
    #[error("the language server did not answer in time")]
    Timeout,
    /// The server answered with an error object.
    #[error("language server error {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("could not start the language server: {0}")]
    Spawn(String),
    #[error("i/o with the language server failed: {0}")]
    Io(String),
    /// The server lacks the capability asked for.
    #[error("the language server does not support this")]
    Unsupported,
    /// The server for this document is still starting.
    #[error("the language server is starting")]
    Starting,
    /// The server stopped after too many restarts.
    #[error("the language server stopped")]
    Crashed,
    /// The document is not open in any server.
    #[error("the document is not open")]
    NotOpen,
    /// A path outside the worktree.
    #[error("outside the worktree")]
    Outside,
}

/// A position in a document: 0-based line and UTF-16 code unit, as the
/// protocol and the editor count them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "LspPos"))]
pub struct Pos {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "LspRange"))]
pub struct Range {
    pub start: Pos,
    pub end: Pos,
}

/// A place a server pointed at. `rel` is None outside the worktree; such a
/// place is shown, never opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "LspLocation"))]
pub struct Location {
    pub rel: Option<String>,
    pub path: String,
    pub range: Range,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "LspHover"))]
pub struct Hover {
    pub markdown: String,
    pub range: Option<Range>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "LspCompletionItem"))]
#[serde(rename_all = "camelCase")]
pub struct CompletionItem {
    pub label: String,
    /// The protocol's `CompletionItemKind` number.
    pub kind: Option<u32>,
    pub detail: Option<String>,
    pub insert_text: String,
    /// The text `insert_text` replaces; the word at the caret when None.
    pub range: Option<Range>,
    pub sort_text: Option<String>,
    pub filter_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "LspCompletionList"))]
pub struct CompletionList {
    /// More items exist: ask again as the person types.
    pub incomplete: bool,
    pub items: Vec<CompletionItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "LspTextEdit"))]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub range: Range,
    pub new_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "LspFileEdit"))]
pub struct FileEdit {
    pub rel: String,
    pub edits: Vec<TextEdit>,
}

/// The edits of a rename, per file of the worktree.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "LspWorkspaceEdit"))]
pub struct WorkspaceEdit {
    pub files: Vec<FileEdit>,
    /// File creates, renames and deletes, and files outside the worktree:
    /// left out, counted here.
    pub skipped: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "LspSymbol"))]
pub struct Symbol {
    pub name: String,
    /// The protocol's `SymbolKind` number.
    pub kind: u32,
    pub container: Option<String>,
    pub rel: String,
    pub range: Range,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "LspDiagnostic"))]
pub struct Diagnostic {
    pub range: Range,
    /// 1 error, 2 warning, 3 information, 4 hint.
    pub severity: u8,
    pub message: String,
    pub source: Option<String>,
    pub code: Option<String>,
}

/// Where a server is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "LspState"))]
#[serde(rename_all = "camelCase")]
pub enum State {
    Starting,
    Ready,
    Stopped,
    Crashed,
    NotFound,
}
