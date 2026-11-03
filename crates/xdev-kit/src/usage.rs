//! Token usage read from the CLI session logs. The index holds counts, ids,
//! times, model names and folder keys, never prompt or reply text.
//!
//! Day keys are local `YYYY-MM-DD`. std has no local time zone and no time
//! crate is allowed here, so the caller passes the offset from UTC in minutes
//! (UTC+7 is 420). A fixed offset does not follow daylight saving; the index
//! is rebuilt when the offset it was built with changes.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::logs::{
    FileMark, for_each_line, is_blank, line_time, log_files, mtime_ns, parse_line, start_at,
};
use crate::{Agent, Home, KitError};

const VERSION: u32 = 2;
/// How many counted Claude message ids a file mark keeps.
const RECENT_IDS: usize = 256;
const TOP_SESSIONS: usize = 20;
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
    /// Local `YYYY-MM-DD`, by the offset the index was built with.
    pub days: BTreeMap<String, Tokens>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageIndex {
    pub version: u32,
    /// Minutes of local time minus UTC that the day keys were made with.
    #[serde(default)]
    pub utc_offset_minutes: i32,
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
            utc_offset_minutes: 0,
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
    /// Log bytes read.
    pub bytes: u64,
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
    /// touched since the last call is not opened. `utc_offset_minutes` is
    /// local time minus UTC; when it differs from the one the index was built
    /// with, the index starts again from zero.
    pub fn refresh(&mut self, homes: &[Home], utc_offset_minutes: i32) -> RefreshStats {
        let mut stats = RefreshStats::default();
        if self.version != VERSION {
            *self = Self::default();
        }
        if self.utc_offset_minutes != utc_offset_minutes {
            self.files.clear();
            self.sessions.clear();
            self.utc_offset_minutes = utc_offset_minutes;
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
        let mut recent_ids: Vec<String> = Vec::new();
        if let Some(mark) = self.files.get(&file_key) {
            let Some(from) = start_at(mark, len, mtime_ns) else {
                return;
            };
            if from > 0 && mark.session == session_key {
                start = from;
                recent_ids = mark.recent_ids.clone();
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
            recent_ids.clear();
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
        let offset_min = self.utc_offset_minutes;
        let read = match home.agent {
            Agent::Claude => read_claude(
                path,
                start,
                offset_min,
                &mut recent_ids,
                &mut session,
                &mut bad,
                &mut touched,
            ),
            Agent::Codex => read_codex(
                path,
                start,
                offset_min,
                &mut session,
                &mut bad,
                &mut touched,
            ),
        };
        let Ok(offset) = read else {
            return;
        };

        stats.files_read += 1;
        stats.bad_lines += bad;
        stats.bytes += offset.saturating_sub(start);
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
                recent_ids,
            },
        );
    }
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

fn add_day(session: &mut SessionUsage, ms: i64, utc_offset_minutes: i32, t: &Tokens) {
    session.total.add(t);
    session
        .days
        .entry(day_key(ms, utc_offset_minutes))
        .or_default()
        .add(t);
}

/// Claude Code: `<home>/projects/*/*.jsonl`. The read starts at `start`;
/// `recent_ids` holds the message ids counted before it, and is updated.
fn read_claude(
    path: &Path,
    start: u64,
    utc_offset_minutes: i32,
    recent_ids: &mut Vec<String>,
    session: &mut SessionUsage,
    bad: &mut usize,
    touched: &mut bool,
) -> io::Result<u64> {
    let mut seen: HashSet<String> = recent_ids.iter().cloned().collect();
    for_each_line(path, start, |_, line| {
        let Some(v) = parse_line(line) else {
            if !is_blank(line) {
                *bad += 1;
            }
            return;
        };
        *touched = true;
        let message = v.get("message");
        let usage = message
            .and_then(|m| m.get("usage"))
            .filter(|u| u.is_object());
        let is_usage_line = v.get("type").and_then(Value::as_str) == Some("assistant");
        let id = message.and_then(|m| m.get("id")).and_then(Value::as_str);
        let duplicate = match (is_usage_line, usage, id) {
            (true, Some(_), Some(id)) => seen.contains(id),
            _ => false,
        };
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
        if let Some(id) = id {
            seen.insert(id.to_string());
            recent_ids.push(id.to_string());
            if recent_ids.len() > RECENT_IDS {
                recent_ids.remove(0);
            }
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
        add_day(session, ms, utc_offset_minutes, &t);
    })
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
    utc_offset_minutes: i32,
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
                let total = info
                    .get("total_token_usage")
                    .filter(|u| u.is_object())
                    .map(codex_tokens);
                // The same total as the event before it: the event was logged
                // again, and its `last_token_usage` is already counted.
                let repeated = total.is_some_and(|t| t == session.total);
                let last = info.get("last_token_usage").filter(|u| u.is_object());
                if let (Some(last), false) = (last, repeated) {
                    match ts {
                        Some(ms) => {
                            // `add_day` also adds to the total; the total is
                            // set from `total_token_usage` below.
                            let before = session.total;
                            add_day(session, ms, utc_offset_minutes, &codex_tokens(last));
                            session.total = before;
                        }
                        None => *bad += 1,
                    }
                }
                if let Some(total) = total {
                    session.total = total;
                }
            }
            _ => {}
        }
    })
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

/// `YYYY-MM-DD` of a unix ms time, `utc_offset_minutes` ahead of UTC.
fn day_key(ms: i64, utc_offset_minutes: i32) -> String {
    let local = ms.saturating_add(i64::from(utc_offset_minutes) * 60_000);
    let (y, m, d) = civil_from_days(local.div_euclid(86_400_000));
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
    use crate::logs::parse_ts;
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
        let stats = index.refresh(std::slice::from_ref(&h), 0);
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
        let again = index.refresh(std::slice::from_ref(&h), 0);
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
        index.refresh(std::slice::from_ref(&h), 0);
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
        let stats = index.refresh(std::slice::from_ref(&h), 0);
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
    fn recent_ids_keep_the_last_256() {
        let mut text = String::new();
        for n in 0..300 {
            text.push_str(&claude_line(
                &format!("m{n:03}"),
                "2026-11-02T10:00:00.000Z",
                1,
                1,
            ));
            text.push('\n');
        }
        let (_dir, h, _file) = claude_home_with(&text);
        let mut index = UsageIndex::default();
        index.refresh(std::slice::from_ref(&h), 0);
        let ids = &index.files.values().next().unwrap().recent_ids;
        assert_eq!(ids.len(), 256);
        assert_eq!(ids.first().unwrap(), "m044");
        assert_eq!(ids.last().unwrap(), "m299");
        assert_eq!(index.sessions["own-claude:s-x"].total, tok(300, 300, 0, 0));
    }

    #[test]
    fn codex_repeated_total_is_not_counted_twice() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let file = sessions.join("rollout-r1.jsonl");
        let event = |ts: &str, input: u64, last: u64| {
            format!(
                r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input},"output_tokens":0}},"last_token_usage":{{"input_tokens":{last},"output_tokens":0}}}}}}}}"#
            )
        };
        let first = event("2026-11-02T10:00:00.000Z", 100, 100);
        let again = event("2026-11-02T10:00:01.000Z", 100, 100);
        let next = event("2026-11-02T10:00:02.000Z", 130, 30);
        fs::write(&file, format!("{first}\n{again}\n{next}\n")).unwrap();
        let h = home("own-codex", Agent::Codex, dir.path());
        let mut index = UsageIndex::default();
        index.refresh(std::slice::from_ref(&h), 0);
        let s = &index.sessions["own-codex:rollout-r1"];
        assert_eq!(s.days["2026-11-02"], tok(130, 0, 0, 0));
        assert_eq!(s.total, tok(130, 0, 0, 0));

        // The same holds across two refreshes.
        let mut text = fs::read_to_string(&file).unwrap();
        text.push_str(&event("2026-11-02T10:00:03.000Z", 130, 30));
        text.push('\n');
        fs::write(&file, text).unwrap();
        index.refresh(std::slice::from_ref(&h), 0);
        let s = &index.sessions["own-codex:rollout-r1"];
        assert_eq!(s.days["2026-11-02"], tok(130, 0, 0, 0));
    }

    #[test]
    fn partial_last_line_is_read_next_time() {
        let first = claude_line("m1", "2026-11-02T10:00:00.000Z", 1, 1);
        let second = claude_line("m2", "2026-11-02T10:00:01.000Z", 2, 2);
        let (_dir, h, file) = claude_home_with(&format!("{first}\n{}", &second[..40]));
        let mut index = UsageIndex::default();
        let stats = index.refresh(std::slice::from_ref(&h), 0);
        assert_eq!(stats.bad_lines, 0);
        assert_eq!(index.sessions["own-claude:s-x"].total, tok(1, 1, 0, 0));
        let mark = index.files.values().next().unwrap();
        assert_eq!(mark.offset, (first.len() + 1) as u64);

        fs::write(&file, format!("{first}\n{second}\n")).unwrap();
        let stats = index.refresh(std::slice::from_ref(&h), 0);
        assert_eq!(stats.bad_lines, 0);
        assert_eq!(index.sessions["own-claude:s-x"].total, tok(3, 3, 0, 0));
        let mark = index.files.values().next().unwrap();
        assert_eq!(mark.offset, (first.len() + second.len() + 2) as u64);
    }

    #[test]
    fn bytes_before_offset_are_not_read() {
        let a = claude_line("m1", "2026-11-02T10:00:00.000Z", 1, 1);
        let b = claude_line("m2", "2026-11-02T10:00:01.000Z", 2, 2);
        let (_dir, h, file) = claude_home_with(&format!("{a}\n{b}\n"));
        let mut index = UsageIndex::default();
        index.refresh(std::slice::from_ref(&h), 0);
        assert_eq!(index.sessions["own-claude:s-x"].total, tok(3, 3, 0, 0));
        let offset = index.files.values().next().unwrap().offset as usize;

        // Everything before the offset becomes garbage of the same length (line
        // ends stay). A repeat of m2 and a new line m3 are appended.
        let mut bytes = fs::read(&file).unwrap();
        assert_eq!(bytes.len(), offset);
        for byte in bytes.iter_mut().filter(|b| **b != b'\n') {
            *byte = b'x';
        }
        bytes.extend_from_slice(claude_line("m2", "2026-11-02T10:00:02.000Z", 2, 2).as_bytes());
        bytes.push(b'\n');
        bytes.extend_from_slice(claude_line("m3", "2026-11-02T10:00:03.000Z", 5, 6).as_bytes());
        bytes.push(b'\n');
        fs::write(&file, bytes).unwrap();

        let stats = index.refresh(std::slice::from_ref(&h), 0);
        assert_eq!(stats.bad_lines, 0);
        // Only m3 is added; m2 is known from the stored ids, not from the file.
        assert_eq!(index.sessions["own-claude:s-x"].total, tok(8, 9, 0, 0));
    }

    #[test]
    fn shrunk_file_is_reread_from_zero() {
        let a = claude_line("m1", "2026-11-02T10:00:00.000Z", 100, 100);
        let b = claude_line("m2", "2026-11-02T10:00:01.000Z", 100, 100);
        let (_dir, h, file) = claude_home_with(&format!("{a}\n{b}\n"));
        let mut index = UsageIndex::default();
        index.refresh(std::slice::from_ref(&h), 0);
        assert_eq!(index.sessions["own-claude:s-x"].total, tok(200, 200, 0, 0));

        let c = claude_line("m3", "2026-11-02T10:00:02.000Z", 7, 8);
        assert!(c.len() + 1 < a.len() + b.len() + 2);
        fs::write(&file, format!("{c}\n")).unwrap();
        index.refresh(std::slice::from_ref(&h), 0);
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
        let stats = index.refresh(std::slice::from_ref(&h), 0);
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
        index.refresh(&homes, 0);
        let data = tempfile::tempdir().unwrap();
        index.save(data.path()).unwrap();
        let on_disk = fs::read_to_string(data.path().join("kit").join("usage.json")).unwrap();
        let in_memory = serde_json::to_string(&index).unwrap();
        for text in [on_disk, in_memory] {
            assert!(text.contains("own-claude:s-0001"));
            // Message ids are kept (`recent_ids`); they are ids, not text.
            assert!(text.contains("msg_01"));
            for secret in [
                "SECRET-PROMPT-ALPHA",
                "SECRET-REPLY-BETA",
                "SECRET-SUMMARY",
                "SECRET-CODEX-PROMPT",
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
        assert_eq!(day_key(T_NOV2_10H, 0), "2026-11-02");
        assert_eq!(day_key(0, 0), "1970-01-01");
        assert_eq!(day_key(-1, 0), "1969-12-31");
        assert_eq!(day_key(951_782_400_000, 0), "2000-02-29");
    }

    #[test]
    fn day_key_uses_local_offset() {
        let late = parse_ts("2026-11-02T20:30:00Z").unwrap();
        assert_eq!(day_key(late, 0), "2026-11-02");
        // UTC+7: already the next morning.
        assert_eq!(day_key(late, 420), "2026-11-03");
        // UTC-5: still the afternoon of the same day.
        assert_eq!(day_key(late, -300), "2026-11-02");
        assert_eq!(day_key(0, -1), "1969-12-31");
    }

    #[test]
    fn offset_change_rebuilds_index() {
        let line = claude_line("m1", "2026-11-02T20:30:00.000Z", 4, 5);
        let (_dir, h, _file) = claude_home_with(&format!(
            "{line}
"
        ));
        let mut index = UsageIndex::default();
        index.refresh(std::slice::from_ref(&h), 0);
        assert_eq!(index.utc_offset_minutes, 0);
        assert_eq!(
            index.sessions["own-claude:s-x"].days["2026-11-02"],
            tok(4, 5, 0, 0)
        );

        // The same offset reads nothing.
        assert_eq!(index.refresh(std::slice::from_ref(&h), 0).files_read, 0);

        // Another offset starts again from zero, with no double count.
        let stats = index.refresh(std::slice::from_ref(&h), 420);
        assert_eq!(stats.files_read, 1);
        assert_eq!(index.utc_offset_minutes, 420);
        let s = &index.sessions["own-claude:s-x"];
        assert_eq!(s.total, tok(4, 5, 0, 0));
        assert_eq!(s.days.len(), 1);
        assert_eq!(s.days["2026-11-03"], tok(4, 5, 0, 0));
    }

    #[test]
    fn index_version_mismatch_rebuilds() {
        let data = tempfile::tempdir().unwrap();
        let kit = data.path().join("kit");
        fs::create_dir_all(&kit).unwrap();
        let stale = r#"{"version":99,"files":{},"sessions":{"x:y":{"id":"y","home_id":"x","agent":"claude","folder":null,"model":null,"first":0,"last":0,"total":{"input":9,"output":9,"cache_read":9,"cache_write":9},"days":{}}}}"#;
        fs::write(kit.join("usage.json"), stale).unwrap();
        let mut index = UsageIndex::load(data.path());
        assert_eq!(index.version, 2);
        assert!(index.sessions.is_empty());

        let claude = tempfile::tempdir().unwrap();
        copy_tree(&fixture("claude"), claude.path());
        let h = home("own-claude", Agent::Claude, claude.path());
        index.refresh(std::slice::from_ref(&h), 0);
        assert_eq!(index.sessions.len(), 1);
        index.save(data.path()).unwrap();
        assert_eq!(UsageIndex::load(data.path()), index);

        // Garbage on disk also gives a fresh index.
        fs::write(kit.join("usage.json"), "not json").unwrap();
        assert_eq!(UsageIndex::load(data.path()), UsageIndex::default());
    }
}
