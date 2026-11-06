//! The global capture shortcut: set from Settings → Screenshots at start-up
//! and after each save.

use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::settings::CaptureSettings;
use crate::settings_store;

/// What `apply` did with the shortcut.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ShortcutStatus {
    Registered {
        chord: String,
    },
    /// Another app holds the chord, or it does not parse.
    Taken {
        chord: String,
    },
    /// The session cannot have global shortcuts; `reason` is `wayland`.
    Unsupported {
        reason: String,
    },
    Off,
}

/// What the settings and the session ask for.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    Off,
    Unsupported(&'static str),
    Register(String),
}

pub(crate) fn plan(settings: &CaptureSettings, session_type: Option<&str>) -> Plan {
    let chord = settings.shortcut.trim();
    if !settings.enabled || chord.is_empty() {
        Plan::Off
    } else if session_type.is_some_and(|s| s.eq_ignore_ascii_case("wayland")) {
        Plan::Unsupported("wayland")
    } else {
        Plan::Register(chord.to_owned())
    }
}

/// The chord registered now, so the next `apply` can take it off.
static CURRENT: Mutex<Option<String>> = Mutex::new(None);

/// Reads the settings and sets the shortcut: the previous chord is taken off
/// first, unless it is the one wanted.
pub fn apply(app: &AppHandle) -> ShortcutStatus {
    let settings = settings_store::read(app).capture;
    let session = std::env::var("XDG_SESSION_TYPE").ok();
    let plan = plan(&settings, session.as_deref());
    let shortcuts = app.global_shortcut();
    let mut current = CURRENT.lock().unwrap_or_else(PoisonError::into_inner);
    if let Plan::Register(chord) = &plan
        && current.as_deref() == Some(chord.as_str())
    {
        return ShortcutStatus::Registered {
            chord: chord.clone(),
        };
    }
    if let Some(previous) = current.take() {
        let _ = shortcuts.unregister(previous.as_str());
    }
    match plan {
        Plan::Off => ShortcutStatus::Off,
        Plan::Unsupported(reason) => ShortcutStatus::Unsupported {
            reason: reason.to_owned(),
        },
        Plan::Register(chord) => {
            let registered = shortcuts.on_shortcut(chord.as_str(), |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = super::start(app);
                }
            });
            match registered {
                Ok(()) => {
                    *current = Some(chord.clone());
                    ShortcutStatus::Registered { chord }
                }
                Err(_) => ShortcutStatus::Taken { chord },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(enabled: bool, shortcut: &str) -> CaptureSettings {
        CaptureSettings {
            enabled,
            shortcut: shortcut.to_owned(),
            ..CaptureSettings::default()
        }
    }

    #[test]
    fn off_wayland_or_a_chord() {
        let on = settings(true, "CmdOrCtrl+Alt+Shift+S");
        assert_eq!(plan(&settings(false, "CmdOrCtrl+S"), None), Plan::Off);
        assert_eq!(plan(&settings(true, "  "), None), Plan::Off);
        assert_eq!(plan(&on, Some("wayland")), Plan::Unsupported("wayland"));
        assert_eq!(
            plan(&on, Some("x11")),
            Plan::Register("CmdOrCtrl+Alt+Shift+S".into())
        );
        assert_eq!(
            plan(&on, None),
            Plan::Register("CmdOrCtrl+Alt+Shift+S".into())
        );
    }

    #[test]
    fn the_default_chord_parses() {
        let chord = CaptureSettings::default().shortcut;
        assert!(
            chord
                .parse::<tauri_plugin_global_shortcut::Shortcut>()
                .is_ok()
        );
    }

    #[test]
    fn status_serializes_with_a_tag() {
        let s = serde_json::to_value(ShortcutStatus::Taken {
            chord: "Ctrl+K".into(),
        })
        .unwrap();
        assert_eq!(
            s,
            serde_json::json!({ "status": "taken", "chord": "Ctrl+K" })
        );
        let s = serde_json::to_value(ShortcutStatus::Off).unwrap();
        assert_eq!(s, serde_json::json!({ "status": "off" }));
    }
}
