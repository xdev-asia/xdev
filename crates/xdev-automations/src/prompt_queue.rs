//! The per-tab prompt queue: the stored shapes and the pure due-time logic. The desktop app owns
//! the file, the tick and the tabs; this module only says what is due, and does nothing itself.
//!
//! Prompts of one tab run in list order and one at a time. A send that is not confirmed pauses the
//! tab: later prompts wait until the person retries or skips it.

use serde::{Deserialize, Serialize};

/// Items one tab may hold.
pub const MAX_ITEMS_PER_TAB: usize = 50;
/// The largest prompt, in bytes.
pub const MAX_PROMPT_BYTES: usize = 16 * 1024;
/// How often a wait for a quota with no known reset looks at the quota.
pub const QUOTA_POLL_MS: i64 = 300_000;

/// When an item is sent, as the person asks for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(rename = "PromptQueueWhenInput"))]
pub enum WhenInput {
    /// A local date and time, as epoch milliseconds.
    #[serde(rename_all = "camelCase")]
    At { at: i64 },
    #[serde(rename_all = "camelCase")]
    InMinutes { minutes: u32 },
    /// When the 5-hour window of the quota `quota` resets; `reset_at` is the reset the UI knows of.
    #[serde(rename_all = "camelCase")]
    AfterReset {
        quota: Option<String>,
        reset_at: Option<i64>,
    },
    /// When the tab's agent is not busy.
    Idle,
}

/// When an item is sent, as it is stored: minutes are already a time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(rename = "PromptQueueWhen"))]
pub enum When {
    #[serde(rename_all = "camelCase")]
    At {
        at: i64,
    },
    #[serde(rename_all = "camelCase")]
    AfterReset {
        quota: Option<String>,
        /// The reset time; `None` while unknown, and the quota is looked at every `QUOTA_POLL_MS`.
        reset_at: Option<i64>,
        /// The next look at the quota, while the reset is unknown.
        next_check_at: i64,
    },
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(rename = "PromptQueueStatus"))]
pub enum Status {
    Waiting,
    /// Handed to the window; its verified send is running.
    Sending,
    /// The send was not confirmed. The tab's queue is paused.
    Unconfirmed,
    /// The send failed. The tab's queue is paused.
    Failed,
    /// The tab was gone when the item was due; it was not sent.
    TabClosed,
}

impl Status {
    /// A failed send holds the rest of its tab's queue.
    pub fn pauses(self) -> bool {
        matches!(self, Self::Unconfirmed | Self::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename = "PromptQueueItem"))]
pub struct Item {
    pub id: String,
    pub tab_id: String,
    pub text: String,
    pub when: When,
    pub status: Status,
    /// "Send now" or Retry: due whatever `when` says.
    #[serde(default)]
    pub forced: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename = "PromptQueueNew"))]
pub struct NewItem {
    pub tab_id: String,
    pub text: String,
    pub when: WhenInput,
}

/// What the window reports of a send.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(rename = "PromptQueueReport"))]
pub enum SendReport {
    Sent,
    Unconfirmed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum QueueError {
    #[error("no such item")]
    NotFound,
    #[error("the prompt is empty")]
    Empty,
    #[error("the prompt is over {MAX_PROMPT_BYTES} bytes")]
    TooLarge,
    #[error("the tab already holds {MAX_ITEMS_PER_TAB} prompts")]
    TooMany,
    #[error("the prompt is being sent")]
    Busy,
}

/// A live tab, as the window last reported it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename = "PromptQueueTabFact"))]
pub struct TabFact {
    pub id: String,
    /// The agent is not busy (a shell is always idle).
    pub idle: bool,
}

/// The 5-hour window of one account or provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename = "PromptQueueQuotaFact"))]
pub struct QuotaFact {
    pub name: String,
    pub resets_at: Option<i64>,
    /// Percent used; `None` when unknown.
    pub utilization: Option<f64>,
}

/// What only the window knows. Until it has reported (`ready`), nothing is due.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename = "PromptQueueFacts"))]
pub struct Facts {
    pub ready: bool,
    pub tabs: Vec<TabFact>,
    pub quotas: Vec<QuotaFact>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Fire {
        id: String,
    },
    TabClosed {
        id: String,
    },
    /// The quota was looked at and is not open yet.
    Recheck {
        id: String,
        next_check_at: i64,
    },
    /// The quota now shows when it resets.
    LearnReset {
        id: String,
        reset_at: i64,
    },
}

/// The queue: every tab's items, in one list. The order inside a tab is the list order.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Queue {
    pub items: Vec<Item>,
}

enum Due {
    Yes,
    No,
    Recheck(i64),
}

fn quota_of<'a>(facts: &'a Facts, name: &Option<String>) -> Option<&'a QuotaFact> {
    match name {
        Some(n) => facts.quotas.iter().find(|q| &q.name == n),
        None => facts.quotas.first(),
    }
}

/// Whether `item` is due, and what to learn on the way.
fn due(item: &Item, facts: &Facts, now: i64, steps: &mut Vec<Step>) -> Due {
    if item.forced {
        return Due::Yes;
    }
    match &item.when {
        When::At { at } => {
            if now >= *at {
                Due::Yes
            } else {
                Due::No
            }
        }
        // A tab that is gone counts as due, so the item ends as "Tab closed" and does not wait for ever.
        When::Idle => match facts.tabs.iter().find(|t| t.id == item.tab_id) {
            None => Due::Yes,
            Some(t) if t.idle => Due::Yes,
            Some(_) => Due::No,
        },
        When::AfterReset {
            quota,
            reset_at,
            next_check_at,
        } => {
            let fact = quota_of(facts, quota);
            let known = reset_at.or_else(|| fact.and_then(|f| f.resets_at));
            if let Some(reset) = known {
                if reset_at.is_none() {
                    steps.push(Step::LearnReset {
                        id: item.id.clone(),
                        reset_at: reset,
                    });
                }
                return if now >= reset { Due::Yes } else { Due::No };
            }
            if now < *next_check_at {
                return Due::No;
            }
            match fact.and_then(|f| f.utilization) {
                Some(u) if u < 100.0 => Due::Yes,
                _ => Due::Recheck(now + QUOTA_POLL_MS),
            }
        }
    }
}

/// What a step does to its item.
type Edit = Box<dyn FnOnce(&mut Item)>;

impl Queue {
    pub fn tab_items(&self, tab_id: &str) -> impl Iterator<Item = &Item> {
        self.items.iter().filter(move |i| i.tab_id == tab_id)
    }

    fn find(&self, id: &str) -> Result<usize, QueueError> {
        self.items
            .iter()
            .position(|i| i.id == id)
            .ok_or(QueueError::NotFound)
    }

    fn check_text(text: &str) -> Result<(), QueueError> {
        if text.trim().is_empty() {
            Err(QueueError::Empty)
        } else if text.len() > MAX_PROMPT_BYTES {
            Err(QueueError::TooLarge)
        } else {
            Ok(())
        }
    }

    /// Resolves what the person asked for into what is stored.
    pub fn resolve(when: WhenInput, now: i64) -> When {
        match when {
            WhenInput::At { at } => When::At { at },
            WhenInput::InMinutes { minutes } => When::At {
                at: now.saturating_add(i64::from(minutes) * 60_000),
            },
            WhenInput::AfterReset { quota, reset_at } => When::AfterReset {
                quota,
                reset_at,
                next_check_at: now,
            },
            WhenInput::Idle => When::Idle,
        }
    }

    /// Adds an item at the end of its tab's queue.
    pub fn add(&mut self, new: NewItem, now: i64, id: String) -> Result<Item, QueueError> {
        Self::check_text(&new.text)?;
        if self.tab_items(&new.tab_id).count() >= MAX_ITEMS_PER_TAB {
            return Err(QueueError::TooMany);
        }
        let item = Item {
            id,
            tab_id: new.tab_id,
            text: new.text,
            when: Self::resolve(new.when, now),
            status: Status::Waiting,
            forced: false,
            created_at: now,
        };
        self.items.push(item.clone());
        Ok(item)
    }

    /// Changes the text and when of an item that is not being sent. An item that failed stays paused
    /// until it is retried.
    pub fn update(
        &mut self,
        id: &str,
        text: String,
        when: WhenInput,
        now: i64,
    ) -> Result<Item, QueueError> {
        let at = self.find(id)?;
        if self.items[at].status == Status::Sending {
            return Err(QueueError::Busy);
        }
        Self::check_text(&text)?;
        let item = &mut self.items[at];
        item.text = text;
        item.when = Self::resolve(when, now);
        item.forced = false;
        if item.status == Status::TabClosed {
            item.status = Status::Waiting;
        }
        Ok(item.clone())
    }

    /// Removes an item that is not being sent. This is also "Skip" for one that failed.
    pub fn delete(&mut self, id: &str) -> Result<(), QueueError> {
        let at = self.find(id)?;
        if self.items[at].status == Status::Sending {
            return Err(QueueError::Busy);
        }
        self.items.remove(at);
        Ok(())
    }

    /// Moves an item one place up (`delta < 0`) or down in its tab's queue; the edges stay.
    pub fn reorder(&mut self, id: &str, delta: i32) -> Result<(), QueueError> {
        let at = self.find(id)?;
        let tab = self.items[at].tab_id.clone();
        let mut positions: Vec<usize> = (0..self.items.len())
            .filter(|&i| self.items[i].tab_id == tab)
            .collect();
        let me = positions.iter().position(|&p| p == at).unwrap_or(0);
        let to = me as i64 + i64::from(delta.signum());
        if to < 0 || to >= positions.len() as i64 {
            return Ok(());
        }
        let other = positions.swap_remove(to as usize);
        self.items.swap(at, other);
        Ok(())
    }

    /// Makes an item due now, whatever `when` says; also Retry for one that failed. The tab's
    /// other items still wait for it.
    pub fn send_now(&mut self, id: &str) -> Result<Item, QueueError> {
        let at = self.find(id)?;
        let item = &mut self.items[at];
        if item.status == Status::Sending {
            return Err(QueueError::Busy);
        }
        item.status = Status::Waiting;
        item.forced = true;
        Ok(item.clone())
    }

    /// The window's report of a send: a sent item leaves the queue, any other pauses its tab.
    pub fn report(&mut self, id: &str, report: SendReport) -> Result<(), QueueError> {
        let at = self.find(id)?;
        match report {
            SendReport::Sent => {
                self.items.remove(at);
            }
            SendReport::Unconfirmed | SendReport::Failed => {
                let item = &mut self.items[at];
                item.forced = false;
                item.status = if report == SendReport::Failed {
                    Status::Failed
                } else {
                    Status::Unconfirmed
                };
            }
        }
        Ok(())
    }

    /// After a restart no window is sending: what was in flight may or may not have gone, so it
    /// pauses its tab for the person to decide.
    pub fn recover(&mut self) -> bool {
        let mut changed = false;
        for item in &mut self.items {
            if item.status == Status::Sending {
                item.status = Status::Unconfirmed;
                changed = true;
            }
        }
        changed
    }

    /// Drops every item of tabs not in `keep`; the ids dropped. For tidying, not for the tick.
    pub fn drop_tabs_not_in(&mut self, keep: &[&str]) -> Vec<String> {
        let (kept, gone): (Vec<Item>, Vec<Item>) = std::mem::take(&mut self.items)
            .into_iter()
            .partition(|i| keep.contains(&i.tab_id.as_str()));
        self.items = kept;
        gone.into_iter().map(|i| i.id).collect()
    }

    /// What to do at `now`, per tab in list order:
    /// - a tab with an item being sent does nothing;
    /// - otherwise an item the person forced goes first;
    /// - otherwise the first item that is not "Tab closed" goes when it is due, unless it failed (the
    ///   tab is paused).
    ///
    /// A due item whose tab is not live ends as "Tab closed". Without a ready window, nothing happens.
    pub fn plan(&self, facts: &Facts, now: i64) -> Vec<Step> {
        let mut steps = Vec::new();
        if !facts.ready {
            return steps;
        }
        let mut seen: Vec<&str> = Vec::new();
        for first in &self.items {
            let tab = first.tab_id.as_str();
            if seen.contains(&tab) {
                continue;
            }
            seen.push(tab);
            if self.tab_items(tab).any(|i| i.status == Status::Sending) {
                continue;
            }
            let forced = self
                .tab_items(tab)
                .find(|i| i.forced && i.status == Status::Waiting);
            let head =
                forced.or_else(|| self.tab_items(tab).find(|i| i.status != Status::TabClosed));
            let Some(item) = head else { continue };
            if item.status != Status::Waiting {
                continue;
            }
            let live = facts.tabs.iter().any(|t| t.id == tab);
            match due(item, facts, now, &mut steps) {
                Due::No => {}
                Due::Recheck(next_check_at) => steps.push(Step::Recheck {
                    id: item.id.clone(),
                    next_check_at,
                }),
                Due::Yes if live => steps.push(Step::Fire {
                    id: item.id.clone(),
                }),
                Due::Yes => steps.push(Step::TabClosed {
                    id: item.id.clone(),
                }),
            }
        }
        steps
    }

    /// Carries out `steps` from `plan`; true when anything changed.
    pub fn apply(&mut self, steps: &[Step]) -> bool {
        let mut changed = false;
        for step in steps {
            let (id, edit): (&str, Edit) = match step {
                Step::Fire { id } => (
                    id,
                    Box::new(|i| {
                        i.status = Status::Sending;
                        i.forced = false;
                    }),
                ),
                Step::TabClosed { id } => (
                    id,
                    Box::new(|i| {
                        i.status = Status::TabClosed;
                        i.forced = false;
                    }),
                ),
                Step::Recheck { id, next_check_at } => {
                    let next = *next_check_at;
                    (
                        id,
                        Box::new(move |i| {
                            if let When::AfterReset { next_check_at, .. } = &mut i.when {
                                *next_check_at = next;
                            }
                        }),
                    )
                }
                Step::LearnReset { id, reset_at } => {
                    let learned = *reset_at;
                    (
                        id,
                        Box::new(move |i| {
                            if let When::AfterReset { reset_at, .. } = &mut i.when {
                                *reset_at = Some(learned);
                            }
                        }),
                    )
                }
            };
            if let Some(item) = self.items.iter_mut().find(|i| i.id == id) {
                edit(item);
                changed = true;
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_000_000;
    const MIN: i64 = 60_000;

    fn new(tab: &str, text: &str, when: WhenInput) -> NewItem {
        NewItem {
            tab_id: tab.into(),
            text: text.into(),
            when,
        }
    }

    fn facts(tabs: &[(&str, bool)], quotas: Vec<QuotaFact>) -> Facts {
        Facts {
            ready: true,
            tabs: tabs
                .iter()
                .map(|(id, idle)| TabFact {
                    id: (*id).into(),
                    idle: *idle,
                })
                .collect(),
            quotas,
        }
    }

    fn quota(reset: Option<i64>, used: Option<f64>) -> QuotaFact {
        QuotaFact {
            name: "main".into(),
            resets_at: reset,
            utilization: used,
        }
    }

    fn queue(items: Vec<(&str, &str, WhenInput)>) -> Queue {
        let mut q = Queue::default();
        for (n, (tab, text, when)) in items.into_iter().enumerate() {
            q.add(new(tab, text, when), T0, format!("i{n}")).unwrap();
        }
        q
    }

    fn fires(q: &Queue, f: &Facts, now: i64) -> Vec<String> {
        q.plan(f, now)
            .into_iter()
            .filter_map(|s| match s {
                Step::Fire { id } => Some(id),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn at_a_time_is_due_from_that_time() {
        let q = queue(vec![("a", "x", WhenInput::At { at: T0 + 5 * MIN })]);
        let f = facts(&[("a", true)], vec![]);
        assert!(fires(&q, &f, T0 + 5 * MIN - 1).is_empty());
        assert_eq!(fires(&q, &f, T0 + 5 * MIN), ["i0"]);
        assert_eq!(fires(&q, &f, T0 + 9 * MIN), ["i0"]);
    }

    #[test]
    fn in_n_minutes_counts_from_when_it_was_queued() {
        let q = queue(vec![("a", "x", WhenInput::InMinutes { minutes: 10 })]);
        assert_eq!(q.items[0].when, When::At { at: T0 + 10 * MIN });
        let f = facts(&[("a", true)], vec![]);
        assert!(fires(&q, &f, T0 + 9 * MIN).is_empty());
        assert_eq!(fires(&q, &f, T0 + 10 * MIN), ["i0"]);
        // In 0 minutes is due at once.
        let now = queue(vec![("a", "x", WhenInput::InMinutes { minutes: 0 })]);
        assert_eq!(fires(&now, &f, T0), ["i0"]);
    }

    fn after_reset(reset_at: Option<i64>) -> WhenInput {
        WhenInput::AfterReset {
            quota: Some("main".into()),
            reset_at,
        }
    }

    #[test]
    fn after_a_known_reset_waits_for_it() {
        let q = queue(vec![("a", "x", after_reset(Some(T0 + 60 * MIN)))]);
        // Whatever the quota shows now, the reset time is what counts.
        let f = facts(
            &[("a", true)],
            vec![quota(Some(T0 + 60 * MIN), Some(100.0))],
        );
        assert!(fires(&q, &f, T0 + 59 * MIN).is_empty());
        assert!(q.plan(&f, T0 + 59 * MIN).is_empty());
        assert_eq!(fires(&q, &f, T0 + 60 * MIN), ["i0"]);
    }

    #[test]
    fn a_reset_that_is_already_past_is_due_at_once() {
        let q = queue(vec![("a", "x", after_reset(Some(T0 - MIN)))]);
        let f = facts(&[("a", true)], vec![quota(None, Some(100.0))]);
        assert_eq!(fires(&q, &f, T0), ["i0"]);
    }

    #[test]
    fn an_unknown_reset_polls_for_the_quota_to_drop_below_100() {
        let mut q = queue(vec![("a", "x", after_reset(None))]);
        let full = facts(&[("a", true)], vec![quota(None, Some(100.0))]);
        // Looked at once, still full: the next look is 5 minutes on.
        let steps = q.plan(&full, T0);
        assert_eq!(
            steps,
            [Step::Recheck {
                id: "i0".into(),
                next_check_at: T0 + QUOTA_POLL_MS
            }]
        );
        assert!(q.apply(&steps));
        // Not looked at before then, even if the quota dropped.
        let open = facts(&[("a", true)], vec![quota(None, Some(40.0))]);
        assert!(q.plan(&open, T0 + QUOTA_POLL_MS - 1).is_empty());
        assert_eq!(fires(&q, &open, T0 + QUOTA_POLL_MS), ["i0"]);
        // An unknown quota is not open.
        let unknown = facts(&[("a", true)], vec![quota(None, None)]);
        assert!(fires(&q, &unknown, T0 + QUOTA_POLL_MS).is_empty());
    }

    #[test]
    fn a_reset_the_quota_learns_of_is_kept() {
        let mut q = queue(vec![("a", "x", after_reset(None))]);
        let f = facts(
            &[("a", true)],
            vec![quota(Some(T0 + 30 * MIN), Some(100.0))],
        );
        let steps = q.plan(&f, T0);
        assert_eq!(
            steps,
            [Step::LearnReset {
                id: "i0".into(),
                reset_at: T0 + 30 * MIN
            }]
        );
        q.apply(&steps);
        // The window rolled over: its next reset is 5 hours away, but the one waited for has come.
        let later = facts(&[("a", true)], vec![quota(Some(T0 + 330 * MIN), Some(3.0))]);
        assert_eq!(fires(&q, &later, T0 + 31 * MIN), ["i0"]);
    }

    #[test]
    fn idle_waits_for_the_agent_to_stop() {
        let q = queue(vec![("a", "x", WhenInput::Idle)]);
        assert!(fires(&q, &facts(&[("a", false)], vec![]), T0).is_empty());
        assert_eq!(fires(&q, &facts(&[("a", true)], vec![]), T0), ["i0"]);
    }

    #[test]
    fn nothing_is_due_before_the_window_reports() {
        let q = queue(vec![("a", "x", WhenInput::InMinutes { minutes: 0 })]);
        assert!(q.plan(&Facts::default(), T0 + MIN).is_empty());
    }

    #[test]
    fn a_tab_that_is_gone_ends_as_tab_closed_and_is_not_sent() {
        let mut q = queue(vec![
            ("a", "x", WhenInput::InMinutes { minutes: 0 }),
            ("a", "y", WhenInput::InMinutes { minutes: 0 }),
        ]);
        let f = facts(&[("b", true)], vec![]);
        let steps = q.plan(&f, T0);
        assert_eq!(steps, [Step::TabClosed { id: "i0".into() }]);
        q.apply(&steps);
        assert_eq!(q.items[0].status, Status::TabClosed);
        // The item behind it is next in line, and meets the same end.
        assert_eq!(q.plan(&f, T0), [Step::TabClosed { id: "i1".into() }]);
        // An idle wait on a gone tab ends the same way.
        let idle = queue(vec![("a", "x", WhenInput::Idle)]);
        assert_eq!(idle.plan(&f, T0), [Step::TabClosed { id: "i0".into() }]);
    }

    #[test]
    fn a_tabs_items_go_in_order_one_at_a_time() {
        let mut q = queue(vec![
            ("a", "first", WhenInput::InMinutes { minutes: 0 }),
            ("a", "second", WhenInput::InMinutes { minutes: 0 }),
            ("b", "other", WhenInput::InMinutes { minutes: 0 }),
        ]);
        let f = facts(&[("a", true), ("b", true)], vec![]);
        // Both tabs go at once; each sends its first.
        let steps = q.plan(&f, T0);
        assert_eq!(fires(&q, &f, T0), ["i0", "i2"]);
        q.apply(&steps);
        // While the first is sending, the second waits.
        assert!(fires(&q, &f, T0 + MIN).is_empty());
        q.report("i0", SendReport::Sent).unwrap();
        assert_eq!(fires(&q, &f, T0 + MIN), ["i1"]);
    }

    #[test]
    fn a_later_item_does_not_jump_a_waiting_one() {
        let q = queue(vec![
            ("a", "first", WhenInput::At { at: T0 + 10 * MIN }),
            ("a", "second", WhenInput::At { at: T0 }),
        ]);
        assert!(fires(&q, &facts(&[("a", true)], vec![]), T0 + MIN).is_empty());
    }

    #[test]
    fn reorder_moves_an_item_within_its_tab() {
        let mut q = queue(vec![
            ("a", "1", WhenInput::Idle),
            ("b", "x", WhenInput::Idle),
            ("a", "2", WhenInput::Idle),
            ("a", "3", WhenInput::Idle),
        ]);
        let order = |q: &Queue| q.tab_items("a").map(|i| i.id.clone()).collect::<Vec<_>>();
        q.reorder("i3", -1).unwrap();
        assert_eq!(order(&q), ["i0", "i3", "i2"]);
        q.reorder("i0", 1).unwrap();
        assert_eq!(order(&q), ["i3", "i0", "i2"]);
        // The edges stay.
        q.reorder("i3", -1).unwrap();
        q.reorder("i2", 1).unwrap();
        assert_eq!(order(&q), ["i3", "i0", "i2"]);
        assert_eq!(q.tab_items("b").count(), 1);
    }

    #[test]
    fn a_failed_send_pauses_the_tab_until_retry_or_skip() {
        let mut q = queue(vec![
            ("a", "first", WhenInput::InMinutes { minutes: 0 }),
            ("a", "second", WhenInput::InMinutes { minutes: 0 }),
            ("b", "other", WhenInput::InMinutes { minutes: 0 }),
        ]);
        let f = facts(&[("a", true), ("b", true)], vec![]);
        let steps = q.plan(&f, T0);
        q.apply(&steps);
        q.report("i0", SendReport::Unconfirmed).unwrap();
        assert_eq!(q.items[0].status, Status::Unconfirmed);
        // Tab a is paused; tab b is not.
        assert_eq!(q.plan(&f, T0 + MIN), []);
        q.report("i2", SendReport::Sent).unwrap();
        // Skip: the second goes.
        q.delete("i0").unwrap();
        assert_eq!(fires(&q, &f, T0 + MIN), ["i1"]);
    }

    #[test]
    fn retry_sends_the_paused_item_again_before_the_rest() {
        let mut q = queue(vec![
            ("a", "first", WhenInput::InMinutes { minutes: 0 }),
            ("a", "second", WhenInput::InMinutes { minutes: 0 }),
        ]);
        let f = facts(&[("a", true)], vec![]);
        let steps = q.plan(&f, T0);
        q.apply(&steps);
        q.report("i0", SendReport::Failed).unwrap();
        assert_eq!(q.items[0].status, Status::Failed);
        q.send_now("i0").unwrap();
        assert_eq!(fires(&q, &f, T0 + MIN), ["i0"]);
    }

    #[test]
    fn send_now_ignores_the_wait_but_not_a_send_in_flight() {
        let mut q = queue(vec![
            ("a", "first", WhenInput::At { at: T0 + 60 * MIN }),
            ("a", "second", WhenInput::At { at: T0 + 90 * MIN }),
        ]);
        let f = facts(&[("a", true)], vec![]);
        q.send_now("i1").unwrap();
        assert_eq!(fires(&q, &f, T0), ["i1"]);
        let steps = q.plan(&f, T0);
        q.apply(&steps);
        assert_eq!(q.send_now("i1"), Err(QueueError::Busy));
        assert_eq!(q.delete("i1"), Err(QueueError::Busy));
    }

    #[test]
    fn limits_are_per_tab_and_per_prompt() {
        let mut q = Queue::default();
        for n in 0..MAX_ITEMS_PER_TAB {
            q.add(new("a", "x", WhenInput::Idle), T0, format!("i{n}"))
                .unwrap();
        }
        assert_eq!(
            q.add(new("a", "x", WhenInput::Idle), T0, "over".into()),
            Err(QueueError::TooMany)
        );
        q.add(new("b", "x", WhenInput::Idle), T0, "b".into())
            .unwrap();
        let big = "x".repeat(MAX_PROMPT_BYTES + 1);
        assert_eq!(
            q.add(new("c", &big, WhenInput::Idle), T0, "big".into()),
            Err(QueueError::TooLarge)
        );
        q.add(
            new("c", &"x".repeat(MAX_PROMPT_BYTES), WhenInput::Idle),
            T0,
            "fit".into(),
        )
        .unwrap();
        assert_eq!(
            q.add(new("c", "  \n", WhenInput::Idle), T0, "blank".into()),
            Err(QueueError::Empty)
        );
    }

    #[test]
    fn update_changes_text_and_time_and_refuses_a_send_in_flight() {
        let mut q = queue(vec![("a", "old", WhenInput::Idle)]);
        let item = q
            .update("i0", "new".into(), WhenInput::InMinutes { minutes: 2 }, T0)
            .unwrap();
        assert_eq!(item.text, "new");
        assert_eq!(item.when, When::At { at: T0 + 2 * MIN });
        let f = facts(&[("a", true)], vec![]);
        let steps = {
            q.send_now("i0").unwrap();
            q.plan(&f, T0)
        };
        q.apply(&steps);
        assert_eq!(
            q.update("i0", "x".into(), WhenInput::Idle, T0),
            Err(QueueError::Busy)
        );
        assert_eq!(
            q.update("nope", "x".into(), WhenInput::Idle, T0),
            Err(QueueError::NotFound)
        );
    }

    #[test]
    fn a_send_in_flight_at_quit_pauses_its_tab() {
        let mut q = queue(vec![("a", "x", WhenInput::InMinutes { minutes: 0 })]);
        let steps = q.plan(&facts(&[("a", true)], vec![]), T0);
        q.apply(&steps);
        assert!(q.recover());
        assert_eq!(q.items[0].status, Status::Unconfirmed);
        assert!(!q.recover());
    }
}
