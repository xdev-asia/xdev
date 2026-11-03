//! The shells a terminal tab can open: the platform's own, WSL distros and
//! the owner's custom ones.

use std::env;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::detect::find_program;
use crate::profiles::{CustomShell, Profiles};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Powershell,
    Cmd,
    Wsl,
    Login,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ShellEntry {
    /// Without the `shell:` prefix: `powershell`, `wsl:Ubuntu`, a custom id.
    pub id: String,
    pub name: String,
    pub kind: ShellKind,
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// The shells to offer: the platform's own, then WSL distros (Windows), then
/// the custom ones.
pub fn list_shells(custom: &[CustomShell], distros: &[String]) -> Vec<ShellEntry> {
    list_shells_for(cfg!(windows), custom, distros)
}

/// `list_shells` for either platform, so both are testable anywhere.
fn list_shells_for(windows: bool, custom: &[CustomShell], distros: &[String]) -> Vec<ShellEntry> {
    let mut shells = Vec::new();
    if windows {
        shells.push(powershell());
        shells.push(ShellEntry {
            id: "cmd".to_owned(),
            name: "CMD".to_owned(),
            kind: ShellKind::Cmd,
            program: PathBuf::from("cmd.exe"),
            args: Vec::new(),
        });
        shells.extend(distros.iter().map(|distro| ShellEntry {
            id: format!("wsl:{distro}"),
            name: distro.clone(),
            kind: ShellKind::Wsl,
            program: PathBuf::from("wsl.exe"),
            args: vec!["-d".to_owned(), distro.clone()],
        }));
    } else {
        shells.push(ShellEntry {
            id: "login".to_owned(),
            name: "Login shell".to_owned(),
            kind: ShellKind::Login,
            program: login_program(),
            args: vec!["-l".to_owned()],
        });
    }
    shells.extend(custom.iter().map(|shell| ShellEntry {
        id: shell.id.clone(),
        name: shell.name.clone(),
        kind: ShellKind::Custom,
        program: PathBuf::from(&shell.program),
        args: shell.args.clone(),
    }));
    shells
}

/// `pwsh.exe` when installed, else Windows PowerShell.
fn powershell() -> ShellEntry {
    ShellEntry {
        id: "powershell".to_owned(),
        name: "PowerShell".to_owned(),
        kind: ShellKind::Powershell,
        program: find_program("pwsh.exe").unwrap_or_else(|| PathBuf::from("powershell.exe")),
        args: vec!["-NoLogo".to_owned()],
    }
}

/// `$SHELL`, else `/bin/sh`.
fn login_program() -> PathBuf {
    env::var_os("SHELL")
        .filter(|s| !s.is_empty())
        .map_or_else(|| PathBuf::from("/bin/sh"), PathBuf::from)
}

/// The id of the shell `shell` opens: the owner's default when it is listed,
/// else the platform's own.
pub fn default_shell_id(profiles: &Profiles, shells: &[ShellEntry]) -> String {
    let own = if cfg!(windows) { "powershell" } else { "login" };
    profiles
        .default_shell
        .as_deref()
        .filter(|id| shells.iter().any(|s| s.id == *id))
        .unwrap_or(own)
        .to_owned()
}

/// The distros `wsl.exe -l -q` lists. Empty when WSL is missing, when it
/// fails or when it does not answer in 3 seconds.
#[cfg(windows)]
pub fn wsl_distros() -> Vec<String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(mut child) = Command::new("wsl.exe")
        .args(["-l", "-q"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Vec::new();
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Vec::new();
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    match rx.recv_timeout(Duration::from_secs(3)) {
        // A failed listing prints a message, which must not pass for names.
        Ok(bytes) => match child.wait() {
            Ok(status) if status.success() => parse_wsl_list(&bytes),
            _ => Vec::new(),
        },
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Vec::new()
        }
    }
}

/// There is no WSL off Windows.
#[cfg(not(windows))]
pub fn wsl_distros() -> Vec<String> {
    Vec::new()
}

/// The names in `wsl.exe -l -q` output: UTF-16LE (with or without a BOM) or
/// UTF-8, one per line.
pub fn parse_wsl_list(bytes: &[u8]) -> Vec<String> {
    let text = if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        utf16(rest)
    } else if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(rest).into_owned()
    } else if looks_like_utf16(bytes) {
        utf16(bytes)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.lines()
        .map(|line| line.replace(['\0', '\u{feff}'], ""))
        .map(|line| line.trim().to_owned())
        .filter(|line| !line.is_empty())
        .collect()
}

fn utf16(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();
    String::from_utf16_lossy(&units)
}

/// Text in UTF-16LE has a NUL as the high byte of most Latin letters.
fn looks_like_utf16(bytes: &[u8]) -> bool {
    bytes.len() >= 2
        && bytes.len().is_multiple_of(2)
        && bytes.iter().skip(1).step_by(2).filter(|b| **b == 0).count() * 2 >= bytes.len() / 2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16_bytes(text: &str, bom: bool) -> Vec<u8> {
        let mut out = if bom { vec![0xFF, 0xFE] } else { Vec::new() };
        out.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        out
    }

    fn custom(id: &str) -> CustomShell {
        CustomShell {
            id: id.to_owned(),
            name: "Fish".to_owned(),
            program: "/usr/bin/fish".to_owned(),
            args: vec!["-l".to_owned()],
        }
    }

    fn ids(shells: &[ShellEntry]) -> Vec<&str> {
        shells.iter().map(|s| s.id.as_str()).collect()
    }

    #[test]
    fn parse_wsl_list_handles_bom_and_utf8() {
        assert_eq!(
            parse_wsl_list(&utf16_bytes("Ubuntu\r\nrancher-desktop\r\n", true)),
            ["Ubuntu", "rancher-desktop"]
        );
        assert_eq!(
            parse_wsl_list(&utf16_bytes("Ubuntu\r\n", false)),
            ["Ubuntu"]
        );
        assert_eq!(parse_wsl_list(b"Debian\n"), ["Debian"]);
        assert_eq!(
            parse_wsl_list(b"\xEF\xBB\xBFDebian\r\nKali\r\n"),
            ["Debian", "Kali"]
        );
        assert!(parse_wsl_list(b"").is_empty());
    }

    #[test]
    fn parse_wsl_list_drops_blank_lines_and_stray_nuls() {
        assert_eq!(
            parse_wsl_list(&utf16_bytes("\r\n  Ubuntu-22.04 \r\n\r\n\r\n", true)),
            ["Ubuntu-22.04"]
        );
        assert_eq!(parse_wsl_list(b"A\0\n\n B \n"), ["A", "B"]);
        assert!(parse_wsl_list(&utf16_bytes("\r\n", true)).is_empty());
        // A name outside ASCII survives; an odd trailing byte is dropped.
        let mut bytes = utf16_bytes("Ubuntu-\u{e9}\r\n", true);
        assert_eq!(parse_wsl_list(&bytes), ["Ubuntu-\u{e9}"]);
        bytes.push(0x41);
        assert_eq!(parse_wsl_list(&bytes), ["Ubuntu-\u{e9}"]);
    }

    #[test]
    fn wsl_entry_runs_the_distro() {
        let shells = list_shells_for(true, &[], &["Ubuntu".to_owned()]);
        let wsl = shells.iter().find(|s| s.id == "wsl:Ubuntu").unwrap();
        assert_eq!(wsl.kind, ShellKind::Wsl);
        assert_eq!(wsl.name, "Ubuntu");
        assert_eq!(wsl.program, PathBuf::from("wsl.exe"));
        assert_eq!(wsl.args, ["-d", "Ubuntu"]);
    }

    #[test]
    fn windows_lists_powershell_cmd_then_distros() {
        let shells = list_shells_for(true, &[], &["A".to_owned(), "B".to_owned()]);
        assert_eq!(ids(&shells), ["powershell", "cmd", "wsl:A", "wsl:B"]);
        let ps = &shells[0];
        assert_eq!(ps.kind, ShellKind::Powershell);
        assert_eq!(ps.name, "PowerShell");
        assert_eq!(ps.args, ["-NoLogo"]);
        let stem = ps
            .program
            .file_stem()
            .unwrap()
            .to_string_lossy()
            .to_lowercase();
        assert!(stem == "pwsh" || stem == "powershell", "{stem}");
        let cmd = &shells[1];
        assert_eq!(cmd.kind, ShellKind::Cmd);
        assert_eq!(cmd.program, PathBuf::from("cmd.exe"));
        assert!(cmd.args.is_empty());
    }

    #[test]
    fn unix_lists_the_login_shell_only() {
        let shells = list_shells_for(false, &[], &["Ubuntu".to_owned()]);
        assert_eq!(ids(&shells), ["login"]);
        assert_eq!(shells[0].kind, ShellKind::Login);
        assert_eq!(shells[0].name, "Login shell");
        assert_eq!(shells[0].args, ["-l"]);
        assert!(!shells[0].program.as_os_str().is_empty());
    }

    #[test]
    fn custom_shell_is_listed_last() {
        for windows in [true, false] {
            let shells = list_shells_for(windows, &[custom("fish")], &[]);
            let last = shells.last().unwrap();
            assert_eq!(last.id, "fish");
            assert_eq!(last.kind, ShellKind::Custom);
            assert_eq!(last.name, "Fish");
            assert_eq!(last.program, PathBuf::from("/usr/bin/fish"));
            assert_eq!(last.args, ["-l"]);
            assert!(shells.len() > 1);
        }
    }

    #[test]
    fn default_shell_falls_back_when_unknown() {
        let own = if cfg!(windows) { "powershell" } else { "login" };
        let shells = list_shells(&[custom("fish")], &[]);
        let mut p = Profiles::default();
        assert_eq!(default_shell_id(&p, &shells), own);
        p.default_shell = Some("fish".to_owned());
        assert_eq!(default_shell_id(&p, &shells), "fish");
        // A shell that is gone (a removed distro, a removed custom shell).
        p.default_shell = Some("wsl:Gone".to_owned());
        assert_eq!(default_shell_id(&p, &shells), own);
        assert_eq!(default_shell_id(&p, &[]), own);
    }

    #[test]
    fn shell_kind_is_lowercase_on_the_wire() {
        let json = serde_json::to_string(&ShellKind::Powershell).unwrap();
        assert_eq!(json, "\"powershell\"");
    }

    #[test]
    fn wsl_distros_never_panics() {
        // Whatever this machine has, the answer is a list of non-empty names.
        assert!(wsl_distros().iter().all(|d| !d.is_empty()));
    }
}
