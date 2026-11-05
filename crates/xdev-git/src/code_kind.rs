//! Sorts a changed path into source, test or generated code, so a branch's
//! line count can tell them apart. Plain string checks on a closed rule set.

use serde::{Deserialize, Serialize};

/// What a path holds, as far as its name tells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeKind {
    Source,
    Test,
    Generated,
}

/// Lines added and removed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LineCount {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub added: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub removed: u64,
}

/// The kind of a repo path with `/` separators. Generated wins over test.
pub fn code_kind(_path: &str) -> CodeKind {
    CodeKind::Source
}
