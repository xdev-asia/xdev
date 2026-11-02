use serde::{Deserialize, Serialize};

use std::time::SystemTime;

use crate::accounts::{AccountEntry, Provider};
use crate::claude::{self, AccountStatus, StatusState};
use crate::codex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum QuotaState {
    Ok,
    Reserve,
    Full,
    Unknown,
}

/// Why a quota is `unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    NoCredentials,
    Expired,
    Unavailable,
    LoggedOut,
    NoClaude,
    NoCodex,
    /// A Codex account with no session that recorded its limits yet.
    NoSessions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub key: String,
    /// Percent used; above 100 when the service lets usage overrun.
    pub utilization: Option<f64>,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub name: String,
    pub state: QuotaState,
    pub reason: Option<Reason>,
    pub windows: Vec<QuotaWindow>,
    /// When the numbers were read, for sources that are not live (Codex's
    /// come from its last session); `None` means now.
    pub as_of: Option<String>,
}

/// Reads the account's usage, unless `status` already shows it cannot work.
pub fn quota(entry: &AccountEntry, status: &AccountStatus, reserve_percent: u8) -> Quota {
    let unknown = |reason| Quota {
        name: entry.name.clone(),
        state: QuotaState::Unknown,
        reason: Some(reason),
        windows: Vec::new(),
        as_of: None,
    };
    match status.state {
        StatusState::LoggedOut => return unknown(Reason::LoggedOut),
        StatusState::NoClaude => return unknown(Reason::NoClaude),
        StatusState::NoCodex => return unknown(Reason::NoCodex),
        // A status that could not be read says nothing about the
        // credentials, so usage is still worth a try.
        StatusState::LoggedIn | StatusState::Error => {}
    }
    let (windows, as_of) = match entry.provider {
        Provider::Claude => match claude::usage(&entry.dir) {
            Ok(windows) => (windows, None),
            Err(reason) => return unknown(reason),
        },
        Provider::Codex => match codex::usage(&entry.dir, SystemTime::now()) {
            Some(usage) => (usage.windows, Some(usage.as_of)),
            None => return unknown(Reason::NoSessions),
        },
    };
    let state = classify(&windows, reserve_percent);
    Quota {
        name: entry.name.clone(),
        state,
        reason: (state == QuotaState::Unknown).then_some(Reason::Unavailable),
        windows,
        as_of,
    }
}

pub fn classify(windows: &[QuotaWindow], reserve_percent: u8) -> QuotaState {
    let Some(top) = highest(windows) else {
        return QuotaState::Unknown;
    };
    if top >= 100.0 {
        QuotaState::Full
    } else if top >= 100.0 - f64::from(reserve_percent) {
        QuotaState::Reserve
    } else {
        QuotaState::Ok
    }
}

/// The signed-in `ok` account with the most room in its tightest window;
/// ties go to the lower name so the pick is stable. `provider` limits the
/// pick to one provider's accounts.
pub fn pick(
    quotas: &[(Provider, AccountStatus, Quota)],
    provider: Option<Provider>,
) -> Option<String> {
    quotas
        .iter()
        .filter(|(p, s, q)| {
            provider.is_none_or(|want| want == *p)
                && s.state == StatusState::LoggedIn
                && q.state == QuotaState::Ok
        })
        .filter_map(|(_, _, q)| Some((highest(&q.windows)?, &q.name)))
        .min_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(b.1)))
        .map(|(_, name)| name.clone())
}

fn highest(windows: &[QuotaWindow]) -> Option<f64> {
    windows
        .iter()
        .filter_map(|w| w.utilization)
        .max_by(f64::total_cmp)
}
