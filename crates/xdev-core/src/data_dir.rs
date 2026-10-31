use std::ffi::OsString;
use std::path::PathBuf;

/// The desktop app's Tauri identifier. Runtimes outside Tauri join it onto
/// the OS data dir to land in the same folder as Tauri's `app_data_dir`.
pub const APP_ID: &str = "asia.xdev.desktop";

/// Where indexes live. One function for every runtime so the CLI and the
/// desktop app share one index per vault; `XDEV_DATA_DIR` lets tests and
/// portable setups move it.
pub fn data_dir() -> Option<PathBuf> {
    resolve(std::env::var_os("XDEV_DATA_DIR"), dirs::data_dir())
}

fn resolve(env: Option<OsString>, os_data_dir: Option<PathBuf>) -> Option<PathBuf> {
    match env {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => os_data_dir.map(|d| d.join(APP_ID)),
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
}
