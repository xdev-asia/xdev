use std::io::{self, Read};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use crate::Cancel;

const POLL: Duration = Duration::from_millis(50);
/// After the child is gone, how long a grandchild that still holds a pipe
/// may keep us.
const DRAIN: Duration = Duration::from_secs(5);

pub(crate) struct Captured {
    pub status: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
    /// Killed because `cancel` was set.
    pub cancelled: bool,
}

/// Runs `cmd` with stdin closed and both pipes read, killing it at
/// `timeout` or once `cancel` is set. Neither is an error, so the caller can
/// still read whatever it printed.
pub(crate) fn capture(
    mut cmd: Command,
    timeout: Duration,
    cancel: &Cancel,
) -> io::Result<Captured> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Its own group, so a kill reaches what the agent started too.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn()?;
    // Each pipe on its own thread, so a full pipe cannot stall the child.
    let stdout = read_on_thread(child.stdout.take());
    let stderr = read_on_thread(child.stderr.take());

    let deadline = Instant::now() + timeout;
    let (status, timed_out, cancelled) = loop {
        if let Some(status) = child.try_wait()? {
            break (status.code(), false, false);
        }
        let timed_out = Instant::now() >= deadline;
        let cancelled = !timed_out && cancel.is_cancelled();
        if timed_out || cancelled {
            kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            break (None, timed_out, cancelled);
        }
        thread::sleep(POLL);
    };

    Ok(Captured {
        status,
        stdout: stdout.recv_timeout(DRAIN).unwrap_or_default(),
        stderr: stderr.recv_timeout(DRAIN).unwrap_or_default(),
        timed_out,
        cancelled,
    })
}

/// Agent CLIs start through shims (`claude.cmd`, `node`), so killing only
/// the child would leave the real agent editing the worktree after a stop.
/// Must run while the child is still alive: Windows finds the tree by
/// parent id.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A GUI app must not flash a console window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A shell whose own child outlives it unless the whole tree is killed;
    /// that grandchild holds stdout, so a survivor keeps `capture` for
    /// `DRAIN`.
    fn shell_with_grandchild() -> Command {
        if cfg!(windows) {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "ping -n 30 127.0.0.1"]);
            cmd
        } else {
            let mut cmd = Command::new("sh");
            // `; :` stops the shell from exec-ing into `sleep`.
            cmd.args(["-c", "sleep 30; :"]);
            cmd
        }
    }

    #[test]
    fn timeout_kills_the_whole_process_tree() {
        let start = Instant::now();
        let out = capture(
            shell_with_grandchild(),
            Duration::from_millis(500),
            &Cancel::new(),
        )
        .unwrap();
        assert!(out.timed_out);
        assert!(
            start.elapsed() < Duration::from_secs(4),
            "{:?}",
            start.elapsed()
        );
    }

    #[test]
    fn cancel_kills_the_whole_process_tree() {
        let cancel = Cancel::new();
        let flag = cancel.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(500));
            flag.cancel();
        });
        let start = Instant::now();
        let out = capture(shell_with_grandchild(), Duration::from_secs(60), &cancel).unwrap();
        assert!(out.cancelled);
        assert!(
            start.elapsed() < Duration::from_secs(4),
            "{:?}",
            start.elapsed()
        );
    }
}
