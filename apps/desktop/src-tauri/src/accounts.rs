//! Agent accounts for the Accounts view. Every call may spawn `claude` or hit
//! the network, so all of them run off the UI thread.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use xdev_ai::{AccountEntry, AccountStatus, AiError, Provider, Quota, Registry};

use crate::commands::{AppState, CmdError};

impl From<AiError> for CmdError {
    fn from(e: AiError) -> CmdError {
        CmdError {
            code: e.code(),
            detail: Some(e.to_string()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    name: String,
    provider: Provider,
    dir: PathBuf,
    status: AccountStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Accounts {
    reserve_percent: u8,
    accounts: Vec<Account>,
}

#[derive(Serialize)]
pub struct LoginStart {
    opened: bool,
    command: String,
}

pub(crate) fn data_dir(state: &AppState) -> Result<&Path, CmdError> {
    state.data_dir.as_deref().ok_or(CmdError {
        code: "io",
        detail: Some("no data dir".into()),
    })
}

fn account(entry: &AccountEntry) -> Account {
    Account {
        name: entry.name.clone(),
        provider: entry.provider,
        dir: entry.dir.clone(),
        status: xdev_ai::status(entry),
    }
}

/// One thread per account: each one waits on a `claude` process and an HTTP
/// call, and waiting for them in turn would make the view slow per account.
fn each<T: Send>(entries: &[AccountEntry], f: impl Fn(&AccountEntry) -> T + Sync) -> Vec<T> {
    std::thread::scope(|s| {
        let handles: Vec<_> = entries.iter().map(|e| s.spawn(|| f(e))).collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("account thread"))
            .collect()
    })
}

#[tauri::command(async)]
pub fn accounts_list(state: State<'_, AppState>) -> Result<Accounts, CmdError> {
    let registry = Registry::load(data_dir(&state)?)?;
    Ok(Accounts {
        reserve_percent: registry.reserve_percent,
        accounts: each(&registry.accounts, account),
    })
}

#[tauri::command(async)]
pub fn accounts_quota(state: State<'_, AppState>) -> Result<Vec<Quota>, CmdError> {
    let registry = Registry::load(data_dir(&state)?)?;
    let reserve = registry.reserve_percent;
    Ok(each(&registry.accounts, |e| {
        xdev_ai::quota(e, &xdev_ai::status(e), reserve)
    }))
}

#[tauri::command(async)]
pub fn account_add(state: State<'_, AppState>, name: String) -> Result<Account, CmdError> {
    let data = data_dir(&state)?;
    let mut registry = Registry::load(data)?;
    let dir = xdev_ai::account_dir(data, &name);
    let entry = registry.add(&name, dir)?.clone();
    // Checked before anything is written, so a failed add leaves no
    // half-made account behind.
    xdev_ai::claude_command()?;
    std::fs::create_dir_all(&entry.dir).map_err(AiError::from)?;
    registry.save(data)?;
    Ok(account(&entry))
}

#[tauri::command(async)]
pub fn account_remove(state: State<'_, AppState>, name: String) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    let mut registry = Registry::load(data)?;
    registry.remove(&name)?;
    registry.save(data)?;
    Ok(())
}

#[tauri::command(async)]
pub fn account_login(state: State<'_, AppState>, name: String) -> Result<LoginStart, CmdError> {
    let registry = Registry::load(data_dir(&state)?)?;
    let entry = registry.get(&name).ok_or(AiError::NotFound)?;
    let command = xdev_ai::login_command(&entry.dir, cfg!(windows));
    Ok(LoginStart {
        opened: open_login(entry)?,
        command,
    })
}

/// The login flow is interactive (browser, then a code pasted back), so it
/// needs a real console; the window stays open so the person sees the result.
#[cfg(windows)]
fn open_login(entry: &AccountEntry) -> Result<bool, CmdError> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

    let claude = xdev_ai::claude_command()?;
    let program = claude.get_program().to_string_lossy().into_owned();
    std::process::Command::new("cmd.exe")
        .raw_arg(format!("/c \"\"{program}\" auth login & pause\""))
        .env("CLAUDE_CONFIG_DIR", &entry.dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map_err(AiError::from)?;
    Ok(true)
}

#[cfg(not(windows))]
fn open_login(_entry: &AccountEntry) -> Result<bool, CmdError> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use xdev_ai::StatusState;

    use super::*;

    #[test]
    fn accounts_serialize_like_the_ui_expects() {
        let accounts = Accounts {
            reserve_percent: 30,
            accounts: vec![Account {
                name: "a".into(),
                provider: Provider::Claude,
                dir: PathBuf::from("d"),
                status: AccountStatus {
                    state: StatusState::LoggedOut,
                    email: None,
                    plan: None,
                    org: None,
                },
            }],
        };
        assert_eq!(
            serde_json::to_value(accounts).unwrap(),
            serde_json::json!({ "reservePercent": 30, "accounts": [{
                "name": "a", "provider": "claude", "dir": "d",
                "status": { "state": "logged_out", "email": null, "plan": null, "org": null }
            }] })
        );
        let login = LoginStart {
            opened: false,
            command: "c".into(),
        };
        assert_eq!(
            serde_json::to_value(login).unwrap(),
            serde_json::json!({ "opened": false, "command": "c" })
        );
    }

    #[test]
    fn ai_errors_keep_their_code() {
        assert_eq!(CmdError::from(AiError::Exists).code, "exists");
        assert_eq!(CmdError::from(AiError::NoClaude).code, "no_claude");
    }
}
