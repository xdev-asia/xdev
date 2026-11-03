use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

/// The desktop app's Tauri identifier. Runtimes outside Tauri join it onto
/// the OS data dir to land in the same folder as Tauri's `app_data_dir`.
pub const APP_ID: &str = "asia.xdev.desktop";

/// Where settings, accounts, policy, the audit log, task records and squads
/// live. One function for every runtime so the CLI and the desktop app share
/// them; `XDEV_DATA_DIR` lets tests and portable setups move it.
pub fn data_dir() -> Option<PathBuf> {
    resolve(std::env::var_os("XDEV_DATA_DIR"), dirs::data_dir())
}

/// Where machine-bound bulk lives: vault indexes and task worktrees. On
/// Windows this is Local, not Roaming, so a roaming profile never syncs it.
/// `XDEV_LOCAL_DIR` moves it; without it `XDEV_DATA_DIR` keeps everything in
/// one folder.
pub fn local_dir() -> Option<PathBuf> {
    resolve_local(
        std::env::var_os("XDEV_LOCAL_DIR"),
        std::env::var_os("XDEV_DATA_DIR"),
        dirs::data_local_dir(),
    )
}

/// Where the desktop app keeps `settings.json`: its config dir, which is the
/// data dir on Windows and macOS but `~/.config/<APP_ID>` on Linux.
/// `XDEV_DATA_DIR` moves it with the data dir, for tests and portable setups.
pub fn config_dir() -> Option<PathBuf> {
    resolve(std::env::var_os("XDEV_DATA_DIR"), dirs::config_dir())
}

fn resolve(env: Option<OsString>, os_data_dir: Option<PathBuf>) -> Option<PathBuf> {
    match env {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => os_data_dir.map(|d| d.join(APP_ID)),
    }
}

fn resolve_local(
    local_env: Option<OsString>,
    data_env: Option<OsString>,
    os_local_dir: Option<PathBuf>,
) -> Option<PathBuf> {
    let env = local_env.filter(|dir| !dir.is_empty()).or(data_env);
    resolve(env, os_local_dir)
}

/// Moves indexes that older versions kept in the data dir to the local dir.
/// Best effort: an index left behind is rebuilt from the vault.
pub fn move_indexes(data_dir: &Path, local_dir: &Path) {
    let (from, to) = (data_dir.join("vaults"), local_dir.join("vaults"));
    if data_dir == local_dir || !from.is_dir() || to.exists() {
        return;
    }
    if fs::create_dir_all(local_dir).is_ok() {
        let _ = fs::rename(from, to);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_wins_over_os_dir() {
        let got = resolve(Some("custom".into()), Some(PathBuf::from("os")));
        assert_eq!(got, Some(PathBuf::from("custom")));
    }

    #[test]
    fn empty_env_falls_back_to_os_dir() {
        let got = resolve(Some(OsString::new()), Some(PathBuf::from("os")));
        assert_eq!(got, Some(PathBuf::from("os").join(APP_ID)));
        assert_eq!(resolve(None, Some(PathBuf::from("os"))), got);
    }

    #[test]
    fn no_dir_without_env_or_os_dir() {
        assert_eq!(resolve(None, None), None);
    }

    #[test]
    fn local_env_wins_over_data_env_and_os_dir() {
        let got = resolve_local(
            Some("local".into()),
            Some("data".into()),
            Some(PathBuf::from("os")),
        );
        assert_eq!(got, Some(PathBuf::from("local")));
    }

    #[test]
    fn data_env_keeps_everything_in_one_dir() {
        let os = Some(PathBuf::from("os"));
        let want = Some(PathBuf::from("data"));
        assert_eq!(resolve_local(None, Some("data".into()), os.clone()), want);
        let empty = Some(OsString::new());
        assert_eq!(resolve_local(empty, Some("data".into()), os), want);
    }

    #[test]
    fn local_falls_back_to_os_local_dir() {
        let os = Some(PathBuf::from("os"));
        let want = Some(PathBuf::from("os").join(APP_ID));
        assert_eq!(resolve_local(None, None, os.clone()), want);
        let empty = || Some(OsString::new());
        assert_eq!(resolve_local(empty(), empty(), os), want);
        assert_eq!(resolve_local(None, None, None), None);
    }

    fn index(dir: &Path) -> PathBuf {
        dir.join("vaults").join("v1").join("index.db")
    }

    fn write_index(dir: &Path, text: &str) {
        fs::create_dir_all(index(dir).parent().unwrap()).unwrap();
        fs::write(index(dir), text).unwrap();
    }

    #[test]
    fn indexes_move_to_the_local_dir() {
        let root = tempfile::tempdir().unwrap();
        let (data, local) = (root.path().join("data"), root.path().join("local"));
        write_index(&data, "old");

        move_indexes(&data, &local);
        assert_eq!(fs::read_to_string(index(&local)).unwrap(), "old");
        assert!(!data.join("vaults").exists());
    }

    #[test]
    fn indexes_already_in_the_local_dir_stay() {
        let root = tempfile::tempdir().unwrap();
        let (data, local) = (root.path().join("data"), root.path().join("local"));
        write_index(&data, "old");
        write_index(&local, "new");

        move_indexes(&data, &local);
        assert_eq!(fs::read_to_string(index(&data)).unwrap(), "old");
        assert_eq!(fs::read_to_string(index(&local)).unwrap(), "new");
    }

    #[test]
    fn same_dir_is_left_alone() {
        let root = tempfile::tempdir().unwrap();
        write_index(root.path(), "old");

        move_indexes(root.path(), root.path());
        assert_eq!(fs::read_to_string(index(root.path())).unwrap(), "old");
    }

    #[test]
    fn nothing_to_move_creates_nothing() {
        let root = tempfile::tempdir().unwrap();
        let local = root.path().join("local");
        move_indexes(&root.path().join("data"), &local);
        assert!(!local.exists());
    }
}
