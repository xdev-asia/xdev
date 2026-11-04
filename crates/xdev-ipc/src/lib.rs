//! A per-user local endpoint between xDev's own processes: a named pipe on
//! Windows, a Unix socket elsewhere, with a token file that proves the peer
//! is the same user. No codec: each user of the crate has its own frames.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// Random bytes in a token; the file holds them as hex.
pub const TOKEN_BYTES: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum IpcError {
    #[error("another process already listens on the endpoint")]
    InUse,
    #[error("nothing listens on the endpoint")]
    NotRunning,
    #[error("the peer did not prove it is the same user")]
    Auth,
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("a message is larger than allowed")]
    TooLarge,
}

/// Where one service listens: a pipe name on Windows, a socket path elsewhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    name: String,
    path: PathBuf,
}

/// `<prefix>-<user key>-v<major>`; a pipe name on Windows, `<dir>/<prefix>.sock`
/// elsewhere. A debug build has its own name, so it never meets a release service.
pub fn endpoint(dir: &Path, prefix: &str, major: u32) -> Endpoint {
    let _ = (dir, prefix, major);
    todo!("B1")
}

impl Endpoint {
    /// The pipe name (Windows) or the socket file's name (elsewhere).
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Fails with `IpcError::InUse` while another listener answers there.
    pub fn bind(&self) -> Result<Listener, IpcError> {
        todo!("B1")
    }

    /// `IpcError::NotRunning` when nothing answers.
    pub fn connect(&self) -> Result<Stream, IpcError> {
        let _ = &self.path;
        todo!("B1")
    }
}

pub struct Listener {
    _private: (),
}

impl Listener {
    pub fn accept(&self) -> Result<Stream, IpcError> {
        todo!("B1")
    }
}

pub struct Stream {
    _private: (),
}

impl Stream {
    pub fn try_clone(&self) -> io::Result<Stream> {
        todo!("B1")
    }

    /// `None` blocks for ever; a read past it fails with `TimedOut` or `WouldBlock`.
    pub fn set_read_timeout(&self, timeout: Option<std::time::Duration>) -> io::Result<()> {
        let _ = timeout;
        todo!("B1")
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let _ = buf;
        todo!("B1")
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let _ = buf;
        todo!("B1")
    }

    fn flush(&mut self) -> io::Result<()> {
        todo!("B1")
    }
}

/// Writes a fresh token (hex) to `<dir>/token`, folder 0700 / file 0600 on Unix.
pub fn new_token(dir: &Path) -> Result<String, IpcError> {
    let _ = dir;
    todo!("B1")
}

pub fn read_token(dir: &Path) -> Result<String, IpcError> {
    let _ = dir;
    todo!("B1")
}

/// Constant time in the length of `b`.
pub fn token_eq(a: &str, b: &str) -> bool {
    let _ = (a, b);
    todo!("B1")
}
