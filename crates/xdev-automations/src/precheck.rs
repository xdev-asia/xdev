//! The optional shell command that gates a run.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::model::{FailureCode, Precheck, PrecheckResult};

#[derive(Debug, Clone)]
pub struct ShellLine {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, OsString)>,
}

/// Trims; an empty command is no precheck; the timeout is clamped to 1..=600 s.
pub fn normalize(p: Option<Precheck>) -> Option<Precheck> {
    p
}

pub fn run(
    _line: &ShellLine,
    _cwd: &Path,
    _timeout: Duration,
    _now: &dyn Fn() -> i64,
) -> PrecheckResult {
    PrecheckResult {
        command: String::new(),
        exit_code: None,
        timed_out: false,
        duration_ms: 0,
        stdout: String::new(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
        error: Some("not implemented".into()),
        started_at: 0,
        completed_at: 0,
    }
}

pub fn passed(_r: &PrecheckResult) -> bool {
    false
}

pub fn failure(_r: &PrecheckResult) -> (FailureCode, BTreeMap<String, String>) {
    (FailureCode::PrecheckFailed, BTreeMap::new())
}
