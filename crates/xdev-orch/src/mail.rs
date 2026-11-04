//! Mail: messages between a run's coordinator (`run:<id>`) and its workers
//! (`dispatch:<id>`). Groups (`@all`, `@idle`, `@worktree:<x>`, `@<agent>`)
//! fan out to one message per worker.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

use crate::error::OrchError;
use crate::model::{CheckResult, Message, MessageType, Priority, Worker};
use crate::render::{NEXT_FINISH_MAIL, NEXT_IDLE, NEXT_MORE_MAIL, NEXT_RECORDED, render};
use crate::store::{MESSAGE_COLS, Store, WORKER_COLS, enum_text, message_row, worker_row};

/// The longest message body.
pub const BODY_MAX: usize = 64 * 1024;
/// How many messages one `check` hands over.
pub const CHECK_MAX: usize = 50;
/// How much of a body `inbox` previews.
pub const PREVIEW_CHARS: usize = 200;

/// Who a call acts as: the run it is in and the mailbox it reads and writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub run_id: String,
    /// `run:<id>` for a coordinator, `dispatch:<id>` for a worker.
    pub address: String,
    /// The dispatch, when the caller is a worker.
    pub dispatch: Option<String>,
}

/// What `send` takes.
#[derive(Debug, Clone)]
pub struct NewMessage {
    pub to: String,
    pub kind: MessageType,
    pub subject: String,
    pub body: String,
    pub priority: Priority,
    pub payload: Option<Value>,
    pub thread: Option<String>,
}

/// What `send` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendReceipt {
    /// The ids written, one per recipient.
    pub ids: Vec<String>,
    /// The mailboxes written to (empty for a group nobody is in).
    pub to: Vec<String>,
    /// How many mailboxes it reached (0 for a group nobody is in).
    pub count: u32,
    pub next: String,
}

/// What `check` filters by.
#[derive(Debug, Clone, Default)]
pub struct CheckOpts {
    /// Look, but do not mark anything handled.
    pub peek: bool,
    /// Include messages already handled.
    pub all: bool,
    /// Only these types (empty: every type).
    pub types: Vec<MessageType>,
}

/// One line of `inbox`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxRow {
    pub id: String,
    pub from: String,
    pub subject: String,
    #[serde(rename = "type")]
    pub kind: MessageType,
    pub priority: Priority,
    pub read: bool,
    pub preview: String,
    pub created_ms: i64,
}

fn preview(body: &str, full: bool) -> String {
    if full || body.chars().count() <= PREVIEW_CHARS {
        return body.to_owned();
    }
    let cut: String = body.chars().take(PREVIEW_CHARS - 1).collect();
    format!("{cut}…")
}

impl Store {
    /// The worker whose tab is `tab`, newest first.
    pub fn worker_of_tab(&self, tab: &str) -> Result<Option<Worker>, OrchError> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "SELECT {WORKER_COLS} FROM workers WHERE tab = ?1
                     ORDER BY created_ms DESC, rowid DESC LIMIT 1"
                ),
                [tab],
                worker_row,
            )
            .optional()?)
    }

    /// Who a call from `tab` (or `--run`) acts as. A worker's tab acts as its
    /// dispatch; any other tab acts as the coordinator of its current run.
    pub fn identity(&self, tab: Option<&str>, run: Option<&str>) -> Result<Identity, OrchError> {
        if let Some(tab) = tab
            && let Some(w) = self.worker_of_tab(tab)?
        {
            let run_id: String = self.conn.query_row(
                "SELECT run_id FROM dispatches WHERE id = ?1",
                [&w.dispatch_id],
                |r| r.get(0),
            )?;
            return Ok(Identity {
                run_id,
                address: format!("dispatch:{}", w.dispatch_id),
                dispatch: Some(w.dispatch_id),
            });
        }
        let run = self.run_resolve(run, tab)?;
        Ok(Identity {
            address: format!("run:{}", run.id),
            run_id: run.id,
            dispatch: None,
        })
    }

    /// The name a message shows for a sender: the worker's task, or the coordinator.
    pub fn display_name(&self, address: &str) -> String {
        match address.strip_prefix("dispatch:") {
            Some(id) => self
                .conn
                .query_row("SELECT task_id FROM dispatches WHERE id = ?1", [id], |r| {
                    r.get::<_, String>(0)
                })
                .map_or_else(|_| "worker".to_owned(), |t| format!("worker-{t}")),
            None => "coordinator".to_owned(),
        }
    }

    /// Workers of a run that can still be written to.
    pub fn live_workers(&self, run_id: &str) -> Result<Vec<Worker>, OrchError> {
        let cols = WORKER_COLS
            .split(", ")
            .map(|c| format!("w.{c}"))
            .collect::<Vec<_>>()
            .join(", ");
        let mut st = self.conn.prepare(&format!(
            "SELECT {cols} FROM workers w JOIN dispatches d ON d.id = w.dispatch_id
             WHERE d.run_id = ?1 AND w.state IN ('starting', 'start_unknown', 'ready')
             ORDER BY w.created_ms, w.rowid"
        ))?;
        Ok(st
            .query_map([run_id], worker_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    /// The mailboxes `to` reaches, as `(address, run)`. `idle` says whether a
    /// tab is idle (for `@idle`).
    fn recipients(
        &self,
        from: &Identity,
        to: &str,
        idle: &dyn Fn(&str) -> bool,
    ) -> Result<Vec<(String, String)>, OrchError> {
        if let Some(id) = to.strip_prefix("run:") {
            let run = self.run_get(id)?;
            return Ok(vec![(to.to_owned(), run.id)]);
        }
        if let Some(id) = to.strip_prefix("dispatch:") {
            let run_id: Option<String> = self
                .conn
                .query_row("SELECT run_id FROM dispatches WHERE id = ?1", [id], |r| {
                    r.get(0)
                })
                .optional()?;
            return match run_id {
                Some(run) => Ok(vec![(to.to_owned(), run)]),
                None => Err(OrchError::not_found(format!("no worker {id}"))),
            };
        }
        let Some(group) = to.strip_prefix('@') else {
            return Err(OrchError::bad_request(format!(
                "{to} is not an address: use run:<id>, dispatch:<id> or @group"
            )));
        };
        let live = self.live_workers(&from.run_id)?;
        let pick: Vec<Worker> = if group == "all" {
            live
        } else if group == "idle" {
            live.into_iter()
                .filter(|w| w.tab.as_deref().is_some_and(idle))
                .collect()
        } else if let Some(wt) = group.strip_prefix("worktree:") {
            live.into_iter()
                .filter(|w| {
                    let base = w
                        .worktree
                        .trim_end_matches(['/', '\\'])
                        .rsplit(['/', '\\'])
                        .next()
                        .unwrap_or("");
                    w.worktree == wt || base == wt
                })
                .collect()
        } else {
            live.into_iter().filter(|w| w.agent == group).collect()
        };
        Ok(pick
            .into_iter()
            .map(|w| format!("dispatch:{}", w.dispatch_id))
            .filter(|a| *a != from.address)
            .map(|a| (a, from.run_id.clone()))
            .collect())
    }

    /// Writes a message under a given id; false when that id already exists.
    pub(crate) fn insert_message_with_id(
        &self,
        id: &str,
        run_id: &str,
        from: &str,
        to: &str,
        m: &NewMessage,
        now_ms: i64,
    ) -> Result<bool, OrchError> {
        let payload = match &m.payload {
            Some(p) => Some(serde_json::to_string(p)?),
            None => None,
        };
        let n = self.conn.execute(
            "INSERT OR IGNORE INTO messages
               (id, run_id, from_addr, to_addr, subject, body, kind, priority, thread_id, payload, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id,
                run_id,
                from,
                to,
                m.subject,
                m.body,
                enum_text(&m.kind),
                enum_text(&m.priority),
                m.thread,
                payload,
                now_ms
            ],
        )?;
        Ok(n > 0)
    }

    /// Sends a message from `from` to an address or a group.
    pub fn send(
        &self,
        from: &Identity,
        m: &NewMessage,
        now_ms: i64,
        idle: &dyn Fn(&str) -> bool,
    ) -> Result<SendReceipt, OrchError> {
        if m.body.len() > BODY_MAX {
            return Err(OrchError::new(
                "too_large",
                format!("a message body is at most {BODY_MAX} bytes"),
            ));
        }
        if m.to.starts_with('@')
            && matches!(m.kind, MessageType::WorkerDone | MessageType::Heartbeat)
        {
            return Err(OrchError::bad_request(format!(
                "{} cannot go to a group",
                enum_text(&m.kind)
            )));
        }
        let targets = self.recipients(from, &m.to, idle)?;
        let mut ids = Vec::new();
        let mut to = Vec::new();
        for (address, run) in targets {
            let id = self.next_id("msg");
            self.insert_message_with_id(&id, &run, &from.address, &address, m, now_ms)?;
            ids.push(id);
            to.push(address);
        }
        let next = if from.dispatch.is_some()
            && matches!(m.kind, MessageType::WorkerDone | MessageType::Question)
        {
            NEXT_RECORDED
        } else {
            ""
        };
        Ok(SendReceipt {
            count: ids.len() as u32,
            ids,
            to,
            next: next.to_owned(),
        })
    }

    fn type_filter(types: &[MessageType]) -> String {
        if types.is_empty() {
            return String::new();
        }
        let names: Vec<String> = types
            .iter()
            .map(|t| format!("'{}'", enum_text(t)))
            .collect();
        format!(" AND kind IN ({})", names.join(", "))
    }

    /// How many unread messages wait in `address`.
    pub fn unread_count(&self, address: &str) -> Result<u32, OrchError> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE to_addr = ?1 AND read = 0",
            [address],
            |r| r.get(0),
        )?)
    }

    /// Hands over the oldest messages of `address` (at most [`CHECK_MAX`]) and
    /// marks them handled, unless `peek`.
    pub fn check(
        &self,
        address: &str,
        opts: &CheckOpts,
        now_ms: i64,
    ) -> Result<CheckResult, OrchError> {
        let filter = Store::type_filter(&opts.types);
        let unread = if opts.all { "" } else { " AND read = 0" };
        let where_ = format!("to_addr = ?1{unread}{filter}");
        let mut st = self.conn.prepare(&format!(
            "SELECT {MESSAGE_COLS} FROM messages WHERE {where_} ORDER BY seq LIMIT {CHECK_MAX}"
        ))?;
        let messages = st
            .query_map([address], message_row)?
            .collect::<Result<Vec<_>, _>>()?;
        let total: u32 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM messages WHERE {where_}"),
            [address],
            |r| r.get(0),
        )?;
        if !opts.peek {
            for m in &messages {
                self.conn.execute(
                    "UPDATE messages SET read = 1, delivered_ms = COALESCE(delivered_ms, ?2) WHERE id = ?1",
                    params![m.id, now_ms],
                )?;
            }
        }
        let remaining = total.saturating_sub(messages.len() as u32);
        let rendered = messages
            .iter()
            .map(|m| render(m, &self.display_name(&m.from)))
            .collect();
        let next = if remaining > 0 {
            NEXT_MORE_MAIL
        } else {
            NEXT_IDLE
        };
        Ok(CheckResult {
            messages,
            rendered,
            remaining,
            next: next.to_owned(),
        })
    }

    /// The newest messages of `address`, with short previews.
    pub fn inbox(
        &self,
        address: &str,
        limit: usize,
        full: bool,
    ) -> Result<Vec<InboxRow>, OrchError> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {MESSAGE_COLS} FROM messages WHERE to_addr = ?1 ORDER BY seq DESC LIMIT ?2"
        ))?;
        let rows = st
            .query_map(params![address, limit as i64], message_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|m| InboxRow {
                preview: preview(&m.body, full),
                id: m.id,
                from: m.from,
                subject: m.subject,
                kind: m.kind,
                priority: m.priority,
                read: m.read,
                created_ms: m.created_ms,
            })
            .collect())
    }

    /// One message by id.
    pub fn message_get(&self, id: &str) -> Result<Message, OrchError> {
        self.conn
            .query_row(
                &format!("SELECT {MESSAGE_COLS} FROM messages WHERE id = ?1"),
                [id],
                message_row,
            )
            .optional()?
            .ok_or_else(|| OrchError::not_found(format!("no message {id}")))
    }

    /// Answers a message sent to the caller: the reply goes to the original
    /// sender, in the same thread.
    pub fn reply(
        &self,
        from: &Identity,
        id: &str,
        body: &str,
        now_ms: i64,
    ) -> Result<SendReceipt, OrchError> {
        let orig = self.message_get(id)?;
        if orig.to != from.address {
            return Err(OrchError::not_found(format!(
                "message {id} was not sent to you"
            )));
        }
        let m = NewMessage {
            to: orig.from.clone(),
            kind: MessageType::Status,
            subject: format!("Re: {}", orig.subject),
            body: body.to_owned(),
            priority: orig.priority,
            payload: None,
            thread: Some(orig.thread_id.clone().unwrap_or_else(|| orig.id.clone())),
        };
        let mut receipt = self.send(from, &m, now_ms, &|_| false)?;
        if self.unread_count(&from.address)? > 0 {
            receipt.next = NEXT_FINISH_MAIL.to_owned();
        }
        Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A run with a coordinator tab and three workers: claude in `/wt/a`,
    /// codex in `/wt/b`, and a finished claude in `/wt/c`.
    fn world() -> (Store, Identity) {
        let s = Store::open_in_memory().unwrap();
        let run = s.run_create("o", Some("lead"), 1).unwrap();
        for (d, tab, wt, agent, state) in [
            ("disp_a", "tab_a", "/wt/a", "claude", "ready"),
            ("disp_b", "tab_b", "/wt/b", "codex", "ready"),
            ("disp_c", "tab_c", "/wt/c", "claude", "succeeded"),
        ] {
            s.conn
                .execute_batch(&format!(
                    "INSERT INTO tasks (id, run_id, spec, status, created_ms, updated_ms) VALUES ('t_{d}', '{r}', 's', 'dispatched', 1, 1);
                     INSERT INTO dispatches (id, run_id, task_id, status) VALUES ('{d}', '{r}', 't_{d}', 'dispatched');
                     INSERT INTO workers (dispatch_id, tab, worktree, agent, state, created_ms, updated_ms)
                       VALUES ('{d}', '{tab}', '{wt}', '{agent}', '{state}', 1, 1);",
                    r = run.id
                ))
                .unwrap();
        }
        let lead = s.identity(Some("lead"), None).unwrap();
        (s, lead)
    }

    fn note(to: &str, kind: MessageType, body: &str) -> NewMessage {
        NewMessage {
            to: to.to_owned(),
            kind,
            subject: "subj".to_owned(),
            body: body.to_owned(),
            priority: Priority::Normal,
            payload: None,
            thread: None,
        }
    }

    fn nobody(_: &str) -> bool {
        false
    }

    #[test]
    fn a_workers_tab_acts_as_its_dispatch_and_any_other_as_the_coordinator() {
        let (s, lead) = world();
        assert_eq!(lead.address, format!("run:{}", lead.run_id));
        let w = s.identity(Some("tab_a"), None).unwrap();
        assert_eq!(w.address, "dispatch:disp_a");
        assert_eq!(w.run_id, lead.run_id);
        assert_eq!(w.dispatch.as_deref(), Some("disp_a"));
        assert_eq!(s.identity(None, None).unwrap(), lead);
    }

    #[test]
    fn a_message_goes_to_one_mailbox_and_check_hands_it_over_once() {
        let (s, lead) = world();
        let m = note("dispatch:disp_a", MessageType::Dispatch, "hi");
        let r = s.send(&lead, &m, 5, &nobody).unwrap();
        assert_eq!(r.count, 1);
        let got = s
            .check("dispatch:disp_a", &CheckOpts::default(), 6)
            .unwrap();
        assert_eq!(got.messages.len(), 1);
        assert_eq!(got.messages[0].from, lead.address);
        assert_eq!(got.rendered.len(), 1);
        assert!(got.rendered[0].contains("From: coordinator"));
        assert_eq!(got.remaining, 0);
        assert_eq!(got.next, NEXT_IDLE);
        let again = s
            .check("dispatch:disp_a", &CheckOpts::default(), 7)
            .unwrap();
        assert!(again.messages.is_empty());
        assert_eq!(s.unread_count("dispatch:disp_b").unwrap(), 0);
    }

    #[test]
    fn check_is_fifo_in_batches_of_fifty_and_says_more_is_waiting() {
        let (s, lead) = world();
        for i in 0..53 {
            let m = note("dispatch:disp_a", MessageType::Status, &format!("m{i}"));
            s.send(&lead, &m, 1, &nobody).unwrap();
        }
        let first = s
            .check("dispatch:disp_a", &CheckOpts::default(), 2)
            .unwrap();
        assert_eq!(first.messages.len(), CHECK_MAX);
        assert_eq!(first.messages[0].body, "m0");
        assert_eq!(first.messages[49].body, "m49");
        assert_eq!(first.remaining, 3);
        assert_eq!(first.next, NEXT_MORE_MAIL);
        let rest = s
            .check("dispatch:disp_a", &CheckOpts::default(), 3)
            .unwrap();
        assert_eq!(rest.messages.len(), 3);
        assert_eq!(rest.messages[0].body, "m50");
        assert_eq!(rest.next, NEXT_IDLE);
    }

    #[test]
    fn peek_marks_nothing_all_includes_handled_and_types_filter() {
        let (s, lead) = world();
        for (kind, body) in [(MessageType::Status, "s"), (MessageType::Handoff, "h")] {
            let m = note("dispatch:disp_a", kind, body);
            s.send(&lead, &m, 1, &nobody).unwrap();
        }
        let peek = CheckOpts {
            peek: true,
            ..CheckOpts::default()
        };
        assert_eq!(
            s.check("dispatch:disp_a", &peek, 2).unwrap().messages.len(),
            2
        );
        assert_eq!(
            s.check("dispatch:disp_a", &peek, 2).unwrap().messages.len(),
            2
        );
        let only = CheckOpts {
            types: vec![MessageType::Handoff],
            ..CheckOpts::default()
        };
        let got = s.check("dispatch:disp_a", &only, 3).unwrap();
        assert_eq!(got.messages.len(), 1);
        assert_eq!(got.messages[0].body, "h");
        assert_eq!(s.unread_count("dispatch:disp_a").unwrap(), 1);
        let rest = s
            .check("dispatch:disp_a", &CheckOpts::default(), 4)
            .unwrap();
        assert_eq!(rest.messages.len(), 1);
        let all = CheckOpts {
            all: true,
            peek: true,
            ..CheckOpts::default()
        };
        assert_eq!(
            s.check("dispatch:disp_a", &all, 5).unwrap().messages.len(),
            2
        );
    }

    #[test]
    fn groups_reach_live_workers_but_never_the_sender() {
        let (s, lead) = world();
        let count = |from: &Identity, to: &str, idle: &dyn Fn(&str) -> bool| {
            s.send(from, &note(to, MessageType::Status, "x"), 1, idle)
                .unwrap()
                .count
        };
        // The finished worker (disp_c) is not live.
        assert_eq!(count(&lead, "@all", &nobody), 2);
        let a = s.identity(Some("tab_a"), None).unwrap();
        assert_eq!(count(&a, "@all", &nobody), 1);
        assert_eq!(count(&lead, "@claude", &nobody), 1);
        assert_eq!(count(&lead, "@codex", &nobody), 1);
        assert_eq!(count(&lead, "@worktree:b", &nobody), 1);
        assert_eq!(count(&lead, "@worktree:/wt/a", &nobody), 1);
        assert_eq!(count(&lead, "@idle", &|tab| tab == "tab_b"), 1);
        assert_eq!(count(&lead, "@idle", &nobody), 0);
        assert_eq!(count(&lead, "@nobody", &nobody), 0);
    }

    #[test]
    fn done_and_heartbeat_cannot_go_to_a_group_and_bodies_are_capped() {
        let (s, lead) = world();
        for kind in [MessageType::WorkerDone, MessageType::Heartbeat] {
            let e = s.send(&lead, &note("@all", kind, "x"), 1, &nobody);
            assert_eq!(e.unwrap_err().code, "bad_request");
        }
        let big = "x".repeat(BODY_MAX + 1);
        let m = note("dispatch:disp_a", MessageType::Status, &big);
        assert_eq!(s.send(&lead, &m, 1, &nobody).unwrap_err().code, "too_large");
        let ok = "x".repeat(BODY_MAX);
        let m = note("dispatch:disp_a", MessageType::Status, &ok);
        s.send(&lead, &m, 1, &nobody).unwrap();
        for to in ["dispatch:nope", "run:nope"] {
            let m = note(to, MessageType::Status, "x");
            assert_eq!(s.send(&lead, &m, 1, &nobody).unwrap_err().code, "not_found");
        }
        let m = note("nobody", MessageType::Status, "x");
        assert_eq!(
            s.send(&lead, &m, 1, &nobody).unwrap_err().code,
            "bad_request"
        );
    }

    #[test]
    fn a_worker_report_is_recorded_and_a_reply_goes_back_in_the_thread() {
        let (s, lead) = world();
        let w = s.identity(Some("tab_a"), None).unwrap();
        let mut q = note(&lead.address, MessageType::Question, "which?");
        q.payload = Some(json!({"a": 1}));
        let r = s.send(&w, &q, 1, &nobody).unwrap();
        assert_eq!(r.next, NEXT_RECORDED);
        let got = s.check(&lead.address, &CheckOpts::default(), 2).unwrap();
        let q_id = got.messages[0].id.clone();
        assert!(got.rendered[0].contains("From: worker-t_disp_a (dispatch:disp_a)"));
        assert!(got.rendered[0].contains("Payload: {\"a\":1}"));

        // Only the addressee may reply.
        assert_eq!(s.reply(&w, &q_id, "no", 3).unwrap_err().code, "not_found");
        let rep = s.reply(&lead, &q_id, "sqlite", 3).unwrap();
        assert_eq!(rep.count, 1);
        assert_eq!(rep.next, "");
        let back = s
            .check("dispatch:disp_a", &CheckOpts::default(), 4)
            .unwrap();
        assert_eq!(back.messages[0].body, "sqlite");
        assert_eq!(back.messages[0].subject, "Re: subj");
        assert_eq!(back.messages[0].thread_id.as_deref(), Some(q_id.as_str()));
        assert_eq!(back.messages[0].kind, MessageType::Status);
    }

    #[test]
    fn a_reply_with_mail_left_says_to_finish_it() {
        let (s, lead) = world();
        let w = s.identity(Some("tab_a"), None).unwrap();
        for (kind, body) in [(MessageType::Question, "q1"), (MessageType::Status, "q2")] {
            s.send(&w, &note(&lead.address, kind, body), 1, &nobody)
                .unwrap();
        }
        let only = CheckOpts {
            types: vec![MessageType::Question],
            ..CheckOpts::default()
        };
        let first = s.check(&lead.address, &only, 2).unwrap();
        let rep = s.reply(&lead, &first.messages[0].id, "a", 3).unwrap();
        assert_eq!(rep.next, NEXT_FINISH_MAIL);
    }

    #[test]
    fn inbox_lists_newest_first_with_previews_and_full_text_on_request() {
        let (s, lead) = world();
        let short = note("dispatch:disp_a", MessageType::Status, "short");
        s.send(&lead, &short, 1, &nobody).unwrap();
        let long = "y".repeat(500);
        let m = note("dispatch:disp_a", MessageType::Status, &long);
        s.send(&lead, &m, 2, &nobody).unwrap();
        let rows = s.inbox("dispatch:disp_a", 10, false).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].preview.chars().count(), PREVIEW_CHARS);
        assert!(rows[0].preview.ends_with('…'));
        assert_eq!(rows[1].preview, "short");
        assert_eq!(
            s.inbox("dispatch:disp_a", 1, true).unwrap()[0].preview,
            long
        );
    }
}
