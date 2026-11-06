//! Tests of the usage archive in `app_stats.rs`.

use std::collections::BTreeMap;

use xdev_kit::{Agent, FileMark, SessionUsage, Tokens, UsageIndex};

use super::*;

fn day(d: &str, n: u64) -> DayTotals {
    DayTotals {
        day: d.into(),
        input: n,
        output: n,
        cache_read: 0,
        cache_write: 0,
    }
}

#[test]
fn the_archive_appends_each_finished_day_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(ARCHIVE_FILE);
    let days = vec![
        day("2026-11-03", 1),
        day("2026-11-04", 2),
        day("2026-11-05", 3),
    ];
    // Today is not finished: it is left out.
    assert_eq!(archive_append(&path, &days, "2026-11-05").unwrap(), 2);
    assert_eq!(archive_append(&path, &days, "2026-11-05").unwrap(), 0);
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text.lines().count(), 2);
    assert!(
        text.lines()
            .next()
            .unwrap()
            .starts_with("{\"v\":1,\"day\":\"2026-11-03\"")
    );
    // The next day adds one line and keeps the others.
    assert_eq!(archive_append(&path, &days, "2026-11-06").unwrap(), 1);
    let back = archive_read(&path);
    let names: Vec<&str> = back.iter().map(|d| d.day.as_str()).collect();
    assert_eq!(names, ["2026-11-03", "2026-11-04", "2026-11-05"]);
    assert_eq!(back[2], day("2026-11-05", 3));
}

#[test]
fn an_empty_day_is_not_archived_and_a_bad_line_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(ARCHIVE_FILE);
    std::fs::write(
        &path,
        "not json\n{\"v\":9,\"day\":\"2026-01-01\",\"input\":1,\"output\":1,\"cacheRead\":0,\"cacheWrite\":0}",
    )
    .unwrap();
    assert!(archive_read(&path).is_empty());
    let added = archive_append(
        &path,
        &[day("2026-11-01", 0), day("2026-11-02", 5)],
        "2026-11-09",
    );
    assert_eq!(added.unwrap(), 1);
    assert_eq!(archive_read(&path), vec![day("2026-11-02", 5)]);
}

#[test]
fn current_means_yesterday_is_there() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(ARCHIVE_FILE);
    assert!(!archive_current(&path, "2026-11-05"));
    archive_append(&path, &[day("2026-11-04", 1)], "2026-11-05").unwrap();
    assert!(!archive_current(&path, "2026-11-05"));
    archive_append(&path, &[day("2026-11-05", 1)], "2026-11-06").unwrap();
    assert!(archive_current(&path, "2026-11-05"));
}

#[test]
fn a_day_with_no_usage_is_still_current_once_marked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(ARCHIVE_FILE);
    // Nothing used: no line is written, and the archive alone stays "not current".
    assert_eq!(
        archive_append(&path, &[day("2026-11-05", 0)], "2026-11-06").unwrap(),
        0
    );
    assert!(!archive_current(&path, "2026-11-05"));
    archive_mark(&path, "2026-11-05").unwrap();
    assert!(archive_current(&path, "2026-11-05"));
    // A later day is not covered by yesterday's mark.
    assert!(!archive_current(&path, "2026-11-06"));
    // The mark is not an archive line.
    assert!(archive_read(&path).is_empty());
}

#[test]
fn day_keys_follow_the_offset() {
    // 2026-11-05T23:00:00Z
    let ms = 1_793_919_600_000;
    assert_eq!(day_key(ms, 0, 0), "2026-11-05");
    assert_eq!(day_key(ms, 420, 0), "2026-11-06");
    assert_eq!(day_key(ms, 420, 1), "2026-11-05");
    assert!(is_day(&day_key(ms, -300, 3)));
}

#[test]
fn the_range_check_needs_pro_before_the_horizon() {
    let h = Some("2026-10-01");
    assert!(check_range("2026-10-01", "2026-11-01", h, false).is_ok());
    let past = check_range("2026-09-30", "2026-11-01", h, false);
    assert_eq!(past.unwrap_err().code, "license_required");
    assert!(check_range("2026-01-01", "2026-11-01", h, true).is_ok());
    // With no log left, every range is past the horizon.
    let none = check_range("2026-11-01", "2026-11-02", None, false);
    assert_eq!(none.unwrap_err().code, "license_required");
    let backwards = check_range("2026-11-02", "2026-11-01", h, true);
    assert_eq!(backwards.unwrap_err().code, "bad_arg");
    let word = check_range("yesterday", "2026-11-01", h, true);
    assert_eq!(word.unwrap_err().code, "bad_arg");
}

#[test]
fn the_range_merges_the_archive_over_the_index() {
    let out = range_of(
        vec![day("2026-11-01", 1), day("2026-11-02", 2)],
        vec![day("2026-11-02", 99), day("2026-11-03", 3)],
        "2026-11-02",
        "2026-11-03",
    );
    assert_eq!(out, vec![day("2026-11-02", 2), day("2026-11-03", 3)]);
}

#[test]
fn the_horizon_is_the_oldest_day_of_a_log_still_on_disk() {
    let mark = |s: &str| FileMark {
        len: 0,
        mtime_ns: 0,
        offset: 0,
        session: s.into(),
        recent_ids: Vec::new(),
    };
    let session = |d: &str, n: u64| SessionUsage {
        id: "x".into(),
        home_id: "h".into(),
        agent: Agent::Claude,
        folder: None,
        model: None,
        first: 0,
        last: 0,
        total: Tokens::default(),
        days: BTreeMap::from([(
            d.to_owned(),
            Tokens {
                input: n,
                ..Tokens::default()
            },
        )]),
        models: BTreeMap::new(),
    };
    let mut index = UsageIndex::default();
    index
        .sessions
        .insert("old".into(), session("2026-08-01", 4));
    index
        .sessions
        .insert("new".into(), session("2026-10-20", 5));
    index.files.insert("gone.jsonl".into(), mark("old"));
    index.files.insert("kept.jsonl".into(), mark("new"));
    let kept = cli_horizon(&index, |p| p == "kept.jsonl");
    assert_eq!(kept.as_deref(), Some("2026-10-20"));
    assert_eq!(cli_horizon(&index, |_| false), None);
    let days = index_days(&index);
    assert_eq!(days[0].day, "2026-08-01");
    assert_eq!(days[0].input, 4);
}
