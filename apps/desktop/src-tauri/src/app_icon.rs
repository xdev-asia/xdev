//! Settings → Appearance → App icon, applied live: the window and taskbar
//! icon on Windows and Linux, the Dock icon on macOS. The installed file
//! (the .exe, the bundle's .icns) keeps the default icon; that cannot change
//! at runtime. The tray keeps its template.

use tauri::{AppHandle, Manager};

use crate::applog;
use crate::settings::known_app_icon;

/// The 256 px PNG of an icon id; an unknown id gets the default icon.
pub fn png_256(id: &str) -> &'static [u8] {
    match known_app_icon(id) {
        "midnight" => include_bytes!("../icons/alt/midnight.png"),
        "light" => include_bytes!("../icons/alt/light.png"),
        "sunset" => include_bytes!("../icons/alt/sunset.png"),
        "forest" => include_bytes!("../icons/alt/forest.png"),
        "mono" => include_bytes!("../icons/alt/mono.png"),
        _ => include_bytes!("../icons/alt/default.png"),
    }
}

/// Puts icon `id` on every app window (Windows, Linux) or on the Dock
/// (macOS). Best effort: a failure is logged.
pub fn apply(app: &AppHandle, id: &str) {
    let png = png_256(id);
    if cfg!(target_os = "macos") {
        set_dock_icon(app, png);
        return;
    }
    let image = match tauri::image::Image::from_bytes(png) {
        Ok(image) => image,
        Err(e) => return applog::warn("app icon", &e.to_string()),
    };
    for window in app.webview_windows().into_values() {
        if let Err(e) = window.set_icon(image.clone()) {
            applog::warn("app icon", &e.to_string());
        }
    }
}

/// `NSApplication.applicationIconImage`, on the main thread.
#[cfg(target_os = "macos")]
fn set_dock_icon(app: &AppHandle, png: &'static [u8]) {
    let done = app.run_on_main_thread(move || {
        use objc2::{AllocAnyThread, MainThreadMarker};
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::NSData;

        let Some(mtm) = MainThreadMarker::new() else {
            return applog::warn("app icon", "not on the main thread");
        };
        let data = NSData::with_bytes(png);
        let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
            return applog::warn("app icon", "the icon did not decode");
        };
        let ns_app = NSApplication::sharedApplication(mtm);
        // SAFETY: on the main thread (checked above), with an image that is
        // not nil; AppKit retains it.
        #[allow(unsafe_code)]
        unsafe {
            ns_app.setApplicationIconImage(Some(&image))
        };
    });
    if let Err(e) = done {
        applog::warn("app icon", &e.to_string());
    }
}

#[cfg(not(target_os = "macos"))]
fn set_dock_icon(_app: &AppHandle, _png: &'static [u8]) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::APP_ICONS;

    const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

    #[test]
    fn every_known_id_has_its_own_png() {
        let mut seen: Vec<&[u8]> = Vec::new();
        for id in APP_ICONS {
            let png = png_256(id);
            assert!(png.starts_with(PNG_MAGIC), "{id}");
            assert!(!seen.contains(&png), "{id} repeats another icon");
            seen.push(png);
        }
    }

    #[test]
    fn an_unknown_id_gets_the_default_png() {
        assert_eq!(png_256("rainbow"), png_256("default"));
        assert_eq!(png_256(""), png_256("default"));
        assert_eq!(png_256("Midnight"), png_256("default"));
        assert_ne!(png_256("midnight"), png_256("default"));
    }

    #[test]
    fn every_png_is_256_square_and_decodes() {
        for id in APP_ICONS {
            let image = tauri::image::Image::from_bytes(png_256(id)).expect(id);
            assert_eq!((image.width(), image.height()), (256, 256), "{id}");
        }
    }
}
