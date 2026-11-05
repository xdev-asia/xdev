//! The real machine: listener tables, the process list and the stop signal.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::{Listener, Proc, ScanError};

/// A GUI app must not flash a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Runs `cmd` and returns its standard output, or `Timeout` once `limit` has
/// passed (the child is killed then).
pub(crate) fn run_with_timeout(cmd: &mut Command, limit: Duration) -> Result<String, ScanError> {
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(cmd, CREATE_NO_WINDOW);
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| ScanError::Failed(format!("{:?}: {e}", cmd.get_program())))?;
    let mut out = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(out) = out.as_mut() {
            let _ = out.read_to_end(&mut bytes);
        }
        bytes
    });
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let bytes = reader.join().unwrap_or_default();
                if !status.success() && bytes.is_empty() {
                    return Err(ScanError::Failed(format!(
                        "{:?} exited with {status}",
                        cmd.get_program()
                    )));
                }
                return Ok(String::from_utf8_lossy(&bytes).into_owned());
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(ScanError::Timeout);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(ScanError::Failed(e.to_string())),
        }
    }
}

/// Every process this user can see, with command line and working folder
/// where the OS allows it.
pub(crate) fn processes() -> Result<Vec<Proc>, ScanError> {
    let mut system = System::new().map_err(|e| ScanError::Failed(e.to_string()))?;
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(UpdateKind::Always)
            .with_cwd(UpdateKind::Always),
    );
    Ok(system
        .processes()
        .iter()
        .map(|(pid, p)| Proc {
            pid: pid.as_u32(),
            ppid: p.parent().map(|p| p.as_u32()),
            name: p.name().to_string_lossy().into_owned(),
            cmd: p
                .cmd()
                .iter()
                .map(|a| a.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" "),
            cwd: p.cwd().map(std::path::Path::to_path_buf),
            start: Some(p.start_time()),
        })
        .collect())
}

/// Whether the output of a stop command says the process was already gone.
pub(crate) fn already_gone(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    text.contains("no such process") || text.contains("not found") || text.contains("no running")
}

/// `pid` and every process under it, parents before children, from the
/// parent links in `procs`. Read before any signal: a child whose parent has
/// ended is moved under another parent and could not be found after.
#[cfg(any(unix, test))]
pub(crate) fn tree_of(pid: u32, procs: &[Proc]) -> Vec<u32> {
    let mut out = vec![pid];
    let mut i = 0;
    while i < out.len() {
        let parent = out[i];
        for p in procs {
            if p.ppid == Some(parent) && p.pid != parent && !out.contains(&p.pid) {
                out.push(p.pid);
            }
        }
        i += 1;
    }
    out
}

/// Ends `pid` and its tree, the same way `xdev_ai::process::kill_tree` does
/// on Windows (`taskkill /T /F`). On Unix the listener is seldom a group
/// leader, so each pid of the tree gets the signal: TERM, or KILL when `hard`.
pub(crate) fn stop_tree(pid: u32, hard: bool) -> Result<(), ScanError> {
    #[cfg(windows)]
    let mut cmd = {
        let _ = hard;
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        std::os::windows::process::CommandExt::creation_flags(&mut cmd, CREATE_NO_WINDOW);
        cmd
    };
    #[cfg(unix)]
    let mut cmd = {
        let program = if cfg!(target_os = "macos") {
            "/bin/kill"
        } else {
            "kill"
        };
        let pids = tree_of(pid, &processes().unwrap_or_default());
        let mut cmd = Command::new(program);
        cmd.arg(if hard { "-KILL" } else { "-TERM" }).arg("--");
        cmd.args(pids.iter().map(u32::to_string));
        cmd
    };
    let output = cmd
        .stdin(Stdio::null())
        .output()
        .map_err(|e| ScanError::Failed(e.to_string()))?;
    if output.status.success() {
        return Ok(());
    }
    let said = format!(
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    // On Unix one pid of the tree may have ended between the read and the signal.
    if already_gone(&said) {
        return Ok(());
    }
    Err(ScanError::Failed(said.trim().to_owned()))
}

/// TCP sockets in the LISTEN state.
#[cfg(windows)]
pub(crate) fn listeners(timeout: Duration) -> Result<Vec<Listener>, ScanError> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let netstat = format!(r"{root}\System32\netstat.exe");
    let mut all = Vec::new();
    for family in ["tcp", "tcpv6"] {
        let mut cmd = Command::new(&netstat);
        cmd.args(["-ano", "-p", family]);
        all.extend(crate::parse::parse_netstat_windows(&run_with_timeout(
            &mut cmd, timeout,
        )?));
    }
    Ok(all)
}

#[cfg(target_os = "macos")]
pub(crate) fn listeners(timeout: Duration) -> Result<Vec<Listener>, ScanError> {
    let mut lsof = Command::new("/usr/sbin/lsof");
    lsof.args(["-nP", "-O", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
    match run_with_timeout(&mut lsof, timeout) {
        Ok(text) => Ok(crate::parse::parse_lsof(&text)),
        Err(ScanError::Timeout) => Err(ScanError::Timeout),
        Err(_) => {
            let mut netstat = Command::new("/usr/sbin/netstat");
            netstat.args(["-aln", "-p", "tcp"]);
            Ok(crate::parse::parse_netstat_macos(&run_with_timeout(
                &mut netstat,
                timeout,
            )?))
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn listeners(timeout: Duration) -> Result<Vec<Listener>, ScanError> {
    use std::collections::HashMap;

    let started = Instant::now();
    let mut rows = Vec::new();
    for (file, v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
        // IPv6 may be switched off; its table is then absent.
        if let Ok(text) = std::fs::read_to_string(file) {
            rows.extend(crate::parse::parse_proc_net_tcp(&text, v6));
        }
    }
    // Socket inode -> pid, from the descriptors this user may read.
    let mut owner: HashMap<u64, u32> = HashMap::new();
    if let Ok(dir) = std::fs::read_dir("/proc") {
        for entry in dir.flatten() {
            if started.elapsed() > timeout {
                return Err(ScanError::Timeout);
            }
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
                continue;
            };
            for fd in fds.flatten() {
                let Ok(target) = std::fs::read_link(fd.path()) else {
                    continue;
                };
                let target = target.to_string_lossy();
                if let Some(inode) = target
                    .strip_prefix("socket:[")
                    .and_then(|t| t.strip_suffix(']'))
                    .and_then(|t| t.parse::<u64>().ok())
                {
                    owner.entry(inode).or_insert(pid);
                }
            }
        }
    }
    Ok(rows
        .into_iter()
        .map(|(bind_host, port, inode)| Listener {
            bind_host,
            port,
            pid: owner.get(&inode).copied(),
        })
        .collect())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub(crate) fn listeners(_timeout: Duration) -> Result<Vec<Listener>, ScanError> {
    Err(ScanError::Unsupported)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, ppid: Option<u32>) -> Proc {
        Proc {
            pid,
            ppid,
            name: String::new(),
            cmd: String::new(),
            cwd: None,
            start: None,
        }
    }

    #[test]
    fn the_tree_holds_every_descendant_once_and_survives_a_loop() {
        let procs = [
            p(1, None),
            p(10, Some(1)),
            p(11, Some(10)),
            p(12, Some(10)),
            p(13, Some(12)),
            p(20, Some(1)),
            // A loop must not hang the walk.
            p(30, Some(31)),
            p(31, Some(30)),
        ];
        assert_eq!(tree_of(10, &procs), vec![10, 11, 12, 13]);
        assert_eq!(tree_of(30, &procs), vec![30, 31]);
        assert_eq!(tree_of(99, &procs), vec![99]);
    }

    #[test]
    fn a_process_that_is_already_gone_counts_as_stopped() {
        assert!(already_gone("kill: (123) - No such process"));
        assert!(already_gone("ERROR: The process \"123\" not found."));
        assert!(!already_gone("Access is denied."));
    }

    #[test]
    fn a_command_that_runs_too_long_is_cut_off() {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("ping");
            c.args(["-n", "30", "127.0.0.1"]);
            c
        } else {
            let mut c = Command::new("sleep");
            c.arg("30");
            c
        };
        let started = Instant::now();
        let result = run_with_timeout(&mut cmd, Duration::from_secs(2));
        assert_eq!(result, Err(ScanError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
