//! Tabs beyond runs: directional links between tabs with their read grants,
//! hand-offs and nudges between tabs (kept as mail, addressed `tab:<id>`),
//! and what Mission Control reads about the workers in tabs.
//!
//! A link `from -> to` lets `from` read `to`, and only through a grant the
//! person turned on: both grants start off. The grants are checked by
//! `xdev-policy` against this store on every read.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::OrchError;
use crate::mail::{BODY_MAX, NewMessage};
use crate::model::{Message, MessageType, Priority, WorkerState};
use crate::store::{MESSAGE_COLS, Store, enum_from, message_row};

/// The prefix of a tab's mail address.
pub const TAB_ADDRESS: &str = "tab:";
/// The sender of what Mission Control types into a tab.
pub const MISSION_ADDRESS: &str = "app:mission";
/// The subject a nudge is recorded under.
pub const NUDGE_SUBJECT: &str = "nudge";
/// The subject a hand-off is recorded under.
pub const HANDOFF_SUBJECT: &str = "handoff";
/// Stuck after this many quiet minutes while busy, unless set otherwise.
pub const STUCK_MINUTES_DEFAULT: u32 = 10;
pub const STUCK_MINUTES_MAX: u32 = 24 * 60;
/// What a nudge types, unless set otherwise.
pub const NUDGE_DEFAULT: &str =
    "Are you stuck? Say in one line what you are waiting for, then carry on.";
/// The longest nudge text.
pub const NUDGE_MAX_CHARS: usize = 500;

const STUCK_KEY: &str = "mission_stuck_minutes";
const NUDGE_KEY: &str = "mission_nudge_prompt";

/// One of the two things a link may let its reader see.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum Grant {
    Transcript,
    Screen,
}

/// A directional link: `from` may read `to` through the grants that are on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TabLink {
    pub from: String,
    pub to: String,
    pub transcript: bool,
    pub screen: bool,
    pub created_ms: i64,
    pub updated_ms: i64,
}

/// What Mission Control is set to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MissionSettings {
    /// A busy tab that printed nothing for this many minutes is stuck.
    pub stuck_minutes: u32,
    /// What a nudge types into the tab.
    pub nudge_prompt: String,
}

impl Default for MissionSettings {
    fn default() -> Self {
        MissionSettings {
            stuck_minutes: STUCK_MINUTES_DEFAULT,
            nudge_prompt: NUDGE_DEFAULT.to_owned(),
        }
    }
}

impl MissionSettings {
    /// The minutes held to 1..=1440; an empty nudge is the default one, a long one is cut.
    pub fn normalized(mut self) -> Self {
        self.stuck_minutes = self.stuck_minutes.clamp(1, STUCK_MINUTES_MAX);
        let text = self.nudge_prompt.trim();
        self.nudge_prompt = if text.is_empty() {
            NUDGE_DEFAULT.to_owned()
        } else {
            text.chars().take(NUDGE_MAX_CHARS).collect()
        };
        self
    }
}

/// The worker in a tab, as Mission Control lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TabWorker {
    pub tab: String,
    pub dispatch_id: String,
    pub run_id: String,
    pub state: WorkerState,
    pub task_id: String,
    pub task_title: Option<String>,
    pub updated_ms: i64,
}

/// The mail address of tab `id`.
pub fn tab_address(id: &str) -> String {
    format!("{TAB_ADDRESS}{id}")
}

/// The text typed into the target of a hand-off: a one-line header naming
/// the sender, then the message.
pub fn handoff_text(sender_title: &str, body: &str) -> String {
    let title: String = sender_title
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    format!("[Handoff from {title}]\n{}", body.trim())
}

const LINK_COLS: &str = "from_tab, to_tab, transcript, screen, created_ms, updated_ms";

fn link_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TabLink> {
    Ok(TabLink {
        from: r.get(0)?,
        to: r.get(1)?,
        transcript: r.get::<_, i64>(2)? != 0,
        screen: r.get::<_, i64>(3)? != 0,
        created_ms: r.get(4)?,
        updated_ms: r.get(5)?,
    })
}

fn check_ends(from: &str, to: &str) -> Result<(), OrchError> {
    if from.trim().is_empty() || to.trim().is_empty() {
        return Err(OrchError::bad_request("a link needs two tabs"));
    }
    if from == to {
        return Err(OrchError::bad_request("a tab cannot be linked to itself"));
    }
    Ok(())
}

impl Store {
    /// The link `from -> to`, if there is one.
    pub fn link_get(&self, from: &str, to: &str) -> Result<Option<TabLink>, OrchError> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {LINK_COLS} FROM tab_links WHERE from_tab = ?1 AND to_tab = ?2"),
                [from, to],
                link_row,
            )
            .optional()?)
    }

    fn link_must(&self, from: &str, to: &str) -> Result<TabLink, OrchError> {
        self.link_get(from, to)?
            .ok_or_else(|| OrchError::not_found(format!("no link {from} -> {to}")))
    }

    /// Every link, oldest first.
    pub fn link_list(&self) -> Result<Vec<TabLink>, OrchError> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {LINK_COLS} FROM tab_links ORDER BY created_ms, rowid"
        ))?;
        Ok(st.query_map([], link_row)?.collect::<Result<Vec<_>, _>>()?)
    }

    /// Links `from -> to` with both grants off; an existing link is kept as it is.
    pub fn link_put(&self, from: &str, to: &str, now_ms: i64) -> Result<TabLink, OrchError> {
        check_ends(from, to)?;
        self.conn.execute(
            "INSERT OR IGNORE INTO tab_links (from_tab, to_tab, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?3)",
            params![from, to, now_ms],
        )?;
        self.link_must(from, to)
    }

    /// Turns one grant of `from -> to` on or off.
    pub fn link_set_grant(
        &self,
        from: &str,
        to: &str,
        grant: Grant,
        on: bool,
        now_ms: i64,
    ) -> Result<TabLink, OrchError> {
        let col = match grant {
            Grant::Transcript => "transcript",
            Grant::Screen => "screen",
        };
        let n = self.conn.execute(
            &format!(
                "UPDATE tab_links SET {col} = ?3, updated_ms = ?4
                 WHERE from_tab = ?1 AND to_tab = ?2"
            ),
            params![from, to, i64::from(on), now_ms],
        )?;
        if n == 0 {
            return Err(OrchError::not_found(format!("no link {from} -> {to}")));
        }
        self.link_must(from, to)
    }

    /// Points `from -> to` at `new_to` instead. The grants were given for the
    /// old target, so the new link starts with both off.
    pub fn link_retarget(
        &self,
        from: &str,
        to: &str,
        new_to: &str,
        now_ms: i64,
    ) -> Result<TabLink, OrchError> {
        check_ends(from, new_to)?;
        self.atomic(|s| {
            s.link_must(from, to)?;
            if to == new_to {
                return s.link_must(from, to);
            }
            if s.link_get(from, new_to)?.is_some() {
                return Err(OrchError::new(
                    "conflict",
                    format!("{from} is already linked to {new_to}"),
                ));
            }
            s.conn.execute(
                "UPDATE tab_links SET to_tab = ?3, transcript = 0, screen = 0, updated_ms = ?4
                 WHERE from_tab = ?1 AND to_tab = ?2",
                params![from, to, new_to, now_ms],
            )?;
            s.link_must(from, new_to)
        })
    }

    /// Removes the link `from -> to`; false when there was none.
    pub fn link_remove(&self, from: &str, to: &str) -> Result<bool, OrchError> {
        Ok(self.conn.execute(
            "DELETE FROM tab_links WHERE from_tab = ?1 AND to_tab = ?2",
            [from, to],
        )? > 0)
    }

    /// Removes every link with an end that is no longer open; returns them.
    pub fn links_prune(&self, open: &dyn Fn(&str) -> bool) -> Result<Vec<TabLink>, OrchError> {
        let gone: Vec<TabLink> = self
            .link_list()?
            .into_iter()
            .filter(|l| !open(&l.from) || !open(&l.to))
            .collect();
        for l in &gone {
            self.link_remove(&l.from, &l.to)?;
        }
        Ok(gone)
    }

    /// Mission Control's settings; the defaults for what was never set.
    pub fn mission_settings(&self) -> Result<MissionSettings, OrchError> {
        let d = MissionSettings::default();
        let minutes = self
            .meta_get(STUCK_KEY)?
            .and_then(|m| u32::try_from(m).ok())
            .unwrap_or(d.stuck_minutes);
        let nudge: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM meta_text WHERE key = ?1",
                [NUDGE_KEY],
                |r| r.get(0),
            )
            .optional()?;
        Ok(MissionSettings {
            stuck_minutes: minutes,
            nudge_prompt: nudge.unwrap_or(d.nudge_prompt),
        }
        .normalized())
    }

    /// Stores Mission Control's settings, normalized, and returns them.
    pub fn mission_settings_put(&self, s: MissionSettings) -> Result<MissionSettings, OrchError> {
        let s = s.normalized();
        self.atomic(|st| {
            st.meta_set(STUCK_KEY, Some(i64::from(s.stuck_minutes)))?;
            st.conn.execute(
                "INSERT INTO meta_text (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![NUDGE_KEY, s.nudge_prompt],
            )?;
            Ok(())
        })?;
        Ok(s)
    }

    /// Records text the app typed into tab `to` (a hand-off or a nudge) as
    /// mail, already handed over: the wake pump never points at it.
    pub fn tab_note(
        &self,
        from: &str,
        to_tab: &str,
        kind: MessageType,
        subject: &str,
        body: &str,
        now_ms: i64,
    ) -> Result<Message, OrchError> {
        if body.len() > BODY_MAX {
            return Err(OrchError::new(
                "too_large",
                format!("a message body is at most {BODY_MAX} bytes"),
            ));
        }
        if body.trim().is_empty() {
            return Err(OrchError::bad_request("nothing to send"));
        }
        let to = tab_address(to_tab);
        let msg = NewMessage {
            to: to.clone(),
            kind,
            subject: subject.to_owned(),
            body: body.to_owned(),
            priority: Priority::Normal,
            payload: None,
            thread: None,
        };
        let id = self.next_id("msg");
        self.atomic(|s| {
            s.insert_message_with_id(&id, "", from, &to, &msg, now_ms)?;
            s.conn.execute(
                "UPDATE messages SET read = 1, delivered_ms = ?2 WHERE id = ?1",
                params![id, now_ms],
            )?;
            s.message_get(&id)
        })
    }

    /// Records a hand-off from tab `from` to tab `to`.
    pub fn handoff(
        &self,
        from: &str,
        to: &str,
        body: &str,
        now_ms: i64,
    ) -> Result<Message, OrchError> {
        check_ends(from, to)?;
        self.tab_note(
            &tab_address(from),
            to,
            MessageType::Handoff,
            HANDOFF_SUBJECT,
            body,
            now_ms,
        )
    }

    /// Records a nudge from Mission Control to tab `to`.
    pub fn nudge(&self, to: &str, body: &str, now_ms: i64) -> Result<Message, OrchError> {
        self.tab_note(
            MISSION_ADDRESS,
            to,
            MessageType::Status,
            NUDGE_SUBJECT,
            body,
            now_ms,
        )
    }

    /// The newest `limit` messages to or from tab `tab` or a worker in it, oldest first.
    pub fn tab_messages(&self, tab: &str, limit: usize) -> Result<Vec<Message>, OrchError> {
        let mut addresses = vec![tab_address(tab)];
        let mut st = self
            .conn
            .prepare("SELECT dispatch_id FROM workers WHERE tab = ?1")?;
        for d in st.query_map([tab], |r| r.get::<_, String>(0))? {
            addresses.push(format!("dispatch:{}", d?));
        }
        let marks = vec!["?"; addresses.len()].join(", ");
        let sql = format!(
            "SELECT {MESSAGE_COLS} FROM messages
             WHERE to_addr IN ({marks}) OR from_addr IN ({marks})
             ORDER BY seq DESC LIMIT {limit}"
        );
        let mut st = self.conn.prepare(&sql)?;
        let args: Vec<&dyn rusqlite::ToSql> = addresses
            .iter()
            .chain(addresses.iter())
            .map(|a| a as &dyn rusqlite::ToSql)
            .collect();
        let mut out = st
            .query_map(args.as_slice(), message_row)?
            .collect::<Result<Vec<_>, _>>()?;
        out.reverse();
        Ok(out)
    }

    /// When tab `tab` was last nudged, as `(epoch ms, text)`.
    pub fn last_nudge(&self, tab: &str) -> Result<Option<(i64, String)>, OrchError> {
        Ok(self
            .conn
            .query_row(
                "SELECT created_ms, body FROM messages
                 WHERE to_addr = ?1 AND from_addr = ?2 AND subject = ?3
                 ORDER BY seq DESC LIMIT 1",
                params![tab_address(tab), MISSION_ADDRESS, NUDGE_SUBJECT],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }

    /// The workers that sit in a tab and have not finished, with their task.
    pub fn tab_workers(&self) -> Result<Vec<TabWorker>, OrchError> {
        let mut st = self.conn.prepare(
            "SELECT w.tab, w.dispatch_id, d.run_id, w.state, d.task_id, t.title, w.updated_ms
             FROM workers w
             JOIN dispatches d ON d.id = w.dispatch_id
             LEFT JOIN tasks t ON t.id = d.task_id
             WHERE w.tab IS NOT NULL
               AND w.state NOT IN ('succeeded', 'failed', 'stopped', 'abandoned')
             ORDER BY w.created_ms, w.rowid",
        )?;
        let rows = st.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (tab, dispatch_id, run_id, state, task_id, task_title, updated_ms) = row?;
            out.push(TabWorker {
                tab,
                dispatch_id,
                run_id,
                state: enum_from(&state)?,
                task_id,
                task_title,
                updated_ms,
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::NewTask;
    use crate::workers::StartPlan;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn a_new_link_has_both_grants_off() {
        let s = store();
        let l = s.link_put("a", "b", 5).unwrap();
        assert!(!l.transcript && !l.screen);
        assert_eq!(
            (l.from.as_str(), l.to.as_str(), l.created_ms),
            ("a", "b", 5)
        );
    }

    #[test]
    fn linking_again_keeps_the_grants() {
        let s = store();
        s.link_put("a", "b", 1).unwrap();
        s.link_set_grant("a", "b", Grant::Transcript, true, 2)
            .unwrap();
        let l = s.link_put("a", "b", 3).unwrap();
        assert!(l.transcript);
        assert_eq!(s.link_list().unwrap().len(), 1);
    }

    #[test]
    fn a_tab_cannot_link_to_itself() {
        let s = store();
        assert_eq!(s.link_put("a", "a", 1).unwrap_err().code, "bad_request");
        assert_eq!(s.link_put("", "a", 1).unwrap_err().code, "bad_request");
    }

    #[test]
    fn grants_turn_on_and_off_and_persist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("o.db");
        {
            let s = Store::open(&path).unwrap();
            s.link_put("a", "b", 1).unwrap();
            let l = s
                .link_set_grant("a", "b", Grant::Transcript, true, 2)
                .unwrap();
            assert!(l.transcript && !l.screen);
            assert_eq!(l.updated_ms, 2);
        }
        let s = Store::open(&path).unwrap();
        let l = s.link_get("a", "b").unwrap().unwrap();
        assert!(l.transcript && !l.screen);
        let l = s
            .link_set_grant("a", "b", Grant::Transcript, false, 3)
            .unwrap();
        assert!(!l.transcript);
    }

    #[test]
    fn a_grant_on_a_missing_link_is_not_found() {
        let s = store();
        let e = s
            .link_set_grant("a", "b", Grant::Screen, true, 1)
            .unwrap_err();
        assert_eq!(e.code, "not_found");
    }

    #[test]
    fn a_link_is_directional() {
        let s = store();
        s.link_put("a", "b", 1).unwrap();
        assert!(s.link_get("b", "a").unwrap().is_none());
        s.link_put("b", "a", 2).unwrap();
        assert_eq!(s.link_list().unwrap().len(), 2);
    }

    #[test]
    fn retargeting_resets_the_grants() {
        let s = store();
        s.link_put("a", "b", 1).unwrap();
        s.link_set_grant("a", "b", Grant::Screen, true, 2).unwrap();
        let l = s.link_retarget("a", "b", "c", 3).unwrap();
        assert_eq!(l.to, "c");
        assert!(!l.screen && !l.transcript);
        assert!(s.link_get("a", "b").unwrap().is_none());
    }

    #[test]
    fn retargeting_onto_an_existing_link_is_refused() {
        let s = store();
        s.link_put("a", "b", 1).unwrap();
        s.link_put("a", "c", 1).unwrap();
        assert_eq!(
            s.link_retarget("a", "b", "c", 2).unwrap_err().code,
            "conflict"
        );
        assert_eq!(
            s.link_retarget("a", "b", "a", 2).unwrap_err().code,
            "bad_request"
        );
        assert!(s.link_get("a", "b").unwrap().is_some());
    }

    #[test]
    fn links_to_closed_tabs_are_pruned() {
        let s = store();
        s.link_put("a", "b", 1).unwrap();
        s.link_put("c", "a", 1).unwrap();
        s.link_put("a", "d", 1).unwrap();
        let gone = s.links_prune(&|t| t != "b" && t != "c").unwrap();
        assert_eq!(gone.len(), 2);
        let left: Vec<_> = s.link_list().unwrap().into_iter().map(|l| l.to).collect();
        assert_eq!(left, ["d"]);
    }

    #[test]
    fn removing_a_link_says_whether_there_was_one() {
        let s = store();
        s.link_put("a", "b", 1).unwrap();
        assert!(s.link_remove("a", "b").unwrap());
        assert!(!s.link_remove("a", "b").unwrap());
    }

    #[test]
    fn mission_settings_default_then_persist_normalized() {
        let s = store();
        assert_eq!(s.mission_settings().unwrap(), MissionSettings::default());
        let put = s
            .mission_settings_put(MissionSettings {
                stuck_minutes: 0,
                nudge_prompt: "  keep going  ".into(),
            })
            .unwrap();
        assert_eq!(put.stuck_minutes, 1);
        assert_eq!(put.nudge_prompt, "keep going");
        assert_eq!(s.mission_settings().unwrap(), put);
        let blank = s
            .mission_settings_put(MissionSettings {
                stuck_minutes: 99_999,
                nudge_prompt: " ".into(),
            })
            .unwrap();
        assert_eq!(blank.stuck_minutes, STUCK_MINUTES_MAX);
        assert_eq!(blank.nudge_prompt, NUDGE_DEFAULT);
    }

    #[test]
    fn a_nudge_is_recorded_as_handled_mail() {
        let s = store();
        let m = s.nudge("t1", "go on", 7).unwrap();
        assert_eq!(m.to, "tab:t1");
        assert_eq!(m.from, MISSION_ADDRESS);
        assert!(m.read);
        assert_eq!(m.delivered_ms, Some(7));
        assert_eq!(s.last_nudge("t1").unwrap(), Some((7, "go on".to_owned())));
        assert_eq!(s.last_nudge("t2").unwrap(), None);
        // Handled mail never wakes anyone.
        assert!(s.wake_targets().unwrap().is_empty());
        assert_eq!(s.nudge("t1", "  ", 8).unwrap_err().code, "bad_request");
    }

    #[test]
    fn a_handoff_is_mail_between_two_tabs() {
        let s = store();
        let m = s.handoff("a", "b", "please review", 3).unwrap();
        assert_eq!((m.from.as_str(), m.to.as_str()), ("tab:a", "tab:b"));
        assert_eq!(m.kind, MessageType::Handoff);
        assert_eq!(s.tab_messages("b", 10).unwrap().len(), 1);
        assert_eq!(s.tab_messages("a", 10).unwrap().len(), 1);
        assert!(s.tab_messages("c", 10).unwrap().is_empty());
        assert_eq!(s.handoff("a", "a", "x", 3).unwrap_err().code, "bad_request");
    }

    #[test]
    fn tab_messages_keep_the_newest_oldest_first() {
        let s = store();
        for i in 0..5 {
            s.nudge("t", &format!("n{i}"), i).unwrap();
        }
        let got: Vec<_> = s
            .tab_messages("t", 2)
            .unwrap()
            .into_iter()
            .map(|m| m.body)
            .collect();
        assert_eq!(got, ["n3", "n4"]);
    }

    #[test]
    fn the_handoff_header_names_the_sender_on_one_line() {
        assert_eq!(
            handoff_text("Lead\nagent", "  do it \n"),
            "[Handoff from Leadagent]\ndo it"
        );
    }

    #[test]
    fn tab_workers_list_live_workers_with_their_task() {
        let s = store();
        let run = s.run_create("ship", Some("lead"), 1).unwrap();
        let task = s
            .task_create(
                &run.id,
                NewTask {
                    title: Some("Write tests".into()),
                    spec: "spec".into(),
                    deps: vec![],
                    parent: None,
                },
                1,
            )
            .unwrap();
        let plan = StartPlan {
            run_id: run.id.clone(),
            task_id: task.id.clone(),
            parent_dispatch: None,
            depth: 1,
            retry_of: None,
            tab: "t9".into(),
            worktree: "/w".into(),
            agent: "claude".into(),
            kept: false,
        };
        s.worker_begin(&plan, 2).unwrap();
        let list = s.tab_workers().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].tab, "t9");
        assert_eq!(list[0].task_title.as_deref(), Some("Write tests"));
    }
}
