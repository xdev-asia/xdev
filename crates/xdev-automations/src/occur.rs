//! Occurrences of a schedule in the automation's time zone.

use crate::schedule::ScheduleError;

/// The first occurrence strictly after `after` (and not before `dtstart`), epoch ms.
pub fn next_after(
    _expr: &str,
    _tz: &str,
    _dtstart: i64,
    _after: i64,
) -> Result<i64, ScheduleError> {
    Err(ScheduleError::NoDate)
}

/// The latest occurrence at or before `now`; `None` when none exists since `dtstart`.
pub fn latest_at_or_before(
    _expr: &str,
    _tz: &str,
    _dtstart: i64,
    _now: i64,
) -> Result<Option<i64>, ScheduleError> {
    Ok(None)
}
