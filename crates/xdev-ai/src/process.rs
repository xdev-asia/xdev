//! Stopping an AI CLI together with everything it started.

use std::process::{Command, Stdio};

/// Its own group, so a kill reaches what the agent started too.
pub fn own_group(cmd: &mut Command) {
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(cmd, 0);
    #[cfg(not(unix))]
    let _ = cmd;
}

/// Agent CLIs start through shims (`claude.cmd`, `node`), so killing only
/// the child would leave the real agent editing the worktree after a stop.
/// Must run while the child is still alive: Windows finds the tree by
/// parent id.
pub fn kill_tree(pid: u32) {
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

/// The soft stop: SIGTERM to the group on POSIX. Windows has no signal; the
/// caller closes stdin instead.
pub fn term_group(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", "--", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(unix))]
    let _ = pid;
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    /// A parent that starts a long-lived grandchild and prints its pid.
    fn parent_with_grandchild() -> Command {
        if cfg!(windows) {
            let mut cmd = Command::new("powershell");
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$p = Start-Process -FilePath ping -ArgumentList '-n','30','127.0.0.1' \
                 -NoNewWindow -PassThru; [Console]::Out.WriteLine($p.Id); \
                 [Console]::Out.Flush(); $p.WaitForExit()",
            ]);
            cmd
        } else {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "sleep 30 & echo $!; wait"]);
            cmd
        }
    }

    fn alive(pid: u32) -> bool {
        if cfg!(windows) {
            let out = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
        } else {
            Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        }
    }

    #[test]
    fn kill_tree_reaches_the_grandchild() {
        let mut cmd = parent_with_grandchild();
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        own_group(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        // The grandchild shares the pipe, so its own output may come first.
        let grandchild: u32 = loop {
            let mut line = String::new();
            assert!(stdout.read_line(&mut line).unwrap() > 0, "no pid printed");
            if let Ok(pid) = line.trim().parse() {
                break pid;
            }
        };
        // The grandchild keeps writing; a full pipe must not be what stops it.
        thread::spawn(move || std::io::copy(&mut stdout, &mut std::io::sink()));
        assert!(alive(grandchild), "grandchild {grandchild} never started");

        kill_tree(child.id());
        let _ = child.kill();
        let _ = child.wait();

        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(grandchild) {
            assert!(
                Instant::now() < deadline,
                "grandchild {grandchild} survived"
            );
            thread::sleep(Duration::from_millis(100));
        }
    }
}
