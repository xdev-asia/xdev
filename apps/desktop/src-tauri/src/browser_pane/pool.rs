//! Which browser tabs hold a live webview, which were closed, and where a webview may be placed.
//!
//! The decisions of `browser_show` and `browser_close` live here, apart from any webview, so their
//! order can be tested. The commands run them under a per-label async lock (`Locks`); a close
//! marks its tab before it waits for the lock, so a show that is making the webview right then
//! sees the mark when it is done and closes what it made.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tauri::async_runtime::Mutex as AsyncMutex;

/// Most live webviews in one window; older ones are closed and keep their URL in the front end.
pub const MAX_LIVE: usize = 3;
/// Largest side a webview gets, in logical pixels.
const MAX_SIDE: f64 = 16384.0;

/// What `browser_show` does with a tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShowPlan {
    /// The tab was closed: nothing is made or shown.
    Skip,
    /// Its webview exists (made by an earlier show): place and show that one.
    Reuse,
    /// Make its webview.
    Create,
}

/// Live tabs, least recently shown first, and the tabs closed for good.
#[derive(Debug, Default)]
pub struct Pool {
    order: Vec<String>,
    /// Tab ids are not used again while the app runs, so this only grows by closed tabs.
    closed: HashSet<String>,
}

impl Pool {
    /// What a show of `tab` does, given whether its webview exists.
    pub fn plan_show(&self, tab: &str, has_view: bool) -> ShowPlan {
        if self.closed.contains(tab) {
            ShowPlan::Skip
        } else if has_view {
            ShowPlan::Reuse
        } else {
            ShowPlan::Create
        }
    }

    /// `tab` has a webview now, before it is placed: tracks it and returns the tabs past the live
    /// limit, or None when the tab was closed meanwhile (the caller closes the webview it made).
    pub fn shown(&mut self, tab: &str) -> Option<Vec<String>> {
        if self.closed.contains(tab) {
            return None;
        }
        Some(self.touch(tab))
    }

    /// Closes `tab` for good: forgotten, and any later show of it is skipped.
    pub fn close(&mut self, tab: &str) {
        self.closed.insert(tab.to_owned());
        self.remove(tab);
    }

    /// Whether `tab` is live; an eviction skips a tab that was shown again meanwhile.
    pub fn is_live(&self, tab: &str) -> bool {
        self.order.iter().any(|t| t == tab)
    }

    /// Marks `tab` as the most recently shown and returns the tabs that no longer fit.
    pub fn touch(&mut self, tab: &str) -> Vec<String> {
        self.order.retain(|t| t != tab);
        self.order.push(tab.to_owned());
        let over = self.order.len().saturating_sub(MAX_LIVE);
        self.order.drain(..over).collect()
    }

    /// Forgets `tab`; true when it was live.
    pub fn remove(&mut self, tab: &str) -> bool {
        let before = self.order.len();
        self.order.retain(|t| t != tab);
        self.order.len() != before
    }

    #[cfg(test)]
    pub fn live(&self) -> &[String] {
        &self.order
    }
}

/// One async lock per webview label, held across get-or-create, placing, showing, hiding and
/// closing, so those steps of one tab never interleave.
#[derive(Debug, Default)]
pub struct Locks {
    by_label: HashMap<String, Arc<AsyncMutex<()>>>,
}

impl Locks {
    /// The lock of `label`; every caller asking for the same label gets the same one.
    pub fn of(&mut self, label: &str) -> Arc<AsyncMutex<()>> {
        // Locks nobody holds or waits for are dropped as new ones are made.
        self.by_label.retain(|_, l| Arc::strong_count(l) > 1);
        self.by_label.entry(label.to_owned()).or_default().clone()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.by_label.len()
    }
}

/// A rectangle in logical pixels, relative to the window's content area.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(rename = "BrowserBounds"))]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Whole pixels of a rectangle that can hold a webview, or None when there is nothing to show
/// (a value that is not finite, or an empty area).
pub fn clamp_bounds(b: Bounds) -> Option<Bounds> {
    if ![b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite()) {
        return None;
    }
    let width = b.width.round().clamp(0.0, MAX_SIDE);
    let height = b.height.round().clamp(0.0, MAX_SIDE);
    if width < 1.0 || height < 1.0 {
        return None;
    }
    Some(Bounds {
        x: b.x.round().clamp(-MAX_SIDE, MAX_SIDE),
        y: b.y.round().clamp(-MAX_SIDE, MAX_SIDE),
        width,
        height,
    })
}

/// The webview label of a tab: `browser-` and the id with anything but letters, digits, `-` and
/// `_` turned into `_`. No capability names a webview with this prefix, so the page gets no
/// app or plugin command.
pub fn label_of(tab: &str) -> String {
    let id: String = tab
        .chars()
        .take(64)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("browser-{id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_three_live_and_evicts_the_oldest() {
        let mut p = Pool::default();
        assert!(p.touch("a").is_empty());
        assert!(p.touch("b").is_empty());
        assert!(p.touch("c").is_empty());
        // Showing `a` again makes `b` the oldest.
        assert!(p.touch("a").is_empty());
        assert_eq!(p.touch("d"), vec!["b".to_owned()]);
        assert_eq!(p.live(), ["c", "a", "d"]);
        assert!(p.remove("a"));
        assert!(!p.remove("a"));
        assert!(p.touch("e").is_empty());
        assert_eq!(p.touch("f"), vec!["c".to_owned()]);
        assert_eq!(p.live(), ["d", "e", "f"]);
    }

    #[test]
    fn a_show_after_a_close_is_skipped() {
        let mut p = Pool::default();
        assert_eq!(p.plan_show("a", false), ShowPlan::Create);
        p.close("a");
        assert_eq!(p.plan_show("a", false), ShowPlan::Skip);
        assert_eq!(p.plan_show("a", true), ShowPlan::Skip);
        assert_eq!(p.shown("a"), None);
        assert!(p.live().is_empty());
    }

    #[test]
    fn a_close_during_a_create_closes_the_new_webview() {
        // show: plans a create and starts making the webview.
        let mut p = Pool::default();
        assert_eq!(p.plan_show("a", false), ShowPlan::Create);
        // close: marks the tab before it waits for the lock the show holds.
        p.close("a");
        // show: the webview is made; the pool refuses it, so the show closes it.
        assert_eq!(p.shown("a"), None);
        assert!(!p.is_live("a"));
    }

    #[test]
    fn a_second_show_reuses_the_first_webview() {
        let mut p = Pool::default();
        // The first show holds the lock and makes the webview.
        assert_eq!(p.plan_show("a", false), ShowPlan::Create);
        assert_eq!(p.shown("a"), Some(vec![]));
        // The second waited for the lock and finds the webview.
        assert_eq!(p.plan_show("a", true), ShowPlan::Reuse);
        assert_eq!(p.shown("a"), Some(vec![]));
        assert_eq!(p.live(), ["a"]);
    }

    #[test]
    fn an_eviction_skips_a_tab_shown_again() {
        let mut p = Pool::default();
        for t in ["a", "b", "c"] {
            assert_eq!(p.shown(t), Some(vec![]));
        }
        assert_eq!(p.shown("d"), Some(vec!["a".to_owned()]));
        assert!(!p.is_live("a"));
        // `a` shown again before its eviction ran: the eviction skips it.
        assert_eq!(p.shown("a"), Some(vec!["b".to_owned()]));
        assert!(p.is_live("a"));
    }

    #[test]
    fn one_lock_per_label() {
        let mut locks = Locks::default();
        let a1 = locks.of("browser-a");
        let a2 = locks.of("browser-a");
        let b = locks.of("browser-b");
        assert!(Arc::ptr_eq(&a1, &a2));
        assert!(!Arc::ptr_eq(&a1, &b));
        drop((a1, a2, b));
        // Unused locks go when the next one is made.
        let _c = locks.of("browser-c");
        assert_eq!(locks.len(), 1);
    }

    #[test]
    fn the_lock_orders_two_callers() {
        let mut locks = Locks::default();
        let first = locks.of("browser-a");
        let second = locks.of("browser-a");
        let held = first.try_lock().unwrap();
        assert!(second.try_lock().is_err());
        drop(held);
        assert!(second.try_lock().is_ok());
    }

    #[test]
    fn clamps_bounds() {
        let b = |x, y, width, height| Bounds {
            x,
            y,
            width,
            height,
        };
        let cases = [
            (
                b(10.4, 20.6, 300.5, 200.2),
                Some(b(10.0, 21.0, 301.0, 200.0)),
            ),
            (b(0.0, 0.0, 0.0, 100.0), None),
            (b(0.0, 0.0, 100.0, 0.4), None),
            (b(0.0, 0.0, -5.0, 100.0), None),
            (b(f64::NAN, 0.0, 100.0, 100.0), None),
            (b(0.0, 0.0, f64::INFINITY, 100.0), None),
            (b(-20.0, 5.0, 1e9, 50.0), Some(b(-20.0, 5.0, 16384.0, 50.0))),
        ];
        for (input, want) in cases {
            assert_eq!(clamp_bounds(input), want, "{input:?}");
        }
    }

    #[test]
    fn labels_have_the_browser_prefix() {
        assert_eq!(label_of("browser:3"), "browser-browser_3");
        assert_eq!(label_of("a b/c"), "browser-a_b_c");
        assert_eq!(label_of(&"x".repeat(100)).len(), "browser-".len() + 64);
    }
}
