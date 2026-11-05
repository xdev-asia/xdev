//! The `PATH` agents are found on. A GUI app starts with a thin `PATH` on
//! macOS and Linux (no shell rc files) and, on Windows, with the one it was
//! launched with, so an agent installed after that is not found. `refresh`
//! reads the PATH a new terminal would get; the caller keeps it (see
//! `xdev_agent::set_path_override`), the process env is not changed.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// How long the login shell may take to print its PATH.
pub const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg_attr(windows, allow(dead_code))]
const MARK: &str = "__xdev_path__";

/// The PATH between the two markers of `output`. A login shell may print
/// anything from its rc files before and after.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn shell_path_parse(output: &str) -> Option<OsString> {
    let start = output.find(MARK)? + MARK.len();
    let len = output[start..].find(MARK)?;
    let path = output[start..start + len].trim();
    (!path.is_empty()).then(|| OsString::from(path))
}

/// Runs `program args` and returns its stdout, or `None` when it fails or
/// is still running after `timeout` (then it is killed).
pub(crate) fn capture(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.by_ref().take(1 << 20).read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    match rx.recv_timeout(timeout) {
        Ok(bytes) => {
            let status = child.wait().ok()?;
            status
                .success()
                .then(|| String::from_utf8_lossy(&bytes).into_owned())
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// The PATH of an interactive login shell.
#[cfg(not(windows))]
fn login_shell_path(timeout: Duration) -> Option<OsString> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_owned());
    let script = format!("printf '{MARK}%s{MARK}' \"$PATH\"");
    shell_path_parse(&capture(&shell, &["-lic", &script], timeout)?)
}

#[cfg_attr(not(windows), allow(dead_code))]
/// `Path` from the output of `reg query <key> /v Path`, with `%NAME%`
/// expanded.
pub(crate) fn reg_path_parse(output: &str, var: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    output.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        if !parts.next()?.eq_ignore_ascii_case("path") {
            return None;
        }
        let kind = parts.next()?;
        if !kind.starts_with("REG_") {
            return None;
        }
        // The value may hold spaces: everything after the type token.
        let at = line.find(kind)? + kind.len();
        let value = line[at..].trim();
        (!value.is_empty()).then(|| expand(value, var))
    })
}

#[cfg_attr(not(windows), allow(dead_code))]
/// Replaces `%NAME%` by `var(NAME)`; an unknown name stays as written.
fn expand(text: &str, var: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('%') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('%') {
            Some(close) => match var(&after[..close]) {
                Some(value) if close > 0 => {
                    out.push_str(&value);
                    rest = &after[close + 1..];
                }
                _ => {
                    out.push('%');
                    rest = after;
                }
            },
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The user and machine `Path` of the registry, which an installer changed
/// after this process started.
#[cfg(windows)]
fn registry_path(timeout: Duration) -> Option<OsString> {
    let read = |key: &str| {
        let reg = reg_exe(std::env::var("SystemRoot").ok());
        let out = capture(&reg, &["query", key, "/v", "Path"], timeout)?;
        reg_path_parse(&out, &|name| std::env::var(name).ok())
    };
    let user = read(r"HKCU\Environment");
    let machine = read(r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment");
    join_registry(machine, user)
}

/// `reg.exe` by its full path, so a `reg` earlier on PATH or in the working
/// directory is never run.
#[cfg(any(windows, test))]
fn reg_exe(system_root: Option<String>) -> String {
    let root = system_root.filter(|r| !r.is_empty());
    format!(
        r"{}\System32\reg.exe",
        root.as_deref()
            .unwrap_or(r"C:\Windows")
            .trim_end_matches('\\')
    )
}

/// The machine `Path` then the user one, the order Windows gives a new
/// process; `None` when both are missing or empty.
#[cfg(any(windows, test))]
fn join_registry(machine: Option<String>, user: Option<String>) -> Option<OsString> {
    let joined = [machine, user]
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(";");
    (!joined.is_empty()).then(|| OsString::from(joined))
}

/// `fresh` first, then the directories of `current` it does not have.
pub(crate) fn merge_path(fresh: &OsStr, current: &OsStr) -> OsString {
    let same = |a: &std::path::Path, b: &std::path::Path| {
        if cfg!(windows) {
            a.to_string_lossy()
                .eq_ignore_ascii_case(&b.to_string_lossy())
        } else {
            a == b
        }
    };
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    for dir in std::env::split_paths(fresh).chain(std::env::split_paths(current)) {
        if !dir.as_os_str().is_empty() && !dirs.iter().any(|d| same(d, &dir)) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| current.to_owned())
}

/// The PATH a new terminal would get, merged in front of the process PATH;
/// `None` when it cannot be read (the old one stays).
pub fn refresh() -> Option<OsString> {
    let current = std::env::var_os("PATH").unwrap_or_default();
    #[cfg(windows)]
    let fresh = registry_path(SHELL_TIMEOUT)?;
    #[cfg(not(windows))]
    let fresh = login_shell_path(SHELL_TIMEOUT)?;
    Some(merge_path(&fresh, &current))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_path_parse_skips_rc_noise() {
        let out = "Welcome!\nmotd\n__xdev_path__/usr/bin:/opt/x/bin__xdev_path__\nbye";
        assert_eq!(
            shell_path_parse(out),
            Some(OsString::from("/usr/bin:/opt/x/bin"))
        );
        assert_eq!(shell_path_parse("no markers"), None);
        assert_eq!(shell_path_parse("__xdev_path__ __xdev_path__"), None);
        assert_eq!(shell_path_parse("__xdev_path__/a"), None);
    }

    #[test]
    fn reg_path_is_parsed_and_expanded() {
        let out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Program Files\\x;%NOPE%\r\n\r\n";
        let var = |n: &str| (n == "USERPROFILE").then(|| r"C:\Users\a".to_owned());
        assert_eq!(
            reg_path_parse(out, &var).as_deref(),
            Some(r"C:\Users\a\bin;C:\Program Files\x;%NOPE%")
        );
        assert_eq!(reg_path_parse("    TEMP    REG_SZ    x", &var), None);
        assert_eq!(reg_path_parse("", &var), None);
    }

    #[test]
    fn reg_runs_from_system32() {
        assert_eq!(reg_exe(Some(r"D:\Win\".into())), r"D:\Win\System32\reg.exe");
        assert_eq!(reg_exe(None), r"C:\Windows\System32\reg.exe");
        assert_eq!(reg_exe(Some(String::new())), r"C:\Windows\System32\reg.exe");
        #[cfg(windows)]
        assert!(std::path::Path::new(&reg_exe(std::env::var("SystemRoot").ok())).is_file());
    }

    #[test]
    fn the_machine_path_comes_before_the_user_path() {
        let got = join_registry(Some(r"C:\Windows".into()), Some(r"C:\Users\u\bin".into()));
        assert_eq!(got, Some(OsString::from(r"C:\Windows;C:\Users\u\bin")));
        assert_eq!(
            join_registry(None, Some("u".into())),
            Some(OsString::from("u"))
        );
        assert_eq!(join_registry(Some(String::new()), None), None);
    }

    #[test]
    fn merge_puts_fresh_first_without_duplicates() {
        let join = |dirs: &[&str]| std::env::join_paths(dirs).unwrap();
        let merged = merge_path(&join(&["/n", "/a"]), &join(&["/a", "/b", ""]));
        assert_eq!(merged, join(&["/n", "/a", "/b"]));
    }

    #[cfg(unix)]
    #[test]
    fn a_slow_login_shell_gives_none_in_time() {
        let start = std::time::Instant::now();
        let got = capture("sh", &["-c", "sleep 10"], Duration::from_secs(1));
        assert_eq!(got, None);
        assert!(start.elapsed() < Duration::from_secs(7));
    }

    #[cfg(unix)]
    #[test]
    fn capture_returns_stdout() {
        let got = capture("sh", &["-c", "printf hi"], Duration::from_secs(5));
        assert_eq!(got.as_deref(), Some("hi"));
    }
}
