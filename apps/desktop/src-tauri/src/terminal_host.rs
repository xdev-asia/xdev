//! What this machine allows a terminal: the system PTY limit and which PowerShell is installed.

use std::collections::HashSet;

use serde::Serialize;
use tauri::State;
use xdev_agent::{Profiles, ShellEntry, find_program, list_shells};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalHostInfo {
    /// The system PTY limit: Linux `/proc/sys/kernel/pty/max`, macOS
    /// `sysctl -n kern.tty.ptmx_max`. None on Windows or when unreadable.
    pub pty_limit: Option<u32>,
    /// Windows: `pwsh.exe` is on PATH. Always false elsewhere.
    pub pwsh_found: bool,
    /// Windows: the default shell resolves to the built-in "powershell" entry.
    pub default_is_powershell: bool,
}

/// A positive number in `text`; None for anything else, zero included.
pub(crate) fn parse_pty_max(text: &str) -> Option<u32> {
    text.trim().parse::<u32>().ok().filter(|n| *n > 0)
}

/// Whether the default shell is the built-in PowerShell entry on a platform where the
/// platform default is `windows ? "powershell" : "login"`.
fn is_powershell_default(windows: bool, profiles: &Profiles, shells: &[ShellEntry]) -> bool {
    let own = if windows { "powershell" } else { "login" };
    let listed: HashSet<&str> = shells.iter().map(|s| s.id.as_str()).collect();
    let id = profiles
        .default_shell
        .as_deref()
        .filter(|id| listed.contains(id))
        .unwrap_or(own);
    id == "powershell"
}

#[cfg(target_os = "linux")]
fn system_pty_limit() -> Option<u32> {
    parse_pty_max(&std::fs::read_to_string("/proc/sys/kernel/pty/max").ok()?)
}

#[cfg(target_os = "macos")]
fn system_pty_limit() -> Option<u32> {
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let out = Command::new("sysctl")
            .args(["-n", "kern.tty.ptmx_max"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let _ = tx.send(out);
    });
    let out = rx.recv_timeout(Duration::from_secs(2)).ok()?.ok()?;
    parse_pty_max(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn system_pty_limit() -> Option<u32> {
    None
}

/// The limits Settings → Terminal shows. A value that cannot be read is None, not an error.
#[tauri::command(async)]
pub fn terminal_host_info(state: State<'_, AppState>) -> Result<TerminalHostInfo, CmdError> {
    let windows = cfg!(windows);
    let default_is_powershell = if windows {
        let profiles = Profiles::load(data_dir(&state)?).unwrap_or_default();
        let shells = list_shells(&profiles.shells, &[]);
        is_powershell_default(true, &profiles, &shells)
    } else {
        false
    };
    Ok(TerminalHostInfo {
        pty_limit: system_pty_limit(),
        pwsh_found: windows && find_program("pwsh.exe").is_some(),
        default_is_powershell,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use xdev_agent::{CustomShell, ShellKind};

    fn entry(id: &str) -> ShellEntry {
        ShellEntry {
            id: id.to_owned(),
            name: id.to_owned(),
            kind: ShellKind::Powershell,
            program: id.into(),
            args: vec![],
        }
    }

    #[test]
    fn parse_pty_max_reads_a_number() {
        assert_eq!(parse_pty_max("4096\n"), Some(4096));
        assert_eq!(parse_pty_max(""), None);
        assert_eq!(parse_pty_max("abc"), None);
        assert_eq!(parse_pty_max("0"), None);
    }

    #[test]
    fn default_is_powershell_follows_profiles() {
        let shells = [entry("powershell"), entry("cmd"), entry("mine")];
        let with = |id: Option<&str>| Profiles {
            default_shell: id.map(str::to_owned),
            shells: vec![CustomShell {
                id: "mine".into(),
                name: "Mine".into(),
                program: "mine".into(),
                args: vec![],
            }],
            ..Profiles::default()
        };
        assert!(is_powershell_default(true, &with(None), &shells));
        assert!(is_powershell_default(
            true,
            &with(Some("powershell")),
            &shells
        ));
        assert!(!is_powershell_default(true, &with(Some("cmd")), &shells));
        assert!(!is_powershell_default(true, &with(Some("mine")), &shells));
        // An id that is not listed falls back to the platform default.
        assert!(is_powershell_default(true, &with(Some("gone")), &shells));
        assert!(!is_powershell_default(false, &with(None), &shells));
    }
}
