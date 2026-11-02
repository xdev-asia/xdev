//! A small YAML subset, parsed by hand: only a few keys matter, and a subset
//! parser cannot fail on odd YAML, it just ignores what it does not know.

/// `Ord` is the fixed order the generated files and the UI list targets in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Agents,
    Claude,
    Gemini,
    Cursor,
}

impl Target {
    /// Exact lowercase only, so `AGENTS` in a list is not mistaken for a
    /// deliberate selection.
    fn parse(s: &str) -> Option<Target> {
        match s {
            "agents" => Some(Target::Agents),
            "claude" => Some(Target::Claude),
            "gemini" => Some(Target::Gemini),
            "cursor" => Some(Target::Cursor),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Frontmatter {
    pub title: Option<String>,
    /// Deduplicated, in `Target` order.
    pub agents: Vec<Target>,
    pub tags: Vec<String>,
    /// Repo-relative pathspecs, cleaned so a doc cannot point outside the repo.
    pub covers: Vec<String>,
    /// Lowercase hex, 4 to 40 digits; anything else reads as missing.
    pub verified: Option<String>,
    /// The `type` key.
    pub doc_type: Option<String>,
}

/// Splits off a leading `---` block. The BOM is never part of the body, so
/// a Windows file and its LF twin give the same body.
pub fn parse_frontmatter(content: &str) -> (Frontmatter, &str) {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    match split(content) {
        Some((block, body)) => (parse_block(block), body),
        None => (Frontmatter::default(), content),
    }
}

/// `(block, body)` when the text opens and closes a frontmatter block.
fn split(content: &str) -> Option<(&str, &str)> {
    let mut offset = 0;
    let mut block_start = None;
    for piece in content.split_inclusive('\n') {
        let start = offset;
        offset += piece.len();
        let line = piece.strip_suffix('\n').unwrap_or(piece);
        let is_fence = line.strip_suffix('\r').unwrap_or(line) == "---";
        match block_start {
            None if is_fence => block_start = Some(offset),
            // Without an opening line at the very start there is no block.
            None => return None,
            Some(from) if is_fence => return Some((&content[from..start], &content[offset..])),
            Some(_) => {}
        }
    }
    None
}

enum Value {
    List(Vec<String>),
    /// `plain` is false for quoted text, which is never read as a boolean.
    Scalar {
        text: String,
        plain: bool,
    },
}

#[derive(Clone, Copy)]
enum Key {
    Title = 0,
    Agents = 1,
    Tags = 2,
    Covers = 3,
    Verified = 4,
    Type = 5,
}

fn parse_block(block: &str) -> Frontmatter {
    let mut values: [Option<Value>; 6] = Default::default();
    // The known key whose `  - item` lines are being collected.
    let mut open: Option<Key> = None;

    for line in block.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let item = trimmed
            .strip_prefix('-')
            .filter(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace));
        let indented = line.starts_with(char::is_whitespace);
        // YAML allows `- item` at the key's own indent, so an unindented item
        // still belongs to the open list.
        if indented || (open.is_some() && item.is_some()) {
            if let (Some(key), Some(item)) = (open, item)
                && let Some(Value::List(items)) = &mut values[key as usize]
            {
                let (text, _) = scalar(item);
                if !text.is_empty() {
                    items.push(text);
                }
            }
            continue;
        }
        open = None;
        let Some((key, raw)) = line.split_once(':') else {
            continue;
        };
        // YAML needs a space after the colon; `a:b` is plain text, not a pair.
        if !(raw.is_empty() || raw.starts_with(char::is_whitespace)) {
            continue;
        }
        let key = match key {
            "title" => Key::Title,
            "agents" => Key::Agents,
            "tags" => Key::Tags,
            "covers" => Key::Covers,
            "verified" => Key::Verified,
            "type" => Key::Type,
            _ => continue,
        };
        let value = parse_value(raw);
        let starts_block = matches!(&value, Value::Scalar { text, plain: true } if text.is_empty());
        values[key as usize] = if starts_block {
            open = Some(key);
            Some(Value::List(Vec::new()))
        } else {
            Some(value)
        };
    }

    let [title, agents, tags, covers, verified, doc_type] = values;
    Frontmatter {
        title: text(title),
        agents: parse_agents(agents),
        tags: list(tags),
        covers: parse_covers(list(covers)),
        verified: text(verified)
            .filter(|v| (4..=40).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(|v| v.to_ascii_lowercase()),
        doc_type: text(doc_type)
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty()),
    }
}

fn text(value: Option<Value>) -> Option<String> {
    match value {
        Some(Value::Scalar { text, .. }) if !text.is_empty() => Some(text),
        _ => None,
    }
}

/// One plain value counts as a list of one.
fn list(value: Option<Value>) -> Vec<String> {
    match value {
        Some(Value::List(items)) => items,
        Some(Value::Scalar { text, .. }) if !text.is_empty() => vec![text],
        _ => Vec::new(),
    }
}

/// Entries are relative to the repo root, so leading `/` and `./` are noise;
/// a `..` segment would reach outside the repo and is dropped, split on `\`
/// too so a Windows-style `..\x` cannot slip through.
fn parse_covers(items: Vec<String>) -> Vec<String> {
    let mut covers: Vec<String> = Vec::new();
    for item in items {
        let mut item = item.trim();
        while let Some(rest) = item.strip_prefix("./").or_else(|| item.strip_prefix('/')) {
            item = rest;
        }
        if item.is_empty() || item.split(['/', '\\']).any(|seg| seg == "..") {
            continue;
        }
        if !covers.iter().any(|c| c == item) {
            covers.push(item.to_owned());
        }
    }
    covers
}

fn parse_agents(value: Option<Value>) -> Vec<Target> {
    let mut targets: Vec<Target> = match value {
        Some(Value::Scalar { text, plain: true }) if text == "true" => vec![Target::Agents],
        Some(Value::Scalar { text, .. }) => Target::parse(&text).into_iter().collect(),
        Some(Value::List(items)) => items.iter().filter_map(|i| Target::parse(i)).collect(),
        None => Vec::new(),
    };
    targets.sort();
    targets.dedup();
    targets
}

fn parse_value(raw: &str) -> Value {
    let (text, plain) = scalar(raw);
    if plain && text.starts_with('[') && text.ends_with(']') {
        let items = text[1..text.len() - 1]
            .split(',')
            .map(|item| unquote(item.trim()).unwrap_or(item.trim()).to_owned())
            .filter(|item| !item.is_empty())
            .collect();
        return Value::List(items);
    }
    Value::Scalar { text, plain }
}

/// Quoted text keeps everything inside the quotes, ` #` included; plain text
/// loses a trailing ` # comment`.
fn scalar(raw: &str) -> (String, bool) {
    let raw = raw.trim();
    if let Some(quote) = raw.chars().next().filter(|c| *c == '"' || *c == '\'')
        && let Some(end) = raw[1..].find(quote)
    {
        return (raw[1..1 + end].to_owned(), false);
    }
    let cut = raw
        .char_indices()
        .find(|&(i, c)| c == '#' && (i == 0 || raw[..i].ends_with(char::is_whitespace)))
        .map_or(raw.len(), |(i, _)| i);
    (raw[..cut].trim().to_owned(), true)
}

fn unquote(s: &str) -> Option<&str> {
    let quote = s.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    s.strip_prefix(quote)?.strip_suffix(quote)
}
