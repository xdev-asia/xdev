//! Quick commands: saved terminal commands and agent prompts, global or tied
//! to one repo. The person's own list lives in `settings.json`
//! (`quickCommands`); a repo may also ship read-only ones in `xdev.toml`
//! under `[[commands]]`, which run only once trusted.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::commands::{AppState, CmdError};

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
    /// No commands, or this `hash` is in the trust store.
    pub trusted: bool,
    /// Blake3 hex of the `[[commands]]` part; empty when there is none.
    pub hash: String,
    pub commands: Vec<FileCommand>,
    /// One line per entry left out (and the file's own error when it does
    /// not parse).
    pub errors: Vec<String>,
}

fn not_yet() -> CmdError {
    CmdError {
        code: "io",
        detail: Some("quick commands are not implemented yet".into()),
    }
}

/// Every saved command, in order: global and per repo together.
#[tauri::command(async)]
pub fn quick_commands_list(app: AppHandle) -> Result<Vec<QuickCommand>, CmdError> {
    let _ = app;
    Ok(Vec::new())
}

/// Inserts at the end of its scope, or replaces the one with the same id in
/// place. Returns what was stored, with a new id when `item.id` was empty.
#[tauri::command(async)]
pub fn quick_command_upsert(
    app: AppHandle,
    state: State<'_, AppState>,
    item: QuickCommand,
) -> Result<QuickCommand, CmdError> {
    let _ = (app, state, item);
    Err(not_yet())
}

#[tauri::command(async)]
pub fn quick_command_delete(app: AppHandle, id: String) -> Result<(), CmdError> {
    let _ = (app, id);
    Err(not_yet())
}

/// Moves the command to position `to` among the commands of its own scope.
#[tauri::command(async)]
pub fn quick_commands_move(app: AppHandle, id: String, to: usize) -> Result<(), CmdError> {
    let _ = (app, id, to);
    Err(not_yet())
}

/// Records a run, for the recently used order.
#[tauri::command(async)]
pub fn quick_command_used(app: AppHandle, id: String) -> Result<(), CmdError> {
    let _ = (app, id);
    Err(not_yet())
}

/// Ids of the recently run commands, newest first, at most 20.
#[tauri::command(async)]
pub fn quick_commands_recent(app: AppHandle) -> Result<Vec<String>, CmdError> {
    let _ = app;
    Ok(Vec::new())
}

/// The `[[commands]]` of the worktree's `xdev.toml`. Read only.
#[tauri::command(async)]
pub fn repo_file_commands(
    state: State<'_, AppState>,
    worktree: PathBuf,
) -> Result<FileCommands, CmdError> {
    let _ = (state, worktree);
    Ok(FileCommands::default())
}

/// Trusts the worktree's `[[commands]]` whose hash is `hash`;
/// `hook_untrusted` when the file no longer holds them. Returns them after.
#[tauri::command(async)]
pub fn repo_file_commands_trust(
    state: State<'_, AppState>,
    worktree: PathBuf,
    hash: String,
) -> Result<FileCommands, CmdError> {
    let _ = (state, worktree, hash);
    Err(not_yet())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
