//! How many new windows a page may open: one a second and five a minute per tab. The rest are
//! dropped; the first drop of a tab asks the front end to say so, once.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

/// Least time between two popups of one tab.
const MIN_GAP: Duration = Duration::from_secs(1);
/// The window `PER_WINDOW` counts in.
const WINDOW: Duration = Duration::from_secs(60);
/// Most popups of one tab in `WINDOW`.
const PER_WINDOW: usize = 5;

/// What becomes of a page's request for a new window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Popup {
    /// Opens as a new tab.
    Open,
    /// Dropped; `notify` is true for the tab's first drop.
    Drop { notify: bool },
}

#[derive(Debug, Default)]
struct TabPopups {
    /// When the popups of the last `WINDOW` opened, oldest first.
    opened: VecDeque<Instant>,
    notified: bool,
}

/// Popup counts per tab. The clock is the caller's, so tests can move it.
#[derive(Debug, Default)]
pub struct PopupLimiter {
    tabs: HashMap<String, TabPopups>,
}

impl PopupLimiter {
    /// Decides a popup of `tab` asked for at `now`, and counts it when it opens.
    pub fn request(&mut self, tab: &str, now: Instant) -> Popup {
        let t = self.tabs.entry(tab.to_owned()).or_default();
        while t
            .opened
            .front()
            .is_some_and(|&at| now.saturating_duration_since(at) >= WINDOW)
        {
            t.opened.pop_front();
        }
        let too_soon = t
            .opened
            .back()
            .is_some_and(|&at| now.saturating_duration_since(at) < MIN_GAP);
        if too_soon || t.opened.len() >= PER_WINDOW {
            let notify = !t.notified;
            t.notified = true;
            return Popup::Drop { notify };
        }
        t.opened.push_back(now);
        Popup::Open
    }

    /// Forgets `tab` (it was closed).
    pub fn forget(&mut self, tab: &str) {
        self.tabs.remove(tab);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    #[test]
    fn one_a_second() {
        let t0 = Instant::now();
        let mut l = PopupLimiter::default();
        assert_eq!(l.request("a", at(t0, 0)), Popup::Open);
        assert_eq!(l.request("a", at(t0, 999)), Popup::Drop { notify: true });
        assert_eq!(l.request("a", at(t0, 500)), Popup::Drop { notify: false });
        assert_eq!(l.request("a", at(t0, 1000)), Popup::Open);
        // Another tab has its own count.
        assert_eq!(l.request("b", at(t0, 1000)), Popup::Open);
    }

    #[test]
    fn five_a_minute() {
        let t0 = Instant::now();
        let mut l = PopupLimiter::default();
        for i in 0..5 {
            assert_eq!(l.request("a", at(t0, i * 1000)), Popup::Open, "{i}");
        }
        assert_eq!(l.request("a", at(t0, 5000)), Popup::Drop { notify: true });
        assert_eq!(
            l.request("a", at(t0, 59_999)),
            Popup::Drop { notify: false }
        );
        // The first popup leaves the window a minute after it opened.
        assert_eq!(l.request("a", at(t0, 60_000)), Popup::Open);
        assert_eq!(l.request("a", at(t0, 61_000)), Popup::Open);
        assert_eq!(
            l.request("a", at(t0, 61_500)),
            Popup::Drop { notify: false }
        );
    }

    #[test]
    fn a_flood_opens_five_and_notifies_once() {
        let t0 = Instant::now();
        let mut l = PopupLimiter::default();
        let results: Vec<Popup> = (0..600).map(|i| l.request("a", at(t0, i * 100))).collect();
        assert_eq!(results.iter().filter(|r| **r == Popup::Open).count(), 5);
        let notified = results
            .iter()
            .filter(|r| **r == Popup::Drop { notify: true })
            .count();
        assert_eq!(notified, 1);
    }

    #[test]
    fn a_forgotten_tab_starts_over() {
        let t0 = Instant::now();
        let mut l = PopupLimiter::default();
        assert_eq!(l.request("a", t0), Popup::Open);
        assert_eq!(l.request("a", t0), Popup::Drop { notify: true });
        l.forget("a");
        assert_eq!(l.request("a", t0), Popup::Open);
        assert_eq!(l.request("a", t0), Popup::Drop { notify: true });
    }
}
