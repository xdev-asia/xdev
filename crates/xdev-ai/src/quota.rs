use serde::{Deserialize, Serialize};

use std::path::Path;
use std::time::SystemTime;

use crate::accounts::{AccountEntry, Provider};
use crate::claude::{self, AccountStatus, StatusState};
use crate::codex;
use crate::codex_rpc::ProbeError;

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
    quota_with(entry, status, reserve_percent, &codex::live_usage)
}

/// `quota` with the Codex live read injected.
pub(crate) fn quota_with(
    entry: &AccountEntry,
    status: &AccountStatus,
    reserve_percent: u8,
    live: &dyn Fn(&Path) -> Result<Vec<QuotaWindow>, ProbeError>,
) -> Quota {
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
        Provider::Codex => match live(&entry.dir) {
            Ok(windows) => (windows, None),
            Err(ProbeError::Auth(_)) => return unknown(Reason::Expired),
            // Any other failure: the limits its last session recorded.
            Err(_) => match codex::usage(&entry.dir, SystemTime::now()) {
                Some(usage) => (usage.windows, Some(usage.as_of)),
                None => return unknown(Reason::NoSessions),
            },
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

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::*;

    fn entry(dir: &Path) -> AccountEntry {
        AccountEntry {
            name: "cx".into(),
            provider: Provider::Codex,
            dir: dir.to_path_buf(),
        }
    }

    fn signed_in() -> AccountStatus {
        AccountStatus::bare(StatusState::LoggedIn)
    }

    fn live_window() -> Vec<QuotaWindow> {
        vec![QuotaWindow {
            key: "five_hour".into(),
            utilization: Some(12.0),
            resets_at: None,
        }]
    }

    fn with_log(dir: &Path) {
        let line = json!({
            "timestamp": "2026-11-02T09:00:00Z",
            "payload": { "type": "token_count", "rate_limits": {
                "primary": { "used_percent": 50.0, "window_minutes": 300, "resets_at": 4_102_444_800_i64 }
            }}
        });
        fs::create_dir_all(dir.join("sessions")).unwrap();
        fs::write(dir.join("sessions/a.jsonl"), format!("{line}\n")).unwrap();
    }

    #[test]
    fn a_live_reading_has_no_as_of() {
        let tmp = tempfile::tempdir().unwrap();
        let q = quota_with(&entry(tmp.path()), &signed_in(), 30, &|_| Ok(live_window()));
        assert_eq!(q.state, QuotaState::Ok);
        assert_eq!(q.as_of, None);
        assert_eq!(q.windows, live_window());
    }

    #[test]
    fn an_auth_failure_is_expired_even_with_logs() {
        let tmp = tempfile::tempdir().unwrap();
        with_log(tmp.path());
        let q = quota_with(&entry(tmp.path()), &signed_in(), 30, &|_| {
            Err(ProbeError::Auth("x".into()))
        });
        assert_eq!(q.state, QuotaState::Unknown);
        assert_eq!(q.reason, Some(Reason::Expired));
    }

    #[test]
    fn another_failure_falls_back_to_the_session_log() {
        let tmp = tempfile::tempdir().unwrap();
        with_log(tmp.path());
        let fails: [fn() -> ProbeError; 3] = [
            || ProbeError::Timeout,
            || ProbeError::NoCodex,
            || ProbeError::Exited(Some(1)),
        ];
        for fail in fails {
            let q = quota_with(&entry(tmp.path()), &signed_in(), 30, &|_| Err(fail()));
            assert_eq!(q.state, QuotaState::Ok);
            assert_eq!(q.as_of.as_deref(), Some("2026-11-02T09:00:00Z"));
        }
    }

    #[test]
    fn a_failure_with_no_logs_is_no_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let q = quota_with(&entry(tmp.path()), &signed_in(), 30, &|_| {
            Err(ProbeError::Timeout)
        });
        assert_eq!(q.reason, Some(Reason::NoSessions));
    }
}
