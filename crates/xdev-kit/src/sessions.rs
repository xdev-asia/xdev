//! Agent session history read from the CLI session logs. The index keeps
//! metadata only: ids, folder, branch, model, times, a message count and a
//! title cut from the first prompt (200 chars). Never the conversation.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::logs::{
    LINE_BUF_MAX, LineRead, for_each_record, log_files, mtime_ns, parse_ts, start_at,
};
use crate::records::{ClaudeLine, CodexLine, CodexPayload, Content, Obj, Str};
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
        self.refresh_since(homes, None, &mut |_| {})
    }

    /// `refresh`, where a log not yet in the index and last written before
    /// `since_ms` is not opened: its lines can only be older. It gets no mark,
    /// so a wider window reads it later. `after_file` is called after each log
    /// that was read, for progress.
    pub fn refresh_since(
        &mut self,
        homes: &[Home],
        since_ms: Option<i64>,
        after_file: &mut dyn FnMut(&Self),
    ) -> RefreshStats {
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
                if self.refresh_file(home, &file, &file_key, since_ms, &mut stats) {
                    after_file(self);
                }
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

    /// Whether the log was opened.
    fn refresh_file(
        &mut self,
        home: &Home,
        path: &Path,
        file_key: &str,
        since_ms: Option<i64>,
        stats: &mut RefreshStats,
    ) -> bool {
        let Ok(meta) = fs::metadata(path) else {
            return false;
        };
        let len = meta.len();
        let mtime_ns = mtime_ns(&meta);
        if !self.files.contains_key(file_key) && is_older(mtime_ns, since_ms) {
            return false;
        }
        let mut start = 0;
        let mut last_reply = None;
        let mut existing = None;
        let old_key = self.files.get(file_key).map(|m| m.session.clone());
        if let Some(mark) = self.files.get(file_key) {
            let Some(from) = start_at(mark, len, mtime_ns) else {
                return false;
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
        let Ok(LineRead { offset, .. }) = result else {
            return false;
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
        true
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

/// Whether a log last written at `mtime_ns` is before `since_ms`.
pub(crate) fn is_older(mtime_ns: i128, since_ms: Option<i64>) -> bool {
    since_ms.is_some_and(|since| mtime_ns < i128::from(since) * 1_000_000)
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
pub(crate) fn uuid_tail(stem: &str) -> Option<&str> {
    let tail = stem.get(stem.len().checked_sub(36)?..)?;
    let ok = tail.char_indices().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => c == '-',
        _ => c.is_ascii_hexdigit(),
    });
    ok.then_some(tail)
}

fn note_time(session: &mut AgentSession, timestamp: &Str) {
    if let Some(ms) = timestamp.raw().and_then(parse_ts) {
        if session.first == 0 || ms < session.first {
            session.first = ms;
        }
        if ms > session.last {
            session.last = ms;
        }
    }
}

/// Text the CLI puts around or in place of a prompt: `<tag>…`, an interrupt
/// note.
pub(crate) fn is_wrapper(text: &str) -> bool {
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
        if out.len() > TITLE_CHARS * 4 {
            break;
        }
    }
    let out: String = out.chars().take(TITLE_CHARS).collect();
    let out = out.trim_end();
    (!out.is_empty()).then(|| out.to_string())
}

/// A typed prompt's text; `Some("")` when it holds only images.
pub(crate) fn claude_prompt(content: &Content) -> Option<&str> {
    match content {
        Content::Text(s) => s.raw().filter(|s| !is_wrapper(s)),
        Content::Items(_) => {
            let items = || content.items().iter().filter_map(Obj::get);
            if items().any(|i| i.kind.is("tool_result")) {
                return None;
            }
            let text = items()
                .filter(|i| i.kind.is("text"))
                .filter_map(|i| i.text.raw())
                .find(|t| !is_wrapper(t));
            text.or_else(|| items().any(|i| i.kind.is("image")).then_some(""))
        }
        Content::None => None,
    }
}

fn add_prompt(session: &mut AgentSession, text: &str) {
    session.messages = session.messages.saturating_add(1);
    if session.title.is_none() {
        session.title = title_of(text);
    }
}

/// Claude Code: `<home>/projects/*/<session id>.jsonl`.
fn read_claude(
    path: &Path,
    start: u64,
    session: &mut AgentSession,
    read: &mut Read,
) -> io::Result<LineRead> {
    for_each_record::<Obj<ClaudeLine>>(path, start, LINE_BUF_MAX, |line| {
        let Some(line) = line else {
            read.bad += 1;
            return;
        };
        let v = line.0.unwrap_or_default();
        read.touched = true;
        note_time(session, &v.timestamp);
        if session.cwd.is_none() {
            session.cwd = v.cwd.get().map(str::to_string);
        }
        if let Some(branch) = v.git_branch.get() {
            session.branch = Some(branch.to_string());
        }
        if v.is_sidechain.0 || v.is_meta.0 {
            return;
        }
        let Some(message) = v.message else {
            return;
        };
        let message = message.0.unwrap_or_default();
        match v.kind.raw() {
            Some("user") => {
                if let Some(text) = claude_prompt(&message.content) {
                    add_prompt(session, text);
                }
            }
            Some("assistant") => {
                if let Some(model) = message.model.get().filter(|m| !m.starts_with('<')) {
                    session.model = Some(model.to_string());
                }
                let id = message.id.get();
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
pub(crate) fn codex_text(payload: &CodexPayload) -> Option<&str> {
    payload
        .content
        .items()
        .iter()
        .filter_map(|i| i.get()?.text.raw())
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
) -> io::Result<LineRead> {
    for_each_record::<Obj<CodexLine>>(path, start, LINE_BUF_MAX, |line| {
        let Some(line) = line else {
            read.bad += 1;
            return;
        };
        let v = line.0.unwrap_or_default();
        read.touched = true;
        note_time(session, &v.timestamp);
        let Some(payload) = v.payload else {
            return;
        };
        let payload = payload.0.unwrap_or_default();
        match v.kind.raw() {
            Some("session_meta") => {
                if let Some(id) = payload.id.get().filter(|_| !resumed) {
                    session.id = id.to_string();
                }
                if let Some(cwd) = payload.cwd.get() {
                    session.cwd = Some(cwd.to_string());
                }
                if let Some(branch) = payload.git.get().and_then(|g| g.branch.get()) {
                    session.branch = Some(branch.to_string());
                }
            }
            Some("turn_context") => {
                if session.cwd.is_none() {
                    session.cwd = payload.cwd.get().map(str::to_string);
                }
                if let Some(model) = payload.model.get() {
                    session.model = Some(model.to_string());
                }
            }
            Some("response_item") if payload.kind.is("message") => match payload.role.raw() {
                Some("user") => {
                    if let Some(text) = codex_text(&payload) {
                        add_prompt(session, text);
                    }
                }
                Some("assistant") => session.messages = session.messages.saturating_add(1),
                _ => {}
            },
            Some("event_msg") if payload.kind.is("user_message") && session.title.is_none() => {
                session.title = payload.message.get().and_then(title_of);
            }
            _ => {}
        }
    })
}

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;
