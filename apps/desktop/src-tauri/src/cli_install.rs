//! Puts the `xdev` CLI on the user's `PATH` from Settings.
//!
//! Windows adds a small shim folder (an `xdev.cmd` that calls the bundled
//! binary) to the user `Path` in the registry. macOS and Linux link
//! `xdev` into a folder that is usually on `PATH`. The decisions are pure
//! functions with tests; the registry and the links are thin wrappers.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::commands::CmdError;

/// What Settings shows about the CLI on `PATH`.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(rename_all = "camelCase"))]
pub struct CliStatus {
    /// A link or shim exists, points at the bundled binary and still works.
    pub installed: bool,
    /// The `xdev` binary that ships with the app; none in a dev build without it.
    pub target_path: Option<String>,
    /// The link (macOS, Linux) or shim (Windows) the app made or would make.
    pub link_path: Option<String>,
    /// The folder of `link_path` is on `PATH`.
    pub on_path: bool,
    /// A link or shim exists but its target is missing or another binary.
    pub stale: bool,
}

fn cli_error(code: &'static str, detail: impl ToString) -> CmdError {
    CmdError {
        code,
        detail: Some(detail.to_string()),
    }
}

// ---- Pure decisions -------------------------------------------------------

/// The `;` separated entries of a Windows path list. A `;` inside double
/// quotes belongs to the entry. Empty entries are dropped.
#[cfg_attr(not(windows), allow(dead_code))]
fn split_entries(list: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    for (i, c) in list.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ';' if !quoted => {
                out.push(&list[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&list[start..]);
    out.retain(|e| !e.trim().is_empty());
    out
}

/// The form two entries are compared in: no quotes, no trailing separator,
/// case folded. `%VAR%` entries are compared as written.
#[cfg_attr(not(windows), allow(dead_code))]
fn norm_entry(entry: &str) -> String {
    let t = entry.trim().trim_matches('"').trim();
    t.trim_end_matches(['\\', '/']).to_lowercase()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn path_contains(list: &str, entry: &str) -> bool {
    let want = norm_entry(entry);
    split_entries(list).iter().any(|e| norm_entry(e) == want)
}

/// `list` with `entry` appended once. A list that has it (any case, quoted or
/// with a trailing slash) is returned untouched.
#[cfg_attr(not(windows), allow(dead_code))]
fn path_add(list: &str, entry: &str) -> String {
    if path_contains(list, entry) {
        return list.to_owned();
    }
    let mut entries = split_entries(list);
    entries.push(entry);
    entries.join(";")
}

/// `list` without `entry`; every other entry is kept as written. A list that
/// has no such entry is returned untouched.
#[cfg_attr(not(windows), allow(dead_code))]
fn path_remove(list: &str, entry: &str) -> String {
    if !path_contains(list, entry) {
        return list.to_owned();
    }
    let want = norm_entry(entry);
    let kept: Vec<&str> = split_entries(list)
        .into_iter()
        .filter(|e| norm_entry(e) != want)
        .collect();
    kept.join(";")
}

/// A link or shim is stale when it exists and its target is gone or is not
/// the binary the app ships now. No link is never stale.
fn is_stale(link_target: Option<&Path>, expected: &Path, target_exists: bool) -> bool {
    match link_target {
        None => false,
        Some(t) => !target_exists || t != expected,
    }
}

/// `/usr/local/bin` when the person can write there, else `~/.local/bin`.
#[cfg_attr(windows, allow(dead_code))]
fn choose_link_dir(usr_local_writable: bool, home: Option<&Path>) -> Option<PathBuf> {
    if usr_local_writable {
        return Some(PathBuf::from("/usr/local/bin"));
    }
    home.map(|h| h.join(".local").join("bin"))
}

/// Whether `dir` is one of the folders of the `PATH` value.
#[cfg_attr(windows, allow(dead_code))]
fn dir_on_path(dir: &Path, path_var: &OsStr) -> bool {
    std::env::split_paths(path_var).any(|p| p == dir)
}

/// A link is the app's own when it points at the bundled binary, or at a file
/// named like it (an older install that moved). Anything else is left alone.
#[cfg_attr(windows, allow(dead_code))]
fn is_ours(link_target: &Path, expected: Option<&Path>) -> bool {
    if expected == Some(link_target) {
        return true;
    }
    link_target
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == "xdev" || n == "xdev.exe")
}

/// The text of the Windows shim that runs `target`.
#[cfg_attr(not(windows), allow(dead_code))]
fn shim_text(target: &Path) -> String {
    format!("@echo off\r\n\"{}\" %*\r\n", target.display())
}

/// The binary a shim runs, read back from its text.
#[cfg_attr(not(windows), allow(dead_code))]
fn shim_target(text: &str) -> Option<PathBuf> {
    let line = text.lines().nth(1)?.trim();
    let rest = line.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(PathBuf::from(&rest[..end]))
}

// ---- Shared wrappers ------------------------------------------------------

/// The `xdev` that ships next to the app.
fn bundled() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    crate::commands::cli_beside(&exe)
}

fn local_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.state::<crate::commands::AppState>().local_dir.clone()
}

#[tauri::command(async)]
pub fn cli_status(app: tauri::AppHandle) -> CliStatus {
    status(local_dir(&app).as_deref())
}

#[tauri::command(async)]
pub fn cli_install(app: tauri::AppHandle) -> Result<CliStatus, CmdError> {
    let local = local_dir(&app);
    let target = bundled().ok_or_else(|| cli_error("cli_missing", "no bundled xdev"))?;
    install(local.as_deref(), &target)?;
    Ok(status(local.as_deref()))
}

#[tauri::command(async)]
pub fn cli_remove(app: tauri::AppHandle) -> Result<CliStatus, CmdError> {
    let local = local_dir(&app);
    remove(local.as_deref())?;
    Ok(status(local.as_deref()))
}

/// Points a stale link or shim at the bundled binary again.
#[tauri::command(async)]
pub fn cli_repair(app: tauri::AppHandle) -> Result<CliStatus, CmdError> {
    cli_install(app)
}

/// Shows the bundled binary in the file manager.
#[tauri::command(async)]
pub fn cli_reveal() -> Result<(), CmdError> {
    let target = bundled().ok_or_else(|| cli_error("cli_missing", "no bundled xdev"))?;
    crate::reveal::reveal(&target, true).map_err(|e| cli_error("cli_io", e))
}

// ---- Windows --------------------------------------------------------------

#[cfg(windows)]
fn shim_path(local: Option<&Path>) -> Option<PathBuf> {
    local.map(|l| l.join("bin").join("xdev.cmd"))
}

#[cfg(windows)]
fn status(local: Option<&Path>) -> CliStatus {
    let target = bundled();
    let Some(shim) = shim_path(local) else {
        return CliStatus {
            target_path: target.map(|t| t.display().to_string()),
            ..CliStatus::default()
        };
    };
    let shim_exe = std::fs::read_to_string(&shim)
        .ok()
        .and_then(|t| shim_target(&t));
    let stale = shim_exe.as_deref().is_some_and(|t| {
        is_stale(
            Some(t),
            target.as_deref().unwrap_or(Path::new("")),
            t.is_file(),
        )
    });
    let on_path = shim
        .parent()
        .is_some_and(|d| path_contains(&win::read_user_path(), &d.display().to_string()));
    CliStatus {
        installed: shim_exe.is_some() && !stale,
        target_path: target.map(|t| t.display().to_string()),
        link_path: Some(shim.display().to_string()),
        on_path,
        stale,
    }
}

#[cfg(windows)]
fn install(local: Option<&Path>, target: &Path) -> Result<(), CmdError> {
    let shim = shim_path(local).ok_or_else(|| cli_error("cli_io", "no local data folder"))?;
    let dir = shim.parent().expect("shim has a folder");
    std::fs::create_dir_all(dir).map_err(|e| cli_error("cli_io", e))?;
    std::fs::write(&shim, shim_text(target)).map_err(|e| cli_error("cli_io", e))?;
    win::edit_user_path(|list| path_add(list, &dir.display().to_string()))
        .map_err(|e| cli_error("cli_io", e))
}

#[cfg(windows)]
fn remove(local: Option<&Path>) -> Result<(), CmdError> {
    let Some(shim) = shim_path(local) else {
        return Ok(());
    };
    let dir = shim.parent().expect("shim has a folder").to_path_buf();
    win::edit_user_path(|list| path_remove(list, &dir.display().to_string()))
        .map_err(|e| cli_error("cli_io", e))?;
    match std::fs::remove_file(&shim) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(cli_error("cli_io", e)),
    }
    // Only an empty folder goes; anything else in it is not ours to delete.
    let _ = std::fs::remove_dir(&dir);
    Ok(())
}

#[cfg(windows)]
mod win {
    use std::io;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, RegType};
    use winreg::{RegKey, RegValue};

    const NAME: &str = "Path";

    fn decode(bytes: &[u8]) -> String {
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        String::from_utf16_lossy(&units)
            .trim_end_matches('\0')
            .to_owned()
    }

    fn encode(text: &str) -> Vec<u8> {
        text.encode_utf16()
            .chain(std::iter::once(0))
            .flat_map(u16::to_le_bytes)
            .collect()
    }

    /// The user `Path` as stored (unexpanded); empty when there is none.
    pub(super) fn read_user_path() -> String {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Environment", KEY_READ)
            .and_then(|k| k.get_raw_value(NAME))
            .map(|v| decode(&v.bytes))
            .unwrap_or_default()
    }

    /// Rewrites the user `Path` with `edit`, keeping its type
    /// (`REG_EXPAND_SZ` when new), then tells running programs.
    pub(super) fn edit_user_path(edit: impl FnOnce(&str) -> String) -> io::Result<()> {
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)?;
        let (old, vtype) = match key.get_raw_value(NAME) {
            Ok(v) => (decode(&v.bytes), v.vtype),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                (String::new(), RegType::REG_EXPAND_SZ)
            }
            Err(e) => return Err(e),
        };
        let new = edit(&old);
        if new == old {
            return Ok(());
        }
        key.set_raw_value(
            NAME,
            &RegValue {
                bytes: encode(&new).into(),
                vtype,
            },
        )?;
        broadcast();
        Ok(())
    }

    /// `WM_SETTINGCHANGE` "Environment", so Explorer and new terminals reread it.
    #[allow(unsafe_code)]
    fn broadcast() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
        };
        let env: Vec<u16> = "Environment\0".encode_utf16().collect();
        let mut result = 0usize;
        // SAFETY: `env` is a NUL terminated UTF-16 string that outlives the
        // call, and `result` is a valid out pointer. The call has a timeout.
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                env.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5000,
                &mut result,
            );
        }
    }
}

// ---- macOS and Linux ------------------------------------------------------

#[cfg(not(windows))]
fn link_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/usr/local/bin")];
    if let Some(h) = home() {
        dirs.push(h.join(".local").join("bin"));
    }
    dirs
}

#[cfg(not(windows))]
fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// The `xdev` link in the first folder that has a symlink of that name.
#[cfg(not(windows))]
fn existing_link() -> Option<(PathBuf, PathBuf)> {
    link_dirs().into_iter().find_map(|d| {
        let link = d.join("xdev");
        std::fs::read_link(&link).ok().map(|t| (link, t))
    })
}

/// Whether the person can create a link in `dir`: it exists and is theirs to
/// write (or world writable). The symlink call has the final word.
#[cfg(not(windows))]
fn writable_dir(dir: &Path) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let Ok(m) = std::fs::metadata(dir) else {
        return false;
    };
    let mode = m.permissions().mode();
    let mine = home()
        .and_then(|h| std::fs::metadata(h).ok())
        .is_some_and(|h| h.uid() == m.uid());
    m.is_dir() && (mode & 0o002 != 0 || (mine && mode & 0o200 != 0))
}

#[cfg(not(windows))]
fn status(_local: Option<&Path>) -> CliStatus {
    let target = bundled();
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let target_path = target.as_ref().map(|t| t.display().to_string());
    match existing_link() {
        Some((link, to)) => {
            let abs = link.parent().map_or(to.clone(), |p| p.join(&to));
            let stale = is_stale(
                Some(&to),
                target.as_deref().unwrap_or(Path::new("")),
                abs.exists(),
            );
            CliStatus {
                installed: !stale,
                target_path,
                on_path: link.parent().is_some_and(|d| dir_on_path(d, &path_var)),
                link_path: Some(link.display().to_string()),
                stale,
            }
        }
        None => {
            let dir = choose_link_dir(writable_dir(Path::new("/usr/local/bin")), home().as_deref());
            CliStatus {
                installed: false,
                target_path,
                on_path: dir.as_deref().is_some_and(|d| dir_on_path(d, &path_var)),
                link_path: dir.map(|d| d.join("xdev").display().to_string()),
                stale: false,
            }
        }
    }
}

#[cfg(not(windows))]
fn install(_local: Option<&Path>, target: &Path) -> Result<(), CmdError> {
    // A stale link is re-pointed where it already is.
    let link = match existing_link() {
        Some((link, _)) => link,
        None => {
            let dir = choose_link_dir(writable_dir(Path::new("/usr/local/bin")), home().as_deref())
                .ok_or_else(|| cli_error("cli_io", "no home folder"))?;
            dir.join("xdev")
        }
    };
    if let Some(dir) = link.parent() {
        std::fs::create_dir_all(dir).map_err(|e| cli_error("cli_io", e))?;
    }
    match std::fs::symlink_metadata(&link) {
        Ok(m) if m.file_type().is_symlink() => {
            std::fs::remove_file(&link).map_err(|e| cli_error("cli_io", e))?;
        }
        Ok(_) => return Err(cli_error("cli_link_exists", link.display())),
        Err(_) => {}
    }
    std::os::unix::fs::symlink(target, &link).map_err(|e| cli_error("cli_io", e))
}

#[cfg(not(windows))]
fn remove(_local: Option<&Path>) -> Result<(), CmdError> {
    let expected = bundled();
    for dir in link_dirs() {
        let link = dir.join("xdev");
        if let Ok(to) = std::fs::read_link(&link)
            && is_ours(&to, expected.as_deref())
        {
            std::fs::remove_file(&link).map_err(|e| cli_error("cli_io", e))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_appends_once_and_ignores_case_quotes_and_slashes() {
        assert_eq!(path_add("C:\\a;C:\\b", "C:\\x"), "C:\\a;C:\\b;C:\\x");
        assert_eq!(path_add("", "C:\\x"), "C:\\x");
        assert_eq!(path_add("C:\\a;c:\\X\\", "C:\\x"), "C:\\a;c:\\X\\");
        assert_eq!(path_add("C:\\a;\"C:\\x\"", "C:\\x"), "C:\\a;\"C:\\x\"");
    }

    #[test]
    fn add_drops_a_trailing_separator_and_empty_entries() {
        assert_eq!(path_add("C:\\a;", "C:\\x"), "C:\\a;C:\\x");
        assert_eq!(path_add("C:\\a;;C:\\b;", "C:\\x"), "C:\\a;C:\\b;C:\\x");
    }

    #[test]
    fn env_var_entries_are_kept_as_written() {
        let list = "%USERPROFILE%\\x;C:\\a";
        assert_eq!(path_add(list, "C:\\n"), "%USERPROFILE%\\x;C:\\a;C:\\n");
        assert_eq!(path_remove(&path_add(list, "C:\\n"), "C:\\n"), list);
        assert_eq!(path_remove(list, "C:\\n"), list);
    }

    #[test]
    fn remove_takes_only_our_entry_in_any_spelling() {
        assert_eq!(
            path_remove("C:\\a;\"C:\\X\\\";C:\\b;", "c:\\x"),
            "C:\\a;C:\\b"
        );
        assert_eq!(path_remove("C:\\x", "C:\\x"), "");
        assert_eq!(path_remove("C:\\xy;C:\\a", "C:\\x"), "C:\\xy;C:\\a");
    }

    #[test]
    fn a_semicolon_in_quotes_stays_inside_its_entry() {
        let list = "\"C:\\a;b\";C:\\c";
        assert_eq!(split_entries(list), vec!["\"C:\\a;b\"", "C:\\c"]);
        assert_eq!(path_remove(list, "C:\\c"), "\"C:\\a;b\"");
    }

    #[test]
    fn stale_needs_a_link_whose_target_is_gone_or_different() {
        let want = Path::new("/app/xdev");
        assert!(!is_stale(None, want, false));
        assert!(!is_stale(Some(want), want, true));
        assert!(is_stale(Some(want), want, false));
        assert!(is_stale(Some(Path::new("/old/xdev")), want, true));
    }

    #[test]
    fn the_link_folder_prefers_a_writable_usr_local_then_home() {
        let home = Path::new("/home/me");
        assert_eq!(
            choose_link_dir(true, Some(home)),
            Some(PathBuf::from("/usr/local/bin"))
        );
        assert_eq!(
            choose_link_dir(false, Some(home)),
            Some(home.join(".local").join("bin"))
        );
        assert_eq!(choose_link_dir(false, None), None);
    }

    #[test]
    fn a_folder_is_on_path_when_it_is_one_of_the_entries() {
        let var = std::env::join_paths(["/usr/bin", "/home/me/.local/bin"]).unwrap();
        assert!(dir_on_path(Path::new("/home/me/.local/bin"), &var));
        assert!(!dir_on_path(Path::new("/home/me/.local"), &var));
    }

    #[test]
    fn only_a_link_to_an_xdev_binary_is_ours() {
        let want = Path::new("/app/xdev");
        assert!(is_ours(want, Some(want)));
        assert!(is_ours(Path::new("/old/app/xdev"), Some(want)));
        assert!(is_ours(Path::new("/old/xdev.exe"), None));
        assert!(!is_ours(Path::new("/usr/bin/other"), Some(want)));
    }

    #[test]
    fn the_shim_text_reads_back_to_its_target() {
        let target = Path::new("C:\\Program Files\\xDev\\xdev.exe");
        let text = shim_text(target);
        assert!(text.contains("%*"));
        assert_eq!(shim_target(&text), Some(target.to_path_buf()));
        assert_eq!(shim_target("@echo off\r\n"), None);
        assert_eq!(shim_target(""), None);
    }
}
