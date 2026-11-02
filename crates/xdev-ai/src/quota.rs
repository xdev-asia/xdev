use serde::{Deserialize, Serialize};

use crate::accounts::AccountEntry;
use crate::claude::{self, AccountStatus, StatusState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuotaState {
    Ok,
    Reserve,
    Full,
    Unknown,
}

/// Why a quota is `unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    NoCredentials,
    Expired,
    Unavailable,
    LoggedOut,
    NoClaude,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub key: String,
    /// Percent used; above 100 when the service lets usage overrun.
    pub utilization: Option<f64>,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub name: String,
    pub state: QuotaState,
    pub reason: Option<Reason>,
    pub windows: Vec<QuotaWindow>,
}

/// Reads the account's usage, unless `status` already shows it cannot work.
pub fn quota(entry: &AccountEntry, status: &AccountStatus, reserve_percent: u8) -> Quota {
    let unknown = |reason| Quota {
        name: entry.name.clone(),
        state: QuotaState::Unknown,
        reason: Some(reason),
        windows: Vec::new(),
    };
    match status.state {
        StatusState::LoggedOut => return unknown(Reason::LoggedOut),
        StatusState::NoClaude => return unknown(Reason::NoClaude),
        // A status that could not be read says nothing about the
        // credentials, so usage is still worth a try.
        StatusState::LoggedIn | StatusState::Error => {}
    }
    match claude::usage(&entry.dir) {
        Ok(windows) => {
            let state = classify(&windows, reserve_percent);
            Quota {
                name: entry.name.clone(),
                state,
                reason: (state == QuotaState::Unknown).then_some(Reason::Unavailable),
                windows,
            }
        }
        Err(reason) => unknown(reason),
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
/// ties go to the lower name so the pick is stable.
pub fn pick(quotas: &[(AccountStatus, Quota)]) -> Option<String> {
    quotas
        .iter()
        .filter(|(s, q)| s.state == StatusState::LoggedIn && q.state == QuotaState::Ok)
        .filter_map(|(_, q)| Some((highest(&q.windows)?, &q.name)))
        .min_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(b.1)))
        .map(|(_, name)| name.clone())
}

fn highest(windows: &[QuotaWindow]) -> Option<f64> {
    windows
        .iter()
        .filter_map(|w| w.utilization)
        .max_by(f64::total_cmp)
}
