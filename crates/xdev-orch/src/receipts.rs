//! Receipts: what a request answered, kept so a retry with the same
//! `--retry-request` id gets the same answer and no second side effect. Also
//! `reset`, which forgets work.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::OrchError;
use crate::store::Store;

/// Most receipts kept.
pub const RECEIPT_ROWS: i64 = 10_000;
/// How long a receipt lives.
pub const RECEIPT_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// A stored answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Receipt {
    pub request_id: String,
    pub method: String,
    pub answer: String,
    pub created_ms: i64,
}

/// What [`Store::receipt_reserve`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reserve {
    /// The id is this caller's: run the request, then put or release it.
    Mine,
    /// Another call with this id is still running.
    Running,
    /// The id was answered before.
    Answered(Receipt),
}

/// The answer of a reserved id that is not answered yet.
const RESERVED: &str = "";

/// What `reset` forgets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetScope {
    /// Every run and everything under it.
    All,
    /// Tasks, dispatches, workers and gates of one run.
    Tasks,
    /// Messages of one run.
    Messages,
}

/// Rows removed, by kind.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResetCounts {
    pub runs: usize,
    pub tasks: usize,
    pub messages: usize,
}

impl Store {
    /// The receipt of a request id, if one is kept.
    pub fn receipt_get(&self, request_id: &str) -> Result<Option<Receipt>, OrchError> {
        Ok(self
            .conn
            .query_row(
                "SELECT request_id, method, answer, created_ms FROM receipts
                 WHERE request_id = ?1 AND answer <> ''",
                [request_id],
                |r| {
                    Ok(Receipt {
                        request_id: r.get(0)?,
                        method: r.get(1)?,
                        answer: r.get(2)?,
                        created_ms: r.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// Claims a request id before the request runs, so two calls with one id
    /// never both run: the first gets [`Reserve::Mine`], the rest see it
    /// running or, once it is put, its answer.
    pub fn receipt_reserve(
        &self,
        request_id: &str,
        method: &str,
        now_ms: i64,
    ) -> Result<Reserve, OrchError> {
        let n = self.conn.execute(
            "INSERT OR IGNORE INTO receipts (request_id, method, answer, created_ms) VALUES (?1, ?2, ?3, ?4)",
            params![request_id, method, RESERVED, now_ms],
        )?;
        if n > 0 {
            return Ok(Reserve::Mine);
        }
        Ok(match self.receipt_get(request_id)? {
            Some(r) => Reserve::Answered(r),
            None => Reserve::Running,
        })
    }

    /// Gives back a reserved id whose request failed, so a retry runs it.
    pub fn receipt_release(&self, request_id: &str) -> Result<(), OrchError> {
        self.conn.execute(
            "DELETE FROM receipts WHERE request_id = ?1 AND answer = ''",
            [request_id],
        )?;
        Ok(())
    }

    /// Drops every reservation: no request outlives the app that ran it.
    pub fn receipts_clear_reserved(&self) -> Result<(), OrchError> {
        self.conn
            .execute("DELETE FROM receipts WHERE answer = ''", [])?;
        Ok(())
    }

    /// Keeps an answer (the first one for an id wins), then prunes receipts
    /// older than 30 days and all but the newest 10 000.
    pub fn receipt_put(
        &self,
        request_id: &str,
        method: &str,
        answer: &str,
        now_ms: i64,
    ) -> Result<(), OrchError> {
        self.conn.execute(
            "INSERT INTO receipts (request_id, method, answer, created_ms) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (request_id) DO UPDATE
             SET method = excluded.method, answer = excluded.answer, created_ms = excluded.created_ms
             WHERE receipts.answer = ''",
            params![request_id, method, answer, now_ms],
        )?;
        self.conn.execute(
            "DELETE FROM receipts WHERE created_ms < ?1",
            [now_ms - RECEIPT_TTL_MS],
        )?;
        self.conn.execute(
            "DELETE FROM receipts WHERE rowid NOT IN (SELECT rowid FROM receipts ORDER BY created_ms DESC, rowid DESC LIMIT ?1)",
            [RECEIPT_ROWS],
        )?;
        Ok(())
    }

    /// Forgets work. `run` is the run for `Tasks` and `Messages`; `All`
    /// ignores it. Receipts are kept.
    pub fn reset(&self, scope: ResetScope, run: Option<&str>) -> Result<ResetCounts, OrchError> {
        self.atomic(|st| {
        let tx = &st.conn;
        let mut out = ResetCounts::default();
        match scope {
            ResetScope::All => {
                out.messages = tx.execute("DELETE FROM messages", [])?;
                out.tasks = tx.execute("DELETE FROM tasks", [])?;
                tx.execute("DELETE FROM workers", [])?;
                tx.execute("DELETE FROM dispatches", [])?;
                tx.execute("DELETE FROM gates", [])?;
                tx.execute("DELETE FROM tab_runs", [])?;
                out.runs = tx.execute("DELETE FROM runs", [])?;
            }
            ResetScope::Tasks => {
                let run = run.ok_or_else(|| OrchError::bad_request("reset needs a run"))?;
                tx.execute(
                    "DELETE FROM workers WHERE dispatch_id IN (SELECT id FROM dispatches WHERE run_id = ?1)",
                    [run],
                )?;
                tx.execute("DELETE FROM dispatches WHERE run_id = ?1", [run])?;
                tx.execute("DELETE FROM gates WHERE run_id = ?1", [run])?;
                out.tasks = tx.execute("DELETE FROM tasks WHERE run_id = ?1", [run])?;
            }
            ResetScope::Messages => {
                let run = run.ok_or_else(|| OrchError::bad_request("reset needs a run"))?;
                out.messages = tx.execute("DELETE FROM messages WHERE run_id = ?1", [run])?;
            }
        }
        Ok(out)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::NewTask;

    fn task(s: &Store, run: &str) {
        s.task_create(
            run,
            NewTask {
                title: None,
                spec: "x".into(),
                deps: vec![],
                parent: None,
            },
            1,
        )
        .unwrap();
    }

    #[test]
    fn a_receipt_is_kept_and_the_first_answer_wins() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.receipt_get("r1").unwrap(), None);
        s.receipt_put("r1", "orchestration.send", "{\"a\":1}", 10)
            .unwrap();
        s.receipt_put("r1", "orchestration.send", "{\"a\":2}", 11)
            .unwrap();
        let got = s.receipt_get("r1").unwrap().unwrap();
        assert_eq!(got.answer, "{\"a\":1}");
        assert_eq!(got.method, "orchestration.send");
        assert_eq!(got.created_ms, 10);
    }

    #[test]
    fn old_receipts_are_pruned_on_insert() {
        let s = Store::open_in_memory().unwrap();
        s.receipt_put("old", "m", "{}", 0).unwrap();
        s.receipt_put("new", "m", "{}", RECEIPT_TTL_MS + 5).unwrap();
        assert_eq!(s.receipt_get("old").unwrap(), None);
        assert!(s.receipt_get("new").unwrap().is_some());
    }

    #[test]
    fn receipts_are_capped_at_the_newest_ten_thousand() {
        let s = Store::open_in_memory().unwrap();
        {
            let tx = s.conn.unchecked_transaction().unwrap();
            for i in 0..RECEIPT_ROWS {
                tx.execute(
                    "INSERT INTO receipts (request_id, method, answer, created_ms) VALUES (?1, 'm', '{}', ?2)",
                    params![format!("r{i}"), i],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }
        s.receipt_put("extra", "m", "{}", RECEIPT_ROWS).unwrap();
        let n: i64 = s
            .conn
            .query_row("SELECT COUNT(*) FROM receipts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, RECEIPT_ROWS);
        assert_eq!(s.receipt_get("r0").unwrap(), None);
        assert!(s.receipt_get("extra").unwrap().is_some());
    }

    #[test]
    fn a_request_id_is_reserved_once_until_it_is_answered_or_released() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.receipt_reserve("r1", "m", 1).unwrap(), Reserve::Mine);
        assert_eq!(s.receipt_reserve("r1", "m", 2).unwrap(), Reserve::Running);
        assert_eq!(
            s.receipt_get("r1").unwrap(),
            None,
            "a reservation is no answer"
        );
        s.receipt_put("r1", "m", "{\"a\":1}", 3).unwrap();
        match s.receipt_reserve("r1", "m", 4).unwrap() {
            Reserve::Answered(r) => assert_eq!(r.answer, "{\"a\":1}"),
            other => panic!("{other:?}"),
        }
        // A request that failed gives its id back.
        assert_eq!(s.receipt_reserve("r2", "m", 5).unwrap(), Reserve::Mine);
        s.receipt_release("r2").unwrap();
        assert_eq!(s.receipt_reserve("r2", "m", 6).unwrap(), Reserve::Mine);
        // Reservations do not outlive the app.
        s.receipts_clear_reserved().unwrap();
        assert_eq!(s.receipt_reserve("r2", "m", 7).unwrap(), Reserve::Mine);
    }

    #[test]
    fn reset_tasks_keeps_messages_and_other_runs() {
        let s = Store::open_in_memory().unwrap();
        let a = s.run_create("a", Some("t1"), 1).unwrap();
        let b = s.run_create("b", Some("t2"), 1).unwrap();
        task(&s, &a.id);
        task(&s, &a.id);
        task(&s, &b.id);
        let n = s.reset(ResetScope::Tasks, Some(&a.id)).unwrap();
        assert_eq!(n.tasks, 2);
        assert_eq!(s.run_show(&a.id).unwrap().tasks.len(), 0);
        assert_eq!(s.run_show(&b.id).unwrap().tasks.len(), 1);
        assert_eq!(s.run_list().unwrap().len(), 2);
    }

    #[test]
    fn reset_all_forgets_every_run_but_not_receipts() {
        let s = Store::open_in_memory().unwrap();
        let a = s.run_create("a", Some("t1"), 1).unwrap();
        task(&s, &a.id);
        s.receipt_put("r", "m", "{}", 1).unwrap();
        let n = s.reset(ResetScope::All, None).unwrap();
        assert_eq!((n.runs, n.tasks), (1, 1));
        assert!(s.run_list().unwrap().is_empty());
        assert!(s.receipt_get("r").unwrap().is_some());
    }

    #[test]
    fn reset_messages_needs_a_run() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(
            s.reset(ResetScope::Messages, None).unwrap_err().code,
            "bad_request"
        );
    }
}
