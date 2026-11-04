//! Workers: the dispatch of a task to an agent in a tab, and the steps of
//! its life. Starting is split in two so the app can talk to the UI between
//! them: [`Store::worker_begin`] records the plan, [`Store::worker_started`]
//! records how the start went.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::error::OrchError;
use crate::mail::NewMessage;
use crate::model::{
    Dispatch, DispatchStatus, FailedStage, MessageType, Priority, StopReason, TaskStatus, Worker,
    WorkerReceipt, WorkerState,
};
use crate::render::{NEXT_BREAKER, NEXT_STARTED};
use crate::store::{DISPATCH_COLS, Store, WORKER_COLS, dispatch_row, enum_text, worker_row};

/// Failed starts in one `--retry-of` chain before the breaker opens.
pub const BREAKER_LIMIT: u32 = 3;

/// What one sweep did to a worker's tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Swept {
    pub dispatch: String,
    pub tab: String,
    /// Close the tab now. The worker is marked released once its tab has
    /// left the board; until then it is asked again every [`CLOSE_RETRY_MS`].
    pub close: bool,
}

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

    /// Refuses a retry of a chain whose breaker is open, of a dispatch that
    /// is not a failure, or of one that was already retried; otherwise how
    /// many starts of its task failed.
    pub fn retry_failures(&self, retry_of: &str, run_id: &str) -> Result<u32, OrchError> {
        let prev = self.dispatch_get(retry_of)?;
        if prev.run_id != run_id {
            return Err(OrchError::bad_request(format!(
                "{retry_of} is not a worker of this run"
            )));
        }
        match prev.status {
            DispatchStatus::CircuitBroken => return Err(broken(retry_of)),
            DispatchStatus::Failed => {}
            _ => {
                return Err(OrchError::new(
                    "invalid_transition",
                    format!("{retry_of} did not fail, so it cannot be retried"),
                ));
            }
        }
        let next: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM dispatches WHERE retry_of = ?1 ORDER BY rowid LIMIT 1",
                [retry_of],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(next) = next {
            return Err(OrchError::new(
                "invalid_transition",
                format!("{retry_of} was already retried as {next}; retry the newest attempt"),
            ));
        }
        self.start_failures(&prev.task_id)
    }

    /// How many starts of `task_id` failed, however they were started.
    fn start_failures(&self, task_id: &str) -> Result<u32, OrchError> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM dispatches d JOIN workers w ON w.dispatch_id = d.id
             WHERE d.task_id = ?1 AND w.failed_stage IS NOT NULL",
            [task_id],
            |r| r.get(0),
        )?)
    }

    /// Records a start: the dispatch, the worker in `starting` and the task
    /// as dispatched. The task must be ready; a failed start hands it back,
    /// a broken breaker leaves it failed.
    pub fn worker_begin(&self, plan: &StartPlan, now_ms: i64) -> Result<Dispatch, OrchError> {
        self.atomic(|s| s.worker_begin_unit(plan, now_ms))
    }

    /// One unit of [`Store::worker_begin`].
    fn worker_begin_unit(&self, plan: &StartPlan, now_ms: i64) -> Result<Dispatch, OrchError> {
        let task = self.task_get(&plan.task_id)?;
        if task.run_id != plan.run_id {
            return Err(OrchError::bad_request(format!(
                "task {} is not in run {}",
                plan.task_id, plan.run_id
            )));
        }
        if let Some(prev) = &plan.retry_of {
            self.retry_failures(prev, &plan.run_id)?;
        }
        // Failures count per task, so a start without --retry-of, or of an
        // older attempt, does not reset the breaker.
        let inherited = self.start_failures(&plan.task_id)?;
        if inherited >= BREAKER_LIMIT {
            return Err(broken(&plan.task_id));
        }
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
        self.atomic(|s| s.worker_started_unit(dispatch_id, result, now_ms))
    }

    /// One unit of [`Store::worker_started`].
    fn worker_started_unit(
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

fn broken(what: &str) -> OrchError {
    OrchError::new(
        "circuit_broken",
        format!(
            "{what} failed to start {BREAKER_LIMIT} times; report it to the user instead of retrying"
        ),
    )
}

/// How long a finished worker's tab stays before it closes.
pub const CLOSE_AFTER_MS: i64 = 120_000;

/// How long a tab asked to close may stay on the board before it is asked
/// again.
pub const CLOSE_RETRY_MS: i64 = 10_000;

/// A worker with its dispatch and the state of its task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerView {
    pub dispatch: Dispatch,
    pub worker: Worker,
    pub task_title: Option<String>,
    pub task_status: TaskStatus,
}

impl Store {
    /// One worker with its dispatch and task.
    pub fn worker_view(&self, dispatch_id: &str) -> Result<WorkerView, OrchError> {
        let dispatch = self.dispatch_get(dispatch_id)?;
        let worker = self.worker_get(dispatch_id)?;
        let task = self.task_get(&dispatch.task_id)?;
        Ok(WorkerView {
            dispatch,
            worker,
            task_title: task.title,
            task_status: task.status,
        })
    }

    /// The workers of a run, oldest first.
    pub fn worker_list(
        &self,
        run_id: &str,
        state: Option<WorkerState>,
    ) -> Result<Vec<WorkerView>, OrchError> {
        let ids: Vec<String> = {
            let mut st = self.conn.prepare(
                "SELECT d.id FROM dispatches d JOIN workers w ON w.dispatch_id = d.id
                 WHERE d.run_id = ?1 ORDER BY w.created_ms, w.rowid",
            )?;
            st.query_map([run_id], |r| r.get(0))?
                .collect::<Result<_, _>>()?
        };
        let mut out = Vec::new();
        for id in ids {
            let v = self.worker_view(&id)?;
            if state.is_none_or(|s| v.worker.state == s) {
                out.push(v);
            }
        }
        Ok(out)
    }

    /// Settles a worker that reported `worker_done` (or was released): its
    /// state, dispatch and task follow `outcome` (`Succeeded` or `Failed`),
    /// the tasks that waited on it are promoted and the tab gets its closing
    /// time. A worker already settled is left as it is.
    pub fn worker_settle(
        &self,
        dispatch_id: &str,
        outcome: WorkerState,
        result: Option<&str>,
        auto_close: bool,
        now_ms: i64,
    ) -> Result<Worker, OrchError> {
        self.atomic(|s| s.worker_settle_unit(dispatch_id, outcome, result, auto_close, now_ms))
    }

    /// One unit of [`Store::worker_settle`].
    fn worker_settle_unit(
        &self,
        dispatch_id: &str,
        outcome: WorkerState,
        result: Option<&str>,
        auto_close: bool,
        now_ms: i64,
    ) -> Result<Worker, OrchError> {
        if !matches!(outcome, WorkerState::Succeeded | WorkerState::Failed) {
            return Err(OrchError::bad_request("an outcome is succeeded or failed"));
        }
        let w = self.worker_get(dispatch_id)?;
        if w.state.is_terminal() {
            return Ok(w);
        }
        // A worker may report before the app has recorded its start.
        if matches!(w.state, WorkerState::Starting | WorkerState::StartUnknown) {
            self.worker_set_state(dispatch_id, WorkerState::Ready, None, None, now_ms)?;
        }
        self.worker_set_state(dispatch_id, outcome, None, None, now_ms)?;
        let ok = outcome == WorkerState::Succeeded;
        let d = self.dispatch_get(dispatch_id)?;
        self.conn.execute(
            "UPDATE dispatches SET status = ?2 WHERE id = ?1",
            params![dispatch_id, if ok { "completed" } else { "failed" }],
        )?;
        self.set_task_status(
            &d.task_id,
            if ok {
                TaskStatus::Completed
            } else {
                TaskStatus::Failed
            },
            result,
            now_ms,
        )?;
        self.promote_dependants(&d.run_id, now_ms)?;
        let closes = (auto_close && !w.kept).then_some(now_ms + CLOSE_AFTER_MS);
        self.worker_set_closes_at(dispatch_id, closes, now_ms)?;
        self.worker_get(dispatch_id)
    }

    /// When a finished worker's tab closes; none: not scheduled.
    pub fn worker_set_closes_at(
        &self,
        dispatch_id: &str,
        at: Option<i64>,
        now_ms: i64,
    ) -> Result<(), OrchError> {
        self.conn.execute(
            "UPDATE workers SET closes_at_ms = ?2, updated_ms = ?3 WHERE dispatch_id = ?1",
            params![dispatch_id, at, now_ms],
        )?;
        Ok(())
    }

    /// Marks a worker's tab as closed by xDev.
    pub fn worker_mark_released(&self, dispatch_id: &str, now_ms: i64) -> Result<(), OrchError> {
        self.conn.execute(
            "UPDATE workers SET released = 1, updated_ms = ?2 WHERE dispatch_id = ?1",
            params![dispatch_id, now_ms],
        )?;
        Ok(())
    }

    /// Keeps a worker's tab open, or lets it close again. Keeping cancels a
    /// closing time that was set.
    pub fn worker_set_kept(
        &self,
        dispatch_id: &str,
        kept: bool,
        now_ms: i64,
    ) -> Result<Worker, OrchError> {
        self.worker_get(dispatch_id)?;
        self.conn.execute(
            "UPDATE workers SET kept = ?2,
                 closes_at_ms = CASE WHEN ?2 THEN NULL ELSE closes_at_ms END,
                 updated_ms = ?3 WHERE dispatch_id = ?1",
            params![dispatch_id, kept, now_ms],
        )?;
        self.worker_get(dispatch_id)
    }

    /// Starts stopping a worker: refused while its tab is kept. A worker
    /// already stopping (or whose stop was unknown) is returned as it is, so
    /// a second `stop` asks the tab to close again.
    pub fn worker_stop_begin(&self, dispatch_id: &str, now_ms: i64) -> Result<Worker, OrchError> {
        let w = self.worker_get(dispatch_id)?;
        if w.kept {
            return Err(OrchError::new(
                "worker_kept",
                format!("the tab of {dispatch_id} is kept open; undo that with keep-open --off"),
            ));
        }
        if matches!(w.state, WorkerState::Stopping | WorkerState::StopUnknown) {
            return Ok(w);
        }
        self.worker_set_state(dispatch_id, WorkerState::Stopping, None, None, now_ms)
    }

    /// Records whether the tab went away: `stopped` hands the task back, not
    /// stopped leaves the stop unknown.
    pub fn worker_stop_end(
        &self,
        dispatch_id: &str,
        stopped: bool,
        now_ms: i64,
    ) -> Result<Worker, OrchError> {
        let w = self.worker_get(dispatch_id)?;
        if stopped {
            let w = self.worker_set_state(dispatch_id, WorkerState::Stopped, None, None, now_ms)?;
            self.give_task_back(dispatch_id, now_ms)?;
            Ok(w)
        } else if w.state == WorkerState::StopUnknown {
            Ok(w)
        } else {
            self.worker_set_state(dispatch_id, WorkerState::StopUnknown, None, None, now_ms)
        }
    }

    /// Forgets a worker without touching its tab; the task is open again.
    pub fn worker_abandon(&self, dispatch_id: &str, now_ms: i64) -> Result<Worker, OrchError> {
        let w = self.worker_set_state(dispatch_id, WorkerState::Abandoned, None, None, now_ms)?;
        self.give_task_back(dispatch_id, now_ms)?;
        Ok(w)
    }

    /// One pass of the auto-close sweeper over finished workers (succeeded or
    /// failed) that are not kept and not released and whose tab is on the
    /// board; `status_of` gives a tab's status, none when it is off the board.
    /// A busy tab (`working`, `needs-you`) cancels its countdown; a quiet one
    /// starts it ([`CLOSE_AFTER_MS`]); one whose time has come is reported
    /// with `close`. A tab asked to close is marked released once it has left
    /// the board, and asked again while it stays ([`CLOSE_RETRY_MS`]). Only
    /// the workers that changed.
    pub fn worker_sweep(
        &self,
        status_of: &dyn Fn(&str) -> Option<String>,
        since_ms: i64,
        now_ms: i64,
    ) -> Result<Vec<Swept>, OrchError> {
        // A worker with no countdown that last changed before auto-close was
        // turned on (`since_ms`) finished while it was off: it stays open.
        let mut st = self.conn.prepare(&format!(
            "SELECT {WORKER_COLS}, close_asked_ms FROM workers
             WHERE state IN ('succeeded', 'failed') AND kept = 0 AND released = 0
               AND tab IS NOT NULL AND (closes_at_ms IS NOT NULL OR updated_ms >= ?1)
             ORDER BY created_ms, rowid"
        ))?;
        let workers = st
            .query_map([since_ms], |r| {
                Ok((worker_row(r)?, r.get::<_, Option<i64>>(12)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut out = Vec::new();
        for (w, asked) in workers {
            let Some(tab) = w.tab.clone() else { continue };
            let status = status_of(&tab);
            let close = match (asked, status) {
                // Asked and gone: the close went through.
                (Some(_), None) => {
                    self.worker_mark_released(&w.dispatch_id, now_ms)?;
                    false
                }
                // Asked and still there: ask again once the gap has passed.
                (Some(at), Some(_)) if now_ms >= at + CLOSE_RETRY_MS => {
                    self.worker_close_asked(&w.dispatch_id, now_ms)?;
                    true
                }
                (Some(_), Some(_)) | (None, None) => continue,
                (None, Some(status)) => {
                    let busy = status == "working" || status == "needs-you";
                    match (busy, w.closes_at_ms) {
                        (true, Some(_)) => {
                            self.worker_set_closes_at(&w.dispatch_id, None, now_ms)?;
                            false
                        }
                        (true, None) => continue,
                        (false, None) => {
                            let at = now_ms + CLOSE_AFTER_MS;
                            self.worker_set_closes_at(&w.dispatch_id, Some(at), now_ms)?;
                            false
                        }
                        (false, Some(at)) if now_ms >= at => {
                            self.worker_close_asked(&w.dispatch_id, now_ms)?;
                            true
                        }
                        (false, Some(_)) => continue,
                    }
                }
            };
            out.push(Swept {
                dispatch: w.dispatch_id,
                tab,
                close,
            });
        }
        Ok(out)
    }

    /// Records that the tab of a worker was asked to close at `now_ms`.
    fn worker_close_asked(&self, dispatch_id: &str, now_ms: i64) -> Result<(), OrchError> {
        self.conn.execute(
            "UPDATE workers SET close_asked_ms = ?2, updated_ms = ?2 WHERE dispatch_id = ?1",
            params![dispatch_id, now_ms],
        )?;
        Ok(())
    }

    /// Workers that are ready and have a tab: the ones whose tab the pump
    /// watches for a stop.
    pub fn ready_workers(&self) -> Result<Vec<Worker>, OrchError> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {WORKER_COLS} FROM workers WHERE state = 'ready' AND tab IS NOT NULL
             ORDER BY created_ms, rowid"
        ))?;
        Ok(st
            .query_map([], worker_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// Tells the coordinator that a ready worker stopped without a
    /// `worker_done` (an `escalation`). Nothing is written when the worker is
    /// no longer ready, when it has a question open (a pending gate, or an
    /// unread question), or when this stop was reported already: the id is
    /// built from the worker, the reason and `edge_ms`. The new message id.
    pub fn worker_stop_notice(
        &self,
        dispatch_id: &str,
        reason: StopReason,
        last_output: &str,
        edge_ms: i64,
        now_ms: i64,
    ) -> Result<Option<String>, OrchError> {
        let w = self.worker_get(dispatch_id)?;
        if w.state != WorkerState::Ready {
            return Ok(None);
        }
        let d = self.dispatch_get(dispatch_id)?;
        let address = format!("dispatch:{dispatch_id}");
        let open: i64 = self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM gates WHERE asker = ?1 AND status = 'pending')
                  + (SELECT COUNT(*) FROM messages
                       WHERE from_addr = ?1 AND kind = 'question' AND read = 0)",
            [&address],
            |r| r.get(0),
        )?;
        if open > 0 {
            return Ok(None);
        }
        let why = enum_text(&reason);
        let id = crate::ids::stop_message_id(dispatch_id, &format!("{why}@{edge_ms}"));
        let m = NewMessage {
            to: format!("run:{}", d.run_id),
            kind: MessageType::Escalation,
            subject: format!("worker-{} stopped: {why}", d.task_id),
            body: format!(
                "The worker of task {} stopped ({why}) without sending worker_done.",
                d.task_id
            ),
            priority: Priority::High,
            payload: Some(serde_json::json!({
                "taskId": d.task_id,
                "dispatchId": dispatch_id,
                "handle": dispatch_id,
                "stopReason": why,
                "lastOutput": last_output.chars().take(2000).collect::<String>(),
            })),
            thread: None,
        };
        let fresh = self.insert_message_with_id(&id, &d.run_id, &address, &m.to, &m, now_ms)?;
        Ok(fresh.then_some(id))
    }

    /// The dispatch failed without a verdict on the task: it is ready again.
    fn give_task_back(&self, dispatch_id: &str, now_ms: i64) -> Result<(), OrchError> {
        let d = self.dispatch_get(dispatch_id)?;
        self.conn.execute(
            "UPDATE dispatches SET status = 'failed' WHERE id = ?1",
            [dispatch_id],
        )?;
        if self.task_get(&d.task_id)?.status == TaskStatus::Dispatched {
            self.set_task_status(&d.task_id, TaskStatus::Ready, None, now_ms)?;
        }
        Ok(())
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
    fn failed_starts_count_per_task_with_or_without_retry_of() {
        let (s, run, task) = world();
        let mut first = None;
        for n in 1..=3 {
            // No --retry-of: the task is simply started again.
            let d = s.worker_begin(&plan(&run, &task, None), n).unwrap();
            let r = s
                .worker_started(&d.id, fail(FailedStage::TerminalCreate), n)
                .unwrap();
            first.get_or_insert(d.id);
            assert_eq!(r.next == NEXT_BREAKER, n == 3, "start {n}");
        }
        assert_eq!(s.task_get(&task).unwrap().status, TaskStatus::Failed);
        let e = s.worker_begin(&plan(&run, &task, first.as_deref()), 9);
        assert_eq!(e.unwrap_err().code, "circuit_broken");
    }

    #[test]
    fn an_attempt_that_was_retried_cannot_be_retried_again() {
        let (s, run, task) = world();
        let a = s.worker_begin(&plan(&run, &task, None), 1).unwrap();
        s.worker_started(&a.id, fail(FailedStage::TerminalCreate), 1)
            .unwrap();
        let b = s.worker_begin(&plan(&run, &task, Some(&a.id)), 2).unwrap();
        s.worker_started(&b.id, fail(FailedStage::TerminalCreate), 2)
            .unwrap();
        let old = s.worker_begin(&plan(&run, &task, Some(&a.id)), 3);
        let e = old.unwrap_err();
        assert_eq!(e.code, "invalid_transition");
        assert!(e.message.contains(&b.id), "{}", e.message);
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

    fn ready_worker(s: &Store, run: &str, task: &str) -> String {
        let d = s.worker_begin(&plan(run, task, None), 1).unwrap();
        s.worker_started(&d.id, StartResult::Ready, 2).unwrap();
        d.id
    }

    #[test]
    fn settling_finishes_the_task_promotes_dependants_and_schedules_the_close() {
        let (s, run, task) = world();
        let next = s
            .task_create(
                &run,
                NewTask {
                    title: None,
                    spec: "then".into(),
                    deps: vec![task.clone()],
                    parent: None,
                },
                1,
            )
            .unwrap();
        assert_eq!(next.status, TaskStatus::Pending);
        let id = ready_worker(&s, &run, &task);
        let w = s
            .worker_settle(&id, WorkerState::Succeeded, Some("did it"), true, 1000)
            .unwrap();
        assert_eq!(w.state, WorkerState::Succeeded);
        assert_eq!(w.closes_at_ms, Some(1000 + CLOSE_AFTER_MS));
        assert_eq!(
            s.dispatch_get(&id).unwrap().status,
            DispatchStatus::Completed
        );
        let t = s.task_get(&task).unwrap();
        assert_eq!(t.status, TaskStatus::Completed);
        assert_eq!(t.result.as_deref(), Some("did it"));
        assert_eq!(s.task_get(&next.id).unwrap().status, TaskStatus::Ready);
        // A second report changes nothing.
        let again = s
            .worker_settle(&id, WorkerState::Failed, None, true, 5000)
            .unwrap();
        assert_eq!(again, w);
        let bad = s.worker_settle(&id, WorkerState::Ready, None, true, 5);
        assert_eq!(bad.unwrap_err().code, "bad_request");
    }

    #[test]
    fn a_failed_report_fails_the_task_and_a_kept_or_manual_tab_gets_no_close_time() {
        let (s, run, task) = world();
        let id = ready_worker(&s, &run, &task);
        s.worker_set_kept(&id, true, 3).unwrap();
        let w = s
            .worker_settle(&id, WorkerState::Failed, None, true, 10)
            .unwrap();
        assert_eq!(w.closes_at_ms, None);
        assert_eq!(s.task_get(&task).unwrap().status, TaskStatus::Failed);
        assert_eq!(s.dispatch_get(&id).unwrap().status, DispatchStatus::Failed);

        let t2 = s
            .task_create(
                &run,
                NewTask {
                    title: None,
                    spec: "b".into(),
                    deps: vec![],
                    parent: None,
                },
                1,
            )
            .unwrap();
        let id2 = ready_worker(&s, &run, &t2.id);
        let w2 = s
            .worker_settle(&id2, WorkerState::Succeeded, None, false, 10)
            .unwrap();
        assert_eq!(w2.closes_at_ms, None);
    }

    #[test]
    fn a_report_before_the_start_was_recorded_still_settles() {
        let (s, run, task) = world();
        let d = s.worker_begin(&plan(&run, &task, None), 1).unwrap();
        let w = s
            .worker_settle(&d.id, WorkerState::Succeeded, None, true, 2)
            .unwrap();
        assert_eq!(w.state, WorkerState::Succeeded);
    }

    #[test]
    fn keeping_cancels_the_close_and_blocks_stop() {
        let (s, run, task) = world();
        let id = ready_worker(&s, &run, &task);
        s.worker_settle(&id, WorkerState::Succeeded, None, true, 10)
            .unwrap();
        let w = s.worker_set_kept(&id, true, 11).unwrap();
        assert!(w.kept);
        assert_eq!(w.closes_at_ms, None);
        assert_eq!(
            s.worker_stop_begin(&id, 12).unwrap_err().code,
            "worker_kept"
        );
        assert!(!s.worker_set_kept(&id, false, 13).unwrap().kept);
        assert_eq!(
            s.worker_set_kept("nope", true, 1).unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn stop_hands_the_task_back_when_the_tab_goes_and_stays_unknown_when_it_does_not() {
        let (s, run, task) = world();
        let id = ready_worker(&s, &run, &task);
        let w = s.worker_stop_begin(&id, 3).unwrap();
        assert_eq!(w.state, WorkerState::Stopping);
        let w = s.worker_stop_end(&id, false, 4).unwrap();
        assert_eq!(w.state, WorkerState::StopUnknown);
        // Asking again retries the close.
        assert_eq!(
            s.worker_stop_begin(&id, 5).unwrap().state,
            WorkerState::StopUnknown
        );
        assert_eq!(
            s.worker_stop_end(&id, false, 6).unwrap().state,
            WorkerState::StopUnknown
        );
        let w = s.worker_stop_end(&id, true, 7).unwrap();
        assert_eq!(w.state, WorkerState::Stopped);
        assert_eq!(s.task_get(&task).unwrap().status, TaskStatus::Ready);
        assert_eq!(s.dispatch_get(&id).unwrap().status, DispatchStatus::Failed);
    }

    #[test]
    fn abandon_forgets_the_worker_and_reopens_the_task() {
        let (s, run, task) = world();
        let id = ready_worker(&s, &run, &task);
        let w = s.worker_abandon(&id, 5).unwrap();
        assert_eq!(w.state, WorkerState::Abandoned);
        assert_eq!(s.task_get(&task).unwrap().status, TaskStatus::Ready);
        assert_eq!(
            s.worker_abandon(&id, 6).unwrap_err().code,
            "invalid_transition"
        );
    }

    #[test]
    fn workers_list_by_run_and_state_with_their_task() {
        let (s, run, task) = world();
        let id = ready_worker(&s, &run, &task);
        let all = s.worker_list(&run, None).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].dispatch.id, id);
        assert_eq!(all[0].task_status, TaskStatus::Dispatched);
        assert_eq!(
            s.worker_list(&run, Some(WorkerState::Ready)).unwrap().len(),
            1
        );
        assert!(
            s.worker_list(&run, Some(WorkerState::Failed))
                .unwrap()
                .is_empty()
        );
        let v = s.worker_view(&id).unwrap();
        assert_eq!(v.worker.state, WorkerState::Ready);
        assert_eq!(s.worker_view("nope").unwrap_err().code, "not_found");
    }

    #[test]
    fn the_sweeper_counts_down_cancels_when_busy_and_closes_when_due() {
        let (s, run, task) = world();
        let id = ready_worker(&s, &run, &task);
        s.worker_settle(&id, WorkerState::Succeeded, None, true, 1_000)
            .unwrap();
        let at = 1_000 + CLOSE_AFTER_MS;
        let on = |st: &'static str| move |_: &str| Some(st.to_owned());
        // Busy: the countdown set by settling is cancelled.
        let a = s.worker_sweep(&on("working"), 0, 2_000).unwrap();
        assert_eq!(a.len(), 1);
        assert!(!a[0].close);
        assert_eq!(s.worker_get(&id).unwrap().closes_at_ms, None);
        assert!(s.worker_sweep(&on("working"), 0, 3_000).unwrap().is_empty());
        // Quiet again: it starts over from now.
        s.worker_sweep(&on("idle"), 0, 4_000).unwrap();
        assert_eq!(
            s.worker_get(&id).unwrap().closes_at_ms,
            Some(4_000 + CLOSE_AFTER_MS)
        );
        assert!(s.worker_sweep(&on("idle"), 0, at).unwrap().is_empty());
        // Due: asked to close, but released only once the tab has gone.
        let due_at = 4_000 + CLOSE_AFTER_MS;
        let due = s.worker_sweep(&on("idle"), 0, due_at).unwrap();
        assert_eq!(due.len(), 1);
        assert!(due[0].close);
        assert!(!s.worker_get(&id).unwrap().released);
        assert!(
            s.worker_sweep(&on("idle"), 0, due_at + 1)
                .unwrap()
                .is_empty()
        );
        // Still on the board after the retry gap: asked again.
        let again = s
            .worker_sweep(&on("idle"), 0, due_at + CLOSE_RETRY_MS)
            .unwrap();
        assert_eq!(again.len(), 1);
        assert!(again[0].close);
        // Gone from the board: released, and never again.
        let gone = |_: &str| None;
        let done = s
            .worker_sweep(&gone, 0, due_at + CLOSE_RETRY_MS + 1)
            .unwrap();
        assert_eq!(done.len(), 1);
        assert!(!done[0].close);
        assert!(s.worker_get(&id).unwrap().released);
        assert!(s.worker_sweep(&on("idle"), 0, at * 9).unwrap().is_empty());
    }

    #[test]
    fn a_worker_that_finished_before_auto_close_was_on_stays_open() {
        let (s, run, task) = world();
        let id = ready_worker(&s, &run, &task);
        // Settled while the setting was off: no countdown.
        s.worker_settle(&id, WorkerState::Succeeded, None, false, 1_000)
            .unwrap();
        let idle = |_: &str| Some("idle".to_owned());
        // Turned on at 2 000: it finished before, so it is left alone.
        assert!(s.worker_sweep(&idle, 2_000, 9_000).unwrap().is_empty());
        assert_eq!(s.worker_get(&id).unwrap().closes_at_ms, None);
        // On since before it finished: it gets its countdown.
        assert_eq!(s.worker_sweep(&idle, 500, 9_000).unwrap().len(), 1);
    }

    #[test]
    fn the_sweeper_skips_kept_workers_and_tabs_off_the_board() {
        let (s, run, task) = world();
        let id = ready_worker(&s, &run, &task);
        s.worker_settle(&id, WorkerState::Failed, None, true, 1_000)
            .unwrap();
        assert!(s.worker_sweep(&|_| None, 0, 9_999_999).unwrap().is_empty());
        s.worker_set_kept(&id, true, 2_000).unwrap();
        let idle = |_: &str| Some("idle".to_owned());
        assert!(s.worker_sweep(&idle, 0, 9_999_999).unwrap().is_empty());
        assert!(!s.worker_get(&id).unwrap().released);
    }

    #[test]
    fn a_stop_notice_goes_to_the_coordinator_once_and_carries_the_context() {
        let (s, run, task) = world();
        let id = ready_worker(&s, &run, &task);
        assert_eq!(s.ready_workers().unwrap().len(), 1);
        let first = s
            .worker_stop_notice(&id, StopReason::Finished, &"x".repeat(3000), 50, 60)
            .unwrap()
            .unwrap();
        assert!(first.starts_with("msg_stop_"));
        let again = s
            .worker_stop_notice(&id, StopReason::Finished, "x", 50, 61)
            .unwrap();
        assert_eq!(again, None, "the same stop is reported once");
        let got = s
            .check(&format!("run:{run}"), &crate::CheckOpts::default(), 70)
            .unwrap();
        let m = &got.messages[0];
        assert_eq!(m.kind, MessageType::Escalation);
        assert_eq!(m.from, format!("dispatch:{id}"));
        let p = m.payload.as_ref().unwrap();
        assert_eq!(p["taskId"], json!(task));
        assert_eq!(p["dispatchId"], json!(id));
        assert_eq!(p["handle"], json!(id));
        assert_eq!(p["stopReason"], "finished");
        assert_eq!(p["lastOutput"].as_str().unwrap().chars().count(), 2000);
        // A later stop of another kind is a new report.
        assert!(
            s.worker_stop_notice(&id, StopReason::Exited, "", 90, 91)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn a_stop_with_a_question_open_or_after_settling_says_nothing() {
        let (s, run, task) = world();
        let id = ready_worker(&s, &run, &task);
        let me = s.identity(Some("tab_x"), None).unwrap();
        s.ask(&me, "which one?", &[], 5).unwrap();
        let none = s
            .worker_stop_notice(&id, StopReason::NeedsInput, "", 10, 11)
            .unwrap();
        assert_eq!(none, None, "the question already says why it stopped");
        let (s2, run2, task2) = world();
        let id2 = ready_worker(&s2, &run2, &task2);
        s2.worker_settle(&id2, WorkerState::Succeeded, None, false, 20)
            .unwrap();
        let after = s2
            .worker_stop_notice(&id2, StopReason::Finished, "", 30, 31)
            .unwrap();
        assert_eq!(after, None);
        assert!(s2.ready_workers().unwrap().is_empty());
    }
}
