//! Quick commands: saved terminal commands and agent prompts, global or tied
//! to one repo. The person's own list lives in `settings.json`
//! (`quickCommands`); a repo may also ship read-only ones in `xdev.toml`
//! under `[[commands]]`, which run only once trusted.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use xdev_agent::Profiles;
use xdev_workspace::{
    COMMAND_LABEL_MAX, COMMAND_PROMPT_MAX, COMMAND_TEXT_MAX, Registry, RepoAction, RepoCommands,
    path_key, repo_commands, trust_commands,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::settings::{Settings, SettingsSection};
use crate::settings_store;
use crate::workspace::{WorkspaceLock, bad_arg, clock, lock_guard};

/// The longest label, in characters once trimmed; the same for `xdev.toml`.
pub const LABEL_MAX: usize = COMMAND_LABEL_MAX;
/// The longest terminal command, in characters once its end is trimmed.
pub const COMMAND_MAX: usize = COMMAND_TEXT_MAX;
/// The longest agent prompt, in UTF-8 bytes.
pub const PROMPT_MAX: usize = COMMAND_PROMPT_MAX;
/// All agent prompts together, in UTF-8 bytes, so `settings.json` stays
/// small enough to read on every change.
pub const PROMPTS_TOTAL_MAX: usize = 2 * 1024 * 1024;
/// How many recent runs are kept.
pub const RECENT_MAX: usize = 20;

/// What every change here tells the windows.
const SECTIONS: &[SettingsSection] = &[SettingsSection::QuickCommands];

/// One saved command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct QuickCommand {
    /// `qc-<uuid v4>`; empty in an upsert asks for a new one.
    pub id: String,
    /// Trimmed, 1..=80 characters.
    pub label: String,
    pub scope: QuickScope,
    pub action: QuickAction,
}

/// Where a command shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum QuickScope {
    /// Every repo.
    Global,
    /// One repo, by its path as the workspace lists it (`RepoView.path`).
    Repo { repo: String },
}

/// What a command does when run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum QuickAction {
    /// Typed into the focused terminal. `command` is stored with its end
    /// trimmed, at most 4000 characters; lines are kept as typed.
    Terminal {
        command: String,
        /// Press Enter after the text; true when absent.
        #[serde(rename = "appendEnter", default = "yes")]
        append_enter: bool,
    },
    /// Opens a new agent tab of `profile` (an agent profile id) and types
    /// `prompt` once the agent is ready; at most 256 KiB.
    Agent { profile: String, prompt: String },
}

fn yes() -> bool {
    true
}

/// One `[[commands]]` entry of a repo's `xdev.toml`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileCommand {
    pub label: String,
    pub action: QuickAction,
}

/// The `[[commands]]` of a worktree's `xdev.toml` (else the primary
/// checkout's). They are listed even when untrusted, but run only once the
/// person trusted this exact `hash` (`repo_file_commands_trust`).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileCommands {
    /// There are commands and this `hash` is in the trust store.
    pub trusted: bool,
    /// Blake3 hex of the `[[commands]]` part; empty when there is none.
    pub hash: String,
    pub commands: Vec<FileCommand>,
    /// One line per entry left out (and the file's own error when it does
    /// not parse).
    pub errors: Vec<String>,
}

/// `item` as it would be stored, or `bad_arg` naming the first field that
/// is wrong. `repos` are the registry's repo paths; a repo scope is stored
/// with the registry's spelling of the path.
fn checked(
    item: QuickCommand,
    repos: &[PathBuf],
    profiles: &Profiles,
) -> Result<QuickCommand, CmdError> {
    let label = item.label.trim().to_owned();
    if label.is_empty() || label.chars().count() > LABEL_MAX {
        return Err(bad_arg("label"));
    }
    let scope = match item.scope {
        QuickScope::Global => QuickScope::Global,
        QuickScope::Repo { repo } => {
            let key = path_key(Path::new(&repo));
            let found = repos
                .iter()
                .find(|path| path_key(path) == key)
                .ok_or_else(|| bad_arg("repo"))?;
            QuickScope::Repo {
                repo: found.to_string_lossy().into_owned(),
            }
        }
    };
    let action = match item.action {
        QuickAction::Terminal {
            command,
            append_enter,
        } => {
            let command = command.trim_end().to_owned();
            if command.is_empty() || command.chars().count() > COMMAND_MAX {
                return Err(bad_arg("command"));
            }
            QuickAction::Terminal {
                command,
                append_enter,
            }
        }
        QuickAction::Agent { profile, prompt } => {
            if prompt.trim().is_empty() || prompt.len() > PROMPT_MAX {
                return Err(bad_arg("prompt"));
            }
            if profiles.get(&profile).is_none() {
                return Err(bad_arg("profile"));
            }
            QuickAction::Agent { profile, prompt }
        }
    };
    Ok(QuickCommand {
        id: item.id,
        label,
        scope,
        action,
    })
}

fn new_id() -> String {
    format!("qc-{}", uuid::Uuid::new_v4())
}

/// Replaces the command with `item.id` in place, or adds `item` at the end
/// (with a new id when it has none). Refuses when all prompts together
/// would pass `PROMPTS_TOTAL_MAX`, leaving `list` as it was.
fn upsert_into(
    list: &mut Vec<QuickCommand>,
    mut item: QuickCommand,
) -> Result<QuickCommand, CmdError> {
    if item.id.is_empty() {
        item.id = new_id();
    }
    let mut next = list.clone();
    match next.iter_mut().find(|c| c.id == item.id) {
        Some(slot) => *slot = item.clone(),
        None => next.push(item.clone()),
    }
    let prompts: usize = next
        .iter()
        .map(|c| match &c.action {
            QuickAction::Agent { prompt, .. } => prompt.len(),
            QuickAction::Terminal { .. } => 0,
        })
        .sum();
    if prompts > PROMPTS_TOTAL_MAX {
        return Err(bad_arg("prompts"));
    }
    *list = next;
    Ok(item)
}

/// Moves `id` to position `to` (clamped) among the commands of its own
/// scope; the others keep their places in the list.
fn move_within(list: &mut [QuickCommand], id: &str, to: usize) -> Result<(), CmdError> {
    let item = list
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or_else(|| CmdError {
            code: "not_found",
            detail: Some(id.to_owned()),
        })?;
    let slots: Vec<usize> = list
        .iter()
        .enumerate()
        .filter(|(_, c)| c.scope == item.scope)
        .map(|(i, _)| i)
        .collect();
    let mut order: Vec<QuickCommand> = slots
        .iter()
        .map(|&i| list[i].clone())
        .filter(|c| c.id != id)
        .collect();
    order.insert(to.min(order.len()), item);
    for (slot, c) in slots.into_iter().zip(order) {
        list[slot] = c;
    }
    Ok(())
}

/// Puts `id` first among the recent runs, keeping `RECENT_MAX`; an id
/// that is not a saved command changes nothing.
fn used_in(s: &mut Settings, id: &str) {
    if !s.quick_commands.iter().any(|c| c.id == id) {
        return;
    }
    s.quick_commands_recent.retain(|r| r != id);
    s.quick_commands_recent.insert(0, id.to_owned());
    s.quick_commands_recent.truncate(RECENT_MAX);
}

/// Drops the command and its place among the recent runs.
fn delete_from(s: &mut Settings, id: &str) {
    s.quick_commands.retain(|c| c.id != id);
    s.quick_commands_recent.retain(|r| r != id);
}

/// The recent runs that are still saved commands.
fn recent_of(s: &Settings) -> Vec<String> {
    s.quick_commands_recent
        .iter()
        .filter(|r| s.quick_commands.iter().any(|c| &c.id == *r))
        .cloned()
        .collect()
}

/// Every saved command, in order: global and per repo together.
#[tauri::command(async)]
pub fn quick_commands_list(app: AppHandle) -> Result<Vec<QuickCommand>, CmdError> {
    Ok(settings_store::read(&app).quick_commands)
}

/// Inserts at the end of its scope, or replaces the one with the same id in
/// place. Returns what was stored, with a new id when `item.id` was empty.
#[tauri::command(async)]
pub fn quick_command_upsert(
    app: AppHandle,
    state: State<'_, AppState>,
    item: QuickCommand,
) -> Result<QuickCommand, CmdError> {
    let data = data_dir(&state)?;
    let repos: Vec<PathBuf> = Registry::load(data)?
        .repos
        .into_iter()
        .map(|r| r.path)
        .collect();
    let item = checked(item, &repos, &Profiles::load(data)?)?;
    settings_store::try_write(&app, SECTIONS, |s| upsert_into(&mut s.quick_commands, item))
}

/// An unknown id is a no-op.
#[tauri::command(async)]
pub fn quick_command_delete(app: AppHandle, id: String) -> Result<(), CmdError> {
    settings_store::write(&app, SECTIONS, |s| delete_from(s, &id))?;
    Ok(())
}

/// Moves the command to position `to` among the commands of its own scope.
#[tauri::command(async)]
pub fn quick_commands_move(app: AppHandle, id: String, to: usize) -> Result<(), CmdError> {
    settings_store::try_write(&app, SECTIONS, |s| {
        move_within(&mut s.quick_commands, &id, to)
    })
}

/// Records a run, for the recently used order. An unknown id is a no-op.
#[tauri::command(async)]
pub fn quick_command_used(app: AppHandle, id: String) -> Result<(), CmdError> {
    if !settings_store::read(&app)
        .quick_commands
        .iter()
        .any(|c| c.id == id)
    {
        return Ok(());
    }
    settings_store::write(&app, SECTIONS, |s| used_in(s, &id))?;
    Ok(())
}

/// Ids of the recently run commands, newest first, at most 20.
#[tauri::command(async)]
pub fn quick_commands_recent(app: AppHandle) -> Result<Vec<String>, CmdError> {
    Ok(recent_of(&settings_store::read(&app)))
}

/// The file's commands as the UI runs them: a prompt without `agent` goes
/// to the default agent.
fn file_commands(found: RepoCommands, default_agent: &str) -> FileCommands {
    FileCommands {
        trusted: found.trusted,
        hash: found.hash,
        commands: found
            .commands
            .into_iter()
            .map(|c| FileCommand {
                label: c.label,
                action: match c.action {
                    RepoAction::Run { command, enter } => QuickAction::Terminal {
                        command,
                        append_enter: enter,
                    },
                    RepoAction::Prompt { agent, prompt } => QuickAction::Agent {
                        profile: agent.unwrap_or_else(|| default_agent.to_owned()),
                        prompt,
                    },
                },
            })
            .collect(),
        errors: found.errors,
    }
}

/// The default agent's id; the built-in one when the profiles do not read.
fn default_agent(data: &Path) -> String {
    Profiles::load(data).unwrap_or_default().default_agent
}

/// The `[[commands]]` of the worktree's `xdev.toml`. Read only.
#[tauri::command(async)]
pub fn repo_file_commands(
    state: State<'_, AppState>,
    worktree: PathBuf,
) -> Result<FileCommands, CmdError> {
    let data = data_dir(&state)?;
    let reg = Registry::load(data)?;
    let found = repo_commands(&reg, data, &worktree)?;
    Ok(file_commands(found, &default_agent(data)))
}

/// Trusts the worktree's `[[commands]]` whose hash is `hash`;
/// `hook_untrusted` when the file no longer holds them. Returns them after.
#[tauri::command(async)]
pub fn repo_file_commands_trust(
    state: State<'_, AppState>,
    lock: State<'_, WorkspaceLock>,
    worktree: PathBuf,
    hash: String,
) -> Result<FileCommands, CmdError> {
    let data = data_dir(&state)?;
    let (now_ms, _) = clock();
    // The same writer lock as the scripts' trust: both share one file.
    let _guard = lock_guard(&lock);
    let reg = Registry::load(data)?;
    let found = trust_commands(&reg, data, &worktree, &hash, now_ms)?;
    Ok(file_commands(found, &default_agent(data)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{self, Settings};
    use crate::settings_store::SettingsStore;

    fn terminal(id: &str, label: &str, scope: QuickScope) -> QuickCommand {
        QuickCommand {
            id: id.into(),
            label: label.into(),
            scope,
            action: QuickAction::Terminal {
                command: format!("echo {label}"),
                append_enter: true,
            },
        }
    }

    fn repo(path: &str) -> QuickScope {
        QuickScope::Repo { repo: path.into() }
    }

    fn labels(list: &[QuickCommand]) -> Vec<&str> {
        list.iter().map(|c| c.label.as_str()).collect()
    }

    fn known() -> (Vec<PathBuf>, Profiles) {
        (vec![PathBuf::from("E:/Codes/app")], Profiles::default())
    }

    fn store() -> (tempfile::TempDir, SettingsStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().join(settings::FILE_NAME));
        (dir, store)
    }

    /// What `quick_command_upsert` does once it has the registry and
    /// profiles, short of the event.
    fn upsert(store: &SettingsStore, item: QuickCommand) -> Result<QuickCommand, CmdError> {
        let (repos, profiles) = known();
        let item = checked(item, &repos, &profiles)?;
        store.try_update(|s| upsert_into(&mut s.quick_commands, item))
    }

    #[test]
    fn the_wire_shape_is_camel_case_and_tagged() {
        let item = QuickCommand {
            id: "qc-1".into(),
            label: "Tests".into(),
            scope: QuickScope::Repo {
                repo: "E:/x".into(),
            },
            action: QuickAction::Terminal {
                command: "cargo test".into(),
                append_enter: false,
            },
        };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "qc-1",
                "label": "Tests",
                "scope": { "type": "repo", "repo": "E:/x" },
                "action": { "type": "terminal", "command": "cargo test", "appendEnter": false },
            })
        );
        let agent = serde_json::json!({ "type": "agent", "profile": "claude", "prompt": "Review" });
        assert_eq!(
            serde_json::from_value::<QuickAction>(agent).unwrap(),
            QuickAction::Agent {
                profile: "claude".into(),
                prompt: "Review".into()
            }
        );
        let global = serde_json::json!({ "type": "global" });
        assert_eq!(
            serde_json::from_value::<QuickScope>(global).unwrap(),
            QuickScope::Global
        );
    }

    #[test]
    fn append_enter_defaults_to_true() {
        let action: QuickAction =
            serde_json::from_str(r#"{ "type": "terminal", "command": "ls" }"#).unwrap();
        assert_eq!(
            action,
            QuickAction::Terminal {
                command: "ls".into(),
                append_enter: true
            }
        );
    }

    #[test]
    fn every_change_names_the_quick_commands_section() {
        assert_eq!(SECTIONS, &[SettingsSection::QuickCommands]);
    }

    #[test]
    fn upsert_without_an_id_gets_a_new_one_at_the_end() {
        let (_dir, store) = store();
        let first = upsert(&store, terminal("", "  Tests  ", QuickScope::Global)).unwrap();
        assert!(first.id.starts_with("qc-"), "{}", first.id);
        assert_eq!(first.id.len(), "qc-".len() + 36);
        assert_eq!(first.label, "Tests");
        let second = upsert(&store, terminal("", "Lint", QuickScope::Global)).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(labels(&store.read().quick_commands), ["Tests", "Lint"]);
    }

    #[test]
    fn upsert_with_a_known_id_replaces_in_place() {
        let (_dir, store) = store();
        let a = upsert(&store, terminal("", "A", QuickScope::Global)).unwrap();
        upsert(&store, terminal("", "B", QuickScope::Global)).unwrap();
        let renamed = upsert(&store, terminal(&a.id, "A2", QuickScope::Global)).unwrap();
        assert_eq!(renamed.id, a.id);
        let list = store.read().quick_commands;
        assert_eq!(labels(&list), ["A2", "B"]);
        assert_eq!(list[0].id, a.id);
    }

    #[test]
    fn bad_fields_are_refused_and_nothing_is_saved() {
        let (_dir, store) = store();
        let detail = |item: QuickCommand| upsert(&store, item).unwrap_err().detail.unwrap();
        assert_eq!(
            detail(terminal("", &"x".repeat(81), QuickScope::Global)),
            "label"
        );
        assert_eq!(detail(terminal("", "   ", QuickScope::Global)), "label");
        let command = |text: String| QuickCommand {
            action: QuickAction::Terminal {
                command: text,
                append_enter: true,
            },
            ..terminal("", "Cmd", QuickScope::Global)
        };
        assert_eq!(detail(command("y".repeat(4001))), "command");
        assert_eq!(detail(command("  \n ".into())), "command");
        assert_eq!(
            detail(terminal("", "Elsewhere", repo("E:/Codes/other"))),
            "repo"
        );
        let agent = |profile: &str, prompt: String| QuickCommand {
            action: QuickAction::Agent {
                profile: profile.into(),
                prompt,
            },
            ..terminal("", "Agent", QuickScope::Global)
        };
        assert_eq!(detail(agent("nobody", "Review".into())), "profile");
        assert_eq!(detail(agent("claude", " \n".into())), "prompt");
        assert_eq!(
            detail(agent("claude", "p".repeat(PROMPT_MAX + 1))),
            "prompt"
        );
        assert_eq!(
            upsert(&store, agent("nobody", "x".into()))
                .unwrap_err()
                .code,
            "bad_arg"
        );
        assert!(store.read().quick_commands.is_empty());

        assert!(upsert(&store, terminal("", &"é".repeat(80), QuickScope::Global)).is_ok());
        assert!(upsert(&store, command("y".repeat(4000))).is_ok());
        assert!(upsert(&store, agent("claude", "Review".into())).is_ok());
        assert_eq!(store.read().quick_commands.len(), 3);
    }

    #[test]
    fn the_prompts_together_are_capped() {
        let (_dir, store) = store();
        let big = |label: &str| QuickCommand {
            action: QuickAction::Agent {
                profile: "claude".into(),
                prompt: "p".repeat(PROMPT_MAX),
            },
            ..terminal("", label, QuickScope::Global)
        };
        let fits = PROMPTS_TOTAL_MAX / PROMPT_MAX;
        for i in 0..fits {
            upsert(&store, big(&format!("P{i}"))).unwrap();
        }
        let refused = upsert(&store, big("one more")).unwrap_err();
        assert_eq!(refused.detail.as_deref(), Some("prompts"));
        assert_eq!(store.read().quick_commands.len(), fits);
    }

    #[test]
    fn a_repo_scope_is_stored_as_the_registry_spells_it() {
        let (repos, profiles) = known();
        let item = checked(terminal("", "T", repo("E:/Codes/app/")), &repos, &profiles).unwrap();
        assert_eq!(item.scope, repo("E:/Codes/app"));
    }

    #[test]
    fn a_terminal_command_keeps_its_lines_and_loses_only_its_trailing_space() {
        let (repos, profiles) = known();
        let item = QuickCommand {
            action: QuickAction::Terminal {
                command: "  cd web\npnpm dev \n\n".into(),
                append_enter: false,
            },
            ..terminal("", "Dev", QuickScope::Global)
        };
        let stored = checked(item, &repos, &profiles).unwrap();
        assert_eq!(
            stored.action,
            QuickAction::Terminal {
                command: "  cd web\npnpm dev".into(),
                append_enter: false
            }
        );
    }

    #[test]
    fn delete_removes_only_that_command() {
        let (_dir, store) = store();
        let a = upsert(&store, terminal("", "A", QuickScope::Global)).unwrap();
        upsert(&store, terminal("", "B", QuickScope::Global)).unwrap();
        for id in [a.id.as_str(), "qc-none"] {
            store.update(|s| delete_from(s, id)).unwrap();
        }
        assert_eq!(labels(&store.read().quick_commands), ["B"]);
    }

    #[test]
    fn a_run_goes_to_the_front_of_recent_capped() {
        let (_dir, store) = store();
        let mut ids = Vec::new();
        for i in 0..RECENT_MAX + 2 {
            ids.push(
                upsert(&store, terminal("", &format!("C{i}"), QuickScope::Global))
                    .unwrap()
                    .id,
            );
        }
        for id in &ids {
            store.update(|s| used_in(s, id)).unwrap();
        }
        store.update(|s| used_in(s, &ids[5])).unwrap();
        let recent = store.read().quick_commands_recent;
        assert_eq!(recent.len(), RECENT_MAX);
        assert_eq!(recent[0], ids[5]);
        assert_eq!(recent[1], ids[RECENT_MAX + 1]);
        assert_eq!(recent.iter().filter(|r| **r == ids[5]).count(), 1);
        assert!(!recent.contains(&ids[0]));
    }

    #[test]
    fn an_unknown_run_changes_nothing() {
        let (_dir, store) = store();
        let a = upsert(&store, terminal("", "A", QuickScope::Global)).unwrap();
        store.update(|s| used_in(s, &a.id)).unwrap();
        let before = store.read();
        let mut after = before.clone();
        used_in(&mut after, "qc-none");
        assert_eq!(after, before);
    }

    #[test]
    fn delete_drops_the_id_from_recent() {
        let (_dir, store) = store();
        let a = upsert(&store, terminal("", "A", QuickScope::Global)).unwrap();
        let b = upsert(&store, terminal("", "B", QuickScope::Global)).unwrap();
        store.update(|s| used_in(s, &a.id)).unwrap();
        store.update(|s| used_in(s, &b.id)).unwrap();
        store.update(|s| delete_from(s, &b.id)).unwrap();
        assert_eq!(
            store.read().quick_commands_recent,
            std::slice::from_ref(&a.id)
        );
        assert_eq!(recent_of(&store.read()), [a.id]);
    }

    #[test]
    fn recent_lists_only_commands_that_still_exist() {
        let s = Settings {
            quick_commands: vec![terminal("qc-a", "A", QuickScope::Global)],
            quick_commands_recent: vec!["qc-gone".into(), "qc-a".into()],
            ..Settings::default()
        };
        assert_eq!(recent_of(&s), ["qc-a"]);
    }

    #[test]
    fn move_reorders_only_within_the_same_scope() {
        let mut list = vec![
            terminal("g1", "G1", QuickScope::Global),
            terminal("r1", "R1", repo("E:/a")),
            terminal("g2", "G2", QuickScope::Global),
            terminal("s1", "S1", repo("E:/b")),
            terminal("g3", "G3", QuickScope::Global),
            terminal("r2", "R2", repo("E:/a")),
        ];
        move_within(&mut list, "g3", 0).unwrap();
        assert_eq!(labels(&list), ["G3", "R1", "G1", "S1", "G2", "R2"]);
        move_within(&mut list, "r1", 99).unwrap();
        assert_eq!(labels(&list), ["G3", "R2", "G1", "S1", "G2", "R1"]);
        move_within(&mut list, "s1", 0).unwrap();
        assert_eq!(labels(&list), ["G3", "R2", "G1", "S1", "G2", "R1"]);
        let missing = move_within(&mut list, "nope", 0).unwrap_err();
        assert_eq!(missing.code, "not_found");
    }

    #[test]
    fn a_refused_move_saves_nothing() {
        let (_dir, store) = store();
        upsert(&store, terminal("", "A", QuickScope::Global)).unwrap();
        let before: Settings = store.read();
        let err = store
            .try_update(|s| move_within(&mut s.quick_commands, "nope", 0))
            .unwrap_err();
        assert_eq!(err.code, "not_found");
        assert_eq!(store.read(), before);
    }

    #[test]
    fn file_commands_map_to_actions_with_the_default_agent() {
        use xdev_workspace::RepoCommand;
        let found = RepoCommands {
            trusted: true,
            hash: "h".into(),
            commands: vec![
                RepoCommand {
                    label: "Dev".into(),
                    action: RepoAction::Run {
                        command: "pnpm dev".into(),
                        enter: false,
                    },
                },
                RepoCommand {
                    label: "Review".into(),
                    action: RepoAction::Prompt {
                        agent: None,
                        prompt: "Review".into(),
                    },
                },
                RepoCommand {
                    label: "Ask".into(),
                    action: RepoAction::Prompt {
                        agent: Some("codex".into()),
                        prompt: "Ask".into(),
                    },
                },
            ],
            errors: vec!["commands[3]: needs a label".into()],
        };
        let out = file_commands(found, "claude");
        assert!(out.trusted);
        assert_eq!(out.hash, "h");
        assert_eq!(out.errors, ["commands[3]: needs a label"]);
        assert_eq!(
            out.commands.iter().map(|c| &c.action).collect::<Vec<_>>(),
            [
                &QuickAction::Terminal {
                    command: "pnpm dev".into(),
                    append_enter: false
                },
                &QuickAction::Agent {
                    profile: "claude".into(),
                    prompt: "Review".into()
                },
                &QuickAction::Agent {
                    profile: "codex".into(),
                    prompt: "Ask".into()
                },
            ]
        );
    }
}
