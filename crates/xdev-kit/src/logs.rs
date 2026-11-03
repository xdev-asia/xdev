//! What the usage and session indexes share: the walk over the CLI session
//! logs, the per-file read marks, line reading and timestamps. The one place
//! that knows where each CLI keeps its logs.

use std::fs;
use std::io::{self, BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Agent, Home};

const MAX_CODEX_DEPTH: usize = 6;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileMark {
    pub len: u64,
    pub mtime_ns: i128,
    /// Just after the last complete line that was read.
    pub offset: u64,
    /// Key into the index's `sessions`.
    pub session: String,
    /// Message ids (API ids, not text) the reader needs to go on from
    /// `offset`: the usage index keeps the last counted Claude ids, oldest
    /// first, to skip a message logged again; the session index keeps the last
    /// Claude reply id.
    #[serde(default)]
    pub recent_ids: Vec<String>,
}

/// Where to go on reading a file that has `mark`: `None` when it did not
/// change, `Some(0)` when it was rewritten or cut, else the mark's offset.
pub(crate) fn start_at(mark: &FileMark, len: u64, mtime_ns: i128) -> Option<u64> {
    if mark.len == len && mark.mtime_ns == mtime_ns {
        return None;
    }
    let rewritten = len < mark.offset || (mark.mtime_ns != mtime_ns && len <= mark.offset);
    Some(if rewritten { 0 } else { mark.offset })
}

pub(crate) fn mtime_ns(meta: &fs::Metadata) -> i128 {
    let Ok(modified) = meta.modified() else {
        return 0;
    };
    match modified.duration_since(UNIX_EPOCH) {
        Ok(d) => i128::try_from(d.as_nanos()).unwrap_or(i128::MAX),
        Err(e) => -i128::try_from(e.duration().as_nanos()).unwrap_or(i128::MAX),
    }
}

pub(crate) fn log_files(home: &Home) -> Vec<PathBuf> {
    let mut out = Vec::new();
    match home.agent {
        Agent::Claude => {
            for dir in sorted_entries(&home.path.join("projects")) {
                if !dir.is_dir() {
                    continue;
                }
                for file in sorted_entries(&dir) {
                    if file.is_file() && has_ext(&file, "jsonl") {
                        out.push(file);
                    }
                }
            }
        }
        Agent::Codex => collect_rollouts(&home.path.join("sessions"), 0, &mut out),
    }
    out
}

fn collect_rollouts(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_CODEX_DEPTH {
        return;
    }
    for path in sorted_entries(dir) {
        if path.is_dir() {
            collect_rollouts(&path, depth + 1, out);
        } else if path.is_file()
            && has_ext(&path, "jsonl")
            && path
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("rollout-"))
        {
            out.push(path);
        }
    }
}

fn sorted_entries(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = read.filter_map(|e| e.ok().map(|e| e.path())).collect();
    paths.sort();
    paths
}

fn has_ext(path: &Path, ext: &str) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

/// Calls `f(line_start, line)` for each complete line from `start` and
/// returns the offset just after the last `\n`. A last line without `\n` is
/// left for the next call.
pub(crate) fn for_each_line(
    path: &Path,
    start: u64,
    mut f: impl FnMut(u64, &[u8]),
) -> io::Result<u64> {
    let mut file = fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut reader = BufReader::new(file);
    let mut pos = start;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 || buf.last() != Some(&b'\n') {
            return Ok(pos);
        }
        let line_start = pos;
        pos += n as u64;
        let mut line = &buf[..buf.len() - 1];
        if line.last() == Some(&b'\r') {
            line = &line[..line.len() - 1];
        }
        f(line_start, line);
    }
}

pub(crate) fn parse_line(line: &[u8]) -> Option<Value> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    serde_json::from_slice::<Value>(line).ok()
}

pub(crate) fn is_blank(line: &[u8]) -> bool {
    line.iter().all(u8::is_ascii_whitespace)
}

pub(crate) fn line_time(v: &Value) -> Option<i64> {
    v.get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_ts)
}

/// `YYYY-MM-DDTHH:MM:SS[.fff…](Z|±HH:MM|±HHMM)` to unix ms. No offset means UTC.
pub(crate) fn parse_ts(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || !(b[10] == b'T' || b[10] == b' ')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let field = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let (year, month, day) = (field(0, 4)?, field(5, 7)?, field(8, 10)?);
    let (hour, minute, second) = (field(11, 13)?, field(14, 16)?, field(17, 19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut rest = s.get(19..)?;
    let mut millis = 0;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let first3 = format!("{:0<3}", &frac[..digits.min(3)]);
        millis = first3.parse::<i64>().ok()?;
        rest = &frac[digits..];
    }
    let offset_min = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits: String = rest[1..].chars().filter(|c| *c != ':').collect();
            if digits.len() != 4 || !digits.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let hh: i64 = digits[..2].parse().ok()?;
            let mm: i64 = digits[2..].parse().ok()?;
            sign * (hh * 60 + mm)
        }
    };
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second - offset_min * 60;
    Some(secs * 1000 + millis)
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
