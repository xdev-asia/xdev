//! Runs: a namespace for tasks, workers and mail. A tab has one current run.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::error::OrchError;
use crate::model::{Run, Task, Worker};
use crate::store::{RUN_COLS, Store, TASK_COLS, WORKER_COLS, run_row, task_row, worker_row};

/// A run with what it holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run: Run,
    pub tasks: Vec<Task>,
    pub workers: Vec<Worker>,
    pub open_gates: u32,
}

impl Store {
    /// Creates a run. The creating tab becomes its coordinator and its current run.
    pub fn run_create(
        &self,
        objective: &str,
        tab: Option<&str>,
        now_ms: i64,
    ) -> Result<Run, OrchError> {
        let id = self.next_id("run");
        self.conn.execute(
            "INSERT INTO runs (id, objective, coordinator_tab, created_ms) VALUES (?1, ?2, ?3, ?4)",
            params![id, objective, tab, now_ms],
        )?;
        if let Some(tab) = tab {
            self.run_use(tab, &id)?;
        }
        self.run_get(&id)
    }

    /// One run by id.
    pub fn run_get(&self, id: &str) -> Result<Run, OrchError> {
        self.conn
            .query_row(
                &format!("SELECT {RUN_COLS} FROM runs WHERE id = ?1"),
                [id],
                run_row,
            )
            .optional()?
            .ok_or_else(|| OrchError::not_found(format!("no run {id}")))
    }

    /// Makes `run_id` the current run of `tab`.
    pub fn run_use(&self, tab: &str, run_id: &str) -> Result<Run, OrchError> {
        let run = self.run_get(run_id)?;
        self.conn.execute(
            "INSERT INTO tab_runs (tab, run_id) VALUES (?1, ?2)
             ON CONFLICT(tab) DO UPDATE SET run_id = excluded.run_id",
            params![tab, run_id],
        )?;
        Ok(run)
    }

    /// The run `tab` works in; without a tab (or a choice) the only run, else `no_run`.
    pub fn run_current(&self, tab: Option<&str>) -> Result<Run, OrchError> {
        if let Some(tab) = tab {
            let run: Option<Run> = self
                .conn
                .query_row(
                    &format!(
                        "SELECT {RUN_COLS} FROM runs WHERE id = (SELECT run_id FROM tab_runs WHERE tab = ?1)"
                    ),
                    [tab],
                    run_row,
                )
                .optional()?;
            if let Some(run) = run {
                return Ok(run);
            }
        }
        let runs = self.run_list()?;
        match runs.as_slice() {
            [only] => Ok(only.clone()),
            [] => Err(OrchError::new(
                "no_run",
                "there is no run; create one first",
            )),
            _ => Err(OrchError::new(
                "no_run",
                "no current run for this tab; pass --run <id> or run-use",
            )),
        }
    }

    /// Resolves an explicit `--run` (when given) or the current run.
    pub fn run_resolve(&self, run: Option<&str>, tab: Option<&str>) -> Result<Run, OrchError> {
        match run {
            Some(id) => self.run_get(id),
            None => self.run_current(tab),
        }
    }

    /// Every run, oldest first.
    pub fn run_list(&self) -> Result<Vec<Run>, OrchError> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {RUN_COLS} FROM runs ORDER BY created_ms, rowid"
        ))?;
        let rows = st.query_map([], run_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// A run with its tasks, workers and the count of open gates.
    pub fn run_show(&self, id: &str) -> Result<RunDetail, OrchError> {
        let run = self.run_get(id)?;
        let mut st = self.conn.prepare(&format!(
            "SELECT {TASK_COLS} FROM tasks WHERE run_id = ?1 ORDER BY created_ms, rowid"
        ))?;
        let tasks = st
            .query_map([id], task_row)?
            .collect::<Result<Vec<_>, _>>()?;
        let cols = WORKER_COLS
            .split(", ")
            .map(|c| format!("w.{c}"))
            .collect::<Vec<_>>()
            .join(", ");
        let mut st = self.conn.prepare(&format!(
            "SELECT {cols} FROM workers w JOIN dispatches d ON d.id = w.dispatch_id
             WHERE d.run_id = ?1 ORDER BY w.created_ms, w.rowid"
        ))?;
        let workers = st
            .query_map([id], worker_row)?
            .collect::<Result<Vec<_>, _>>()?;
        let open_gates: u32 = self.conn.query_row(
            "SELECT COUNT(*) FROM gates WHERE run_id = ?1 AND status = 'pending'",
            [id],
            |r| r.get(0),
        )?;
        Ok(RunDetail {
            run,
            tasks,
            workers,
            open_gates,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creating_a_run_makes_the_tab_its_coordinator_and_current() {
        let s = Store::open_in_memory().unwrap();
        let run = s.run_create("ship it", Some("tab1"), 10).unwrap();
        assert_eq!(run.coordinator_tab.as_deref(), Some("tab1"));
        assert_eq!(run.objective, "ship it");
        assert!(run.id.starts_with("run_"));
        assert_eq!(s.run_current(Some("tab1")).unwrap(), run);
    }

    #[test]
    fn current_falls_back_to_the_only_run_and_else_is_no_run() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.run_current(Some("t")).unwrap_err().code, "no_run");
        let a = s.run_create("a", None, 1).unwrap();
        assert_eq!(s.run_current(Some("other")).unwrap(), a);
        assert_eq!(s.run_current(None).unwrap(), a);
        s.run_create("b", None, 2).unwrap();
        assert_eq!(s.run_current(Some("other")).unwrap_err().code, "no_run");
    }

    #[test]
    fn use_switches_the_current_run_of_a_tab() {
        let s = Store::open_in_memory().unwrap();
        let a = s.run_create("a", Some("t"), 1).unwrap();
        let b = s.run_create("b", Some("u"), 2).unwrap();
        assert_eq!(s.run_current(Some("t")).unwrap(), a);
        s.run_use("t", &b.id).unwrap();
        assert_eq!(s.run_current(Some("t")).unwrap(), b);
        assert_eq!(s.run_use("t", "run_nope").unwrap_err().code, "not_found");
    }

    #[test]
    fn list_is_oldest_first_and_resolve_prefers_the_explicit_run() {
        let s = Store::open_in_memory().unwrap();
        let a = s.run_create("a", Some("t"), 1).unwrap();
        let b = s.run_create("b", Some("t"), 2).unwrap();
        let ids: Vec<_> = s.run_list().unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![a.id.clone(), b.id.clone()]);
        assert_eq!(s.run_resolve(Some(&a.id), Some("t")).unwrap(), a);
        assert_eq!(s.run_resolve(None, Some("t")).unwrap(), b);
    }

    #[test]
    fn show_counts_tasks_workers_and_open_gates() {
        let s = Store::open_in_memory().unwrap();
        let run = s.run_create("a", Some("t"), 1).unwrap();
        s.conn
            .execute_batch(&format!(
                "INSERT INTO tasks (id, run_id, spec, status, created_ms, updated_ms)
                   VALUES ('task_1', '{r}', 's', 'ready', 1, 1);
                 INSERT INTO dispatches (id, run_id, task_id, status) VALUES ('disp_1', '{r}', 'task_1', 'dispatched');
                 INSERT INTO workers (dispatch_id, worktree, agent, state, created_ms, updated_ms)
                   VALUES ('disp_1', 'w', 'claude', 'ready', 1, 1);
                 INSERT INTO gates (id, run_id, task_id, question, status, created_ms)
                   VALUES ('gate_1', '{r}', 'task_1', 'q', 'pending', 1),
                          ('gate_2', '{r}', 'task_1', 'q', 'resolved', 1);",
                r = run.id
            ))
            .unwrap();
        let d = s.run_show(&run.id).unwrap();
        assert_eq!(d.tasks.len(), 1);
        assert_eq!(d.workers.len(), 1);
        assert_eq!(d.open_gates, 1);
        assert_eq!(s.run_show("run_x").unwrap_err().code, "not_found");
    }
}
