//! Open a worktree in another program: one of the person's Open In apps,
//! or the system file manager.

use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::commands::{AppState, CmdError};
use crate::settings::{OpenInSettings, SettingsSection};
use crate::settings_store;
use crate::workspace::bad_arg;

/// Where `open_in` sends a folder.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OpenTarget {
    /// The Open In app with this id.
    App {
        id: String,
    },
    FileManager,
}

/// Settings → Open In Apps as stored; the default list when nothing is.
#[tauri::command(async)]
pub fn open_in_settings(app: AppHandle) -> OpenInSettings {
    settings_store::read(&app).open_in
}

/// Stores the Open In list and returns what was stored; `bad_arg` names
/// the rule a refused list breaks.
#[tauri::command(async)]
pub fn open_in_settings_put(app: AppHandle, v: OpenInSettings) -> Result<OpenInSettings, CmdError> {
    v.check().map_err(bad_arg)?;
    settings_store::write(&app, &[SettingsSection::OpenIn], |s| s.open_in = v).map(|s| s.open_in)
}

/// Opens `path`, a repo or worktree the workspace knows, in `target`.
#[tauri::command(async)]
pub fn open_in(
    state: State<'_, AppState>,
    path: PathBuf,
    target: OpenTarget,
) -> Result<(), CmdError> {
    let _ = (state, path, target);
    Err(CmdError {
        code: "io",
        detail: Some("open_in is not implemented yet".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{self, OpenInApp};
    use crate::settings_store::SettingsStore;

    fn app(id: &str, command: &str) -> OpenInApp {
        OpenInApp {
            id: id.into(),
            label: id.into(),
            command: command.into(),
            args: Vec::new(),
        }
    }

    fn list(apps: Vec<OpenInApp>) -> OpenInSettings {
        OpenInSettings { apps }
    }

    fn store() -> (tempfile::TempDir, SettingsStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().join(settings::FILE_NAME));
        (dir, store)
    }

    #[test]
    fn an_old_file_reads_the_default_list() {
        let (_dir, store) = store();
        std::fs::write(store.path(), r#"{"version":1,"git":{}}"#).unwrap();
        assert_eq!(store.read().open_in, OpenInSettings::default());
        assert_eq!(OpenInSettings::default().apps[0].command, "code");
    }

    #[test]
    fn a_broken_open_in_section_keeps_the_rest() {
        let (_dir, store) = store();
        std::fs::write(
            store.path(),
            r#"{"open_in":{"apps":7},"vault_prompted":true}"#,
        )
        .unwrap();
        let read = store.read();
        assert_eq!(read.open_in, OpenInSettings::default());
        assert!(read.vault_prompted);
    }

    #[test]
    fn the_list_rules() {
        assert_eq!(OpenInSettings::default().check(), Ok(()));
        let nine = (0..9).map(|i| app(&format!("a{i}"), "x")).collect();
        assert_eq!(list(nine).check(), Err("apps"));
        assert_eq!(list(vec![app("a", "x"), app("a", "y")]).check(), Err("id"));
        assert_eq!(list(vec![app(" ", "x")]).check(), Err("id"));
        let mut empty = app("a", "x");
        empty.label = String::new();
        assert_eq!(list(vec![empty]).check(), Err("label"));
        let mut long = app("a", "x");
        long.label = "é".repeat(41);
        assert_eq!(list(vec![long]).check(), Err("label"));
        assert_eq!(list(vec![app("a", "")]).check(), Err("command"));
        assert_eq!(list(vec![app("a", "code --new")]).check(), Err("command"));
        assert_eq!(
            list(vec![app("a", &"c".repeat(261))]).check(),
            Err("command")
        );
        let mut args = app("a", "x");
        args.args = vec!["-n".into(); 9];
        assert_eq!(list(vec![args]).check(), Err("args"));
        let mut arg = app("a", "x");
        arg.args = vec!["a".repeat(201)];
        assert_eq!(list(vec![arg]).check(), Err("args"));
    }

    #[test]
    fn a_command_with_spaces_must_be_an_existing_absolute_path() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("My Editor").join("edit.exe");
        let command = exe.to_string_lossy().into_owned();
        assert_eq!(list(vec![app("a", &command)]).check(), Err("command"));
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(list(vec![app("a", &command)]).check(), Ok(()));
    }

    #[test]
    fn a_stored_list_keeps_order_and_args() {
        let (_dir, store) = store();
        let mut cursor = app("app-1", "cursor");
        cursor.args = vec!["-n".into(), "--reuse".into()];
        let next = list(vec![cursor, OpenInSettings::default().apps[0].clone()]);
        let saved = store.update(|s| s.open_in = next.clone()).unwrap();
        assert_eq!(saved.open_in, next);
        assert_eq!(store.read().open_in, next);
        let text = std::fs::read_to_string(store.path()).unwrap();
        assert!(text.contains("\"open_in\""), "{text}");
    }
}
