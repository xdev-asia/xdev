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

#[cfg(test)]
#[path = "transcripts_tests.rs"]
mod tests;
