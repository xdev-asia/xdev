use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use crate::GitError;

/// A hook or a GPG prompt can wait forever; the UI must not.
const TIMEOUT: Duration = Duration::from_secs(60);
/// Push, pull and fetch talk to a remote and may transfer a lot.
pub(crate) const LONG_TIMEOUT: Duration = Duration::from_secs(300);
const POLL: Duration = Duration::from_millis(20);

/// Runs git and fails on any non-zero exit.
pub(crate) fn run(
    workdir: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Result<Vec<u8>, GitError> {
    checked(args, spawn(workdir, args, stdin, true, TIMEOUT)?)
}

/// For commands that talk to a remote: the long timeout, and the whole
/// result, because the caller classifies a failure by its exit code and
/// output instead of treating it as one error.
pub(crate) fn run_long(workdir: &Path, args: &[&str]) -> Result<Output, GitError> {
    spawn(workdir, args, None, true, LONG_TIMEOUT)
}

/// Like `run`, but the whole result survives a failure, so the caller can
/// show what a hook printed.
pub(crate) fn run_output(
    workdir: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Result<Output, GitError> {
    spawn(workdir, args, stdin, true, TIMEOUT)
}

/// Like `run`, but pathspecs keep their magic. Only for callers that write
/// the magic themselves, such as `:(top,glob)` in front of every entry.
pub(crate) fn run_magic(workdir: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
    checked(args, spawn(workdir, args, None, false, TIMEOUT)?)
}

fn checked(args: &[&str], out: Output) -> Result<Vec<u8>, GitError> {
    if out.status != Some(0) {
        return Err(GitError::Failed {
            args: args.join(" "),
            status: out.status,
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        });
    }
    Ok(out.stdout)
}

/// For callers that branch on the exit code. Git's messages are translated,
/// so the code is the only reliable signal.
pub(crate) fn run_status(
    workdir: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Result<(Option<i32>, Vec<u8>), GitError> {
    let out = spawn(workdir, args, stdin, true, TIMEOUT)?;
    Ok((out.status, out.stdout))
}

pub(crate) struct Output {
    pub(crate) status: Option<i32>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

fn spawn(
    workdir: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
    literal: bool,
    timeout: Duration,
) -> Result<Output, GitError> {
    // Otherwise a missing folder fails the spawn with `NotFound` on Unix,
    // which would read as "git is not installed".
    if !workdir.is_dir() {
        return Err(GitError::Io(io::Error::new(
            io::ErrorKind::NotFound,
            workdir.display().to_string(),
        )));
    }

    let mut cmd = Command::new("git");
    cmd.current_dir(workdir)
        .args(args)
        // Never wait for a password; a status must not rewrite `.git/index`
        // behind the user's back.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Paths are file names, not patterns: `[a].md` must not also match
        // `a.md`, and a leading `:` must not be read as pathspec magic.
        .env("GIT_LITERAL_PATHSPECS", if literal { "1" } else { "0" })
        // Pathspec meaning is chosen by the caller alone; these would turn
        // globs off, on or case-blind behind its back.
        .env_remove("GIT_ICASE_PATHSPECS")
        .env_remove("GIT_NOGLOB_PATHSPECS")
        .env_remove("GIT_GLOB_PATHSPECS")
        // Set when xDev itself is started from a git hook; they would point
        // every call at another repo or index.
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => GitError::NoGit,
        _ => GitError::Io(e),
    })?;

    // Each pipe is drained on its own thread so a full pipe cannot block
    // git while we wait for it to exit.
    let stdout = read_on_thread(child.stdout.take());
    let stderr = read_on_thread(child.stderr.take());
    if let (Some(mut pipe), Some(input)) = (child.stdin.take(), stdin) {
        let input = input.to_vec();
        // Git may exit without reading stdin; a broken pipe is not an error.
        thread::spawn(move || {
            let _ = pipe.write_all(&input);
        });
    }

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(GitError::Timeout);
        }
        thread::sleep(POLL);
    };

    // A process started by a hook may keep the pipes open after git exits.
    let left = || deadline.saturating_duration_since(Instant::now());
    let stdout = stdout.recv_timeout(left()).map_err(|_| GitError::Timeout)?;
    let stderr = stderr.recv_timeout(left()).map_err(|_| GitError::Timeout)?;
    Ok(Output {
        status: status.code(),
        stdout,
        stderr,
    })
}

fn read_on_thread(pipe: Option<impl Read + Send + 'static>) -> Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        let _ = tx.send(buf);
    });
    rx
}
