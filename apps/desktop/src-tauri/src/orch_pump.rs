//! The wake pump: unread mail waits in the store, so a tab that sits idle
//! gets one line typed into it that says to run `xdev orchestration check`.
//! It points at a mailbox once per batch of new mail, never at a tab that is
//! busy, and never at one with a `check --wait` already sleeping on it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use xdev_orch::Wake;

use crate::cli_verbs::TabReport;

/// The least time between two pointers at the same mailbox.
pub const POINTER_GAP_MS: i64 = 2_000;
/// How long the pointer waits before it is typed, so a screen that just went
/// idle has drawn its prompt.
pub const WRITE_DELAY_MS: u64 = 500;

/// One line to type into `tab`, pointing at `address`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pointer {
    pub address: String,
    pub tab: String,
    /// The newest message this pointer covers.
    pub seq: i64,
    pub text: String,
}

/// Writes bytes to a tab's terminal; false when it could not.
pub type Writer = Arc<dyn Fn(&str, &[u8]) -> bool + Send + Sync>;

/// What the pump remembers: per mailbox, the newest message it pointed at and
/// when.
#[derive(Default)]
pub struct Pump {
    pointed: Mutex<HashMap<String, (i64, i64)>>,
}

fn pointer_text(unread: u32) -> String {
    let what = if unread == 1 {
        "1 unread message".to_owned()
    } else {
        format!("{unread} unread messages")
    };
    format!("[xdev] {what} for you. Run `xdev orchestration check` and handle them.")
}

fn is_idle(t: &TabReport) -> bool {
    !t.exited && (t.status == "idle" || t.status == "done")
}

impl Pump {
    /// The pointers to type now. A mailbox is pointed at when its tab is on
    /// the board and idle, nobody waits on it, it has mail newer than the last
    /// pointer, and the last pointer is at least [`POINTER_GAP_MS`] old. What is
    /// returned counts as pointed at; [`Pump::forget`] takes it back.
    pub fn plan(
        &self,
        wakes: &[Wake],
        tabs: &[TabReport],
        has_waiter: &dyn Fn(&str) -> bool,
        now_ms: i64,
    ) -> Vec<Pointer> {
        let mut pointed = self.pointed.lock().unwrap_or_else(PoisonError::into_inner);
        // A mailbox that was read has nothing to remember.
        pointed.retain(|a, _| wakes.iter().any(|w| w.address == *a));
        let mut out = Vec::new();
        for w in wakes {
            let Some(tab) = tabs.iter().find(|t| t.id == w.tab) else {
                continue;
            };
            if !is_idle(tab) || has_waiter(&w.address) {
                continue;
            }
            if let Some(&(seq, at)) = pointed.get(&w.address)
                && (w.latest_seq <= seq || now_ms - at < POINTER_GAP_MS)
            {
                continue;
            }
            pointed.insert(w.address.clone(), (w.latest_seq, now_ms));
            out.push(Pointer {
                address: w.address.clone(),
                tab: w.tab.clone(),
                seq: w.latest_seq,
                text: pointer_text(w.unread),
            });
        }
        out
    }

    /// A write failed: the mail stays unread, and the next pass may point again.
    pub fn forget(&self, p: &Pointer) {
        let mut pointed = self.pointed.lock().unwrap_or_else(PoisonError::into_inner);
        if pointed
            .get(&p.address)
            .is_some_and(|&(seq, _)| seq == p.seq)
        {
            pointed.remove(&p.address);
        }
    }

    /// Types the pointers after `delay`, on a timer thread. A failed write
    /// keeps the mail and forgets the pointer.
    pub fn deliver(
        self: &Arc<Self>,
        plans: Vec<Pointer>,
        delay: Duration,
        write: Writer,
    ) -> Option<std::thread::JoinHandle<()>> {
        if plans.is_empty() {
            return None;
        }
        let pump = Arc::clone(self);
        Some(std::thread::spawn(move || {
            std::thread::sleep(delay);
            for p in plans {
                let mut bytes = p.text.clone().into_bytes();
                bytes.push(b'\r');
                if !write(&p.tab, &bytes) {
                    pump.forget(&p);
                }
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str, status: &str, exited: bool) -> TabReport {
        TabReport {
            id: id.to_owned(),
            worktree: "/wt".to_owned(),
            title: None,
            profile: "claude".to_owned(),
            agent: true,
            status: status.to_owned(),
            last_output_ms: 0,
            exited,
        }
    }

    fn wake(address: &str, tab: &str, unread: u32, seq: i64) -> Wake {
        Wake {
            address: address.to_owned(),
            tab: tab.to_owned(),
            unread,
            latest_seq: seq,
        }
    }

    fn nobody(_: &str) -> bool {
        false
    }

    #[test]
    fn an_idle_tab_gets_one_pointer_for_its_mail() {
        let pump = Pump::default();
        let wakes = [wake("dispatch:d1", "t1", 2, 7)];
        let tabs = [tab("t1", "idle", false)];
        let got = pump.plan(&wakes, &tabs, &nobody, 10_000);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].tab, "t1");
        assert!(got[0].text.contains("2 unread messages"));
        assert!(got[0].text.contains("xdev orchestration check"));
        // The same mail is not pointed at again, however long it waits.
        assert!(pump.plan(&wakes, &tabs, &nobody, 99_000).is_empty());
    }

    #[test]
    fn a_working_tab_gets_none_until_it_goes_idle() {
        let pump = Pump::default();
        let wakes = [wake("run:r1", "t1", 1, 3)];
        let working = [tab("t1", "working", false)];
        assert!(pump.plan(&wakes, &working, &nobody, 1_000).is_empty());
        let needs = [tab("t1", "needs-you", false)];
        assert!(pump.plan(&wakes, &needs, &nobody, 2_000).is_empty());
        let done = [tab("t1", "done", false)];
        assert_eq!(pump.plan(&wakes, &done, &nobody, 3_000).len(), 1);
    }

    #[test]
    fn an_exited_or_missing_tab_or_a_waiter_means_no_pointer() {
        let pump = Pump::default();
        let wakes = [wake("dispatch:d1", "t1", 1, 3)];
        let exited = [tab("t1", "idle", true)];
        assert!(pump.plan(&wakes, &exited, &nobody, 1_000).is_empty());
        assert!(pump.plan(&wakes, &[], &nobody, 1_000).is_empty());
        let idle = [tab("t1", "idle", false)];
        let waiting = |a: &str| a == "dispatch:d1";
        assert!(pump.plan(&wakes, &idle, &waiting, 1_000).is_empty());
        // Once the waiter leaves, the mail is pointed at.
        assert_eq!(pump.plan(&wakes, &idle, &nobody, 1_100).len(), 1);
    }

    #[test]
    fn it_points_again_only_for_new_mail_and_after_two_seconds() {
        let pump = Pump::default();
        let idle = [tab("t1", "idle", false)];
        let one = [wake("dispatch:d1", "t1", 1, 3)];
        assert_eq!(pump.plan(&one, &idle, &nobody, 10_000).len(), 1);
        // New mail inside the gap waits for it.
        let two = [wake("dispatch:d1", "t1", 2, 4)];
        assert!(pump.plan(&two, &idle, &nobody, 11_999).is_empty());
        assert_eq!(pump.plan(&two, &idle, &nobody, 12_000).len(), 1);
        assert!(pump.plan(&two, &idle, &nobody, 20_000).is_empty());
    }

    #[test]
    fn a_failed_write_keeps_the_mail_and_lets_the_next_pass_point_again() {
        let pump = Arc::new(Pump::default());
        let wakes = [wake("dispatch:d1", "t1", 1, 3)];
        let idle = [tab("t1", "idle", false)];
        let plans = pump.plan(&wakes, &idle, &nobody, 1_000);
        let tries = Arc::new(Mutex::new(Vec::<(String, Vec<u8>)>::new()));
        let log = Arc::clone(&tries);
        let fail: Writer = Arc::new(move |tab, bytes| {
            log.lock().unwrap().push((tab.to_owned(), bytes.to_vec()));
            false
        });
        pump.deliver(plans, Duration::ZERO, fail)
            .unwrap()
            .join()
            .unwrap();
        let seen = tries.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "t1");
        assert_eq!(seen[0].1.last(), Some(&b'\r'));
        // Forgotten, so the next pass (the gap does not apply) points again.
        assert_eq!(pump.plan(&wakes, &idle, &nobody, 1_001).len(), 1);
    }

    #[test]
    fn nothing_to_deliver_starts_no_thread() {
        let pump = Arc::new(Pump::default());
        let w: Writer = Arc::new(|_, _| true);
        assert!(pump.deliver(Vec::new(), Duration::ZERO, w).is_none());
    }
}
