//! The system tray: Windows keeps xDev running there when the window is
//! closed, macOS shows a menu bar icon. Linux has none. The decisions (which
//! items, whether to exist, how the attention dot looks) are plain functions;
//! the part that talks to the OS exists only where a tray does.

use crate::settings::ShellSettings;
use crate::shell::Os;

/// The id of the one tray icon.
#[cfg(any(windows, target_os = "macos"))]
const TRAY_ID: &str = "main";

/// The attention dot: the `warn` token, dark theme. A test keeps it equal to
/// `packages/xdev-ui/tokens/tokens.json`.
pub const ATTENTION_RGB: [u8; 3] = [0xf2, 0xb5, 0x44];

/// One entry of the tray menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayItem {
    Open,
    Settings,
    CheckUpdates,
    Separator,
    QuitEndAll,
    Quit,
}

/// The tray menu, top to bottom. macOS has Settings and updates too, since it
/// has no window menu to reach them while the window is hidden behind others.
pub fn tray_items(os: Os) -> Vec<TrayItem> {
    match os {
        Os::Macos => vec![
            TrayItem::Open,
            TrayItem::Settings,
            TrayItem::CheckUpdates,
            TrayItem::Separator,
            TrayItem::QuitEndAll,
            TrayItem::Quit,
        ],
        Os::Windows => vec![
            TrayItem::Open,
            TrayItem::Separator,
            TrayItem::QuitEndAll,
            TrayItem::Quit,
        ],
        Os::Linux => Vec::new(),
    }
}

/// Whether the tray icon should exist.
pub fn wanted(os: Os, shell: &ShellSettings) -> bool {
    match os {
        Os::Windows => shell.minimize_to_tray,
        Os::Macos => shell.menu_bar_icon,
        Os::Linux => false,
    }
}

/// Paints the attention dot into the top right corner of straight RGBA
/// pixels: a filled dot in the `warn` colour with a transparent ring around
/// it, so it reads on a light or a dark bar. The centre of the icon is left
/// as it was.
pub fn attention_dot(rgba: &mut [u8], width: u32, height: u32) {
    let (w, h) = (width as i64, height as i64);
    if rgba.len() != (w * h * 4) as usize || w < 8 || h < 8 {
        return;
    }
    let radius = (w.min(h) as f64) * 0.22;
    let ring = (w.min(h) as f64 * 0.08).max(1.0);
    let (cx, cy) = (w as f64 - radius - 0.5, radius + 0.5);
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt();
            let at = ((y * w + x) * 4) as usize;
            if d <= radius {
                rgba[at..at + 3].copy_from_slice(&ATTENTION_RGB);
                rgba[at + 3] = 255;
            } else if d <= radius + ring {
                rgba[at + 3] = 0;
            }
        }
    }
}

#[cfg(any(windows, target_os = "macos"))]
pub use native::{remove, set_attention, sync};

/// Without a tray there is nothing to light.
#[cfg(not(any(windows, target_os = "macos")))]
pub fn sync(_app: &tauri::AppHandle) {}

/// Without a tray there is nothing to remove.
#[cfg(not(any(windows, target_os = "macos")))]
pub fn remove(_app: &tauri::AppHandle) {}

/// Without a tray there is nothing to light.
#[cfg(not(any(windows, target_os = "macos")))]
pub fn set_attention(_app: &tauri::AppHandle, _on: bool) {}

#[cfg(any(windows, target_os = "macos"))]
mod native {
    use std::sync::atomic::Ordering;

    use tauri::image::Image;
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::{AppHandle, Emitter, Manager};

    use super::{TRAY_ID, TrayItem, attention_dot, tray_items, wanted};
    use crate::settings_store;
    use crate::shell::{self, MenuAction, MenuEvent, Os, QuitMode, ShellLabels, ShellState};

    #[cfg(target_os = "macos")]
    const ICON: &[u8] = include_bytes!("../icons/tray-template@2x.png");
    #[cfg(not(target_os = "macos"))]
    const ICON: &[u8] = include_bytes!("../icons/32x32.png");

    const ID_OPEN: &str = "tray-open";
    const ID_SETTINGS: &str = "tray-settings";
    const ID_UPDATES: &str = "tray-updates";
    const ID_QUIT_END_ALL: &str = "quit-end-all";
    const ID_QUIT: &str = "tray-quit";

    fn label(item: TrayItem, l: &ShellLabels) -> &str {
        match item {
            TrayItem::Open => &l.tray_open,
            TrayItem::Settings => &l.settings,
            TrayItem::CheckUpdates => &l.check_updates,
            TrayItem::QuitEndAll => &l.quit_end_all,
            TrayItem::Quit => &l.quit,
            TrayItem::Separator => "",
        }
    }

    fn id(item: TrayItem) -> &'static str {
        match item {
            TrayItem::Open => ID_OPEN,
            TrayItem::Settings => ID_SETTINGS,
            TrayItem::CheckUpdates => ID_UPDATES,
            TrayItem::QuitEndAll => ID_QUIT_END_ALL,
            TrayItem::Quit => ID_QUIT,
            TrayItem::Separator => "",
        }
    }

    fn menu(app: &AppHandle, labels: &ShellLabels) -> tauri::Result<Menu<tauri::Wry>> {
        let menu = Menu::new(app)?;
        for item in tray_items(Os::current()) {
            match item {
                TrayItem::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
                _ => menu.append(&MenuItem::with_id(
                    app,
                    id(item),
                    label(item, labels),
                    true,
                    None::<&str>,
                )?)?,
            }
        }
        Ok(menu)
    }

    /// The tray image, with the dot when `attention` is on.
    fn image(attention: bool) -> Option<Image<'static>> {
        let base = Image::from_bytes(ICON).ok()?;
        let (w, h) = (base.width(), base.height());
        let mut rgba = base.rgba().to_vec();
        if attention {
            attention_dot(&mut rgba, w, h);
        }
        Some(Image::new_owned(rgba, w, h))
    }

    fn show_window(app: &AppHandle) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }

    fn emit(app: &AppHandle, action: MenuAction) {
        show_window(app);
        let _ = app.emit("shell://menu", MenuEvent { action });
    }

    fn on_menu(app: &AppHandle, id: &str) {
        match id {
            ID_OPEN => show_window(app),
            ID_SETTINGS => emit(app, MenuAction::OpenSettings),
            ID_UPDATES => emit(app, MenuAction::CheckUpdates),
            // The webview confirms first: ending every terminal is not undone.
            ID_QUIT_END_ALL => emit(app, MenuAction::QuitEndAll),
            ID_QUIT => shell::quit(app, QuitMode::Quit),
            _ => {}
        }
    }

    /// Creates, updates or removes the tray to match the settings and labels.
    /// Called when either changes.
    pub fn sync(app: &AppHandle) {
        let shell = settings_store::read(app).shell;
        if !wanted(Os::current(), &shell) {
            // Removing drops the icon, so no ghost is left in the tray.
            app.remove_tray_by_id(TRAY_ID);
            return;
        }
        let state = app.state::<ShellState>();
        let labels = state
            .labels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let attention = state.attention.load(Ordering::Relaxed);
        let tooltip = if attention {
            &labels.tray_attention
        } else {
            &labels.tray_tooltip
        };
        let Ok(menu) = menu(app, &labels) else {
            return;
        };
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let _ = tray.set_menu(Some(menu));
            let _ = tray.set_tooltip(Some(tooltip));
            let _ = tray.set_icon_with_as_template(image(attention), !attention);
            return;
        }
        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip(tooltip)
            .menu(&menu)
            .show_menu_on_left_click(Os::current() == Os::Macos)
            .icon_as_template(!attention)
            .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
            .on_tray_icon_event(|tray, event| {
                // A left click opens the window; the right click is the menu.
                let click = matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                );
                if click && Os::current() == Os::Windows {
                    show_window(tray.app_handle());
                }
            });
        if let Some(icon) = image(attention) {
            builder = builder.icon(icon);
        }
        if let Err(e) = builder.build(app) {
            eprintln!("tray failed: {e}");
        }
    }

    /// Takes the icon out as the app exits, so none is left behind.
    pub fn remove(app: &AppHandle) {
        app.remove_tray_by_id(TRAY_ID);
    }

    /// Lights or clears the dot. Lights only when the window cannot be seen.
    pub fn set_attention(app: &AppHandle, on: bool) {
        let state = app.state::<ShellState>();
        if state.attention.swap(on, Ordering::Relaxed) != on {
            sync(app);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(minimize: bool, bar: bool) -> ShellSettings {
        ShellSettings {
            minimize_to_tray: minimize,
            menu_bar_icon: bar,
            ..ShellSettings::default()
        }
    }

    #[test]
    fn the_menu_per_os() {
        assert_eq!(
            tray_items(Os::Windows),
            [
                TrayItem::Open,
                TrayItem::Separator,
                TrayItem::QuitEndAll,
                TrayItem::Quit
            ]
        );
        assert_eq!(
            tray_items(Os::Macos),
            [
                TrayItem::Open,
                TrayItem::Settings,
                TrayItem::CheckUpdates,
                TrayItem::Separator,
                TrayItem::QuitEndAll,
                TrayItem::Quit
            ]
        );
        assert!(tray_items(Os::Linux).is_empty());
    }

    #[test]
    fn each_os_follows_its_own_setting() {
        for (os, minimize, bar, want) in [
            (Os::Windows, true, false, true),
            (Os::Windows, false, true, false),
            (Os::Macos, false, true, true),
            (Os::Macos, true, false, false),
            (Os::Linux, true, true, false),
        ] {
            assert_eq!(
                wanted(os, &shell(minimize, bar)),
                want,
                "{os:?} minimize={minimize} bar={bar}"
            );
        }
    }

    fn pixel(rgba: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
        let at = ((y * w + x) * 4) as usize;
        [rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]]
    }

    #[test]
    fn the_dot_is_warn_in_the_corner_and_leaves_the_centre() {
        let (w, h) = (32u32, 32u32);
        let mut rgba = vec![10u8; (w * h * 4) as usize];
        attention_dot(&mut rgba, w, h);
        let [r, g, b, a] = pixel(&rgba, w, w - 5, 5);
        assert_eq!([r, g, b], ATTENTION_RGB);
        assert_eq!(a, 255);
        // The middle is untouched.
        assert_eq!(pixel(&rgba, w, 12, 20), [10, 10, 10, 10]);
        // Far from the dot nothing changes; right around it a ring is cleared.
        assert_eq!(pixel(&rgba, w, 8, 5), [10, 10, 10, 10]);
        assert!(
            (0..w).any(|x| pixel(&rgba, w, x, 5)[3] == 0),
            "a ring exists"
        );
    }

    #[test]
    fn a_wrong_sized_buffer_is_left_alone() {
        let mut rgba = vec![7u8; 10];
        attention_dot(&mut rgba, 32, 32);
        assert_eq!(rgba, vec![7u8; 10]);
    }

    #[test]
    fn the_dot_colour_is_the_warn_token() {
        let tokens = include_str!("../../../../packages/xdev-ui/tokens/tokens.json");
        let json: serde_json::Value = serde_json::from_str(tokens).unwrap();
        let hex = find_warn_dark(&json).expect("a warn token with a dark value");
        let want = format!(
            "#{:02x}{:02x}{:02x}",
            ATTENTION_RGB[0], ATTENTION_RGB[1], ATTENTION_RGB[2]
        );
        assert_eq!(hex.to_lowercase(), want);
    }

    fn find_warn_dark(v: &serde_json::Value) -> Option<String> {
        match v {
            serde_json::Value::Object(map) => {
                if map.get("name").and_then(|n| n.as_str()) == Some("warn")
                    && let Some(dark) = map.get("value").and_then(|x| x.get("dark"))
                {
                    return dark.as_str().map(str::to_owned);
                }
                map.values().find_map(find_warn_dark)
            }
            serde_json::Value::Array(items) => items.iter().find_map(find_warn_dark),
            _ => None,
        }
    }
}
