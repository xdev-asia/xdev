//! A per-user local endpoint between xDev's own processes: a named pipe on
//! Windows, a Unix socket elsewhere, with a token file that proves the peer
//! is the same user. No codec: each user of the crate has its own frames.

use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use interprocess::TryClone;
use interprocess::local_socket::traits::{Listener as _, Stream as _};
use interprocess::local_socket::{self as ls, ListenerOptions};

/// Random bytes in a token; the file holds them as hex.
pub const TOKEN_BYTES: usize = 32;

const TOKEN_FILE: &str = "token";

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

/// A debug build never meets a release service, nor the other way round.
const CHANNEL: &str = if cfg!(debug_assertions) { "-dev" } else { "" };

/// `<prefix>-<user key>-v<major>`; a pipe name on Windows, `<dir>/<prefix>.sock`
/// elsewhere. A debug build has its own name, so it never meets a release service.
pub fn endpoint(dir: &Path, prefix: &str, major: u32) -> Endpoint {
    // Pipe names are machine-wide; the user's name keeps two users apart.
    // `dir` is the user's own already, so the socket path does not need it.
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();
    let key = blake3::hash(user.as_bytes()).to_hex();
    Endpoint {
        name: format!("{prefix}{CHANNEL}-{}-v{major}", &key[..16]),
        path: dir.join(format!("{prefix}{CHANNEL}-v{major}.sock")),
    }
}

impl Endpoint {
    /// The pipe name (Windows) or the socket file's name (elsewhere).
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Fails with `IpcError::InUse` while another listener answers there.
    pub fn bind(&self) -> Result<Listener, IpcError> {
        #[cfg(unix)]
        if let Some(parent) = self.path.parent() {
            private_dir(parent)?;
        }
        match self.listen() {
            Err(IpcError::InUse) if self.stale() => {
                // A crashed listener left its socket file; nobody answers on it.
                let _ = fs::remove_file(&self.path);
                self.listen()
            }
            other => other,
        }
    }

    fn listen(&self) -> Result<Listener, IpcError> {
        ListenerOptions::new()
            .name(self.socket_name()?)
            .create_sync()
            .map(Listener)
            .map_err(|e| match e.kind() {
                ErrorKind::AddrInUse => IpcError::InUse,
                // A second pipe server instance is refused with access denied.
                ErrorKind::PermissionDenied if cfg!(windows) => IpcError::InUse,
                _ => IpcError::Io(e),
            })
    }

    /// A socket file that nothing answers on. Never on Windows: a pipe goes
    /// away with its last server.
    fn stale(&self) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileTypeExt;
            fs::symlink_metadata(&self.path).is_ok_and(|m| m.file_type().is_socket())
                && matches!(self.connect(), Err(IpcError::NotRunning))
        }
        #[cfg(not(unix))]
        false
    }

    /// `IpcError::NotRunning` when nothing answers.
    pub fn connect(&self) -> Result<Stream, IpcError> {
        ls::Stream::connect(self.socket_name()?)
            .map(Stream)
            .map_err(|e| match e.kind() {
                ErrorKind::NotFound | ErrorKind::ConnectionRefused => IpcError::NotRunning,
                _ => IpcError::Io(e),
            })
    }

    #[cfg(windows)]
    fn socket_name(&self) -> io::Result<ls::Name<'_>> {
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        self.name.as_str().to_ns_name::<GenericNamespaced>()
    }

    #[cfg(not(windows))]
    fn socket_name(&self) -> io::Result<ls::Name<'_>> {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        self.path.as_path().to_fs_name::<GenericFilePath>()
    }
}

pub struct Listener(ls::Listener);

impl Listener {
    pub fn accept(&self) -> Result<Stream, IpcError> {
        Ok(Stream(self.0.accept()?))
    }
}

pub struct Stream(ls::Stream);

impl Stream {
    pub fn try_clone(&self) -> io::Result<Stream> {
        Ok(Stream(self.0.try_clone()?))
    }

    /// `None` blocks for ever; a read past it fails with `TimedOut` or `WouldBlock`.
    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.0.set_recv_timeout(timeout)
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

/// Writes a fresh token (hex) to `<dir>/token`, folder 0700 / file 0600 on Unix.
pub fn new_token(dir: &Path) -> Result<String, IpcError> {
    private_dir(dir)?;
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    // Temp then rename, so a reader never sees half a token.
    let tmp = dir.join(format!(".{TOKEN_FILE}-{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options
        .open(&tmp)
        .and_then(|mut f| f.write_all(token.as_bytes()).and_then(|()| f.sync_all()))
        .and_then(|()| fs::rename(&tmp, dir.join(TOKEN_FILE)));
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(token)
}

/// `IpcError::NotRunning` when no service has written one.
pub fn read_token(dir: &Path) -> Result<String, IpcError> {
    match fs::read_to_string(dir.join(TOKEN_FILE)) {
        Ok(token) => Ok(token.trim().to_owned()),
        Err(e) if e.kind() == ErrorKind::NotFound => Err(IpcError::NotRunning),
        Err(e) => Err(e.into()),
    }
}

/// Constant time in the length of `b`.
pub fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = a.len() ^ b.len();
    for (i, y) in b.iter().enumerate() {
        diff |= usize::from(a.get(i).copied().unwrap_or(0) ^ y);
    }
    std::hint::black_box(diff) == 0
}

/// Created when missing; on Unix only the user may enter it. Windows: the
/// local app data folder is the user's alone already.
fn private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn ep(dir: &Path) -> Endpoint {
        // A name of its own per test: Windows pipes share one namespace.
        let prefix = format!(
            "xdev-ipc-test-{}",
            dir.file_name().unwrap().to_string_lossy()
        );
        endpoint(dir, &prefix, 1)
    }

    #[test]
    fn names_carry_the_prefix_the_major_and_the_channel() {
        let dir = tempfile::tempdir().unwrap();
        let a = endpoint(dir.path(), "xdev-ptyd", 1);
        assert_eq!(a, endpoint(dir.path(), "xdev-ptyd", 1));
        assert!(a.name().starts_with("xdev-ptyd-"), "{}", a.name());
        assert!(a.name().ends_with("-v1"), "{}", a.name());
        assert_eq!(a.name().contains("-dev-"), cfg!(debug_assertions));
        assert_ne!(a, endpoint(dir.path(), "xdev-ptyd", 2));
        assert_ne!(a, endpoint(dir.path(), "xdev-app", 1));
    }

    #[test]
    fn a_second_bind_is_in_use() {
        let dir = tempfile::tempdir().unwrap();
        let e = ep(dir.path());
        let _first = e.bind().unwrap();
        assert!(matches!(e.bind(), Err(IpcError::InUse)));
    }

    #[test]
    fn connect_with_nothing_bound_is_not_running() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            ep(dir.path()).connect(),
            Err(IpcError::NotRunning)
        ));
    }

    #[test]
    fn a_dropped_listener_frees_the_name() {
        let dir = tempfile::tempdir().unwrap();
        let e = ep(dir.path());
        drop(e.bind().unwrap());
        assert!(matches!(e.connect(), Err(IpcError::NotRunning)));
        e.bind().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_socket_file_is_taken_over() {
        let dir = tempfile::tempdir().unwrap();
        let e = ep(dir.path());
        // A crashed service leaves its socket file behind.
        drop(std::os::unix::net::UnixListener::bind(&e.path).unwrap());
        assert!(e.path.exists());
        e.bind().unwrap();
    }

    #[test]
    fn a_round_trip_over_the_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let e = ep(dir.path());
        let listener = e.bind().unwrap();
        let server = thread::spawn(move || {
            let mut s = listener.accept().unwrap();
            let mut buf = [0; 5];
            s.read_exact(&mut buf).unwrap();
            let mut w = s.try_clone().unwrap();
            w.write_all(&buf.map(|b| b.to_ascii_uppercase())).unwrap();
            w.flush().unwrap();
        });
        let mut c = e.connect().unwrap();
        c.write_all(b"hello").unwrap();
        c.flush().unwrap();
        let mut back = [0; 5];
        c.read_exact(&mut back).unwrap();
        assert_eq!(&back, b"HELLO");
        server.join().unwrap();
    }

    #[test]
    fn a_read_timeout_ends_a_silent_read() {
        let dir = tempfile::tempdir().unwrap();
        let e = ep(dir.path());
        let listener = e.bind().unwrap();
        let server = thread::spawn(move || listener.accept().unwrap());
        let mut c = e.connect().unwrap();
        let _held = server.join().unwrap();
        c.set_read_timeout(Some(std::time::Duration::from_millis(100)))
            .unwrap();
        let mut buf = [0; 1];
        assert!(c.read(&mut buf).is_err());
    }

    #[test]
    fn a_token_is_written_and_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let ptyd = dir.path().join("ptyd");
        let token = new_token(&ptyd).unwrap();
        assert_eq!(token.len(), TOKEN_BYTES * 2);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(read_token(&ptyd).unwrap(), token);
        assert_ne!(new_token(&ptyd).unwrap(), token);
        assert!(matches!(
            read_token(&dir.path().join("none")),
            Err(IpcError::NotRunning)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn the_token_file_is_the_users_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let ptyd = dir.path().join("ptyd");
        new_token(&ptyd).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&ptyd.join("token")), 0o600);
        assert_eq!(mode(&ptyd), 0o700);
    }

    #[test]
    fn token_eq_compares_whole_strings() {
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "abcd"));
        assert!(!token_eq("abcd", "abc"));
        assert!(!token_eq("", "a"));
        assert!(token_eq("", ""));
    }
}
