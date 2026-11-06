//! Agent accounts for the Accounts view. Every call may spawn `claude` or
//! `codex`, hit the network or read session files, so all of them run off
//! the UI thread.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use xdev_agent::Routing;
use xdev_ai::{
    AccountEntry, AccountStatus, ActiveAccount, AiError, AlertLog, Provider, Quota, QuotaAlert,
    Registry,
};

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

/// Emitted with a `QuotaAlert` when an account's quota crosses one of its
/// provider's thresholds, once per window and threshold.
pub const QUOTA_ALERT_EVENT: &str = "accounts://quota-alert";

/// What routing at spawn reads: the latest quota readings, and the account
/// each provider's last routed agent started on. Kept in memory only.
#[derive(Default)]
struct Hub {
    quotas: Vec<Quota>,
    last_used: Vec<(Provider, String)>,
    alerts: AlertLog,
}

static HUB: LazyLock<Mutex<Hub>> = LazyLock::new(Mutex::default);

fn hub() -> MutexGuard<'static, Hub> {
    HUB.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Hub {
    /// Keeps `quotas` for routing and returns the alerts they raise.
    fn observe(&mut self, registry: &Registry, quotas: &[Quota]) -> Vec<QuotaAlert> {
        let mut alerts = Vec::new();
        for quota in quotas {
            let Some(entry) = registry.get(&quota.name) else {
                continue;
            };
            let thresholds = registry.routing(entry.provider).thresholds;
            alerts.extend(self.alerts.check(entry.provider, quota, &thresholds));
        }
        // A removed account's windows start afresh if it comes back.
        let gone: Vec<String> = self
            .quotas
            .iter()
            .filter(|q| registry.get(&q.name).is_none())
            .map(|q| q.name.clone())
            .collect();
        for name in gone {
            self.alerts.forget(&name);
        }
        self.quotas = quotas.to_vec();
        alerts
    }

    fn last_used(&self, provider: Provider) -> Option<&str> {
        self.last_used
            .iter()
            .find(|(p, _)| *p == provider)
            .map(|(_, name)| name.as_str())
    }

    fn started(&mut self, provider: Provider, name: &str) {
        self.last_used.retain(|(p, _)| *p != provider);
        self.last_used.push((provider, name.to_owned()));
    }
}

/// The account a new agent of `provider` with no account of its own starts
/// on, by the provider's routing and the latest quota readings.
pub(crate) fn routed(registry: &Registry, provider: Provider) -> Option<String> {
    let hub = hub();
    registry.route(provider, &hub.quotas, hub.last_used(provider), None)
}

/// Another account of `provider` for an agent that failed on `current`, by
/// the provider's routing; none when no other one is signed in.
pub(crate) fn backup(registry: &Registry, provider: Provider, current: &str) -> Option<String> {
    let hub = hub();
    registry.route(
        provider,
        &hub.quotas,
        hub.last_used(provider),
        Some(current),
    )
}

/// How much of account `name`'s tightest quota window is used, in percent,
/// by the latest reading.
pub(crate) fn used(name: &str) -> Option<f64> {
    hub().quotas.iter().find(|q| q.name == name).and_then(|q| {
        q.windows
            .iter()
            .filter_map(|w| w.utilization)
            .max_by(f64::total_cmp)
    })
}

/// Records that a routed agent of `provider` started on `name`, for round
/// robin.
pub(crate) fn started(provider: Provider, name: &str) {
    hub().started(provider, name);
}

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

/// A Codex quota may wait seconds on its `app-server` probe while holding
/// that home's lock, so the reads run on a blocking thread and not on the
/// async runtime's workers.
///
/// Also keeps the readings for routing, and emits `QUOTA_ALERT_EVENT` for
/// each threshold they cross.
#[tauri::command]
pub async fn accounts_quota(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<Quota>, CmdError> {
    let registry = Registry::load(data_dir(&state)?)?;
    let (quotas, alerts) = tauri::async_runtime::spawn_blocking(move || {
        let reserve = registry.reserve_percent;
        let quotas = each(&registry.accounts, |e| {
            xdev_ai::quota(e, &xdev_ai::status(e), reserve)
        });
        let alerts = hub().observe(&registry, &quotas);
        (quotas, alerts)
    })
    .await
    .map_err(|e| CmdError {
        code: "io",
        detail: Some(e.to_string()),
    })?;
    for alert in alerts {
        let _ = app.emit(QUOTA_ALERT_EVENT, alert);
    }
    Ok(quotas)
}

/// Each provider's account routing, Claude first.
#[tauri::command(async)]
pub fn accounts_routing(state: State<'_, AppState>) -> Result<Vec<xdev_ai::Routing>, CmdError> {
    let registry = Registry::load(data_dir(&state)?)?;
    Ok([Provider::Claude, Provider::Codex]
        .into_iter()
        .map(|p| registry.routing(p))
        .collect())
}

/// Replaces one provider's account routing; only new agents follow it.
#[tauri::command(async)]
pub fn account_routing_set(
    app: AppHandle,
    state: State<'_, AppState>,
    routing: xdev_ai::Routing,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    let mut registry = Registry::load(data)?;
    registry.set_routing(routing)?;
    registry.save(data)?;
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(())
}

/// Makes the account routing picks, other than `avoid` (else the current
/// default), the provider's default for new tabs, and returns it. `None`
/// when there is no other account to use; nothing changes then.
#[tauri::command(async)]
pub fn account_use_next(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: Provider,
    avoid: Option<String>,
) -> Result<Option<String>, CmdError> {
    let data = data_dir(&state)?;
    let mut registry = Registry::load(data)?;
    let next = use_next(&mut registry, &hub(), provider, avoid.as_deref())?;
    if next.is_some() {
        registry.save(data)?;
        let _ = app.emit(CHANGED_EVENT, ());
    }
    Ok(next)
}

fn use_next(
    registry: &mut Registry,
    hub: &Hub,
    provider: Provider,
    avoid: Option<&str>,
) -> Result<Option<String>, CmdError> {
    let current = registry.active(provider).map(|a| a.name.clone());
    let Some(avoid) = avoid.map(str::to_owned).or(current) else {
        return Ok(None);
    };
    let next = registry.route(provider, &hub.quotas, hub.last_used(provider), Some(&avoid));
    if let Some(name) = &next {
        registry.activate(provider, Some(name))?;
    }
    Ok(next)
}

#[tauri::command(async)]
pub fn account_add(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    provider: String,
    dir: Option<PathBuf>,
) -> Result<Account, CmdError> {
    let provider = Provider::parse(&provider)?;
    let data = data_dir(&state)?;
    let mut registry = Registry::load(data)?;
    if let Some(dir) = dir {
        let added = import(data, &mut registry, &name, provider, &dir)?;
        let _ = app.emit(CHANGED_EVENT, ());
        return Ok(added);
    }
    let dir = xdev_ai::account_dir(data, &name);
    let entry = registry.add(&name, provider, dir)?.clone();
    // Checked before anything is written, so a failed add leaves no
    // half-made account behind.
    provider.command()?;
    std::fs::create_dir_all(&entry.dir).map_err(AiError::from)?;
    registry.save(data)?;
    let _ = app.emit(CHANGED_EVENT, ());
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
pub fn account_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    let mut registry = Registry::load(data)?;
    registry.remove(&name)?;
    registry.save(data)?;
    let _ = app.emit(CHANGED_EVENT, ());
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
    let registry = Registry::load(data_dir(&state)?)?;
    let home = xdev_ai::default_home(provider);
    carry(&registry, home, provider, from, to, &session, &cwd)
}

/// `account_carry_session` with the registry and the CLI's own home given.
fn carry(
    registry: &Registry,
    default_home: Option<PathBuf>,
    provider: Provider,
    from: Option<String>,
    to: Option<String>,
    session: &str,
    cwd: &Path,
) -> Result<bool, CmdError> {
    let home = |name: Option<String>| -> Result<AccountEntry, CmdError> {
        match name {
            Some(name) => registry
                .get(&name)
                .filter(|e| e.provider == provider)
                .cloned()
                .ok_or_else(|| AiError::NotFound.into()),
            None => Ok(AccountEntry {
                name: String::new(),
                provider,
                dir: default_home.clone().ok_or(AiError::NotFound)?,
            }),
        }
    };
    let (from, to) = (home(from)?, home(to)?);
    Ok(xdev_ai::carry_session(&from, &to, session, cwd)?)
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

/// Which row of `routing`'s match table takes this work, for the editor's
/// test box; the rows are the editor's, saved or not.
#[tauri::command(async)]
pub fn routing_match(
    routing: Routing,
    sentence: String,
    label: Option<String>,
) -> xdev_agent::Matched {
    routing.route(&sentence, label.as_deref())
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
    fn carry_resolves_names_and_the_default_home() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let mut registry = Registry::load(&data).unwrap();
        registry
            .add("work", Provider::Claude, tmp.path().join("work"))
            .unwrap();
        registry
            .add("gpt", Provider::Codex, tmp.path().join("gpt"))
            .unwrap();
        let cli = tmp.path().join("cli");
        let cwd = tmp.path().join("repo");
        let id = "s1";
        let log = cli.join("projects").join("-x").join("s1.jsonl");
        std::fs::create_dir_all(log.parent().unwrap()).unwrap();
        std::fs::write(&log, "x").unwrap();
        let run = |from: Option<&str>, to: Option<&str>, home: Option<PathBuf>| {
            carry(
                &registry,
                home,
                Provider::Claude,
                from.map(str::to_owned),
                to.map(str::to_owned),
                id,
                &cwd,
            )
        };
        // The CLI's own home to an account, then nothing left to copy.
        assert!(run(None, Some("work"), Some(cli.clone())).unwrap());
        assert!(tmp.path().join("work/projects/-x/s1.jsonl").is_file());
        assert!(!run(None, Some("work"), Some(cli.clone())).unwrap());
        // Back to the CLI's home, which has it.
        assert!(!run(Some("work"), None, Some(cli.clone())).unwrap());
        // Unknown names, another provider's account, no home at all.
        for (from, to, home) in [
            (Some("nope"), None, Some(cli.clone())),
            (None, Some("gpt"), Some(cli.clone())),
            (None, Some("work"), None),
        ] {
            let err = run(from, to, home).unwrap_err();
            assert_eq!(err.code, "not_found", "{from:?} {to:?}");
        }
        let err = carry(
            &registry,
            Some(cli.clone()),
            Provider::Claude,
            None,
            Some("work".into()),
            "gone",
            &cwd,
        )
        .unwrap_err();
        assert_eq!(err.code, "session_missing");
    }

    #[test]
    fn ai_errors_keep_their_code() {
        assert_eq!(CmdError::from(AiError::Exists).code, "exists");
        assert_eq!(CmdError::from(AiError::NoClaude).code, "no_claude");
        assert_eq!(CmdError::from(AiError::NoCodex).code, "no_codex");
        let unknown = Provider::parse("gemini").unwrap_err();
        assert_eq!(CmdError::from(unknown).code, "unknown_provider");
    }

    fn routed_registry(data: &Path) -> Registry {
        let mut reg = Registry::default();
        for name in ["work", "home", "spare"] {
            reg.add(name, Provider::Claude, data.join(name)).unwrap();
        }
        reg.activate(Provider::Claude, Some("work")).unwrap();
        reg
    }

    fn reading(name: &str, five: f64) -> Quota {
        Quota {
            name: name.into(),
            state: xdev_ai::QuotaState::Ok,
            reason: None,
            windows: vec![xdev_ai::QuotaWindow {
                key: "five_hour".into(),
                utilization: Some(five),
                resets_at: Some("2026-11-06T20:00:00Z".into()),
            }],
            as_of: None,
        }
    }

    #[test]
    fn observe_alerts_once_and_keeps_the_readings() {
        let tmp = tempfile::tempdir().unwrap();
        let mut reg = routed_registry(tmp.path());
        let mut hub = Hub::default();
        let first = hub.observe(&reg, &[reading("work", 82.0), reading("home", 10.0)]);
        assert_eq!(first.len(), 1);
        assert_eq!(
            (first[0].account.as_str(), first[0].threshold),
            ("work", 80)
        );
        let again = hub.observe(&reg, &[reading("work", 84.0), reading("home", 10.0)]);
        assert!(again.is_empty());
        assert_eq!(hub.quotas.len(), 2);
        // Thresholds are the provider's own.
        reg.set_routing(xdev_ai::Routing {
            thresholds: vec![50],
            ..xdev_ai::Routing::new(Provider::Claude)
        })
        .unwrap();
        let alerts = hub.observe(&reg, &[reading("home", 55.0)]);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].threshold, 50);
    }

    #[test]
    fn use_next_moves_the_default_off_the_alerting_account() {
        let tmp = tempfile::tempdir().unwrap();
        let mut reg = routed_registry(tmp.path());
        let mut hub = Hub::default();
        let quotas = [
            reading("work", 96.0),
            reading("home", 40.0),
            reading("spare", 20.0),
        ];
        hub.observe(&reg, &quotas);
        let next = use_next(&mut reg, &hub, Provider::Claude, Some("work")).unwrap();
        assert_eq!(next.as_deref(), Some("spare"));
        assert_eq!(reg.active(Provider::Claude).unwrap().name, "spare");
        // No account to avoid given: away from the current default.
        let next = use_next(&mut reg, &hub, Provider::Claude, None).unwrap();
        assert_eq!(next.as_deref(), Some("home"));
        // Nothing else to use: no change.
        let mut lone = Registry::default();
        lone.add("only", Provider::Codex, tmp.path().join("o"))
            .unwrap();
        lone.activate(Provider::Codex, Some("only")).unwrap();
        assert_eq!(
            use_next(&mut lone, &hub, Provider::Codex, None).unwrap(),
            None
        );
        assert_eq!(lone.active(Provider::Codex).unwrap().name, "only");
    }

    #[test]
    fn round_robin_follows_the_last_started() {
        let tmp = tempfile::tempdir().unwrap();
        let mut reg = routed_registry(tmp.path());
        reg.set_routing(xdev_ai::Routing {
            policy: xdev_ai::Policy::RoundRobin,
            ..xdev_ai::Routing::new(Provider::Claude)
        })
        .unwrap();
        let mut hub = Hub::default();
        let pick = |hub: &Hub| {
            reg.route(
                Provider::Claude,
                &hub.quotas,
                hub.last_used(Provider::Claude),
                None,
            )
        };
        assert_eq!(pick(&hub).as_deref(), Some("work"));
        hub.started(Provider::Claude, "work");
        assert_eq!(pick(&hub).as_deref(), Some("home"));
        hub.started(Provider::Claude, "home");
        assert_eq!(pick(&hub).as_deref(), Some("spare"));
    }
}
