//! Token usage read from the CLI session logs. The index holds counts, ids,
//! times, model names and folder keys, never prompt or reply text.
//!
//! Day keys are UTC `YYYY-MM-DD`: std has no local time zone, and no time
//! crate is allowed in this crate.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Agent, Home, KitError};

const VERSION: u32 = 1;
const TOP_SESSIONS: usize = 20;
const MAX_CODEX_DEPTH: usize = 6;
const UNKNOWN: &str = "(unknown)";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Tokens {
    pub fn add(&mut self, other: &Tokens) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
        self.cache_write = self.cache_write.saturating_add(other.cache_write);
    }

    /// All four counts together; the sort key for the summary lists.
    pub fn sum(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct SessionUsage {
    /// The log file's stem.
    pub id: String,
    pub home_id: String,
    pub agent: Agent,
    pub folder: Option<String>,
    pub model: Option<String>,
    /// Unix ms; 0 when no line had a time.
    pub first: i64,
    pub last: i64,
    pub total: Tokens,
    /// UTC `YYYY-MM-DD`.
    pub days: BTreeMap<String, Tokens>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileMark {
    pub len: u64,
    pub mtime_ns: i128,
    /// Just after the last complete line that was read.
    pub offset: u64,
    /// Key into `UsageIndex::sessions`.
    pub session: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageIndex {
    pub version: u32,
    /// Keyed by the log file's path.
    #[serde(default)]
    pub files: BTreeMap<String, FileMark>,
    /// Keyed by `<home id>:<session id>`.
    #[serde(default)]
    pub sessions: BTreeMap<String, SessionUsage>,
}

impl Default for UsageIndex {
    fn default() -> Self {
        Self {
            version: VERSION,
            files: BTreeMap::new(),
            sessions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct RefreshStats {
    /// Log files that were opened and read, from the start or from a mark.
    pub files_read: usize,
    /// JSON lines that could not be used.
    pub bad_lines: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct UsageQuery {
    /// Inclusive, `YYYY-MM-DD`.
    pub since_day: String,
    /// Inclusive, `YYYY-MM-DD`.
    pub until_day: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct UsageSummary {
    /// Oldest day first.
    pub days: Vec<(String, Tokens)>,
    /// Largest first.
    pub by_home: Vec<(String, Tokens)>,
    pub by_folder: Vec<(String, Tokens)>,
    pub by_model: Vec<(String, Tokens)>,
    /// At most 20, largest first. `total` and `days` cover the query range only.
    pub top_sessions: Vec<SessionUsage>,
}

fn index_path(data_dir: &Path) -> PathBuf {
    data_dir.join("kit").join("usage.json")
}

impl UsageIndex {
    /// An index that is missing, unreadable or of another version gives a
    /// fresh one; the next `refresh` rebuilds it.
    pub fn load(data_dir: &Path) -> Self {
        fs::read(index_path(data_dir))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<UsageIndex>(&bytes).ok())
            .filter(|index| index.version == VERSION)
            .unwrap_or_default()
    }

    pub fn save(&self, data_dir: &Path) -> Result<(), KitError> {
        let path = index_path(data_dir);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec(self).map_err(|e| KitError::Parse(e.to_string()))?;
        let tmp = path.with_extension("json.xdev-tmp");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Reads what is new in the session logs of `homes`. A log that was not
    /// touched since the last call is not opened.
    pub fn refresh(&mut self, homes: &[Home]) -> RefreshStats {
        let mut stats = RefreshStats::default();
        if self.version != VERSION {
            *self = Self::default();
        }
        for home in homes {
            for file in log_files(home) {
                self.refresh_file(home, &file, &mut stats);
            }
        }
        stats
    }

    fn refresh_file(&mut self, home: &Home, path: &Path, stats: &mut RefreshStats) {
        let Ok(meta) = fs::metadata(path) else {
            return;
        };
        let len = meta.len();
        let mtime_ns = mtime_ns(&meta);
        let file_key = path.to_string_lossy().into_owned();
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let session_key = format!("{}:{stem}", home.id);

        let mut start = 0;
        if let Some(mark) = self.files.get(&file_key) {
            if mark.len == len && mark.mtime_ns == mtime_ns {
                return;
            }
            let rewritten = len < mark.offset || (mark.mtime_ns != mtime_ns && len <= mark.offset);
            if !rewritten && mark.session == session_key {
                start = mark.offset;
            }
        }
        // From 0 the totals start again; a session with no mark would
        // otherwise be counted twice.
        let existing = if start > 0 {
            self.sessions.get(&session_key).cloned()
        } else {
            None
        };
        if existing.is_none() {
            start = 0;
        }
        let existed = existing.is_some();
        let mut session = existing.unwrap_or_else(|| SessionUsage {
            id: stem.clone(),
            home_id: home.id.clone(),
            agent: home.agent,
            folder: None,
            model: None,
            first: 0,
            last: 0,
            total: Tokens::default(),
            days: BTreeMap::new(),
        });

        let mut bad = 0;
        let mut touched = false;
        let read = match home.agent {
            Agent::Claude => read_claude(path, start, &mut session, &mut bad, &mut touched),
            Agent::Codex => read_codex(path, start, &mut session, &mut bad, &mut touched),
        };
        let Ok(offset) = read else {
            return;
        };

        stats.files_read += 1;
        stats.bad_lines += bad;
        if existed || touched {
            self.sessions.insert(session_key.clone(), session);
        } else {
            self.sessions.remove(&session_key);
        }
        self.files.insert(
            file_key,
            FileMark {
                len,
                mtime_ns,
                offset,
                session: session_key,
            },
        );
    }
}

fn mtime_ns(meta: &fs::Metadata) -> i128 {
    let Ok(modified) = meta.modified() else {
        return 0;
    };
    match modified.duration_since(UNIX_EPOCH) {
        Ok(d) => i128::try_from(d.as_nanos()).unwrap_or(i128::MAX),
        Err(e) => -i128::try_from(e.duration().as_nanos()).unwrap_or(i128::MAX),
    }
}

fn log_files(home: &Home) -> Vec<PathBuf> {
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
fn for_each_line(path: &Path, start: u64, mut f: impl FnMut(u64, &[u8])) -> io::Result<u64> {
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

fn parse_line(line: &[u8]) -> Option<Value> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    serde_json::from_slice::<Value>(line).ok()
}

fn is_blank(line: &[u8]) -> bool {
    line.iter().all(u8::is_ascii_whitespace)
}

fn num(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn note_time(session: &mut SessionUsage, ts: Option<i64>) {
    if let Some(ms) = ts {
        if session.first == 0 || ms < session.first {
            session.first = ms;
        }
        if ms > session.last {
            session.last = ms;
        }
    }
}

fn line_time(v: &Value) -> Option<i64> {
    v.get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_ts)
}

fn add_day(session: &mut SessionUsage, ms: i64, t: &Tokens) {
    session.total.add(t);
    session.days.entry(day_key(ms)).or_default().add(t);
}

/// Claude Code: `<home>/projects/*/*.jsonl`. When a file is read again from a
/// mark, the part before the mark is read only to collect the message ids
/// already counted; ids are not kept in the index.
fn read_claude(
    path: &Path,
    start: u64,
    session: &mut SessionUsage,
    bad: &mut usize,
    touched: &mut bool,
) -> io::Result<u64> {
    let mut seen: HashSet<String> = HashSet::new();
    for_each_line(path, 0, |pos, line| {
        let counting = pos >= start;
        if !counting && !contains(line, b"\"usage\"") {
            return;
        }
        let Some(v) = parse_line(line) else {
            if counting && !is_blank(line) {
                *bad += 1;
            }
            return;
        };
        let message = v.get("message");
        let usage = message
            .and_then(|m| m.get("usage"))
            .filter(|u| u.is_object());
        let is_usage_line = v.get("type").and_then(Value::as_str) == Some("assistant");
        let duplicate = match (is_usage_line, usage) {
            (true, Some(_)) => message
                .and_then(|m| m.get("id"))
                .and_then(Value::as_str)
                .is_some_and(|id| !seen.insert(id.to_string())),
            _ => false,
        };
        if !counting {
            return;
        }
        *touched = true;
        let ts = line_time(&v);
        note_time(session, ts);
        if session.folder.is_none() {
            session.folder = v.get("cwd").and_then(Value::as_str).map(str::to_string);
        }
        let (true, Some(usage), false) = (is_usage_line, usage, duplicate) else {
            return;
        };
        if let Some(model) = message.and_then(|m| m.get("model")).and_then(Value::as_str) {
            session.model = Some(model.to_string());
        }
        let Some(ms) = ts else {
            *bad += 1;
            return;
        };
        let t = Tokens {
            input: num(usage, "input_tokens"),
            output: num(usage, "output_tokens"),
            cache_read: num(usage, "cache_read_input_tokens"),
            cache_write: num(usage, "cache_creation_input_tokens"),
        };
        add_day(session, ms, &t);
    })
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn codex_tokens(v: &Value) -> Tokens {
    let cached = num(v, "cached_input_tokens");
    Tokens {
        input: num(v, "input_tokens").saturating_sub(cached),
        output: num(v, "output_tokens"),
        cache_read: cached,
        cache_write: num(v, "cache_write_input_tokens"),
    }
}

/// Codex CLI: `<home>/sessions/**/rollout-*.jsonl`.
fn read_codex(
    path: &Path,
    start: u64,
    session: &mut SessionUsage,
    bad: &mut usize,
    touched: &mut bool,
) -> io::Result<u64> {
    for_each_line(path, start, |_, line| {
        let Some(v) = parse_line(line) else {
            if !is_blank(line) {
                *bad += 1;
            }
            return;
        };
        *touched = true;
        let ts = line_time(&v);
        note_time(session, ts);
        let payload = v.get("payload");
        match v.get("type").and_then(Value::as_str) {
            Some("session_meta" | "turn_context") => {
                if session.folder.is_none() {
                    session.folder = payload
                        .and_then(|p| p.get("cwd"))
                        .or_else(|| v.get("cwd"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                if let Some(model) = payload.and_then(|p| p.get("model")).and_then(Value::as_str) {
                    session.model = Some(model.to_string());
                }
            }
            Some("event_msg") => {
                let Some(payload) = payload else {
                    return;
                };
                if payload.get("type").and_then(Value::as_str) != Some("token_count") {
                    return;
                }
                let Some(info) = payload.get("info").filter(|i| i.is_object()) else {
                    return;
                };
                if let Some(last) = info.get("last_token_usage").filter(|u| u.is_object()) {
                    match ts {
                        Some(ms) => {
                            // `add_day` also adds to the total; the total is
                            // set from `total_token_usage` below.
                            let before = session.total;
                            add_day(session, ms, &codex_tokens(last));
                            session.total = before;
                        }
                        None => *bad += 1,
                    }
                }
                if let Some(total) = info.get("total_token_usage").filter(|u| u.is_object()) {
                    session.total = codex_tokens(total);
                }
            }
            _ => {}
        }
    })
}

/// `YYYY-MM-DDTHH:MM:SS[.fff…](Z|±HH:MM|±HHMM)` to unix ms. No offset means UTC.
fn parse_ts(s: &str) -> Option<i64> {
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

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// UTC `YYYY-MM-DD` of a unix ms time.
fn day_key(ms: i64) -> String {
    let (y, m, d) = civil_from_days(ms.div_euclid(86_400_000));
    format!("{y:04}-{m:02}-{d:02}")
}

fn sorted_by_total(map: BTreeMap<String, Tokens>) -> Vec<(String, Tokens)> {
    let mut list: Vec<(String, Tokens)> = map.into_iter().collect();
    // The map is sorted by name, and the sort is stable, so ties stay by name.
    list.sort_by_key(|(_, t)| std::cmp::Reverse(t.sum()));
    list
}

/// Totals for the days `since_day..=until_day`, split by day, home, folder and
/// model, plus the 20 largest sessions in that range.
pub fn summarize(index: &UsageIndex, q: &UsageQuery) -> UsageSummary {
    let mut days: BTreeMap<String, Tokens> = BTreeMap::new();
    let mut by_home: BTreeMap<String, Tokens> = BTreeMap::new();
    let mut by_folder: BTreeMap<String, Tokens> = BTreeMap::new();
    let mut by_model: BTreeMap<String, Tokens> = BTreeMap::new();
    let mut sessions: Vec<SessionUsage> = Vec::new();

    for session in index.sessions.values() {
        let mut in_range = Tokens::default();
        let mut kept = BTreeMap::new();
        for (day, t) in &session.days {
            if day.as_str() < q.since_day.as_str() || day.as_str() > q.until_day.as_str() {
                continue;
            }
            days.entry(day.clone()).or_default().add(t);
            in_range.add(t);
            kept.insert(day.clone(), *t);
        }
        if in_range.sum() == 0 {
            continue;
        }
        by_home
            .entry(session.home_id.clone())
            .or_default()
            .add(&in_range);
        by_folder
            .entry(
                session
                    .folder
                    .clone()
                    .unwrap_or_else(|| UNKNOWN.to_string()),
            )
            .or_default()
            .add(&in_range);
        by_model
            .entry(session.model.clone().unwrap_or_else(|| UNKNOWN.to_string()))
            .or_default()
            .add(&in_range);
        let mut s = session.clone();
        s.total = in_range;
        s.days = kept;
        sessions.push(s);
    }

    sessions.sort_by(|a, b| {
        b.total
            .sum()
            .cmp(&a.total.sum())
            .then_with(|| a.home_id.cmp(&b.home_id))
            .then_with(|| a.id.cmp(&b.id))
    });
    sessions.truncate(TOP_SESSIONS);

    UsageSummary {
        days: days.into_iter().collect(),
        by_home: sorted_by_total(by_home),
        by_folder: sorted_by_total(by_folder),
        by_model: sorted_by_total(by_model),
        top_sessions: sessions,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::{Agent, Home, HomeSource};

    const T_NOV2_10H: i64 = 1_793_613_600_000;
    const T_NOV3_09H: i64 = 1_793_696_400_000;
    const T_NOV3_08H: i64 = 1_793_692_800_000;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    fn copy_tree(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    fn home(id: &str, agent: Agent, path: &Path) -> Home {
        Home {
            id: id.to_string(),
            agent,
            path: path.to_path_buf(),
            source: HomeSource::Own,
        }
    }

    fn tok(input: u64, output: u64, cache_read: u64, cache_write: u64) -> Tokens {
        Tokens {
            input,
            output,
            cache_read,
            cache_write,
        }
    }

    fn claude_line(id: &str, ts: &str, input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","cwd":"/work/demo","timestamp":"{ts}","message":{{"id":"{id}","model":"model-a","usage":{{"input_tokens":{input},"output_tokens":{output}}}}}}}"#
        )
    }

    /// A temp claude home with one session file; returns (dir, home, file).
    fn claude_home_with(content: &str) -> (tempfile::TempDir, Home, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("projects").join("-work-demo");
        fs::create_dir_all(&proj).unwrap();
        let file = proj.join("s-x.jsonl");
        fs::write(&file, content).unwrap();
        let h = home("own-claude", Agent::Claude, dir.path());
        (dir, h, file)
    }

    #[test]
    fn claude_usage_summed_and_deduped_by_message_id() {
        let dir = tempfile::tempdir().unwrap();
        copy_tree(&fixture("claude"), dir.path());
        let h = home("own-claude", Agent::Claude, dir.path());
        let mut index = UsageIndex::default();
        let stats = index.refresh(std::slice::from_ref(&h));
        assert_eq!(stats.bad_lines, 0);
        let s = &index.sessions["own-claude:s-0001"];
        assert_eq!(s.id, "s-0001");
        assert_eq!(s.home_id, "own-claude");
        assert_eq!(s.agent, Agent::Claude);
        assert_eq!(s.folder.as_deref(), Some("/work/demo"));
        assert_eq!(s.model.as_deref(), Some("model-b"));
        assert_eq!(s.first, T_NOV2_10H);
        assert_eq!(s.last, T_NOV3_09H);
        assert_eq!(s.total, tok(11, 22, 33, 44));
        assert_eq!(s.days["2026-11-02"], tok(10, 20, 30, 40));
        assert_eq!(s.days["2026-11-03"], tok(1, 2, 3, 4));

        // Nothing changed: a second refresh reads nothing and keeps the numbers.
        let again = index.refresh(std::slice::from_ref(&h));
        assert_eq!(again.files_read, 0);
        assert_eq!(
            index.sessions["own-claude:s-0001"].total,
            tok(11, 22, 33, 44)
        );

        // An appended repeat of msg_02 is skipped; a new id is counted.
        let file = dir.path().join("projects/-work-demo/s-0001.jsonl");
        let mut text = fs::read_to_string(&file).unwrap();
        text.push_str(&claude_line("msg_02", "2026-11-03T09:00:01.000Z", 1, 2));
        text.push('\n');
        text.push_str(&claude_line("msg_03", "2026-11-03T09:00:02.000Z", 5, 6));
        text.push('\n');
        fs::write(&file, text).unwrap();
        index.refresh(std::slice::from_ref(&h));
        let s = &index.sessions["own-claude:s-0001"];
        assert_eq!(s.total, tok(16, 28, 33, 44));
        assert_eq!(s.days["2026-11-03"], tok(6, 8, 3, 4));
    }

    #[test]
    fn codex_last_usage_added_by_day() {
        let dir = tempfile::tempdir().unwrap();
        copy_tree(&fixture("codex"), dir.path());
        let h = home("own-codex", Agent::Codex, dir.path());
        let mut index = UsageIndex::default();
        let stats = index.refresh(std::slice::from_ref(&h));
        assert_eq!(stats.bad_lines, 0);
        let s = &index.sessions["own-codex:rollout-2026-11-02T10-00-00-c0de01"];
        assert_eq!(s.agent, Agent::Codex);
        assert_eq!(s.folder.as_deref(), Some("/work/cli-demo"));
        // input is `input_tokens` minus `cached_input_tokens`.
        assert_eq!(s.days["2026-11-02"], tok(60, 20, 40, 0));
        assert_eq!(s.days["2026-11-03"], tok(90, 30, 60, 5));
        // The total comes from the last `total_token_usage`.
        assert_eq!(s.total, tok(150, 50, 100, 5));
        assert_eq!(s.first, T_NOV2_10H);
        assert_eq!(s.last, T_NOV3_08H);
    }

    #[test]
    fn partial_last_line_is_read_next_time() {
        let first = claude_line("m1", "2026-11-02T10:00:00.000Z", 1, 1);
        let second = claude_line("m2", "2026-11-02T10:00:01.000Z", 2, 2);
        let (_dir, h, file) = claude_home_with(&format!("{first}\n{}", &second[..40]));
        let mut index = UsageIndex::default();
        let stats = index.refresh(std::slice::from_ref(&h));
        assert_eq!(stats.bad_lines, 0);
        assert_eq!(index.sessions["own-claude:s-x"].total, tok(1, 1, 0, 0));
        let mark = index.files.values().next().unwrap();
        assert_eq!(mark.offset, (first.len() + 1) as u64);

        fs::write(&file, format!("{first}\n{second}\n")).unwrap();
        let stats = index.refresh(std::slice::from_ref(&h));
        assert_eq!(stats.bad_lines, 0);
        assert_eq!(index.sessions["own-claude:s-x"].total, tok(3, 3, 0, 0));
        let mark = index.files.values().next().unwrap();
        assert_eq!(mark.offset, (first.len() + second.len() + 2) as u64);
    }

    #[test]
    fn shrunk_file_is_reread_from_zero() {
        let a = claude_line("m1", "2026-11-02T10:00:00.000Z", 100, 100);
        let b = claude_line("m2", "2026-11-02T10:00:01.000Z", 100, 100);
        let (_dir, h, file) = claude_home_with(&format!("{a}\n{b}\n"));
        let mut index = UsageIndex::default();
        index.refresh(std::slice::from_ref(&h));
        assert_eq!(index.sessions["own-claude:s-x"].total, tok(200, 200, 0, 0));

        let c = claude_line("m3", "2026-11-02T10:00:02.000Z", 7, 8);
        assert!(c.len() + 1 < a.len() + b.len() + 2);
        fs::write(&file, format!("{c}\n")).unwrap();
        index.refresh(std::slice::from_ref(&h));
        let s = &index.sessions["own-claude:s-x"];
        assert_eq!(s.total, tok(7, 8, 0, 0));
        assert_eq!(s.days["2026-11-02"], tok(7, 8, 0, 0));
    }

    #[test]
    fn bad_line_is_skipped_and_counted() {
        let a = claude_line("m1", "2026-11-02T10:00:00.000Z", 1, 1);
        let b = claude_line("m2", "2026-11-02T10:00:01.000Z", 2, 2);
        let (_dir, h, _file) = claude_home_with(&format!("{a}\nthis is not json {{\n{b}\n"));
        let mut index = UsageIndex::default();
        let stats = index.refresh(std::slice::from_ref(&h));
        assert_eq!(stats.bad_lines, 1);
        assert_eq!(index.sessions["own-claude:s-x"].total, tok(3, 3, 0, 0));
    }

    #[test]
    fn index_holds_no_prompt_text() {
        let claude = tempfile::tempdir().unwrap();
        copy_tree(&fixture("claude"), claude.path());
        let codex = tempfile::tempdir().unwrap();
        copy_tree(&fixture("codex"), codex.path());
        let homes = [
            home("own-claude", Agent::Claude, claude.path()),
            home("own-codex", Agent::Codex, codex.path()),
        ];
        let mut index = UsageIndex::default();
        index.refresh(&homes);
        let data = tempfile::tempdir().unwrap();
        index.save(data.path()).unwrap();
        let on_disk = fs::read_to_string(data.path().join("kit").join("usage.json")).unwrap();
        let in_memory = serde_json::to_string(&index).unwrap();
        for text in [on_disk, in_memory] {
            assert!(text.contains("own-claude:s-0001"));
            for secret in [
                "SECRET-PROMPT-ALPHA",
                "SECRET-REPLY-BETA",
                "SECRET-SUMMARY",
                "SECRET-CODEX-PROMPT",
                "msg_01",
            ] {
                assert!(!text.contains(secret), "index leaks {secret}");
            }
        }
        let loaded = UsageIndex::load(data.path());
        assert_eq!(loaded, index);
    }

    fn session(
        id: &str,
        home_id: &str,
        folder: Option<&str>,
        model: Option<&str>,
        days: &[(&str, u64)],
    ) -> SessionUsage {
        let mut map = BTreeMap::new();
        let mut total = Tokens::default();
        for (day, n) in days {
            let t = tok(*n, 0, 0, 0);
            total.add(&t);
            map.insert((*day).to_string(), t);
        }
        SessionUsage {
            id: id.to_string(),
            home_id: home_id.to_string(),
            agent: Agent::Claude,
            folder: folder.map(str::to_string),
            model: model.map(str::to_string),
            first: 0,
            last: 0,
            total,
            days: map,
        }
    }

    #[test]
    fn summarize_sorts_and_limits() {
        let mut index = UsageIndex::default();
        for n in 0..25u64 {
            let id = format!("s{n:02}");
            let s = session(
                &id,
                if n % 2 == 0 { "h-even" } else { "h-odd" },
                Some(if n < 10 { "/a" } else { "/b" }),
                Some("m"),
                &[("2026-11-02", n + 1), ("2026-11-09", 1000)],
            );
            index.sessions.insert(format!("h:{id}"), s);
        }
        index.sessions.insert(
            "h:nofolder".into(),
            session("nofolder", "h-odd", None, None, &[("2026-11-03", 5)]),
        );

        let q = UsageQuery {
            since_day: "2026-11-01".into(),
            until_day: "2026-11-05".into(),
        };
        let sum = summarize(&index, &q);

        // The 2026-11-09 day is outside the range.
        assert_eq!(
            sum.days,
            vec![
                ("2026-11-02".to_string(), tok(325, 0, 0, 0)),
                ("2026-11-03".to_string(), tok(5, 0, 0, 0)),
            ]
        );
        // 1..=25 split by parity: even n gives odd numbers 1,3,..,25 (sum 169); odd n gives 2,4,..,24 (sum 156) plus 5.
        assert_eq!(
            sum.by_home,
            vec![
                ("h-even".to_string(), tok(169, 0, 0, 0)),
                ("h-odd".to_string(), tok(161, 0, 0, 0)),
            ]
        );
        // /a: n = 0..10 gives 1..=10 = 55; /b: 11..=25 = 270.
        assert_eq!(sum.by_folder[0], ("/b".to_string(), tok(270, 0, 0, 0)));
        assert_eq!(sum.by_folder[1], ("/a".to_string(), tok(55, 0, 0, 0)));
        assert_eq!(sum.by_folder[2].0, "(unknown)");
        assert_eq!(sum.by_model[0], ("m".to_string(), tok(325, 0, 0, 0)));
        assert_eq!(sum.by_model[1].0, "(unknown)");

        assert_eq!(sum.top_sessions.len(), 20);
        assert_eq!(sum.top_sessions[0].id, "s24");
        assert_eq!(sum.top_sessions[0].total, tok(25, 0, 0, 0));
        assert_eq!(sum.top_sessions[0].days.len(), 1);
        let totals: Vec<u64> = sum.top_sessions.iter().map(|s| s.total.input).collect();
        assert!(totals.windows(2).all(|w| w[0] >= w[1]));
        assert!(sum.top_sessions.iter().all(|s| s.id != "s00"));
    }

    #[test]
    fn timestamps_and_day_keys() {
        assert_eq!(parse_ts("2026-11-02T10:00:00.000Z"), Some(T_NOV2_10H));
        assert_eq!(parse_ts("2026-11-02T10:00:00Z"), Some(T_NOV2_10H));
        assert_eq!(parse_ts("2026-11-02T10:00:00.5Z"), Some(T_NOV2_10H + 500));
        assert_eq!(parse_ts("2026-11-02T17:00:00+07:00"), Some(T_NOV2_10H));
        assert_eq!(parse_ts("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_ts("yesterday"), None);
        assert_eq!(parse_ts("2026-13-02T10:00:00Z"), None);
        assert_eq!(day_key(T_NOV2_10H), "2026-11-02");
        assert_eq!(day_key(0), "1970-01-01");
        assert_eq!(day_key(-1), "1969-12-31");
        assert_eq!(day_key(951_782_400_000), "2000-02-29");
    }

    #[test]
    fn index_version_mismatch_rebuilds() {
        let data = tempfile::tempdir().unwrap();
        let kit = data.path().join("kit");
        fs::create_dir_all(&kit).unwrap();
        let stale = r#"{"version":99,"files":{},"sessions":{"x:y":{"id":"y","home_id":"x","agent":"claude","folder":null,"model":null,"first":0,"last":0,"total":{"input":9,"output":9,"cache_read":9,"cache_write":9},"days":{}}}}"#;
        fs::write(kit.join("usage.json"), stale).unwrap();
        let mut index = UsageIndex::load(data.path());
        assert_eq!(index.version, 1);
        assert!(index.sessions.is_empty());

        let claude = tempfile::tempdir().unwrap();
        copy_tree(&fixture("claude"), claude.path());
        let h = home("own-claude", Agent::Claude, claude.path());
        index.refresh(std::slice::from_ref(&h));
        assert_eq!(index.sessions.len(), 1);
        index.save(data.path()).unwrap();
        assert_eq!(UsageIndex::load(data.path()), index);

        // Garbage on disk also gives a fresh index.
        fs::write(kit.join("usage.json"), "not json").unwrap();
        assert_eq!(UsageIndex::load(data.path()), UsageIndex::default());
    }
}
