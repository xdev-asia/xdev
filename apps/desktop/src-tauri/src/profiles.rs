//! The Agents settings commands: the profiles and shells on this machine,
//! and how to change them. Everything that saves holds `ProfilesLock` from
//! load to save, so two commands never write over each other.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::State;
use xdev_agent::{
    Approvals, CustomShell, Permissions, Profile, ProfileError, Profiles, ShellKind,
    default_shell_id, efforts, find_builtin, find_program, list_shells,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::pty::distros;

#[derive(Default)]
pub struct ProfilesLock(Mutex<()>);

impl From<ProfileError> for CmdError {
    fn from(e: ProfileError) -> CmdError {
        CmdError {
            code: e.code(),
            detail: Some(e.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub profile: Profile,
    pub builtin: bool,
    pub installed: bool,
    pub path: Option<String>,
    /// What the profile runs as now: its own mode, else the global switch.
    pub permissions: Permissions,
    pub follows_approvals: bool,
    /// The effort levels its CLI accepts; empty when it has none.
    pub efforts: Vec<String>,
}

/// A shell the `+` menu offers. `id` has the `shell:` prefix `pty_spawn` takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ShellView {
    pub id: String,
    pub name: String,
    pub kind: ShellKind,
    pub custom: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProfilesView {
    pub approvals: Approvals,
    pub default_agent: String,
    /// With the `shell:` prefix, like the ids in `shells`.
    pub default_shell: String,
    pub profiles: Vec<ProfileView>,
    pub shells: Vec<ShellView>,
}

type Find<'a> = &'a dyn Fn(&Profile) -> Option<PathBuf>;

/// Where a profile's program is installed, by the real detectors.
fn detect(profile: &Profile) -> Option<PathBuf> {
    match profile.cli {
        Some(cli) => find_builtin(cli),
        None => profile.program.as_deref().and_then(find_program),
    }
}

fn lock_guard(lock: &ProfilesLock) -> MutexGuard<'_, ()> {
    lock.0.lock().unwrap_or_else(PoisonError::into_inner)
}

fn build(profiles: &Profiles, find: Find<'_>, distros: &[String]) -> ProfilesView {
    let entries = list_shells(&profiles.shells, distros);
    let default_shell = format!("shell:{}", default_shell_id(profiles, &entries));
    ProfilesView {
        approvals: profiles.approvals,
        default_agent: profiles.default_agent.clone(),
        default_shell,
        profiles: profiles
            .profiles
            .iter()
            .map(|p| {
                let path = find(p);
                ProfileView {
                    builtin: p.cli.is_some(),
                    installed: path.is_some(),
                    path: path.map(|p| p.to_string_lossy().into_owned()),
                    permissions: profiles.effective(p),
                    follows_approvals: p.follows_approvals(),
                    efforts: p
                        .cli
                        .map(|c| efforts(c).iter().map(|e| (*e).to_owned()).collect())
                        .unwrap_or_default(),
                    profile: p.clone(),
                }
            })
            .collect(),
        shells: entries
            .into_iter()
            .map(|s| ShellView {
                id: format!("shell:{}", s.id),
                custom: s.kind == ShellKind::Custom,
                name: s.name,
                kind: s.kind,
            })
            .collect(),
    }
}

/// The profiles and shells stored in `data_dir`, with detection by `find`.
pub(crate) fn view(
    data_dir: &Path,
    find: Find<'_>,
    distros: &[String],
) -> Result<ProfilesView, CmdError> {
    Ok(build(&Profiles::load(data_dir)?, find, distros))
}

/// Load, change, save and show again, all under the lock.
fn update(
    data_dir: &Path,
    lock: &ProfilesLock,
    find: Find<'_>,
    distros: &[String],
    f: impl FnOnce(&mut Profiles) -> Result<(), ProfileError>,
) -> Result<ProfilesView, CmdError> {
    let _guard = lock_guard(lock);
    let mut profiles = Profiles::load(data_dir)?;
    f(&mut profiles)?;
    profiles.save(data_dir)?;
    Ok(build(&profiles, find, distros))
}

fn change(
    state: &AppState,
    lock: &ProfilesLock,
    f: impl FnOnce(&mut Profiles) -> Result<(), ProfileError>,
) -> Result<ProfilesView, CmdError> {
    update(data_dir(state)?, lock, &detect, distros(), f)
}

#[tauri::command(async)]
pub fn profiles_list(state: State<'_, AppState>) -> Result<ProfilesView, CmdError> {
    view(data_dir(&state)?, &detect, distros())
}

#[tauri::command(async)]
pub fn profile_put(
    state: State<'_, AppState>,
    lock: State<'_, ProfilesLock>,
    profile: Profile,
) -> Result<ProfilesView, CmdError> {
    change(&state, &lock, |p| p.put(profile))
}

#[tauri::command(async)]
pub fn profile_remove(
    state: State<'_, AppState>,
    lock: State<'_, ProfilesLock>,
    id: String,
) -> Result<ProfilesView, CmdError> {
    change(&state, &lock, |p| p.remove(&id))
}

#[tauri::command(async)]
pub fn profile_reset(
    state: State<'_, AppState>,
    lock: State<'_, ProfilesLock>,
    id: String,
) -> Result<ProfilesView, CmdError> {
    change(&state, &lock, |p| p.reset(&id))
}

/// `default_shell` may carry the `shell:` prefix the menu ids have; it is
/// stored without.
#[tauri::command(async)]
pub fn profiles_defaults(
    state: State<'_, AppState>,
    lock: State<'_, ProfilesLock>,
    approvals: Approvals,
    default_agent: String,
    default_shell: Option<String>,
) -> Result<ProfilesView, CmdError> {
    let shell = default_shell.map(|s| s.strip_prefix("shell:").unwrap_or(&s).to_owned());
    change(&state, &lock, |p| {
        p.set_defaults(approvals, &default_agent, shell)
    })
}

#[tauri::command(async)]
pub fn shell_put(
    state: State<'_, AppState>,
    lock: State<'_, ProfilesLock>,
    shell: CustomShell,
) -> Result<ProfilesView, CmdError> {
    change(&state, &lock, |p| p.put_shell(shell))
}

#[tauri::command(async)]
pub fn shell_remove(
    state: State<'_, AppState>,
    lock: State<'_, ProfilesLock>,
    id: String,
) -> Result<ProfilesView, CmdError> {
    change(&state, &lock, |p| p.remove_shell(&id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use xdev_agent::{Cli, Permissions, Profile, builtin};

    fn custom(id: &str) -> Profile {
        Profile {
            id: id.to_owned(),
            name: id.to_owned(),
            cli: None,
            program: Some("my-agent".to_owned()),
            ..builtin(Cli::Claude)
        }
    }

    fn only_claude(p: &Profile) -> Option<PathBuf> {
        (p.id == "claude").then(|| PathBuf::from("/bin/claude"))
    }

    #[test]
    fn view_marks_builtins_and_detection() {
        let dir = tempfile::tempdir().unwrap();
        let v = view(dir.path(), &only_claude, &[]).unwrap();
        let by = |id: &str| v.profiles.iter().find(|p| p.profile.id == id).unwrap();
        assert!(by("claude").builtin && by("claude").installed);
        assert_eq!(by("claude").path.as_deref(), Some("/bin/claude"));
        assert!(by("codex").builtin && !by("codex").installed);
        assert!(by("codex").path.is_none());
        assert!(by("claude").follows_approvals);
        assert_eq!(by("claude").permissions, Permissions::Ask);
        assert!(by("claude").efforts.contains(&"max".to_owned()));
        assert!(by("gemini").efforts.is_empty());
        assert_eq!(v.default_agent, "claude");
        assert!(v.shells.iter().all(|s| s.id.starts_with("shell:")));
        assert!(v.shells.iter().any(|s| s.id == v.default_shell));
    }

    #[test]
    fn put_then_list_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let lock = ProfilesLock::default();
        let put = update(dir.path(), &lock, &only_claude, &[], |p| {
            p.put(custom("mine"))
        })
        .unwrap();
        let listed = view(dir.path(), &only_claude, &[]).unwrap();
        assert_eq!(put, listed);
        let mine = listed
            .profiles
            .iter()
            .find(|p| p.profile.id == "mine")
            .unwrap();
        assert!(!mine.builtin && !mine.installed);
        assert_eq!(mine.permissions, Permissions::Ask);
    }

    #[test]
    fn concurrent_puts_both_land() {
        let dir = tempfile::tempdir().unwrap();
        let lock = ProfilesLock::default();
        std::thread::scope(|s| {
            for id in ["one", "two"] {
                let (dir, lock) = (dir.path(), &lock);
                s.spawn(move || {
                    update(dir, lock, &only_claude, &[], |p| p.put(custom(id))).unwrap();
                });
            }
        });
        let v = view(dir.path(), &only_claude, &[]).unwrap();
        for id in ["one", "two"] {
            assert!(v.profiles.iter().any(|p| p.profile.id == id), "{id}");
        }
    }

    #[test]
    fn remove_builtin_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let lock = ProfilesLock::default();
        let err = update(dir.path(), &lock, &only_claude, &[], |p| p.remove("claude")).unwrap_err();
        assert_eq!(err.code, "builtin_profile");
    }
}
