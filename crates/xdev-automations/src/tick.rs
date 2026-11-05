//! The tick decision: pure, it says what to do and does nothing.

use crate::model::{Automation, AutomationRun, FailureCode};

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

pub fn plan(
    _automations: &[Automation],
    _now: i64,
    _tick_ms: i64,
    _can_dispatch: bool,
) -> Vec<TickStep> {
    Vec::new()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Watch {
    Keep,
    Fail(FailureCode),
}

/// `dispatching` for more than 2 min, `dispatched` for more than 6 h.
pub fn watchdog(_run: &AutomationRun, _now: i64) -> Watch {
    Watch::Keep
}
