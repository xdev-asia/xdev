//! The macOS Screen Recording permission. Other systems ask nothing.

use serde::Serialize;
use tauri::AppHandle;

use crate::commands::CmdError;

const PRIVACY_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum CapturePermission {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Granted,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Denied,
    /// Kept for a system that cannot say.
    #[allow(dead_code)]
    Unknown,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    NotNeeded,
}

pub fn status() -> CapturePermission {
    #[cfg(target_os = "macos")]
    {
        if objc2_core_graphics::CGPreflightScreenCaptureAccess() {
            CapturePermission::Granted
        } else {
            CapturePermission::Denied
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        CapturePermission::NotNeeded
    }
}

/// Opens System Settings at Privacy & Security, Screen Recording.
pub fn open_privacy(app: &AppHandle) -> Result<(), CmdError> {
    use crate::history::UrlOpener;
    crate::history::PluginOpener(app).open(PRIVACY_URL)
}
