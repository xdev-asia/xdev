//! The only part that touches the OS. Tests use a fake `Probe`.

use std::path::PathBuf;
use std::time::Duration;

/// One listening TCP socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    pub bind_host: String,
    pub port: u16,
    /// None when the OS would not say, for instance another user's process.
    pub pid: Option<u32>,
}

/// One running process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub name: String,
    pub cmd: String,
    pub cwd: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ScanError {
    #[error("the scan took too long")]
    Timeout,
    #[error("{0}")]
    Failed(String),
    #[error("this platform has no port scan")]
    Unsupported,
}

/// What the scanner needs from the machine.
pub trait Probe: Send + Sync {
    /// Every TCP socket in the LISTEN state, IPv4 and IPv6.
    fn listeners(&self, timeout: Duration) -> Result<Vec<Listener>, ScanError>;
    /// Every process this user can see.
    fn processes(&self) -> Result<Vec<Proc>, ScanError>;
    /// Ends one process. A process that is already gone counts as success.
    fn terminate(&self, pid: u32) -> Result<(), ScanError>;
}

/// The real machine.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsProbe;

impl Probe for OsProbe {
    fn listeners(&self, timeout: Duration) -> Result<Vec<Listener>, ScanError> {
        crate::os::listeners(timeout)
    }
    fn processes(&self) -> Result<Vec<Proc>, ScanError> {
        crate::os::processes()
    }
    fn terminate(&self, pid: u32) -> Result<(), ScanError> {
        crate::os::terminate(pid)
    }
}

/// A terminal the app started: the pid at its root and the worktree it runs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyRoot {
    pub pid: u32,
    pub worktree: PathBuf,
}
