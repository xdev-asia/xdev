//! The frames between the app and `xdev-ptyd`.
//!
//! Wire: u32 length (LE), u8 kind, body. Control bodies are JSON; Output is
//! id + u64 seq + bytes. A reader skips a kind it does not know.

use std::io::{self, Read, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const PROTOCOL: u32 = 1;
pub const FRAME_MAX: usize = 1024 * 1024;
pub const RING_DEFAULT: usize = 2 * 1024 * 1024;
pub const RING_MAX: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Hello {
        protocol: u32,
        minor: u32,
        token: String,
        app_version: String,
    },
    Welcome {
        protocol: u32,
        minor: u32,
        features: Vec<String>,
        service_version: String,
        pid: u32,
    },
    Spawn {
        id: String,
        program: PathBuf,
        args: Vec<String>,
        env: Vec<(String, String)>,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        meta: serde_json::Value,
    },
    Spawned {
        id: String,
        pid: Option<u32>,
    },
    Write {
        id: String,
        data: Vec<u8>,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
    },
    Ack {
        id: String,
        n: u64,
    },
    Kill {
        id: String,
    },
    List,
    Sessions {
        sessions: Vec<SessionInfo>,
    },
    Attach {
        id: String,
        from_seq: u64,
    },
    Detach {
        id: String,
    },
    Output {
        id: String,
        seq: u64,
        data: Vec<u8>,
    },
    Gap {
        id: String,
        lost: u64,
    },
    Detached {
        id: String,
        reason: String,
    },
    Exited {
        id: String,
        code: Option<i32>,
    },
    QuitAll,
    Error {
        id: Option<String>,
        code: String,
    },
}

/// One PTY the service holds, for the sessions list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub pid: Option<u32>,
    pub program: String,
    pub cwd: String,
    pub started_ms: i64,
    pub last_output_ms: i64,
    pub last_input_ms: i64,
    /// What the app passed at spawn: `{ worktree, tabId, profile }`.
    #[cfg_attr(
        feature = "ts",
        ts(type = "{ worktree?: string, tabId?: string, profile?: string }")
    )]
    pub meta: serde_json::Value,
    pub attached: bool,
    pub exited: Option<i32>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProtoError {
    #[error("frame larger than {FRAME_MAX} bytes")]
    TooLarge,
    #[error("bad frame: {0}")]
    Bad(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

pub fn write_frame(w: &mut impl Write, f: &Frame) -> io::Result<()> {
    let _ = (w, f);
    todo!("B2")
}

/// `None` at a clean end of stream, between frames. A kind this build does
/// not know is skipped.
pub fn read_frame(r: &mut impl Read) -> Result<Option<Frame>, ProtoError> {
    let _ = r;
    todo!("B2")
}
