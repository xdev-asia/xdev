//! Live TCP ports per worktree. A port belongs to a worktree when the
//! process listening on it is the shell of one of its terminals or a
//! descendant of it. The scan and the stop run here, off the main thread;
//! the sidebar polls the scan only while its card shows the Ports part.

use std::collections::{HashMap, HashSet};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::CmdError;
use crate::pty::Ptys;

/// One TCP listener of a worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LivePort {
    pub port: u16,
    /// Where it listens: `127.0.0.1`, `0.0.0.0`, `::1`, ...
    pub address: String,
    pub pid: u32,
    /// The program's name; none when the process table does not name it.
    pub process: Option<String>,
}

/// A worktree and the terminals that run in it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PortQuery {
    pub path: String,
    pub pty_ids: Vec<String>,
}

/// The listeners of one queried worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WorktreePorts {
    pub path: String,
    pub ports: Vec<LivePort>,
}

/// A listening socket and the process that holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Listener {
    port: u16,
    address: String,
    pid: u32,
}

/// One row of the process table.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Proc {
    pid: u32,
    ppid: u32,
    name: String,
}

/// The listeners that descend from one of `roots`, by port then address, each once.
fn attribute(listeners: &[Listener], table: &[Proc], roots: &[u32]) -> Vec<LivePort> {
    let parents: HashMap<u32, &Proc> = table.iter().map(|p| (p.pid, p)).collect();
    let mut out: Vec<LivePort> = listeners
        .iter()
        .filter(|l| descends(l.pid, &parents, roots))
        .map(|l| LivePort {
            port: l.port,
            address: l.address.clone(),
            pid: l.pid,
            process: parents
                .get(&l.pid)
                .map(|p| p.name.clone())
                .filter(|n| !n.is_empty()),
        })
        .collect();
    out.sort_by(|a, b| (a.port, &a.address, a.pid).cmp(&(b.port, &b.address, b.pid)));
    out.dedup_by(|a, b| a.port == b.port && a.address == b.address && a.pid == b.pid);
    out
}

/// Whether `pid` is one of `roots` or has one as an ancestor. A loop in the
/// table (a reused pid) ends the walk.
fn descends(pid: u32, table: &HashMap<u32, &Proc>, roots: &[u32]) -> bool {
    let mut seen = HashSet::new();
    let mut at = pid;
    while seen.insert(at) {
        if roots.contains(&at) {
            return true;
        }
        match table.get(&at) {
            Some(p) if p.ppid != 0 => at = p.ppid,
            _ => return false,
        }
    }
    false
}

/// `host:port` as the OS tools print it: `[::1]:80`, `*:80`, `127.0.0.1:80`.
fn split_endpoint(text: &str) -> Option<(String, u16)> {
    let (host, port) = text.rsplit_once(':')?;
    let port = port.parse().ok()?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let host = if host == "*" { "0.0.0.0" } else { host };
    Some((host.to_owned(), port))
}

/// Listening rows of `/proc/net/tcp` (`v6` for `tcp6`): port, address, socket inode.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn parse_proc_net(text: &str, v6: bool) -> Vec<(u16, String, u64)> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            // 0A is TCP_LISTEN.
            if f.get(3) != Some(&"0A") {
                return None;
            }
            let (addr, port) = f.get(1)?.split_once(':')?;
            let port = u16::from_str_radix(port, 16).ok()?;
            let address = if v6 { hex_v6(addr)? } else { hex_v4(addr)? };
            let inode = f.get(9)?.parse().ok()?;
            Some((port, address, inode))
        })
        .collect()
}

/// `0100007F` (the host's byte order) as `127.0.0.1`.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn hex_v4(hex: &str) -> Option<String> {
    let n = u32::from_str_radix(hex, 16).ok()?;
    Some(std::net::Ipv4Addr::from(n.swap_bytes()).to_string())
}

/// 32 hex digits, four words each in the host's byte order.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn hex_v6(hex: &str) -> Option<String> {
    if hex.len() != 32 {
        return None;
    }
    let mut bytes = [0u8; 16];
    for (i, word) in (0..4).map(|i| (i, &hex[i * 8..i * 8 + 8])) {
        let n = u32::from_str_radix(word, 16).ok()?;
        bytes[i * 4..i * 4 + 4].copy_from_slice(&n.swap_bytes().to_be_bytes());
    }
    Some(std::net::Ipv6Addr::from(bytes).to_string())
}

/// `lsof -nP -iTCP -sTCP:LISTEN -F pcn`: a `p` line, then `c` and `n` lines for it.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn parse_lsof(text: &str) -> Vec<Listener> {
    let mut pid = None;
    let mut out = Vec::new();
    for line in text.lines() {
        let Some((tag, rest)) = line.split_at_checked(1) else {
            continue;
        };
        match tag {
            "p" => pid = rest.parse().ok(),
            "n" => {
                if let (Some(pid), Some((address, port))) = (pid, split_endpoint(rest)) {
                    out.push(Listener { port, address, pid });
                }
            }
            _ => {}
        }
    }
    out
}

/// `netstat -ano -p tcp` (or `tcpv6`): a listening row is a foreign endpoint with
/// port 0. The state word is localized and may be several words, so it is not read;
/// the pid is the last column.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn parse_netstat(text: &str) -> Vec<Listener> {
    text.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 5 || !f[0].eq_ignore_ascii_case("TCP") {
                return None;
            }
            let (address, port) = split_endpoint(f[1])?;
            let (_, foreign) = split_endpoint(f[2])?;
            if foreign != 0 {
                return None;
            }
            Some(Listener {
                port,
                address,
                pid: f.last()?.parse().ok()?,
            })
        })
        .collect()
}

/// `/proc/<pid>/stat`: `pid (comm) state ppid ...`; the name may hold spaces and brackets.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn parse_stat(text: &str) -> Option<Proc> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let pid = text[..open].trim().parse().ok()?;
    let ppid = text[close + 1..].split_whitespace().nth(1)?.parse().ok()?;
    Some(Proc {
        pid,
        ppid,
        name: text[open + 1..close].to_owned(),
    })
}

/// `ps -axo pid=,ppid=,comm=`: two numbers, then the command path.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn parse_ps(text: &str) -> Vec<Proc> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let (pid, rest) = line.split_once(char::is_whitespace)?;
            let (ppid, command) = rest.trim_start().split_once(char::is_whitespace)?;
            let command = command.trim();
            let name = command.rsplit('/').next().unwrap_or(command);
            Some(Proc {
                pid: pid.parse().ok()?,
                ppid: ppid.parse().ok()?,
                name: name.to_owned(),
            })
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn listeners() -> Vec<Listener> {
    use std::fs;
    let mut sockets: HashMap<u64, (u16, String)> = HashMap::new();
    for (file, v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
        if let Ok(text) = fs::read_to_string(file) {
            for (port, address, inode) in parse_proc_net(&text, v6) {
                sockets.insert(inode, (port, address));
            }
        }
    }
    if sockets.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let Ok(procs) = fs::read_dir("/proc") else {
        return out;
    };
    for entry in procs.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        // Another user's process refuses the read; it is skipped.
        let Ok(fds) = fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(target) = fs::read_link(fd.path()) else {
                continue;
            };
            let target = target.to_string_lossy();
            let inode = target
                .strip_prefix("socket:[")
                .and_then(|r| r.strip_suffix(']'))
                .and_then(|n| n.parse::<u64>().ok());
            if let Some((port, address)) = inode.and_then(|i| sockets.get(&i)) {
                out.push(Listener {
                    port: *port,
                    address: address.clone(),
                    pid,
                });
            }
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn listeners() -> Vec<Listener> {
    Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"])
        .output()
        .map(|o| parse_lsof(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

#[cfg(windows)]
fn listeners() -> Vec<Listener> {
    use std::os::windows::process::CommandExt;
    // A GUI app must not flash a console window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    ["tcp", "tcpv6"]
        .iter()
        .flat_map(|family| {
            Command::new("netstat")
                .args(["-ano", "-p", family])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map(|o| parse_netstat(&String::from_utf8_lossy(&o.stdout)))
                .unwrap_or_default()
        })
        .collect()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn listeners() -> Vec<Listener> {
    Vec::new()
}

#[cfg(target_os = "linux")]
fn process_table() -> Vec<Proc> {
    let Ok(procs) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    procs
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()))
        })
        .filter_map(|e| parse_stat(&std::fs::read_to_string(e.path().join("stat")).ok()?))
        .collect()
}

#[cfg(target_os = "macos")]
fn process_table() -> Vec<Proc> {
    Command::new("ps")
        .args(["-axo", "pid=,ppid=,comm="])
        .output()
        .map(|o| parse_ps(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn process_table() -> Vec<Proc> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    // SAFETY: the snapshot handle is checked before use and closed once; `entry` is a plain
    // struct of integers and a wide-char array, zeroed, with `dwSize` set as the API asks.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            out.push(Proc {
                pid: entry.th32ProcessID,
                ppid: entry.th32ParentProcessID,
                name: String::from_utf16_lossy(&entry.szExeFile[..len]),
            });
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    out
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn process_table() -> Vec<Proc> {
    Vec::new()
}

/// The shells of the terminals `ids` name; an id that has gone is skipped.
fn roots_of(ptys: &Ptys, ids: &[String]) -> Vec<u32> {
    ids.iter()
        .filter_map(|id| ptys.with(id, |h| h.pid()).ok().flatten())
        .collect()
}

/// The ports of each query, from the given roots, listeners and table.
fn scan_with(
    queries: &[PortQuery],
    roots: &[Vec<u32>],
    listeners: &[Listener],
    table: &[Proc],
) -> Vec<WorktreePorts> {
    queries
        .iter()
        .zip(roots)
        .map(|(q, roots)| WorktreePorts {
            path: q.path.clone(),
            ports: attribute(listeners, table, roots),
        })
        .collect()
}

/// The live ports of each worktree asked for, in the order asked. Nothing is
/// read from the OS when no queried terminal is running.
// Off the main thread: the OS tools take a moment.
#[tauri::command(async)]
pub fn ports_scan(ptys: State<'_, Ptys>, queries: Vec<PortQuery>) -> Vec<WorktreePorts> {
    let roots: Vec<Vec<u32>> = queries
        .iter()
        .map(|q| roots_of(&ptys, &q.pty_ids))
        .collect();
    if roots.iter().all(Vec::is_empty) {
        return scan_with(&queries, &roots, &[], &[]);
    }
    scan_with(&queries, &roots, &listeners(), &process_table())
}

/// Ends `pid` and what it started when it descends from `roots`; `kill`
/// does the ending.
fn stop_with(
    roots: &[u32],
    pid: u32,
    confirmed: bool,
    table: &[Proc],
    kill: impl FnOnce(u32),
) -> Result<(), CmdError> {
    if !confirmed {
        return Err(CmdError {
            code: "needs_approval",
            detail: None,
        });
    }
    // The process is checked again here: the id came from a scan that may be old.
    let by_pid: HashMap<u32, &Proc> = table.iter().map(|p| (p.pid, p)).collect();
    if !descends(pid, &by_pid, roots) {
        return Err(CmdError {
            code: "port_unknown",
            detail: None,
        });
    }
    kill(pid);
    Ok(())
}

/// Stops the process behind a port of a worktree, once the person confirmed.
// Off the main thread: ending a process tree waits on the OS.
#[tauri::command(async)]
pub fn port_stop(
    ptys: State<'_, Ptys>,
    pty_ids: Vec<String>,
    pid: u32,
    confirmed: bool,
) -> Result<(), CmdError> {
    if !confirmed {
        return stop_with(&[], pid, false, &[], |_| {});
    }
    let roots = roots_of(&ptys, &pty_ids);
    stop_with(&roots, pid, true, &process_table(), |pid| {
        xdev_ai::process::kill_tree(pid);
        // `kill_tree` signals a process group on Unix; a listener that is not a group leader needs its own.
        #[cfg(unix)]
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status();
    })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    use super::*;

    fn l(port: u16, address: &str, pid: u32) -> Listener {
        Listener {
            port,
            address: address.to_owned(),
            pid,
        }
    }
    fn p(pid: u32, ppid: u32, name: &str) -> Proc {
        Proc {
            pid,
            ppid,
            name: name.to_owned(),
        }
    }

    #[test]
    fn a_port_belongs_to_a_root_or_its_descendants() {
        // 10 shell > 11 npm > 12 node (listens); 20 is another worktree's shell.
        let table = [
            p(1, 0, "init"),
            p(10, 1, "bash"),
            p(11, 10, "npm"),
            p(12, 11, "node"),
            p(20, 1, "bash"),
            p(21, 20, "python"),
        ];
        let listeners = [
            l(5173, "127.0.0.1", 12),
            l(8000, "0.0.0.0", 21),
            l(22, "0.0.0.0", 1),
        ];
        let mine = attribute(&listeners, &table, &[10]);
        assert_eq!(mine.len(), 1);
        assert_eq!((mine[0].port, mine[0].pid), (5173, 12));
        assert_eq!(mine[0].process.as_deref(), Some("node"));
        let other = attribute(&listeners, &table, &[20]);
        assert_eq!(other.iter().map(|x| x.port).collect::<Vec<_>>(), [8000]);
        assert!(attribute(&listeners, &table, &[]).is_empty());
        // The root itself counts.
        assert_eq!(attribute(&[l(1, "::1", 10)], &table, &[10]).len(), 1);
    }

    #[test]
    fn attribution_sorts_by_port_then_address_and_dedupes() {
        let table = [p(10, 1, "bash"), p(11, 10, "a")];
        let listeners = [
            l(9000, "127.0.0.1", 11),
            l(80, "::1", 11),
            l(80, "0.0.0.0", 11),
            l(80, "0.0.0.0", 11),
        ];
        let out = attribute(&listeners, &table, &[10]);
        assert_eq!(
            out.iter()
                .map(|x| (x.port, x.address.as_str()))
                .collect::<Vec<_>>(),
            [(80, "0.0.0.0"), (80, "::1"), (9000, "127.0.0.1")]
        );
    }

    #[test]
    fn attribution_survives_a_parent_loop() {
        let table = [p(5, 6, "a"), p(6, 5, "b")];
        assert!(attribute(&[l(1, "x", 5)], &table, &[99]).is_empty());
        assert_eq!(attribute(&[l(1, "x", 5)], &table, &[6]).len(), 1);
    }

    #[test]
    fn a_missing_name_comes_back_as_none() {
        let table = [p(10, 0, "")];
        assert_eq!(attribute(&[l(1, "x", 10)], &table, &[10])[0].process, None);
        assert_eq!(attribute(&[l(1, "x", 11)], &table, &[11])[0].process, None);
    }

    #[test]
    fn proc_net_keeps_listeners_and_reads_the_address() {
        let text = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0\n\
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222 1 0000000000000000 100 0 0 10 0\n\
   2: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0000000000000000 20 4 30 10 -1\n";
        assert_eq!(
            parse_proc_net(text, false),
            vec![
                (8080, "127.0.0.1".to_owned(), 12345),
                (22, "0.0.0.0".to_owned(), 222)
            ]
        );
    }

    #[test]
    fn proc_net_reads_ipv6() {
        let text = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1 0000000000000000 100 0 0 10 0\n\
   1: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 778 1 0000000000000000 100 0 0 10 0\n";
        assert_eq!(
            parse_proc_net(text, true),
            vec![(3000, "::1".to_owned(), 777), (8080, "::".to_owned(), 778)]
        );
    }

    #[test]
    fn lsof_output_gives_each_listener_its_process() {
        let text = "p812\ncnode\nn127.0.0.1:3000\nn[::1]:3000\np900\ncpython3.12\nn*:8000\nn*:Z\n";
        assert_eq!(
            parse_lsof(text),
            vec![
                l(3000, "127.0.0.1", 812),
                l(3000, "::1", 812),
                l(8000, "0.0.0.0", 900)
            ]
        );
    }

    #[test]
    fn netstat_keeps_listening_rows_whatever_the_state_word() {
        let text = "\nActive Connections\n\n  Proto  Local Address          Foreign Address        State           PID\n\
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1120\n\
  TCP    127.0.0.1:5173         0.0.0.0:0              ĐANG NGHE       4242\n\
  TCP    127.0.0.1:50422        127.0.0.1:5173         ESTABLISHED     7000\n\
  TCP    [::1]:8080             [::]:0                 LISTENING       4243\n\
  UDP    0.0.0.0:5353           *:*                                    1120\n";
        assert_eq!(
            parse_netstat(text),
            vec![
                l(135, "0.0.0.0", 1120),
                l(5173, "127.0.0.1", 4242),
                l(8080, "::1", 4243)
            ]
        );
    }

    #[test]
    fn proc_stat_and_ps_name_the_parent() {
        let stat = parse_stat("1234 (my (odd) app) S 77 1234 1234 0 -1 4194560").unwrap();
        assert_eq!(
            (stat.pid, stat.ppid, stat.name.as_str()),
            (1234, 77, "my (odd) app")
        );
        assert!(parse_stat("garbage").is_none());
        let ps = parse_ps(
            "    1     0 /sbin/launchd\n  501   1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n",
        );
        assert_eq!(ps[0], p(1, 0, "launchd"));
        assert_eq!(
            (ps[1].pid, ps[1].ppid, ps[1].name.as_str()),
            (501, 1, "Electron")
        );
    }

    #[test]
    fn scan_pairs_each_query_with_its_roots() {
        let table = [p(10, 1, "bash"), p(11, 10, "node"), p(20, 1, "bash")];
        let queries = [
            PortQuery {
                path: "/a".into(),
                pty_ids: vec![],
            },
            PortQuery {
                path: "/b".into(),
                pty_ids: vec![],
            },
        ];
        let out = scan_with(
            &queries,
            &[vec![10], vec![20]],
            &[l(3000, "127.0.0.1", 11)],
            &table,
        );
        assert_eq!(out[0].path, "/a");
        assert_eq!(out[0].ports.len(), 1);
        assert_eq!(out[1].path, "/b");
        assert!(out[1].ports.is_empty());
    }

    #[test]
    fn stop_needs_confirmation_and_checks_the_pid_again() {
        let table = [p(10, 1, "bash"), p(11, 10, "node"), p(20, 1, "other")];
        let killed = Cell::new(None);
        // Without `confirmed` nothing is checked or killed.
        let err = stop_with(&[10], 11, false, &table, |pid| killed.set(Some(pid))).unwrap_err();
        assert_eq!(err.code, "needs_approval");
        assert_eq!(killed.get(), None);
        // A process outside the worktree's terminals is refused.
        let err = stop_with(&[10], 20, true, &table, |pid| killed.set(Some(pid))).unwrap_err();
        assert_eq!(err.code, "port_unknown");
        assert_eq!(killed.get(), None);
        // A pid that is not in the table at all is refused too.
        assert_eq!(
            stop_with(&[10], 999, true, &table, |_| {})
                .unwrap_err()
                .code,
            "port_unknown"
        );
        // A descendant of a terminal is ended.
        stop_with(&[10], 11, true, &table, |pid| killed.set(Some(pid))).unwrap();
        assert_eq!(killed.get(), Some(11));
    }

    #[test]
    fn a_socket_this_test_holds_is_found_and_attributed() {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        let me = std::process::id();
        let deadline = Instant::now() + Duration::from_secs(5);
        let found = loop {
            let live = attribute(&listeners(), &process_table(), &[me]);
            if let Some(hit) = live.into_iter().find(|x| x.port == port) {
                break Some(hit);
            }
            if Instant::now() > deadline {
                break None;
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let hit = found.expect("the bound port is listed");
        assert_eq!(hit.pid, me);
        assert_eq!(hit.address, "127.0.0.1");
        drop(socket);
    }
}
