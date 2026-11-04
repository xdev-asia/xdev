//! The auto-close sweeper: once a worker is finished, its tab closes after a
//! quiet spell, unless it is kept, busy again, or the setting is off.

use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use crate::cli_verbs::TabReport;
use crate::orchestration::{OrchHub, WorkerChanged, WorkerClose};

/// How often the sweeper looks.
pub const TICK: Duration = Duration::from_secs(1);

/// When auto-close was last turned on, so a worker that finished while it
/// was off keeps its tab.
#[derive(Debug, Default)]
pub struct AutoClose {
    was_on: Option<bool>,
    since_ms: i64,
}

impl AutoClose {
    /// With the setting `on` at `now_ms`: none when off, else the time it
    /// was turned on (0 when it was on from the start).
    pub fn since(&mut self, on: bool, now_ms: i64) -> Option<i64> {
        if on && self.was_on == Some(false) {
            self.since_ms = now_ms;
        }
        self.was_on = Some(on);
        on.then_some(self.since_ms)
    }
}

/// One pass over workers that finished from `since_ms` on. `emit` sends the UI its events: `close-worker` for a tab that is
/// due, `worker-changed` for every strip that changed. How many tabs it asked
/// to close.
pub fn sweep_once(
    hub: &OrchHub,
    data: &Path,
    since_ms: i64,
    tabs: &[TabReport],
    now_ms: i64,
    emit: &dyn Fn(&str, Value),
) -> usize {
    let status_of = |tab: &str| {
        tabs.iter().find(|t| t.id == tab).map(|t| {
            if t.exited {
                "exited".to_owned()
            } else {
                t.status.clone()
            }
        })
    };
    let Ok(swept) = hub.with_store(data, |s| s.worker_sweep(&status_of, since_ms, now_ms)) else {
        return 0;
    };
    let mut closed = 0;
    for w in swept {
        if w.close {
            closed += 1;
            if let Ok(p) = serde_json::to_value(WorkerClose {
                dispatch: w.dispatch.clone(),
                tab: w.tab.clone(),
            }) {
                emit("orchestration://close-worker", p);
            }
        }
        if let Ok(p) = serde_json::to_value(WorkerChanged { tab: w.tab }) {
            emit("orchestration://worker-changed", p);
        }
    }
    closed
}

/// Starts the sweeper thread; it ticks every second while the setting is on.
/// The setting is read once and then kept fresh by the settings command.
pub fn start(app: AppHandle) {
    use tauri::{Emitter, Manager};
    std::thread::spawn(move || {
        let mut auto = AutoClose::default();
        loop {
            std::thread::sleep(TICK);
            let hub = app.state::<OrchHub>();
            let on = hub.auto_close(|| {
                crate::settings_store::read(&app)
                    .orchestration
                    .worker_auto_close
            });
            let now = crate::workspace::clock().0;
            let Some(since) = auto.since(on, now) else {
                continue;
            };
            let state = app.state::<crate::commands::AppState>();
            let Ok(data) = crate::accounts::data_dir(&state) else {
                continue;
            };
            if !data.join("orchestration.db").is_file() {
                continue;
            }
            let board = app.state::<crate::cli_verbs::CliHub>();
            let (tabs, _) = board.board.tabs();
            let emit = |event: &str, payload: Value| {
                let _ = app.emit(event, payload);
            };
            sweep_once(&hub, data, since, &tabs, now, &emit);
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn tab(id: &str, status: &str) -> TabReport {
        TabReport {
            id: id.to_owned(),
            worktree: "/wt".to_owned(),
            title: None,
            profile: "claude".to_owned(),
            agent: true,
            status: status.to_owned(),
            last_output_ms: 0,
            exited: false,
        }
    }

    #[test]
    fn auto_close_counts_from_when_it_was_turned_on() {
        let mut a = AutoClose::default();
        // On from the start: every finished worker counts.
        assert_eq!(a.since(true, 1_000), Some(0));
        assert_eq!(a.since(true, 2_000), Some(0));
        assert_eq!(a.since(false, 3_000), None);
        // Turned on again: only workers that finish from now on.
        assert_eq!(a.since(true, 4_000), Some(4_000));
        assert_eq!(a.since(true, 5_000), Some(4_000));
    }

    #[test]
    fn a_finished_workers_tab_closes_after_the_quiet_spell_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let hub = OrchHub::default();
        let d = hub
            .with_store(dir.path(), |s| {
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
                s.worker_settle(&d.id, xdev_orch::WorkerState::Succeeded, None, true, 1_000)?;
                Ok(d.id)
            })
            .unwrap();
        let events = Mutex::new(Vec::<(String, Value)>::new());
        let emit = |e: &str, p: Value| events.lock().unwrap().push((e.to_owned(), p));
        let idle = [tab("t1", "idle")];
        let due = 1_000 + xdev_orch::CLOSE_AFTER_MS;
        assert_eq!(sweep_once(&hub, dir.path(), 0, &idle, due - 1, &emit), 0);
        assert!(events.lock().unwrap().is_empty());
        // Working again cancels; the strip is told.
        let busy = [tab("t1", "working")];
        sweep_once(&hub, dir.path(), 0, &busy, due - 1, &emit);
        assert_eq!(
            events.lock().unwrap()[0].0,
            "orchestration://worker-changed"
        );
        // Quiet, then due.
        sweep_once(&hub, dir.path(), 0, &idle, 5_000, &emit);
        let n = sweep_once(
            &hub,
            dir.path(),
            0,
            &idle,
            5_000 + xdev_orch::CLOSE_AFTER_MS,
            &emit,
        );
        assert_eq!(n, 1);
        let seen = events.lock().unwrap().clone();
        let close = seen
            .iter()
            .find(|(e, _)| e == "orchestration://close-worker")
            .unwrap();
        assert_eq!(close.1["dispatch"], d);
        assert_eq!(close.1["tab"], "t1");
        // Released once the tab has left the board; never again.
        let gone = 5_000 + xdev_orch::CLOSE_AFTER_MS + 1;
        assert_eq!(sweep_once(&hub, dir.path(), 0, &[], gone, &emit), 0);
        let released = hub
            .with_store(dir.path(), |s| s.worker_get(&d))
            .unwrap()
            .released;
        assert!(released);
        assert_eq!(sweep_once(&hub, dir.path(), 0, &idle, 99_999_999, &emit), 0);
    }
}
