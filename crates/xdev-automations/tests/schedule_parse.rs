use xdev_automations::schedule::{
    Freq, ParsedCron, ParsedRrule, build_cron, build_rrule, describe, is_valid_new, parse,
};
use xdev_automations::{Describe, ParseOptions, Preset, Schedule, ScheduleError};

const NOW: i64 = 1_793_793_600_000;

fn cron(expr: &str) -> ParsedCron {
    match parse(expr, ParseOptions::default()).expect(expr) {
        Schedule::Cron(c) => c,
        other => panic!("{expr}: {other:?}"),
    }
}

fn rrule(expr: &str) -> ParsedRrule {
    match parse(expr, ParseOptions::default()).expect(expr) {
        Schedule::Rrule(r) => r,
        other => panic!("{expr}: {other:?}"),
    }
}

fn bits(mask: u64) -> Vec<u32> {
    (0..64).filter(|b| mask >> b & 1 == 1).collect()
}

#[test]
fn a_start_with_a_step_runs_to_the_top_of_the_field() {
    assert_eq!(bits(cron("5/15 * * * *").minute), vec![5, 20, 35, 50]);
}

#[test]
fn a_star_with_a_step_does_not_restrict_the_day() {
    let c = cron("0 9 */2 * *");
    assert!(!c.dom_restricted);
    assert!(!c.dow_restricted);
    assert!(cron("0 9 1-31 * *").dom_restricted);
}

#[test]
fn names_and_seven_for_sunday() {
    assert_eq!(cron("0 9 * * MON-FRI").dow, 0b0111110);
    assert_eq!(cron("0 9 * * mon-fri").dow, 0b0111110);
    assert_eq!(cron("0 9 * * 7").dow, 0b0000001);
    assert_eq!(cron("0 9 * * SU,SA").dow, 0b1000001);
    assert_eq!(cron("0 9 * * 5-7").dow, 0b1100001);
    assert_eq!(bits(cron("0 9 1 JAN,mar *").month as u64), vec![1, 3]);
}

#[test]
fn both_day_fields_restricted_is_recorded() {
    let c = cron("0 9 1 * 1");
    assert!(c.dom_restricted && c.dow_restricted);
}

#[test]
fn unicode_spaces_separate_fields() {
    let c = cron("0\u{00a0}9\u{3000}*  * \t1");
    assert_eq!(c.hour, 1 << 9);
    assert_eq!(c.dow, 0b10);
}

#[test]
fn a_cron_needs_five_fields_and_fits_two_kib() {
    assert_eq!(
        parse("0 9 * *", ParseOptions::default()),
        Err(ScheduleError::FieldCount)
    );
    assert_eq!(
        parse("", ParseOptions::default()),
        Err(ScheduleError::Empty)
    );
    let long = format!("0 9 * * {}", "1,".repeat(1100));
    assert!(long.len() > 2048);
    assert_eq!(
        parse(&long, ParseOptions::default()),
        Err(ScheduleError::TooLong)
    );
}

#[test]
fn bad_fields_are_refused() {
    for bad in [
        "60 * * * *",
        "* 24 * * *",
        "* * 0 * *",
        "* * * 13 *",
        "* * * * 8",
        "5-1 * * * *",
        "1,,2 * * * *",
        "x * * * *",
        "*/0 * * * *",
    ] {
        assert!(parse(bad, ParseOptions::default()).is_err(), "{bad}");
    }
}

#[test]
fn an_oversized_step_is_refused_only_for_new_input() {
    let strict = ParseOptions {
        reject_oversized_step: true,
    };
    let err = parse("*/61 * * * *", strict).unwrap_err();
    assert_eq!(
        err.to_string(),
        "Cron minute step must be between 1 and 60."
    );
    assert!(parse("*/60 * * * *", strict).is_ok());
    assert!(parse("* */25 * * *", strict).is_err());
    assert_eq!(bits(cron("*/61 * * * *").minute), vec![0]);
}

#[test]
fn a_date_that_never_exists_is_not_valid_new_input() {
    assert!(!is_valid_new("0 0 31 2 *", "UTC", NOW));
    assert!(is_valid_new("0 0 29 2 *", "UTC", NOW));
    assert!(is_valid_new("0 9 * * 1-5", "UTC", NOW));
    assert!(!is_valid_new("*/61 * * * *", "UTC", NOW));
    // Both day fields restricted match on either, so the Monday is a date.
    assert!(is_valid_new("0 0 31 2 1", "UTC", NOW));
}

#[test]
fn an_rrule_without_a_time_runs_at_nine() {
    let r = rrule("FREQ=DAILY");
    assert_eq!((r.freq, r.hour, r.minute), (Freq::Daily, 9, 0));
    let r = rrule("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=30");
    assert_eq!(
        (r.freq, r.by_day, r.hour, r.minute),
        (Freq::Weekly, 0b0111110, 7, 30)
    );
    assert_eq!(rrule("FREQ=HOURLY;BYMINUTE=15").minute, 15);
}

#[test]
fn a_bad_rrule_is_refused() {
    for bad in [
        "FREQ=WEEKLY;BYDAY=XX",
        "FREQ=MONTHLY",
        "FREQ=DAILY;BYHOUR=24",
        "FREQ=DAILY;BYMINUTE=60",
        "BYHOUR=9",
        "FREQ=DAILY;INTERVAL=2",
        "FREQ=DAILY;BYHOUR=x",
    ] {
        assert!(
            matches!(
                parse(bad, ParseOptions::default()),
                Err(ScheduleError::Rrule(_))
            ),
            "{bad}"
        );
    }
}

#[test]
fn presets_build_the_stored_rule() {
    assert_eq!(
        build_rrule(Preset::Hourly, 9, 15, 0),
        "FREQ=HOURLY;BYMINUTE=15"
    );
    assert_eq!(
        build_rrule(Preset::Daily, 16, 30, 0),
        "FREQ=DAILY;BYHOUR=16;BYMINUTE=30"
    );
    assert_eq!(
        build_rrule(Preset::Weekdays, 9, 0, 0),
        "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0"
    );
    assert_eq!(
        build_rrule(Preset::Weekly, 14, 0, 4),
        "FREQ=WEEKLY;BYDAY=TH;BYHOUR=14;BYMINUTE=0"
    );
    assert_eq!(
        build_rrule(Preset::Weekly, 14, 0, 0),
        "FREQ=WEEKLY;BYDAY=SU;BYHOUR=14;BYMINUTE=0"
    );
    assert_eq!(build_rrule(Preset::Custom, 9, 0, 0), "");
}

#[test]
fn presets_build_a_cron() {
    assert_eq!(build_cron(Preset::Hourly, 9, 15, 0), "15 * * * *");
    assert_eq!(build_cron(Preset::Daily, 16, 30, 0), "30 16 * * *");
    assert_eq!(build_cron(Preset::Weekdays, 9, 0, 0), "0 9 * * 1-5");
    assert_eq!(build_cron(Preset::Weekly, 14, 0, 4), "0 14 * * 4");
    assert_eq!(build_cron(Preset::Custom, 9, 0, 0), "");
}

#[test]
fn describe_maps_a_cron_back_to_a_preset() {
    assert_eq!(
        describe("0 * * * *", "UTC", NOW),
        Describe::Hourly { minute: 0 }
    );
    assert_eq!(
        describe("15 * * * *", "UTC", NOW),
        Describe::Hourly { minute: 15 }
    );
    assert_eq!(
        describe("30 16 * * *", "UTC", NOW),
        Describe::Daily {
            hour: 16,
            minute: 30
        }
    );
    assert_eq!(
        describe("0 9 * * 1-5", "UTC", NOW),
        Describe::Weekdays { hour: 9, minute: 0 }
    );
    assert_eq!(
        describe("0 14 * * 4", "UTC", NOW),
        Describe::Weekly {
            hour: 14,
            minute: 0,
            day_of_week: 4
        }
    );
    assert_eq!(
        describe("0 14 * * 7", "UTC", NOW),
        Describe::Weekly {
            hour: 14,
            minute: 0,
            day_of_week: 0
        }
    );
    assert_eq!(
        describe("0 9 1 * 1", "UTC", NOW),
        Describe::Custom {
            expression: Some("0 9 1 * 1".into())
        }
    );
    assert_eq!(
        describe("*/5 * * * *", "UTC", NOW),
        Describe::Custom {
            expression: Some("*/5 * * * *".into())
        }
    );
    assert_eq!(describe("0 0 31 2 *", "UTC", NOW), Describe::Invalid);
    assert_eq!(describe("nonsense", "UTC", NOW), Describe::Invalid);
}

#[test]
fn describe_reads_the_preset_rrules() {
    assert_eq!(
        describe("FREQ=HOURLY;BYMINUTE=15", "UTC", NOW),
        Describe::Hourly { minute: 15 }
    );
    assert_eq!(
        describe("FREQ=DAILY;BYHOUR=16;BYMINUTE=30", "UTC", NOW),
        Describe::Daily {
            hour: 16,
            minute: 30
        }
    );
    assert_eq!(
        describe(&build_rrule(Preset::Weekdays, 9, 0, 0), "UTC", NOW),
        Describe::Weekdays { hour: 9, minute: 0 }
    );
    assert_eq!(
        describe(&build_rrule(Preset::Weekly, 14, 0, 4), "UTC", NOW),
        Describe::Weekly {
            hour: 14,
            minute: 0,
            day_of_week: 4
        }
    );
    assert_eq!(
        describe("FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9", "UTC", NOW),
        Describe::Custom { expression: None }
    );
    assert_eq!(describe("FREQ=MONTHLY", "UTC", NOW), Describe::Invalid);
}
