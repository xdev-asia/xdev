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
pub fn parse(_expr: &str, _opts: ParseOptions) -> Result<Schedule, ScheduleError> {
    Err(ScheduleError::Empty)
}

/// New input: oversized steps refused and at least one date in 9×366 days.
pub fn is_valid_new(_expr: &str, _tz: &str, _now: i64) -> bool {
    false
}

pub fn build_rrule(_preset: Preset, _hour: u8, _minute: u8, _day_of_week: u8) -> String {
    String::new()
}

pub fn build_cron(_preset: Preset, _hour: u8, _minute: u8, _day_of_week: u8) -> String {
    String::new()
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

pub fn describe(_expr: &str, _tz: &str, _now: i64) -> Describe {
    Describe::Invalid
}
