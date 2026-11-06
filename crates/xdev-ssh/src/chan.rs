//! An exec channel: one long-lived `ssh -T <host> sh` whose stdin takes one
//! script at a time. Each script's output ends with a line that holds a
//! random nonce and the exit code, so the output of one command is told
//! from the next without a new connection per call.

use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use crate::rpath::RemoteError;

/// The most stdout one script may print.
pub const OUTPUT_MAX: usize = 16 * 1024 * 1024;

/// What a script printed and how it exited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChanOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
}

/// The shell's stdin is `W`; its stdout went to the reader thread in `new`.
pub struct ExecChannel<W: Write> {
    w: W,
    rx: Receiver<Result<Vec<u8>, RemoteError>>,
    /// Bytes read past the last sentinel.
    buf: Vec<u8>,
    /// The nonce of a run that timed out: its output is still coming.
    stale: Option<String>,
    /// The reader ended; every later run fails.
    closed: bool,
}

fn reader<R: Read>(mut r: R, tx: mpsc::Sender<Result<Vec<u8>, RemoteError>>) {
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match r.read(&mut chunk) {
            Ok(0) => {
                let _ = tx.send(Err(RemoteError::Closed));
                return;
            }
            Ok(n) => {
                if tx.send(Ok(chunk[..n].to_vec())).is_err() {
                    return;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                let _ = tx.send(Err(e.into()));
                return;
            }
        }
    }
}

/// 16 random hex digits.
fn nonce() -> Result<String, RemoteError> {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).map_err(|e| RemoteError::Io(e.to_string()))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// The text a script with `nonce` is sent as. Stderr is dropped; the
/// sentinel's leading newline ends output that had none.
pub fn wrap_script(script: &str, nonce: &str) -> String {
    // A newline, not `;`, before `}`: a script that ends in `&` or a
    // comment still parses.
    format!("{{ {script}\n}} 2>/dev/null; printf '\\n__XDEV_{nonce}__%d\\n' $?\n")
}

/// Where the sentinel of `nonce` is in `buf`: `(start, end, code)`, with
/// `start` at its leading newline and `end` past its trailing one.
fn find_sentinel(buf: &[u8], nonce: &str) -> Option<(usize, usize, i32)> {
    let mark = format!("\n__XDEV_{nonce}__");
    let mark = mark.as_bytes();
    let mut from = 0;
    while let Some(at) = buf[from..].windows(mark.len()).position(|w| w == mark) {
        let start = from + at;
        let digits_at = start + mark.len();
        let rest = &buf[digits_at..];
        let nl = rest.iter().position(|&b| b == b'\n')?;
        let code = std::str::from_utf8(&rest[..nl])
            .ok()
            .and_then(|s| s.parse::<i32>().ok());
        if let Some(code) = code {
            return Some((start, digits_at + nl + 1, code));
        }
        from = start + 1;
    }
    None
}

impl<W: Write> ExecChannel<W> {
    /// `r` is the shell's stdout; it is read on a thread of its own.
    pub fn new<R: Read + Send + 'static>(r: R, w: W) -> Result<Self, RemoteError> {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("ssh-exec-read".into())
            .spawn(move || reader(r, tx))
            .map_err(|e| RemoteError::Io(e.to_string()))?;
        Ok(Self {
            w,
            rx,
            buf: Vec::new(),
            stale: None,
            closed: false,
        })
    }

    /// Reads until the sentinel of `nonce`; the output before it, or
    /// `TooLarge` (after the rest was read and dropped) when it passed
    /// `OUTPUT_MAX`.
    fn read_until(&mut self, nonce: &str, deadline: Instant) -> Result<ChanOutput, RemoteError> {
        let mut over = false;
        // How much of `buf` was searched; the next search starts 64 bytes
        // before it, more than a sentinel's length, for one cut in two.
        let mut scanned = 0usize;
        loop {
            let from = scanned.saturating_sub(64);
            if let Some((start, end, code)) = find_sentinel(&self.buf[from..], nonce) {
                let (start, end) = (from + start, from + end);
                let too_large = over || start > OUTPUT_MAX;
                let mut stdout: Vec<u8> = self.buf.drain(..end).collect();
                if too_large {
                    return Err(RemoteError::TooLarge);
                }
                stdout.truncate(start);
                return Ok(ChanOutput { code, stdout });
            }
            scanned = self.buf.len();
            if self.buf.len() > OUTPUT_MAX + 64 {
                over = true;
                // Keep the tail where a sentinel may be cut in two.
                let keep = self.buf.split_off(self.buf.len() - 64);
                self.buf = keep;
                scanned = 0;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(Ok(chunk)) => self.buf.extend_from_slice(&chunk),
                Ok(Err(e)) => {
                    self.closed = true;
                    return Err(e);
                }
                Err(RecvTimeoutError::Timeout) => return Err(RemoteError::Timeout),
                Err(RecvTimeoutError::Disconnected) => {
                    self.closed = true;
                    return Err(RemoteError::Closed);
                }
            }
        }
    }

    /// Runs `script` in the remote shell and waits up to `timeout` for it.
    /// A run that timed out leaves its output in flight; the next run reads
    /// past it first, within its own timeout.
    pub fn run(&mut self, script: &str, timeout: Duration) -> Result<ChanOutput, RemoteError> {
        if self.closed {
            return Err(RemoteError::Closed);
        }
        let deadline = Instant::now() + timeout;
        if let Some(old) = self.stale.clone() {
            match self.read_until(&old, deadline) {
                Ok(_) | Err(RemoteError::TooLarge) => self.stale = None,
                Err(e) => return Err(e),
            }
        }
        let nonce = nonce()?;
        self.w.write_all(wrap_script(script, &nonce).as_bytes())?;
        self.w.flush()?;
        match self.read_until(&nonce, deadline) {
            Err(RemoteError::Timeout) => {
                self.stale = Some(nonce);
                Err(RemoteError::Timeout)
            }
            other => other,
        }
    }
}

#[cfg(test)]
pub(crate) mod fake {
    //! A shell that answers each script with canned output and the sentinel
    //! of the nonce it was sent.

    use std::collections::VecDeque;
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};

    use crate::sftp::fake::Pipe;

    /// Canned `(stdout, exit code)` answers.
    pub type Answers = Arc<Mutex<VecDeque<(Vec<u8>, i32)>>>;

    /// Answers queued in order: `(stdout, code)`. Each written script gets
    /// the next one, with the sentinel built from its nonce.
    #[derive(Clone)]
    pub struct Shell {
        pub out: Pipe,
        pub answers: Answers,
        pub scripts: Arc<Mutex<Vec<String>>>,
    }

    impl Shell {
        pub fn new(answers: Vec<(Vec<u8>, i32)>) -> Self {
            Self {
                out: Pipe::default(),
                answers: Arc::new(Mutex::new(answers.into())),
                scripts: Arc::default(),
            }
        }
    }

    impl Write for Shell {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let text = String::from_utf8_lossy(buf).into_owned();
            let nonce = text
                .split("__XDEV_")
                .nth(1)
                .and_then(|r| r.get(..16))
                .unwrap_or_default()
                .to_owned();
            let script = text
                .strip_prefix("{ ")
                .and_then(|t| t.split_once("\n} 2>/dev/null;"))
                .map(|(s, _)| s.to_owned())
                .unwrap_or_default();
            self.scripts.lock().unwrap().push(script);
            if let Some((stdout, code)) = self.answers.lock().unwrap().pop_front() {
                let mut reply = stdout;
                reply.extend(format!("\n__XDEV_{nonce}__{code}\n").into_bytes());
                self.out.push(&reply);
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::Shell;
    use super::*;
    use crate::sftp::fake::{Pipe, Sink};

    const T: Duration = Duration::from_secs(5);

    fn chan(answers: Vec<(Vec<u8>, i32)>) -> (ExecChannel<Shell>, Shell) {
        let shell = Shell::new(answers);
        (
            ExecChannel::new(shell.out.clone(), shell.clone()).unwrap(),
            shell,
        )
    }

    #[test]
    fn wraps_the_script() {
        assert_eq!(
            wrap_script("git status", "0123456789abcdef"),
            "{ git status\n} 2>/dev/null; printf '\\n__XDEV_0123456789abcdef__%d\\n' $?\n"
        );
        let n = nonce().unwrap();
        assert_eq!(n.len(), 16);
        assert!(n.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(n, nonce().unwrap());
    }

    #[test]
    fn output_without_a_trailing_newline() {
        let (mut c, shell) = chan(vec![(b"/home/dev".to_vec(), 0), (b"a\nb\n".to_vec(), 0)]);
        assert_eq!(
            c.run("printf %s \"$HOME\"", T).unwrap(),
            ChanOutput {
                code: 0,
                stdout: b"/home/dev".to_vec()
            }
        );
        assert_eq!(c.run("ls", T).unwrap().stdout, b"a\nb\n");
        assert_eq!(
            *shell.scripts.lock().unwrap(),
            ["printf %s \"$HOME\"", "ls"]
        );
    }

    #[test]
    fn a_nonzero_exit_code() {
        let (mut c, _s) = chan(vec![(Vec::new(), 128)]);
        assert_eq!(
            c.run("git status", T).unwrap(),
            ChanOutput {
                code: 128,
                stdout: Vec::new()
            }
        );
    }

    #[test]
    fn a_fake_sentinel_with_another_nonce_is_output() {
        let fake = b"x\n__XDEV_ffffffffffffffff__0\ny".to_vec();
        let (mut c, _s) = chan(vec![(fake.clone(), 3)]);
        assert_eq!(
            c.run("cat f", T).unwrap(),
            ChanOutput {
                code: 3,
                stdout: fake
            }
        );
    }

    #[test]
    fn output_over_the_cap_is_too_large_and_the_channel_stays_in_step() {
        let big = vec![b'z'; OUTPUT_MAX + 10];
        let (mut c, _s) = chan(vec![(big, 0), (b"ok".to_vec(), 0)]);
        assert!(matches!(c.run("cat big", T), Err(RemoteError::TooLarge)));
        assert_eq!(c.run("echo ok", T).unwrap().stdout, b"ok");
    }

    #[test]
    fn a_timeout_then_the_next_run_skips_the_late_output() {
        let pipe = Pipe::default();
        let sink = Sink::default();
        let mut c = ExecChannel::new(pipe.clone(), sink.clone()).unwrap();
        assert_eq!(
            c.run("sleep 9", Duration::from_millis(50)),
            Err(RemoteError::Timeout)
        );
        let sent: Vec<u8> = sink.0.lock().unwrap().iter().copied().collect();
        let sent = String::from_utf8(sent).unwrap();
        let old = &sent.split("__XDEV_").nth(1).unwrap()[..16];
        pipe.push(format!("late\n__XDEV_{old}__0\n").as_bytes());
        // The next run's own answer cannot be scripted without its nonce, so
        // it times out after reading past the late output.
        assert_eq!(
            c.run("true", Duration::from_millis(50)),
            Err(RemoteError::Timeout)
        );
        assert!(c.buf.is_empty());
    }

    #[test]
    fn a_closed_shell_is_closed() {
        let pipe = Pipe::default();
        let mut c = ExecChannel::new(pipe.clone(), Sink::default()).unwrap();
        pipe.close();
        assert_eq!(c.run("true", T), Err(RemoteError::Closed));
        assert_eq!(c.run("true", T), Err(RemoteError::Closed));
    }
}
