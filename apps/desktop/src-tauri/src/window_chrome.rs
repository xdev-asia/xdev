//! Native or custom window frame, applied live from `UiSettings::titlebar`.

use tauri::{AppHandle, Manager};

use crate::applog;
use crate::settings::TitlebarMode;

/// Title the native frame shows; the custom one hides it.
#[cfg(target_os = "macos")]
const NATIVE_TITLE: &str = "xDev";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Other,
}

impl Os {
    pub const CURRENT: Os = if cfg!(target_os = "macos") {
        Os::Mac
    } else {
        Os::Other
    };
}

/// What `apply` does to the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// Windows and Linux, custom: no system frame.
    HideDecorations,
    /// Windows and Linux, native: the system frame back.
    ShowDecorations,
    /// macOS, custom: content under the title bar, traffic lights kept, no title.
    MacOverlay,
    /// macOS, native: the visible title bar back.
    MacVisible,
}

pub fn plan(mode: TitlebarMode, os: Os) -> Plan {
    match (mode, os) {
        (TitlebarMode::Custom, Os::Mac) => Plan::MacOverlay,
        (TitlebarMode::Native, Os::Mac) => Plan::MacVisible,
        (TitlebarMode::Custom, Os::Other) => Plan::HideDecorations,
        (TitlebarMode::Native, Os::Other) => Plan::ShowDecorations,
    }
}

/// Puts the main window in `mode`. Best effort: a failure is logged.
pub fn apply(app: &AppHandle, mode: TitlebarMode) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let plan = plan(mode, Os::CURRENT);
    let done = match plan {
        Plan::HideDecorations => window.set_decorations(false),
        Plan::ShowDecorations => window.set_decorations(true),
        Plan::MacOverlay | Plan::MacVisible => set_mac_style(&window, plan),
    };
    if let Err(e) = done {
        applog::warn("window chrome", &e.to_string());
    }
}

#[cfg(target_os = "macos")]
fn set_mac_style(window: &tauri::WebviewWindow, plan: Plan) -> tauri::Result<()> {
    use tauri::TitleBarStyle;
    if plan == Plan::MacOverlay {
        window.set_title_bar_style(TitleBarStyle::Overlay)?;
        window.set_title("")
    } else {
        window.set_title_bar_style(TitleBarStyle::Visible)?;
        window.set_title(NATIVE_TITLE)
    }
}

#[cfg(not(target_os = "macos"))]
fn set_mac_style(_window: &tauri::WebviewWindow, _plan: Plan) -> tauri::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_hides_the_frame_off_mac() {
        assert_eq!(plan(TitlebarMode::Custom, Os::Other), Plan::HideDecorations);
        assert_eq!(plan(TitlebarMode::Native, Os::Other), Plan::ShowDecorations);
    }

    #[test]
    fn custom_overlays_the_title_bar_on_mac() {
        assert_eq!(plan(TitlebarMode::Custom, Os::Mac), Plan::MacOverlay);
        assert_eq!(plan(TitlebarMode::Native, Os::Mac), Plan::MacVisible);
    }
}
