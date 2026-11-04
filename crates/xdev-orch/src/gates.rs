//! Decision gates: a question for the person (or the coordinator) that waits
//! for an answer. `ask` makes one; `gate-resolve` answers it.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::error::OrchError;
use crate::mail::{Identity, NewMessage};
use crate::model::{Gate, GateStatus, MessageType, Priority};
use crate::render::NEXT_RECORDED;
use crate::store::{GATE_COLS, Store, enum_text, gate_row};

/// What `ask` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskAnswer {
    /// True while nobody has answered.
    pub pending: bool,
    pub gate_id: String,
    pub resolution: Option<String>,
    pub next: String,
}

/// The first line of a question, short enough for a subject.
fn subject_of(question: &str) -> String {
    let line = question.lines().next().unwrap_or("").trim();
    if line.chars().count() <= 80 {
        return line.to_owned();
    }
    let cut: String = line.chars().take(79).collect();
    format!("{cut}…")
}

impl Store {
    /// One gate by id.
    pub fn gate_get(&self, id: &str) -> Result<Gate, OrchError> {
        self.conn
            .query_row(
                &format!("SELECT {GATE_COLS} FROM gates WHERE id = ?1"),
                [id],
                gate_row,
            )
            .optional()?
            .ok_or_else(|| OrchError::not_found(format!("no gate {id}")))
    }

    /// Opens a gate on `task_id` (empty when it belongs to no task); the
    /// answer goes to `asker`.
    pub fn gate_create(
        &self,
        run_id: &str,
        task_id: &str,
        question: &str,
        options: &[String],
        asker: &str,
        now_ms: i64,
    ) -> Result<Gate, OrchError> {
        if question.trim().is_empty() {
            return Err(OrchError::bad_request("a gate needs a question"));
        }
        if !task_id.is_empty() {
            let task = self.task_get(task_id)?;
            if task.run_id != run_id {
                return Err(OrchError::bad_request(format!(
                    "task {task_id} is not in run {run_id}"
                )));
            }
        }
        let id = self.next_id("gate");
        self.conn.execute(
            "INSERT INTO gates (id, run_id, task_id, question, options, status, asker, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)",
            params![
                id,
                run_id,
                task_id,
                question,
                serde_json::to_string(options)?,
                asker,
                now_ms
            ],
        )?;
        self.gate_get(&id)
    }

    /// The gates of a run, oldest first.
    pub fn gate_list(&self, run_id: &str, pending_only: bool) -> Result<Vec<Gate>, OrchError> {
        let only = if pending_only {
            " AND status = 'pending'"
        } else {
            ""
        };
        let mut st = self.conn.prepare(&format!(
            "SELECT {GATE_COLS} FROM gates WHERE run_id = ?1{only} ORDER BY created_ms, rowid"
        ))?;
        Ok(st
            .query_map([run_id], gate_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// Answers a pending gate. A worker that asked gets the answer as a
    /// `decision_gate` message; a coordinator gets it from `ask` itself.
    pub fn gate_resolve(&self, id: &str, resolution: &str, now_ms: i64) -> Result<Gate, OrchError> {
        let gate = self.gate_get(id)?;
        if gate.status != GateStatus::Pending {
            return Err(OrchError::new(
                "invalid_transition",
                format!("gate {id} is already {}", enum_text(&gate.status)),
            ));
        }
        self.conn.execute(
            "UPDATE gates SET status = 'resolved', resolution = ?2 WHERE id = ?1",
            params![id, resolution],
        )?;
        let asker: String =
            self.conn
                .query_row("SELECT asker FROM gates WHERE id = ?1", [id], |r| r.get(0))?;
        if asker.starts_with("dispatch:") {
            let m = NewMessage {
                to: asker.clone(),
                kind: MessageType::DecisionGate,
                subject: format!("Decision: {}", subject_of(&gate.question)),
                body: resolution.to_owned(),
                priority: Priority::High,
                payload: Some(serde_json::json!({ "gateId": id })),
                thread: None,
            };
            let from = format!("run:{}", gate.run_id);
            let mid = self.next_id("msg");
            self.insert_message_with_id(&mid, &gate.run_id, &from, &asker, &m, now_ms)?;
        }
        self.gate_get(id)
    }

    /// `ask`: a worker's question is mailed to the coordinator and the worker
    /// is told to end its turn; a coordinator's is just a gate to wait on.
    pub fn ask(
        &self,
        from: &Identity,
        question: &str,
        options: &[String],
        now_ms: i64,
    ) -> Result<AskAnswer, OrchError> {
        let task_id = match &from.dispatch {
            Some(d) => {
                self.conn
                    .query_row("SELECT task_id FROM dispatches WHERE id = ?1", [d], |r| {
                        r.get::<_, String>(0)
                    })?
            }
            None => String::new(),
        };
        let gate = self.gate_create(
            &from.run_id,
            &task_id,
            question,
            options,
            &from.address,
            now_ms,
        )?;
        if from.dispatch.is_some() {
            let m = NewMessage {
                to: format!("run:{}", from.run_id),
                kind: MessageType::Question,
                subject: subject_of(question),
                body: question.to_owned(),
                priority: Priority::High,
                payload: Some(serde_json::json!({
                    "gateId": gate.id,
                    "taskId": task_id,
                    "options": options,
                })),
                thread: None,
            };
            let mid = self.next_id("msg");
            self.insert_message_with_id(&mid, &from.run_id, &from.address, &m.to, &m, now_ms)?;
        }
        Ok(AskAnswer {
            pending: true,
            gate_id: gate.id,
            resolution: None,
            next: if from.dispatch.is_some() {
                NEXT_RECORDED.to_owned()
            } else {
                String::new()
            },
        })
    }

    /// The state of a gate as `ask --resume` reports it.
    pub fn ask_resume(&self, gate_id: &str) -> Result<AskAnswer, OrchError> {
        let g = self.gate_get(gate_id)?;
        let done = g.status != GateStatus::Pending;
        Ok(AskAnswer {
            pending: !done,
            gate_id: g.id,
            resolution: g.resolution,
            next: String::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::CheckOpts;

    fn world() -> (Store, Identity, Identity, String) {
        let s = Store::open_in_memory().unwrap();
        let run = s.run_create("o", Some("lead"), 1).unwrap();
        let task = s
            .task_create(
                &run.id,
                crate::NewTask {
                    title: None,
                    spec: "s".into(),
                    deps: vec![],
                    parent: None,
                },
                1,
            )
            .unwrap();
        s.conn
            .execute_batch(&format!(
                "INSERT INTO dispatches (id, run_id, task_id, status) VALUES ('disp_a', '{r}', '{t}', 'dispatched');
                 INSERT INTO workers (dispatch_id, tab, worktree, agent, state, created_ms, updated_ms)
                   VALUES ('disp_a', 'tab_a', '/wt/a', 'claude', 'ready', 1, 1);",
                r = run.id,
                t = task.id
            ))
            .unwrap();
        let lead = s.identity(Some("lead"), None).unwrap();
        let worker = s.identity(Some("tab_a"), None).unwrap();
        (s, lead, worker, task.id)
    }

    #[test]
    fn a_worker_ask_mails_the_coordinator_and_returns_at_once() {
        let (s, lead, worker, task) = world();
        let a = s
            .ask(
                &worker,
                "Pick one?\nlong text",
                &["x".into(), "y".into()],
                5,
            )
            .unwrap();
        assert!(a.pending);
        assert_eq!(a.next, NEXT_RECORDED);
        let g = s.gate_get(&a.gate_id).unwrap();
        assert_eq!(g.task_id, task);
        assert_eq!(g.options, vec!["x", "y"]);
        let mail = s.check(&lead.address, &CheckOpts::default(), 6).unwrap();
        assert_eq!(mail.messages.len(), 1);
        assert_eq!(mail.messages[0].kind, MessageType::Question);
        assert_eq!(mail.messages[0].subject, "Pick one?");
        assert_eq!(
            mail.messages[0].payload.as_ref().unwrap()["gateId"],
            a.gate_id
        );
    }

    #[test]
    fn resolving_sends_the_worker_a_decision_and_only_once() {
        let (s, _lead, worker, _) = world();
        let a = s.ask(&worker, "which?", &[], 5).unwrap();
        assert!(s.ask_resume(&a.gate_id).unwrap().pending);
        let g = s.gate_resolve(&a.gate_id, "sqlite", 7).unwrap();
        assert_eq!(g.status, GateStatus::Resolved);
        assert_eq!(g.resolution.as_deref(), Some("sqlite"));
        let back = s.check(&worker.address, &CheckOpts::default(), 8).unwrap();
        assert_eq!(back.messages.len(), 1);
        assert_eq!(back.messages[0].kind, MessageType::DecisionGate);
        assert_eq!(back.messages[0].body, "sqlite");
        assert_eq!(back.messages[0].priority, Priority::High);
        let again = s.gate_resolve(&a.gate_id, "no", 9);
        assert_eq!(again.unwrap_err().code, "invalid_transition");
        let r = s.ask_resume(&a.gate_id).unwrap();
        assert!(!r.pending);
        assert_eq!(r.resolution.as_deref(), Some("sqlite"));
    }

    #[test]
    fn a_coordinator_ask_sends_no_mail_and_gets_the_answer_from_resume() {
        let (s, lead, _worker, _) = world();
        let a = s.ask(&lead, "ship it?", &[], 5).unwrap();
        assert!(a.pending);
        assert_eq!(a.next, "");
        s.gate_resolve(&a.gate_id, "yes", 6).unwrap();
        assert_eq!(s.unread_count(&lead.address).unwrap(), 0);
        assert_eq!(
            s.ask_resume(&a.gate_id).unwrap().resolution.as_deref(),
            Some("yes")
        );
    }

    #[test]
    fn gates_list_by_run_and_reject_bad_input() {
        let (s, lead, _worker, task) = world();
        let g1 = s
            .gate_create(&lead.run_id, &task, "q1", &[], &lead.address, 1)
            .unwrap();
        s.gate_create(&lead.run_id, "", "q2", &[], &lead.address, 2)
            .unwrap();
        assert_eq!(s.gate_list(&lead.run_id, true).unwrap().len(), 2);
        s.gate_resolve(&g1.id, "a", 3).unwrap();
        assert_eq!(s.gate_list(&lead.run_id, true).unwrap().len(), 1);
        assert_eq!(s.gate_list(&lead.run_id, false).unwrap().len(), 2);
        let empty = s.gate_create(&lead.run_id, "", "  ", &[], &lead.address, 1);
        assert_eq!(empty.unwrap_err().code, "bad_request");
        let ghost = s.gate_create(&lead.run_id, "task_nope", "q", &[], &lead.address, 1);
        assert_eq!(ghost.unwrap_err().code, "not_found");
        assert_eq!(s.gate_get("gate_nope").unwrap_err().code, "not_found");
        assert_eq!(s.run_show(&lead.run_id).unwrap().open_gates, 1);
    }
}
