//! Settings that belong to one SSH host: what resolves for it (its own
//! value, else the global one, else the built-in default) and which host a
//! path runs on. Local is the global settings; only SSH hosts have overrides.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use xdev_ssh::SshHost;

use crate::accounts::data_dir;
use crate::agent_sessions::HISTORY_DAYS;
use crate::commands::{AppState, CmdError};
use crate::settings::{HOST_DAYS_RANGE, HostEnvVar, HostSettings, Settings, SettingsSection};
use crate::settings_store;

/// Where a path runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostScope {
    Local,
    Ssh(String),
}

/// `Ssh(id)` for an `ssh://<id>/...` worktree, or for a local checkout that has a remote target
/// ("run on host"); `Local` for anything else, including an `ssh://` string with a bad host id.
pub fn scope_of(path: &str, data: &Path) -> HostScope {
    if let Some(r) = crate::remote_ssh::remote_ref(Path::new(path)) {
        return HostScope::Ssh(r.host_id);
    }
    if path.starts_with("ssh://") {
        return HostScope::Local;
    }
    match crate::remote_ssh::target_of(data, Path::new(path)) {
        Ok(Some(target)) => HostScope::Ssh(target.host_id),
        _ => HostScope::Local,
    }
}

pub const DEFAULT_CLAUDE_HOME: &str = "~/.claude";
pub const DEFAULT_CODEX_HOME: &str = "~/.codex";

/// A host's values with every default filled in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EffectiveHost {
    /// The label, else the host alias.
    pub label: String,
    /// `None` = the host's `"$SHELL" -l`.
    pub shell: Option<String>,
    pub env: Vec<HostEnvVar>,
    pub history: EffectiveHistory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EffectiveHistory {
    pub enabled: bool,
    pub claude_home: String,
    pub codex_home: String,
    pub days: u32,
}

/// `stored` over the defaults; `alias` names the host when it has no label.
pub fn effective(stored: Option<&HostSettings>, alias: &str) -> EffectiveHost {
    let empty = HostSettings::default();
    let s = stored.unwrap_or(&empty);
    let days = s.history.days.unwrap_or(HISTORY_DAYS);
    EffectiveHost {
        label: s.label.clone().unwrap_or_else(|| alias.to_owned()),
        shell: s.shell.clone(),
        env: s.env.clone(),
        history: EffectiveHistory {
            enabled: s.history.enabled.unwrap_or(true),
            claude_home: s
                .history
                .claude_home
                .clone()
                .unwrap_or_else(|| DEFAULT_CLAUDE_HOME.to_owned()),
            codex_home: s
                .history
                .codex_home
                .clone()
                .unwrap_or_else(|| DEFAULT_CODEX_HOME.to_owned()),
            days: days.clamp(*HOST_DAYS_RANGE.start(), *HOST_DAYS_RANGE.end()),
        },
    }
}

/// The picker entry of Local; never a valid SSH host id.
pub const LOCAL_ID: &str = "local";

/// One row of the host picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostScopeEntry {
    pub id: String,
    pub alias: String,
    pub label: String,
    /// How many values the host sets itself.
    pub overrides: u32,
}

/// What the page shows for one host.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostSettingsView {
    pub host_id: String,
    pub stored: HostSettings,
    pub effective: EffectiveHost,
    pub history: HostHistoryStatus,
}

/// The state of the host's session mirror.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostHistoryStatus {
    #[cfg_attr(test, ts(optional))]
    pub last_sync_ms: Option<u64>,
    pub files: u32,
    pub bytes: u64,
    pub capped: bool,
    #[cfg_attr(test, ts(optional))]
    pub error: Option<CmdError>,
}

/// `<data>/hosts/<id>/`: the mirror, its index and `status.json`. `id` must be a valid host id.
pub fn host_dir(data: &Path, id: &str) -> PathBuf {
    data.join("hosts").join(id)
}

/// Deletes the mirror of `id`; an id that is not a host id is left alone.
pub fn remove_mirror(data: &Path, id: &str) {
    if xdev_ssh::valid_host_id(id) {
        let _ = std::fs::remove_dir_all(host_dir(data, id));
    }
}

/// How many values `s` sets.
pub fn overrides(s: &HostSettings) -> u32 {
    let h = &s.history;
    [
        s.label.is_some(),
        s.shell.is_some(),
        !s.env.is_empty(),
        h.enabled.is_some(),
        h.claude_home.is_some(),
        h.codex_home.is_some(),
        h.days.is_some(),
    ]
    .into_iter()
    .map(u32::from)
    .sum()
}

/// Local first, then every saved host in store order.
pub fn scopes_list_in(hosts: &[SshHost], settings: &Settings) -> Vec<HostScopeEntry> {
    let local = HostScopeEntry {
        id: LOCAL_ID.to_owned(),
        alias: LOCAL_ID.to_owned(),
        label: "Local".to_owned(),
        overrides: 0,
    };
    let rest = hosts.iter().map(|h| {
        let stored = settings.hosts.0.get(&h.id);
        HostScopeEntry {
            id: h.id.clone(),
            alias: h.alias.clone(),
            label: effective(stored, &h.alias).label,
            overrides: stored.map_or(0, overrides),
        }
    });
    std::iter::once(local).chain(rest).collect()
}

fn not_found(id: &str) -> CmdError {
    CmdError {
        code: "not_found",
        detail: Some(id.to_owned()),
    }
}

fn find_host<'a>(hosts: &'a [SshHost], id: &str) -> Result<&'a SshHost, CmdError> {
    hosts
        .iter()
        .find(|h| h.id == id)
        .ok_or_else(|| not_found(id))
}

/// What `status.json` keeps of a sync.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StatusFile {
    last_sync_ms: Option<u64>,
    files: u32,
    bytes: u64,
    capped: bool,
}

pub fn status_path(data: &Path, id: &str) -> PathBuf {
    host_dir(data, id).join("status.json")
}

/// The last sync as persisted; empty when there was none.
pub fn read_status(data: &Path, id: &str) -> HostHistoryStatus {
    let f: StatusFile = std::fs::read(status_path(data, id))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    HostHistoryStatus {
        last_sync_ms: f.last_sync_ms,
        files: f.files,
        bytes: f.bytes,
        capped: f.capped,
        error: None,
    }
}

pub fn view_of(
    data: &Path,
    hosts: &[SshHost],
    settings: &Settings,
    id: &str,
) -> Result<HostSettingsView, CmdError> {
    let host = find_host(hosts, id)?;
    let stored = settings.hosts.0.get(id).cloned().unwrap_or_default();
    Ok(HostSettingsView {
        host_id: id.to_owned(),
        effective: effective(Some(&stored), &host.alias),
        stored,
        history: read_status(data, id),
    })
}

/// Validates `new` and stores it for `id`; an empty value removes the entry. Entries of hosts
/// that are no longer saved are dropped as well.
pub fn put_into(
    settings: &mut Settings,
    hosts: &[SshHost],
    id: &str,
    new: HostSettings,
) -> Result<(), CmdError> {
    find_host(hosts, id)?;
    let new = new.validated().map_err(|(code, detail)| CmdError {
        code,
        detail: Some(detail),
    })?;
    settings
        .hosts
        .0
        .retain(|k, _| hosts.iter().any(|h| &h.id == k));
    if new.is_empty() {
        settings.hosts.0.remove(id);
    } else {
        settings.hosts.0.insert(id.to_owned(), new);
    }
    Ok(())
}

/// Drops the overrides of removed hosts.
pub fn forget(settings: &mut Settings, ids: &[String]) {
    settings.hosts.0.retain(|k, _| !ids.contains(k));
}

fn saved_hosts(data: &Path) -> Result<Vec<SshHost>, CmdError> {
    xdev_ssh::load(data).map_err(crate::ssh::cmd_error)
}

/// Local, then each saved SSH host.
#[tauri::command(async)]
pub fn host_scopes_list(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<HostScopeEntry>, CmdError> {
    let hosts = saved_hosts(data_dir(&state)?)?;
    Ok(scopes_list_in(&hosts, &settings_store::read(&app)))
}

/// One host's stored and effective values and its history mirror state.
#[tauri::command(async)]
pub fn host_settings_get(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
) -> Result<HostSettingsView, CmdError> {
    let data = data_dir(&state)?;
    view_of(
        data,
        &saved_hosts(data)?,
        &settings_store::read(&app),
        &host_id,
    )
}

/// Replaces one host's overrides. Turning history off deletes its mirror.
#[tauri::command(async)]
pub fn host_settings_put(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    settings: HostSettings,
) -> Result<HostSettingsView, CmdError> {
    let data = data_dir(&state)?;
    let hosts = saved_hosts(data)?;
    let saved = settings_store::try_write(&app, &[SettingsSection::Hosts], |s| {
        put_into(s, &hosts, &host_id, settings)?;
        Ok(s.clone())
    })?;
    let history_off = saved
        .hosts
        .0
        .get(&host_id)
        .is_some_and(|h| h.history.enabled == Some(false));
    if history_off {
        remove_mirror(data, &host_id);
    }
    view_of(data, &hosts, &saved, &host_id)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::settings::HostHistory;
    use xdev_ssh::RemoteTarget;

    fn ssh(id: &str, alias: &str) -> SshHost {
        SshHost {
            id: id.to_owned(),
            alias: alias.to_owned(),
            host_name: format!("{alias}.example.com"),
            ..SshHost::default()
        }
    }

    fn with_shell(shell: &str) -> HostSettings {
        HostSettings {
            shell: Some(shell.to_owned()),
            ..HostSettings::default()
        }
    }

    #[test]
    fn the_list_is_local_first_then_hosts_in_store_order() {
        let hosts = [ssh("ssh-b", "bee"), ssh("ssh-a", "ay")];
        let mut s = Settings::default();
        let mut h = with_shell("/bin/zsh");
        h.label = Some("Bee box".into());
        h.history.days = Some(5);
        s.hosts.0.insert("ssh-b".into(), h);
        let list = scopes_list_in(&hosts, &s);
        let ids: Vec<&str> = list.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["local", "ssh-b", "ssh-a"]);
        assert_eq!((list[1].label.as_str(), list[1].overrides), ("Bee box", 3));
        assert_eq!((list[2].label.as_str(), list[2].overrides), ("ay", 0));
        assert_eq!(list[0].overrides, 0);
    }

    #[test]
    fn put_checks_the_host_and_removes_an_empty_entry() {
        let hosts = [ssh("ssh-a", "ay")];
        let mut s = Settings::default();
        let e = put_into(&mut s, &hosts, "ssh-zzz", with_shell("/bin/zsh")).unwrap_err();
        assert_eq!(e.code, "not_found");
        assert!(s.hosts.0.is_empty());

        put_into(&mut s, &hosts, "ssh-a", with_shell("/bin/zsh")).unwrap();
        assert_eq!(s.hosts.0["ssh-a"].shell.as_deref(), Some("/bin/zsh"));
        put_into(&mut s, &hosts, "ssh-a", HostSettings::default()).unwrap();
        assert!(s.hosts.0.is_empty());

        let e = put_into(&mut s, &hosts, "ssh-a", with_shell("zsh")).unwrap_err();
        assert_eq!(e.code, "bad_path");
    }

    #[test]
    fn put_prunes_ids_that_are_not_saved_hosts() {
        let hosts = [ssh("ssh-a", "ay")];
        let mut s = Settings::default();
        s.hosts.0.insert("ssh-gone".into(), with_shell("/bin/sh"));
        put_into(&mut s, &hosts, "ssh-a", with_shell("/bin/zsh")).unwrap();
        let ids: Vec<&String> = s.hosts.0.keys().collect();
        assert_eq!(ids, ["ssh-a"]);
    }

    #[test]
    fn the_view_holds_stored_effective_and_status() {
        let dir = tempfile::tempdir().unwrap();
        let hosts = [ssh("ssh-a", "ay")];
        let mut s = Settings::default();
        s.hosts.0.insert("ssh-a".into(), with_shell("/bin/zsh"));
        let v = view_of(dir.path(), &hosts, &s, "ssh-a").unwrap();
        assert_eq!(v.stored.shell.as_deref(), Some("/bin/zsh"));
        assert_eq!(v.effective.label, "ay");
        assert_eq!(v.history, HostHistoryStatus::default());
        assert_eq!(
            view_of(dir.path(), &hosts, &s, "nope").unwrap_err().code,
            "not_found"
        );
        let d = host_dir(dir.path(), "ssh-a");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("status.json"),
            r#"{"lastSyncMs":9,"files":2,"bytes":30,"capped":true}"#,
        )
        .unwrap();
        let v = view_of(dir.path(), &hosts, &s, "ssh-a").unwrap();
        assert_eq!(
            (
                v.history.last_sync_ms,
                v.history.files,
                v.history.bytes,
                v.history.capped
            ),
            (Some(9), 2, 30, true)
        );
    }

    #[test]
    fn forgetting_a_host_drops_its_overrides_and_mirror() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Settings::default();
        s.hosts.0.insert("ssh-a".into(), with_shell("/bin/zsh"));
        s.hosts.0.insert("ssh-b".into(), with_shell("/bin/sh"));
        for id in ["ssh-a", "ssh-b"] {
            let d = host_dir(dir.path(), id).join("logs");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("x"), "x").unwrap();
        }
        forget(&mut s, &["ssh-a".into()]);
        remove_mirror(dir.path(), "ssh-a");
        remove_mirror(dir.path(), "../..");
        assert!(!s.hosts.0.contains_key("ssh-a") && s.hosts.0.contains_key("ssh-b"));
        assert!(!host_dir(dir.path(), "ssh-a").exists());
        assert!(host_dir(dir.path(), "ssh-b").exists());
    }

    #[test]
    fn nothing_stored_gives_the_defaults() {
        let e = effective(None, "box");
        assert_eq!(e.label, "box");
        assert_eq!(e.shell, None);
        assert!(e.env.is_empty());
        assert!(e.history.enabled);
        assert_eq!(e.history.claude_home, "~/.claude");
        assert_eq!(e.history.codex_home, "~/.codex");
        assert_eq!(e.history.days, 90);
        assert_eq!(effective(Some(&HostSettings::default()), "box"), e);
    }

    #[test]
    fn each_override_wins_alone() {
        let base = effective(None, "box");
        let with = |f: &dyn Fn(&mut HostSettings)| {
            let mut h = HostSettings::default();
            f(&mut h);
            effective(Some(&h), "box")
        };
        assert_eq!(with(&|h| h.label = Some("Dev".into())).label, "Dev");
        assert_eq!(
            with(&|h| h.shell = Some("/bin/zsh".into()))
                .shell
                .as_deref(),
            Some("/bin/zsh")
        );
        let env = vec![HostEnvVar {
            name: "A".into(),
            value: "1".into(),
        }];
        assert_eq!(with(&|h| h.env = env.clone()).env, env);
        assert!(!with(&|h| h.history.enabled = Some(false)).history.enabled);
        assert_eq!(
            with(&|h| h.history.claude_home = Some("/opt/c".into()))
                .history
                .claude_home,
            "/opt/c"
        );
        assert_eq!(
            with(&|h| h.history.codex_home = Some("/opt/x".into()))
                .history
                .codex_home,
            "/opt/x"
        );
        assert_eq!(with(&|h| h.history.days = Some(7)).history.days, 7);
        // The others stay at their defaults.
        let one = with(&|h| h.history.days = Some(7));
        assert_eq!(one.label, base.label);
        assert_eq!(one.history.claude_home, base.history.claude_home);
    }

    #[test]
    fn days_are_clamped() {
        let h = HostSettings {
            history: HostHistory {
                days: Some(0),
                ..HostHistory::default()
            },
            ..HostSettings::default()
        };
        assert_eq!(effective(Some(&h), "b").history.days, 1);
        let h = HostSettings {
            history: HostHistory {
                days: Some(99_999),
                ..HostHistory::default()
            },
            ..HostSettings::default()
        };
        assert_eq!(effective(Some(&h), "b").history.days, 3650);
    }

    #[test]
    fn scope_of_an_ssh_worktree_is_its_host() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            scope_of("ssh://ssh-a/home/u/p", dir.path()),
            HostScope::Ssh("ssh-a".into())
        );
        assert_eq!(scope_of("ssh://bad id/x", dir.path()), HostScope::Local);
    }

    #[test]
    fn scope_of_a_checkout_follows_its_remote_target() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let repo = dir.path().join("repo");
        let other = dir.path().join("other");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let entry: xdev_workspace::RepoEntry = serde_json::from_value(serde_json::json!({
            "id": "r1",
            "short_name": "repo",
            "path": repo,
            "base_ref": "main",
            "worktree_root": dir.path().join("wt"),
        }))
        .unwrap();
        xdev_workspace::Registry {
            version: 1,
            repos: vec![entry],
            ..xdev_workspace::Registry::default()
        }
        .save(&data)
        .unwrap();
        let mut targets = BTreeMap::new();
        targets.insert(
            "r1".to_owned(),
            RemoteTarget {
                host_id: "ssh-b".into(),
                path: "/srv/p".into(),
            },
        );
        crate::remote_ssh::store::save_targets(&data, &targets).unwrap();
        assert_eq!(
            scope_of(repo.to_str().unwrap(), &data),
            HostScope::Ssh("ssh-b".into())
        );
        assert_eq!(scope_of(other.to_str().unwrap(), &data), HostScope::Local);
        assert_eq!(
            scope_of(other.to_str().unwrap(), dir.path()),
            HostScope::Local
        );
    }
}
