//! Keep the computer awake: the mode from Settings → Agents, and the OS
//! request that follows it.

use std::sync::Mutex;

use tauri::{AppHandle, State};

use crate::commands::CmdError;
use crate::settings::KeepAwake;

/// What the footer item shows.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AwakeView {
    pub mode: KeepAwake,
    /// Whether an OS request is held right now.
    pub held: bool,
    /// Whether this machine has a way to hold one.
    pub supported: bool,
}

/// Emitted with an `AwakeView` whenever it changes.
pub const CHANGED_EVENT: &str = "keep-awake://changed";

/// Whether the OS should be asked to stay awake: `On` always, `Agent` only
/// while an agent works, `Off` never.
pub fn wants_awake(mode: KeepAwake, agents_working: bool) -> bool {
    match mode {
        KeepAwake::On => true,
        KeepAwake::Agent => agents_working,
        KeepAwake::Off => false,
    }
}

/// One OS request not to sleep.
pub trait Blocker: Send {
    /// Asks the OS to stay awake. Called only while nothing is held.
    fn hold(&mut self) -> Result<(), String>;
    /// Gives the request back. Safe to call when nothing is held.
    fn release(&mut self);
    /// False when this machine has no way to hold a request.
    fn available(&self) -> bool {
        true
    }
}

struct Inner {
    mode: KeepAwake,
    working: bool,
    held: bool,
    /// A `hold` failed under this mode; not tried again until the mode changes.
    failed: bool,
    blocker: Box<dyn Blocker>,
}

impl Inner {
    fn view(&self) -> AwakeView {
        AwakeView {
            mode: self.mode,
            held: self.held,
            supported: !self.failed && self.blocker.available(),
        }
    }

    /// Brings the OS request in line with the mode and the working flag.
    fn reconcile(&mut self) {
        let want = wants_awake(self.mode, self.working) && !self.failed;
        if want && !self.held {
            match self.blocker.hold() {
                Ok(()) => self.held = true,
                Err(_) => self.failed = true,
            }
        } else if !want && self.held {
            self.blocker.release();
            self.held = false;
        }
    }
}

/// The keep-awake mode and the OS request that follows it.
pub struct Awake(Mutex<Inner>);

impl Awake {
    pub fn new(blocker: Box<dyn Blocker>) -> Self {
        Self(Mutex::new(Inner {
            mode: KeepAwake::Off,
            working: false,
            held: false,
            failed: false,
            blocker,
        }))
    }

    fn state(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn view(&self) -> AwakeView {
        self.state().view()
    }

    /// Takes a new mode; a changed mode may try a failed request again.
    pub fn set_mode(&self, mode: KeepAwake) -> AwakeView {
        let mut s = self.state();
        if s.mode != mode {
            s.mode = mode;
            s.failed = false;
        }
        s.reconcile();
        s.view()
    }

    /// Takes whether an agent tab is working.
    pub fn set_working(&self, working: bool) -> AwakeView {
        let mut s = self.state();
        s.working = working;
        s.reconcile();
        s.view()
    }

    /// Gives the request back for good, on exit.
    pub fn release(&self) {
        let mut s = self.state();
        if s.held {
            s.blocker.release();
            s.held = false;
        }
    }
}

impl Default for Awake {
    fn default() -> Self {
        Self::new(Box::new(Unavailable))
    }
}

impl Drop for Awake {
    fn drop(&mut self) {
        self.release();
    }
}

/// The blocker of a machine that has no way to hold a request.
struct Unavailable;

impl Blocker for Unavailable {
    fn hold(&mut self) -> Result<(), String> {
        Err("not available".to_owned())
    }
    fn release(&mut self) {}
    fn available(&self) -> bool {
        false
    }
}

#[tauri::command]
pub fn keep_awake_get(_app: AppHandle, awake: State<'_, Awake>) -> AwakeView {
    awake.view()
}

#[tauri::command(async)]
pub fn keep_awake_set(
    _app: AppHandle,
    awake: State<'_, Awake>,
    mode: KeepAwake,
) -> Result<AwakeView, CmdError> {
    Ok(awake.set_mode(mode))
}

#[tauri::command]
pub fn keep_awake_agents(_app: AppHandle, awake: State<'_, Awake>, working: bool) -> AwakeView {
    awake.set_working(working)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[derive(Default)]
    struct Counts {
        holds: AtomicU32,
        releases: AtomicU32,
    }

    struct Fake {
        counts: Arc<Counts>,
        fail: bool,
    }

    impl Blocker for Fake {
        fn hold(&mut self) -> Result<(), String> {
            self.counts.holds.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                Err("no".to_owned())
            } else {
                Ok(())
            }
        }
        fn release(&mut self) {
            self.counts.releases.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn awake(fail: bool) -> (Awake, Arc<Counts>) {
        let counts = Arc::new(Counts::default());
        let fake = Fake {
            counts: counts.clone(),
            fail,
        };
        (Awake::new(Box::new(fake)), counts)
    }

    fn n(a: &AtomicU32) -> u32 {
        a.load(Ordering::SeqCst)
    }

    #[test]
    fn wants_awake_covers_every_mode_and_working_state() {
        use KeepAwake::{Agent, Off, On};
        for (mode, working, want) in [
            (On, true, true),
            (On, false, true),
            (Agent, true, true),
            (Agent, false, false),
            (Off, true, false),
            (Off, false, false),
        ] {
            assert_eq!(wants_awake(mode, working), want, "{mode:?} {working}");
        }
    }

    #[test]
    fn on_holds_once_and_off_releases() {
        let (a, c) = awake(false);
        assert_eq!(
            a.view(),
            AwakeView {
                mode: KeepAwake::Off,
                held: false,
                supported: true
            }
        );
        assert!(a.set_mode(KeepAwake::On).held);
        assert!(a.set_mode(KeepAwake::On).held);
        assert!(a.set_working(true).held);
        assert_eq!((n(&c.holds), n(&c.releases)), (1, 0));
        assert!(!a.set_mode(KeepAwake::Off).held);
        assert_eq!((n(&c.holds), n(&c.releases)), (1, 1));
    }

    #[test]
    fn agent_mode_follows_the_working_edges() {
        let (a, c) = awake(false);
        assert!(!a.set_mode(KeepAwake::Agent).held);
        assert!(a.set_working(true).held);
        assert!(
            a.set_working(true).held,
            "a repeated report does not hold again"
        );
        assert!(!a.set_working(false).held);
        assert!(!a.set_working(false).held);
        assert!(a.set_working(true).held);
        assert_eq!((n(&c.holds), n(&c.releases)), (2, 1));
        // Leaving agent mode while held gives the request back.
        assert!(!a.set_mode(KeepAwake::Off).held);
        assert_eq!(n(&c.releases), 2);
    }

    #[test]
    fn a_working_report_before_the_mode_is_remembered() {
        let (a, c) = awake(false);
        a.set_working(true);
        assert_eq!(n(&c.holds), 0);
        assert!(a.set_mode(KeepAwake::Agent).held);
    }

    #[test]
    fn a_failing_hold_is_unsupported_and_not_retried_until_the_mode_changes() {
        let (a, c) = awake(true);
        let v = a.set_mode(KeepAwake::On);
        assert_eq!(
            v,
            AwakeView {
                mode: KeepAwake::On,
                held: false,
                supported: false
            }
        );
        a.set_working(true);
        a.set_working(false);
        a.set_mode(KeepAwake::On);
        assert_eq!(n(&c.holds), 1);
        a.set_mode(KeepAwake::Agent);
        a.set_working(true);
        assert_eq!(n(&c.holds), 2, "a changed mode tries again");
        assert_eq!(n(&c.releases), 0);
    }

    #[test]
    fn drop_and_release_give_the_request_back_once() {
        let (a, c) = awake(false);
        a.set_mode(KeepAwake::On);
        a.release();
        a.release();
        assert_eq!(n(&c.releases), 1);
        let (b, c2) = awake(false);
        b.set_mode(KeepAwake::On);
        drop(b);
        assert_eq!(n(&c2.releases), 1);
    }

    #[test]
    fn the_default_has_no_blocker_and_says_so() {
        let a = Awake::default();
        let v = a.set_mode(KeepAwake::On);
        assert!(!v.held && !v.supported);
    }
}
