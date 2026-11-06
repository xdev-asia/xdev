//! A hand-written subset of YAML front matter: scalars, quoted scalars,
//! inline lists `[a, b]` and block lists `- a`. Each line is kept as a key
//! line or as raw text, so a round trip keeps what it does not understand,
//! and a key line that is not changed is written back exactly as read.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Str(String),
    List(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    /// `key: value`, with a block list's `- item` lines folded in.
    Known {
        key: String,
        value: Value,
        /// The line(s) as read, joined by `\n`; used while `value` is as read.
        orig: Option<String>,
        /// The value as read, to tell a change.
        read: Option<Value>,
        /// A trailing ` # comment`, kept when the value changes.
        comment: Option<String>,
    },
    /// Anything else (comments, blank lines, odd lines), copied exactly.
    Raw(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskDoc {
    pub lines: Vec<Line>,
    pub body: String,
    eol: &'static str,
    /// The closing `---` ended with a line break.
    close_eol: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ParseError {
    #[error("the file does not start with ---")]
    NoOpen,
    #[error("the front matter has no closing ---")]
    NoClose,
}

fn strip_eol(line: &str) -> &str {
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line)
}

fn is_key_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

/// `key` and the text after the colon, for an unindented `key: …` line.
fn split_key(line: &str) -> Option<(&str, &str)> {
    let first = line.chars().next()?;
    if !is_key_start(first) {
        return None;
    }
    let colon = line.find(':')?;
    let key = line[..colon].trim_end();
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some((key, &line[colon + 1..]))
}

/// A quoted scalar at the start of `s` and the text after it.
fn unquote(s: &str) -> Option<(String, &str)> {
    let mut chars = s.char_indices();
    let (_, quote) = chars.next()?;
    let mut out = String::new();
    if quote == '"' {
        let mut escaped = false;
        for (i, c) in chars {
            if escaped {
                match c {
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    '"' | '\\' => out.push(c),
                    other => {
                        out.push('\\');
                        out.push(other);
                    }
                }
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                return Some((out, &s[i + 1..]));
            } else {
                out.push(c);
            }
        }
        None
    } else if quote == '\'' {
        let mut iter = chars.peekable();
        while let Some((i, c)) = iter.next() {
            if c == '\'' {
                if iter.peek().is_some_and(|&(_, n)| n == '\'') {
                    out.push('\'');
                    iter.next();
                } else {
                    return Some((out, &s[i + 1..]));
                }
            } else {
                out.push(c);
            }
        }
        None
    } else {
        None
    }
}

/// The text before a ` #` comment, and the comment (with its leading space).
fn split_comment(s: &str) -> (&str, Option<&str>) {
    let bytes = s.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'#' && i > 0 && (bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
            let head = s[..i].trim_end();
            return (head, Some(&s[head.len()..]));
        }
    }
    (s, None)
}

/// The ` # comment` after a closing quote or bracket, if there is one.
fn after_quote_comment(rest: &str) -> Option<String> {
    let t = rest.trim();
    t.starts_with('#').then(|| format!(" {t}"))
}

fn parse_scalar(raw: &str) -> (String, Option<String>) {
    let raw = raw.trim_start();
    if let Some((text, rest)) = unquote(raw) {
        return (text, after_quote_comment(rest));
    }
    let (head, comment) = split_comment(raw);
    (head.trim().to_owned(), comment.map(str::to_owned))
}

fn parse_inline_list(raw: &str) -> Option<(Vec<String>, Option<String>)> {
    let raw = raw.trim_start();
    let mut rest = raw.strip_prefix('[')?;
    let mut items = Vec::new();
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix(']') {
            return Some((items, after_quote_comment(after)));
        }
        let item;
        if rest.starts_with('"') || rest.starts_with('\'') {
            let (text, after) = unquote(rest)?;
            item = text;
            rest = after.trim_start();
        } else {
            let end = rest.find([',', ']'])?;
            item = rest[..end].trim().to_owned();
            rest = &rest[end..];
        }
        if !item.is_empty() {
            items.push(item);
        }
        if let Some(after) = rest.strip_prefix(',') {
            rest = after;
        } else if !rest.starts_with(']') {
            return None;
        }
    }
}

fn block_item(line: &str) -> Option<String> {
    let t = line.trim_start();
    let item = t.strip_prefix('-')?;
    if !item.is_empty() && !item.starts_with([' ', '\t']) {
        return None;
    }
    Some(parse_scalar(item).0)
}

pub fn parse(text: &str) -> Result<TaskDoc, ParseError> {
    let mut rest = text;
    let first = rest
        .split_inclusive('\n')
        .next()
        .ok_or(ParseError::NoOpen)?;
    if strip_eol(first) != "---" {
        return Err(ParseError::NoOpen);
    }
    let eol = if first.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    rest = &rest[first.len()..];
    let mut raw_lines: Vec<&str> = Vec::new();
    let mut close = None;
    while !rest.is_empty() {
        let line = rest.split_inclusive('\n').next().unwrap_or("");
        rest = &rest[line.len()..];
        if strip_eol(line) == "---" {
            close = Some(line.ends_with('\n'));
            break;
        }
        raw_lines.push(strip_eol(line));
    }
    let close_eol = close.ok_or(ParseError::NoClose)?;
    let body = rest.to_owned();

    let mut lines = Vec::new();
    let mut i = 0;
    while i < raw_lines.len() {
        let line = raw_lines[i];
        i += 1;
        let Some((key, after)) = split_key(line) else {
            lines.push(Line::Raw(line.to_owned()));
            continue;
        };
        let after_trim = after.trim_start();
        let mut orig = line.to_owned();
        let (value, comment) = if after_trim.is_empty() || after_trim.starts_with('#') {
            let comment = (!after_trim.is_empty()).then(|| format!(" {after_trim}"));
            let mut items = Vec::new();
            while i < raw_lines.len() {
                let Some(item) = block_item(raw_lines[i]) else {
                    break;
                };
                items.push(item);
                orig.push('\n');
                orig.push_str(raw_lines[i]);
                i += 1;
            }
            if items.is_empty() {
                (Value::Str(String::new()), comment)
            } else {
                (Value::List(items), comment)
            }
        } else if let Some((items, comment)) = parse_inline_list(after) {
            (Value::List(items), comment)
        } else {
            let (text, comment) = parse_scalar(after);
            (Value::Str(text), comment)
        };
        lines.push(Line::Known {
            key: key.to_owned(),
            read: Some(value.clone()),
            value,
            orig: Some(orig),
            comment,
        });
    }
    Ok(TaskDoc {
        lines,
        body,
        eol,
        close_eol,
    })
}

fn needs_quote(s: &str) -> bool {
    let colon = s
        .char_indices()
        .any(|(i, c)| c == ':' && s[i + 1..].chars().next().is_none_or(char::is_whitespace));
    colon
        || s.contains(['#', '[', ']', ',', '"', '\'', '\n', '\r', '\\'])
        || s.starts_with(char::is_whitespace)
        || s.ends_with(char::is_whitespace)
        || s.starts_with(['-', '>', '|', '&', '*', '!', '%', '@', '`', '?', '{', '}'])
}

fn quote(s: &str) -> String {
    let mut out = String::from('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A value as written: quoted when a reader would take it for something else.
pub fn scalar_text(s: &str) -> String {
    if needs_quote(s) {
        quote(s)
    } else {
        s.to_owned()
    }
}

fn value_text(v: &Value) -> String {
    match v {
        Value::Str(s) => scalar_text(s),
        Value::List(items) => {
            let items: Vec<String> = items.iter().map(|i| scalar_text(i)).collect();
            format!("[{}]", items.join(", "))
        }
    }
}

impl TaskDoc {
    /// A document with the given key lines and body.
    pub fn new(pairs: Vec<(String, Value)>, body: String) -> TaskDoc {
        TaskDoc {
            lines: pairs
                .into_iter()
                .map(|(key, value)| Line::Known {
                    key,
                    value,
                    orig: None,
                    read: None,
                    comment: None,
                })
                .collect(),
            body,
            eol: "\n",
            close_eol: true,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.lines.iter().find_map(|l| match l {
            Line::Known { key: k, value, .. } if k == key => Some(value),
            _ => None,
        })
    }

    /// The value of `key` as one string; a list reads as its first item.
    pub fn get_str(&self, key: &str) -> Option<&str> {
        match self.get(key)? {
            Value::Str(s) => Some(s),
            Value::List(items) => items.first().map(String::as_str),
        }
    }

    /// Changes `key` where it is, or adds it after the last key line.
    pub fn set(&mut self, key: &str, new: Value) {
        for line in &mut self.lines {
            if let Line::Known { key: k, value, .. } = line
                && k == key
            {
                *value = new;
                return;
            }
        }
        let at = self
            .lines
            .iter()
            .rposition(|l| matches!(l, Line::Known { .. }))
            .map_or(self.lines.len(), |i| i + 1);
        self.lines.insert(
            at,
            Line::Known {
                key: key.to_owned(),
                value: new,
                orig: None,
                read: None,
                comment: None,
            },
        );
    }

    /// Drops `key`, with its comment.
    pub fn remove(&mut self, key: &str) {
        self.lines
            .retain(|l| !matches!(l, Line::Known { key: k, .. } if k == key));
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        let push = |text: &str, out: &mut String| {
            for (n, part) in text.split('\n').enumerate() {
                if n > 0 {
                    out.push_str(self.eol);
                }
                out.push_str(part);
            }
            out.push_str(self.eol);
        };
        out.push_str("---");
        out.push_str(self.eol);
        for line in &self.lines {
            match line {
                Line::Raw(text) => push(text, &mut out),
                Line::Known {
                    key,
                    value,
                    orig,
                    read,
                    comment,
                } => match orig {
                    Some(orig) if read.as_ref() == Some(value) => push(orig, &mut out),
                    _ => {
                        let text = value_text(value);
                        let sep = if text.is_empty() { "" } else { " " };
                        let comment = comment.as_deref().unwrap_or("");
                        push(&format!("{key}:{sep}{text}{comment}"), &mut out);
                    }
                },
            }
        }
        out.push_str("---");
        if self.close_eol {
            out.push_str(self.eol);
        }
        out.push_str(&self.body);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nid: t7k2m9q\n# a note\ntitle: \"Fix: the loop\"\nstatus: todo   # backlog | todo\nlabels:\n  - auth\n  - bug\nowner: me\n\nmood:  odd\n---\nBody line\n\n  indented\n";

    #[test]
    fn round_trip_is_byte_for_byte() {
        for text in [
            SAMPLE.to_owned(),
            SAMPLE.replace('\n', "\r\n"),
            "---\nid: a\n---".to_owned(),
            "---\n---\n".to_owned(),
        ] {
            assert_eq!(parse(&text).unwrap().render(), text);
        }
    }

    #[test]
    fn reads_scalars_quotes_and_comments() {
        let doc = parse(SAMPLE).unwrap();
        assert_eq!(doc.get_str("title"), Some("Fix: the loop"));
        assert_eq!(doc.get_str("status"), Some("todo"));
        assert_eq!(doc.get_str("mood"), Some("odd"));
        let doc = parse("---\na: 'it''s'\nb: x#y\nc: \"q\" # c\n---\n").unwrap();
        assert_eq!(doc.get_str("a"), Some("it's"));
        assert_eq!(doc.get_str("b"), Some("x#y"));
        assert_eq!(doc.get_str("c"), Some("q"));
    }

    #[test]
    fn reads_block_and_inline_lists() {
        let doc = parse(SAMPLE).unwrap();
        assert_eq!(
            doc.get("labels"),
            Some(&Value::List(vec!["auth".into(), "bug".into()]))
        );
        let doc = parse("---\nlabels: [a, \"b, c\", 'd']\nnone: []\n---\n").unwrap();
        assert_eq!(
            doc.get("labels"),
            Some(&Value::List(vec!["a".into(), "b, c".into(), "d".into()]))
        );
        assert_eq!(doc.get("none"), Some(&Value::List(vec![])));
    }

    #[test]
    fn changes_keep_order_unknown_lines_and_body() {
        let mut doc = parse(SAMPLE).unwrap();
        doc.set("status", Value::Str("done".into()));
        doc.set("branch", Value::Str("x".into()));
        doc.set("labels", Value::List(vec!["a".into(), "b c".into()]));
        let out = doc.render();
        assert_eq!(
            out,
            "---\nid: t7k2m9q\n# a note\ntitle: \"Fix: the loop\"\nstatus: done   # backlog | todo\nlabels: [a, b c]\nowner: me\n\nmood:  odd\nbranch: x\n---\nBody line\n\n  indented\n"
        );
    }

    #[test]
    fn quotes_what_would_read_back_wrong() {
        for s in [
            "a: b",
            "a #b",
            "[x]",
            "a,b",
            " lead",
            "trail ",
            "say \"hi\"",
            "- dash",
            "a\\b",
        ] {
            let mut doc = parse("---\n---\n").unwrap();
            doc.set("k", Value::Str(s.into()));
            doc.set("l", Value::List(vec![s.into(), "z".into()]));
            let back = parse(&doc.render()).unwrap();
            assert_eq!(back.get_str("k"), Some(s), "{s}");
            assert_eq!(
                back.get("l"),
                Some(&Value::List(vec![s.into(), "z".into()])),
                "{s}"
            );
        }
        assert_eq!(scalar_text("2026-11-06T09:12:00Z"), "2026-11-06T09:12:00Z");
        assert_eq!(scalar_text("a: b"), "\"a: b\"");
        assert_eq!(scalar_text("plain"), "plain");
    }

    #[test]
    fn needs_both_fences() {
        assert_eq!(parse("id: a\n").unwrap_err(), ParseError::NoOpen);
        assert_eq!(parse("").unwrap_err(), ParseError::NoOpen);
        assert_eq!(
            parse("---\nid: a\nbody\n").unwrap_err(),
            ParseError::NoClose
        );
    }
}
