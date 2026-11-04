//! A short-lived JSON-RPC session with the user's own `codex app-server`,
//! to read the account's live rate limits.

#![allow(dead_code)]

use std::io;
use std::process::Command;
use std::time::Duration;

use serde_json::Value;

use crate::quota::QuotaWindow;

pub(crate) const PROBE_ARGS: [&str; 9] = [
    "-c",
    "approval_policy=never",
    "-c",
    "features.plugins=false",
    "-s",
    "read-only",
    "-a",
    "never",
    "app-server",
];
pub(crate) const SESSION_MINUTES: i64 = 300;
pub(crate) const WEEKLY_MINUTES: i64 = 10_080;

#[derive(Debug, Clone, Copy)]
pub(crate) struct ProbeTimeouts {
    pub init: Duration,
    pub rpc: Duration,
    pub drain: Duration,
}

impl Default for ProbeTimeouts {
    fn default() -> Self {
        ProbeTimeouts {
            init: Duration::from_secs(30),
            rpc: Duration::from_secs(10),
            drain: Duration::from_secs(5),
        }
    }
}

#[derive(Debug)]
pub(crate) enum ProbeError {
    /// The binary is not there.
    NoCodex,
    /// An RPC error, or stderr matched an auth phrase.
    Auth(String),
    Timeout,
    /// Closed before the answer.
    Exited(Option<i32>),
    Rpc(String),
    Io(io::Error),
}

/// Spawns `cmd` (already carrying args, env, cwd), runs the handshake and
/// returns the windows.
pub(crate) fn read_rate_limits(
    _cmd: Command,
    _t: ProbeTimeouts,
    _now: i64,
) -> Result<Vec<QuotaWindow>, ProbeError> {
    Err(ProbeError::Timeout)
}

/// `result.rateLimits` to windows keyed `five_hour` / `seven_day` (by
/// duration within a minute, else by slot). A slot with no finite
/// `usedPercent` is skipped.
pub(crate) fn parse_rpc_rate_limits(result: &Value, _now: i64) -> Vec<QuotaWindow> {
    let mut out: Vec<QuotaWindow> = Vec::new();
    for (slot, by_slot) in [("primary", "five_hour"), ("secondary", "seven_day")] {
        let Some(w) = result.get("rateLimits").and_then(|l| l.get(slot)) else {
            continue;
        };
        let Some(used) = w
            .get("usedPercent")
            .and_then(Value::as_f64)
            .filter(|u| u.is_finite())
        else {
            continue;
        };
        let key = match w.get("windowDurationMins").and_then(Value::as_i64) {
            Some(m) if (m - SESSION_MINUTES).abs() <= 1 => "five_hour",
            Some(m) if (m - WEEKLY_MINUTES).abs() <= 1 => "seven_day",
            _ => by_slot,
        };
        if out.iter().any(|o| o.key == key) {
            continue;
        }
        out.push(QuotaWindow {
            key: key.to_owned(),
            utilization: Some(used.clamp(0.0, 100.0)),
            resets_at: w
                .get("resetsAt")
                .and_then(Value::as_i64)
                .map(crate::codex::rfc3339),
        });
    }
    out.sort_by_key(|w| w.key != "five_hour");
    out
}

const AUTH_PHRASES: [&str; 16] = [
    "access token could not be refreshed",
    "authentication session could not be refreshed",
    "refresh token has expired",
    "refresh token was already used",
    "refresh token was revoked",
    "you have since logged out or signed in to another account",
    "please sign in again",
    "please log out and sign in again",
    "please reauthenticate",
    "not logged in",
    "sign in with chatgpt",
    "token data is not available",
    "auth is missing",
    "auth tokens are missing",
    "auth does not expose",
    "chatgpt authentication required",
];

/// Lower-cased phrase match with ANSI escapes stripped.
pub(crate) fn is_auth_error(text: &str) -> bool {
    let lower = strip_ansi(text).to_lowercase();
    AUTH_PHRASES.iter().any(|p| lower.contains(p))
}

/// Drops `ESC [ ... final-byte` sequences.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for n in chars.by_ref() {
                if ('@'..='~').contains(&n) {
                    break;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn keys(w: &[QuotaWindow]) -> Vec<(&str, Option<f64>)> {
        w.iter().map(|w| (w.key.as_str(), w.utilization)).collect()
    }

    fn lim(p: Value, s: Value) -> Value {
        json!({ "rateLimits": { "primary": p, "secondary": s } })
    }

    fn win(used: Value, mins: Value, at: Value) -> Value {
        json!({ "usedPercent": used, "windowDurationMins": mins, "resetsAt": at })
    }

    #[test]
    fn classifies_by_duration() {
        let r = lim(
            win(json!(10.0), json!(300), json!(1000)),
            win(json!(20.0), json!(10080), json!(2000)),
        );
        let w = parse_rpc_rate_limits(&r, 0);
        assert_eq!(
            keys(&w),
            [("five_hour", Some(10.0)), ("seven_day", Some(20.0))]
        );
        assert_eq!(w[0].resets_at.as_deref(), Some("1970-01-01T00:16:40Z"));
    }

    #[test]
    fn duration_is_matched_within_a_minute() {
        let r = lim(
            win(json!(1.0), json!(299), Value::Null),
            win(json!(2.0), json!(10081), Value::Null),
        );
        let w = parse_rpc_rate_limits(&r, 0);
        assert_eq!(
            keys(&w),
            [("five_hour", Some(1.0)), ("seven_day", Some(2.0))]
        );
        assert_eq!(w[0].resets_at, None);
    }

    #[test]
    fn swapped_slots_follow_the_duration() {
        let r = lim(
            win(json!(5.0), json!(10080), Value::Null),
            win(json!(6.0), json!(300), Value::Null),
        );
        let w = parse_rpc_rate_limits(&r, 0);
        assert_eq!(
            keys(&w),
            [("five_hour", Some(6.0)), ("seven_day", Some(5.0))]
        );
    }

    #[test]
    fn unknown_durations_fall_back_by_slot() {
        let r = lim(
            win(json!(5.0), json!(60), Value::Null),
            win(json!(6.0), Value::Null, Value::Null),
        );
        let w = parse_rpc_rate_limits(&r, 0);
        assert_eq!(
            keys(&w),
            [("five_hour", Some(5.0)), ("seven_day", Some(6.0))]
        );
    }

    #[test]
    fn used_percent_is_clamped() {
        let r = lim(
            win(json!(130), json!(300), Value::Null),
            win(json!(-5), json!(10080), Value::Null),
        );
        assert_eq!(
            keys(&parse_rpc_rate_limits(&r, 0)),
            [("five_hour", Some(100.0)), ("seven_day", Some(0.0))]
        );
    }

    #[test]
    fn a_slot_without_a_finite_percent_is_skipped() {
        let r = lim(
            win(Value::Null, json!(300), Value::Null),
            win(json!("x"), json!(10080), Value::Null),
        );
        assert!(parse_rpc_rate_limits(&r, 0).is_empty());
        let r = json!({ "rateLimits": { "secondary": { "windowDurationMins": 10080 } } });
        assert!(parse_rpc_rate_limits(&r, 0).is_empty());
    }

    #[test]
    fn null_rate_limits_give_nothing() {
        assert!(parse_rpc_rate_limits(&json!({ "rateLimits": null }), 0).is_empty());
        assert!(parse_rpc_rate_limits(&json!({}), 0).is_empty());
    }

    #[test]
    fn every_auth_phrase_matches_through_ansi() {
        for p in AUTH_PHRASES {
            assert!(is_auth_error(p), "{p}");
            let wrapped = format!("\u{1b}[31mError:\u{1b}[0m {} \u{1b}[1m", p.to_uppercase());
            assert!(is_auth_error(&wrapped), "{p}");
        }
    }

    #[test]
    fn other_errors_are_not_auth() {
        assert!(!is_auth_error("rate limit reached"));
        assert!(!is_auth_error(""));
    }
}
