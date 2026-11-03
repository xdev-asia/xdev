//! The one way into `settings.json`. Every write goes through
//! `SettingsStore::update`, which holds a lock across load, change and the
//! atomic save, so two commands changing different sections at once both
//! land.

use std::io;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::CmdError;
use crate::settings::{self, CHANGED_EVENT, Settings, SettingsChanged, SettingsSection, VERSION};

/// Lives in Tauri state from setup on; absent only when the OS gave no
/// config folder.
pub struct SettingsStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl SettingsStore {
    pub fn new(path: PathBuf) -> Self {
        SettingsStore {
            path,
            lock: Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The file as it is; the defaults when it is missing or broken. Needs
    /// no lock: a save renames a whole file into place.
    pub fn read(&self) -> Settings {
        settings::load(&self.path)
    }

    /// Loads, applies `f`, stamps the current version and saves atomically,
    /// all under the lock. Returns what was saved.
    pub fn update<F: FnOnce(&mut Settings)>(&self, f: F) -> io::Result<Settings> {
        let _held = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let mut next = settings::load(&self.path);
        f(&mut next);
        next.version = VERSION;
        settings::save(&self.path, &next)?;
        Ok(next)
    }
}

/// The app's store, once setup registered it.
pub fn store(app: &AppHandle) -> Option<State<'_, SettingsStore>> {
    app.try_state::<SettingsStore>()
}

/// The app's settings; the defaults when there is no store.
pub fn read(app: &AppHandle) -> Settings {
    store(app).map(|s| s.read()).unwrap_or_default()
}

/// `SettingsStore::update` on the app's store, as a command error; once it
/// is saved, every window hears which `sections` changed.
pub fn write<F: FnOnce(&mut Settings)>(
    app: &AppHandle,
    sections: &[SettingsSection],
    f: F,
) -> Result<Settings, CmdError> {
    let store = store(app).ok_or_else(|| CmdError {
        code: "io",
        detail: Some("no app config folder".into()),
    })?;
    let saved = store.update(f).map_err(|e| CmdError {
        code: "io",
        detail: Some(e.to_string()),
    })?;
    emit_changed(app, sections);
    Ok(saved)
}

fn changed(sections: &[SettingsSection]) -> SettingsChanged {
    SettingsChanged {
        sections: sections.to_vec(),
    }
}

/// Tells every window, this one included, that `sections` were saved.
/// Fails only once the app is shutting down; nobody is listening then.
pub fn emit_changed(app: &AppHandle, sections: &[SettingsSection]) {
    let _ = app.emit(CHANGED_EVENT, changed(sections));
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::thread;

    use super::*;

    fn store() -> (tempfile::TempDir, SettingsStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().join("config").join(settings::FILE_NAME));
        (dir, store)
    }

    #[test]
    fn the_changed_payload_names_the_sections() {
        let json =
            |sections: &[SettingsSection]| serde_json::to_string(&changed(sections)).unwrap();
        assert_eq!(
            json(&[SettingsSection::Status]),
            r#"{"sections":["status"]}"#
        );
        assert_eq!(
            json(&[
                SettingsSection::Vault,
                SettingsSection::Git,
                SettingsSection::Terminal
            ]),
            r#"{"sections":["vault","git","terminal"]}"#
        );
        assert_eq!(
            json(&[SettingsSection::Keys, SettingsSection::Ui]),
            r#"{"sections":["keys","ui"]}"#
        );
    }

    #[test]
    fn key_and_ui_settings_are_stored_beside_the_rest() {
        let (_dir, store) = store();
        store
            .update(|s| s.last_vault = Some("D:/docs".into()))
            .unwrap();
        let keys = settings::KeySettings {
            terminal_policy: settings::TerminalKeyPolicy::TerminalFirst,
            terminal_hints: false,
        };
        let stored = store.update(|s| s.keys = keys.clone()).unwrap();
        assert_eq!(stored.keys, keys);
        let ui = store
            .update(|s| s.ui = settings::UiSettings { zoom: 9.0 }.clamped())
            .unwrap()
            .ui;
        assert_eq!(ui.zoom, 2.0);
        let loaded = store.read();
        assert_eq!(loaded.keys, keys);
        assert_eq!(loaded.ui.zoom, 2.0);
        assert_eq!(loaded.last_vault.as_deref(), Some("D:/docs"));
    }

    #[test]
    fn update_returns_what_it_saved() {
        let (_dir, store) = store();
        assert_eq!(store.read(), settings::Settings::default());
        let saved = store
            .update(|s| s.last_vault = Some("D:/docs".into()))
            .unwrap();
        assert_eq!(saved.version, VERSION);
        assert_eq!(saved.last_vault.as_deref(), Some("D:/docs"));
        assert_eq!(store.read(), saved);
        assert_eq!(settings::load(store.path()), saved);
    }

    #[test]
    fn git_settings_are_stored_normalized_beside_the_rest() {
        let (_dir, store) = store();
        store
            .update(|s| s.last_vault = Some("D:/docs".into()))
            .unwrap();
        let git = settings::GitSettings {
            branch_prefix: settings::BranchPrefixMode::Custom,
            branch_prefix_custom: " team//me/ ".into(),
            refresh_local_base_on_create: true,
            ..settings::GitSettings::default()
        };
        let stored = store.update(|s| s.git = git.normalized()).unwrap().git;
        assert_eq!(stored.branch_prefix_custom, "team/me");
        let loaded = store.read();
        assert_eq!(loaded.git, stored);
        assert_eq!(loaded.last_vault.as_deref(), Some("D:/docs"));
    }

    #[test]
    fn concurrent_updates_of_different_fields_lose_none() {
        let (_dir, store) = store();
        let store = Arc::new(store);
        let start = store.read().terminal.scrollback;
        let scrollback = {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                for _ in 0..50 {
                    store.update(|s| s.terminal.scrollback += 1).unwrap();
                }
            })
        };
        let prefix = {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                for _ in 0..50 {
                    store
                        .update(|s| s.git.branch_prefix_custom.push('x'))
                        .unwrap();
                }
            })
        };
        scrollback.join().unwrap();
        prefix.join().unwrap();
        let end = store.read();
        assert_eq!(end.terminal.scrollback, start + 50);
        assert_eq!(end.git.branch_prefix_custom, "x".repeat(50));
    }
}
