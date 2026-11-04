//! The macOS menu bar. What it holds is a plain description (`menu_spec`) so
//! the order, the shortcuts and where each item goes are tested on every OS;
//! only `install` builds it, and only on macOS. Windows and Linux have no menu
//! bar: the header's Help menu carries the same items.
//!
//! The shortcuts the webview's own keymap owns (zoom, sidebars, tabs) are not
//! bound here, so a native item never swallows a key the person rebound.

// Only macOS builds the menu; the spec is still tested everywhere.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use crate::shell::{HelpLink, MenuAction, ShellLabels};

/// A system item macOS provides (its label comes from the labels).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Predefined {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Maximize,
}

/// One row of a menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Item {
        id: &'static str,
        label: String,
        accelerator: Option<&'static str>,
    },
    Predefined(Predefined, Option<String>),
    Separator,
}

/// A top-level menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub title: String,
    pub entries: Vec<Entry>,
}

/// Where a chosen item goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// The webview acts on it.
    Action(MenuAction),
    Reload,
    Devtools,
    /// Quit through the guard, like the tray's Quit.
    Quit,
    Help(HelpLink),
}

pub const ID_SETTINGS: &str = "menu-settings";
pub const ID_UPDATES: &str = "menu-updates";
pub const ID_QUIT_END_ALL: &str = "menu-quit-end-all";
pub const ID_QUIT: &str = "menu-quit";
pub const ID_RELOAD: &str = "menu-reload";
pub const ID_FORCE_RELOAD: &str = "menu-force-reload";
pub const ID_DEVTOOLS: &str = "menu-devtools";
pub const ID_ZOOM_RESET: &str = "menu-zoom-reset";
pub const ID_ZOOM_IN: &str = "menu-zoom-in";
pub const ID_ZOOM_OUT: &str = "menu-zoom-out";
pub const ID_LEFT: &str = "menu-left-sidebar";
pub const ID_RIGHT: &str = "menu-right-sidebar";
pub const ID_DOCS: &str = "menu-docs";
pub const ID_START: &str = "menu-getting-started";
pub const ID_CHANGELOG: &str = "menu-changelog";
pub const ID_ISSUE: &str = "menu-report-issue";

/// What a menu item id does; `None` for an id that is not ours.
pub fn route(id: &str) -> Option<Route> {
    Some(match id {
        ID_SETTINGS => Route::Action(MenuAction::OpenSettings),
        ID_UPDATES => Route::Action(MenuAction::CheckUpdates),
        ID_QUIT_END_ALL => Route::Action(MenuAction::QuitEndAll),
        ID_QUIT => Route::Quit,
        ID_RELOAD | ID_FORCE_RELOAD => Route::Reload,
        ID_DEVTOOLS => Route::Devtools,
        ID_ZOOM_RESET => Route::Action(MenuAction::ZoomReset),
        ID_ZOOM_IN => Route::Action(MenuAction::ZoomIn),
        ID_ZOOM_OUT => Route::Action(MenuAction::ZoomOut),
        ID_LEFT => Route::Action(MenuAction::ToggleLeftSidebar),
        ID_RIGHT => Route::Action(MenuAction::ToggleRightSidebar),
        ID_DOCS => Route::Help(HelpLink::Docs),
        ID_START => Route::Help(HelpLink::GettingStarted),
        ID_CHANGELOG => Route::Help(HelpLink::Changelog),
        ID_ISSUE => Route::Help(HelpLink::ReportIssue),
        _ => return None,
    })
}

fn item(id: &'static str, label: &str, accelerator: Option<&'static str>) -> Entry {
    Entry::Item {
        id,
        label: label.to_owned(),
        accelerator,
    }
}

fn system(kind: Predefined) -> Entry {
    Entry::Predefined(kind, None)
}

/// The menu bar, left to right.
pub fn menu_spec(l: &ShellLabels) -> Vec<Section> {
    let section = |title: &str, entries: Vec<Entry>| Section {
        title: title.to_owned(),
        entries,
    };
    vec![
        section(
            &l.tray_tooltip,
            vec![
                Entry::Predefined(Predefined::About, Some(l.about.clone())),
                Entry::Separator,
                item(ID_SETTINGS, &l.settings, Some("CmdOrCtrl+,")),
                item(ID_UPDATES, &l.check_updates, None),
                Entry::Separator,
                system(Predefined::Services),
                Entry::Predefined(Predefined::Hide, Some(l.hide.clone())),
                Entry::Predefined(Predefined::HideOthers, Some(l.hide_others.clone())),
                Entry::Predefined(Predefined::ShowAll, Some(l.show_all.clone())),
                Entry::Separator,
                item(ID_QUIT_END_ALL, &l.quit_end_all, None),
                item(ID_QUIT, &l.quit, Some("CmdOrCtrl+Q")),
            ],
        ),
        // The standard edit shortcuts: without them copy and paste stop working
        // in every input and in the terminal.
        section(
            &l.edit,
            vec![
                system(Predefined::Undo),
                system(Predefined::Redo),
                Entry::Separator,
                system(Predefined::Cut),
                system(Predefined::Copy),
                system(Predefined::Paste),
                system(Predefined::SelectAll),
            ],
        ),
        section(
            &l.view,
            vec![
                item(ID_RELOAD, &l.reload, Some("CmdOrCtrl+R")),
                item(ID_FORCE_RELOAD, &l.force_reload, Some("CmdOrCtrl+Shift+R")),
                item(ID_DEVTOOLS, &l.devtools, Some("Alt+CmdOrCtrl+I")),
                Entry::Separator,
                item(ID_ZOOM_RESET, &l.zoom_reset, None),
                item(ID_ZOOM_IN, &l.zoom_in, None),
                item(ID_ZOOM_OUT, &l.zoom_out, None),
                Entry::Separator,
                item(ID_LEFT, &l.left_sidebar, None),
                item(ID_RIGHT, &l.right_sidebar, None),
                Entry::Separator,
                system(Predefined::Fullscreen),
            ],
        ),
        section(
            &l.window,
            vec![system(Predefined::Minimize), system(Predefined::Maximize)],
        ),
        section(
            &l.help,
            vec![
                item(ID_DOCS, &l.docs, None),
                item(ID_START, &l.getting_started, None),
                item(ID_CHANGELOG, &l.changelog, None),
                Entry::Separator,
                item(ID_ISSUE, &l.report_issue, None),
            ],
        ),
    ]
}

#[cfg(target_os = "macos")]
pub use native::install;

/// Only macOS has a menu bar to fill.
#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle) {}

#[cfg(target_os = "macos")]
mod native {
    use tauri::menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::{AppHandle, Emitter, Manager};

    use super::{Entry, Predefined, Route, menu_spec, route};
    use crate::shell::{self, MenuEvent, QuitMode, ShellState};

    fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
        let labels = app
            .state::<ShellState>()
            .labels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let menu = Menu::new(app)?;
        for section in menu_spec(&labels) {
            let sub = Submenu::new(app, &section.title, true)?;
            for entry in section.entries {
                match entry {
                    Entry::Separator => sub.append(&PredefinedMenuItem::separator(app)?)?,
                    Entry::Item {
                        id,
                        label,
                        accelerator,
                    } => sub.append(&MenuItem::with_id(app, id, label, true, accelerator)?)?,
                    Entry::Predefined(kind, text) => {
                        let text = text.as_deref();
                        let built = match kind {
                            Predefined::About => PredefinedMenuItem::about(
                                app,
                                text,
                                Some(
                                    AboutMetadataBuilder::new()
                                        .name(Some("xDev"))
                                        .version(Some(xdev_core::version()))
                                        .build(),
                                ),
                            )?,
                            Predefined::Services => PredefinedMenuItem::services(app, text)?,
                            Predefined::Hide => PredefinedMenuItem::hide(app, text)?,
                            Predefined::HideOthers => PredefinedMenuItem::hide_others(app, text)?,
                            Predefined::ShowAll => PredefinedMenuItem::show_all(app, text)?,
                            Predefined::Undo => PredefinedMenuItem::undo(app, text)?,
                            Predefined::Redo => PredefinedMenuItem::redo(app, text)?,
                            Predefined::Cut => PredefinedMenuItem::cut(app, text)?,
                            Predefined::Copy => PredefinedMenuItem::copy(app, text)?,
                            Predefined::Paste => PredefinedMenuItem::paste(app, text)?,
                            Predefined::SelectAll => PredefinedMenuItem::select_all(app, text)?,
                            Predefined::Fullscreen => PredefinedMenuItem::fullscreen(app, text)?,
                            Predefined::Minimize => PredefinedMenuItem::minimize(app, text)?,
                            Predefined::Maximize => PredefinedMenuItem::maximize(app, text)?,
                        };
                        sub.append(&built)?;
                    }
                }
            }
            menu.append(&sub)?;
        }
        Ok(menu)
    }

    fn on_event(app: &AppHandle, id: &str) {
        match route(id) {
            Some(Route::Action(action)) => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit("shell://menu", MenuEvent { action });
            }
            Some(Route::Reload) => shell::window_reload_now(app),
            Some(Route::Devtools) => shell::window_devtools_toggle_now(app),
            Some(Route::Quit) => shell::quit(app, QuitMode::Quit),
            Some(Route::Help(link)) => {
                if let Err(e) = shell::open_help(app, link) {
                    eprintln!("help link failed: {e}");
                }
            }
            None => {}
        }
    }

    /// Sets (or rebuilds, after the labels changed) the menu bar.
    pub fn install(app: &AppHandle) {
        match build(app) {
            Ok(menu) => {
                let _ = app.set_menu(menu);
            }
            Err(e) => eprintln!("menu failed: {e}"),
        }
    }

    /// Routes the menu clicks; set once at start.
    pub fn listen(app: &AppHandle) {
        app.on_menu_event(|app, event| on_event(app, event.id().as_ref()));
    }
}

#[cfg(target_os = "macos")]
pub use native::listen;

/// Only macOS has a menu bar to listen to.
#[cfg(not(target_os = "macos"))]
pub fn listen(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(spec: &[Section]) -> Vec<Entry> {
        spec.iter().flat_map(|s| s.entries.clone()).collect()
    }

    #[test]
    fn the_menu_bar_order() {
        let l = ShellLabels::default();
        let titles: Vec<_> = menu_spec(&l).into_iter().map(|s| s.title).collect();
        assert_eq!(titles, ["xDev", "Edit", "View", "Window", "Help"]);
    }

    #[test]
    fn the_shortcuts_are_the_native_ones() {
        let l = ShellLabels::default();
        let accel = |id: &str| {
            flat(&menu_spec(&l)).into_iter().find_map(|e| match e {
                Entry::Item {
                    id: found,
                    accelerator,
                    ..
                } if found == id => Some(accelerator),
                _ => None,
            })
        };
        assert_eq!(accel(ID_SETTINGS), Some(Some("CmdOrCtrl+,")));
        assert_eq!(accel(ID_QUIT), Some(Some("CmdOrCtrl+Q")));
        assert_eq!(accel(ID_DEVTOOLS), Some(Some("Alt+CmdOrCtrl+I")));
        assert_eq!(accel(ID_FORCE_RELOAD), Some(Some("CmdOrCtrl+Shift+R")));
    }

    #[test]
    fn keys_the_webview_owns_are_not_bound_natively() {
        let l = ShellLabels::default();
        for id in [ID_ZOOM_IN, ID_ZOOM_OUT, ID_ZOOM_RESET, ID_LEFT, ID_RIGHT] {
            let bound = flat(&menu_spec(&l)).into_iter().any(
                |e| matches!(e, Entry::Item { id: found, accelerator: Some(_), .. } if found == id),
            );
            assert!(!bound, "{id}");
        }
    }

    #[test]
    fn edit_keeps_copy_and_paste() {
        let l = ShellLabels::default();
        let edit = &menu_spec(&l)[1];
        for kind in [
            Predefined::Cut,
            Predefined::Copy,
            Predefined::Paste,
            Predefined::SelectAll,
        ] {
            assert!(
                edit.entries.contains(&Entry::Predefined(kind, None)),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn every_item_id_is_routed_and_quit_goes_through_the_guard() {
        let l = ShellLabels::default();
        for entry in flat(&menu_spec(&l)) {
            if let Entry::Item { id, .. } = entry {
                assert!(route(id).is_some(), "{id}");
            }
        }
        assert_eq!(route(ID_QUIT), Some(Route::Quit));
        assert_eq!(
            route(ID_QUIT_END_ALL),
            Some(Route::Action(MenuAction::QuitEndAll))
        );
        assert_eq!(
            route(ID_SETTINGS),
            Some(Route::Action(MenuAction::OpenSettings))
        );
        assert_eq!(route(ID_DOCS), Some(Route::Help(HelpLink::Docs)));
        assert_eq!(route("unknown"), None);
    }

    #[test]
    fn labels_come_from_the_labels() {
        let l = ShellLabels {
            settings: "Cài đặt…".into(),
            ..ShellLabels::default()
        };
        assert!(flat(&menu_spec(&l)).iter().any(|e| matches!(
            e,
            Entry::Item { id, label, .. } if *id == ID_SETTINGS && label == "Cài đặt…"
        )));
    }
}
