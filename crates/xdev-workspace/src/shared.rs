//! `[worktree] shared` of `xdev.toml`: paths of the main checkout linked into
//! each new worktree, so they share dependency folders and local files.

use serde::Serialize;

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
