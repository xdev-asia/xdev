//! Occurrences of a schedule in the automation's time zone.
//!
//! Cron and hourly rules walk absolute minutes (a repeated hour in a DST fold fires twice);
//! daily and weekly rules compose a local date with the time and resolve it with `compatible`
//! (a gap runs later, a fold runs once, on the earlier pass). The walk skips whole days that
//! cannot match, so a rare rule (`0 0 29 2 *`) costs thousands of steps, not millions.

use jiff::civil::{Date, DateTime};
use jiff::tz::TimeZone;
use jiff::{Span, Timestamp};

use crate::schedule::{self, Freq, ParseOptions, ParsedCron, ParsedRrule, Schedule, ScheduleError};

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 86_400_000;
/// How far a search goes before it calls a rule empty: nine years of 366 days.
const HORIZON_DAYS: i64 = 9 * 366;

fn zone(tz: &str) -> TimeZone {
    TimeZone::get(tz).unwrap_or_else(|_| TimeZone::system())
}

enum Rule {
    /// Cron, and the hourly preset, which is a cron on every hour.
    Walk(ParsedCron),
    /// Daily and weekly presets.
    Compose(ParsedRrule),
}

fn rule(expr: &str) -> Result<Rule, ScheduleError> {
    Ok(match schedule::parse(expr, ParseOptions::default())? {
        Schedule::Cron(c) if schedule::has_date(&c) => Rule::Walk(c),
        Schedule::Cron(_) => return Err(ScheduleError::NoDate),
        Schedule::Rrule(r) if r.freq == Freq::Hourly => Rule::Walk(ParsedCron {
            minute: 1 << r.minute,
            hour: 0x00FF_FFFF,
            dom: 0xFFFF_FFFE,
            month: 0x1FFE,
            dow: 0x7F,
            dom_restricted: false,
            dow_restricted: false,
        }),
        Schedule::Rrule(r) => Rule::Compose(r),
    })
}

fn civil(ms: i64, tz: &TimeZone) -> Option<DateTime> {
    Some(
        Timestamp::from_millisecond(ms)
            .ok()?
            .to_zoned(tz.clone())
            .datetime(),
    )
}

fn day_matches(c: &ParsedCron, dt: &DateTime) -> bool {
    if c.month >> dt.month() & 1 == 0 {
        return false;
    }
    let dom = c.dom >> dt.day() & 1 == 1;
    let dow = c.dow >> dt.weekday().to_sunday_zero_offset() & 1 == 1;
    if c.dom_restricted && c.dow_restricted {
        dom || dow
    } else {
        dom && dow
    }
}

/// The first instant of local date `d` (later when midnight falls in a gap), epoch ms.
fn day_start(d: Date, tz: &TimeZone) -> Option<i64> {
    Some(d.to_zoned(tz.clone()).ok()?.timestamp().as_millisecond())
}

fn cron_next(c: &ParsedCron, tz: &TimeZone, from: i64, limit: i64) -> Option<i64> {
    let mut t = from.div_euclid(MINUTE_MS) * MINUTE_MS;
    if t < from {
        t += MINUTE_MS;
    }
    while t <= limit {
        let dt = civil(t, tz)?;
        let (h, m) = (i64::from(dt.hour()), i64::from(dt.minute()));
        if !day_matches(c, &dt) {
            // The next local midnight: a DST day is 23 or 25 hours, so not `1440 - minutes`.
            t = day_start(dt.date().tomorrow().ok()?, tz)?;
        } else if c.hour >> h & 1 == 0 {
            t += (60 - m) * MINUTE_MS;
        } else if c.minute >> m & 1 == 0 {
            t += MINUTE_MS;
        } else {
            return Some(t);
        }
    }
    None
}

fn cron_prev(c: &ParsedCron, tz: &TimeZone, from: i64, floor: i64) -> Option<i64> {
    let mut t = from.div_euclid(MINUTE_MS) * MINUTE_MS;
    while t >= floor {
        let dt = civil(t, tz)?;
        let (h, m) = (i64::from(dt.hour()), i64::from(dt.minute()));
        if !day_matches(c, &dt) {
            // The last minute of the previous local day.
            t = day_start(dt.date(), tz)? - MINUTE_MS;
        } else if c.hour >> h & 1 == 0 {
            t -= (m + 1) * MINUTE_MS;
        } else if c.minute >> m & 1 == 0 {
            t -= MINUTE_MS;
        } else {
            return Some(t);
        }
    }
    None
}

/// The instant of `r` on a local date, or `None` when the date is off the rule's days.
fn compose(r: &ParsedRrule, d: Date, tz: &TimeZone) -> Option<i64> {
    if r.freq == Freq::Weekly
        && r.by_day != 0
        && r.by_day >> d.weekday().to_sunday_zero_offset() & 1 == 0
    {
        return None;
    }
    let at = d.at(r.hour as i8, r.minute as i8, 0, 0);
    let z = tz.to_ambiguous_zoned(at).compatible().ok()?;
    Some(z.timestamp().as_millisecond())
}

fn shifted(d: Date, days: i64) -> Option<Date> {
    d.checked_add(Span::new().days(days)).ok()
}

/// The first occurrence strictly after `after` (and not before `dtstart`), epoch ms.
pub fn next_after(expr: &str, tz: &str, dtstart: i64, after: i64) -> Result<i64, ScheduleError> {
    let rule = rule(expr)?;
    let tz = zone(tz);
    let lower = (after.saturating_add(1)).max(dtstart);
    let found = match &rule {
        Rule::Walk(c) => cron_next(c, &tz, lower, lower.saturating_add(HORIZON_DAYS * DAY_MS)),
        Rule::Compose(r) => {
            let start = civil(lower, &tz).map(|dt| dt.date());
            start.and_then(|s| {
                (-1..=HORIZON_DAYS)
                    .filter_map(|k| shifted(s, k))
                    .filter_map(|d| compose(r, d, &tz))
                    .find(|ms| *ms >= lower)
            })
        }
    };
    found.ok_or(ScheduleError::NoDate)
}

/// The latest occurrence at or before `now`; `None` when none exists since `dtstart`.
pub fn latest_at_or_before(
    expr: &str,
    tz: &str,
    dtstart: i64,
    now: i64,
) -> Result<Option<i64>, ScheduleError> {
    let rule = rule(expr)?;
    let tz = zone(tz);
    let floor = dtstart.max(now.saturating_sub(HORIZON_DAYS * DAY_MS));
    Ok(match &rule {
        Rule::Walk(c) => cron_prev(c, &tz, now, floor),
        Rule::Compose(r) => civil(now, &tz).map(|dt| dt.date()).and_then(|s| {
            (-1..=HORIZON_DAYS)
                .filter_map(|k| shifted(s, 1 - k))
                .filter_map(|d| compose(r, d, &tz))
                .take_while(|ms| *ms >= floor)
                .find(|ms| *ms <= now)
        }),
    })
}
