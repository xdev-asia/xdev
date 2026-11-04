//! The task DAG of a run: a task waits for its deps, and becomes ready when
//! they are all completed.

use rusqlite::{OptionalExtension, params};

use crate::error::OrchError;
use crate::model::{Task, TaskStatus};
use crate::store::{Store, TASK_COLS, enum_text, task_row};

/// What `task-create` takes.
#[derive(Debug, Clone, Default)]
pub struct NewTask {
    pub title: Option<String>,
    pub spec: String,
    pub deps: Vec<String>,
    pub parent: Option<String>,
}

/// Which tasks `task-list` shows.
#[derive(Debug, Clone, Default)]
pub struct TaskFilter {
    pub status: Option<TaskStatus>,
    /// Only tasks that can start now.
    pub ready: bool,
}

/// The longest a spec is shown in a `--brief` list.
pub const BRIEF_CHARS: usize = 160;

/// A spec cut to one line of at most [`BRIEF_CHARS`] characters.
pub fn brief(spec: &str) -> String {
    let line = spec.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= BRIEF_CHARS {
        return line;
    }
    let cut: String = line.chars().take(BRIEF_CHARS - 1).collect();
    format!("{cut}…")
}

impl Store {
    /// One task by id.
    pub fn task_get(&self, id: &str) -> Result<Task, OrchError> {
        self.conn
            .query_row(
                &format!("SELECT {TASK_COLS} FROM tasks WHERE id = ?1"),
                [id],
                task_row,
            )
            .optional()?
            .ok_or_else(|| OrchError::not_found(format!("no task {id}")))
    }

    /// Adds a task to `run_id`: pending while a dep is incomplete, else ready.
    pub fn task_create(&self, run_id: &str, new: NewTask, now_ms: i64) -> Result<Task, OrchError> {
        if new.spec.trim().is_empty() {
            return Err(OrchError::bad_request("a task needs a spec"));
        }
        self.run_get(run_id)?;
        let mut deps: Vec<String> = Vec::new();
        for dep in &new.deps {
            if !deps.contains(dep) {
                deps.push(dep.clone());
            }
        }
        let mut waiting = false;
        for dep in &deps {
            let task = self
                .task_get(dep)
                .map_err(|_| OrchError::bad_request(format!("unknown dependency {dep}")))?;
            if task.run_id != run_id {
                return Err(OrchError::bad_request(format!(
                    "dependency {dep} belongs to another run"
                )));
            }
            waiting |= task.status != TaskStatus::Completed;
        }
        if let Some(parent) = &new.parent {
            let task = self
                .task_get(parent)
                .map_err(|_| OrchError::bad_request(format!("unknown parent {parent}")))?;
            if task.run_id != run_id {
                return Err(OrchError::bad_request(format!(
                    "parent {parent} belongs to another run"
                )));
            }
        }
        let id = self.next_id("task");
        // Ids are minted here, so a new task cannot be anyone's dependency yet:
        // a cycle can only come from naming itself, which an unknown id rules out.
        if deps.contains(&id) {
            return Err(OrchError::bad_request("a task cannot depend on itself"));
        }
        let status = if waiting {
            TaskStatus::Pending
        } else {
            TaskStatus::Ready
        };
        self.conn.execute(
            "INSERT INTO tasks (id, run_id, title, spec, deps, parent, status, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                id,
                run_id,
                new.title,
                new.spec,
                serde_json::to_string(&deps)?,
                new.parent,
                enum_text(&status),
                now_ms
            ],
        )?;
        self.task_get(&id)
    }

    /// The run's tasks, oldest first.
    pub fn task_list(&self, run_id: &str, filter: &TaskFilter) -> Result<Vec<Task>, OrchError> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {TASK_COLS} FROM tasks WHERE run_id = ?1 ORDER BY created_ms, rowid"
        ))?;
        let all = st
            .query_map([run_id], task_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(all
            .into_iter()
            .filter(|t| filter.status.is_none_or(|s| t.status == s))
            .filter(|t| !filter.ready || t.status == TaskStatus::Ready)
            .collect())
    }

    /// Sets a task's status (and result). Completing it makes the tasks that
    /// waited only for it ready. Returns the task as it now stands.
    pub fn task_update(
        &self,
        id: &str,
        status: Option<TaskStatus>,
        result: Option<&str>,
        now_ms: i64,
    ) -> Result<Task, OrchError> {
        let task = self.task_get(id)?;
        let Some(to) = status else {
            self.conn.execute(
                "UPDATE tasks SET result = COALESCE(?2, result), updated_ms = ?3 WHERE id = ?1",
                params![id, result, now_ms],
            )?;
            return self.task_get(id);
        };
        let from = task.status;
        let allowed = match to {
            TaskStatus::Completed => true,
            TaskStatus::Failed => from != TaskStatus::Completed,
            TaskStatus::Blocked => matches!(
                from,
                TaskStatus::Pending | TaskStatus::Ready | TaskStatus::Dispatched
            ),
            TaskStatus::Ready => {
                matches!(
                    from,
                    TaskStatus::Failed
                        | TaskStatus::Blocked
                        | TaskStatus::Dispatched
                        | TaskStatus::Ready
                        | TaskStatus::Pending
                ) && self.deps_done(&task)?
            }
            TaskStatus::Pending | TaskStatus::Dispatched => {
                return Err(OrchError::bad_request(
                    "a task's status is set to completed, failed, blocked or ready",
                ));
            }
        };
        if !allowed {
            return Err(OrchError::new(
                "invalid_transition",
                format!(
                    "task {id} cannot go from {} to {}",
                    enum_text(&from),
                    enum_text(&to)
                ),
            ));
        }
        self.set_task_status(id, to, result, now_ms)?;
        if to == TaskStatus::Completed {
            self.promote_dependants(&task.run_id, now_ms)?;
        }
        self.task_get(id)
    }

    /// Writes a status without checking the move (the callers did).
    pub(crate) fn set_task_status(
        &self,
        id: &str,
        status: TaskStatus,
        result: Option<&str>,
        now_ms: i64,
    ) -> Result<(), OrchError> {
        self.conn.execute(
            "UPDATE tasks SET status = ?2, result = COALESCE(?3, result), updated_ms = ?4 WHERE id = ?1",
            params![id, enum_text(&status), result, now_ms],
        )?;
        Ok(())
    }

    fn deps_done(&self, task: &Task) -> Result<bool, OrchError> {
        for dep in &task.deps {
            if self.task_get(dep)?.status != TaskStatus::Completed {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Pending tasks of the run whose deps are all completed become ready.
    pub(crate) fn promote_dependants(&self, run_id: &str, now_ms: i64) -> Result<(), OrchError> {
        let pending = self.task_list(
            run_id,
            &TaskFilter {
                status: Some(TaskStatus::Pending),
                ready: false,
            },
        )?;
        for task in pending {
            if self.deps_done(&task)? {
                self.set_task_status(&task.id, TaskStatus::Ready, None, now_ms)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, String) {
        let s = Store::open_in_memory().unwrap();
        let run = s.run_create("r", Some("t"), 1).unwrap();
        (s, run.id)
    }

    fn make(s: &Store, run: &str, spec: &str, deps: &[&Task]) -> Task {
        s.task_create(
            run,
            NewTask {
                spec: spec.to_owned(),
                deps: deps.iter().map(|t| t.id.clone()).collect(),
                ..NewTask::default()
            },
            5,
        )
        .unwrap()
    }

    #[test]
    fn a_task_without_open_deps_is_ready_and_with_one_it_is_pending() {
        let (s, run) = store();
        let a = make(&s, &run, "a", &[]);
        assert_eq!(a.status, TaskStatus::Ready);
        let b = make(&s, &run, "b", &[&a]);
        assert_eq!(b.status, TaskStatus::Pending);
        assert_eq!(b.deps, vec![a.id.clone()]);
        s.task_update(&a.id, Some(TaskStatus::Completed), Some("done"), 6)
            .unwrap();
        let c = make(&s, &run, "c", &[&a]);
        assert_eq!(c.status, TaskStatus::Ready);
    }

    #[test]
    fn a_diamond_promotes_the_join_only_when_both_arms_are_done() {
        let (s, run) = store();
        let top = make(&s, &run, "top", &[]);
        let l = make(&s, &run, "l", &[&top]);
        let r = make(&s, &run, "r", &[&top]);
        let join = make(&s, &run, "join", &[&l, &r]);
        s.task_update(&top.id, Some(TaskStatus::Completed), None, 6)
            .unwrap();
        assert_eq!(s.task_get(&l.id).unwrap().status, TaskStatus::Ready);
        assert_eq!(s.task_get(&r.id).unwrap().status, TaskStatus::Ready);
        assert_eq!(s.task_get(&join.id).unwrap().status, TaskStatus::Pending);
        s.task_update(&l.id, Some(TaskStatus::Completed), None, 7)
            .unwrap();
        assert_eq!(s.task_get(&join.id).unwrap().status, TaskStatus::Pending);
        s.task_update(&r.id, Some(TaskStatus::Completed), None, 8)
            .unwrap();
        assert_eq!(s.task_get(&join.id).unwrap().status, TaskStatus::Ready);
    }

    #[test]
    fn unknown_and_foreign_deps_and_empty_specs_are_bad_requests() {
        let (s, run) = store();
        let other = s.run_create("o", None, 2).unwrap();
        let foreign = make(&s, &other.id, "x", &[]);
        let bad = |deps: Vec<String>, spec: &str| {
            s.task_create(
                &run,
                NewTask {
                    spec: spec.to_owned(),
                    deps,
                    ..NewTask::default()
                },
                1,
            )
            .unwrap_err()
            .code
        };
        assert_eq!(bad(vec!["task_nope".into()], "s"), "bad_request");
        assert_eq!(bad(vec![foreign.id.clone()], "s"), "bad_request");
        assert_eq!(bad(vec![], "  "), "bad_request");
        let err = s
            .task_create(
                &run,
                NewTask {
                    spec: "s".into(),
                    parent: Some("task_nope".into()),
                    ..NewTask::default()
                },
                1,
            )
            .unwrap_err();
        assert_eq!(err.code, "bad_request");
    }

    #[test]
    fn list_filters_by_status_and_ready_and_brief_cuts_a_spec() {
        let (s, run) = store();
        let a = make(&s, &run, "a", &[]);
        let b = make(&s, &run, "b", &[&a]);
        let ready = TaskFilter {
            ready: true,
            ..TaskFilter::default()
        };
        let ids = |f: &TaskFilter| -> Vec<String> {
            s.task_list(&run, f)
                .unwrap()
                .into_iter()
                .map(|t| t.id)
                .collect()
        };
        assert_eq!(
            ids(&TaskFilter::default()),
            vec![a.id.clone(), b.id.clone()]
        );
        assert_eq!(ids(&ready), vec![a.id.clone()]);
        let pending = TaskFilter {
            status: Some(TaskStatus::Pending),
            ready: false,
        };
        assert_eq!(ids(&pending), vec![b.id.clone()]);

        let long = "word ".repeat(100);
        let cut = brief(&long);
        assert_eq!(cut.chars().count(), BRIEF_CHARS);
        assert!(cut.ends_with('…'));
        assert_eq!(brief("one\n two"), "one two");
    }

    #[test]
    fn a_failed_or_blocked_task_can_be_reopened_when_its_deps_are_done() {
        let (s, run) = store();
        let a = make(&s, &run, "a", &[]);
        let b = make(&s, &run, "b", &[&a]);
        // b waits for a: it cannot be forced ready.
        assert_eq!(
            s.task_update(&b.id, Some(TaskStatus::Ready), None, 6)
                .unwrap_err()
                .code,
            "invalid_transition"
        );
        s.task_update(&a.id, Some(TaskStatus::Failed), Some("boom"), 6)
            .unwrap();
        let again = s
            .task_update(&a.id, Some(TaskStatus::Ready), None, 7)
            .unwrap();
        assert_eq!(again.status, TaskStatus::Ready);
        assert_eq!(again.result.as_deref(), Some("boom"));
        s.task_update(&a.id, Some(TaskStatus::Blocked), None, 8)
            .unwrap();
        assert_eq!(s.task_get(&a.id).unwrap().status, TaskStatus::Blocked);
    }

    #[test]
    fn statuses_that_are_not_set_by_hand_and_moves_out_of_completed_are_refused() {
        let (s, run) = store();
        let a = make(&s, &run, "a", &[]);
        assert_eq!(
            s.task_update(&a.id, Some(TaskStatus::Dispatched), None, 6)
                .unwrap_err()
                .code,
            "bad_request"
        );
        s.task_update(&a.id, Some(TaskStatus::Completed), None, 6)
            .unwrap();
        for to in [TaskStatus::Failed, TaskStatus::Blocked, TaskStatus::Ready] {
            assert_eq!(
                s.task_update(&a.id, Some(to), None, 7).unwrap_err().code,
                "invalid_transition"
            );
        }
        // A result alone is recorded without a status change.
        let t = s.task_update(&a.id, None, Some("note"), 8).unwrap();
        assert_eq!(t.status, TaskStatus::Completed);
        assert_eq!(t.result.as_deref(), Some("note"));
        assert_eq!(
            s.task_update("task_x", None, None, 1).unwrap_err().code,
            "not_found"
        );
    }
}
