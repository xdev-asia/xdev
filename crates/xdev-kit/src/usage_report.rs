//! A filtered view of the usage index for the Stats page: an agent filter, a
//! folder scope, an optional start day (All time), per-agent totals, the
//! session count and the earliest session start.

use serde::{Deserialize, Serialize};

use crate::{Agent, Tokens, UsageIndex, UsageSummary};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ReportQuery {
    /// Inclusive `YYYY-MM-DD`; `None` is All time.
    pub since_day: Option<String>,
    /// Inclusive `YYYY-MM-DD`.
    pub until_day: String,
    /// The agents to count; empty counts none.
    pub agents: Vec<Agent>,
    /// `None` counts every folder; `Some` only sessions whose folder is under
    /// one of these.
    pub folders: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct UsageReport {
    /// Same shape as `summarize`, filtered.
    pub summary: UsageSummary,
    /// Largest first.
    pub by_agent: Vec<(Agent, Tokens)>,
    /// Sessions with tokens in the range.
    pub sessions: u32,
    /// Unix ms of the earliest session start (> 0) among the counted agents,
    /// whatever the range.
    pub tracking_since: Option<i64>,
}

/// Contract stub; the filter lands with the Lane B task that owns it.
pub fn report(_index: &UsageIndex, _q: &ReportQuery) -> UsageReport {
    UsageReport {
        summary: UsageSummary {
            days: Vec::new(),
            by_home: Vec::new(),
            by_folder: Vec::new(),
            by_model: Vec::new(),
            top_sessions: Vec::new(),
        },
        by_agent: Vec::new(),
        sessions: 0,
        tracking_since: None,
    }
}

/// Whether `folder` is one of `roots` or inside one, by path component, not
/// by string prefix.
pub fn under_any(_folder: &str, _roots: &[String]) -> bool {
    false
}
