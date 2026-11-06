//! Layout presets the person saved (`pro.layouts`). Saving needs Pro and is checked here, not in the
//! webview. Reading and deleting stay free, so a downgrade keeps the presets and their use.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::license::LicenseHub;

pub const FILE: &str = "layout-presets.json";
/// Longest name, in characters.
pub const NAME_MAX: usize = 40;
/// Most saved presets.
pub const MAX_PRESETS: usize = 20;
/// The gated feature.
pub const FEATURE: &str = "pro.layouts";
/// Largest file this module reads or writes.
const FILE_MAX: usize = 1024 * 1024;

/// One saved preset. `layout` is the pane layout as the webview made it; Rust keeps it opaque.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UserPreset {
    pub name: String,
    #[cfg_attr(test, ts(type = "unknown"))]
    pub layout: serde_json::Value,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    #[serde(default)]
    presets: Vec<UserPreset>,
}

fn err(code: &'static str, detail: &str) -> CmdError {
    CmdError {
        code,
        detail: Some(detail.to_owned()),
    }
}

/// The saved presets; a missing or unreadable file is an empty list.
pub(crate) fn load(dir: &Path) -> Vec<UserPreset> {
    std::fs::read(dir.join(FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<Saved>(&b).ok())
        .map(|s| s.presets)
        .unwrap_or_default()
}

fn store(dir: &Path, presets: Vec<UserPreset>) -> Result<(), CmdError> {
    let bytes =
        serde_json::to_vec_pretty(&Saved { presets }).map_err(|e| err("io", &e.to_string()))?;
    if bytes.len() > FILE_MAX {
        return Err(err("too_large", "layout presets"));
    }
    crate::atomic::write_atomic(&dir.join(FILE), &bytes).map_err(|e| err("io", &e.to_string()))
}

/// A name with its edges trimmed; it is 1 to `NAME_MAX` characters.
pub(crate) fn clean_name(name: &str) -> Result<String, CmdError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > NAME_MAX || name.chars().any(char::is_control) {
        return Err(err("bad_arg", "name"));
    }
    Ok(name.to_owned())
}

/// Adds the preset, or replaces the one with this name. The gate is the caller's: `allowed` says
/// whether `pro.layouts` is on. A new name past `MAX_PRESETS` is `too_large`.
pub(crate) fn save_in(
    dir: &Path,
    allowed: bool,
    name: &str,
    layout: serde_json::Value,
) -> Result<(), CmdError> {
    if !allowed {
        return Err(err("license_required", FEATURE));
    }
    let name = clean_name(name)?;
    if !layout.is_object() {
        return Err(err("bad_arg", "layout"));
    }
    let mut presets = load(dir);
    match presets.iter_mut().find(|p| p.name == name) {
        Some(found) => found.layout = layout,
        None => {
            if presets.len() >= MAX_PRESETS {
                return Err(err("too_large", "layout presets"));
            }
            presets.push(UserPreset { name, layout });
        }
    }
    store(dir, presets)
}

pub(crate) fn delete_in(dir: &Path, name: &str) -> Result<(), CmdError> {
    let mut presets = load(dir);
    let before = presets.len();
    presets.retain(|p| p.name != name);
    if presets.len() == before {
        return Ok(());
    }
    store(dir, presets)
}

#[tauri::command(async)]
pub fn layout_presets_user(state: State<'_, AppState>) -> Result<Vec<UserPreset>, CmdError> {
    Ok(load(data_dir(&state)?))
}

#[tauri::command(async)]
pub fn layout_preset_save(
    state: State<'_, AppState>,
    hub: State<'_, LicenseHub>,
    name: String,
    layout: serde_json::Value,
) -> Result<(), CmdError> {
    save_in(data_dir(&state)?, hub.allows(FEATURE), &name, layout)
}

#[tauri::command(async)]
pub fn layout_preset_delete(state: State<'_, AppState>, name: String) -> Result<(), CmdError> {
    delete_in(data_dir(&state)?, &name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn layout() -> serde_json::Value {
        json!({ "root": { "kind": "leaf", "id": "p1" } })
    }

    #[test]
    fn saving_is_gated() {
        let dir = tempfile::tempdir().unwrap();
        let e = save_in(dir.path(), false, "Review", layout()).unwrap_err();
        assert_eq!(e.code, "license_required");
        assert!(load(dir.path()).is_empty());
        assert!(!dir.path().join(FILE).exists());
    }

    #[test]
    fn saves_replaces_and_deletes() {
        let dir = tempfile::tempdir().unwrap();
        save_in(dir.path(), true, " Review ", layout()).unwrap();
        save_in(dir.path(), true, "Review", json!({ "root": 2 })).unwrap();
        let all = load(dir.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Review");
        assert_eq!(all[0].layout, json!({ "root": 2 }));
        delete_in(dir.path(), "Review").unwrap();
        assert!(load(dir.path()).is_empty());
        // Deleting what is not there is not an error, and works on any plan.
        delete_in(dir.path(), "Review").unwrap();
    }

    #[test]
    fn the_name_is_limited() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["", "   ", "a\nb", &"x".repeat(NAME_MAX + 1)] {
            assert_eq!(
                save_in(dir.path(), true, bad, layout()).unwrap_err().code,
                "bad_arg"
            );
        }
        save_in(dir.path(), true, &"x".repeat(NAME_MAX), layout()).unwrap();
        // Characters, not bytes.
        save_in(dir.path(), true, &"é".repeat(NAME_MAX), layout()).unwrap();
    }

    #[test]
    fn the_layout_must_be_an_object() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            save_in(dir.path(), true, "A", json!("no"))
                .unwrap_err()
                .code,
            "bad_arg"
        );
    }

    #[test]
    fn the_count_is_limited_but_a_replace_still_works() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..MAX_PRESETS {
            save_in(dir.path(), true, &format!("p{i}"), layout()).unwrap();
        }
        let e = save_in(dir.path(), true, "one more", layout()).unwrap_err();
        assert_eq!(e.code, "too_large");
        save_in(dir.path(), true, "p0", json!({ "root": 3 })).unwrap();
        assert_eq!(load(dir.path()).len(), MAX_PRESETS);
    }

    #[test]
    fn a_broken_file_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), b"{nope").unwrap();
        assert!(load(dir.path()).is_empty());
    }
}
