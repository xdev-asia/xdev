//! Keep the computer awake: the mode from Settings → Agents, and the OS
//! request that follows it.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::CmdError;
use crate::settings::{AgentsSettings, KeepAwake, SettingsSection};
use crate::settings_store::{self, SettingsStore};

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
        Self::new(Box::new(OsBlocker(xdev_awake::SleepBlock::new())))
    }
}

impl Drop for Awake {
    fn drop(&mut self) {
        self.release();
    }
}

/// The request of this OS (`xdev-awake`).
struct OsBlocker(xdev_awake::SleepBlock);

impl Blocker for OsBlocker {
    fn hold(&mut self) -> Result<(), String> {
        self.0.hold()
    }
    fn release(&mut self) {
        self.0.release();
    }
    fn available(&self) -> bool {
        self.0.available()
    }
}

/// The blocker of a machine that has no way to hold a request.
#[cfg(test)]
struct Unavailable;

#[cfg(test)]
impl Blocker for Unavailable {
    fn hold(&mut self) -> Result<(), String> {
        Err("not available".to_owned())
    }
    fn release(&mut self) {}
    fn available(&self) -> bool {
        false
    }
}

/// Tells every window when the view changed.
fn publish(app: &AppHandle, before: &AwakeView, now: &AwakeView) {
    if before != now {
        let _ = app.emit(CHANGED_EVENT, now.clone());
    }
}

/// Follows a stored mode: at start and after Settings → Agents is saved.
pub fn apply_mode(app: &AppHandle, mode: KeepAwake) -> AwakeView {
    let awake = app.state::<Awake>();
    let before = awake.view();
    let now = awake.set_mode(mode);
    publish(app, &before, &now);
    now
}

/// Stores `mode` in the agents settings, then follows it.
fn set_stored(
    store: &SettingsStore,
    awake: &Awake,
    mode: KeepAwake,
) -> Result<AwakeView, CmdError> {
    store
        .update(|s| s.agents.keep_awake = mode)
        .map_err(|e| CmdError {
            code: "io",
            detail: Some(e.to_string()),
        })?;
    Ok(awake.set_mode(mode))
}

/// Stores Settings → Agents, then follows its keep-awake mode: the one step `agents_settings_put` takes.
fn save_agents(
    store: &SettingsStore,
    awake: &Awake,
    agents: AgentsSettings,
) -> Result<(AgentsSettings, AwakeView), CmdError> {
    let saved = store
        .update(|s| s.agents = agents)
        .map_err(|e| CmdError {
            code: "io",
            detail: Some(e.to_string()),
        })?
        .agents;
    let now = awake.set_mode(saved.keep_awake);
    Ok((saved, now))
}

/// `save_agents` on the app's store; every window hears the save and the view when it changed.
pub fn put_agents(app: &AppHandle, agents: AgentsSettings) -> Result<AgentsSettings, CmdError> {
    let store = settings_store::store(app).ok_or(CmdError {
        code: "io",
        detail: Some("no app config folder".into()),
    })?;
    let awake = app.state::<Awake>();
    let before = awake.view();
    let (saved, now) = save_agents(&store, &awake, agents)?;
    settings_store::emit_changed(app, &[SettingsSection::Agents]);
    publish(app, &before, &now);
    Ok(saved)
}

#[tauri::command]
pub fn keep_awake_get(awake: State<'_, Awake>) -> AwakeView {
    awake.view()
}

#[tauri::command(async)]
pub fn keep_awake_set(
    app: AppHandle,
    awake: State<'_, Awake>,
    mode: KeepAwake,
) -> Result<AwakeView, CmdError> {
    let store = settings_store::store(&app).ok_or(CmdError {
        code: "io",
        detail: Some("no app config folder".into()),
    })?;
    let before = awake.view();
    let now = set_stored(&store, &awake, mode)?;
    settings_store::emit_changed(&app, &[SettingsSection::Agents]);
    publish(&app, &before, &now);
    Ok(now)
}

#[tauri::command]
pub fn keep_awake_agents(app: AppHandle, awake: State<'_, Awake>, working: bool) -> AwakeView {
    let before = awake.view();
    let now = awake.set_working(working);
    publish(&app, &before, &now);
    now
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
    fn a_machine_without_a_mechanism_says_so() {
        let a = Awake::new(Box::new(Unavailable));
        let v = a.set_mode(KeepAwake::On);
        assert!(!v.held && !v.supported);
    }

    #[test]
    fn a_set_mode_is_stored_and_followed() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().join(crate::settings::FILE_NAME));
        let (a, c) = awake(false);
        let v = set_stored(&store, &a, KeepAwake::Agent).unwrap();
        assert_eq!(v.mode, KeepAwake::Agent);
        assert_eq!(store.read().agents.keep_awake, KeepAwake::Agent);
        let v = set_stored(&store, &a, KeepAwake::On).unwrap();
        assert!(v.held);
        assert_eq!(n(&c.holds), 1);
        assert_eq!(store.read().agents.keep_awake, KeepAwake::On);
    }

    #[test]
    fn a_saved_agents_section_changes_the_mode_the_same_way() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().join(crate::settings::FILE_NAME));
        let (a, c) = awake(false);
        let agents = AgentsSettings {
            keep_awake: KeepAwake::On,
            ..Default::default()
        };
        let (saved, view) = save_agents(&store, &a, agents).unwrap();
        assert_eq!(saved.keep_awake, KeepAwake::On);
        assert_eq!(store.read().agents.keep_awake, KeepAwake::On);
        assert!(view.held);
        assert_eq!(a.view().mode, KeepAwake::On);
        assert_eq!(n(&c.holds), 1);
        // Another mode in the same section releases it.
        let (_, view) = save_agents(&store, &a, AgentsSettings::default()).unwrap();
        assert_eq!(view.mode, KeepAwake::Off);
        assert!(!view.held);
    }
}
