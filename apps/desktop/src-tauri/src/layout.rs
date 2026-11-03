//! The tab and split layout of every worktree, kept in `<data_dir>/layout.json`
//! so it comes back after a restart. The shape belongs to the UI (R3): the
//! backend stores it as opaque JSON and checks only its `version` and size.

use tauri::State;

use crate::commands::{AppState, CmdError};

/// The snapshot version this build reads and writes.
#[allow(dead_code)] // Contract stub: the checks in `layout_save` use it.
pub const LAYOUT_VERSION: u32 = 1;
/// The largest snapshot stored, in bytes; a larger one is refused.
#[allow(dead_code)] // Contract stub: the checks in `layout_save` use it.
pub const LAYOUT_MAX: usize = 1024 * 1024;

/// The saved snapshot; `None` when there is none, or when the file does not
/// parse (it is then kept as `layout.json.bad`).
#[tauri::command(async)]
pub fn layout_load(state: State<'_, AppState>) -> Result<Option<serde_json::Value>, CmdError> {
    let _ = state;
    Ok(None)
}

/// Replaces the saved snapshot. Rejects with `bad_arg` when its `version` is
/// not [`LAYOUT_VERSION`] and `too_large` past [`LAYOUT_MAX`] bytes.
#[tauri::command(async)]
pub fn layout_save(
    state: State<'_, AppState>,
    snapshot: serde_json::Value,
) -> Result<(), CmdError> {
    let _ = (state, snapshot);
    Ok(())
}
