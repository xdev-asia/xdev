//! The app's own endpoint for the `xdev` CLI: a per-user pipe or socket
//! from `xdev-ipc`, a token file, and newline-delimited JSON frames.
//! The first line of a connection is a hello with the token; then each
//! line is a `Request` and gets one `Response` line, in order.
// The contract lands before the endpoint that uses it.
#![allow(dead_code)]

use std::path::Path;

use serde::{Deserialize, Serialize};
use xdev_workspace::Registry;

/// The frames' version; a CLI with another one is refused at hello.
pub const APP_PROTOCOL: u32 = 1;
/// A request line longer than this is answered `too_large`.
pub const LINE_MAX: usize = 256 * 1024;
/// The longest `terminal.wait`, in seconds.
pub const WAIT_MAX_S: u64 = 86_400;
/// The `xdev-ipc` prefix; the terminal service uses `xdev-ptyd`.
pub const PREFIX: &str = "xdev-app";

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
    pub caller: Option<Caller>,
}

/// Who says it is calling: the PTY the CLI runs in (`XDEV_PTY_ID`). A
/// label for scope and audit, not an identity.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct Caller {
    pub pty: Option<String>,
}

/// Where a target stands from the caller's worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// The caller's own worktree.
    Own,
    /// The caller's parent or one of its children.
    Family,
    Other,
    /// No caller worktree: a script outside the app's terminals.
    External,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Own => "own",
            Scope::Family => "family",
            Scope::Other => "other",
            Scope::External => "external",
        }
    }
}

/// The first frame of a connection.
#[derive(Debug, Deserialize)]
pub struct Hello {
    pub protocol: u32,
    pub token: String,
    #[serde(default)]
    pub client: String,
    pub caller: Option<Caller>,
}

/// `<local_dir>/app/endpoint.json`, written at start and removed at a clean exit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointFile {
    pub name: String,
    pub pid: u32,
    pub version: String,
    pub started_ms: i64,
}

/// The scope of `target` for a caller in `caller_worktree`.
pub fn scope_of(caller_worktree: Option<&Path>, target: &Path, reg: &Registry) -> Scope {
    let _ = (caller_worktree, target, reg);
    Scope::External
}
