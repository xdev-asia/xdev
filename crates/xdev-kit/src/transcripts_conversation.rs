//! The whole conversation of one log, for reading: what the person typed,
//! what the agent answered, each tool step it took and the marks the CLI
//! left (a compaction, a resume, a model change). The same lines the
//! transcript reader drops stay dropped: side chains, meta lines, wrapper
//! text, thinking, images, reasoning and instructions.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::logs::{for_each_line, parse_line, parse_ts};
use crate::sessions::is_wrapper;
use crate::transcripts::TEXT_CHARS_MAX;
use crate::{Agent, Home};

/// The most bytes of tool output one step keeps.
pub const TOOL_OUTPUT_MAX: usize = 2_048;
/// The most characters of a tool step's input summary.
pub const TOOL_SUMMARY_CHARS: usize = 160;
/// The items one page holds when no limit is given.
pub const CONVERSATION_PAGE: usize = 200;
/// The most items one page holds.
pub const CONVERSATION_PAGE_MAX: usize = 1_000;
/// The most markers a page lists for the whole session.
pub const MARKERS_MAX: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversationKind {
    User,
    Assistant,
    Tool,
    Marker,
}

impl ConversationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ConversationKind::User => "user",
            ConversationKind::Assistant => "assistant",
            ConversationKind::Tool => "tool",
            ConversationKind::Marker => "marker",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    Ok,
    Error,
    /// No result logged yet: the step runs, or the session stopped in it.
    Pending,
}

impl ToolStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolStatus::Ok => "ok",
            ToolStatus::Error => "error",
            ToolStatus::Pending => "pending",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkerKind {
    Compact,
    Resume,
    Model,
}

impl MarkerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MarkerKind::Compact => "compact",
            MarkerKind::Resume => "resume",
            MarkerKind::Model => "model",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolStep {
    pub name: String,
    /// One line about the input: the command, the path, the pattern…
    pub summary: String,
    pub status: ToolStatus,
    /// At most `TOOL_OUTPUT_MAX` bytes.
    pub output: String,
    /// The output was cut.
    pub cut: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationItem {
    /// Place in the whole conversation, from 0.
    pub index: usize,
    pub kind: ConversationKind,
    /// The message text; a marker's detail (the new model); empty for a tool step.
    pub text: String,
    /// Unix ms; 0 when the line has no time.
    pub at: i64,
    pub tool: Option<ToolStep>,
    pub marker: Option<MarkerKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConversationPage {
    pub items: Vec<ConversationItem>,
    /// Index of the first item of `items`.
    pub from: usize,
    /// Items in the whole conversation.
    pub total: usize,
    /// Messages the person typed in the whole conversation.
    pub turns: usize,
    /// The last model the log names.
    pub model: Option<String>,
    /// The markers of the whole conversation, the last `MARKERS_MAX`.
    pub markers: Vec<ConversationItem>,
}

/// One page of the conversation in `path`. `from` absent reads the last
/// `limit` items; `limit` absent is `CONVERSATION_PAGE`, and it is held to
/// 1..=`CONVERSATION_PAGE_MAX`. A `from` past the end gives no items.
pub fn conversation(
    home: &Home,
    path: &Path,
    from: Option<usize>,
    limit: Option<usize>,
) -> std::io::Result<ConversationPage> {
    fs::metadata(path)?;
    let mut read = Reader::new(home.agent);
    for_each_line(path, 0, |_, line| {
        if let Some(v) = parse_line(line) {
            read.line(&v);
        }
    })?;
    Ok(read.page(from, limit))
}

/// The conversation of `text` (log lines, oldest first), for tests and callers
/// that hold the lines already.
pub fn conversation_of_text(
    agent: Agent,
    text: &str,
    from: Option<usize>,
    limit: Option<usize>,
) -> ConversationPage {
    let mut read = Reader::new(agent);
    for line in text.lines() {
        if let Some(v) = parse_line(line.as_bytes()) {
            read.line(&v);
        }
    }
    read.page(from, limit)
}

/// `(start, end)` of a page of `total` items.
pub fn page_bounds(total: usize, from: Option<usize>, limit: Option<usize>) -> (usize, usize) {
    let limit = limit
        .unwrap_or(CONVERSATION_PAGE)
        .clamp(1, CONVERSATION_PAGE_MAX);
    let start = match from {
        Some(f) => f.min(total),
        None => total.saturating_sub(limit),
    };
    (start, start.saturating_add(limit).min(total))
}

struct Reader {
    agent: Agent,
    items: Vec<ConversationItem>,
    /// Tool call id to the index of its step.
    calls: HashMap<String, usize>,
    model: Option<String>,
    session: Option<String>,
    metas: usize,
    last_at: i64,
}

impl Reader {
    fn new(agent: Agent) -> Self {
        Reader {
            agent,
            items: Vec::new(),
            calls: HashMap::new(),
            model: None,
            session: None,
            metas: 0,
            last_at: 0,
        }
    }

    fn page(self, from: Option<usize>, limit: Option<usize>) -> ConversationPage {
        let total = self.items.len();
        let (start, end) = page_bounds(total, from, limit);
        let turns = self
            .items
            .iter()
            .filter(|i| i.kind == ConversationKind::User)
            .count();
        let markers: Vec<ConversationItem> = self
            .items
            .iter()
            .filter(|i| i.kind == ConversationKind::Marker)
            .cloned()
            .collect();
        let skip = markers.len().saturating_sub(MARKERS_MAX);
        ConversationPage {
            items: self.items[start..end].to_vec(),
            from: start,
            total,
            turns,
            model: self.model,
            markers: markers.into_iter().skip(skip).collect(),
        }
    }

    fn push(&mut self, kind: ConversationKind, text: String, at: i64) -> usize {
        let index = self.items.len();
        self.items.push(ConversationItem {
            index,
            kind,
            text,
            at,
            tool: None,
            marker: None,
        });
        index
    }

    fn text(&mut self, kind: ConversationKind, text: &str, at: i64) {
        if let Some(text) = keep_text(text) {
            self.push(kind, text, at);
        }
    }

    fn marker(&mut self, kind: MarkerKind, detail: String, at: i64) {
        let i = self.push(ConversationKind::Marker, detail, at);
        self.items[i].marker = Some(kind);
    }

    fn tool(&mut self, id: Option<&str>, name: &str, summary: String, at: i64) {
        let i = self.push(ConversationKind::Tool, String::new(), at);
        self.items[i].tool = Some(ToolStep {
            name: one_line(name, 60),
            summary,
            status: ToolStatus::Pending,
            output: String::new(),
            cut: false,
        });
        if let Some(id) = id.filter(|s| !s.is_empty()) {
            self.calls.insert(id.to_string(), i);
        }
    }

    fn result(&mut self, id: Option<&str>, error: bool, output: &str) {
        let Some(i) = id.and_then(|id| self.calls.remove(id)) else {
            return;
        };
        if let Some(step) = self.items[i].tool.as_mut() {
            step.status = if error {
                ToolStatus::Error
            } else {
                ToolStatus::Ok
            };
            let (output, cut) = bound_output(output);
            step.output = output;
            step.cut = cut;
        }
    }

    fn model_seen(&mut self, model: &str, at: i64) {
        if model.is_empty() || model.starts_with('<') {
            return;
        }
        match self.model.as_deref() {
            Some(m) if m == model => {}
            Some(_) => {
                self.model = Some(model.to_string());
                self.marker(MarkerKind::Model, model.to_string(), at);
            }
            None => self.model = Some(model.to_string()),
        }
    }

    fn at(&mut self, v: &Value) -> i64 {
        let at = str_of(v, "timestamp")
            .and_then(parse_ts)
            .unwrap_or(self.last_at);
        self.last_at = at;
        at
    }

    fn line(&mut self, v: &Value) {
        let at = self.at(v);
        match self.agent {
            Agent::Claude => self.claude(v, at),
            Agent::Codex => self.codex(v, at),
        }
    }

    fn claude(&mut self, v: &Value, at: i64) {
        if flag(v, "isSidechain") {
            return;
        }
        let kind = str_of(v, "type").unwrap_or("");
        if kind == "system" {
            if str_of(v, "subtype") == Some("compact_boundary") {
                self.marker(MarkerKind::Compact, String::new(), at);
            }
            return;
        }
        if kind != "user" && kind != "assistant" {
            return;
        }
        // A session carried on from another keeps the other's id on its lines.
        if let Some(id) = str_of(v, "sessionId").filter(|s| !s.is_empty()) {
            match self.session.as_deref() {
                Some(s) if s != id => {
                    self.session = Some(id.to_string());
                    self.marker(MarkerKind::Resume, String::new(), at);
                }
                Some(_) => {}
                None => self.session = Some(id.to_string()),
            }
        }
        if flag(v, "isMeta") || flag(v, "isCompactSummary") {
            return;
        }
        let Some(message) = v.get("message").filter(|m| m.is_object()) else {
            return;
        };
        let content = message.get("content");
        if kind == "assistant" {
            if let Some(model) = str_of(message, "model") {
                self.model_seen(model, at);
            }
            match content {
                Some(Value::String(s)) => self.text(ConversationKind::Assistant, s, at),
                Some(Value::Array(items)) => {
                    for item in items {
                        match str_of(item, "type") {
                            Some("text") => {
                                let t = str_of(item, "text").unwrap_or("");
                                self.text(ConversationKind::Assistant, t, at);
                            }
                            Some("tool_use" | "server_tool_use") => {
                                let name = str_of(item, "name").unwrap_or("tool");
                                let summary = summarize_input(item.get("input"));
                                self.tool(str_of(item, "id"), name, summary, at);
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            return;
        }
        match content {
            Some(Value::String(s)) => self.text(ConversationKind::User, s, at),
            Some(Value::Array(items)) => {
                let mut typed = Vec::new();
                for item in items {
                    match str_of(item, "type") {
                        Some("tool_result") => {
                            let output = result_text(item.get("content"));
                            let error = flag(item, "is_error");
                            self.result(str_of(item, "tool_use_id"), error, &output);
                        }
                        Some("text") => {
                            if let Some(t) = str_of(item, "text") {
                                typed.push(t);
                            }
                        }
                        _ => {}
                    }
                }
                let typed: Vec<&str> = typed.into_iter().filter(|t| !is_wrapper(t)).collect();
                if !typed.is_empty() {
                    self.text(ConversationKind::User, &typed.join("\n"), at);
                }
            }
            _ => {}
        }
    }

    fn codex(&mut self, v: &Value, at: i64) {
        let Some(payload) = v.get("payload").filter(|p| p.is_object()) else {
            return;
        };
        match str_of(v, "type").unwrap_or("") {
            "session_meta" => {
                self.metas += 1;
                if self.metas > 1 {
                    self.marker(MarkerKind::Resume, String::new(), at);
                }
            }
            "turn_context" => {
                if let Some(model) = str_of(payload, "model") {
                    self.model_seen(model, at);
                }
            }
            "compacted" => self.marker(MarkerKind::Compact, String::new(), at),
            "response_item" => self.codex_item(payload, at),
            _ => {}
        }
    }

    fn codex_item(&mut self, p: &Value, at: i64) {
        match str_of(p, "type").unwrap_or("") {
            "message" => {
                let kind = match str_of(p, "role") {
                    Some("user") => ConversationKind::User,
                    Some("assistant") => ConversationKind::Assistant,
                    // Developer and system messages are instructions, not the talk.
                    _ => return,
                };
                let parts: Vec<&str> = p
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|i| str_of(i, "text"))
                            .filter(|t| !is_wrapper(t))
                            .collect()
                    })
                    .unwrap_or_default();
                if !parts.is_empty() {
                    self.text(kind, &parts.join("\n"), at);
                }
            }
            "function_call" => {
                let name = str_of(p, "name").unwrap_or("tool");
                let args = str_of(p, "arguments")
                    .and_then(|a| serde_json::from_str::<Value>(a).ok())
                    .or_else(|| str_of(p, "arguments").map(|a| Value::String(a.to_string())));
                let summary = summarize_input(args.as_ref());
                self.tool(str_of(p, "call_id"), name, summary, at);
            }
            "custom_tool_call" => {
                let name = str_of(p, "name").unwrap_or("tool");
                let input = p.get("input");
                self.tool(str_of(p, "call_id"), name, summarize_input(input), at);
            }
            "local_shell_call" => {
                let summary = summarize_input(p.get("action"));
                self.tool(str_of(p, "call_id"), "shell", summary, at);
            }
            "function_call_output" | "custom_tool_call_output" => {
                let (error, output) = codex_output(p.get("output"));
                self.result(str_of(p, "call_id"), error, &output);
            }
            _ => {}
        }
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool) == Some(true)
}

/// Message text trimmed and cut to `TEXT_CHARS_MAX`; `None` when empty or
/// only wrapper text.
fn keep_text(text: &str) -> Option<String> {
    if is_wrapper(text) {
        return None;
    }
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(TEXT_CHARS_MAX).collect())
}

/// Whitespace runs to one space, cut to `max` chars with an ellipsis.
fn one_line(text: &str, max: usize) -> String {
    let mut out = String::new();
    for word in text.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
        if out.len() > max * 4 {
            break;
        }
    }
    if out.chars().count() > max {
        let mut cut: String = out.chars().take(max.saturating_sub(1)).collect();
        cut.push('…');
        return cut;
    }
    out
}

/// The input fields that say what a step did, most telling first.
const SUMMARY_KEYS: &[&str] = &[
    "command",
    "cmd",
    "file_path",
    "path",
    "notebook_path",
    "pattern",
    "url",
    "query",
    "description",
    "prompt",
];

/// One line about a tool input, values that look like secrets hidden.
pub fn summarize_input(input: Option<&Value>) -> String {
    let Some(input) = input else {
        return String::new();
    };
    let raw = match input {
        Value::String(s) => s.clone(),
        Value::Object(map) => {
            let found = SUMMARY_KEYS.iter().find_map(|k| map.get(*k)).or_else(|| {
                map.values()
                    .find(|v| v.is_string() && !v.as_str().unwrap_or("").is_empty())
            });
            match found {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => String::new(),
            }
        }
        _ => String::new(),
    };
    one_line(&mask_secrets(&raw), TOOL_SUMMARY_CHARS)
}

/// The text of a Claude `tool_result` content: a string, or text items.
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|i| str_of(i, "type") == Some("text"))
            .filter_map(|i| str_of(i, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// `(error, text)` of a Codex call output: a plain string, a JSON string with
/// `output` and `metadata.exit_code`, or an object with `content` and `success`.
fn codex_output(output: Option<&Value>) -> (bool, String) {
    let exit_line = |text: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix("Exit code: "))
            .and_then(|n| n.trim().parse::<i64>().ok())
            .is_some_and(|n| n != 0)
    };
    match output {
        Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
            Ok(v @ Value::Object(_)) => {
                let text = str_of(&v, "output").unwrap_or("").to_string();
                let code = v
                    .get("metadata")
                    .and_then(|m| m.get("exit_code"))
                    .and_then(Value::as_i64);
                (code.is_some_and(|c| c != 0) || exit_line(&text), text)
            }
            _ => (exit_line(s), s.clone()),
        },
        Some(v @ Value::Object(_)) => {
            let text = match v.get("content") {
                Some(Value::String(s)) => s.clone(),
                other => result_text(other),
            };
            let failed = v.get("success").and_then(Value::as_bool) == Some(false);
            (failed || exit_line(&text), text)
        }
        _ => (false, String::new()),
    }
}

/// The output kept for a step: secrets masked, at most `TOOL_OUTPUT_MAX`
/// bytes on a char boundary, and whether it was cut.
fn bound_output(text: &str) -> (String, bool) {
    let text = mask_secrets(text.trim_end());
    if text.len() <= TOOL_OUTPUT_MAX {
        return (text, false);
    }
    let mut end = TOOL_OUTPUT_MAX;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// Names whose value is hidden when they are set with `=` or `:`.
const SECRET_NAMES: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "api_key",
    "apikey",
    "api-key",
    "authorization",
    "private_key",
];

/// Hides the value after `NAME=` or `NAME:` when the name holds one of
/// `SECRET_NAMES` (any case), and the rest of a `Bearer` header.
pub fn mask_secrets(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(['=', ':']) {
        let (head, tail) = rest.split_at(i);
        out.push_str(head);
        let sep = &tail[..1];
        out.push_str(sep);
        let tail = &tail[1..];
        let named = head.trim_end_matches(['"', '\'', ' ']);
        let name_start = named
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .map_or(0, |j| j + 1);
        let name = named[name_start..].to_ascii_lowercase();
        let secret = !name.is_empty() && SECRET_NAMES.iter().any(|s| name.contains(s));
        if secret {
            let lead = tail.len() - tail.trim_start().len();
            let value = &tail[lead..];
            let value = value.strip_prefix('"').unwrap_or(value);
            let quoted = value.len() != tail.len() - lead;
            let end = value
                .find(|c: char| c.is_whitespace() || c == '"' || c == ',' || c == '}')
                .unwrap_or(value.len());
            let mut end = end;
            // `Authorization: Bearer x` hides the token after the scheme too.
            if value[..end].eq_ignore_ascii_case("bearer")
                || value[..end].eq_ignore_ascii_case("basic")
            {
                let after = &value[end..];
                let gap = after.len() - after.trim_start().len();
                let more = after[gap..]
                    .find(|c: char| c.is_whitespace() || c == '"' || c == ',')
                    .unwrap_or(after.len() - gap);
                end += gap + more;
            }
            if end > 0 {
                out.push_str(&tail[..lead]);
                if quoted {
                    out.push('"');
                }
                out.push_str("•••");
                rest = &value[end..];
                continue;
            }
        }
        rest = tail;
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
#[path = "transcripts_conversation_tests.rs"]
mod tests;
