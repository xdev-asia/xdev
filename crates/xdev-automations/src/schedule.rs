//! Schedules: a preset RRULE or a five-field cron (vixie dialect).

use serde::{Deserialize, Serialize};

pub const CRON_MAX_BYTES: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    Hourly,
    Daily,
    Weekdays,
    Weekly,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ScheduleError {
    #[error("empty schedule")]
    Empty,
    #[error("schedule is longer than {CRON_MAX_BYTES} bytes")]
    TooLong,
    #[error("a cron needs five fields")]
    FieldCount,
    /// `field` is `minute`, `hour`, `day`, `month` or `weekday`.
    #[error("bad {field} field: {detail}")]
    Field { field: &'static str, detail: String },
    /// A step larger than the field's value count (new input only).
    #[error("Cron {field} step must be between 1 and {max}.")]
    Step { field: &'static str, max: u32 },
    #[error("bad rule: {0}")]
    Rrule(String),
    #[error("no date in range")]
    NoDate,
    #[error("unknown time zone")]
    TimeZone,
}

/// A parsed rule; the bit sets hold the allowed values of each field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCron {
    pub minute: u64,
    pub hour: u32,
    pub dom: u32,
    pub month: u16,
    /// Bit 0 = Sunday.
    pub dow: u8,
    pub dom_restricted: bool,
    pub dow_restricted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freq {
    Hourly,
    Daily,
    Weekly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRrule {
    pub freq: Freq,
    /// Bit 0 = Sunday; empty means every day.
    pub by_day: u8,
    pub hour: u8,
    pub minute: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Schedule {
    Rrule(ParsedRrule),
    Cron(ParsedCron),
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ParseOptions {
    pub reject_oversized_step: bool,
}

/// Anything with `=` is an RRULE, the rest a cron.
pub fn parse(expr: &str, opts: ParseOptions) -> Result<Schedule, ScheduleError> {
    let expr = expr.trim();
    if expr.is_empty() {
        return Err(ScheduleError::Empty);
    }
    if expr.len() > CRON_MAX_BYTES {
        return Err(ScheduleError::TooLong);
    }
    if expr.contains('=') {
        parse_rrule(expr).map(Schedule::Rrule)
    } else {
        parse_cron(expr, opts).map(Schedule::Cron)
    }
}

struct Spec {
    name: &'static str,
    min: u32,
    max: u32,
    /// How many distinct values the field has; the largest step a new rule may use.
    count: u32,
}

const MINUTE: Spec = Spec {
    name: "minute",
    min: 0,
    max: 59,
    count: 60,
};
const HOUR: Spec = Spec {
    name: "hour",
    min: 0,
    max: 23,
    count: 24,
};
const DAY: Spec = Spec {
    name: "day",
    min: 1,
    max: 31,
    count: 31,
};
const MONTH: Spec = Spec {
    name: "month",
    min: 1,
    max: 12,
    count: 12,
};
// 7 is a second spelling of Sunday.
const WEEKDAY: Spec = Spec {
    name: "weekday",
    min: 0,
    max: 7,
    count: 7,
};

const MONTH_NAMES: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const DAY_NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

fn field_err(spec: &Spec, detail: impl Into<String>) -> ScheduleError {
    ScheduleError::Field {
        field: spec.name,
        detail: detail.into(),
    }
}

fn value(spec: &Spec, text: &str) -> Result<u32, ScheduleError> {
    let lower = text.to_ascii_lowercase();
    let named = match spec.name {
        "month" => MONTH_NAMES
            .iter()
            .position(|n| *n == lower)
            .map(|i| i as u32 + 1),
        "weekday" => DAY_NAMES
            .iter()
            .position(|n| *n == lower || (lower.len() == 2 && n.starts_with(&lower)))
            .map(|i| i as u32),
        _ => None,
    };
    let v = match named {
        Some(v) => v,
        None if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) => {
            text.parse::<u32>().map_err(|_| field_err(spec, text))?
        }
        None => return Err(field_err(spec, text)),
    };
    if v < spec.min || v > spec.max {
        return Err(field_err(spec, format!("{v} is out of range")));
    }
    Ok(v)
}

/// The values of one field as a bit set, and whether the field is restricted (no term starts with `*`).
fn field(text: &str, spec: &Spec, opts: ParseOptions) -> Result<(u64, bool), ScheduleError> {
    let mut bits = 0u64;
    let mut star = false;
    for term in text.split(',') {
        let (base, step) = match term.split_once('/') {
            Some((b, s)) => (b, Some(s)),
            None => (term, None),
        };
        let step = match step {
            None => 1,
            Some(s) => {
                let n = s
                    .parse::<u32>()
                    .ok()
                    .filter(|n| s.bytes().all(|b| b.is_ascii_digit()) && *n >= 1)
                    .ok_or(ScheduleError::Step {
                        field: spec.name,
                        max: spec.count,
                    })?;
                if opts.reject_oversized_step && n > spec.count {
                    return Err(ScheduleError::Step {
                        field: spec.name,
                        max: spec.count,
                    });
                }
                n
            }
        };
        let (lo, hi) = if base == "*" {
            star = true;
            (spec.min, spec.max)
        } else if let Some((a, b)) = base.split_once('-') {
            let (a, b) = (value(spec, a)?, value(spec, b)?);
            if a > b {
                return Err(field_err(spec, format!("{a}-{b} runs backwards")));
            }
            (a, b)
        } else {
            let a = value(spec, base)?;
            if term.contains('/') {
                (a, spec.max)
            } else {
                (a, a)
            }
        };
        let mut v = lo;
        while v <= hi {
            bits |= 1
                << if spec.name == "weekday" && v == 7 {
                    0
                } else {
                    v
                };
            v += step;
        }
    }
    // `*` with a step still counts as a star term, but a weekday star must not restrict.
    Ok((bits, !star))
}

fn parse_cron(expr: &str, opts: ParseOptions) -> Result<ParsedCron, ScheduleError> {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return Err(ScheduleError::FieldCount);
    }
    let (minute, _) = field(parts[0], &MINUTE, opts)?;
    let (hour, _) = field(parts[1], &HOUR, opts)?;
    let (dom, dom_restricted) = field(parts[2], &DAY, opts)?;
    let (month, _) = field(parts[3], &MONTH, opts)?;
    let (dow, dow_restricted) = field(parts[4], &WEEKDAY, opts)?;
    Ok(ParsedCron {
        minute,
        hour: hour as u32,
        dom: dom as u32,
        month: month as u16,
        dow: dow as u8,
        dom_restricted,
        dow_restricted,
    })
}

const BYDAY: [&str; 7] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

fn parse_rrule(expr: &str) -> Result<ParsedRrule, ScheduleError> {
    let bad = |m: String| ScheduleError::Rrule(m);
    let body = expr.strip_prefix("RRULE:").unwrap_or(expr);
    let (mut freq, mut by_day, mut hour, mut minute) = (None, 0u8, 9u8, 0u8);
    for part in body.split(';').filter(|p| !p.is_empty()) {
        let (key, val) = part.split_once('=').ok_or_else(|| bad(part.into()))?;
        match key.to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match val.to_ascii_uppercase().as_str() {
                    "HOURLY" => Freq::Hourly,
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    other => return Err(bad(format!("FREQ={other}"))),
                })
            }
            "BYDAY" => {
                by_day = 0;
                for d in val.split(',') {
                    let i = BYDAY
                        .iter()
                        .position(|n| n.eq_ignore_ascii_case(d))
                        .ok_or_else(|| bad(format!("BYDAY={d}")))?;
                    by_day |= 1 << i;
                }
            }
            "BYHOUR" => {
                hour = val
                    .parse()
                    .ok()
                    .filter(|h| *h < 24)
                    .ok_or_else(|| bad(format!("BYHOUR={val}")))?
            }
            "BYMINUTE" => {
                minute = val
                    .parse()
                    .ok()
                    .filter(|m| *m < 60)
                    .ok_or_else(|| bad(format!("BYMINUTE={val}")))?
            }
            other => return Err(bad(format!("{other} is not supported"))),
        }
    }
    let freq = freq.ok_or_else(|| bad("FREQ is missing".into()))?;
    Ok(ParsedRrule {
        freq,
        by_day,
        hour,
        minute,
    })
}

fn days_in_month_max(month: u32) -> u32 {
    match month {
        2 => 29,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Whether some calendar date can match (leap years count): `0 0 31 2 *` has none.
fn has_date(c: &ParsedCron) -> bool {
    if c.minute == 0 || c.hour == 0 || c.month == 0 || c.dom == 0 && c.dow == 0 {
        return false;
    }
    let dom_ok = (1..=12u32)
        .filter(|m| c.month >> m & 1 == 1)
        .any(|m| (1..=days_in_month_max(m)).any(|d| c.dom >> d & 1 == 1));
    if c.dom_restricted && c.dow_restricted {
        dom_ok || c.dow != 0
    } else {
        // An unrestricted side matches every day it lists; both sides must hold.
        dom_ok && c.dow != 0
    }
}

/// New input: oversized steps refused and at least one date in 9×366 days.
pub fn is_valid_new(expr: &str, _tz: &str, _now: i64) -> bool {
    match parse(
        expr,
        ParseOptions {
            reject_oversized_step: true,
        },
    ) {
        Ok(Schedule::Cron(c)) => has_date(&c),
        Ok(Schedule::Rrule(_)) => true,
        Err(_) => false,
    }
}

const DAY_NAMES_RRULE: [&str; 7] = BYDAY;

pub fn build_rrule(preset: Preset, hour: u8, minute: u8, day_of_week: u8) -> String {
    match preset {
        Preset::Hourly => format!("FREQ=HOURLY;BYMINUTE={minute}"),
        Preset::Daily => format!("FREQ=DAILY;BYHOUR={hour};BYMINUTE={minute}"),
        Preset::Weekdays => {
            format!("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR={hour};BYMINUTE={minute}")
        }
        Preset::Weekly => format!(
            "FREQ=WEEKLY;BYDAY={};BYHOUR={hour};BYMINUTE={minute}",
            DAY_NAMES_RRULE[usize::from(day_of_week % 7)]
        ),
        Preset::Custom => String::new(),
    }
}

pub fn build_cron(preset: Preset, hour: u8, minute: u8, day_of_week: u8) -> String {
    match preset {
        Preset::Hourly => format!("{minute} * * * *"),
        Preset::Daily => format!("{minute} {hour} * * *"),
        Preset::Weekdays => format!("{minute} {hour} * * 1-5"),
        Preset::Weekly => format!("{minute} {hour} * * {}", day_of_week % 7),
        Preset::Custom => String::new(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Describe {
    Hourly {
        minute: u8,
    },
    Daily {
        hour: u8,
        minute: u8,
    },
    Weekdays {
        hour: u8,
        minute: u8,
    },
    Weekly {
        hour: u8,
        minute: u8,
        day_of_week: u8,
    },
    Custom {
        expression: Option<String>,
    },
    Invalid,
}

const WEEKDAYS: u8 = 0b0111110;
const ALL_DAYS: u8 = 0b1111111;

/// Names the preset a rule is, when it is one; `Invalid` when it cannot run at all.
pub fn describe(expr: &str, _tz: &str, _now: i64) -> Describe {
    match parse(expr, ParseOptions::default()) {
        Err(_) => Describe::Invalid,
        Ok(Schedule::Rrule(r)) => {
            let (hour, minute) = (r.hour, r.minute);
            match r.freq {
                Freq::Hourly => Describe::Hourly { minute },
                Freq::Daily => Describe::Daily { hour, minute },
                Freq::Weekly if r.by_day == WEEKDAYS => Describe::Weekdays { hour, minute },
                Freq::Weekly if r.by_day.count_ones() == 1 => Describe::Weekly {
                    hour,
                    minute,
                    day_of_week: r.by_day.trailing_zeros() as u8,
                },
                Freq::Weekly if r.by_day == ALL_DAYS || r.by_day == 0 => {
                    Describe::Daily { hour, minute }
                }
                Freq::Weekly => Describe::Custom { expression: None },
            }
        }
        Ok(Schedule::Cron(c)) => {
            if !has_date(&c) {
                return Describe::Invalid;
            }
            let custom = Describe::Custom {
                expression: Some(expr.trim().to_string()),
            };
            let one_minute = c.minute.count_ones() == 1;
            let any_day = !c.dom_restricted && c.dom == 0xFFFF_FFFE && c.month == 0x1FFE;
            if !one_minute || !any_day || c.dow_restricted && c.dom_restricted {
                return custom;
            }
            let minute = c.minute.trailing_zeros() as u8;
            let every_hour = c.hour == 0x00FF_FFFF;
            let one_hour = c.hour.count_ones() == 1;
            let hour = c.hour.trailing_zeros() as u8;
            if every_hour && !c.dow_restricted && c.dow == ALL_DAYS {
                Describe::Hourly { minute }
            } else if one_hour && !c.dow_restricted && c.dow == ALL_DAYS {
                Describe::Daily { hour, minute }
            } else if one_hour && c.dow == WEEKDAYS {
                Describe::Weekdays { hour, minute }
            } else if one_hour && c.dow.count_ones() == 1 {
                Describe::Weekly {
                    hour,
                    minute,
                    day_of_week: c.dow.trailing_zeros() as u8,
                }
            } else {
                custom
            }
        }
    }
}
