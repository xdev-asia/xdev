//! The status strip at the MacBook notch: a second window, `notch`, that
//! shows the most urgent agent state across all tabs. Without a notch it
//! sits at the top centre of the main display. macOS only, behind Settings →
//! General → "Show status at the notch".
//!
//! The main window reports its agent tabs (`notch_report`); the strip reads
//! the pick (`notch_state`, `STATE_EVENT`) and a click on it focuses the main
//! window on that tab (`notch_open`). The strip is shown without activating
//! the app, so it never takes focus from another app on its own.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// The label of the strip's window.
pub const LABEL: &str = "notch";
/// Carries the `NotchState` to the strip whenever it changes.
pub const STATE_EVENT: &str = "notch://state";

/// Width of each side of the strip next to the notch, in points.
const WING: f64 = 140.0;
/// The strip without a notch, in points.
const PILL_W: f64 = 280.0;
const PILL_H: f64 = 28.0;
/// Space between the menu bar and the strip without a notch.
const PILL_GAP: f64 = 6.0;

/// A tab's status, as the main window computes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum NotchTabStatus {
    Working,
    NeedsYou,
    Done,
    Idle,
    Failed,
    Exited,
}

/// One agent tab of the main window.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct NotchTab {
    pub pty_id: String,
    pub status: NotchTabStatus,
    /// The profile name, or the title the person gave the tab.
    pub name: String,
    pub worktree: String,
}

/// What the strip shows.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum NotchView {
    /// Nothing waits, failed or works: the strip is away.
    #[default]
    Hidden,
    /// An agent waits for input. `others` more wait too.
    #[serde(rename_all = "camelCase")]
    NeedsYou {
        pty_id: String,
        name: String,
        worktree: String,
        others: u32,
    },
    /// An agent stopped on an error. `others` more did too.
    #[serde(rename_all = "camelCase")]
    Failed {
        pty_id: String,
        name: String,
        worktree: String,
        others: u32,
    },
    /// `count` agents work; `pty_id` is the first of them.
    #[serde(rename_all = "camelCase")]
    Working { pty_id: String, count: u32 },
}

/// The view and the width of the notch it sits around.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct NotchState {
    pub view: NotchView,
    /// The notch's width in points; 0 on a display without one.
    pub gap: f64,
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The most urgent state of `tabs`: one waiting for input, else one with an
/// error, else how many work. The first tab of a kind is the one shown.
pub fn pick(tabs: &[NotchTab]) -> NotchView {
    let of = |state: NotchTabStatus| tabs.iter().filter(move |t| t.status == state);
    if let Some(t) = of(NotchTabStatus::NeedsYou).next() {
        return NotchView::NeedsYou {
            pty_id: t.pty_id.clone(),
            name: t.name.clone(),
            worktree: t.worktree.clone(),
            others: count(of(NotchTabStatus::NeedsYou).count() - 1),
        };
    }
    if let Some(t) = of(NotchTabStatus::Failed).next() {
        return NotchView::Failed {
            pty_id: t.pty_id.clone(),
            name: t.name.clone(),
            worktree: t.worktree.clone(),
            others: count(of(NotchTabStatus::Failed).count() - 1),
        };
    }
    match of(NotchTabStatus::Working).next() {
        Some(t) => NotchView::Working {
            pty_id: t.pty_id.clone(),
            count: count(of(NotchTabStatus::Working).count()),
        },
        None => NotchView::Hidden,
    }
}

/// A rectangle in AppKit screen points: the origin is the bottom left of the
/// primary display and y grows upward.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn top(&self) -> f64 {
        self.y + self.h
    }
    fn right(&self) -> f64 {
        self.x + self.w
    }
}

/// What AppKit says of the display the strip goes on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Screen {
    pub frame: Rect,
    /// The frame without the menu bar and the Dock.
    pub visible: Rect,
    /// `safeAreaInsets.top`: the notch's height, 0 without one.
    pub top_inset: f64,
    /// `auxiliaryTopLeftArea` and `auxiliaryTopRightArea`: the menu bar left
    /// and right of the notch; none or empty without one.
    pub left: Option<Rect>,
    pub right: Option<Rect>,
}

/// Where the strip goes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Placement {
    pub frame: Rect,
    /// The notch's width, 0 without one.
    pub gap: f64,
}

/// Around the notch, as tall as it, with a wing each side; without a notch,
/// centred just below the menu bar. Kept inside the display.
pub(crate) fn place(screen: &Screen) -> Placement {
    let notch = match (screen.left, screen.right) {
        (Some(l), Some(r)) if screen.top_inset > 0.0 && l.w > 0.0 && r.w > 0.0 => {
            Some((l.right(), r.x - l.right()))
        }
        _ => None,
    };
    let (frame, gap) = match notch {
        Some((start, gap)) if gap > 0.0 => {
            let w = gap + 2.0 * WING;
            let h = screen.top_inset;
            let x = start + gap / 2.0 - w / 2.0;
            (
                Rect {
                    x,
                    y: screen.frame.top() - h,
                    w,
                    h,
                },
                gap,
            )
        }
        _ => {
            let x = screen.frame.x + (screen.frame.w - PILL_W) / 2.0;
            let y = screen.visible.top() - PILL_H - PILL_GAP;
            (
                Rect {
                    x,
                    y,
                    w: PILL_W,
                    h: PILL_H,
                },
                0.0,
            )
        }
    };
    let x = frame
        .x
        .min(screen.frame.right() - frame.w)
        .max(screen.frame.x);
    Placement {
        frame: Rect { x, ..frame },
        gap,
    }
}

/// The last pick and notch width.
#[derive(Default)]
pub struct Notch {
    state: Mutex<NotchState>,
    /// Held while the window is made or moved, so two calls cannot make two.
    apply: Mutex<()>,
}

impl Notch {
    fn get(&self) -> NotchState {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Runs `f` on the stored state; whether it changed.
    fn update(&self, f: impl FnOnce(&mut NotchState)) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let before = state.clone();
        f(&mut state);
        *state != before
    }
}

fn emit_state(app: &AppHandle, state: &NotchState) {
    let _ = app.emit_to(LABEL, STATE_EVENT, state);
}

/// The main window's agent tabs. The strip changes only when the pick does.
#[tauri::command(async)]
pub fn notch_report(app: AppHandle, notch: State<'_, Notch>, tabs: Vec<NotchTab>) {
    let view = pick(&tabs);
    if notch.update(|s| s.view = view) {
        emit_state(&app, &notch.get());
        sync(&app);
    }
}

/// What the strip shows now; it asks once as it loads.
#[tauri::command]
pub fn notch_state(notch: State<'_, Notch>) -> NotchState {
    notch.get()
}

/// A click on the strip: the main window comes forward on that tab.
#[tauri::command]
pub fn notch_open(app: AppHandle, pty_id: Option<String>) {
    crate::xdev_id::focus_main(&app);
    if let Some(pty_id) = pty_id {
        let _ = app.emit_to(
            "main",
            crate::status::CLICK_EVENT,
            serde_json::json!({ "ptyId": pty_id }),
        );
    }
}

/// Makes, moves, shows or hides the strip after the setting or the pick
/// changed. Off the calling thread: making a window must not wait on a
/// command.
pub fn sync(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { native::apply(&app) });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
mod native {
    use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    use super::{LABEL, Notch, NotchView, PILL_H, PILL_W, Rect, Screen, emit_state, place};
    use crate::{applog, settings_store};

    /// The strip's window, made the first time it is wanted. It stays until
    /// the main window goes: hiding it is enough to turn it off.
    fn window(app: &AppHandle) -> Option<WebviewWindow> {
        if let Some(w) = app.get_webview_window(LABEL) {
            return Some(w);
        }
        let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("notch.html".into()))
            .title("xDev")
            .inner_size(PILL_W, PILL_H)
            .transparent(true)
            .decorations(false)
            .resizable(false)
            .focused(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .shadow(false)
            .accept_first_mouse(true)
            .visible(false)
            .build();
        let window = match built {
            Ok(w) => w,
            Err(e) => {
                applog::warn("notch", &e.to_string());
                return None;
            }
        };
        // The strip alone must not keep the app open after its window closed.
        if let Some(main) = app.get_webview_window("main") {
            let strip = window.clone();
            main.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    let _ = strip.destroy();
                }
            });
        }
        Some(window)
    }

    pub(super) fn apply(app: &AppHandle) {
        let notch = app.state::<Notch>();
        let _held = notch.apply.lock().unwrap_or_else(|e| e.into_inner());
        let wanted = settings_store::read(app).shell.notch_status;
        let show = wanted && notch.get().view != NotchView::Hidden;
        let window = if wanted {
            window(app)
        } else {
            app.get_webview_window(LABEL)
        };
        let Some(window) = window else {
            return;
        };
        let app = app.clone();
        let done = window
            .clone()
            .run_on_main_thread(move || order(&app, &window, show));
        if let Err(e) = done {
            applog::warn("notch", &e.to_string());
        }
    }

    fn rect(r: objc2_foundation::NSRect) -> Rect {
        Rect {
            x: r.origin.x,
            y: r.origin.y,
            w: r.size.width,
            h: r.size.height,
        }
    }

    /// Places the strip on the main display and orders it in or out, without
    /// making it key or activating the app. On the main thread.
    fn order(app: &AppHandle, window: &WebviewWindow, show: bool) {
        use objc2::MainThreadMarker;
        use objc2::runtime::NSObjectProtocol;
        use objc2::sel;
        use objc2_app_kit::{NSScreen, NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior};
        use objc2_foundation::{NSPoint, NSRect, NSSize};

        let Some(mtm) = MainThreadMarker::new() else {
            return applog::warn("notch", "not on the main thread");
        };
        let ptr = match window.ns_window() {
            Ok(p) if !p.is_null() => p,
            _ => return applog::warn("notch", "no native window"),
        };
        // SAFETY: Tauri hands out the NSWindow of a window that is alive (we
        // hold it), and we are on the main thread where AppKit wants it used.
        #[allow(unsafe_code)]
        let ns: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
        if !show {
            ns.orderOut(None);
            return;
        }
        // The first screen is the main display, the one with the menu bar.
        let Some(screen) = NSScreen::screens(mtm).iter().next() else {
            return ns.orderOut(None);
        };
        // Both came with macOS 12; an older system has no notch.
        let aux = screen.respondsToSelector(sel!(auxiliaryTopLeftArea))
            && screen.respondsToSelector(sel!(safeAreaInsets));
        let placed = place(&Screen {
            frame: rect(screen.frame()),
            visible: rect(screen.visibleFrame()),
            top_inset: if aux {
                screen.safeAreaInsets().top
            } else {
                0.0
            },
            left: aux.then(|| rect(screen.auxiliaryTopLeftArea())),
            right: aux.then(|| rect(screen.auxiliaryTopRightArea())),
        });
        let notch = app.state::<Notch>();
        if notch.update(|s| s.gap = placed.gap) {
            emit_state(app, &notch.get());
        }
        let f = placed.frame;
        ns.setFrame_display(
            NSRect::new(NSPoint::new(f.x, f.y), NSSize::new(f.w, f.h)),
            true,
        );
        ns.setLevel(NSStatusWindowLevel);
        ns.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        ns.setHidesOnDeactivate(false);
        ns.orderFrontRegardless();
    }
}

#[cfg(test)]
#[path = "notch_tests.rs"]
mod tests;
