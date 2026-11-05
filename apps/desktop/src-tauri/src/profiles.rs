//! The Agents settings commands: the profiles and shells on this machine,
//! and how to change them. Everything that saves holds `ProfilesLock` from
//! load to save, so two commands never write over each other.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::AppHandle;
use tauri::State;
use tauri_plugin_opener::OpenerExt;
use xdev_agent::{
    Approvals, Cli, CustomShell, DefaultAgent, Permissions, Profile, ProfileError, Profiles,
    PromptMode, ShellKind, default_shell_id, efforts, find_builtin, find_program,
    has_permission_args, list_shells, modes, pick_agent, set_path_override, spec,
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
    /// The profile's own args already hold a permission flag of its agent,
    /// so xDev adds none.
    pub custom_args: bool,
    /// The approval modes the agent offers; `ask` first.
    pub modes: Vec<Permissions>,
    /// A built-in with a docs or install link.
    pub docs: bool,
    /// The first prompt is typed after the agent starts, not passed as an
    /// argument.
    pub prompt_after: bool,
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
    pub default_agent: DefaultAgent,
    /// The profile id the default agent starts now (`auto` picks the first
    /// installed one); `None` opens a shell.
    pub resolved_default: Option<String>,
    /// With the `shell:` prefix, like the ids in `shells`.
    pub default_shell: String,
    pub profiles: Vec<ProfileView>,
    pub shells: Vec<ShellView>,
}

pub(crate) type Find<'a> = &'a dyn Fn(&Profile) -> Option<PathBuf>;

/// Where a profile's program is installed, by the real detectors.
pub(crate) fn detect(profile: &Profile) -> Option<PathBuf> {
    match profile.cli {
        Some(cli) => find_builtin(cli),
        None => profile.program.as_deref().and_then(find_program),
    }
}

fn lock_guard(lock: &ProfilesLock) -> MutexGuard<'_, ()> {
    lock.0.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The agent the default starts, as the UI resolves it: `None` for a shell.
fn resolved_default(profiles: &Profiles, find: Find<'_>) -> Option<String> {
    pick_agent(&profiles.default_agent, &|id| {
        profiles
            .get(id)
            .is_some_and(|p| p.enabled && find(p).is_some())
    })
}

/// The profile id a caller with no terminal starts: the agent the default
/// resolves to, else the saved id (or claude), so its launch says it is
/// missing rather than starting another agent.
pub(crate) fn default_agent_id(profiles: &Profiles, find: Find<'_>) -> String {
    resolved_default(profiles, find).unwrap_or_else(|| profiles.default_id())
}

fn build(profiles: &Profiles, find: Find<'_>, distros: &[String]) -> ProfilesView {
    let entries = list_shells(&profiles.shells, distros);
    let default_shell = format!("shell:{}", default_shell_id(profiles, &entries));
    ProfilesView {
        approvals: profiles.approvals,
        default_agent: profiles.default_agent.clone(),
        resolved_default: resolved_default(profiles, find),
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
                    custom_args: p.cli.is_some_and(|cli| has_permission_args(cli, &p.args)),
                    modes: p.cli.map(modes).unwrap_or_default(),
                    docs: p.cli.is_some(),
                    prompt_after: p
                        .cli
                        .is_some_and(|cli| spec(cli).prompt == PromptMode::AfterStart),
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
    default_agent: DefaultAgent,
    default_shell: Option<String>,
) -> Result<ProfilesView, CmdError> {
    let shell = default_shell.map(|s| s.strip_prefix("shell:").unwrap_or(&s).to_owned());
    change(&state, &lock, |p| {
        p.set_defaults(approvals, default_agent, shell)
    })
}

/// Reads the PATH a new terminal gets, uses it to find agents and to start
/// them from now on, and shows the profiles again. A PATH that cannot be read
/// keeps the old one.
#[tauri::command(async)]
pub fn agents_refresh(state: State<'_, AppState>) -> Result<ProfilesView, CmdError> {
    if let Some(path) = crate::agent_path::refresh() {
        set_path_override(Some(path));
    }
    view(data_dir(&state)?, &detect, distros())
}

/// The docs or install page of a built-in agent.
pub(crate) fn agent_docs_url(id: &str) -> Result<&'static str, CmdError> {
    Cli::of_id(id)
        .map(|cli| spec(cli).docs_url)
        .ok_or(CmdError {
            code: "unknown_profile",
            detail: Some(id.to_owned()),
        })
}

#[tauri::command]
pub fn agent_docs_open(app: AppHandle, id: String) -> Result<(), CmdError> {
    app.opener()
        .open_url(agent_docs_url(&id)?, None::<&str>)
        .map_err(|e| CmdError {
            code: "open_failed",
            detail: Some(e.to_string()),
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
        assert_eq!(v.default_agent, DefaultAgent::Auto);
        assert!(v.shells.iter().all(|s| s.id.starts_with("shell:")));
        assert!(v.shells.iter().any(|s| s.id == v.default_shell));
    }

    fn only(ids: &'static [&'static str]) -> impl Fn(&Profile) -> Option<PathBuf> {
        move |p| {
            ids.contains(&p.id.as_str())
                .then(|| PathBuf::from("/bin/x"))
        }
    }

    #[test]
    fn the_default_agent_id_follows_auto_and_names_a_missing_one() {
        let mut p = Profiles::default();
        // Auto: the first usable agent, as the UI resolves it.
        assert_eq!(default_agent_id(&p, &only(&["codex"])), "codex");
        // Nothing usable: claude, so the launch says it is missing.
        assert_eq!(default_agent_id(&p, &only(&[])), "claude");
        // A saved agent stays itself even when missing.
        p.default_agent = DefaultAgent::Agent("gemini".into());
        assert_eq!(default_agent_id(&p, &only(&["codex"])), "gemini");
    }

    #[test]
    fn view_reports_modes_custom_args_and_the_resolved_default() {
        let dir = tempfile::tempdir().unwrap();
        let lock = ProfilesLock::default();
        // Claude is missing: `auto` picks codex.
        let v = view(dir.path(), &only(&["codex", "aider"]), &[]).unwrap();
        assert_eq!(v.default_agent, DefaultAgent::Auto);
        assert_eq!(v.resolved_default.as_deref(), Some("codex"));
        let by = |id: &str| v.profiles.iter().find(|p| p.profile.id == id).unwrap();
        assert_eq!(
            by("claude").modes,
            [
                Permissions::Ask,
                Permissions::AcceptEdits,
                Permissions::Auto,
                Permissions::Skip
            ]
        );
        assert_eq!(by("opencode").modes, [Permissions::Ask]);
        assert!(by("aider").prompt_after && !by("claude").prompt_after);
        assert!(by("devin").docs);
        assert!(!by("claude").custom_args);
        // Nothing installed: a shell.
        let none = view(dir.path(), &only(&[]), &[]).unwrap();
        assert_eq!(none.resolved_default, None);
        // A saved default that is not installed is a shell, not another agent.
        let saved = update(dir.path(), &lock, &only(&["goose"]), &[], |p| {
            p.set_defaults(Approvals::Ask, DefaultAgent::Agent("codex".into()), None)
        })
        .unwrap();
        assert_eq!(saved.resolved_default, None);
        // Blank is a shell whatever is installed.
        let blank = update(dir.path(), &lock, &only(&["goose"]), &[], |p| {
            p.set_defaults(Approvals::Ask, DefaultAgent::Blank, None)
        })
        .unwrap();
        assert_eq!(blank.resolved_default, None);
        // Own permission args are reported.
        let custom_args = update(dir.path(), &lock, &only(&[]), &[], |p| {
            let mut c = p.get("claude").unwrap().clone();
            c.args = vec!["--permission-mode".into(), "plan".into()];
            p.put(c)
        })
        .unwrap();
        let claude = custom_args
            .profiles
            .iter()
            .find(|p| p.profile.id == "claude")
            .unwrap();
        assert!(claude.custom_args);
    }

    #[test]
    fn docs_url_is_the_table_url() {
        assert_eq!(
            agent_docs_url("devin").unwrap(),
            xdev_agent::spec(Cli::Devin).docs_url
        );
        assert_eq!(agent_docs_url("nope").unwrap_err().code, "unknown_profile");
        // A custom profile id is not a built-in.
        assert_eq!(agent_docs_url("mine").unwrap_err().code, "unknown_profile");
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
