//! The window shell around the webview: how a close is handled, the quit
//! paths, the labels the native menu and tray draw, and the fixed help
//! links. The tray is `tray.rs`, the macOS menu `app_menu.rs`.

use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::settings::{OnQuit, SettingsSection, ShellSettings};
use crate::settings_store;

/// The label of the one app window.
const MAIN: &str = "main";

/// The operating systems the shell treats differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Macos,
    Linux,
}

impl Os {
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

/// What the webview does with a close request: the window was hidden to the
/// tray (`Hide`) or the close goes on to the quit guard (`Close`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum CloseIntent {
    Hide,
    Close,
}

/// How the app ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum QuitMode {
    /// Quit; terminals follow the "On quit" setting.
    Quit,
    /// Quit and end every terminal.
    EndAll,
    /// Quit, install a pending update and start again.
    Restart,
}

/// A page the Help menu opens in the OS browser. A fixed set: the webview
/// never passes a URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum HelpLink {
    Docs,
    GettingStarted,
    Changelog,
    ReportIssue,
    Source,
}

/// A native menu or tray item the webview acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum MenuAction {
    OpenSettings,
    Shortcuts,
    CheckUpdates,
    QuitEndAll,
    ZoomIn,
    ZoomOut,
    ZoomReset,
    ToggleLeftSidebar,
    ToggleRightSidebar,
    About,
}

/// The payload of the `shell://menu` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct MenuEvent {
    pub action: MenuAction,
}

/// Every string the tray and the native menu draw. The webview sends them in
/// the person's language; until it does, these are the English ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ShellLabels {
    pub tray_tooltip: String,
    pub tray_attention: String,
    pub tray_open: String,
    pub about: String,
    pub settings: String,
    pub check_updates: String,
    pub hide: String,
    pub hide_others: String,
    pub show_all: String,
    pub quit_end_all: String,
    pub quit: String,
    pub file: String,
    pub edit: String,
    pub view: String,
    pub window: String,
    pub help: String,
    pub reload: String,
    pub force_reload: String,
    pub devtools: String,
    pub zoom_reset: String,
    pub zoom_in: String,
    pub zoom_out: String,
    pub left_sidebar: String,
    pub right_sidebar: String,
    pub fullscreen: String,
    pub minimize: String,
    pub zoom: String,
    pub docs: String,
    pub getting_started: String,
    pub changelog: String,
    pub report_issue: String,
}

impl Default for ShellLabels {
    fn default() -> Self {
        let s = |v: &str| v.to_string();
        Self {
            tray_tooltip: s("xDev"),
            tray_attention: s("xDev – an agent needs you"),
            tray_open: s("Open xDev"),
            about: s("About xDev"),
            settings: s("Settings…"),
            check_updates: s("Check for updates…"),
            hide: s("Hide xDev"),
            hide_others: s("Hide others"),
            show_all: s("Show all"),
            quit_end_all: s("Quit and end terminals…"),
            quit: s("Quit xDev"),
            file: s("File"),
            edit: s("Edit"),
            view: s("View"),
            window: s("Window"),
            help: s("Help"),
            reload: s("Reload"),
            force_reload: s("Force reload"),
            devtools: s("Toggle developer tools"),
            zoom_reset: s("Actual size"),
            zoom_in: s("Zoom in"),
            zoom_out: s("Zoom out"),
            left_sidebar: s("Toggle left sidebar"),
            right_sidebar: s("Toggle right sidebar"),
            fullscreen: s("Toggle full screen"),
            minimize: s("Minimize"),
            zoom: s("Zoom"),
            docs: s("Documentation"),
            getting_started: s("Getting started"),
            changelog: s("Changelog"),
            report_issue: s("Report an issue"),
        }
    }
}

/// Shared by the close handler, the quit commands and the tray.
#[derive(Default)]
pub struct ShellState {
    pub quitting: Mutex<Option<QuitMode>>,
    pub attention: AtomicBool,
    pub labels: Mutex<ShellLabels>,
}

impl ShellState {
    fn quitting(&self) -> Option<QuitMode> {
        *self.quitting.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_quitting(&self, mode: Option<QuitMode>) {
        *self.quitting.lock().unwrap_or_else(|e| e.into_inner()) = mode;
    }
}

/// Whether closing the window hides it to the tray or goes on to the quit
/// guard. Only Windows hides, and only when asked to; a quit in flight always
/// closes. macOS keeps its own close behaviour.
pub fn close_intent(os: Os, shell: &ShellSettings, quitting: bool) -> CloseIntent {
    if !quitting && os == Os::Windows && shell.minimize_to_tray {
        CloseIntent::Hide
    } else {
        CloseIntent::Close
    }
}

/// Whether the "still running in the tray" notice is due: on the first hide.
fn notice_due(intent: CloseIntent, shell: &ShellSettings) -> bool {
    intent == CloseIntent::Hide && !shell.tray_notice_shown
}

/// What `Ptys::quit` follows on exit: "Quit and end terminals" ends them
/// whatever the "On quit" setting says.
pub fn on_quit_for(mode: Option<QuitMode>, setting: OnQuit) -> OnQuit {
    if mode == Some(QuitMode::EndAll) {
        OnQuit::End
    } else {
        setting
    }
}

/// The quit in flight, read as the app exits.
pub fn quit_mode(app: &AppHandle) -> Option<QuitMode> {
    app.try_state::<ShellState>().and_then(|s| s.quitting())
}

/// Called by the webview's close guard before it decides anything. When the
/// window is to hide, it is hidden here and the guard stands down.
#[tauri::command]
pub fn shell_close_requested(
    app: AppHandle,
    state: State<'_, ShellState>,
    notice_title: String,
    notice_body: String,
) -> CloseIntent {
    let shell = settings_store::read(&app).shell;
    let intent = close_intent(Os::current(), &shell, state.quitting().is_some());
    if intent == CloseIntent::Hide {
        if let Some(window) = app.get_webview_window(MAIN) {
            let _ = window.hide();
        }
        if notice_due(intent, &shell) {
            // Once: the flag is saved before the notice so a failure never repeats it.
            let saved = settings_store::write(&app, &[SettingsSection::Shell], |s| {
                s.shell.tray_notice_shown = true;
            });
            if saved.is_ok()
                && let Err(e) = app
                    .notification()
                    .builder()
                    .title(notice_title)
                    .body(notice_body)
                    .show()
            {
                eprintln!("tray notice failed: {e}");
            }
        }
    }
    intent
}

/// Every quit goes through here: the window is shown (a hidden one cannot ask
/// anything) and closed, so the webview's quit guard decides as for a click on
/// the close button.
#[tauri::command]
pub fn shell_quit(app: AppHandle, state: State<'_, ShellState>, mode: QuitMode) {
    state.set_quitting(Some(mode));
    let Some(window) = app.get_webview_window(MAIN) else {
        // No window to ask: leave now.
        app.exit(0);
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    if window.close().is_err() {
        app.exit(0);
    }
}

/// The person answered the quit guard with Cancel.
#[tauri::command]
pub fn shell_quit_cancelled(state: State<'_, ShellState>) {
    state.set_quitting(None);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(minimize: bool) -> ShellSettings {
        ShellSettings {
            minimize_to_tray: minimize,
            ..ShellSettings::default()
        }
    }

    #[test]
    fn only_windows_with_the_setting_on_hides() {
        for (os, minimize, quitting, want) in [
            (Os::Windows, true, false, CloseIntent::Hide),
            (Os::Windows, false, false, CloseIntent::Close),
            (Os::Windows, true, true, CloseIntent::Close),
            (Os::Windows, false, true, CloseIntent::Close),
            (Os::Macos, true, false, CloseIntent::Close),
            (Os::Macos, false, false, CloseIntent::Close),
            (Os::Macos, true, true, CloseIntent::Close),
            (Os::Linux, true, false, CloseIntent::Close),
            (Os::Linux, false, true, CloseIntent::Close),
        ] {
            assert_eq!(
                close_intent(os, &shell(minimize), quitting),
                want,
                "{os:?} minimize={minimize} quitting={quitting}"
            );
        }
    }

    #[test]
    fn the_tray_notice_is_due_once() {
        let mut s = shell(true);
        assert!(notice_due(CloseIntent::Hide, &s));
        assert!(!notice_due(CloseIntent::Close, &s));
        s.tray_notice_shown = true;
        assert!(!notice_due(CloseIntent::Hide, &s));
    }

    #[test]
    fn quit_and_end_all_forces_the_terminals_to_end() {
        for setting in [OnQuit::Keep, OnQuit::End, OnQuit::Ask] {
            assert_eq!(
                on_quit_for(Some(QuitMode::EndAll), setting),
                OnQuit::End,
                "{setting:?}"
            );
            assert_eq!(on_quit_for(Some(QuitMode::Quit), setting), setting);
            assert_eq!(on_quit_for(Some(QuitMode::Restart), setting), setting);
            assert_eq!(on_quit_for(None, setting), setting);
        }
    }

    #[test]
    fn a_cancel_clears_the_quit_in_flight() {
        let state = ShellState::default();
        assert_eq!(state.quitting(), None);
        state.set_quitting(Some(QuitMode::EndAll));
        assert_eq!(state.quitting(), Some(QuitMode::EndAll));
        state.set_quitting(None);
        assert_eq!(state.quitting(), None);
    }
}
