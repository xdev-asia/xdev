//! Terminal sets and startup presets. A set is a named list of terminals to
//! open together; a preset is a named startup sequence (commands typed into a
//! terminal in order). Both live in `settings.json` beside the quick
//! commands, and the windows hear of every change as `terminalSets`.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use xdev_agent::Profiles;

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::settings::SettingsSection;
use crate::settings_store;
use crate::workspace::bad_arg;

/// The longest set or preset name, in characters once trimmed.
pub const NAME_MAX: usize = 80;
/// The longest startup command, in characters once its end is trimmed.
pub const COMMAND_MAX: usize = 4000;
/// Terminals in one set.
pub const ENTRIES_MAX: usize = 32;
/// Steps in one startup sequence.
pub const STEPS_MAX: usize = 16;
/// The longest "wait N s", in seconds.
pub const WAIT_MAX_SECONDS: u32 = 3600;
/// Sets, and presets, kept.
pub const LIST_MAX: usize = 64;

const SECTIONS: &[SettingsSection] = &[SettingsSection::TerminalSets];

/// What a terminal of a set runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SetTarget {
    /// A new tab of this agent profile.
    Agent { profile: String },
    /// A new shell tab; `command`, when not empty, is typed into it first.
    /// `shell` is the shell profile id, or none for the default shell.
    Shell {
        command: String,
        #[serde(default)]
        shell: Option<String>,
    },
}

/// Which worktree a terminal opens in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SetWorktree {
    /// The worktree the set is opened in.
    Current,
    /// A worktree by its label in the workspace.
    Named { name: String },
}

/// What a startup step waits for before the next one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StepWait {
    None,
    /// A fixed pause, 1..=3600 seconds.
    Seconds {
        seconds: u32,
    },
    /// Until the terminal goes quiet.
    Idle,
}

/// One command of a startup sequence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SequenceStep {
    /// Typed with Enter; end-trimmed, 1..=4000 characters.
    pub command: String,
    /// Waited out before the next step; ignored after the last one.
    pub wait: StepWait,
}

/// One terminal of a set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SetEntry {
    pub target: SetTarget,
    pub worktree: SetWorktree,
    /// Run in order once the terminal has started; at most 16 steps.
    #[serde(default)]
    pub startup: Vec<SequenceStep>,
}

/// A named set of terminals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TerminalSet {
    /// `ts-<uuid v4>`; empty in an upsert asks for a new one.
    pub id: String,
    /// Trimmed, 1..=80 characters.
    pub name: String,
    /// 1..=32 terminals.
    pub entries: Vec<SetEntry>,
}

/// A named startup sequence, to apply to any terminal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StartupPreset {
    /// `sp-<uuid v4>`; empty in an upsert asks for a new one.
    pub id: String,
    pub name: String,
    /// 1..=16 steps.
    pub steps: Vec<SequenceStep>,
}

fn name_of(raw: &str) -> Result<String, CmdError> {
    let name = raw.trim().to_owned();
    if name.is_empty() || name.chars().count() > NAME_MAX {
        return Err(bad_arg("name"));
    }
    Ok(name)
}

fn steps_checked(steps: Vec<SequenceStep>) -> Result<Vec<SequenceStep>, CmdError> {
    if steps.len() > STEPS_MAX {
        return Err(bad_arg("steps"));
    }
    steps
        .into_iter()
        .map(|step| {
            let command = step.command.trim_end().to_owned();
            if command.trim().is_empty() || command.chars().count() > COMMAND_MAX {
                return Err(bad_arg("command"));
            }
            if let StepWait::Seconds { seconds } = step.wait
                && !(1..=WAIT_MAX_SECONDS).contains(&seconds)
            {
                return Err(bad_arg("wait"));
            }
            Ok(SequenceStep {
                command,
                wait: step.wait,
            })
        })
        .collect()
}

/// `set` as it would be stored, or `bad_arg` naming the first wrong field.
fn set_checked(set: TerminalSet, profiles: &Profiles) -> Result<TerminalSet, CmdError> {
    let name = name_of(&set.name)?;
    if set.entries.is_empty() || set.entries.len() > ENTRIES_MAX {
        return Err(bad_arg("entries"));
    }
    let entries = set
        .entries
        .into_iter()
        .map(|entry| {
            let target = match entry.target {
                SetTarget::Agent { profile } => {
                    if profiles.get(&profile).is_none() {
                        return Err(bad_arg("profile"));
                    }
                    SetTarget::Agent { profile }
                }
                SetTarget::Shell { command, shell } => {
                    let command = command.trim_end().to_owned();
                    if command.chars().count() > COMMAND_MAX {
                        return Err(bad_arg("command"));
                    }
                    SetTarget::Shell { command, shell }
                }
            };
            let worktree = match entry.worktree {
                SetWorktree::Current => SetWorktree::Current,
                SetWorktree::Named { name } => {
                    let name = name.trim().to_owned();
                    if name.is_empty() {
                        return Err(bad_arg("worktree"));
                    }
                    SetWorktree::Named { name }
                }
            };
            Ok(SetEntry {
                target,
                worktree,
                startup: steps_checked(entry.startup)?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(TerminalSet {
        id: set.id,
        name,
        entries,
    })
}

fn preset_checked(preset: StartupPreset) -> Result<StartupPreset, CmdError> {
    let name = name_of(&preset.name)?;
    if preset.steps.is_empty() {
        return Err(bad_arg("steps"));
    }
    Ok(StartupPreset {
        id: preset.id,
        name,
        steps: steps_checked(preset.steps)?,
    })
}

/// Replaces the item with the same id in place, or adds it at the end (with
/// a new id when it has none). Refuses past `LIST_MAX`.
fn upsert_by_id<T: Clone>(
    list: &mut Vec<T>,
    mut item: T,
    id_of: fn(&mut T) -> &mut String,
    prefix: &str,
) -> Result<T, CmdError> {
    if id_of(&mut item).is_empty() {
        *id_of(&mut item) = format!("{prefix}-{}", uuid::Uuid::new_v4());
    }
    let id = id_of(&mut item).clone();
    let at = list.iter_mut().position(|c| id_of(c) == &id);
    match at {
        Some(i) => list[i] = item.clone(),
        None if list.len() >= LIST_MAX => return Err(bad_arg("list")),
        None => list.push(item.clone()),
    }
    Ok(item)
}

fn set_id(s: &mut TerminalSet) -> &mut String {
    &mut s.id
}

fn preset_id(p: &mut StartupPreset) -> &mut String {
    &mut p.id
}

/// Every saved set, in the order they were made.
#[tauri::command(async)]
pub fn terminal_sets_list(app: AppHandle) -> Result<Vec<TerminalSet>, CmdError> {
    Ok(settings_store::read(&app).terminal_sets)
}

/// Adds a set, or replaces the one with the same id in place. Rejects with
/// `bad_arg` and the field in `detail`: `name`, `entries`, `profile`,
/// `command`, `wait`, `steps`, `worktree` or `list`.
#[tauri::command(async)]
pub fn terminal_set_upsert(
    app: AppHandle,
    state: State<'_, AppState>,
    item: TerminalSet,
) -> Result<TerminalSet, CmdError> {
    let item = set_checked(item, &Profiles::load(data_dir(&state)?)?)?;
    settings_store::try_write(&app, SECTIONS, |s| {
        upsert_by_id(&mut s.terminal_sets, item, set_id, "ts")
    })
}

/// An unknown id is a no-op.
#[tauri::command(async)]
pub fn terminal_set_delete(app: AppHandle, id: String) -> Result<(), CmdError> {
    settings_store::write(&app, SECTIONS, |s| s.terminal_sets.retain(|c| c.id != id))?;
    Ok(())
}

/// Every saved startup preset.
#[tauri::command(async)]
pub fn startup_presets_list(app: AppHandle) -> Result<Vec<StartupPreset>, CmdError> {
    Ok(settings_store::read(&app).startup_presets)
}

/// Adds a preset, or replaces the one with the same id in place.
#[tauri::command(async)]
pub fn startup_preset_upsert(
    app: AppHandle,
    item: StartupPreset,
) -> Result<StartupPreset, CmdError> {
    let item = preset_checked(item)?;
    settings_store::try_write(&app, SECTIONS, |s| {
        upsert_by_id(&mut s.startup_presets, item, preset_id, "sp")
    })
}

/// An unknown id is a no-op.
#[tauri::command(async)]
pub fn startup_preset_delete(app: AppHandle, id: String) -> Result<(), CmdError> {
    settings_store::write(&app, SECTIONS, |s| s.startup_presets.retain(|c| c.id != id))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(command: &str, wait: StepWait) -> SequenceStep {
        SequenceStep {
            command: command.into(),
            wait,
        }
    }

    fn shell_entry(command: &str, startup: Vec<SequenceStep>) -> SetEntry {
        SetEntry {
            target: SetTarget::Shell {
                command: command.into(),
                shell: None,
            },
            worktree: SetWorktree::Current,
            startup,
        }
    }

    fn set(name: &str, entries: Vec<SetEntry>) -> TerminalSet {
        TerminalSet {
            id: String::new(),
            name: name.into(),
            entries,
        }
    }

    fn detail<T>(r: Result<T, CmdError>) -> String {
        r.err().unwrap().detail.unwrap()
    }

    #[test]
    fn changes_name_the_terminal_sets_section() {
        assert_eq!(SECTIONS, &[SettingsSection::TerminalSets]);
    }

    #[test]
    fn a_set_is_trimmed_and_checked_field_by_field() {
        let profiles = Profiles::default();
        let ok = set_checked(
            set("  Dev  ", vec![shell_entry("npm run dev  \n", vec![])]),
            &profiles,
        )
        .unwrap();
        assert_eq!(ok.name, "Dev");
        assert_eq!(
            ok.entries[0].target,
            SetTarget::Shell {
                command: "npm run dev".into(),
                shell: None
            }
        );
        assert_eq!(
            detail(set_checked(
                set(" ", vec![shell_entry("", vec![])]),
                &profiles
            )),
            "name"
        );
        assert_eq!(
            detail(set_checked(
                set(&"x".repeat(81), vec![shell_entry("", vec![])]),
                &profiles
            )),
            "name"
        );
        assert_eq!(detail(set_checked(set("A", vec![]), &profiles)), "entries");
        let many = vec![shell_entry("", vec![]); ENTRIES_MAX + 1];
        assert_eq!(detail(set_checked(set("A", many), &profiles)), "entries");
        let nobody = SetEntry {
            target: SetTarget::Agent {
                profile: "nobody".into(),
            },
            ..shell_entry("", vec![])
        };
        assert_eq!(
            detail(set_checked(set("A", vec![nobody]), &profiles)),
            "profile"
        );
        let unnamed = SetEntry {
            worktree: SetWorktree::Named { name: " ".into() },
            ..shell_entry("", vec![])
        };
        assert_eq!(
            detail(set_checked(set("A", vec![unnamed]), &profiles)),
            "worktree"
        );
    }

    #[test]
    fn startup_steps_are_checked() {
        let bad_command = steps_checked(vec![step("  ", StepWait::None)]);
        assert_eq!(detail(bad_command), "command");
        let long = steps_checked(vec![step(&"y".repeat(4001), StepWait::None)]);
        assert_eq!(detail(long), "command");
        let zero = steps_checked(vec![step("ls", StepWait::Seconds { seconds: 0 })]);
        assert_eq!(detail(zero), "wait");
        let big = steps_checked(vec![step("ls", StepWait::Seconds { seconds: 3601 })]);
        assert_eq!(detail(big), "wait");
        let many = steps_checked(vec![step("ls", StepWait::Idle); STEPS_MAX + 1]);
        assert_eq!(detail(many), "steps");
        let ok = steps_checked(vec![step("ls  ", StepWait::Seconds { seconds: 2 })]).unwrap();
        assert_eq!(ok[0].command, "ls");
    }

    #[test]
    fn a_preset_needs_a_name_and_a_step() {
        let preset = |name: &str, steps| StartupPreset {
            id: String::new(),
            name: name.into(),
            steps,
        };
        assert_eq!(
            detail(preset_checked(preset("", vec![step("ls", StepWait::None)]))),
            "name"
        );
        assert_eq!(detail(preset_checked(preset("P", vec![]))), "steps");
        assert_eq!(
            preset_checked(preset(" P ", vec![step("ls", StepWait::None)]))
                .unwrap()
                .name,
            "P"
        );
    }

    #[test]
    fn upsert_adds_with_a_new_id_then_replaces_in_place() {
        let mut list: Vec<TerminalSet> = Vec::new();
        let a = upsert_by_id(&mut list, set("A", vec![]), set_id, "ts").unwrap();
        assert!(a.id.starts_with("ts-"), "{}", a.id);
        upsert_by_id(&mut list, set("B", vec![]), set_id, "ts").unwrap();
        let renamed = TerminalSet {
            name: "A2".into(),
            ..a.clone()
        };
        upsert_by_id(&mut list, renamed, set_id, "ts").unwrap();
        let names: Vec<_> = list.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["A2", "B"]);
        assert_eq!(list[0].id, a.id);
    }

    #[test]
    fn the_list_is_capped() {
        let mut list: Vec<TerminalSet> = Vec::new();
        for _ in 0..LIST_MAX {
            upsert_by_id(&mut list, set("A", vec![]), set_id, "ts").unwrap();
        }
        assert_eq!(
            detail(upsert_by_id(&mut list, set("A", vec![]), set_id, "ts")),
            "list"
        );
        assert_eq!(list.len(), LIST_MAX);
    }

    #[test]
    fn the_wire_shape_is_camel_case_and_tagged() {
        let entry = SetEntry {
            target: SetTarget::Agent {
                profile: "claude".into(),
            },
            worktree: SetWorktree::Named {
                name: "main".into(),
            },
            startup: vec![step("npm i", StepWait::Seconds { seconds: 5 })],
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            serde_json::json!({
                "target": { "type": "agent", "profile": "claude" },
                "worktree": { "type": "named", "name": "main" },
                "startup": [{ "command": "npm i", "wait": { "type": "seconds", "seconds": 5 } }],
            })
        );
        let shell: SetEntry = serde_json::from_str(
            r#"{ "target": { "type": "shell", "command": "ls" }, "worktree": { "type": "current" } }"#,
        )
        .unwrap();
        assert_eq!(shell, shell_entry("ls", vec![]));
    }

    #[test]
    fn sets_and_presets_round_trip_through_settings_and_a_bad_one_is_dropped() {
        use crate::settings;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(settings::FILE_NAME);
        let store = crate::settings_store::SettingsStore::new(path.clone());
        let saved = store
            .try_update(|s| {
                upsert_by_id(
                    &mut s.terminal_sets,
                    set(
                        "Dev",
                        vec![shell_entry("ls", vec![step("a", StepWait::Idle)])],
                    ),
                    set_id,
                    "ts",
                )
            })
            .unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"terminalSets\""), "{raw}");
        let mut value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        value["terminalSets"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({ "nonsense": true }));
        std::fs::write(&path, value.to_string()).unwrap();
        let loaded = settings::load(&path);
        assert_eq!(loaded.terminal_sets, vec![saved]);
        assert!(loaded.startup_presets.is_empty());
    }
}
