//! The window shell around the webview: how a close is handled, the quit
//! paths, the labels the native menu and tray draw, and the fixed help
//! links. The tray is `tray.rs`, the macOS menu `app_menu.rs`.

use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

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
