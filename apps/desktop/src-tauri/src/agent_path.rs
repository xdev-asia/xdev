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

/// Where an entry of the effective PATH comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum PathSource {
    /// The PATH the system gave; read-only here.
    System,
    /// An entry the owner put in front (Settings).
    Prepend,
    /// An entry the owner put at the end (Settings).
    Append,
}

/// One directory of the effective PATH, in search order.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PathEntry {
    pub path: String,
    pub source: PathSource,
    /// Whether the directory exists; a missing one stays in the PATH.
    pub exists: bool,
}

/// Why a PATH entry of the owner is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryError {
    Empty,
    /// The entry holds the PATH separator, so it would split in two.
    Separator,
    /// The entry holds a control character.
    Control,
}

/// The separator between PATH entries on this system.
pub const SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

/// `raw` trimmed, or why it cannot be a PATH entry, with `sep` as the separator.
pub fn validate_entry_with(raw: &str, sep: char) -> Result<String, EntryError> {
    let entry = raw.trim();
    if entry.is_empty() {
        Err(EntryError::Empty)
    } else if entry.contains(sep) {
        Err(EntryError::Separator)
    } else if entry.chars().any(char::is_control) {
        Err(EntryError::Control)
    } else {
        Ok(entry.to_owned())
    }
}

/// `validate_entry_with` for this system's separator.
pub fn validate_entry(raw: &str) -> Result<String, EntryError> {
    validate_entry_with(raw, SEPARATOR)
}

/// The valid entries of `raw`, trimmed, each once, in order; the others are dropped.
pub fn clean_entries(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in raw.iter().filter_map(|r| validate_entry(r).ok()) {
        if !out.iter().any(|o| same_dir(o, &entry)) {
            out.push(entry);
        }
    }
    out
}

fn same_dir(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// The effective PATH in order: the owner's `prepend` entries, the `system`
/// ones, then the `append` ones. A directory appears once, at its first
/// place; a system entry the owner also listed counts as the owner's. A
/// missing directory is kept and flagged. Pure: `exists` is the only look at
/// the disk.
pub fn layout(
    system: &OsStr,
    prepend: &[String],
    append: &[String],
    exists: &dyn Fn(&str) -> bool,
) -> Vec<PathEntry> {
    let mut out: Vec<PathEntry> = Vec::new();
    let mut add = |path: String, source: PathSource| {
        if path.is_empty() || out.iter().any(|e| same_dir(&e.path, &path)) {
            return;
        }
        let exists = exists(&path);
        out.push(PathEntry {
            path,
            source,
            exists,
        });
    };
    for p in prepend {
        add(p.clone(), PathSource::Prepend);
    }
    for dir in std::env::split_paths(system) {
        add(dir.to_string_lossy().into_owned(), PathSource::System);
    }
    for p in append {
        add(p.clone(), PathSource::Append);
    }
    out
}

/// The owner's entries over `system`, as a PATH value; `None` when the owner
/// has none (the system PATH stays as it is) or the result cannot be joined.
pub fn with_extras(system: &OsStr, prepend: &[String], append: &[String]) -> Option<OsString> {
    if prepend.is_empty() && append.is_empty() {
        return None;
    }
    let entries = layout(system, prepend, append, &|_| true);
    std::env::join_paths(entries.iter().map(|e| &e.path)).ok()
}

/// The effective PATH of `system` with the owner's entries, flagging the
/// directories that do not exist.
pub fn effective(system: &OsStr, prepend: &[String], append: &[String]) -> Vec<PathEntry> {
    layout(system, prepend, append, &|p| {
        std::path::Path::new(p).is_dir()
    })
}

/// Puts the owner's entries into a launch env's `PATH`, over the PATH the
/// profile set or else `base`. Nothing changes without entries.
pub fn apply_extras(
    env: &mut Vec<(String, OsString)>,
    base: &OsStr,
    prepend: &[String],
    append: &[String],
) {
    let own = env.iter().position(|(k, _)| k.eq_ignore_ascii_case("PATH"));
    let system = own.map_or(base, |i| env[i].1.as_os_str());
    let Some(path) = with_extras(system, prepend, append) else {
        return;
    };
    match own {
        Some(i) => env[i].1 = path,
        None => env.push(("PATH".to_owned(), path)),
    }
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

    fn join(dirs: &[&str]) -> OsString {
        std::env::join_paths(dirs).unwrap()
    }

    fn paths(entries: &[PathEntry]) -> Vec<(&str, PathSource)> {
        entries
            .iter()
            .map(|e| (e.path.as_str(), e.source))
            .collect()
    }

    #[test]
    fn layout_prepends_and_appends_around_the_system_path() {
        let got = layout(
            &join(&["/s1", "/s2"]),
            &["/p".to_owned()],
            &["/a".to_owned()],
            &|_| true,
        );
        assert_eq!(
            paths(&got),
            [
                ("/p", PathSource::Prepend),
                ("/s1", PathSource::System),
                ("/s2", PathSource::System),
                ("/a", PathSource::Append)
            ]
        );
    }

    #[test]
    fn layout_dedupes_and_keeps_the_first_place() {
        let got = layout(
            &join(&["/s1", "/s2", "/s1"]),
            &["/s2".to_owned(), "/p".to_owned(), "/p".to_owned()],
            &["/s1".to_owned(), "/a".to_owned()],
            &|_| true,
        );
        assert_eq!(
            paths(&got),
            [
                ("/s2", PathSource::Prepend),
                ("/p", PathSource::Prepend),
                ("/s1", PathSource::System),
                ("/a", PathSource::Append)
            ]
        );
    }

    #[test]
    fn layout_keeps_missing_dirs_and_flags_them() {
        let got = layout(
            &join(&["/here", "/gone"]),
            &["/also-gone".to_owned()],
            &[],
            &|p| p == "/here",
        );
        let flags: Vec<_> = got.iter().map(|e| (e.path.as_str(), e.exists)).collect();
        assert_eq!(
            flags,
            [("/also-gone", false), ("/here", true), ("/gone", false)]
        );
    }

    #[test]
    fn extras_join_into_one_path_and_none_leaves_it_alone() {
        let system = join(&["/s"]);
        assert_eq!(with_extras(&system, &[], &[]), None);
        assert_eq!(
            with_extras(&system, &["/p".to_owned()], &["/a".to_owned()]),
            Some(join(&["/p", "/s", "/a"]))
        );
    }

    #[test]
    fn apply_extras_wraps_the_profile_path_or_the_base() {
        let pre = ["/p".to_owned()];
        let mut env = vec![("PATH".to_owned(), join(&["/own"]))];
        apply_extras(&mut env, &join(&["/base"]), &pre, &[]);
        assert_eq!(env, [("PATH".to_owned(), join(&["/p", "/own"]))]);

        let mut env: Vec<(String, OsString)> = Vec::new();
        apply_extras(&mut env, &join(&["/base"]), &pre, &[]);
        assert_eq!(env, [("PATH".to_owned(), join(&["/p", "/base"]))]);

        let mut env: Vec<(String, OsString)> = Vec::new();
        apply_extras(&mut env, &join(&["/base"]), &[], &[]);
        assert!(env.is_empty());
    }

    #[test]
    fn entries_are_validated() {
        assert_eq!(validate_entry_with("  /a/b ", ':').as_deref(), Ok("/a/b"));
        assert_eq!(validate_entry_with("", ':'), Err(EntryError::Empty));
        assert_eq!(validate_entry_with("   ", ';'), Err(EntryError::Empty));
        assert_eq!(
            validate_entry_with("/a:/b", ':'),
            Err(EntryError::Separator)
        );
        assert_eq!(
            validate_entry_with(r"C:\a;C:\b", ';'),
            Err(EntryError::Separator)
        );
        // A drive colon is no separator on Windows.
        assert_eq!(
            validate_entry_with(r"C:\tools", ';').as_deref(),
            Ok(r"C:\tools")
        );
        assert_eq!(validate_entry_with("/a\nb", ':'), Err(EntryError::Control));
    }

    #[test]
    fn clean_entries_drops_bad_ones_and_repeats() {
        let raw: Vec<String> = [" /a ", "", "/b", "/a", "x\0y"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(clean_entries(&raw), ["/a", "/b"]);
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
