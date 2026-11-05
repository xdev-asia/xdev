//! The tick decision: pure, it says what to do and does nothing.

use crate::model::{
    AGENT_START_DEADLINE_MS, Automation, AutomationRun, FailureCode, OBSERVE_DEADLINE_MS, RunStatus,
};
use crate::occur;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TickStep {
    Advance {
        id: String,
    },
    Missed {
        id: String,
        scheduled_for: i64,
    },
    Unevaluable {
        id: String,
        detail: String,
    },
    Refuse {
        id: String,
        scheduled_for: i64,
        code: FailureCode,
    },
    Dispatch {
        id: String,
        scheduled_for: i64,
    },
}

/// What to do about each enabled automation that is due at `now`: one step per automation, for the
/// latest occurrence only (older missed ones are not replayed). The caller carries the steps out and
/// then advances `next_run_at`. An automation in `active` (it has a run that is not final yet) is
/// refused with `previousRunActive`, so runs of one automation never overlap.
pub fn plan(
    automations: &[Automation],
    now: i64,
    tick_ms: i64,
    can_dispatch: bool,
    active: &[&str],
) -> Vec<TickStep> {
    automations
        .iter()
        .filter(|a| a.enabled && a.next_run_at <= now)
        .map(|a| {
            let id = a.id.clone();
            match occur::latest_at_or_before(&a.rrule, &a.timezone, a.dtstart, now) {
                Err(e) => TickStep::Unevaluable {
                    id,
                    detail: e.to_string(),
                },
                Ok(None) => TickStep::Advance { id },
                Ok(Some(scheduled_for)) => {
                    let allowed = i64::from(a.missed_run_grace_minutes) * 60_000 + 2 * tick_ms;
                    if now - scheduled_for > allowed {
                        TickStep::Missed { id, scheduled_for }
                    } else if active.contains(&a.id.as_str()) {
                        TickStep::Refuse {
                            id,
                            scheduled_for,
                            code: FailureCode::PreviousRunActive,
                        }
                    } else if can_dispatch {
                        TickStep::Dispatch { id, scheduled_for }
                    } else {
                        TickStep::Refuse {
                            id,
                            scheduled_for,
                            code: FailureCode::NoDispatchHost,
                        }
                    }
                }
            }
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Watch {
    Keep,
    Fail(FailureCode),
}

/// `dispatching` for more than 2 min (the UI never answered), `dispatched` for more than 6 h.
pub fn watchdog(run: &AutomationRun, now: i64) -> Watch {
    match run.status {
        RunStatus::Dispatching => {
            let since = run.started_at.unwrap_or(run.created_at);
            if now - since > AGENT_START_DEADLINE_MS {
                return Watch::Fail(FailureCode::AgentNeverStarted);
            }
        }
        RunStatus::Dispatched => {
            let since = run
                .dispatched_at
                .or(run.started_at)
                .unwrap_or(run.created_at);
            if now - since > OBSERVE_DEADLINE_MS {
                return Watch::Fail(FailureCode::WatchTimedOut);
            }
        }
        _ => {}
    }
    Watch::Keep
}
