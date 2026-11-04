//! Makes the `xdev` CLI reachable from the terminals the app starts: its
//! folder goes first on `PATH` and `XDEV_CLI` names it. Agents run
//! `xdev orchestration ...` from those terminals.
//!
//! Nothing changes when the CLI is not next to the app's exe (a plain
//! `cargo run` without `xdev` built).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The CLI next to `exe`, the same rule as the sidecar service.
pub(crate) fn find(exe: &Path) -> Option<PathBuf> {
    crate::commands::cli_beside(exe)
}

/// Adds `XDEV_CLI` and the CLI's folder to `env` when the CLI sits next to `exe`.
pub(crate) fn cli_env(exe: &Path, env: &mut Vec<(String, OsString)>) {
    if let Some(cli) = find(exe) {
        apply(&cli, env, std::env::var_os("PATH"));
    }
}

/// `cli_env` with the CLI found and the process `PATH` given.
pub(crate) fn apply(cli: &Path, env: &mut Vec<(String, OsString)>, process_path: Option<OsString>) {
    let Some(dir) = cli.parent() else { return };
    env.retain(|(k, _)| k != "XDEV_CLI");
    env.push(("XDEV_CLI".to_owned(), cli.as_os_str().to_owned()));

    // Windows names the variable `Path`, and a name differing in case is the
    // same variable; keep the launch's own spelling.
    let at = env.iter().position(|(k, _)| is_path_key(k));
    let base = match at {
        Some(i) => Some(env[i].1.clone()),
        None => process_path,
    };
    let mut dirs: Vec<PathBuf> = vec![dir.to_path_buf()];
    if let Some(base) = base {
        dirs.extend(std::env::split_paths(&base).filter(|p| p != dir && !p.as_os_str().is_empty()));
    }
    let Ok(joined) = std::env::join_paths(dirs) else {
        return;
    };
    match at {
        Some(i) => env[i].1 = joined,
        None => env.push((default_key().to_owned(), joined)),
    }
}

fn is_path_key(key: &str) -> bool {
    if cfg!(windows) {
        key.eq_ignore_ascii_case("path")
    } else {
        key == "PATH"
    }
}

fn default_key() -> &'static str {
    if cfg!(windows) { "Path" } else { "PATH" }
}

/// The value of `PATH` in `env`, whatever its spelling.
#[cfg(test)]
fn path_of(env: &[(String, OsString)]) -> Option<&std::ffi::OsStr> {
    env.iter()
        .find(|(k, _)| is_path_key(k))
        .map(|(_, v)| v.as_os_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exe_with_cli(present: bool) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir
            .path()
            .join(format!("xdev-desktop{}", std::env::consts::EXE_SUFFIX));
        let cli = dir
            .path()
            .join(format!("xdev{}", std::env::consts::EXE_SUFFIX));
        if present {
            std::fs::write(&cli, "").unwrap();
        }
        (dir, exe, cli)
    }

    #[test]
    fn a_missing_cli_changes_nothing() {
        let (_dir, exe, _) = exe_with_cli(false);
        let mut env = vec![("A".to_owned(), OsString::from("1"))];
        cli_env(&exe, &mut env);
        assert_eq!(env, vec![("A".to_owned(), OsString::from("1"))]);
        assert_eq!(find(&exe), None);
    }

    #[test]
    fn a_cli_beside_the_exe_is_named_and_put_first_on_the_path() {
        let (dir, exe, cli) = exe_with_cli(true);
        assert_eq!(find(&exe), Some(cli.clone()));
        let mut env = vec![("A".to_owned(), OsString::from("1"))];
        cli_env(&exe, &mut env);
        assert!(env.contains(&("XDEV_CLI".to_owned(), cli.into_os_string())));
        let path = path_of(&env).expect("a PATH entry").to_owned();
        let first = std::env::split_paths(&path).next().unwrap();
        assert_eq!(first, dir.path());
    }

    #[test]
    fn the_rest_of_the_launch_path_is_kept_in_order() {
        let (dir, _, cli) = exe_with_cli(true);
        let old = std::env::join_paths(["/one", "/two"]).unwrap();
        let mut env = vec![(default_key().to_owned(), old)];
        apply(&cli, &mut env, Some(OsString::from("/ignored")));
        let parts: Vec<PathBuf> = std::env::split_paths(path_of(&env).unwrap()).collect();
        assert_eq!(
            parts,
            vec![dir.path().to_path_buf(), "/one".into(), "/two".into()]
        );
        assert_eq!(env.iter().filter(|(k, _)| is_path_key(k)).count(), 1);
    }

    #[test]
    fn without_a_launch_path_the_process_path_is_the_base() {
        let (dir, _, cli) = exe_with_cli(true);
        let process = std::env::join_paths(["/usr/bin", "/bin"]).unwrap();
        let mut env = Vec::new();
        apply(&cli, &mut env, Some(process));
        let parts: Vec<PathBuf> = std::env::split_paths(path_of(&env).unwrap()).collect();
        assert_eq!(
            parts,
            vec![dir.path().to_path_buf(), "/usr/bin".into(), "/bin".into()]
        );
    }

    #[test]
    fn the_folder_is_not_listed_twice() {
        let (dir, _, cli) = exe_with_cli(true);
        let old = std::env::join_paths([dir.path(), Path::new("/x")]).unwrap();
        let mut env = vec![(default_key().to_owned(), old)];
        apply(&cli, &mut env, None);
        let parts: Vec<PathBuf> = std::env::split_paths(path_of(&env).unwrap()).collect();
        assert_eq!(parts, vec![dir.path().to_path_buf(), "/x".into()]);
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_any_spelling_of_path_is_the_same_variable() {
        let (dir, _, cli) = exe_with_cli(true);
        let mut env = vec![("PATH".to_owned(), OsString::from("C:\\tools"))];
        apply(&cli, &mut env, None);
        assert_eq!(
            env.iter()
                .filter(|(k, _)| k.eq_ignore_ascii_case("path"))
                .count(),
            1
        );
        assert_eq!(env.iter().find(|(k, _)| k == "PATH").map(|_| ()), Some(()));
        let parts: Vec<PathBuf> = std::env::split_paths(path_of(&env).unwrap()).collect();
        assert_eq!(parts, vec![dir.path().to_path_buf(), "C:\\tools".into()]);
    }
}
