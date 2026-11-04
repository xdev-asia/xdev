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

/// The store key of the time auto-close was turned on.
const SINCE_KEY: &str = "auto_close_since_ms";

/// When auto-close was last turned on, so a worker that finished while it
/// was off keeps its tab. The time is kept in the store, so a restart with
/// the setting on does not forget it.
#[derive(Debug, Default)]
pub struct AutoClose {
    was_on: Option<bool>,
    since_ms: Option<i64>,
}

impl AutoClose {
    /// With the setting `on` at `now_ms`: none when off, else the time it
    /// was turned on (0 when it was on from the start). `load` reads the
    /// kept time (once, when the app starts); `save` keeps a new one, or
    /// forgets it (none) while the setting is off.
    pub fn since(
        &mut self,
        on: bool,
        now_ms: i64,
        load: &dyn Fn() -> Option<i64>,
        save: &dyn Fn(Option<i64>),
    ) -> Option<i64> {
        let was = self.was_on.replace(on);
        if !on {
            if was != Some(false) {
                save(None);
            }
            self.since_ms = None;
            return None;
        }
        if was == Some(false) {
            self.since_ms = Some(now_ms);
            save(Some(now_ms));
        }
        Some(*self.since_ms.get_or_insert_with(|| load().unwrap_or(0)))
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
            let state = app.state::<crate::commands::AppState>();
            let Ok(data) = crate::accounts::data_dir(&state) else {
                continue;
            };
            let has_db = data.join("orchestration.db").is_file();
            let load = || {
                if !has_db {
                    return None;
                }
                hub.with_store(data, |s| s.meta_get(SINCE_KEY))
                    .ok()
                    .flatten()
            };
            let save = |v: Option<i64>| {
                if has_db {
                    let _ = hub.with_store(data, |s| s.meta_set(SINCE_KEY, v));
                }
            };
            let Some(since) = auto.since(on, now, &load, &save) else {
                continue;
            };
            if !has_db {
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
        let kept = std::cell::Cell::new(None);
        let load = || kept.get();
        let save = |v: Option<i64>| kept.set(v);
        let mut a = AutoClose::default();
        // On from the start: every finished worker counts.
        assert_eq!(a.since(true, 1_000, &load, &save), Some(0));
        assert_eq!(a.since(true, 2_000, &load, &save), Some(0));
        assert_eq!(a.since(false, 3_000, &load, &save), None);
        assert_eq!(kept.get(), None);
        // Turned on again: only workers that finish from now on.
        assert_eq!(a.since(true, 4_000, &load, &save), Some(4_000));
        assert_eq!(a.since(true, 5_000, &load, &save), Some(4_000));
        assert_eq!(kept.get(), Some(4_000));
        // A restart with the setting still on: the kept time is read back.
        let mut b = AutoClose::default();
        assert_eq!(b.since(true, 9_000, &load, &save), Some(4_000));
        // A restart with it off forgets the time.
        let mut c = AutoClose::default();
        assert_eq!(c.since(false, 9_500, &load, &save), None);
        assert_eq!(kept.get(), None);
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
