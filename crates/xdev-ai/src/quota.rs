use serde::{Deserialize, Serialize};

use std::collections::HashMap;
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
    /// The agent CLI of a provider other than Claude and Codex is missing.
    NoCli,
    /// The provider has no quota source xDev can read: quota unknown.
    NoQuotaSource,
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
        StatusState::NoCli => return unknown(Reason::NoCli),
        // A status that could not be read says nothing about the
        // credentials, so usage is still worth a try.
        StatusState::LoggedIn | StatusState::Error | StatusState::Undetected => {}
    }
    if !entry.provider.has_quota() {
        return unknown(Reason::NoQuotaSource);
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
        _ => return unknown(Reason::NoQuotaSource),
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

/// Percent used in the account's tightest window; `None` when unknown.
pub fn highest(windows: &[QuotaWindow]) -> Option<f64> {
    windows
        .iter()
        .filter_map(|w| w.utilization)
        .max_by(f64::total_cmp)
}

/// The windows quota alerts watch.
pub const ALERT_WINDOWS: [&str; 2] = ["five_hour", "seven_day"];

/// An account crossed one of its provider's thresholds in one window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct QuotaAlert {
    pub provider: Provider,
    pub account: String,
    /// `five_hour` or `seven_day`.
    pub window: String,
    pub threshold: u8,
    pub utilization: f64,
}

/// The thresholds each account's windows already alerted for, so every
/// window raises each threshold once until it resets.
#[derive(Debug, Default)]
pub struct AlertLog {
    seen: HashMap<(String, String), Seen>,
}

#[derive(Debug)]
struct Seen {
    resets_at: Option<String>,
    fired: Vec<u8>,
}

impl AlertLog {
    /// The alerts `quota`'s latest reading raises. Thresholds crossed
    /// together raise one alert, for the highest. A window resets when its
    /// reset time moves (compared to the minute, so a reading that only
    /// differs in seconds is the same window) or its usage falls below a
    /// threshold it alerted for.
    pub fn check(
        &mut self,
        provider: Provider,
        quota: &Quota,
        thresholds: &[u8],
    ) -> Vec<QuotaAlert> {
        let mut alerts = Vec::new();
        for window in &quota.windows {
            if !ALERT_WINDOWS.contains(&window.key.as_str()) {
                continue;
            }
            let Some(used) = window.utilization else {
                continue;
            };
            let seen = self
                .seen
                .entry((quota.name.clone(), window.key.clone()))
                .or_insert_with(|| Seen {
                    resets_at: window.resets_at.clone(),
                    fired: Vec::new(),
                });
            let minute =
                |at: &Option<String>| at.as_deref().map(|t| t.get(..16).unwrap_or(t).to_owned());
            if minute(&seen.resets_at) != minute(&window.resets_at) {
                seen.fired.clear();
                seen.resets_at = window.resets_at.clone();
            }
            seen.fired.retain(|t| used >= f64::from(*t));
            let crossed: Vec<u8> = thresholds
                .iter()
                .copied()
                .filter(|t| used >= f64::from(*t) && !seen.fired.contains(t))
                .collect();
            let Some(top) = crossed.iter().copied().max() else {
                continue;
            };
            seen.fired.extend(crossed);
            alerts.push(QuotaAlert {
                provider,
                account: quota.name.clone(),
                window: window.key.clone(),
                threshold: top,
                utilization: used,
            });
        }
        alerts
    }

    /// Forgets an account, so it alerts afresh if it comes back.
    pub fn forget(&mut self, account: &str) {
        self.seen.retain(|(name, _), _| name != account);
    }
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
    fn a_provider_without_a_quota_source_is_unknown() {
        let tmp = tempfile::tempdir().unwrap();
        for (provider, state) in [
            (Provider::Gemini, StatusState::LoggedIn),
            (Provider::Cursor, StatusState::Undetected),
        ] {
            let entry = AccountEntry {
                provider,
                ..entry(tmp.path())
            };
            let q = quota_with(&entry, &AccountStatus::bare(state), 30, &|_| {
                panic!("no live read for {provider:?}")
            });
            assert_eq!(q.state, QuotaState::Unknown);
            assert_eq!(q.reason, Some(Reason::NoQuotaSource));
        }
        let entry = AccountEntry {
            provider: Provider::Amp,
            ..entry(tmp.path())
        };
        let missing = AccountStatus::bare(StatusState::NoCli);
        let q = quota_with(&entry, &missing, 30, &|_| Ok(live_window()));
        assert_eq!(q.reason, Some(Reason::NoCli));
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
        let fails: [fn() -> ProbeError; 4] = [
            || ProbeError::Timeout,
            || ProbeError::Rpc("internal error".into()),
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

    fn reading(five: f64, resets: &str) -> Quota {
        Quota {
            name: "a".into(),
            state: QuotaState::Ok,
            reason: None,
            windows: vec![
                QuotaWindow {
                    key: "five_hour".into(),
                    utilization: Some(five),
                    resets_at: Some(resets.into()),
                },
                QuotaWindow {
                    key: "seven_day".into(),
                    utilization: Some(10.0),
                    resets_at: Some("2026-11-10T00:00:00Z".into()),
                },
                QuotaWindow {
                    key: "seven_day_opus".into(),
                    utilization: Some(99.0),
                    resets_at: None,
                },
            ],
            as_of: None,
        }
    }

    fn fired(log: &mut AlertLog, q: &Quota) -> Vec<(String, u8)> {
        log.check(Provider::Claude, q, &[80, 95])
            .into_iter()
            .map(|a| (a.window, a.threshold))
            .collect()
    }

    const AT: &str = "2026-11-06T15:00:00.120Z";

    #[test]
    fn each_threshold_alerts_once_per_window() {
        let mut log = AlertLog::default();
        assert!(fired(&mut log, &reading(50.0, AT)).is_empty());
        assert_eq!(
            fired(&mut log, &reading(81.0, AT)),
            [("five_hour".into(), 80)]
        );
        assert!(fired(&mut log, &reading(85.0, AT)).is_empty());
        assert_eq!(
            fired(&mut log, &reading(96.0, AT)),
            [("five_hour".into(), 95)]
        );
        assert!(fired(&mut log, &reading(100.0, AT)).is_empty());
    }

    #[test]
    fn thresholds_crossed_together_raise_the_highest_once() {
        let mut log = AlertLog::default();
        assert_eq!(
            fired(&mut log, &reading(97.0, AT)),
            [("five_hour".into(), 95)]
        );
        assert!(fired(&mut log, &reading(98.0, AT)).is_empty());
    }

    #[test]
    fn a_reset_window_alerts_again() {
        let mut log = AlertLog::default();
        assert_eq!(fired(&mut log, &reading(81.0, AT)).len(), 1);
        // Same window, read a moment later: the reset time differs in
        // seconds only.
        assert!(fired(&mut log, &reading(82.0, "2026-11-06T15:00:00.480Z")).is_empty());
        // The next window, already past 80% by the next reading.
        assert_eq!(
            fired(&mut log, &reading(83.0, "2026-11-06T20:00:00Z")),
            [("five_hour".into(), 80)]
        );
        // Usage that falls back under a threshold also means a reset.
        assert!(fired(&mut log, &reading(5.0, "2026-11-06T20:00:00Z")).is_empty());
        assert_eq!(
            fired(&mut log, &reading(81.0, "2026-11-06T20:00:00Z")).len(),
            1
        );
    }

    #[test]
    fn windows_and_accounts_are_kept_apart() {
        let mut log = AlertLog::default();
        let mut q = reading(81.0, AT);
        q.windows[1].utilization = Some(90.0);
        assert_eq!(
            fired(&mut log, &q),
            [("five_hour".into(), 80), ("seven_day".into(), 80)]
        );
        q.name = "b".into();
        assert_eq!(fired(&mut log, &q).len(), 2);
        log.forget("a");
        q.name = "a".into();
        assert_eq!(fired(&mut log, &q).len(), 2);
    }

    #[test]
    fn unknown_usage_raises_nothing() {
        let mut log = AlertLog::default();
        let mut q = reading(0.0, AT);
        q.windows[0].utilization = None;
        assert!(fired(&mut log, &q).is_empty());
        assert_eq!(highest(&q.windows), Some(99.0));
        assert_eq!(highest(&[]), None);
    }
}
