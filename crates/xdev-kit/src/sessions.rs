//! Agent session history read from the CLI session logs. The index keeps
//! metadata only: ids, folder, branch, model, times, a message count and a
//! title cut from the first prompt (200 chars). Never the conversation.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::logs::{for_each_line, is_blank, line_time, log_files, mtime_ns, parse_line, start_at};
use crate::{Agent, FileMark, Home, KitError, RefreshStats};

const VERSION: u32 = 1;
const TITLE_CHARS: usize = 200;

/// One agent session on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    /// `<home id>:<session id>`, the same keying as `UsageIndex`.
    pub key: String,
    /// The CLI's session id: the log file stem for Claude, the session id in
    /// the log for Codex.
    pub id: String,
    pub home_id: String,
    pub agent: Agent,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    /// The first user prompt, on one line, at most 200 chars.
    pub title: Option<String>,
    pub model: Option<String>,
    /// Unix ms; 0 when no line had a time.
    pub first: i64,
    pub last: i64,
    /// User prompts and assistant replies seen.
    pub messages: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionIndex {
    pub version: u32,
    /// Keyed by the log file's path.
    #[serde(default)]
    pub files: BTreeMap<String, FileMark>,
    /// Keyed by `AgentSession::key`.
    #[serde(default)]
    pub sessions: BTreeMap<String, AgentSession>,
}

impl Default for SessionIndex {
    fn default() -> Self {
        Self {
            version: VERSION,
            files: BTreeMap::new(),
            sessions: BTreeMap::new(),
        }
    }
}

fn index_path(data_dir: &Path) -> PathBuf {
    data_dir.join("kit").join("sessions.json")
}

impl SessionIndex {
    /// `<data_dir>/kit/sessions.json`; missing, unreadable or of another
    /// version gives an empty index.
    pub fn load(data_dir: &Path) -> Self {
        fs::read(index_path(data_dir))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SessionIndex>(&bytes).ok())
            .filter(|index| index.version == VERSION)
            .unwrap_or_default()
    }

    /// Atomic: written aside, then renamed over.
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
    /// touched since the last call is not opened; a log that is gone takes
    /// its session with it.
    pub fn refresh(&mut self, homes: &[Home]) -> RefreshStats {
        let mut stats = RefreshStats::default();
        if self.version != VERSION {
            *self = Self::default();
        }
        let mut present = HashSet::new();
        for home in homes {
            for file in log_files(home) {
                // A linked folder (the private Codex home's `sessions`
                // bridge) reaches a file another home already read.
                let file = fs::canonicalize(&file).unwrap_or(file);
                let file_key = file.to_string_lossy().into_owned();
                if !present.insert(file_key.clone()) {
                    continue;
                }
                self.refresh_file(home, &file, &file_key, &mut stats);
            }
        }
        let gone: Vec<String> = self
            .files
            .keys()
            .filter(|k| !present.contains(*k))
            .cloned()
            .collect();
        for key in gone {
            if let Some(mark) = self.files.remove(&key) {
                self.sessions.remove(&mark.session);
            }
        }
        stats
    }

    fn refresh_file(&mut self, home: &Home, path: &Path, file_key: &str, stats: &mut RefreshStats) {
        let Ok(meta) = fs::metadata(path) else {
            return;
        };
        let len = meta.len();
        let mtime_ns = mtime_ns(&meta);
        let mut start = 0;
        let mut last_reply = None;
        let mut existing = None;
        let old_key = self.files.get(file_key).map(|m| m.session.clone());
        if let Some(mark) = self.files.get(file_key) {
            let Some(from) = start_at(mark, len, mtime_ns) else {
                return;
            };
            if from > 0
                && let Some(session) = self.sessions.get(&mark.session)
            {
                start = from;
                last_reply = mark.recent_ids.last().cloned();
                existing = Some(session.clone());
            }
        }
        let existed = existing.is_some();
        let mut session = existing.unwrap_or_else(|| new_session(home, path));
        let mut read = Read {
            bad: 0,
            touched: false,
            last_reply,
        };
        let result = match home.agent {
            Agent::Claude => read_claude(path, start, &mut session, &mut read),
            Agent::Codex => read_codex(path, start, existed, &mut session, &mut read),
        };
        let Ok(offset) = result else {
            return;
        };
        stats.files_read += 1;
        stats.bad_lines += read.bad;
        stats.bytes += offset.saturating_sub(start);

        session.key = format!("{}:{}", home.id, session.id);
        if let Some(old) = old_key.filter(|old| *old != session.key) {
            self.sessions.remove(&old);
        }
        let key = session.key.clone();
        if existed || read.touched {
            self.sessions.insert(key.clone(), session);
        } else {
            self.sessions.remove(&key);
        }
        self.files.insert(
            file_key.to_string(),
            FileMark {
                len,
                mtime_ns,
                offset,
                session: key,
                recent_ids: read.last_reply.into_iter().collect(),
            },
        );
    }

    /// Drops the sessions whose `last` is before `older_than_ms`. Their file
    /// marks stay, so an old log is not read again on each refresh; it comes
    /// back when it is written to.
    pub fn prune(&mut self, older_than_ms: i64) {
        self.sessions.retain(|_, s| s.last >= older_than_ms);
    }

    /// Every session with a message, newest `last` first.
    pub fn list(&self) -> Vec<&AgentSession> {
        let mut out: Vec<&AgentSession> =
            self.sessions.values().filter(|s| s.messages > 0).collect();
        out.sort_by(|a, b| b.last.cmp(&a.last).then_with(|| a.key.cmp(&b.key)));
        out
    }
}

/// What one read of a log carries besides the session.
struct Read {
    bad: usize,
    /// A line was parsed.
    touched: bool,
    /// The last Claude reply id counted: a reply is logged once per content
    /// block, on lines next to each other.
    last_reply: Option<String>,
}

fn new_session(home: &Home, path: &Path) -> AgentSession {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let id = match home.agent {
        Agent::Claude => stem,
        Agent::Codex => uuid_tail(&stem).map_or_else(|| stem.clone(), str::to_string),
    };
    AgentSession {
        key: String::new(),
        id,
        home_id: home.id.clone(),
        agent: home.agent,
        cwd: None,
        branch: None,
        title: None,
        model: None,
        first: 0,
        last: 0,
        messages: 0,
    }
}

/// The UUID a Codex rollout file name ends with.
fn uuid_tail(stem: &str) -> Option<&str> {
    let tail = stem.get(stem.len().checked_sub(36)?..)?;
    let ok = tail.char_indices().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => c == '-',
        _ => c.is_ascii_hexdigit(),
    });
    ok.then_some(tail)
}

fn note_time(session: &mut AgentSession, v: &Value) {
    if let Some(ms) = line_time(v) {
        if session.first == 0 || ms < session.first {
            session.first = ms;
        }
        if ms > session.last {
            session.last = ms;
        }
    }
}

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn type_of(v: &Value) -> Option<&str> {
    v.get("type").and_then(Value::as_str)
}

/// Text the CLI puts around or in place of a prompt: `<tag>…`, an interrupt
/// note.
fn is_wrapper(text: &str) -> bool {
    let t = text.trim_start();
    let mut chars = t.chars();
    (chars.next() == Some('<') && chars.next().is_some_and(|c| c.is_ascii_alphabetic()))
        || t.starts_with("[Request interrupted")
}

/// One line, whitespace runs to one space, at most 200 chars.
fn title_of(text: &str) -> Option<String> {
    let mut out = String::new();
    for word in text.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    let out: String = out.chars().take(TITLE_CHARS).collect();
    let out = out.trim_end();
    (!out.is_empty()).then(|| out.to_string())
}

/// A typed prompt's text; `Some("")` when it holds only images.
fn claude_prompt(content: &Value) -> Option<&str> {
    match content {
        Value::String(s) => (!is_wrapper(s)).then_some(s.as_str()),
        Value::Array(items) => {
            if items.iter().any(|i| type_of(i) == Some("tool_result")) {
                return None;
            }
            let text = items
                .iter()
                .filter(|i| type_of(i) == Some("text"))
                .filter_map(|i| i.get("text").and_then(Value::as_str))
                .find(|t| !is_wrapper(t));
            text.or_else(|| {
                items
                    .iter()
                    .any(|i| type_of(i) == Some("image"))
                    .then_some("")
            })
        }
        _ => None,
    }
}

fn add_prompt(session: &mut AgentSession, text: &str) {
    session.messages = session.messages.saturating_add(1);
    if session.title.is_none() {
        session.title = title_of(text);
    }
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool) == Some(true)
}

/// Claude Code: `<home>/projects/*/<session id>.jsonl`.
fn read_claude(
    path: &Path,
    start: u64,
    session: &mut AgentSession,
    read: &mut Read,
) -> io::Result<u64> {
    for_each_line(path, start, |_, line| {
        let Some(v) = parse_line(line) else {
            if !is_blank(line) {
                read.bad += 1;
            }
            return;
        };
        read.touched = true;
        note_time(session, &v);
        if session.cwd.is_none() {
            session.cwd = str_at(&v, "cwd").map(str::to_string);
        }
        if let Some(branch) = str_at(&v, "gitBranch") {
            session.branch = Some(branch.to_string());
        }
        if flag(&v, "isSidechain") || flag(&v, "isMeta") {
            return;
        }
        let Some(message) = v.get("message") else {
            return;
        };
        match type_of(&v) {
            Some("user") => {
                if let Some(text) = message.get("content").and_then(claude_prompt) {
                    add_prompt(session, text);
                }
            }
            Some("assistant") => {
                if let Some(model) = str_at(message, "model").filter(|m| !m.starts_with('<')) {
                    session.model = Some(model.to_string());
                }
                let id = str_at(message, "id");
                if id.is_none() || id != read.last_reply.as_deref() {
                    session.messages = session.messages.saturating_add(1);
                    read.last_reply = id.map(str::to_string);
                }
            }
            _ => {}
        }
    })
}

/// The text of a Codex message, wrappers left out.
fn codex_text(payload: &Value) -> Option<&str> {
    payload
        .get("content")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|i| i.get("text").and_then(Value::as_str))
        .find(|t| !is_wrapper(t))
}

/// Codex: `<home>/sessions/**/rollout-*.jsonl`. `resumed` is true when the
/// read goes on from a mark, so the session id is already known.
fn read_codex(
    path: &Path,
    start: u64,
    resumed: bool,
    session: &mut AgentSession,
    read: &mut Read,
) -> io::Result<u64> {
    for_each_line(path, start, |_, line| {
        let Some(v) = parse_line(line) else {
            if !is_blank(line) {
                read.bad += 1;
            }
            return;
        };
        read.touched = true;
        note_time(session, &v);
        let Some(payload) = v.get("payload") else {
            return;
        };
        match type_of(&v) {
            Some("session_meta") => {
                if let Some(id) = str_at(payload, "id").filter(|_| !resumed) {
                    session.id = id.to_string();
                }
                if let Some(cwd) = str_at(payload, "cwd") {
                    session.cwd = Some(cwd.to_string());
                }
                if let Some(branch) = payload.get("git").and_then(|g| str_at(g, "branch")) {
                    session.branch = Some(branch.to_string());
                }
            }
            Some("turn_context") => {
                if session.cwd.is_none() {
                    session.cwd = str_at(payload, "cwd").map(str::to_string);
                }
                if let Some(model) = str_at(payload, "model") {
                    session.model = Some(model.to_string());
                }
            }
            Some("response_item") if type_of(payload) == Some("message") => {
                match payload.get("role").and_then(Value::as_str) {
                    Some("user") => {
                        if let Some(text) = codex_text(payload) {
                            add_prompt(session, text);
                        }
                    }
                    Some("assistant") => session.messages = session.messages.saturating_add(1),
                    _ => {}
                }
            }
            Some("event_msg")
                if type_of(payload) == Some("user_message") && session.title.is_none() =>
            {
                session.title = str_at(payload, "message").and_then(title_of);
            }
            _ => {}
        }
    })
}

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;
