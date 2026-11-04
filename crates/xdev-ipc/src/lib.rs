//! A per-user local endpoint between xDev's own processes: a named pipe on
//! Windows, a Unix socket elsewhere, with a token file that proves the peer
//! is the same user. No codec: each user of the crate has its own frames.

use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use interprocess::TryClone;
use interprocess::local_socket::traits::Listener as _;
#[cfg(not(windows))]
use interprocess::local_socket::traits::Stream as _;
use interprocess::local_socket::{self as ls, ListenerOptions};

#[cfg(windows)]
mod win;

/// Random bytes in a token; the file holds them as hex.
pub const TOKEN_BYTES: usize = 32;

const TOKEN_FILE: &str = "token";

/// How long a Windows client waits for a pipe instance to come free.
#[cfg(windows)]
const CONNECT_WAIT: Duration = Duration::from_secs(2);

#[derive(Debug, thiserror::Error)]
pub enum IpcError {
    #[error("another process already listens on the endpoint")]
    InUse,
    #[error("nothing listens on the endpoint")]
    NotRunning,
    /// Only on Windows, where pipe names are machine-wide.
    #[error("another user's process listens on the endpoint")]
    Foreign,
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

/// `-dev` in a debug build: a debug build never meets a release service, nor
/// the other way round. Users of the crate put it in their own file names.
pub const CHANNEL: &str = if cfg!(debug_assertions) { "-dev" } else { "" };

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
        let options = ListenerOptions::new().name(self.socket_name()?);
        // A pipe takes the default DACL otherwise, which lets other users
        // open it; a socket file is kept to the user by its private dir.
        #[cfg(windows)]
        let options = {
            use interprocess::os::windows::local_socket::ListenerOptionsExt as _;
            options.security_descriptor(win::only_current_user()?)
        };
        options
            .create_sync()
            .map(Listener)
            .map_err(|e| match e.kind() {
                ErrorKind::AddrInUse => IpcError::InUse,
                // A pipe name that has a server already refuses a first
                // instance with access denied, whoever the server runs as.
                ErrorKind::PermissionDenied if cfg!(windows) => self.held_by(e),
                _ => IpcError::Io(e),
            })
    }

    /// Who holds the pipe name that refused a listener with `denied`.
    fn held_by(&self, denied: io::Error) -> IpcError {
        match self.connect() {
            Ok(_) => IpcError::InUse,
            Err(IpcError::Foreign) => IpcError::Foreign,
            Err(_) => IpcError::Io(denied),
        }
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

    /// `IpcError::NotRunning` when nothing answers; `IpcError::Foreign` on
    /// Windows when another user's process does.
    pub fn connect(&self) -> Result<Stream, IpcError> {
        self.open().map(Stream::new)
    }

    #[cfg(not(windows))]
    fn open(&self) -> Result<ls::Stream, IpcError> {
        self.socket_name()
            .and_then(ls::Stream::connect)
            .map_err(connect_error)
    }

    /// A pipe whose instances are all taken makes a client wait for one; the
    /// local socket API waits for ever, and ignores a wait mode. That wait
    /// never ends on a name that outlived its listener because a peer still
    /// holds a connected instance, so this one gives up at `CONNECT_WAIT`.
    ///
    /// Pipe names are machine-wide, so another user can create this one
    /// first and read what a client sends, the token included: the client
    /// talks only to a server that runs as its own user.
    #[cfg(windows)]
    fn open(&self) -> Result<ls::Stream, IpcError> {
        use interprocess::ConnectWaitMode;
        use interprocess::os::windows::named_pipe::{DuplexPipeStream, local_socket, pipe_mode};
        // The path `GenericNamespaced` gives the name.
        let path = format!(r"\\.\pipe\{}", self.name);
        let pipe = DuplexPipeStream::<pipe_mode::Bytes>::connect_by_path_with_wait_mode(
            path.as_str(),
            ConnectWaitMode::Timeout(CONNECT_WAIT),
        )
        .map_err(connect_error)?;
        // A server whose user cannot be told counts as another user's.
        match pipe.server_process_id().and_then(win::runs_as_current_user) {
            Ok(true) => Ok(local_socket::Stream::from(pipe).into()),
            _ => Err(IpcError::Foreign),
        }
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

fn connect_error(e: io::Error) -> IpcError {
    match e.kind() {
        ErrorKind::NotFound | ErrorKind::ConnectionRefused => IpcError::NotRunning,
        // A listener keeps a free instance at all times, so no free
        // instance for this long means no listener.
        ErrorKind::TimedOut if cfg!(windows) => IpcError::NotRunning,
        // Our listener's DACL lets this user in, so this pipe is another
        // user's.
        ErrorKind::PermissionDenied if cfg!(windows) => IpcError::Foreign,
        _ => IpcError::Io(e),
    }
}

pub struct Listener(ls::Listener);

impl Listener {
    pub fn accept(&self) -> Result<Stream, IpcError> {
        Ok(Stream::new(self.0.accept()?))
    }
}

pub struct Stream {
    // Declared before `inner`, so it stops before the handle it watches closes.
    #[cfg(windows)]
    watch: Option<win::Watchdog>,
    #[cfg(not(windows))]
    until: Option<Instant>,
    inner: ls::Stream,
}

impl Stream {
    fn new(inner: ls::Stream) -> Stream {
        Stream {
            #[cfg(windows)]
            watch: None,
            #[cfg(not(windows))]
            until: None,
            inner,
        }
    }

    /// A clone has no read deadline of its own.
    pub fn try_clone(&self) -> io::Result<Stream> {
        Ok(Stream::new(self.inner.try_clone()?))
    }

    /// Reads fail with `TimedOut` once `limit` from now has passed, until the
    /// next call; `None` lets them block for ever. On Windows a read blocked at
    /// the deadline is cancelled, so the caller can drop a silent peer.
    pub fn set_read_deadline(&mut self, limit: Option<Duration>) -> io::Result<()> {
        let until = limit.and_then(|d| Instant::now().checked_add(d));
        #[cfg(windows)]
        match (until, &self.watch) {
            (Some(until), Some(watch)) => watch.set(until),
            (Some(until), None) => {
                use std::os::windows::io::AsHandle;
                let ls::Stream::NamedPipe(pipe) = &self.inner;
                self.watch = Some(win::Watchdog::start(pipe.inner().as_handle(), until)?);
            }
            (None, _) => self.watch = None,
        }
        #[cfg(not(windows))]
        {
            self.until = until;
            if until.is_none() {
                recv_timeout(&self.inner, None)?;
            }
        }
        Ok(())
    }
}

impl Read for Stream {
    #[cfg(windows)]
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match &self.watch {
            Some(watch) => watch.read(|| self.inner.read(buf)),
            None => self.inner.read(buf),
        }
    }

    #[cfg(not(windows))]
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let Some(until) = self.until else {
            return self.inner.read(buf);
        };
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(timed_out());
        }
        recv_timeout(&self.inner, Some(left))?;
        match self.inner.read(buf) {
            Err(e) if e.kind() == ErrorKind::WouldBlock => Err(timed_out()),
            other => other,
        }
    }
}

/// macOS refuses the option with `EINVAL` once the peer has hung up; the
/// read that follows then sees the end of the stream at once, so that error
/// is not the caller's.
#[cfg(not(windows))]
fn recv_timeout(inner: &ls::Stream, limit: Option<Duration>) -> io::Result<()> {
    match inner.set_recv_timeout(limit) {
        Err(e) if e.kind() == ErrorKind::InvalidInput => Ok(()),
        other => other,
    }
}

#[cfg(not(windows))]
fn timed_out() -> io::Error {
    io::Error::new(ErrorKind::TimedOut, "no data before the read deadline")
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
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

    /// Another user's pipe, as this user sees it: one whose DACL leaves this
    /// user out (here it grants SYSTEM alone).
    #[cfg(windows)]
    #[test]
    fn a_pipe_this_user_may_not_open_is_foreign() {
        use interprocess::os::windows::local_socket::ListenerOptionsExt as _;
        use interprocess::os::windows::security_descriptor::SecurityDescriptor;
        let dir = tempfile::tempdir().unwrap();
        let e = ep(dir.path());
        let sd = SecurityDescriptor::deserialize(
            &widestring::U16CString::from_str("D:P(A;;GA;;;SY)").unwrap(),
        )
        .unwrap();
        let _theirs = ListenerOptions::new()
            .name(e.socket_name().unwrap())
            .security_descriptor(sd)
            .create_sync()
            .unwrap();
        assert!(matches!(e.connect(), Err(IpcError::Foreign)));
        assert!(matches!(e.bind(), Err(IpcError::Foreign)));
    }

    #[test]
    fn a_name_that_outlived_its_listener_is_not_running() {
        let dir = tempfile::tempdir().unwrap();
        let e = ep(dir.path());
        let listener = e.bind().unwrap();
        let _client = e.connect().unwrap();
        let _served = listener.accept().unwrap();
        drop(listener);
        // The connected pair still holds the name on Windows.
        assert!(matches!(e.connect(), Err(IpcError::NotRunning)));
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

    // Bounds are generous: they tell a read that gives up from one that hangs,
    // and shared CI runners are slow.
    const HANG: Duration = Duration::from_secs(5);

    #[test]
    fn a_read_deadline_ends_a_silent_read() {
        let dir = tempfile::tempdir().unwrap();
        let e = ep(dir.path());
        let listener = e.bind().unwrap();
        let server = thread::spawn(move || listener.accept().unwrap());
        let mut c = e.connect().unwrap();
        let _held = server.join().unwrap();
        c.set_read_deadline(Some(Duration::from_millis(100)))
            .unwrap();
        let start = Instant::now();
        let mut buf = [0; 1];
        let err = c.read(&mut buf).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::TimedOut, "{err}");
        assert!(start.elapsed() < HANG);
        // Past the deadline every read fails at once.
        assert_eq!(c.read(&mut buf).unwrap_err().kind(), ErrorKind::TimedOut);
    }

    #[test]
    fn a_new_deadline_or_none_reads_again() {
        let dir = tempfile::tempdir().unwrap();
        let e = ep(dir.path());
        let listener = e.bind().unwrap();
        let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
        let server = thread::spawn(move || {
            let mut s = listener.accept().unwrap();
            for byte in b"ab" {
                go_rx.recv().unwrap();
                s.write_all(&[*byte]).unwrap();
            }
            // Holds the pipe open until the client is done.
            let _ = go_rx.recv();
        });
        let mut c = e.connect().unwrap();
        let mut buf = [0; 1];
        c.set_read_deadline(Some(Duration::from_millis(50)))
            .unwrap();
        assert_eq!(c.read(&mut buf).unwrap_err().kind(), ErrorKind::TimedOut);
        // Nothing is lost to the read that gave up.
        c.set_read_deadline(Some(HANG)).unwrap();
        go_tx.send(()).unwrap();
        c.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"a");
        c.set_read_deadline(None).unwrap();
        go_tx.send(()).unwrap();
        c.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"b");
        drop(go_tx);
        server.join().unwrap();
    }

    #[test]
    fn a_deadline_lets_the_server_drop_a_silent_peer() {
        let dir = tempfile::tempdir().unwrap();
        let e = ep(dir.path());
        let listener = e.bind().unwrap();
        let server = thread::spawn(move || {
            let mut s = listener.accept().unwrap();
            let _w = s.try_clone().unwrap();
            s.set_read_deadline(Some(Duration::from_millis(100)))
                .unwrap();
            let mut buf = [0; 1];
            let err = s.read(&mut buf).unwrap_err();
            assert_eq!(err.kind(), ErrorKind::TimedOut, "{err}");
            // Both handles go here: the peer is cut off.
        });
        let mut c = e.connect().unwrap();
        server.join().unwrap();
        c.set_read_deadline(Some(HANG)).unwrap();
        let mut buf = [0; 1];
        // End of stream, not the client's own deadline.
        assert_eq!(c.read(&mut buf).unwrap(), 0);
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
