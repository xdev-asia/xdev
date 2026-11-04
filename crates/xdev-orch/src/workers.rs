//! Workers: the dispatch of a task to an agent in a tab, and the steps of
//! its life. Starting is split in two so the app can talk to the UI between
//! them: [`Store::worker_begin`] records the plan, [`Store::worker_started`]
//! records how the start went.

use rusqlite::{OptionalExtension, params};

use crate::error::OrchError;
use crate::model::{
    Dispatch, DispatchStatus, FailedStage, TaskStatus, Worker, WorkerReceipt, WorkerState,
};
use crate::render::{NEXT_BREAKER, NEXT_STARTED};
use crate::store::{DISPATCH_COLS, Store, WORKER_COLS, dispatch_row, enum_text, worker_row};

/// Failed starts in one `--retry-of` chain before the breaker opens.
pub const BREAKER_LIMIT: u32 = 3;

/// What a start is going to do.
#[derive(Debug, Clone)]
pub struct StartPlan {
    pub run_id: String,
    pub task_id: String,
    /// The dispatch of the worker that is starting this one, if any.
    pub parent_dispatch: Option<String>,
    pub depth: u32,
    /// The failed dispatch this one retries.
    pub retry_of: Option<String>,
    pub tab: String,
    pub worktree: String,
    pub agent: String,
    pub kept: bool,
}

/// How the start went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartResult {
    Ready,
    /// The UI did not answer in time: the tab may or may not be there.
    Unknown,
    Failed {
        stage: FailedStage,
        error: String,
    },
}

fn recovery_of(stage: FailedStage) -> &'static str {
    match stage {
        FailedStage::TerminalCreate => "The tab could not be opened. Check the worktree and retry.",
        FailedStage::SetupStart => {
            "The worktree setup did not start. Fix it, or retry with --setup skip."
        }
        FailedStage::AgentReadiness => {
            "The agent never showed its prompt. Check that it is installed and signed in, then retry."
        }
        FailedStage::SetupWait => {
            "The worktree setup did not finish in time. Retry with --setup skip, or a longer --timeout-ms."
        }
        FailedStage::DispatchInput => "The task could not be typed into the agent. Retry.",
    }
}

impl Store {
    /// One dispatch by id.
    pub fn dispatch_get(&self, id: &str) -> Result<Dispatch, OrchError> {
        self.conn
            .query_row(
                &format!("SELECT {DISPATCH_COLS} FROM dispatches WHERE id = ?1"),
                [id],
                dispatch_row,
            )
            .optional()?
            .ok_or_else(|| OrchError::not_found(format!("no worker {id}")))
    }

    /// One worker by its dispatch id.
    pub fn worker_get(&self, dispatch_id: &str) -> Result<Worker, OrchError> {
        self.conn
            .query_row(
                &format!("SELECT {WORKER_COLS} FROM workers WHERE dispatch_id = ?1"),
                [dispatch_id],
                worker_row,
            )
            .optional()?
            .ok_or_else(|| OrchError::not_found(format!("no worker {dispatch_id}")))
    }

    /// The depth a worker started by `parent` (a dispatch id) is at; 1 when a
    /// coordinator starts it.
    pub fn depth_for_child(&self, parent: Option<&str>) -> Result<u32, OrchError> {
        match parent {
            Some(d) => Ok(self.dispatch_get(d)?.depth + 1),
            None => Ok(1),
        }
    }

    /// Refuses a retry of a chain whose breaker is open or of a dispatch that
    /// is not a failure; otherwise how many starts in the chain failed.
    pub fn retry_failures(&self, retry_of: &str, run_id: &str) -> Result<u32, OrchError> {
        let prev = self.dispatch_get(retry_of)?;
        if prev.run_id != run_id {
            return Err(OrchError::bad_request(format!(
                "{retry_of} is not a worker of this run"
            )));
        }
        match prev.status {
            DispatchStatus::CircuitBroken => Err(OrchError::new(
                "circuit_broken",
                format!(
                    "{retry_of} failed to start {BREAKER_LIMIT} times; report it to the user instead of retrying"
                ),
            )),
            DispatchStatus::Failed => Ok(prev.failure_count),
            _ => Err(OrchError::new(
                "invalid_transition",
                format!("{retry_of} did not fail, so it cannot be retried"),
            )),
        }
    }

    /// Records a start: the dispatch, the worker in `starting` and the task
    /// as dispatched. The task must be ready; a failed start hands it back,
    /// a broken breaker leaves it failed.
    pub fn worker_begin(&self, plan: &StartPlan, now_ms: i64) -> Result<Dispatch, OrchError> {
        let task = self.task_get(&plan.task_id)?;
        if task.run_id != plan.run_id {
            return Err(OrchError::bad_request(format!(
                "task {} is not in run {}",
                plan.task_id, plan.run_id
            )));
        }
        let inherited = match &plan.retry_of {
            Some(prev) => self.retry_failures(prev, &plan.run_id)?,
            None => 0,
        };
        match task.status {
            TaskStatus::Ready => {}
            other => {
                return Err(OrchError::new(
                    "invalid_transition",
                    format!(
                        "task {} is {}; only a ready task can be started",
                        plan.task_id,
                        enum_text(&other)
                    ),
                ));
            }
        }
        let id = self.next_id("disp");
        self.conn.execute(
            "INSERT INTO dispatches (id, run_id, task_id, status, depth, retry_of, failure_count, parent_dispatch)
             VALUES (?1, ?2, ?3, 'dispatched', ?4, ?5, ?6, ?7)",
            params![
                id,
                plan.run_id,
                plan.task_id,
                plan.depth,
                plan.retry_of,
                inherited,
                plan.parent_dispatch
            ],
        )?;
        self.conn.execute(
            "INSERT INTO workers (dispatch_id, tab, worktree, agent, state, kept, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, 'starting', ?5, ?6, ?6)",
            params![id, plan.tab, plan.worktree, plan.agent, plan.kept, now_ms],
        )?;
        self.set_task_status(&plan.task_id, TaskStatus::Dispatched, None, now_ms)?;
        self.dispatch_get(&id)
    }

    /// Moves a worker along the transition table.
    pub fn worker_set_state(
        &self,
        dispatch_id: &str,
        to: WorkerState,
        stage: Option<FailedStage>,
        error: Option<&str>,
        now_ms: i64,
    ) -> Result<Worker, OrchError> {
        let w = self.worker_get(dispatch_id)?;
        if !w.state.can_go(to) {
            return Err(OrchError::new(
                "invalid_transition",
                format!(
                    "worker {dispatch_id} is {}; it cannot become {}",
                    enum_text(&w.state),
                    enum_text(&to)
                ),
            ));
        }
        self.conn.execute(
            "UPDATE workers SET state = ?2, failed_stage = COALESCE(?3, failed_stage),
                 last_error = COALESCE(?4, last_error), updated_ms = ?5 WHERE dispatch_id = ?1",
            params![
                dispatch_id,
                enum_text(&to),
                stage.as_ref().map(enum_text),
                error,
                now_ms
            ],
        )?;
        self.worker_get(dispatch_id)
    }

    /// Records how the start went and answers with the receipt.
    pub fn worker_started(
        &self,
        dispatch_id: &str,
        result: StartResult,
        now_ms: i64,
    ) -> Result<WorkerReceipt, OrchError> {
        let d = self.dispatch_get(dispatch_id)?;
        let handle = dispatch_id;
        let mut receipt = WorkerReceipt {
            run_id: d.run_id.clone(),
            task_id: d.task_id.clone(),
            dispatch_id: d.id.clone(),
            state: WorkerState::Starting,
            failed_stage: None,
            last_error: None,
            recovery: None,
            next_commands: Vec::new(),
            next: String::new(),
        };
        match result {
            StartResult::Ready => {
                let w = self.worker_set_state(handle, WorkerState::Ready, None, None, now_ms)?;
                receipt.state = w.state;
                receipt.next = NEXT_STARTED.to_owned();
                receipt.next_commands = vec![
                    format!("xdev orchestration worker-show --handle {handle}"),
                    "xdev orchestration check".to_owned(),
                ];
            }
            StartResult::Unknown => {
                let w =
                    self.worker_set_state(handle, WorkerState::StartUnknown, None, None, now_ms)?;
                receipt.state = w.state;
                receipt.recovery = Some(
                    "xDev did not hear back, so the tab may be open. Look at it before retrying."
                        .to_owned(),
                );
                receipt.next_commands = vec![
                    format!("xdev orchestration worker-read --handle {handle}"),
                    format!("xdev orchestration worker-stop --handle {handle}"),
                ];
                receipt.next = NEXT_STARTED.to_owned();
            }
            StartResult::Failed { stage, error } => {
                let w = self.worker_set_state(
                    handle,
                    WorkerState::Failed,
                    Some(stage),
                    Some(&error),
                    now_ms,
                )?;
                receipt.state = w.state;
                receipt.failed_stage = Some(stage);
                receipt.last_error = Some(error);
                let count = d.failure_count + 1;
                if count >= BREAKER_LIMIT {
                    self.conn.execute(
                        "UPDATE dispatches SET status = 'circuit_broken', failure_count = ?2 WHERE id = ?1",
                        params![handle, count],
                    )?;
                    self.set_task_status(&d.task_id, TaskStatus::Failed, None, now_ms)?;
                    receipt.recovery = Some(format!(
                        "{BREAKER_LIMIT} starts in a row failed at {}.",
                        enum_text(&stage)
                    ));
                    receipt.next = NEXT_BREAKER.to_owned();
                } else {
                    self.conn.execute(
                        "UPDATE dispatches SET status = 'failed', failure_count = ?2 WHERE id = ?1",
                        params![handle, count],
                    )?;
                    self.set_task_status(&d.task_id, TaskStatus::Ready, None, now_ms)?;
                    receipt.recovery = Some(recovery_of(stage).to_owned());
                    receipt.next_commands = vec![format!(
                        "xdev orchestration worker-start --task {} --retry-of {handle}",
                        d.task_id
                    )];
                }
            }
        }
        Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NewTask;
    use serde_json::json;

    fn world() -> (Store, String, String) {
        let s = Store::open_in_memory().unwrap();
        let run = s.run_create("o", Some("lead"), 1).unwrap();
        let t = s
            .task_create(
                &run.id,
                NewTask {
                    title: None,
                    spec: "do it".into(),
                    deps: vec![],
                    parent: None,
                },
                1,
            )
            .unwrap();
        (s, run.id, t.id)
    }

    fn plan(run: &str, task: &str, retry_of: Option<&str>) -> StartPlan {
        StartPlan {
            run_id: run.to_owned(),
            task_id: task.to_owned(),
            parent_dispatch: None,
            depth: 1,
            retry_of: retry_of.map(str::to_owned),
            tab: "tab_x".to_owned(),
            worktree: "/wt/a".to_owned(),
            agent: "claude".to_owned(),
            kept: false,
        }
    }

    fn fail(stage: FailedStage) -> StartResult {
        StartResult::Failed {
            stage,
            error: "boom".to_owned(),
        }
    }

    #[test]
    fn a_ready_start_records_dispatch_worker_and_task() {
        let (s, run, task) = world();
        let d = s.worker_begin(&plan(&run, &task, None), 5).unwrap();
        assert_eq!(d.status, DispatchStatus::Dispatched);
        assert_eq!(d.depth, 1);
        assert_eq!(s.worker_get(&d.id).unwrap().state, WorkerState::Starting);
        assert_eq!(s.task_get(&task).unwrap().status, TaskStatus::Dispatched);
        // The task is taken: it cannot be started twice.
        let again = s.worker_begin(&plan(&run, &task, None), 6);
        assert_eq!(again.unwrap_err().code, "invalid_transition");

        let r = s.worker_started(&d.id, StartResult::Ready, 7).unwrap();
        assert_eq!(r.state, WorkerState::Ready);
        assert_eq!(r.next, NEXT_STARTED);
        // The receipt, as the agent reads it.
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({
                "runId": run,
                "taskId": task,
                "dispatchId": d.id,
                "state": "ready",
                "failedStage": null,
                "lastError": null,
                "recovery": null,
                "nextCommands": [
                    format!("xdev orchestration worker-show --handle {}", d.id),
                    "xdev orchestration check"
                ],
                "next": NEXT_STARTED,
            })
        );
    }

    #[test]
    fn a_failed_start_names_its_stage_and_hands_the_task_back() {
        let (s, run, task) = world();
        let d = s.worker_begin(&plan(&run, &task, None), 5).unwrap();
        let r = s
            .worker_started(&d.id, fail(FailedStage::AgentReadiness), 6)
            .unwrap();
        assert_eq!(r.state, WorkerState::Failed);
        assert_eq!(r.failed_stage, Some(FailedStage::AgentReadiness));
        assert_eq!(r.last_error.as_deref(), Some("boom"));
        assert!(r.recovery.unwrap().contains("agent"));
        assert_eq!(r.next_commands.len(), 1);
        assert!(r.next_commands[0].contains(&format!("--retry-of {}", d.id)));
        assert_eq!(
            s.dispatch_get(&d.id).unwrap().status,
            DispatchStatus::Failed
        );
        assert_eq!(s.task_get(&task).unwrap().status, TaskStatus::Ready);
    }

    #[test]
    fn an_unanswered_start_is_unknown_and_keeps_the_task_dispatched() {
        let (s, run, task) = world();
        let d = s.worker_begin(&plan(&run, &task, None), 5).unwrap();
        let r = s.worker_started(&d.id, StartResult::Unknown, 6).unwrap();
        assert_eq!(r.state, WorkerState::StartUnknown);
        assert!(r.recovery.is_some());
        assert_eq!(s.task_get(&task).unwrap().status, TaskStatus::Dispatched);
    }

    #[test]
    fn the_third_failed_start_in_a_retry_chain_opens_the_breaker() {
        let (s, run, task) = world();
        let mut prev: Option<String> = None;
        for n in 1..=3 {
            let d = s
                .worker_begin(&plan(&run, &task, prev.as_deref()), n)
                .unwrap();
            let r = s
                .worker_started(&d.id, fail(FailedStage::TerminalCreate), n)
                .unwrap();
            if n < 3 {
                assert_eq!(s.dispatch_get(&d.id).unwrap().failure_count, n as u32);
                assert_ne!(r.next, NEXT_BREAKER);
            } else {
                assert_eq!(r.next, NEXT_BREAKER);
                assert!(r.next_commands.is_empty());
                assert_eq!(
                    s.dispatch_get(&d.id).unwrap().status,
                    DispatchStatus::CircuitBroken
                );
                assert_eq!(s.task_get(&task).unwrap().status, TaskStatus::Failed);
            }
            prev = Some(d.id);
        }
        // The chain is closed: no retry of the broken one.
        let e = s.worker_begin(&plan(&run, &task, prev.as_deref()), 9);
        assert_eq!(e.unwrap_err().code, "circuit_broken");
    }

    #[test]
    fn a_retry_needs_a_failed_dispatch_of_the_same_run() {
        let (s, run, task) = world();
        let d = s.worker_begin(&plan(&run, &task, None), 1).unwrap();
        let live = s.worker_begin(&plan(&run, &task, Some(&d.id)), 2);
        assert_eq!(live.unwrap_err().code, "invalid_transition");
        let ghost = s.worker_begin(&plan(&run, &task, Some("disp_nope")), 2);
        assert_eq!(ghost.unwrap_err().code, "not_found");
    }

    #[test]
    fn depth_counts_from_the_starting_workers_dispatch() {
        let (s, run, task) = world();
        assert_eq!(s.depth_for_child(None).unwrap(), 1);
        let d = s.worker_begin(&plan(&run, &task, None), 1).unwrap();
        assert_eq!(s.depth_for_child(Some(&d.id)).unwrap(), 2);
        assert_eq!(
            s.depth_for_child(Some("nope")).unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn states_move_only_along_the_table() {
        let (s, run, task) = world();
        let d = s.worker_begin(&plan(&run, &task, None), 1).unwrap();
        s.worker_set_state(&d.id, WorkerState::Ready, None, None, 2)
            .unwrap();
        let bad = s.worker_set_state(&d.id, WorkerState::Starting, None, None, 3);
        assert_eq!(bad.unwrap_err().code, "invalid_transition");
        s.worker_set_state(&d.id, WorkerState::Succeeded, None, None, 4)
            .unwrap();
        let out = s.worker_set_state(&d.id, WorkerState::Ready, None, None, 5);
        assert_eq!(out.unwrap_err().code, "invalid_transition");
    }
}
