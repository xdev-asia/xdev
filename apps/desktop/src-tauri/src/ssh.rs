//! Saved SSH hosts (`ssh_hosts.json` in the app config dir) and the sync from the OpenSSH client
//! config. Opening a host in a terminal is a shell (`shell:ssh:<alias>`), not a command here.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;
use xdev_ssh::{SshError, SshHost, SyncCounts, parse_config};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};

/// One writer at a time: a change reads the file, edits the list and writes it back.
static LOCK: Mutex<()> = Mutex::new(());

fn guard() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn cmd_error(e: SshError) -> CmdError {
    CmdError {
        code: match e {
            SshError::Io(_) => "io",
            SshError::NotFound => "not_found",
            _ => "bad_arg",
        },
        detail: Some(e.code().to_owned()),
    }
}

/// What a sync did, for the line under its button.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshSyncReport {
    pub added: u32,
    pub updated: u32,
    pub unchanged: u32,
    /// Config aliases left alone because a manual host has the same alias.
    pub skipped: u32,
    /// There is no `~/.ssh/config`.
    pub missing: bool,
    /// An `Include` line was seen; included files are not read.
    pub include_ignored: bool,
}

fn config_path() -> Option<PathBuf> {
    Some(crate::applog::home_dir()?.join(".ssh").join("config"))
}

fn list_in(dir: &Path) -> Result<Vec<SshHost>, CmdError> {
    xdev_ssh::load(dir).map_err(cmd_error)
}

fn save_in(dir: &Path, host: &SshHost, new_id: &dyn Fn() -> String) -> Result<SshHost, CmdError> {
    let _lock = guard();
    let mut hosts = xdev_ssh::load(dir).map_err(cmd_error)?;
    let mut host = host.clone();
    if host.id.trim().is_empty() {
        host.id = new_id();
    }
    // An edit of a synced host makes it the person's own: a sync no longer rewrites it.
    host.source = xdev_ssh::HostSource::Manual;
    let stored = xdev_ssh::upsert(&mut hosts, &host).map_err(cmd_error)?;
    xdev_ssh::save(dir, &hosts).map_err(cmd_error)?;
    Ok(stored)
}

fn remove_in(dir: &Path, ids: &[String]) -> Result<u32, CmdError> {
    let _lock = guard();
    let mut hosts = xdev_ssh::load(dir).map_err(cmd_error)?;
    let gone = xdev_ssh::remove_many(&mut hosts, ids);
    if gone > 0 {
        xdev_ssh::save(dir, &hosts).map_err(cmd_error)?;
    }
    Ok(u32::try_from(gone).unwrap_or(u32::MAX))
}

fn sync_in(
    dir: &Path,
    config: Option<&Path>,
    new_id: &dyn Fn() -> String,
) -> Result<SshSyncReport, CmdError> {
    let _lock = guard();
    let text = match config.map(std::fs::read_to_string) {
        Some(Ok(text)) => Some(text),
        Some(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => None,
        Some(Err(e)) => return Err(cmd_error(e.into())),
        None => None,
    };
    let Some(text) = text else {
        return Ok(SshSyncReport {
            added: 0,
            updated: 0,
            unchanged: 0,
            skipped: 0,
            missing: true,
            include_ignored: false,
        });
    };
    let parsed = parse_config(&text);
    let mut hosts = xdev_ssh::load(dir).map_err(cmd_error)?;
    let SyncCounts {
        added,
        updated,
        unchanged,
        skipped,
    } = xdev_ssh::merge_config(&mut hosts, &parsed.hosts, &mut |_| new_id());
    if added + updated > 0 {
        xdev_ssh::save(dir, &hosts).map_err(cmd_error)?;
    }
    Ok(SshSyncReport {
        added,
        updated,
        unchanged,
        skipped,
        missing: false,
        include_ignored: parsed.include_seen,
    })
}

fn new_id() -> String {
    format!("ssh-{}", uuid::Uuid::new_v4())
}

/// The saved hosts, in the order they were added.
#[tauri::command(async)]
pub fn ssh_hosts_list(state: State<'_, AppState>) -> Result<Vec<SshHost>, CmdError> {
    list_in(data_dir(&state)?)
}

/// Adds a host (empty `id`) or replaces one. The alias is trimmed and must be unique; a saved
/// host is a manual one from then on.
#[tauri::command(async)]
pub fn ssh_host_save(state: State<'_, AppState>, host: SshHost) -> Result<SshHost, CmdError> {
    save_in(data_dir(&state)?, &host, &new_id)
}

#[tauri::command(async)]
pub fn ssh_host_remove(state: State<'_, AppState>, id: String) -> Result<(), CmdError> {
    match remove_in(data_dir(&state)?, &[id])? {
        0 => Err(cmd_error(SshError::NotFound)),
        _ => Ok(()),
    }
}

/// Removes every host in `ids`; returns how many were there.
#[tauri::command(async)]
pub fn ssh_hosts_remove_many(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<u32, CmdError> {
    remove_in(data_dir(&state)?, &ids)
}

/// Reads `~/.ssh/config` again: new aliases are added, hosts that came from it are updated,
/// manual hosts are never touched.
#[tauri::command(async)]
pub fn ssh_config_sync(state: State<'_, AppState>) -> Result<SshSyncReport, CmdError> {
    sync_in(data_dir(&state)?, config_path().as_deref(), &new_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use xdev_ssh::HostSource;

    fn host(alias: &str) -> SshHost {
        SshHost {
            id: String::new(),
            alias: alias.to_owned(),
            host_name: format!("{alias}.example.com"),
            user: None,
            port: Some(22),
            identity_file: None,
            source: HostSource::Manual,
        }
    }

    fn counter() -> impl Fn() -> String {
        let n = std::sync::atomic::AtomicU32::new(0);
        move || format!("id{}", n.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
    }

    #[test]
    fn save_list_remove_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let id = counter();
        let a = save_in(dir.path(), &host("a"), &id).unwrap();
        assert_eq!(a.id, "id0");
        save_in(dir.path(), &host("b"), &id).unwrap();
        assert_eq!(list_in(dir.path()).unwrap().len(), 2);
        let mut edit = a.clone();
        edit.user = Some("me".into());
        save_in(dir.path(), &edit, &id).unwrap();
        assert_eq!(list_in(dir.path()).unwrap()[0].user.as_deref(), Some("me"));
        assert_eq!(
            remove_in(dir.path(), &["id0".into(), "nope".into()]).unwrap(),
            1
        );
        assert_eq!(list_in(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn save_refuses_bad_input() {
        let dir = tempfile::tempdir().unwrap();
        let id = counter();
        let mut bad = host("a b");
        assert_eq!(save_in(dir.path(), &bad, &id).unwrap_err().code, "bad_arg");
        bad = host("a");
        bad.port = Some(0);
        assert_eq!(save_in(dir.path(), &bad, &id).unwrap_err().code, "bad_arg");
        save_in(dir.path(), &host("a"), &id).unwrap();
        let err = save_in(dir.path(), &host("a"), &id).unwrap_err();
        assert_eq!(err.detail.as_deref(), Some("duplicate_alias"));
    }

    #[test]
    fn sync_adds_updates_and_leaves_manual_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config");
        std::fs::write(
            &cfg,
            "Include x\nHost web\n  HostName w.example.com\n  User deploy\nHost mine\n  HostName theirs\nHost *\n  User all\n",
        )
        .unwrap();
        let id = counter();
        let mut mine = host("mine");
        mine.host_name = "mine.example.com".into();
        save_in(dir.path(), &mine, &id).unwrap();

        let first = sync_in(dir.path(), Some(&cfg), &id).unwrap();
        assert_eq!((first.added, first.updated, first.skipped), (1, 0, 1));
        assert!(first.include_ignored && !first.missing);
        let hosts = list_in(dir.path()).unwrap();
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].host_name, "mine.example.com");
        assert_eq!(hosts[1].source, HostSource::SshConfig);

        std::fs::write(&cfg, "Host web\n  HostName w2.example.com\n").unwrap();
        let second = sync_in(dir.path(), Some(&cfg), &id).unwrap();
        assert_eq!((second.added, second.updated, second.unchanged), (0, 1, 0));
        assert_eq!(list_in(dir.path()).unwrap()[1].host_name, "w2.example.com");
    }

    #[test]
    fn sync_without_a_config_reports_missing() {
        let dir = tempfile::tempdir().unwrap();
        let none = dir.path().join("nope");
        let r = sync_in(dir.path(), Some(&none), &counter()).unwrap();
        assert!(r.missing);
        assert!(sync_in(dir.path(), None, &counter()).unwrap().missing);
        assert!(list_in(dir.path()).unwrap().is_empty());
    }
}
