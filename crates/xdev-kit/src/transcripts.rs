//! The text of agent conversations, read from the same CLI logs as the
//! session index: what the person typed and what the agent answered. Tool
//! calls and results, side chains, meta lines and wrapper text are left out.
//! Nothing is stored here; the caller keeps the text and the read marks.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fs;
use std::path::Path;

use crate::logs::{
    FileMark, LINE_BUF_MAX, LineRead, for_each_record, log_files, mtime_ns, parse_ts, start_at,
};
use crate::records::{ClaudeLine, CodexLine, Content, Obj, Str};
use crate::sessions::{claude_prompt, codex_text, is_older, is_wrapper, uuid_tail};
use crate::{Agent, Home, RefreshStats};

/// The most characters one message keeps.
pub const TEXT_CHARS_MAX: usize = 8_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptText {
    /// The log file, canonical.
    pub file: String,
    /// `<home id>:<session id>`, as `AgentSession::key`.
    pub session_key: String,
    pub role: TextRole,
    pub text: String,
    /// Unix ms of the line; 0 when it has no time.
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscriptEvent {
    /// The file was rewritten or cut: drop its texts, new ones follow.
    Reset {
        file: String,
    },
    /// The file is gone.
    Gone {
        file: String,
    },
    Text(TranscriptText),
    /// Every event of the file has been sent; `mark` is where the read stopped.
    /// A caller that stores texts in batches may cut after this event.
    Done {
        file: String,
        mark: FileMark,
    },
}

/// Texts of a Codex log held back until its session id is known: the
/// `session_meta` line comes first, so this is reached only by a log without
/// one.
const HOLD_MAX: usize = 64;

/// Reads what is new in the logs of `homes` past `marks` and updates `marks`.
/// A log read from its start begins with `Reset`, so a caller may store the
/// texts of a long log before its `Done` and still not keep a text twice.
/// A log not yet marked and last written before `since_ms` is not opened.
/// Events of one file come in log order.
pub fn scan_transcripts(
    homes: &[Home],
    marks: &mut BTreeMap<String, FileMark>,
    since_ms: Option<i64>,
    sink: &mut dyn FnMut(TranscriptEvent),
) -> RefreshStats {
    let mut stats = RefreshStats::default();
    let mut present = HashSet::new();
    for home in homes {
        for file in log_files(home) {
            let file = fs::canonicalize(&file).unwrap_or(file);
            let file_key = file.to_string_lossy().into_owned();
            if !present.insert(file_key.clone()) {
                continue;
            }
            scan_file(home, &file, &file_key, marks, since_ms, sink, &mut stats);
        }
    }
    let gone: Vec<String> = marks
        .keys()
        .filter(|k| !present.contains(*k))
        .cloned()
        .collect();
    for file in gone {
        marks.remove(&file);
        sink(TranscriptEvent::Gone { file });
    }
    stats
}

/// The most bytes `tail_turns` reads from the end of a log.
const TAIL_BYTES: u64 = 4 << 20;

/// One turn of a conversation, for showing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailTurn {
    pub role: TextRole,
    pub text: String,
    /// Unix ms; 0 when the line has no time.
    pub at: i64,
}

/// The last `turns` user and assistant texts of one log, oldest first, each
/// cut to `chars` characters. It reads the same lines as `scan_transcripts`
/// but only the last `TAIL_BYTES` of a long log.
pub fn tail_turns(home: &Home, path: &Path, turns: usize, chars: usize) -> Vec<TailTurn> {
    let mut ring: VecDeque<TailTurn> = VecDeque::with_capacity(turns + 1);
    if turns == 0 {
        return Vec::new();
    }
    let mut marks = BTreeMap::new();
    let file = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let file_key = file.to_string_lossy().into_owned();
    if let Some(from) = tail_start(&file) {
        // A mark that differs from the file makes the read go on from `from`.
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        marks.insert(
            file_key.clone(),
            FileMark {
                len: 0,
                mtime_ns: -1,
                offset: from,
                session: format!("{}:{stem}", home.id),
                recent_ids: Vec::new(),
            },
        );
    }
    let mut stats = RefreshStats::default();
    scan_file(
        home,
        &file,
        &file_key,
        &mut marks,
        None,
        &mut |event| {
            if let TranscriptEvent::Text(t) = event {
                if ring.len() == turns {
                    ring.pop_front();
                }
                ring.push_back(TailTurn {
                    role: t.role,
                    text: t.text.chars().take(chars).collect(),
                    at: t.at,
                });
            }
        },
        &mut stats,
    );
    ring.into()
}

/// Where a read of a long log starts: just after the first newline in its
/// last `TAIL_BYTES`. `None` when the whole log is read.
fn tail_start(path: &Path) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};
    let len = fs::metadata(path).ok()?.len();
    let from = len.checked_sub(TAIL_BYTES)?;
    let mut file = fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = [0u8; 8192];
    let mut at = from;
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            return Some(len);
        }
        if let Some(i) = buf[..n].iter().position(|b| *b == b'\n') {
            return Some(at + i as u64 + 1);
        }
        at += n as u64;
    }
}

/// The events of one log as it is read.
struct Out<'a> {
    file: &'a str,
    home_id: &'a str,
    id: String,
    /// The session id can no longer change.
    settled: bool,
    held: Vec<(TextRole, String, i64)>,
    reset_due: bool,
    sink: &'a mut dyn FnMut(TranscriptEvent),
}

impl Out<'_> {
    fn key(&self) -> String {
        format!("{}:{}", self.home_id, self.id)
    }

    fn reset_if_due(&mut self) {
        if self.reset_due {
            self.reset_due = false;
            (self.sink)(TranscriptEvent::Reset {
                file: self.file.to_string(),
            });
        }
    }

    fn text(&mut self, role: TextRole, text: String, at: i64) {
        if !self.settled {
            self.held.push((role, text, at));
            if self.held.len() >= HOLD_MAX {
                self.settle();
            }
            return;
        }
        self.reset_if_due();
        let session_key = self.key();
        (self.sink)(TranscriptEvent::Text(TranscriptText {
            file: self.file.to_string(),
            session_key,
            role,
            text,
            at,
        }));
    }

    fn session_id(&mut self, id: &str) {
        if !self.settled {
            self.id = id.to_string();
        }
        self.settle();
    }

    fn settle(&mut self) {
        self.settled = true;
        for (role, text, at) in std::mem::take(&mut self.held) {
            self.text(role, text, at);
        }
    }
}

fn scan_file(
    home: &Home,
    path: &Path,
    file_key: &str,
    marks: &mut BTreeMap<String, FileMark>,
    since_ms: Option<i64>,
    sink: &mut dyn FnMut(TranscriptEvent),
    stats: &mut RefreshStats,
) {
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    let (len, mtime) = (meta.len(), mtime_ns(&meta));
    let mut start = 0;
    let mut known_key = None;
    if let Some(mark) = marks.get(file_key) {
        let Some(from) = start_at(mark, len, mtime) else {
            return;
        };
        start = from;
        known_key = Some(mark.session.clone());
    } else if is_older(mtime, since_ms) {
        return;
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut id = match home.agent {
        Agent::Claude => stem.clone(),
        Agent::Codex => uuid_tail(&stem).map_or_else(|| stem.clone(), str::to_string),
    };
    if start > 0
        && let Some(key) = known_key.as_deref()
        && let Some(rest) = key.strip_prefix(&format!("{}:", home.id))
    {
        id = rest.to_string();
    }
    let mut out = Out {
        file: file_key,
        home_id: &home.id,
        id,
        settled: home.agent == Agent::Claude || start > 0,
        held: Vec::new(),
        reset_due: start == 0,
        sink,
    };
    let mut bad = 0;
    let mut last_at = 0;
    let mut at_of = |timestamp: &Str| {
        let at = timestamp.raw().and_then(parse_ts).unwrap_or(last_at);
        last_at = at;
        at
    };
    let result = match home.agent {
        Agent::Claude => {
            for_each_record::<Obj<ClaudeLine>>(path, start, LINE_BUF_MAX, |line| match line {
                Some(line) => {
                    let v = line.0.unwrap_or_default();
                    let at = at_of(&v.timestamp);
                    claude_line(v, at, &mut out);
                }
                None => bad += 1,
            })
        }
        Agent::Codex => {
            for_each_record::<Obj<CodexLine>>(path, start, LINE_BUF_MAX, |line| match line {
                Some(line) => {
                    let v = line.0.unwrap_or_default();
                    let at = at_of(&v.timestamp);
                    codex_line(v, at, &mut out);
                }
                None => bad += 1,
            })
        }
    };
    let Ok(LineRead { offset, .. }) = result else {
        return;
    };
    stats.files_read += 1;
    stats.bad_lines += bad;
    stats.bytes += offset.saturating_sub(start);

    out.settle();
    out.reset_if_due();
    let mark = FileMark {
        len,
        mtime_ns: mtime,
        offset,
        session: out.key(),
        recent_ids: Vec::new(),
    };
    marks.insert(file_key.to_string(), mark.clone());
    (out.sink)(TranscriptEvent::Done {
        file: file_key.to_string(),
        mark,
    });
}

fn cap(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(TEXT_CHARS_MAX).collect())
}

/// The `text` items of a content array, wrappers left out, joined by lines.
fn joined_text(content: &Content) -> Option<String> {
    match content {
        Content::Text(s) => s.raw().filter(|s| !is_wrapper(s)).map(str::to_string),
        Content::Items(items) => {
            let parts: Vec<&str> = items
                .iter()
                .filter_map(|i| i.get()?.text.raw())
                .filter(|t| !is_wrapper(t))
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        Content::None => None,
    }
}

fn claude_line(v: ClaudeLine, at: i64, out: &mut Out<'_>) {
    if v.is_sidechain.0 || v.is_meta.0 {
        return;
    }
    let Some(message) = v.message.and_then(|m| m.0) else {
        return;
    };
    let content = &message.content;
    let (role, text) = match v.kind.raw() {
        Some("user") => (TextRole::User, claude_prompt(content).map(str::to_string)),
        Some("assistant") => (TextRole::Assistant, joined_text(content)),
        _ => return,
    };
    if let Some(text) = text.as_deref().and_then(cap) {
        out.text(role, text, at);
    }
}

fn codex_line(v: CodexLine, at: i64, out: &mut Out<'_>) {
    let Some(payload) = v.payload else {
        return;
    };
    let payload = payload.0.unwrap_or_default();
    match v.kind.raw() {
        Some("session_meta") => {
            if let Some(found) = payload.id.get() {
                out.session_id(found);
            }
        }
        Some("response_item") if payload.kind.is("message") => {
            let (role, text) = match payload.role.raw() {
                Some("user") => (TextRole::User, codex_text(&payload).map(str::to_string)),
                Some("assistant") => (TextRole::Assistant, joined_text(&payload.content)),
                _ => return,
            };
            if let Some(text) = text.as_deref().and_then(cap) {
                out.text(role, text, at);
            }
        }
        _ => {}
    }
}

/// How much of a conversation the model holds in mind now, read from the
/// last usage line of a log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextUsage {
    /// Tokens the last request sent: new input plus cache writes and reads.
    pub tokens: u64,
    /// The model of that request, when the line names one.
    pub model: Option<String>,
    /// The model's window when the log states it (Codex does); `None` otherwise.
    pub window: Option<u64>,
    /// Unix ms of the line; 0 when it has no time.
    pub at: i64,
}

/// The window of a Claude model that does not state it: 200k, or 1M for a
/// model id marked `[1m]`. A session that already holds more than 200k tokens
/// must be on the 1M window.
pub fn claude_window(model: Option<&str>, tokens: u64) -> u64 {
    const BASE: u64 = 200_000;
    const WIDE: u64 = 1_000_000;
    let wide = model.is_some_and(|m| m.to_ascii_lowercase().contains("[1m]"));
    if wide || tokens > BASE { WIDE } else { BASE }
}

fn uint(v: &serde_json::Value, key: &str) -> u64 {
    v.get(key).and_then(serde_json::Value::as_u64).unwrap_or(0)
}

/// The context usage one log line reports, or `None` for a line that carries
/// none (or is not JSON). Claude: an `assistant` line's `message.usage`
/// (side chains are another conversation and are skipped). Codex: an
/// `event_msg` `token_count` line's `last_token_usage`.
pub fn parse_context_line(agent: Agent, line: &str) -> Option<ContextUsage> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let at = v
        .get("timestamp")
        .and_then(serde_json::Value::as_str)
        .and_then(parse_ts)
        .unwrap_or(0);
    match agent {
        Agent::Claude => {
            if v.get("type")?.as_str()? != "assistant"
                || v.get("isSidechain").and_then(serde_json::Value::as_bool) == Some(true)
            {
                return None;
            }
            let message = v.get("message")?;
            let usage = message.get("usage")?;
            let tokens = uint(usage, "input_tokens")
                + uint(usage, "cache_creation_input_tokens")
                + uint(usage, "cache_read_input_tokens");
            let model = message
                .get("model")
                .and_then(serde_json::Value::as_str)
                .filter(|m| !m.is_empty() && !m.starts_with('<'))
                .map(str::to_string);
            // A synthetic reply (no model, no tokens) says nothing about the context.
            (tokens > 0).then_some(ContextUsage {
                tokens,
                model,
                window: None,
                at,
            })
        }
        Agent::Codex => {
            if v.get("type")?.as_str()? != "event_msg" {
                return None;
            }
            let payload = v.get("payload")?;
            if payload.get("type")?.as_str()? != "token_count" {
                return None;
            }
            let info = payload.get("info")?;
            let last = info.get("last_token_usage")?;
            let tokens = last
                .get("total_tokens")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_else(|| uint(last, "input_tokens") + uint(last, "output_tokens"));
            let window = info
                .get("model_context_window")
                .and_then(serde_json::Value::as_u64)
                .filter(|w| *w > 0);
            (tokens > 0).then_some(ContextUsage {
                tokens,
                model: None,
                window,
                at,
            })
        }
    }
}

/// The latest context usage in `text` (log lines, oldest first).
pub fn latest_context(agent: Agent, text: &str) -> Option<ContextUsage> {
    text.lines()
        .rev()
        .find_map(|line| parse_context_line(agent, line))
}

/// The most bytes `context_usage` reads from the end of a log.
const CONTEXT_BYTES: u64 = 1 << 20;

/// The context usage at the end of one log: the last usage line in its final
/// `CONTEXT_BYTES`. `None` when the log cannot be read or has none, which a
/// caller shows as nothing, not as zero.
pub fn context_usage(home: &Home, path: &Path) -> Option<ContextUsage> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let from = len.saturating_sub(CONTEXT_BYTES);
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::new();
    file.take(CONTEXT_BYTES).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    // A read that began mid-file starts inside a line: drop that piece.
    let text = if from > 0 {
        text.split_once('\n').map_or("", |(_, rest)| rest)
    } else {
        &text
    };
    latest_context(home.agent, text)
}

#[path = "transcripts_conversation.rs"]
mod conversation_read;
pub use conversation_read::{
    CONVERSATION_PAGE, CONVERSATION_PAGE_MAX, ConversationItem, ConversationKind, ConversationPage,
    MarkerKind, TOOL_OUTPUT_MAX, ToolStatus, ToolStep, conversation, conversation_of_text,
};

#[cfg(test)]
#[path = "transcripts_tests.rs"]
mod tests;

#[cfg(test)]
mod context_tests {
    use super::*;

    const CLAUDE: &str = r#"{"type":"assistant","timestamp":"2026-01-02T03:04:05.000Z","message":{"model":"claude-sonnet-5-5","content":[],"usage":{"input_tokens":10,"cache_creation_input_tokens":200,"cache_read_input_tokens":3000,"output_tokens":50}}}"#;

    #[test]
    fn claude_sums_the_input_side() {
        let u = parse_context_line(Agent::Claude, CLAUDE).unwrap();
        assert_eq!(u.tokens, 3210);
        assert_eq!(u.model.as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(u.window, None);
        assert!(u.at > 0);
    }

    #[test]
    fn claude_skips_sidechain_user_and_empty_usage() {
        let side = CLAUDE.replace(
            r#"{"type":"assistant","#,
            r#"{"type":"assistant","isSidechain":true,"#,
        );
        assert_eq!(parse_context_line(Agent::Claude, &side), None);
        let user = CLAUDE.replace("\"assistant\"", "\"user\"");
        assert_eq!(parse_context_line(Agent::Claude, &user), None);
        let zero = r#"{"type":"assistant","message":{"model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}}}"#;
        assert_eq!(parse_context_line(Agent::Claude, zero), None);
        assert_eq!(parse_context_line(Agent::Claude, "not json"), None);
        assert_eq!(parse_context_line(Agent::Claude, "{}"), None);
    }

    #[test]
    fn codex_reads_last_usage_and_window() {
        let line = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":99999},"last_token_usage":{"input_tokens":900,"output_tokens":100,"total_tokens":1000},"model_context_window":258400}}}"#;
        let u = parse_context_line(Agent::Codex, line).unwrap();
        assert_eq!(u.tokens, 1000);
        assert_eq!(u.window, Some(258_400));
        let null_info = r#"{"type":"event_msg","payload":{"type":"token_count","info":null}}"#;
        assert_eq!(parse_context_line(Agent::Codex, null_info), None);
        assert_eq!(parse_context_line(Agent::Codex, CLAUDE), None);
    }

    #[test]
    fn latest_wins_and_unknown_is_none() {
        let older = CLAUDE.replace("3000", "1");
        let text = format!("{older}\nnot json\n{CLAUDE}\n{{\"type\":\"user\"}}\n");
        assert_eq!(latest_context(Agent::Claude, &text).unwrap().tokens, 3210);
        assert_eq!(latest_context(Agent::Claude, "{\"type\":\"user\"}\n"), None);
        assert_eq!(latest_context(Agent::Claude, ""), None);
    }

    #[test]
    fn window_by_model_and_size() {
        assert_eq!(claude_window(Some("claude-sonnet-5-5"), 1000), 200_000);
        assert_eq!(
            claude_window(Some("claude-sonnet-5-5[1m]"), 1000),
            1_000_000
        );
        assert_eq!(claude_window(None, 250_000), 1_000_000);
        assert_eq!(claude_window(None, 0), 200_000);
    }
}
