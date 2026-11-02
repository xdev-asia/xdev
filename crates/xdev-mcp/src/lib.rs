//! MCP server over stdio for an xDev vault: JSON-RPC, tool schemas and the
//! text agents read. The vault itself sits behind [`Docs`], so this crate
//! stays free of the core and of any async runtime.

mod protocol;
mod tools;

use serde::Serialize;

pub use protocol::serve;
pub use xdev_store::ContextPack;

/// Protocol versions this server speaks, newest first. `2026-07-28` is the
/// per-request (`_meta`) era; the others are the `initialize` handshake era.
pub const SUPPORTED: &[&str] = &["2026-07-28", "2025-11-25", "2025-06-18"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Hit {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DocInfo {
    pub path: String,
    pub title: String,
    #[serde(rename = "type")]
    pub doc_type: Option<String>,
    /// `DocState` as lowercase text: `fresh`, `stale`, `unverified`, `unknown`, `none`.
    pub state: String,
    pub covers: Vec<String>,
    /// Commits since `verified` that touched a covered path.
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Doc {
    pub info: DocInfo,
    pub content: String,
    pub backlinks: Vec<String>,
}

/// A failure the agent can act on, reported as a tool result with `isError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    /// Stable code such as `not_found`, `conflict`, `no_repo`.
    pub code: String,
}

/// The vault as the tools see it.
pub trait Docs {
    fn vault_name(&self) -> String;
    fn context_pack(&mut self, query: &str, budget: usize) -> Result<ContextPack, ToolError>;
    fn search(&mut self, query: &str, limit: usize) -> Result<Vec<Hit>, ToolError>;
    fn get(&mut self, path: &str) -> Result<Doc, ToolError>;
    fn list(&mut self, doc_type: Option<&str>) -> Result<Vec<DocInfo>, ToolError>;
    /// Docs whose state is `stale`, `unverified` or `unknown`.
    fn stale(&mut self) -> Result<Vec<DocInfo>, ToolError>;
    fn propose(
        &mut self,
        path: &str,
        content: &str,
        summary: Option<&str>,
    ) -> Result<(), ToolError>;
}
