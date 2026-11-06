//! Settings → Agents → Status hooks: how each catalogue CLI gets its status
//! hooks, and the install and uninstall of the managed ones (`xdev_agent`
//! `install_hooks`), which go in the CLI's own user config.

use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use xdev_agent::profiles::Cli;
use xdev_agent::{
    HookInstall, HookSupport, hook_install_state, hook_support, hooks_root, hooks_settings,
    install_hooks, uninstall_hooks,
};

use crate::commands::{CmdError, cli_beside};

/// One CLI's row: how it gets hooks and, for a managed one, whether they are
/// in its settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CliHooks {
    pub cli: Cli,
    pub support: HookSupport,
    /// `None` unless `support` is managed.
    pub state: Option<HookInstall>,
    /// The file the managed hooks go in.
    pub settings: Option<String>,
    /// Why `state` could not be read: `hooks-unreadable` (not plain JSON),
    /// `hooks-conflict` (a file of the person's at xDev's own path),
    /// `hooks-no-home`, `io`.
    pub error: Option<String>,
}

/// The `code` of an install or state failure.
fn error_code(e: &io::Error) -> &'static str {
    match e.kind() {
        io::ErrorKind::InvalidData => "hooks-unreadable",
        io::ErrorKind::AlreadyExists => "hooks-conflict",
        io::ErrorKind::Unsupported => "hooks-unsupported",
        _ => "io",
    }
}

fn error(e: &io::Error) -> CmdError {
    CmdError {
        code: error_code(e),
        detail: Some(e.to_string()),
    }
}

/// The row of `cli`, its managed hooks read under `root` for `xdev`.
fn row(cli: Cli, root: Option<&Path>, xdev: Option<&Path>) -> CliHooks {
    let support = hook_support(cli);
    let mut out = CliHooks {
        cli,
        support,
        state: None,
        settings: None,
        error: None,
    };
    if support != HookSupport::Managed {
        return out;
    }
    let Some(root) = root else {
        out.error = Some("hooks-no-home".to_owned());
        return out;
    };
    out.settings = hooks_settings(cli, root).map(|p| p.to_string_lossy().into_owned());
    // Without the `xdev` beside the app (a dev build), any entry of ours is
    // one this app cannot keep current.
    let xdev = xdev.map_or_else(|| PathBuf::from("xdev"), Path::to_path_buf);
    match hook_install_state(cli, root, &xdev) {
        Ok(state) => out.state = Some(state),
        Err(e) => out.error = Some(error_code(&e).to_owned()),
    }
    out
}

fn rows(root_of: impl Fn(Cli) -> Option<PathBuf>, xdev: Option<&Path>) -> Vec<CliHooks> {
    Cli::ALL
        .into_iter()
        .map(|cli| row(cli, root_of(cli).as_deref(), xdev))
        .collect()
}

/// The root a managed CLI's settings live under, from the app's env.
fn app_root(cli: Cli) -> Option<PathBuf> {
    hooks_root(cli, |key| std::env::var_os(key))
}

fn app_xdev() -> Option<PathBuf> {
    cli_beside(&std::env::current_exe().ok()?)
}

fn install_at(cli: Cli, root: Option<&Path>, xdev: Option<&Path>) -> Result<CliHooks, CmdError> {
    let root = root.ok_or(CmdError {
        code: "hooks-no-home",
        detail: None,
    })?;
    let program = xdev.ok_or(CmdError {
        code: "hooks-no-cli",
        detail: None,
    })?;
    install_hooks(cli, root, program).map_err(|e| error(&e))?;
    Ok(row(cli, Some(root), xdev))
}

fn uninstall_at(cli: Cli, root: Option<&Path>, xdev: Option<&Path>) -> Result<CliHooks, CmdError> {
    let root = root.ok_or(CmdError {
        code: "hooks-no-home",
        detail: None,
    })?;
    uninstall_hooks(cli, root).map_err(|e| error(&e))?;
    Ok(row(cli, Some(root), xdev))
}

/// Every catalogue CLI, in menu order, with how it gets status hooks.
#[tauri::command(async)]
pub fn hook_installs() -> Vec<CliHooks> {
    rows(app_root, app_xdev().as_deref())
}

/// Merges xDev's status hooks into the settings of `cli` (a managed one).
#[tauri::command(async)]
pub fn hook_install(cli: Cli) -> Result<CliHooks, CmdError> {
    install_at(cli, app_root(cli).as_deref(), app_xdev().as_deref())
}

/// Takes xDev's status hooks out of the settings of `cli`.
#[tauri::command(async)]
pub fn hook_uninstall(cli: Cli) -> Result<CliHooks, CmdError> {
    uninstall_at(cli, app_root(cli).as_deref(), app_xdev().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use xdev_agent::Unsupported;

    #[test]
    fn every_cli_gets_a_row_with_a_support() {
        let root = tempfile::tempdir().unwrap();
        let all = rows(|_| Some(root.path().to_path_buf()), None);
        assert_eq!(all.len(), Cli::ALL.len());
        let gemini = all.iter().find(|r| r.cli == Cli::Gemini).unwrap();
        assert_eq!(gemini.support, HookSupport::Managed);
        assert_eq!(gemini.state, Some(HookInstall::Missing));
        assert!(
            gemini
                .settings
                .as_deref()
                .unwrap()
                .ends_with("settings.json")
        );
        let claude = all.iter().find(|r| r.cli == Cli::Claude).unwrap();
        assert_eq!((claude.state, claude.settings.as_deref()), (None, None));
        let aider = all.iter().find(|r| r.cli == Cli::Aider).unwrap();
        assert_eq!(
            aider.support,
            HookSupport::Unsupported {
                reason: Unsupported::NotChecked
            }
        );
    }

    #[test]
    fn install_then_uninstall_reports_the_state() {
        let root = tempfile::tempdir().unwrap();
        let xdev = Path::new("/opt/xdev");
        let row = install_at(Cli::Gemini, Some(root.path()), Some(xdev)).unwrap();
        assert_eq!(row.state, Some(HookInstall::Installed));
        let row = uninstall_at(Cli::Gemini, Some(root.path()), Some(xdev)).unwrap();
        assert_eq!(row.state, Some(HookInstall::Missing));
    }

    #[test]
    fn install_needs_a_home_and_the_cli() {
        let root = tempfile::tempdir().unwrap();
        let xdev = Path::new("/opt/xdev");
        assert_eq!(
            install_at(Cli::Gemini, None, Some(xdev)).unwrap_err().code,
            "hooks-no-home"
        );
        assert_eq!(
            install_at(Cli::Gemini, Some(root.path()), None)
                .unwrap_err()
                .code,
            "hooks-no-cli"
        );
        assert_eq!(
            install_at(Cli::Claude, Some(root.path()), Some(xdev))
                .unwrap_err()
                .code,
            "hooks-unsupported"
        );
    }

    #[test]
    fn a_settings_file_with_comments_is_reported_not_changed() {
        let root = tempfile::tempdir().unwrap();
        let path = hooks_settings(Cli::Gemini, root.path()).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ // mine\n}").unwrap();
        let xdev = Path::new("/opt/xdev");
        let row = row(Cli::Gemini, Some(root.path()), Some(xdev));
        assert_eq!(row.error.as_deref(), Some("hooks-unreadable"));
        let err = install_at(Cli::Gemini, Some(root.path()), Some(xdev)).unwrap_err();
        assert_eq!(err.code, "hooks-unreadable");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ // mine\n}");
    }

    #[test]
    fn a_file_of_the_persons_at_xdevs_path_is_a_conflict() {
        let root = tempfile::tempdir().unwrap();
        let path = hooks_settings(Cli::Copilot, root.path()).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();
        let xdev = Path::new("/opt/xdev");
        let row = row(Cli::Copilot, Some(root.path()), Some(xdev));
        assert_eq!(row.error.as_deref(), Some("hooks-conflict"));
        let err = install_at(Cli::Copilot, Some(root.path()), Some(xdev)).unwrap_err();
        assert_eq!(err.code, "hooks-conflict");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
    }
}
