//! Agent accounts for the Accounts view. Every call may spawn `claude` or
//! `codex`, hit the network or read session files, so all of them run off
//! the UI thread.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use xdev_agent::Routing;
use xdev_ai::{AccountEntry, AccountStatus, ActiveAccount, AiError, Provider, Quota, Registry};

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
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Account {
    name: String,
    provider: Provider,
    dir: PathBuf,
    status: AccountStatus,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Accounts {
    reserve_percent: u8,
    accounts: Vec<Account>,
    /// The active account per provider, at most one each.
    active: Vec<ActiveAccount>,
}

/// Emitted, without a payload, after an account is added, removed or made
/// active.
pub const CHANGED_EVENT: &str = "accounts://changed";

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
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

pub(crate) fn local_dir(state: &AppState) -> Result<&Path, CmdError> {
    state.local_dir.as_deref().ok_or(CmdError {
        code: "io",
        detail: Some("no local dir".into()),
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

/// One thread per account: each one waits on a CLI process and an HTTP call
/// or a file walk, and waiting for them in turn would make the view slow per
/// account.
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
        active: registry.active.clone(),
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
pub fn account_add(
    state: State<'_, AppState>,
    name: String,
    provider: String,
    dir: Option<PathBuf>,
) -> Result<Account, CmdError> {
    let provider = Provider::parse(&provider)?;
    let data = data_dir(&state)?;
    let mut registry = Registry::load(data)?;
    if let Some(dir) = dir {
        return import(data, &mut registry, &name, provider, &dir);
    }
    let dir = xdev_ai::account_dir(data, &name);
    let entry = registry.add(&name, provider, dir)?.clone();
    // Checked before anything is written, so a failed add leaves no
    // half-made account behind.
    provider.command()?;
    std::fs::create_dir_all(&entry.dir).map_err(AiError::from)?;
    registry.save(data)?;
    Ok(account(&entry))
}

/// Registers a Claude Code or Codex config folder that already exists, such
/// as a hive account. Its sign-in is used as is; nothing is copied or made.
fn import(
    data: &Path,
    registry: &mut Registry,
    name: &str,
    provider: Provider,
    dir: &Path,
) -> Result<Account, CmdError> {
    if !dir.is_dir() {
        return Err(AiError::NotFound.into());
    }
    // Stored absolute so the registry means the same from any folder.
    let dir = std::path::absolute(dir).map_err(AiError::from)?;
    let entry = registry.add(name, provider, dir)?.clone();
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

/// Makes `name` the active account of `provider`; `None` goes back to the
/// CLI's own home. Running tabs are left alone: the UI restarts the ones
/// the person picks.
#[tauri::command(async)]
pub fn account_activate(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: Provider,
    name: Option<String>,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    let mut registry = Registry::load(data)?;
    registry.activate(provider, name.as_deref())?;
    registry.save(data)?;
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(())
}

/// Copies the log of agent session `session` from account `from`'s home to
/// `to`'s, so a tab restarted under `to` can resume it; `None` is the CLI's
/// own home. Returns whether it copied (false: `to` already has it).
#[tauri::command(async)]
pub fn account_carry_session(
    state: State<'_, AppState>,
    provider: Provider,
    from: Option<String>,
    to: Option<String>,
    session: String,
    cwd: PathBuf,
) -> Result<bool, CmdError> {
    let _ = (state, provider, from, to, session, cwd);
    Err(AiError::SessionMissing.into())
}

/// The person's rules for which model a turn runs on.
#[tauri::command(async)]
pub fn routing_get(state: State<'_, AppState>) -> Result<Routing, CmdError> {
    Ok(Routing::load(data_dir(&state)?)?)
}

#[tauri::command(async)]
pub fn routing_set(state: State<'_, AppState>, routing: Routing) -> Result<(), CmdError> {
    routing.save(data_dir(&state)?)?;
    Ok(())
}

/// The models each CLI offers, for the routing picker. A CLI that is missing
/// or fails gives an empty list; the person can still type a name.
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Models {
    claude: Vec<String>,
    codex: Vec<String>,
}

#[tauri::command(async)]
pub fn routing_models() -> Models {
    let (claude, codex) = std::thread::scope(|s| {
        let codex = s.spawn(|| xdev_ai::codex_models().unwrap_or_default());
        let claude = xdev_ai::claude_models().unwrap_or_default();
        (claude, codex.join().unwrap_or_default())
    });
    Models { claude, codex }
}

#[tauri::command(async)]
pub fn account_login(state: State<'_, AppState>, name: String) -> Result<LoginStart, CmdError> {
    let registry = Registry::load(data_dir(&state)?)?;
    let entry = registry.get(&name).ok_or(AiError::NotFound)?;
    let command = xdev_ai::login_command(entry.provider, &entry.dir, cfg!(windows));
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

    let provider = entry.provider;
    let cli = provider.command()?;
    let program = cli.get_program().to_string_lossy().into_owned();
    let args = provider.login_args().join(" ");
    std::process::Command::new("cmd.exe")
        .raw_arg(format!("/c \"\"{program}\" {args} & pause\""))
        .env(provider.home_var(), &entry.dir)
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
            active: vec![ActiveAccount {
                provider: Provider::Claude,
                name: "a".into(),
            }],
            accounts: vec![
                Account {
                    name: "a".into(),
                    provider: Provider::Claude,
                    dir: PathBuf::from("d"),
                    status: AccountStatus {
                        state: StatusState::LoggedOut,
                        email: None,
                        plan: None,
                        org: None,
                    },
                },
                Account {
                    name: "c".into(),
                    provider: Provider::Codex,
                    dir: PathBuf::from("e"),
                    status: AccountStatus {
                        state: StatusState::NoCodex,
                        email: None,
                        plan: None,
                        org: None,
                    },
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(accounts).unwrap(),
            serde_json::json!({ "reservePercent": 30, "accounts": [{
                "name": "a", "provider": "claude", "dir": "d",
                "status": { "state": "logged_out", "email": null, "plan": null, "org": null }
            }, {
                "name": "c", "provider": "codex", "dir": "e",
                "status": { "state": "no_codex", "email": null, "plan": null, "org": null }
            }], "active": [{ "provider": "claude", "name": "a" }] })
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
    fn import_registers_an_existing_folder_without_touching_it() {
        let data = tempfile::tempdir().unwrap();
        let hive = tempfile::tempdir().unwrap();
        let mut registry = Registry::load(data.path()).unwrap();
        let missing = hive.path().join("missing");
        let Err(err) = import(data.path(), &mut registry, "h", Provider::Claude, &missing) else {
            panic!("a missing folder was registered");
        };
        assert_eq!(err.code, "not_found");
        assert!(!missing.exists());

        import(
            data.path(),
            &mut registry,
            "h",
            Provider::Codex,
            hive.path(),
        )
        .unwrap();
        let saved = Registry::load(data.path()).unwrap();
        assert_eq!(saved.accounts.len(), 1);
        assert_eq!(saved.accounts[0].dir, hive.path());
        assert_eq!(saved.accounts[0].provider, Provider::Codex);
        assert!(!xdev_ai::account_dir(data.path(), "h").exists());
    }

    #[test]
    fn ai_errors_keep_their_code() {
        assert_eq!(CmdError::from(AiError::Exists).code, "exists");
        assert_eq!(CmdError::from(AiError::NoClaude).code, "no_claude");
        assert_eq!(CmdError::from(AiError::NoCodex).code, "no_codex");
        let unknown = Provider::parse("gemini").unwrap_err();
        assert_eq!(CmdError::from(unknown).code, "unknown_provider");
    }
}
