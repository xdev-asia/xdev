//! Failover: when a worker counts as failed, and what takes its place. Pure,
//! so the sweep's choices are tested without a terminal or an account.

use crate::model::{FailReason, WorkerState};

/// Failovers one dispatch may make, when the settings say nothing else.
pub const DEFAULT_MAX_FAILOVERS: u32 = 2;
/// The most of a failed worker's last output handed to the one after it.
pub const TAIL_BYTES: usize = 4096;
/// How long a stuck worker waits before its restart, then before it fails
/// over (or is marked failed) when it is stuck again after the restart.
pub const RESTART_BACKOFF_MS: [i64; 2] = [30_000, 120_000];
/// The quota a window reads when it is used up.
pub const QUOTA_FULL_PERCENT: f64 = 100.0;

/// What a provider's CLI prints when it stops for quota or a rate limit:
/// provider, reason, and lower-case text to look for. Quota rows come first,
/// so a screen that shows both reads as out of quota.
pub const MARKERS: &[(&str, FailReason, &str)] = &[
    ("claude", FailReason::OutOfQuota, "usage limit reached"),
    ("claude", FailReason::OutOfQuota, "you've hit your limit"),
    ("claude", FailReason::OutOfQuota, "out of extra usage"),
    ("claude", FailReason::RateLimited, "rate_limit_error"),
    ("claude", FailReason::RateLimited, "429 too many requests"),
    (
        "codex",
        FailReason::OutOfQuota,
        "you've hit your usage limit",
    ),
    ("codex", FailReason::OutOfQuota, "insufficient_quota"),
    ("codex", FailReason::RateLimited, "rate limit reached"),
    ("codex", FailReason::RateLimited, "429 too many requests"),
];

/// The marker `output` shows for `provider`, if any.
pub fn marker(provider: &str, output: &str) -> Option<FailReason> {
    let text = output.to_lowercase();
    MARKERS
        .iter()
        .find(|(p, _, m)| *p == provider && text.contains(m))
        .map(|(_, r, _)| *r)
}

/// A worker that has not settled: only these can fail over. A worker the
/// person stopped is stopping, stopped or abandoned, so it never does.
pub fn unsettled(state: WorkerState) -> bool {
    matches!(
        state,
        WorkerState::Starting | WorkerState::StartUnknown | WorkerState::Ready
    )
}

/// What the sweep saw of a worker's tab.
#[derive(Debug, Clone, Copy, Default)]
pub struct Seen<'a> {
    /// The tab's process has ended.
    pub exited: bool,
    /// Its exit code; none when it ended without one (a crash).
    pub exit_code: Option<i32>,
    /// The end of the tab's output; empty when it was not read.
    pub output: &'a str,
    /// The agent's provider, when it has one.
    pub provider: Option<&'a str>,
    /// How much of the account's tightest quota window is used, in percent.
    pub quota_used: Option<f64>,
}

/// Why a worker in `state` counts as failed, or none. A marker in the output
/// names the reason better than the exit code, so it wins.
pub fn detect(state: WorkerState, seen: &Seen<'_>) -> Option<FailReason> {
    if !unsettled(state) {
        return None;
    }
    let marked = seen.provider.and_then(|p| marker(p, seen.output));
    if seen.exited {
        return match seen.exit_code {
            Some(0) => marked,
            Some(_) => marked.or(Some(FailReason::Exited)),
            None => marked.or(Some(FailReason::Crashed)),
        };
    }
    if marked.is_some() {
        return marked;
    }
    seen.quota_used
        .filter(|used| *used >= QUOTA_FULL_PERCENT)
        .map(|_| FailReason::QuotaFull)
}

/// Busy with no output for `after_ms`.
pub fn stuck(busy: bool, last_output_ms: Option<i64>, now_ms: i64, after_ms: i64) -> bool {
    busy && last_output_ms.is_some_and(|at| now_ms.saturating_sub(at) >= after_ms)
}

/// The failover settings, as the sweep reads them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Policy {
    pub enabled: bool,
    /// Try the same agent on another account of its provider first.
    pub backup_account: bool,
    /// Agents to try next, in order; each starts on its provider's routing.
    pub backup_agents: Vec<String>,
    pub max_failovers: u32,
    /// Restart a stuck worker once before anything else.
    pub autopilot: bool,
}

/// Where a failed worker stands.
#[derive(Debug, Clone, Copy)]
pub struct Situation<'a> {
    pub reason: FailReason,
    pub state: WorkerState,
    pub agent: &'a str,
    /// Failovers this dispatch's chain has made.
    pub failovers: u32,
    /// Restarts this dispatch's chain has made.
    pub restarts: u32,
    /// Agents the chain ran, this worker's included.
    pub tried_agents: &'a [String],
    /// Another account of the agent's provider, picked with the accounts the
    /// chain ran on left out.
    pub backup_account: Option<&'a str>,
    /// How long ago the worker was first seen stuck; for `Stuck` only.
    pub stuck_for_ms: i64,
}

/// What to do about a failed worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice {
    /// Nothing: the person stopped it, or the settings leave it alone.
    Leave,
    /// Not yet: a stuck worker waits out its backoff.
    Wait,
    /// Start the same agent on the same account.
    Restart,
    /// Start `agent`; on `account` when set, else on its provider's routing.
    FailOver {
        agent: String,
        account: Option<String>,
    },
    /// No backup is left, or none is allowed: the worker failed.
    MarkFailed,
}

/// The backoff a stuck worker waits after `restarts` restarts.
pub fn restart_backoff(restarts: u32) -> i64 {
    let last = RESTART_BACKOFF_MS.len() - 1;
    RESTART_BACKOFF_MS[usize::try_from(restarts).map_or(last, |i| i.min(last))]
}

/// The choice for a failed worker under `policy`.
pub fn choose(policy: &Policy, s: &Situation<'_>) -> Choice {
    if !unsettled(s.state) {
        return Choice::Leave;
    }
    if s.reason == FailReason::Stuck {
        if !policy.autopilot {
            return Choice::Leave;
        }
        if s.stuck_for_ms < restart_backoff(s.restarts) {
            return Choice::Wait;
        }
        if s.restarts == 0 {
            return Choice::Restart;
        }
        if !policy.enabled {
            return Choice::MarkFailed;
        }
    } else if !policy.enabled {
        return Choice::Leave;
    }
    if s.failovers >= policy.max_failovers {
        return Choice::MarkFailed;
    }
    if policy.backup_account
        && let Some(account) = s.backup_account
    {
        return Choice::FailOver {
            agent: s.agent.to_owned(),
            account: Some(account.to_owned()),
        };
    }
    match policy
        .backup_agents
        .iter()
        .find(|a| !s.tried_agents.contains(a))
    {
        Some(agent) => Choice::FailOver {
            agent: agent.clone(),
            account: None,
        },
        None => Choice::MarkFailed,
    }
}

/// The last `TAIL_BYTES` of `text`, cut on a character boundary.
pub fn tail(text: &str) -> &str {
    if text.len() <= TAIL_BYTES {
        return text;
    }
    let mut start = text.len() - TAIL_BYTES;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// What a reason reads as in the preamble and the activity.
pub fn reason_text(reason: FailReason) -> &'static str {
    match reason {
        FailReason::Exited => "it exited with an error",
        FailReason::Crashed => "it crashed",
        FailReason::OutOfQuota => "its account ran out of quota",
        FailReason::RateLimited => "its account was rate limited",
        FailReason::QuotaFull => "its account's quota reads 100%",
        FailReason::Stuck => "it was busy with no output for too long",
    }
}

/// The text put before the task for a worker that continues a failed one.
pub fn continue_preamble(from_agent: &str, reason: FailReason, last_output: &str) -> String {
    let tail = tail(last_output).trim_end();
    let mut out = format!(
        "You continue the work of a worker ({from_agent}) that stopped because {}. \
         Check the worktree for what it already did, then carry on with the task below.\n",
        reason_text(reason)
    );
    if !tail.is_empty() {
        out.push_str("\nThe end of its last output:\n```\n");
        out.push_str(tail);
        out.push_str("\n```\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_marker_table_reads_quota_and_rate_limits_per_provider() {
        let cases = [
            (
                "claude",
                "Claude usage limit reached. Resets 5pm",
                Some(FailReason::OutOfQuota),
            ),
            (
                "claude",
                "You've hit your limit · resets 3am",
                Some(FailReason::OutOfQuota),
            ),
            (
                "claude",
                "API Error: 429 {\"type\":\"rate_limit_error\"}",
                Some(FailReason::RateLimited),
            ),
            (
                "codex",
                "You've hit your usage limit. Try again later.",
                Some(FailReason::OutOfQuota),
            ),
            (
                "codex",
                "stream error: Rate limit reached for requests",
                Some(FailReason::RateLimited),
            ),
            (
                "codex",
                "error: insufficient_quota",
                Some(FailReason::OutOfQuota),
            ),
            // A marker of another provider does not count.
            ("codex", "rate_limit_error", None),
            ("claude", "all tests pass", None),
            ("other", "usage limit reached", None),
        ];
        for (provider, text, want) in cases {
            assert_eq!(marker(provider, text), want, "{provider}: {text}");
        }
        // Quota wins when a screen shows both.
        assert_eq!(
            marker("claude", "rate_limit_error ... usage limit reached"),
            Some(FailReason::OutOfQuota)
        );
        // Every row is lower case, or it could never match.
        for (_, _, m) in MARKERS {
            assert_eq!(*m, m.to_lowercase());
        }
    }

    fn seen<'a>(exited: bool, code: Option<i32>, output: &'a str, quota: Option<f64>) -> Seen<'a> {
        Seen {
            exited,
            exit_code: code,
            output,
            provider: Some("claude"),
            quota_used: quota,
        }
    }

    #[test]
    fn detection_covers_exits_crashes_markers_and_full_quota() {
        let ready = WorkerState::Ready;
        assert_eq!(
            detect(ready, &seen(true, Some(1), "", None)),
            Some(FailReason::Exited)
        );
        assert_eq!(
            detect(ready, &seen(true, None, "", None)),
            Some(FailReason::Crashed)
        );
        assert_eq!(detect(ready, &seen(true, Some(0), "", None)), None);
        assert_eq!(
            detect(ready, &seen(true, Some(0), "usage limit reached", None)),
            Some(FailReason::OutOfQuota)
        );
        assert_eq!(
            detect(ready, &seen(true, Some(2), "rate_limit_error", None)),
            Some(FailReason::RateLimited)
        );
        assert_eq!(
            detect(ready, &seen(false, None, "usage limit reached", None)),
            Some(FailReason::OutOfQuota)
        );
        assert_eq!(
            detect(ready, &seen(false, None, "", Some(100.0))),
            Some(FailReason::QuotaFull)
        );
        assert_eq!(detect(ready, &seen(false, None, "", Some(99.9))), None);
        assert_eq!(detect(ready, &seen(false, None, "working", None)), None);
        assert_eq!(
            detect(WorkerState::Starting, &seen(true, Some(1), "", None)),
            Some(FailReason::Exited)
        );
        // A settled or stopped worker never fails over.
        for state in [
            WorkerState::Succeeded,
            WorkerState::Failed,
            WorkerState::Stopping,
            WorkerState::StopUnknown,
            WorkerState::Stopped,
            WorkerState::Abandoned,
        ] {
            assert_eq!(
                detect(
                    state,
                    &seen(true, Some(1), "usage limit reached", Some(100.0))
                ),
                None
            );
        }
    }

    #[test]
    fn stuck_means_busy_with_no_output_for_the_limit() {
        assert!(stuck(true, Some(0), 60_000, 60_000));
        assert!(!stuck(true, Some(1), 60_000, 60_000));
        assert!(!stuck(false, Some(0), 600_000, 60_000));
        assert!(!stuck(true, None, 600_000, 60_000));
    }

    fn policy() -> Policy {
        Policy {
            enabled: true,
            backup_account: true,
            backup_agents: vec!["codex".to_owned(), "claude".to_owned()],
            max_failovers: DEFAULT_MAX_FAILOVERS,
            autopilot: true,
        }
    }

    fn situation<'a>(
        reason: FailReason,
        tried: &'a [String],
        account: Option<&'a str>,
    ) -> Situation<'a> {
        Situation {
            reason,
            state: WorkerState::Ready,
            agent: "claude",
            failovers: 0,
            restarts: 0,
            tried_agents: tried,
            backup_account: account,
            stuck_for_ms: 0,
        }
    }

    #[test]
    fn the_backup_account_comes_first_then_the_backup_agents_in_order() {
        let tried = vec!["claude".to_owned()];
        let s = situation(FailReason::OutOfQuota, &tried, Some("claude-2"));
        assert_eq!(
            choose(&policy(), &s),
            Choice::FailOver {
                agent: "claude".to_owned(),
                account: Some("claude-2".to_owned())
            }
        );
        // No other account: the first agent not tried yet, on its own routing.
        let s = situation(FailReason::QuotaFull, &tried, None);
        assert_eq!(
            choose(&policy(), &s),
            Choice::FailOver {
                agent: "codex".to_owned(),
                account: None
            }
        );
        // The backup account switch off skips the account.
        let p = Policy {
            backup_account: false,
            ..policy()
        };
        let s = situation(FailReason::Exited, &tried, Some("claude-2"));
        assert!(matches!(
            choose(&p, &s),
            Choice::FailOver { account: None, .. }
        ));
    }

    #[test]
    fn no_backup_means_failed() {
        let tried = vec!["claude".to_owned(), "codex".to_owned()];
        let s = situation(FailReason::Crashed, &tried, None);
        assert_eq!(choose(&policy(), &s), Choice::MarkFailed);
        let p = Policy {
            backup_agents: vec![],
            ..policy()
        };
        assert_eq!(
            choose(
                &p,
                &situation(FailReason::Exited, &["claude".to_owned()], None)
            ),
            Choice::MarkFailed
        );
    }

    #[test]
    fn the_max_stops_the_chain() {
        let tried = vec!["claude".to_owned()];
        let mut s = situation(FailReason::RateLimited, &tried, Some("claude-2"));
        s.failovers = 2;
        assert_eq!(choose(&policy(), &s), Choice::MarkFailed);
        s.failovers = 1;
        assert!(matches!(choose(&policy(), &s), Choice::FailOver { .. }));
        let p = Policy {
            max_failovers: 0,
            ..policy()
        };
        s.failovers = 0;
        assert_eq!(choose(&p, &s), Choice::MarkFailed);
    }

    #[test]
    fn a_stopped_worker_is_left_alone() {
        let tried = vec!["claude".to_owned()];
        for state in [
            WorkerState::Stopping,
            WorkerState::StopUnknown,
            WorkerState::Stopped,
            WorkerState::Abandoned,
            WorkerState::Succeeded,
            WorkerState::Failed,
        ] {
            let mut s = situation(FailReason::QuotaFull, &tried, Some("claude-2"));
            s.state = state;
            assert_eq!(choose(&policy(), &s), Choice::Leave, "{state:?}");
            s.reason = FailReason::Stuck;
            s.stuck_for_ms = i64::MAX;
            assert_eq!(choose(&policy(), &s), Choice::Leave, "{state:?}");
        }
    }

    #[test]
    fn failover_off_leaves_failures_as_they_were() {
        let p = Policy {
            enabled: false,
            autopilot: false,
            ..policy()
        };
        let tried = vec!["claude".to_owned()];
        let s = situation(FailReason::QuotaFull, &tried, Some("claude-2"));
        assert_eq!(choose(&p, &s), Choice::Leave);
        assert_eq!(choose(&Policy::default(), &s), Choice::Leave);
    }

    #[test]
    fn a_stuck_worker_restarts_once_after_its_backoffs() {
        assert_eq!(restart_backoff(0), 30_000);
        assert_eq!(restart_backoff(1), 120_000);
        assert_eq!(restart_backoff(7), 120_000);
        let tried = vec!["claude".to_owned()];
        let mut s = situation(FailReason::Stuck, &tried, Some("claude-2"));
        s.stuck_for_ms = 29_999;
        assert_eq!(choose(&policy(), &s), Choice::Wait);
        s.stuck_for_ms = 30_000;
        assert_eq!(choose(&policy(), &s), Choice::Restart);
        // Stuck again after the restart: 120s more, then the backup.
        s.restarts = 1;
        s.stuck_for_ms = 119_999;
        assert_eq!(choose(&policy(), &s), Choice::Wait);
        s.stuck_for_ms = 120_000;
        assert!(matches!(choose(&policy(), &s), Choice::FailOver { .. }));
        // With failover off it is marked failed instead.
        let p = Policy {
            enabled: false,
            ..policy()
        };
        assert_eq!(choose(&p, &s), Choice::MarkFailed);
        // Autopilot off: a stuck worker is left alone.
        let p = Policy {
            autopilot: false,
            ..policy()
        };
        assert_eq!(choose(&p, &s), Choice::Leave);
    }

    #[test]
    fn the_preamble_carries_at_most_four_kilobytes_of_output() {
        let long = format!("{}é{}", "a".repeat(5000), "z".repeat(TAIL_BYTES - 1));
        let t = tail(&long);
        assert!(t.len() <= TAIL_BYTES);
        assert!(t.ends_with('z'));
        assert_eq!(tail("short"), "short");
        let p = continue_preamble("claude", FailReason::OutOfQuota, &long);
        assert!(p.contains("continue the work of a worker (claude)"));
        assert!(p.contains("ran out of quota"));
        assert!(!p.contains(&"a".repeat(10)));
        let bare = continue_preamble("claude", FailReason::Crashed, "  ");
        assert!(!bare.contains("```"));
    }
}
