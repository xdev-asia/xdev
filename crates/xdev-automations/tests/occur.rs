use std::time::{Duration, Instant};

use jiff::Timestamp;
use jiff::tz::TimeZone;
use xdev_automations::occur::{latest_at_or_before, next_after};

fn ms(s: &str) -> i64 {
    s.parse::<Timestamp>().expect(s).as_millisecond()
}

fn local(ms: i64, tz: &str) -> String {
    Timestamp::from_millisecond(ms)
        .unwrap()
        .in_tz(tz)
        .expect(tz)
        .datetime()
        .to_string()
}

fn next(expr: &str, tz: &str, after: &str) -> i64 {
    next_after(expr, tz, 0, ms(after)).expect(expr)
}

fn latest(expr: &str, tz: &str, now: &str) -> Option<i64> {
    latest_at_or_before(expr, tz, 0, ms(now)).expect(expr)
}

#[test]
fn hourly_runs_at_its_minute() {
    let r = "FREQ=HOURLY;BYMINUTE=15";
    assert_eq!(
        next(r, "UTC", "2026-11-05T10:20:00Z"),
        ms("2026-11-05T11:15:00Z")
    );
    assert_eq!(
        latest(r, "UTC", "2026-11-05T10:20:00Z"),
        Some(ms("2026-11-05T10:15:00Z"))
    );
}

#[test]
fn next_is_strictly_after_and_latest_is_at_or_before() {
    let r = "FREQ=DAILY;BYHOUR=16;BYMINUTE=30";
    let at = "2026-11-05T16:30:00Z";
    assert_eq!(next(r, "UTC", at), ms("2026-11-06T16:30:00Z"));
    assert_eq!(latest(r, "UTC", at), Some(ms(at)));
    assert_eq!(
        latest(r, "UTC", "2026-11-05T16:29:59Z"),
        Some(ms("2026-11-04T16:30:00Z"))
    );
}

#[test]
fn weekdays_skip_the_weekend() {
    let r = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0";
    // 2026-11-06 is a Friday.
    assert_eq!(
        next(r, "UTC", "2026-11-06T17:00:00Z"),
        ms("2026-11-09T09:00:00Z")
    );
    assert_eq!(
        latest(r, "UTC", "2026-11-08T12:00:00Z"),
        Some(ms("2026-11-06T09:00:00Z"))
    );
}

#[test]
fn weekly_runs_on_its_day() {
    let r = "FREQ=WEEKLY;BYDAY=TH;BYHOUR=14;BYMINUTE=0";
    assert_eq!(
        next(r, "UTC", "2026-11-05T15:00:00Z"),
        ms("2026-11-12T14:00:00Z")
    );
    assert_eq!(
        latest(r, "UTC", "2026-11-05T15:00:00Z"),
        Some(ms("2026-11-05T14:00:00Z"))
    );
}

#[test]
fn cron_matches_either_day_field_when_both_are_restricted() {
    // 2026-11-02 is a Monday: the next Monday beats the next first of the month.
    assert_eq!(
        next("0 9 1 * 1", "UTC", "2026-11-02T10:00:00Z"),
        ms("2026-11-09T09:00:00Z")
    );
    assert_eq!(
        next("*/15 * * * *", "UTC", "2026-11-05T10:20:00Z"),
        ms("2026-11-05T10:30:00Z")
    );
    assert_eq!(
        latest("*/15 * * * *", "UTC", "2026-11-05T10:20:00Z"),
        Some(ms("2026-11-05T10:15:00Z"))
    );
    assert_eq!(
        latest("0 0 1 1 *", "UTC", "2026-11-05T00:00:00Z"),
        Some(ms("2026-01-01T00:00:00Z"))
    );
}

#[test]
fn a_cron_walk_skips_days_and_stays_fast() {
    let t = Instant::now();
    let found = next("0 0 29 2 *", "UTC", "2097-03-01T00:00:00Z");
    assert_eq!(found, ms("2104-02-29T00:00:00Z"));
    assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
    let t = Instant::now();
    assert_eq!(
        latest("0 0 29 2 *", "UTC", "2104-03-01T00:00:00Z"),
        Some(ms("2104-02-29T00:00:00Z"))
    );
    assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
}

#[test]
fn a_rule_with_no_date_is_an_error() {
    assert!(next_after("0 0 31 2 *", "UTC", 0, ms("2026-01-01T00:00:00Z")).is_err());
    assert!(next_after("nonsense", "UTC", 0, 0).is_err());
    assert!(latest_at_or_before("nonsense", "UTC", 0, 0).is_err());
}

#[test]
fn dtstart_bounds_both_ends() {
    let r = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
    let dtstart = ms("2026-11-10T12:00:00Z");
    assert_eq!(
        next_after(r, "UTC", dtstart, ms("2026-11-05T00:00:00Z")),
        Ok(ms("2026-11-11T09:00:00Z"))
    );
    assert_eq!(
        latest_at_or_before(r, "UTC", dtstart, ms("2026-11-10T20:00:00Z")),
        Ok(None)
    );
    assert_eq!(
        latest_at_or_before(r, "UTC", dtstart, ms("2026-11-11T10:00:00Z")),
        Ok(Some(ms("2026-11-11T09:00:00Z")))
    );
    assert_eq!(
        next_after("*/15 * * * *", "UTC", dtstart, 0),
        Ok(ms("2026-11-10T12:00:00Z"))
    );
}

#[test]
fn a_daily_rule_in_the_spring_gap_runs_later() {
    let r = "FREQ=DAILY;BYHOUR=2;BYMINUTE=30";
    let got = next(r, "America/New_York", "2026-03-07T12:00:00-05:00");
    assert_eq!(local(got, "America/New_York"), "2026-03-08T03:30:00");
    let after = next(r, "America/New_York", "2026-03-08T04:00:00-04:00");
    assert_eq!(local(after, "America/New_York"), "2026-03-09T02:30:00");
}

#[test]
fn a_daily_rule_in_the_fall_fold_runs_once_and_a_cron_twice() {
    let r = "FREQ=DAILY;BYHOUR=1;BYMINUTE=30";
    let first = next(r, "America/New_York", "2026-10-31T12:00:00-04:00");
    assert_eq!(first, ms("2026-11-01T05:30:00Z"));
    assert_eq!(
        next_after(r, "America/New_York", 0, first),
        Ok(ms("2026-11-02T06:30:00Z"))
    );

    let c = "30 1 * * *";
    let a = next(c, "America/New_York", "2026-10-31T12:00:00-04:00");
    let b = next_after(c, "America/New_York", 0, a).unwrap();
    let d = next_after(c, "America/New_York", 0, b).unwrap();
    assert_eq!(
        [a, b, d],
        [
            ms("2026-11-01T05:30:00Z"),
            ms("2026-11-01T06:30:00Z"),
            ms("2026-11-02T06:30:00Z")
        ]
    );
}

#[test]
fn the_same_rule_lands_on_different_instants_in_different_zones() {
    let r = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
    let london = next(r, "Europe/London", "2026-11-05T00:00:00Z");
    let hcm = next(r, "Asia/Ho_Chi_Minh", "2026-11-05T00:00:00Z");
    assert_eq!(london, ms("2026-11-05T09:00:00Z"));
    assert_eq!(hcm, ms("2026-11-05T02:00:00Z"));
}

#[test]
fn an_unknown_zone_falls_back_to_the_system_zone() {
    let r = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
    let got = next(r, "Not/AZone", "2026-11-05T00:00:00Z");
    let z = Timestamp::from_millisecond(got)
        .unwrap()
        .to_zoned(TimeZone::system());
    assert_eq!((z.hour(), z.minute()), (9, 0));
    assert_eq!(got, next(r, "", "2026-11-05T00:00:00Z"));
}
