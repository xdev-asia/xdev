//! The text of agent conversations, read from the same CLI logs as the
//! session index: what the person typed and what the agent answered. Tool
//! calls and results, side chains, meta lines and wrapper text are left out.
//! Nothing is stored here; the caller keeps the text and the read marks.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::logs::{
    FileMark, for_each_line, is_blank, line_time, log_files, mtime_ns, parse_line, start_at,
};
use crate::sessions::{claude_prompt, codex_text, flag, is_wrapper, str_at, type_of, uuid_tail};
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

type Found = Vec<(TextRole, String, i64)>;

/// Reads what is new in the logs of `homes` past `marks` and updates `marks`.
/// Events of one file come in log order, after its `Reset`.
pub fn scan_transcripts(
    homes: &[Home],
    marks: &mut BTreeMap<String, FileMark>,
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
            scan_file(home, &file, &file_key, marks, sink, &mut stats);
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

fn scan_file(
    home: &Home,
    path: &Path,
    file_key: &str,
    marks: &mut BTreeMap<String, FileMark>,
    sink: &mut dyn FnMut(TranscriptEvent),
    stats: &mut RefreshStats,
) {
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    let (len, mtime) = (meta.len(), mtime_ns(&meta));
    let mut start = 0;
    let mut known_key = None;
    let had_mark = marks.contains_key(file_key);
    if let Some(mark) = marks.get(file_key) {
        let Some(from) = start_at(mark, len, mtime) else {
            return;
        };
        start = from;
        known_key = Some(mark.session.clone());
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
    let mut bad = 0;
    // Texts wait until the end of the read: a Codex file names its session
    // on its first line, and a rewritten file must reset before it adds.
    let mut found: Found = Vec::new();
    let mut last_at = 0;
    let result = for_each_line(path, start, |_, line| {
        let Some(v) = parse_line(line) else {
            if !is_blank(line) {
                bad += 1;
            }
            return;
        };
        let at = line_time(&v).unwrap_or(last_at);
        last_at = at;
        match home.agent {
            Agent::Claude => claude_line(&v, at, &mut found),
            Agent::Codex => codex_line(&v, at, &mut id, &mut found),
        }
    });
    let Ok(offset) = result else {
        return;
    };
    stats.files_read += 1;
    stats.bad_lines += bad;
    stats.bytes += offset.saturating_sub(start);

    let session_key = format!("{}:{id}", home.id);
    if had_mark && start == 0 {
        sink(TranscriptEvent::Reset {
            file: file_key.to_string(),
        });
    }
    for (role, text, at) in found {
        sink(TranscriptEvent::Text(TranscriptText {
            file: file_key.to_string(),
            session_key: session_key.clone(),
            role,
            text,
            at,
        }));
    }
    let mark = FileMark {
        len,
        mtime_ns: mtime,
        offset,
        session: session_key,
        recent_ids: Vec::new(),
    };
    marks.insert(file_key.to_string(), mark.clone());
    sink(TranscriptEvent::Done {
        file: file_key.to_string(),
        mark,
    });
}

fn cap(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(TEXT_CHARS_MAX).collect())
}

/// The `text` items of a content array, wrappers left out, joined by lines.
fn joined_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => (!is_wrapper(s)).then(|| s.clone()),
        Value::Array(items) => {
            let parts: Vec<&str> = items
                .iter()
                .filter_map(|i| i.get("text").and_then(Value::as_str))
                .filter(|t| !is_wrapper(t))
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

fn claude_line(v: &Value, at: i64, out: &mut Found) {
    if flag(v, "isSidechain") || flag(v, "isMeta") {
        return;
    }
    let Some(content) = v.get("message").and_then(|m| m.get("content")) else {
        return;
    };
    let (role, text) = match type_of(v) {
        Some("user") => (TextRole::User, claude_prompt(content).map(str::to_string)),
        Some("assistant") => (TextRole::Assistant, joined_text(content)),
        _ => return,
    };
    if let Some(text) = text.as_deref().and_then(cap) {
        out.push((role, text, at));
    }
}

fn codex_line(v: &Value, at: i64, id: &mut String, out: &mut Found) {
    let Some(payload) = v.get("payload") else {
        return;
    };
    match type_of(v) {
        Some("session_meta") => {
            if let Some(found) = str_at(payload, "id") {
                *id = found.to_string();
            }
        }
        Some("response_item") if type_of(payload) == Some("message") => {
            let (role, text) = match payload.get("role").and_then(Value::as_str) {
                Some("user") => (TextRole::User, codex_text(payload).map(str::to_string)),
                Some("assistant") => (
                    TextRole::Assistant,
                    payload.get("content").and_then(joined_text),
                ),
                _ => return,
            };
            if let Some(text) = text.as_deref().and_then(cap) {
                out.push((role, text, at));
            }
        }
        _ => {}
    }
}

#[cfg(test)]
#[path = "transcripts_tests.rs"]
mod tests;
