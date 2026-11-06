//! A small SFTP v3 client (draft-ietf-secsh-filexfer-02) over any byte pipe,
//! in practice the stdin and stdout of `ssh -T -s <host> sftp`.
//!
//! Packets are `u32 len | u8 type | u32 id | …` and strings `u32 len |
//! bytes`. One request is in flight at a time. The read side runs on a
//! thread that hands whole packets over a channel, so every call can give up
//! after its timeout; a reply that comes after its request timed out is
//! dropped when it arrives.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use crate::rpath::RemoteError;

/// The largest packet either side sends or takes.
pub const MAX_PACKET: usize = 256 * 1024;

/// How much one `READ` or `WRITE` moves.
pub const CHUNK: u32 = 32 * 1024;

const FXP_INIT: u8 = 1;
const FXP_VERSION: u8 = 2;
const FXP_OPEN: u8 = 3;
const FXP_CLOSE: u8 = 4;
const FXP_READ: u8 = 5;
const FXP_WRITE: u8 = 6;
const FXP_LSTAT: u8 = 7;
const FXP_OPENDIR: u8 = 11;
const FXP_READDIR: u8 = 12;
const FXP_REMOVE: u8 = 13;
const FXP_MKDIR: u8 = 14;
const FXP_RMDIR: u8 = 15;
const FXP_REALPATH: u8 = 16;
const FXP_STAT: u8 = 17;
const FXP_RENAME: u8 = 18;
const FXP_STATUS: u8 = 101;
const FXP_HANDLE: u8 = 102;
const FXP_DATA: u8 = 103;
const FXP_NAME: u8 = 104;
const FXP_ATTRS: u8 = 105;
const FXP_EXTENDED: u8 = 200;

const FX_OK: u32 = 0;
const FX_EOF: u32 = 1;
const FX_NO_SUCH_FILE: u32 = 2;
const FX_PERMISSION_DENIED: u32 = 3;

pub const OPEN_READ: u32 = 0x01;
pub const OPEN_WRITE: u32 = 0x02;
pub const OPEN_CREAT: u32 = 0x08;
pub const OPEN_TRUNC: u32 = 0x10;
pub const OPEN_EXCL: u32 = 0x20;

const ATTR_SIZE: u32 = 0x01;
const ATTR_UIDGID: u32 = 0x02;
const ATTR_PERMISSIONS: u32 = 0x04;
const ATTR_ACMODTIME: u32 = 0x08;
const ATTR_EXTENDED: u32 = 0x8000_0000;

const S_IFMT: u32 = 0o170_000;
const S_IFDIR: u32 = 0o040_000;
const S_IFREG: u32 = 0o100_000;
const S_IFLNK: u32 = 0o120_000;

const POSIX_RENAME: &str = "posix-rename@openssh.com";

/// A `STATUS` reply that is not OK.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SftpError {
    pub code: u32,
    pub msg: String,
}

impl From<SftpError> for RemoteError {
    fn from(e: SftpError) -> Self {
        match e.code {
            FX_NO_SUCH_FILE => RemoteError::NotFound,
            FX_PERMISSION_DENIED => RemoteError::Denied,
            _ => RemoteError::Io(format!("sftp {}: {}", e.code, e.msg)),
        }
    }
}

/// What `stat` tells about an item. A field the server left out is `None`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Attrs {
    pub size: Option<u64>,
    pub permissions: Option<u32>,
    pub mtime: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

impl Attrs {
    /// From the permission bits; `Other` when the server sent none.
    pub fn kind(&self) -> EntryKind {
        match self.permissions.map(|p| p & S_IFMT) {
            Some(S_IFDIR) => EntryKind::Dir,
            Some(S_IFREG) => EntryKind::File,
            Some(S_IFLNK) => EntryKind::Symlink,
            _ => EntryKind::Other,
        }
    }

    pub fn is_dir(&self) -> bool {
        self.kind() == EntryKind::Dir
    }
}

/// One item of a folder; never `.` or `..`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    pub mtime: u32,
}

/// A connected SFTP session. `W` is the server's stdin; its stdout was handed
/// to the reader thread in `init`.
pub struct Sftp<W: Write> {
    w: W,
    rx: Receiver<Result<Vec<u8>, RemoteError>>,
    next_id: u32,
    /// Requests that timed out; their late replies are dropped.
    stale: HashSet<u32>,
    timeout: Duration,
    posix_rename: bool,
    extensions: Vec<(String, String)>,
}

/// Reads packets off `r` until it ends or the session is dropped.
fn reader<R: Read>(mut r: R, tx: mpsc::Sender<Result<Vec<u8>, RemoteError>>) {
    loop {
        let mut len = [0u8; 4];
        if let Err(e) = r.read_exact(&mut len) {
            let _ = tx.send(Err(e.into()));
            return;
        }
        let len = u32::from_be_bytes(len) as usize;
        if len == 0 || len > MAX_PACKET {
            let _ = tx.send(Err(RemoteError::Protocol(format!("packet length {len}"))));
            return;
        }
        let mut body = vec![0u8; len];
        if let Err(e) = r.read_exact(&mut body) {
            let _ = tx.send(Err(e.into()));
            return;
        }
        if tx.send(Ok(body)).is_err() {
            return;
        }
    }
}

/// A packet body being read.
struct Cursor<'a> {
    buf: &'a [u8],
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], RemoteError> {
        if self.buf.len() < n {
            return Err(RemoteError::Protocol("short packet".into()));
        }
        let (head, rest) = self.buf.split_at(n);
        self.buf = rest;
        Ok(head)
    }
    fn u8(&mut self) -> Result<u8, RemoteError> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, RemoteError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn u64(&mut self) -> Result<u64, RemoteError> {
        Ok((u64::from(self.u32()?) << 32) | u64::from(self.u32()?))
    }
    fn bytes(&mut self) -> Result<&'a [u8], RemoteError> {
        let n = self.u32()? as usize;
        self.take(n)
    }
    fn string(&mut self) -> Result<String, RemoteError> {
        Ok(String::from_utf8_lossy(self.bytes()?).into_owned())
    }
    fn attrs(&mut self) -> Result<Attrs, RemoteError> {
        let flags = self.u32()?;
        let mut a = Attrs::default();
        if flags & ATTR_SIZE != 0 {
            a.size = Some(self.u64()?);
        }
        if flags & ATTR_UIDGID != 0 {
            self.take(8)?;
        }
        if flags & ATTR_PERMISSIONS != 0 {
            a.permissions = Some(self.u32()?);
        }
        if flags & ATTR_ACMODTIME != 0 {
            self.u32()?;
            a.mtime = Some(self.u32()?);
        }
        if flags & ATTR_EXTENDED != 0 {
            for _ in 0..self.u32()? {
                self.bytes()?;
                self.bytes()?;
            }
        }
        Ok(a)
    }
}

/// A packet being written: the body after the length.
#[derive(Default)]
struct Packet {
    buf: Vec<u8>,
}

impl Packet {
    fn new(kind: u8) -> Self {
        Self { buf: vec![kind] }
    }
    fn u32(mut self, v: u32) -> Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }
    fn u64(mut self, v: u64) -> Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }
    fn bytes(self, b: &[u8]) -> Self {
        let mut p = self.u32(b.len() as u32);
        p.buf.extend_from_slice(b);
        p
    }
    fn str(self, s: &str) -> Self {
        self.bytes(s.as_bytes())
    }
    /// Attributes with only the permission bits, or none.
    fn attrs(self, mode: Option<u32>) -> Self {
        match mode {
            Some(m) => self.u32(ATTR_PERMISSIONS).u32(m),
            None => self.u32(0),
        }
    }
}

/// A reply: its type and what follows the id.
struct Reply {
    kind: u8,
    body: Vec<u8>,
}

impl Reply {
    fn cursor(&self) -> Cursor<'_> {
        Cursor { buf: &self.body }
    }

    /// The status of a `STATUS` reply, OK or not.
    fn status(&self) -> Result<SftpError, RemoteError> {
        let mut c = self.cursor();
        let code = c.u32()?;
        // Some servers end the packet after the code.
        let msg = c.string().unwrap_or_default();
        Ok(SftpError { code, msg })
    }

    /// `Ok` for a `STATUS` OK; a typed error for any other status; a
    /// protocol error for another type.
    fn expect_ok(self) -> Result<(), RemoteError> {
        if self.kind != FXP_STATUS {
            return Err(unexpected(self.kind));
        }
        let st = self.status()?;
        if st.code == FX_OK {
            Ok(())
        } else {
            Err(st.into())
        }
    }

    /// A reply of type `kind`, or the error a `STATUS` carries.
    fn expect(self, kind: u8) -> Result<Reply, RemoteError> {
        if self.kind == kind {
            return Ok(self);
        }
        if self.kind == FXP_STATUS {
            return Err(self.status()?.into());
        }
        Err(unexpected(self.kind))
    }

    /// Whether this is a `STATUS` EOF.
    fn is_eof(&self) -> bool {
        self.kind == FXP_STATUS && self.status().is_ok_and(|s| s.code == FX_EOF)
    }
}

fn unexpected(kind: u8) -> RemoteError {
    RemoteError::Protocol(format!("unexpected reply type {kind}"))
}

impl<W: Write> Sftp<W> {
    /// Sends `INIT` v3 and reads the server's `VERSION` and extensions.
    /// `r` is read on a thread of its own from here on.
    pub fn init<R: Read + Send + 'static>(
        r: R,
        w: W,
        timeout: Duration,
    ) -> Result<Self, RemoteError> {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("sftp-read".into())
            .spawn(move || reader(r, tx))
            .map_err(|e| RemoteError::Io(e.to_string()))?;
        let mut s = Sftp {
            w,
            rx,
            next_id: 1,
            stale: HashSet::new(),
            timeout,
            posix_rename: false,
            extensions: Vec::new(),
        };
        s.send(Packet::new(FXP_INIT).u32(3))?;
        let body = s.recv_packet()?;
        let mut c = Cursor { buf: &body };
        if c.u8()? != FXP_VERSION {
            return Err(RemoteError::Protocol("no VERSION".into()));
        }
        let version = c.u32()?;
        if version < 3 {
            return Err(RemoteError::Protocol(format!("version {version}")));
        }
        while !c.buf.is_empty() {
            let name = c.string()?;
            let data = c.string()?;
            s.extensions.push((name, data));
        }
        s.posix_rename = s.extensions.iter().any(|(n, _)| n == POSIX_RENAME);
        Ok(s)
    }

    /// The extensions the server named in `VERSION`.
    pub fn extensions(&self) -> &[(String, String)] {
        &self.extensions
    }

    /// Whether `rename` replaces an existing target (`posix-rename`).
    pub fn has_posix_rename(&self) -> bool {
        self.posix_rename
    }

    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    fn send(&mut self, p: Packet) -> Result<(), RemoteError> {
        if p.buf.len() + 4 > MAX_PACKET {
            return Err(RemoteError::TooLarge);
        }
        let mut out = Vec::with_capacity(p.buf.len() + 4);
        out.extend_from_slice(&(p.buf.len() as u32).to_be_bytes());
        out.extend_from_slice(&p.buf);
        self.w.write_all(&out)?;
        self.w.flush()?;
        Ok(())
    }

    fn recv_packet(&mut self) -> Result<Vec<u8>, RemoteError> {
        match self.rx.recv_timeout(self.timeout) {
            Ok(r) => r,
            Err(RecvTimeoutError::Timeout) => Err(RemoteError::Timeout),
            Err(RecvTimeoutError::Disconnected) => Err(RemoteError::Closed),
        }
    }

    /// Sends a request of `kind` built by `fill` after the id, and waits for
    /// the reply to it.
    fn call(
        &mut self,
        kind: u8,
        fill: impl FnOnce(Packet) -> Packet,
    ) -> Result<Reply, RemoteError> {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        self.send(fill(Packet::new(kind).u32(id)))?;
        loop {
            let body = match self.recv_packet() {
                Err(RemoteError::Timeout) => {
                    self.stale.insert(id);
                    return Err(RemoteError::Timeout);
                }
                other => other?,
            };
            let mut c = Cursor { buf: &body };
            let kind = c.u8()?;
            let got = c.u32()?;
            if got == id {
                return Ok(Reply {
                    kind,
                    body: c.buf.to_vec(),
                });
            }
            if !self.stale.remove(&got) {
                return Err(RemoteError::Protocol(format!(
                    "reply id {got}, expected {id}"
                )));
            }
        }
    }

    fn path_call(&mut self, kind: u8, path: &str) -> Result<Reply, RemoteError> {
        self.call(kind, |p| p.str(path))
    }

    /// The absolute, resolved form of `path` (`.` is the login folder).
    pub fn realpath(&mut self, path: &str) -> Result<String, RemoteError> {
        let r = self.path_call(FXP_REALPATH, path)?.expect(FXP_NAME)?;
        let mut c = r.cursor();
        if c.u32()? == 0 {
            return Err(RemoteError::Protocol("empty NAME".into()));
        }
        c.string()
    }

    /// Follows links.
    pub fn stat(&mut self, path: &str) -> Result<Attrs, RemoteError> {
        self.path_call(FXP_STAT, path)?
            .expect(FXP_ATTRS)?
            .cursor()
            .attrs()
    }

    /// Does not follow links.
    pub fn lstat(&mut self, path: &str) -> Result<Attrs, RemoteError> {
        self.path_call(FXP_LSTAT, path)?
            .expect(FXP_ATTRS)?
            .cursor()
            .attrs()
    }

    /// `stat`, with a missing item as `None`.
    pub fn try_lstat(&mut self, path: &str) -> Result<Option<Attrs>, RemoteError> {
        match self.lstat(path) {
            Ok(a) => Ok(Some(a)),
            Err(RemoteError::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn handle(r: Reply) -> Result<Vec<u8>, RemoteError> {
        Ok(r.expect(FXP_HANDLE)?.cursor().bytes()?.to_vec())
    }

    pub fn open(
        &mut self,
        path: &str,
        flags: u32,
        mode: Option<u32>,
    ) -> Result<Vec<u8>, RemoteError> {
        let r = self.call(FXP_OPEN, |p| p.str(path).u32(flags).attrs(mode))?;
        Self::handle(r)
    }

    pub fn close(&mut self, handle: &[u8]) -> Result<(), RemoteError> {
        self.call(FXP_CLOSE, |p| p.bytes(handle))?.expect_ok()
    }

    /// Up to `len` bytes at `offset`; `None` at the end of the file.
    pub fn read(
        &mut self,
        handle: &[u8],
        offset: u64,
        len: u32,
    ) -> Result<Option<Vec<u8>>, RemoteError> {
        let r = self.call(FXP_READ, |p| p.bytes(handle).u64(offset).u32(len))?;
        if r.is_eof() {
            return Ok(None);
        }
        Ok(Some(r.expect(FXP_DATA)?.cursor().bytes()?.to_vec()))
    }

    pub fn write(&mut self, handle: &[u8], offset: u64, data: &[u8]) -> Result<(), RemoteError> {
        self.call(FXP_WRITE, |p| p.bytes(handle).u64(offset).bytes(data))?
            .expect_ok()
    }

    /// Every item of the folder `path` but `.` and `..`, in the server's order.
    pub fn read_dir(&mut self, path: &str) -> Result<Vec<DirEntry>, RemoteError> {
        let handle = Self::handle(self.path_call(FXP_OPENDIR, path)?)?;
        let listed = self.read_dir_handle(&handle);
        let closed = self.close(&handle);
        let out = listed?;
        closed?;
        Ok(out)
    }

    fn read_dir_handle(&mut self, handle: &[u8]) -> Result<Vec<DirEntry>, RemoteError> {
        let mut out = Vec::new();
        loop {
            let r = self.call(FXP_READDIR, |p| p.bytes(handle))?;
            if r.is_eof() {
                return Ok(out);
            }
            let r = r.expect(FXP_NAME)?;
            let mut c = r.cursor();
            for _ in 0..c.u32()? {
                let name = c.string()?;
                let _long = c.bytes()?;
                let a = c.attrs()?;
                if name == "." || name == ".." {
                    continue;
                }
                out.push(DirEntry {
                    name,
                    kind: a.kind(),
                    size: a.size.unwrap_or(0),
                    mtime: a.mtime.unwrap_or(0),
                });
            }
        }
    }

    /// The whole file, in `CHUNK` reads; `TooLarge` once it passes `max`.
    pub fn read_file(&mut self, path: &str, max: u64) -> Result<Vec<u8>, RemoteError> {
        let handle = self.open(path, OPEN_READ, None)?;
        let read = self.read_handle(&handle, max);
        let closed = self.close(&handle);
        let out = read?;
        closed?;
        Ok(out)
    }

    fn read_handle(&mut self, handle: &[u8], max: u64) -> Result<Vec<u8>, RemoteError> {
        let mut out = Vec::new();
        while let Some(chunk) = self.read(handle, out.len() as u64, CHUNK)? {
            out.extend_from_slice(&chunk);
            if out.len() as u64 > max {
                return Err(RemoteError::TooLarge);
            }
        }
        Ok(out)
    }

    /// Creates or truncates `path` and writes `bytes`.
    pub fn write_file(&mut self, path: &str, bytes: &[u8]) -> Result<(), RemoteError> {
        self.write_file_mode(path, bytes, None)
    }

    /// `write_file`, with the mode a new file is created with.
    pub fn write_file_mode(
        &mut self,
        path: &str,
        bytes: &[u8],
        mode: Option<u32>,
    ) -> Result<(), RemoteError> {
        let handle = self.open(path, OPEN_CREAT | OPEN_TRUNC | OPEN_WRITE, mode)?;
        let mut wrote = Ok(());
        for (i, chunk) in bytes.chunks(CHUNK as usize).enumerate() {
            wrote = self.write(&handle, i as u64 * u64::from(CHUNK), chunk);
            if wrote.is_err() {
                break;
            }
        }
        let closed = self.close(&handle);
        wrote?;
        closed
    }

    /// An empty file; fails when the name is taken.
    pub fn create_new(&mut self, path: &str) -> Result<(), RemoteError> {
        let handle = self.open(path, OPEN_CREAT | OPEN_EXCL | OPEN_WRITE, None)?;
        self.close(&handle)
    }

    pub fn mkdir(&mut self, path: &str) -> Result<(), RemoteError> {
        self.call(FXP_MKDIR, |p| p.str(path).attrs(None))?
            .expect_ok()
    }

    /// With `posix-rename` when the server has it, which replaces `to`; the
    /// plain v3 rename fails when `to` exists.
    pub fn rename(&mut self, from: &str, to: &str) -> Result<(), RemoteError> {
        if self.posix_rename {
            self.call(FXP_EXTENDED, |p| p.str(POSIX_RENAME).str(from).str(to))?
                .expect_ok()
        } else {
            self.call(FXP_RENAME, |p| p.str(from).str(to))?.expect_ok()
        }
    }

    pub fn remove(&mut self, path: &str) -> Result<(), RemoteError> {
        self.path_call(FXP_REMOVE, path)?.expect_ok()
    }

    pub fn rmdir(&mut self, path: &str) -> Result<(), RemoteError> {
        self.path_call(FXP_RMDIR, path)?.expect_ok()
    }
}

#[cfg(test)]
pub(crate) mod fake {
    //! A scripted server: replies queued up front, requests kept to check.

    use std::collections::VecDeque;
    use std::io::{self, Read, Write};
    use std::sync::{Arc, Mutex};

    use super::*;

    /// Bytes the client reads; blocks (until `close`) once they run out,
    /// like a server that stops answering.
    /// The queued bytes and whether the server closed its end.
    type PipeState = (Mutex<(VecDeque<u8>, bool)>, std::sync::Condvar);

    #[derive(Clone, Default)]
    pub struct Pipe(Arc<PipeState>);

    impl Pipe {
        pub fn push(&self, bytes: &[u8]) {
            let (m, cv) = &*self.0;
            m.lock().unwrap().0.extend(bytes);
            cv.notify_all();
        }
        pub fn close(&self) {
            let (m, cv) = &*self.0;
            m.lock().unwrap().1 = true;
            cv.notify_all();
        }
    }

    impl Read for Pipe {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let (m, cv) = &*self.0;
            let mut g = m.lock().unwrap();
            while g.0.is_empty() && !g.1 {
                g = cv.wait(g).unwrap();
            }
            let n = buf.len().min(g.0.len());
            for (i, b) in g.0.drain(..n).enumerate() {
                buf[i] = b;
            }
            Ok(n)
        }
    }

    /// What the client wrote.
    #[derive(Clone, Default)]
    pub struct Sink(pub Arc<Mutex<VecDeque<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Sink {
        /// Each packet written so far, as `(type, body after the type)`.
        pub fn packets(&self) -> Vec<(u8, Vec<u8>)> {
            let bytes: Vec<u8> = self.0.lock().unwrap().iter().copied().collect();
            let mut out = Vec::new();
            let mut at = 0;
            while at + 4 <= bytes.len() {
                let len = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
                out.push((bytes[at + 4], bytes[at + 5..at + 4 + len].to_vec()));
                at += 4 + len;
            }
            out
        }
    }

    /// A framed packet.
    pub fn frame(kind: u8, id: Option<u32>, rest: &[u8]) -> Vec<u8> {
        let mut body = vec![kind];
        if let Some(id) = id {
            body.extend_from_slice(&id.to_be_bytes());
        }
        body.extend_from_slice(rest);
        let mut out = (body.len() as u32).to_be_bytes().to_vec();
        out.extend(body);
        out
    }

    pub fn s(b: &[u8]) -> Vec<u8> {
        let mut out = (b.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(b);
        out
    }

    pub fn version(exts: &[(&str, &str)]) -> Vec<u8> {
        let mut rest = 3u32.to_be_bytes().to_vec();
        for (n, d) in exts {
            rest.extend(s(n.as_bytes()));
            rest.extend(s(d.as_bytes()));
        }
        frame(FXP_VERSION, None, &rest)
    }

    pub fn status(id: u32, code: u32, msg: &str) -> Vec<u8> {
        let mut rest = code.to_be_bytes().to_vec();
        rest.extend(s(msg.as_bytes()));
        rest.extend(s(b""));
        frame(FXP_STATUS, Some(id), &rest)
    }

    pub fn ok(id: u32) -> Vec<u8> {
        status(id, FX_OK, "")
    }

    pub fn eof(id: u32) -> Vec<u8> {
        status(id, FX_EOF, "")
    }

    pub fn handle(id: u32, h: &[u8]) -> Vec<u8> {
        frame(FXP_HANDLE, Some(id), &s(h))
    }

    pub fn data(id: u32, d: &[u8]) -> Vec<u8> {
        frame(FXP_DATA, Some(id), &s(d))
    }

    /// Attributes with a size and permissions.
    pub fn attr_bytes(size: u64, perms: u32, mtime: u32) -> Vec<u8> {
        let mut a = (ATTR_SIZE | ATTR_PERMISSIONS | ATTR_ACMODTIME)
            .to_be_bytes()
            .to_vec();
        a.extend(size.to_be_bytes());
        a.extend(perms.to_be_bytes());
        a.extend(mtime.to_be_bytes());
        a.extend(mtime.to_be_bytes());
        a
    }

    pub fn attrs(id: u32, size: u64, perms: u32) -> Vec<u8> {
        frame(FXP_ATTRS, Some(id), &attr_bytes(size, perms, 7))
    }

    pub fn names(id: u32, items: &[(&str, u64, u32)]) -> Vec<u8> {
        let mut rest = (items.len() as u32).to_be_bytes().to_vec();
        for (n, size, perms) in items {
            rest.extend(s(n.as_bytes()));
            rest.extend(s(format!("-rw-r--r-- {n}").as_bytes()));
            rest.extend(attr_bytes(*size, *perms, 9));
        }
        frame(FXP_NAME, Some(id), &rest)
    }

    pub const DIR: u32 = 0o040_755;
    pub const FILE: u32 = 0o100_644;

    /// A session over a pipe that already holds `replies` after `VERSION`.
    pub fn session(exts: &[(&str, &str)], replies: &[Vec<u8>]) -> (Sftp<Sink>, Sink, Pipe) {
        let pipe = Pipe::default();
        pipe.push(&version(exts));
        for r in replies {
            pipe.push(r);
        }
        let sink = Sink::default();
        let sftp = Sftp::init(pipe.clone(), sink.clone(), Duration::from_secs(5)).unwrap();
        (sftp, sink, pipe)
    }
}

#[cfg(test)]
mod tests {
    use super::fake::*;
    use super::*;

    #[test]
    fn init_sends_version_3_and_reads_extensions() {
        let (sftp, sink, _p) = session(&[(POSIX_RENAME, "1"), ("statvfs@openssh.com", "2")], &[]);
        assert!(sftp.has_posix_rename());
        assert_eq!(sftp.extensions().len(), 2);
        assert_eq!(sink.packets(), [(FXP_INIT, 3u32.to_be_bytes().to_vec())]);
        let (plain, _, _p) = session(&[], &[]);
        assert!(!plain.has_posix_rename());
    }

    #[test]
    fn realpath_reads_the_first_name() {
        let (mut sftp, sink, _p) = session(&[], &[names(1, &[("/home/dev", 0, DIR)])]);
        assert_eq!(sftp.realpath(".").unwrap(), "/home/dev");
        let sent = &sink.packets()[1];
        assert_eq!(sent.0, FXP_REALPATH);
        let mut want = 1u32.to_be_bytes().to_vec();
        want.extend(s(b"."));
        assert_eq!(sent.1, want);
    }

    #[test]
    fn read_dir_over_two_batches() {
        let (mut sftp, sink, _p) = session(
            &[],
            &[
                handle(1, b"h1"),
                names(2, &[(".", 0, DIR), ("..", 0, DIR), ("src", 0, DIR)]),
                names(3, &[("README.md", 12, FILE)]),
                eof(4),
                ok(5),
            ],
        );
        let got = sftp.read_dir("/home/dev/app").unwrap();
        assert_eq!(
            got,
            [
                DirEntry {
                    name: "src".into(),
                    kind: EntryKind::Dir,
                    size: 0,
                    mtime: 9
                },
                DirEntry {
                    name: "README.md".into(),
                    kind: EntryKind::File,
                    size: 12,
                    mtime: 9
                },
            ]
        );
        let kinds: Vec<u8> = sink.packets().iter().map(|p| p.0).collect();
        assert_eq!(
            kinds,
            [
                FXP_INIT,
                FXP_OPENDIR,
                FXP_READDIR,
                FXP_READDIR,
                FXP_READDIR,
                FXP_CLOSE
            ]
        );
    }

    #[test]
    fn read_file_over_three_chunks() {
        let a = vec![b'a'; CHUNK as usize];
        let b = vec![b'b'; CHUNK as usize];
        let (mut sftp, sink, _p) = session(
            &[],
            &[
                handle(1, b"f"),
                data(2, &a),
                data(3, &b),
                data(4, b"tail"),
                eof(5),
                ok(6),
            ],
        );
        let got = sftp.read_file("/x", 1 << 20).unwrap();
        assert_eq!(got.len(), 2 * CHUNK as usize + 4);
        assert!(got.ends_with(b"tail"));
        // The third READ asks at the offset after two chunks.
        let reads: Vec<_> = sink
            .packets()
            .into_iter()
            .filter(|p| p.0 == FXP_READ)
            .collect();
        assert_eq!(reads.len(), 4);
        let off = &reads[2].1[4 + 4 + 1..4 + 4 + 1 + 8];
        assert_eq!(
            u64::from_be_bytes(off.try_into().unwrap()),
            2 * u64::from(CHUNK)
        );
    }

    #[test]
    fn read_file_too_large_closes_the_handle() {
        let a = vec![0u8; CHUNK as usize];
        let (mut sftp, sink, _p) = session(&[], &[handle(1, b"f"), data(2, &a), ok(3)]);
        assert_eq!(sftp.read_file("/x", 100), Err(RemoteError::TooLarge));
        assert_eq!(sink.packets().last().unwrap().0, FXP_CLOSE);
    }

    #[test]
    fn status_errors_map() {
        let (mut sftp, _s, _p) = session(
            &[],
            &[
                status(1, FX_PERMISSION_DENIED, "Permission denied"),
                status(2, FX_NO_SUCH_FILE, "No such file"),
                status(3, 4, "Failure"),
            ],
        );
        assert_eq!(sftp.stat("/root/x"), Err(RemoteError::Denied));
        assert_eq!(sftp.stat("/nope"), Err(RemoteError::NotFound));
        assert!(matches!(sftp.mkdir("/x"), Err(RemoteError::Io(m)) if m.contains("Failure")));
    }

    #[test]
    fn a_wrong_reply_id_is_an_error() {
        let (mut sftp, _s, _p) = session(&[], &[attrs(9, 1, FILE)]);
        assert!(matches!(sftp.stat("/x"), Err(RemoteError::Protocol(m)) if m.contains("id 9")));
    }

    #[test]
    fn a_call_times_out_and_its_late_reply_is_dropped() {
        let (mut sftp, _s, pipe) = session(&[], &[]);
        sftp.set_timeout(Duration::from_millis(50));
        assert_eq!(sftp.stat("/slow"), Err(RemoteError::Timeout));
        // The late reply to 1, then the reply to 2.
        pipe.push(&attrs(1, 5, FILE));
        pipe.push(&attrs(2, 6, FILE));
        sftp.set_timeout(Duration::from_secs(5));
        assert_eq!(sftp.stat("/next").unwrap().size, Some(6));
    }

    #[test]
    fn a_closed_pipe_is_closed() {
        let (mut sftp, _s, pipe) = session(&[], &[]);
        pipe.close();
        assert_eq!(sftp.stat("/x"), Err(RemoteError::Closed));
    }

    #[test]
    fn rename_uses_posix_rename_when_listed() {
        let (mut sftp, sink, _p) = session(&[(POSIX_RENAME, "1")], &[ok(1)]);
        sftp.rename("/a", "/b").unwrap();
        let p = &sink.packets()[1];
        assert_eq!(p.0, FXP_EXTENDED);
        assert!(
            p.1.windows(POSIX_RENAME.len())
                .any(|w| w == POSIX_RENAME.as_bytes())
        );
        let (mut plain, sink, _p) = session(&[], &[ok(1)]);
        plain.rename("/a", "/b").unwrap();
        assert_eq!(sink.packets()[1].0, FXP_RENAME);
    }

    #[test]
    fn write_file_opens_creat_trunc_write() {
        let big = vec![b'x'; CHUNK as usize + 1];
        let (mut sftp, sink, _p) = session(&[], &[handle(1, b"w"), ok(2), ok(3), ok(4)]);
        sftp.write_file("/x", &big).unwrap();
        let p = sink.packets();
        assert_eq!(p[1].0, FXP_OPEN);
        let flags = &p[1].1[4 + 4 + 2..4 + 4 + 2 + 4];
        assert_eq!(
            u32::from_be_bytes(flags.try_into().unwrap()),
            OPEN_CREAT | OPEN_TRUNC | OPEN_WRITE
        );
        let kinds: Vec<u8> = p.iter().map(|p| p.0).collect();
        assert_eq!(kinds, [FXP_INIT, FXP_OPEN, FXP_WRITE, FXP_WRITE, FXP_CLOSE]);
    }

    #[test]
    fn an_oversized_packet_is_refused() {
        let pipe = Pipe::default();
        pipe.push(&((MAX_PACKET as u32 + 1).to_be_bytes()));
        let r = Sftp::init(pipe, Sink::default(), Duration::from_secs(5));
        assert!(matches!(r, Err(RemoteError::Protocol(_))));
    }
}
