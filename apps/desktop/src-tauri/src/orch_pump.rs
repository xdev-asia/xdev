//! The wake pump: unread mail waits in the store, so a tab that sits idle
//! gets one line typed into it that says to run `xdev orchestration check`.
//! It points at a mailbox once per batch of new mail, never at a tab that is
//! busy, and never at one with a `check --wait` already sleeping on it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use xdev_orch::{StopReason, Wake, Worker};

use crate::cli_verbs::TabReport;
use crate::orchestration::OrchHub;

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
/// when; per watched tab, how it looked last.
#[derive(Default)]
pub struct Pump {
    pointed: Mutex<HashMap<String, (i64, i64)>>,
    seen: Mutex<HashMap<String, Seen>>,
}

/// How a watched tab looked at the last pass.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Seen {
    /// `working`, `needs-you`, `done`, `idle`, `exited` or `gone`.
    state: String,
    last_output_ms: i64,
}

/// A ready worker whose tab stopped, without a `worker_done`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopEdge {
    pub dispatch: String,
    pub reason: StopReason,
    /// The tab's last output time: with the reason, what names this stop.
    pub edge_ms: i64,
    pub tab: String,
}

/// The plan's wake line; `run` names the run for a coordinator of several.
fn pointer_text(unread: u32, run: Option<&str>) -> String {
    let run = run.map(|r| format!(" --run {r}")).unwrap_or_default();
    format!("You have {unread} orchestration message(s). Run `xdev orchestration check{run}`.")
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
                text: pointer_text(w.unread, w.run.as_deref()),
            });
        }
        out
    }

    /// The stops since the last pass among `ready` workers (those with a tab):
    /// working to done or idle is `finished`, any change to needs-you is
    /// `needs_input`, and the tab exiting or leaving the board is `exited`.
    /// A tab seen for the first time only records how it looks.
    pub fn stops(&self, ready: &[Worker], tabs: &[TabReport]) -> Vec<StopEdge> {
        let mut seen = self.seen.lock().unwrap_or_else(PoisonError::into_inner);
        seen.retain(|t, _| ready.iter().any(|w| w.tab.as_deref() == Some(t)));
        let mut out = Vec::new();
        for w in ready {
            let Some(tab) = w.tab.as_deref() else {
                continue;
            };
            let now = match tabs.iter().find(|t| t.id == tab) {
                Some(t) => Seen {
                    state: if t.exited { "exited" } else { &t.status }.to_owned(),
                    last_output_ms: t.last_output_ms,
                },
                None => Seen {
                    state: "gone".to_owned(),
                    last_output_ms: seen.get(tab).map_or(0, |s| s.last_output_ms),
                },
            };
            let prev = seen.insert(tab.to_owned(), now.clone());
            let Some(prev) = prev else { continue };
            if prev.state == now.state {
                continue;
            }
            let reason = match now.state.as_str() {
                "exited" | "gone" if prev.state != "exited" && prev.state != "gone" => {
                    Some(StopReason::Exited)
                }
                "needs-you" => Some(StopReason::NeedsInput),
                "idle" | "done" if prev.state == "working" => Some(StopReason::Finished),
                _ => None,
            };
            if let Some(reason) = reason {
                out.push(StopEdge {
                    dispatch: w.dispatch_id.clone(),
                    reason,
                    edge_ms: now.last_output_ms,
                    tab: tab.to_owned(),
                });
            }
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

/// Mails the coordinator one escalation per stop. `read` gives the tab's
/// recent output (empty when it cannot be read). True when mail was written.
pub fn escalate(
    hub: &OrchHub,
    data: &std::path::Path,
    edges: &[StopEdge],
    read: &dyn Fn(&str) -> String,
    now_ms: i64,
) -> bool {
    let mut wrote = false;
    for e in edges {
        let text = read(&e.tab);
        let made = hub.with_store(data, |s| {
            s.worker_stop_notice(&e.dispatch, e.reason, &text, e.edge_ms, now_ms)
        });
        wrote |= matches!(made, Ok(Some(_)));
    }
    if wrote {
        hub.notify_mail();
    }
    wrote
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
            run: None,
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
        assert_eq!(
            got[0].text,
            "You have 2 orchestration message(s). Run `xdev orchestration check`."
        );
        // The same mail is not pointed at again, however long it waits.
        assert!(pump.plan(&wakes, &tabs, &nobody, 99_000).is_empty());
    }

    #[test]
    fn a_coordinator_of_several_runs_is_told_which_run() {
        let pump = Pump::default();
        let wakes = [Wake {
            run: Some("run_r1".to_owned()),
            ..wake("run:run_r1", "t1", 1, 3)
        }];
        let got = pump.plan(&wakes, &[tab("t1", "idle", false)], &nobody, 1_000);
        assert_eq!(
            got[0].text,
            "You have 1 orchestration message(s). Run `xdev orchestration check --run run_r1`."
        );
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

    fn worker(dispatch: &str, tab: &str) -> Worker {
        Worker {
            dispatch_id: dispatch.to_owned(),
            tab: Some(tab.to_owned()),
            worktree: "/wt".to_owned(),
            agent: "claude".to_owned(),
            state: xdev_orch::WorkerState::Ready,
            failed_stage: None,
            last_error: None,
            kept: false,
            closes_at_ms: None,
            released: false,
            created_ms: 1,
            updated_ms: 1,
        }
    }

    fn at(id: &str, status: &str, exited: bool, out: i64) -> TabReport {
        TabReport {
            last_output_ms: out,
            ..tab(id, status, exited)
        }
    }

    #[test]
    fn each_stop_reason_is_an_edge_and_a_steady_tab_is_not() {
        let pump = Pump::default();
        let ws = [worker("d1", "t1")];
        // First sight only records.
        assert!(pump.stops(&ws, &[at("t1", "working", false, 5)]).is_empty());
        assert!(pump.stops(&ws, &[at("t1", "working", false, 6)]).is_empty());
        let fin = pump.stops(&ws, &[at("t1", "idle", false, 7)]);
        assert_eq!(fin.len(), 1);
        assert_eq!(fin[0].reason, StopReason::Finished);
        assert_eq!((fin[0].edge_ms, fin[0].dispatch.as_str()), (7, "d1"));
        assert!(pump.stops(&ws, &[at("t1", "idle", false, 7)]).is_empty());
        // Idle to done is no stop; working to done is.
        assert!(pump.stops(&ws, &[at("t1", "done", false, 7)]).is_empty());
        pump.stops(&ws, &[at("t1", "working", false, 8)]);
        let done = pump.stops(&ws, &[at("t1", "done", false, 9)]);
        assert_eq!(done[0].reason, StopReason::Finished);
        // Needs you, from anywhere.
        let needs = pump.stops(&ws, &[at("t1", "needs-you", false, 10)]);
        assert_eq!(needs[0].reason, StopReason::NeedsInput);
        // Exited, once.
        let out = pump.stops(&ws, &[at("t1", "needs-you", true, 10)]);
        assert_eq!(out[0].reason, StopReason::Exited);
        assert!(
            pump.stops(&ws, &[]).is_empty(),
            "gone after exited is no new stop"
        );
    }

    #[test]
    fn a_tab_that_leaves_the_board_counts_as_exited() {
        let pump = Pump::default();
        let ws = [worker("d1", "t1")];
        pump.stops(&ws, &[at("t1", "working", false, 5)]);
        let gone = pump.stops(&ws, &[]);
        assert_eq!(gone[0].reason, StopReason::Exited);
        assert_eq!(gone[0].edge_ms, 5);
    }

    fn hub_with_ready_worker(dir: &std::path::Path) -> (OrchHub, String, String) {
        let hub = OrchHub::default();
        let (run, d) = hub
            .with_store(dir, |s| {
                let run = s.run_create("o", Some("lead"), 1)?;
                let t = s.task_create(
                    &run.id,
                    xdev_orch::NewTask {
                        title: None,
                        spec: "x".into(),
                        deps: vec![],
                        parent: None,
                    },
                    1,
                )?;
                let d = s.worker_begin(
                    &xdev_orch::StartPlan {
                        run_id: run.id.clone(),
                        task_id: t.id,
                        parent_dispatch: None,
                        depth: 1,
                        retry_of: None,
                        tab: "t1".into(),
                        worktree: "/wt".into(),
                        agent: "claude".into(),
                        kept: false,
                    },
                    1,
                )?;
                s.worker_started(&d.id, xdev_orch::StartResult::Ready, 2)?;
                Ok((run.id, d.id))
            })
            .unwrap();
        (hub, run, d)
    }

    #[test]
    fn a_stop_is_mailed_once_with_the_last_output_and_skipped_when_a_question_is_open() {
        let dir = tempfile::tempdir().unwrap();
        let (hub, run, d) = hub_with_ready_worker(dir.path());
        let edge = StopEdge {
            dispatch: d.clone(),
            reason: StopReason::Finished,
            edge_ms: 7,
            tab: "t1".to_owned(),
        };
        let read = |_: &str| "last words".to_owned();
        assert!(escalate(
            &hub,
            dir.path(),
            std::slice::from_ref(&edge),
            &read,
            10
        ));
        assert!(
            !escalate(&hub, dir.path(), std::slice::from_ref(&edge), &read, 11),
            "deduped"
        );
        let got = hub
            .with_store(dir.path(), |s| {
                s.check(&format!("run:{run}"), &xdev_orch::CheckOpts::default(), 12)
            })
            .unwrap();
        assert_eq!(got.messages.len(), 1);
        let p = got.messages[0].payload.as_ref().unwrap();
        assert_eq!(p["lastOutput"], "last words");
        assert_eq!(p["stopReason"], "finished");

        // With a pending question, a different stop is not reported.
        hub.with_store(dir.path(), |s| {
            let me = s.identity(Some("t1"), None)?;
            s.ask(&me, "which?", &[], 20).map(|_| ())
        })
        .unwrap();
        let other = StopEdge {
            reason: StopReason::NeedsInput,
            edge_ms: 30,
            ..edge
        };
        assert!(!escalate(
            &hub,
            dir.path(),
            &[other],
            &|_: &str| String::new(),
            31
        ));
    }

    #[test]
    fn nothing_to_deliver_starts_no_thread() {
        let pump = Arc::new(Pump::default());
        let w: Writer = Arc::new(|_, _| true);
        assert!(pump.deliver(Vec::new(), Duration::ZERO, w).is_none());
    }
}
