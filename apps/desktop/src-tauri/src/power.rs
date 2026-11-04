//! Keep the computer awake: the mode from Settings → Agents, and the OS
//! request that follows it.

use tauri::{AppHandle, State};

use crate::commands::CmdError;
use crate::settings::KeepAwake;

/// What the footer item shows.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AwakeView {
    pub mode: KeepAwake,
    /// Whether an OS request is held right now.
    pub held: bool,
    /// Whether this machine has a way to hold one.
    pub supported: bool,
}

/// Emitted with an `AwakeView` whenever it changes.
pub const CHANGED_EVENT: &str = "keep-awake://changed";

/// The state behind the commands.
#[derive(Default)]
pub struct Awake;

#[tauri::command]
pub fn keep_awake_get(_app: AppHandle, _awake: State<'_, Awake>) -> AwakeView {
    AwakeView {
        mode: KeepAwake::Off,
        held: false,
        supported: false,
    }
}

#[tauri::command(async)]
pub fn keep_awake_set(
    _app: AppHandle,
    _awake: State<'_, Awake>,
    mode: KeepAwake,
) -> Result<AwakeView, CmdError> {
    Ok(AwakeView {
        mode,
        held: false,
        supported: false,
    })
}

#[tauri::command]
pub fn keep_awake_agents(_app: AppHandle, _awake: State<'_, Awake>, _working: bool) -> AwakeView {
    AwakeView {
        mode: KeepAwake::Off,
        held: false,
        supported: false,
    }
}
