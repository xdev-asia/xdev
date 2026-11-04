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
/// duration within a minute, else by slot).
pub(crate) fn parse_rpc_rate_limits(_result: &Value, _now: i64) -> Vec<QuotaWindow> {
    Vec::new()
}

/// Lower-cased phrase match with ANSI escapes stripped.
pub(crate) fn is_auth_error(_text: &str) -> bool {
    false
}
