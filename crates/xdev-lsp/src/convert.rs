//! Server answers to the app's shapes. Pure: a shape that does not parse
//! gives the empty answer, never an error.

use std::path::Path;

use serde_json::Value;
use url::Url;

use crate::docs::rel_of;
use crate::{
    CompletionItem, CompletionList, Diagnostic, FileEdit, Hover, Location, Pos, Range, Symbol,
    TextEdit, WorkspaceEdit,
};

/// The most completion items kept.
pub const MAX_COMPLETIONS: usize = 200;
/// The most workspace symbols kept.
pub const MAX_SYMBOLS: usize = 200;
/// The most diagnostics kept per file.
pub const MAX_DIAGNOSTICS: usize = 500;
/// The longest diagnostic message kept, in characters.
pub const MAX_MESSAGE: usize = 2000;

pub fn pos(v: &Value) -> Option<Pos> {
    Some(Pos {
        line: u32::try_from(v["line"].as_u64()?).ok()?,
        character: u32::try_from(v["character"].as_u64()?).ok()?,
    })
}

pub fn range(v: &Value) -> Option<Range> {
    Some(Range {
        start: pos(&v["start"])?,
        end: pos(&v["end"])?,
    })
}

fn string(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}

/// A MarkedString or MarkupContent as markdown.
fn marked(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_owned());
    }
    let value = v["value"].as_str()?;
    match (v["kind"].as_str(), v["language"].as_str()) {
        (Some("markdown"), _) => Some(value.to_owned()),
        (Some(_), _) => Some(fence("", value)),
        (None, Some(language)) => Some(fence(language, value)),
        (None, None) => Some(value.to_owned()),
    }
}

fn fence(language: &str, value: &str) -> String {
    format!("```{language}\n{value}\n```")
}

/// `textDocument/hover`: None when there is nothing to show.
pub fn hover(v: Value) -> Option<Hover> {
    let contents = &v["contents"];
    let markdown = match contents.as_array() {
        Some(parts) => parts
            .iter()
            .filter_map(marked)
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        None => marked(contents)?,
    };
    if markdown.trim().is_empty() {
        return None;
    }
    Some(Hover {
        markdown,
        range: range(&v["range"]),
    })
}

/// A snippet's plain text: placeholders keep their default, tab stops go.
fn strip_snippet(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            }
            '$' if chars.peek().is_some_and(char::is_ascii_digit) => {
                while chars.peek().is_some_and(char::is_ascii_digit) {
                    chars.next();
                }
            }
            '$' if chars.peek() == Some(&'{') => {
                chars.next();
                depth += 1;
                while chars.peek().is_some_and(char::is_ascii_digit) {
                    chars.next();
                }
                if chars.peek() == Some(&':') {
                    chars.next();
                }
            }
            '}' if depth > 0 => depth -= 1,
            _ => out.push(c),
        }
    }
    out
}

/// The range an edit replaces: a plain range, or the `replace` half of an
/// insert/replace pair.
fn edit_range(v: &Value) -> Option<Range> {
    range(v).or_else(|| range(&v["replace"]))
}

fn completion_item(v: &Value, default_range: Option<Range>) -> Option<CompletionItem> {
    let label = string(&v["label"])?;
    let snippet = v["insertTextFormat"].as_u64() == Some(2);
    let (text, range) = match v.get("textEdit").filter(|e| e.is_object()) {
        Some(edit) => (
            string(&edit["newText"]),
            range(&edit["range"]).or_else(|| edit_range(edit)),
        ),
        None => (string(&v["insertText"]), default_range),
    };
    let text = text.unwrap_or_else(|| label.clone());
    Some(CompletionItem {
        insert_text: if snippet { strip_snippet(&text) } else { text },
        kind: v["kind"].as_u64().and_then(|k| u32::try_from(k).ok()),
        detail: string(&v["detail"]),
        range,
        sort_text: string(&v["sortText"]),
        filter_text: string(&v["filterText"]),
        label,
    })
}

/// `textDocument/completion`: an item array or a CompletionList.
pub fn completion(v: Value) -> CompletionList {
    let (items, mut incomplete, default_range) = match &v {
        Value::Array(items) => (items.as_slice(), false, None),
        Value::Object(_) => (
            v["items"].as_array().map_or(&[][..], Vec::as_slice),
            v["isIncomplete"].as_bool().unwrap_or(false),
            edit_range(&v["itemDefaults"]["editRange"]),
        ),
        _ => (&[][..], false, None),
    };
    if items.len() > MAX_COMPLETIONS {
        incomplete = true;
    }
    CompletionList {
        incomplete,
        items: items
            .iter()
            .filter_map(|i| completion_item(i, default_range))
            .take(MAX_COMPLETIONS)
            .collect(),
    }
}

fn location_at(uri: &str, range: Range, worktree: &Path) -> Option<Location> {
    let url = Url::parse(uri).ok()?;
    let path = url
        .to_file_path()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|()| uri.to_owned());
    Some(Location {
        rel: rel_of(worktree, &url),
        path,
        range,
    })
}

/// A Location or a LocationLink.
fn location(v: &Value, worktree: &Path) -> Option<Location> {
    if let Some(uri) = v["targetUri"].as_str() {
        let range = range(&v["targetSelectionRange"]).or_else(|| range(&v["targetRange"]))?;
        return location_at(uri, range, worktree);
    }
    location_at(v["uri"].as_str()?, range(&v["range"])?, worktree)
}

/// `textDocument/definition`: null, one Location, or an array of Locations
/// or LocationLinks. Places outside the worktree keep `rel: None`.
pub fn locations(v: Value, worktree: &Path) -> Vec<Location> {
    match &v {
        Value::Array(all) => all.iter().filter_map(|l| location(l, worktree)).collect(),
        Value::Object(_) => location(&v, worktree).into_iter().collect(),
        _ => Vec::new(),
    }
}

fn text_edits(v: &Value) -> Vec<TextEdit> {
    v.as_array()
        .map(|all| {
            all.iter()
                .filter_map(|e| {
                    Some(TextEdit {
                        range: range(&e["range"])?,
                        new_text: string(&e["newText"])?,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `textDocument/rename`: text edits per file of the worktree. File
/// operations and files outside are counted in `skipped`.
pub fn workspace_edit(v: Value, worktree: &Path) -> WorkspaceEdit {
    let mut out = WorkspaceEdit::default();
    let add = |out: &mut WorkspaceEdit, uri: Option<&str>, edits: Vec<TextEdit>| {
        let rel = uri
            .and_then(|u| Url::parse(u).ok())
            .and_then(|u| rel_of(worktree, &u));
        let Some(rel) = rel else {
            out.skipped += 1;
            return;
        };
        if edits.is_empty() {
            return;
        }
        match out.files.iter_mut().find(|f| f.rel == rel) {
            Some(file) => file.edits.extend(edits),
            None => out.files.push(FileEdit { rel, edits }),
        }
    };
    if let Some(changes) = v["documentChanges"].as_array() {
        for change in changes {
            if change.get("kind").is_some() {
                out.skipped += 1;
                continue;
            }
            add(
                &mut out,
                change["textDocument"]["uri"].as_str(),
                text_edits(&change["edits"]),
            );
        }
    } else if let Some(changes) = v["changes"].as_object() {
        for (uri, edits) in changes {
            add(&mut out, Some(uri), text_edits(edits));
        }
    }
    out
}

/// `workspace/symbol`: SymbolInformation or WorkspaceSymbol, inside the
/// worktree only.
pub fn symbols(v: Value, worktree: &Path) -> Vec<Symbol> {
    let Some(all) = v.as_array() else {
        return Vec::new();
    };
    all.iter()
        .filter_map(|s| {
            let loc = &s["location"];
            let uri = Url::parse(loc["uri"].as_str()?).ok()?;
            Some(Symbol {
                name: string(&s["name"])?,
                kind: u32::try_from(s["kind"].as_u64()?).ok()?,
                container: string(&s["containerName"]).filter(|c| !c.is_empty()),
                rel: rel_of(worktree, &uri)?,
                // A WorkspaceSymbol may leave the range to resolve.
                range: range(&loc["range"]).unwrap_or_default(),
            })
        })
        .take(MAX_SYMBOLS)
        .collect()
}

/// `textDocument/publishDiagnostics`: the document and its diagnostics.
pub fn diagnostics(v: Value) -> Option<(Url, Vec<Diagnostic>)> {
    let uri = Url::parse(v["uri"].as_str()?).ok()?;
    let items = v["diagnostics"]
        .as_array()
        .map(|all| {
            all.iter()
                .filter_map(|d| {
                    let message = d["message"].as_str()?;
                    Some(Diagnostic {
                        range: range(&d["range"])?,
                        severity: d["severity"]
                            .as_u64()
                            .filter(|s| (1..=4).contains(s))
                            .map_or(1, |s| s as u8),
                        message: message.chars().take(MAX_MESSAGE).collect(),
                        source: string(&d["source"]),
                        code: match &d["code"] {
                            Value::String(s) => Some(s.clone()),
                            Value::Number(n) => Some(n.to_string()),
                            _ => None,
                        },
                    })
                })
                .take(MAX_DIAGNOSTICS)
                .collect()
        })
        .unwrap_or_default();
    Some((uri, items))
}

fn is_word(c: u16) -> bool {
    char::from_u32(u32::from(c)).is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// The identifier at `at` in `text`, counted in UTF-16 like the protocol.
pub fn word_range(text: &str, at: Pos) -> Option<Range> {
    let line = text.split('\n').nth(at.line as usize)?;
    let units: Vec<u16> = line.trim_end_matches('\r').encode_utf16().collect();
    let caret = (at.character as usize).min(units.len());
    let mut start = caret;
    while start > 0 && is_word(units[start - 1]) {
        start -= 1;
    }
    let mut end = caret;
    while end < units.len() && is_word(units[end]) {
        end += 1;
    }
    if start == end {
        return None;
    }
    let p = |c: usize| Pos {
        line: at.line,
        character: c as u32,
    };
    Some(Range {
        start: p(start),
        end: p(end),
    })
}

/// `textDocument/prepareRename`: a range, a range with a placeholder, or
/// `{defaultBehavior}` (the word at the caret). None when the server
/// refuses.
pub fn prepare_rename(v: Value, text: &str, at: Pos) -> Option<Range> {
    if let Some(r) = range(&v).or_else(|| range(&v["range"])) {
        return Some(r);
    }
    if v["defaultBehavior"].as_bool() == Some(true) {
        return word_range(text, at);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn r(l1: u32, c1: u32, l2: u32, c2: u32) -> Value {
        json!({"start": {"line": l1, "character": c1}, "end": {"line": l2, "character": c2}})
    }

    fn rng(l1: u32, c1: u32, l2: u32, c2: u32) -> Range {
        range(&r(l1, c1, l2, c2)).unwrap()
    }

    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\w")
        } else {
            PathBuf::from("/w")
        }
    }

    fn uri(rel: &str) -> String {
        Url::from_file_path(root().join(rel)).unwrap().to_string()
    }

    fn outside() -> String {
        let p = if cfg!(windows) {
            r"C:\lib\x.rs"
        } else {
            "/lib/x.rs"
        };
        Url::from_file_path(p).unwrap().to_string()
    }

    #[test]
    fn hover_markup_content() {
        let h = hover(
            json!({"contents": {"kind": "markdown", "value": "**x**"}, "range": r(1, 2, 1, 3)}),
        )
        .unwrap();
        assert_eq!(h.markdown, "**x**");
        assert_eq!(h.range, Some(rng(1, 2, 1, 3)));
        let plain = hover(json!({"contents": {"kind": "plaintext", "value": "a*b"}})).unwrap();
        assert_eq!(plain.markdown, "```\na*b\n```");
    }

    #[test]
    fn hover_marked_string_array() {
        let h = hover(json!({"contents": [
            {"language": "rust", "value": "fn x()"},
            "",
            "docs",
        ]}))
        .unwrap();
        assert_eq!(h.markdown, "```rust\nfn x()\n```\n\ndocs");
        assert_eq!(h.range, None);
        assert_eq!(hover(json!({"contents": []})), None);
        assert_eq!(hover(Value::Null), None);
    }

    #[test]
    fn completion_text_sources() {
        let list = completion(json!({
            "isIncomplete": false,
            "itemDefaults": {"editRange": {"insert": r(0, 0, 0, 1), "replace": r(0, 0, 0, 4)}},
            "items": [
                {"label": "a", "textEdit": {"range": r(0, 1, 0, 2), "newText": "alpha"}, "kind": 3},
                {"label": "b", "textEdit": {"insert": r(0, 0, 0, 1), "replace": r(0, 0, 0, 3), "newText": "beta"}},
                {"label": "c", "insertText": "gamma"},
                {"label": "d", "detail": "fn", "sortText": "1", "filterText": "dd"},
                {"label": "e", "insertText": "e(${1:x}, $2) {}$0", "insertTextFormat": 2},
                {"nolabel": true},
            ],
        }));
        assert!(!list.incomplete);
        let texts: Vec<_> = list
            .items
            .iter()
            .map(|i| (i.insert_text.as_str(), i.range))
            .collect();
        assert_eq!(
            texts,
            [
                ("alpha", Some(rng(0, 1, 0, 2))),
                ("beta", Some(rng(0, 0, 0, 3))),
                ("gamma", Some(rng(0, 0, 0, 4))),
                ("d", Some(rng(0, 0, 0, 4))),
                ("e(x, ) {}", Some(rng(0, 0, 0, 4))),
            ]
        );
        assert_eq!(list.items[0].kind, Some(3));
        assert_eq!(list.items[3].detail.as_deref(), Some("fn"));
        assert_eq!(list.items[3].filter_text.as_deref(), Some("dd"));
    }

    #[test]
    fn completion_caps_and_arrays() {
        let many: Vec<_> = (0..250)
            .map(|i| json!({"label": format!("x{i}")}))
            .collect();
        let list = completion(Value::Array(many));
        assert!(list.incomplete);
        assert_eq!(list.items.len(), MAX_COMPLETIONS);
        assert_eq!(list.items[0].range, None);
        assert_eq!(completion(Value::Null), CompletionList::default());
    }

    #[test]
    fn locations_and_links() {
        let w = root();
        let one = locations(json!({"uri": uri("src/a.rs"), "range": r(1, 0, 1, 4)}), &w);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].rel.as_deref(), Some("src/a.rs"));
        assert_eq!(
            one[0].path,
            root().join("src").join("a.rs").display().to_string()
        );
        let links = locations(
            json!([
                {"targetUri": uri("b.ts"), "targetRange": r(0, 0, 9, 0), "targetSelectionRange": r(2, 4, 2, 8)},
                {"targetUri": outside(), "targetRange": r(3, 0, 3, 1)},
            ]),
            &w,
        );
        assert_eq!(links[0].rel.as_deref(), Some("b.ts"));
        assert_eq!(links[0].range, rng(2, 4, 2, 8));
        assert_eq!(links[1].rel, None);
        assert_eq!(links[1].range, rng(3, 0, 3, 1));
        assert!(locations(Value::Null, &w).is_empty());
    }

    #[test]
    fn workspace_edit_changes() {
        let w = root();
        let mut changes = serde_json::Map::new();
        changes.insert(
            uri("a.ts"),
            json!([{"range": r(0, 0, 0, 1), "newText": "y"}]),
        );
        changes.insert(outside(), json!([{"range": r(0, 0, 0, 1), "newText": "y"}]));
        let e = workspace_edit(json!({"changes": changes}), &w);
        assert_eq!(e.skipped, 1);
        assert_eq!(e.files.len(), 1);
        assert_eq!(e.files[0].rel, "a.ts");
        assert_eq!(e.files[0].edits[0].new_text, "y");
    }

    #[test]
    fn workspace_edit_document_changes_skip_resource_ops() {
        let w = root();
        let e = workspace_edit(
            json!({"documentChanges": [
                {"textDocument": {"uri": uri("a.rs"), "version": 1}, "edits": [{"range": r(0, 0, 0, 1), "newText": "b"}]},
                {"kind": "rename", "oldUri": uri("a.rs"), "newUri": uri("b.rs")},
                {"textDocument": {"uri": uri("a.rs"), "version": 1}, "edits": [{"range": r(2, 0, 2, 1), "newText": "b"}]},
                {"textDocument": {"uri": outside(), "version": null}, "edits": []},
            ]}),
            &w,
        );
        assert_eq!(e.skipped, 2);
        assert_eq!(e.files.len(), 1);
        assert_eq!(e.files[0].edits.len(), 2);
        assert_eq!(workspace_edit(Value::Null, &w), WorkspaceEdit::default());
    }

    #[test]
    fn symbols_drop_outside_and_cap() {
        let w = root();
        let s = symbols(
            json!([
                {"name": "Foo", "kind": 5, "containerName": "mod", "location": {"uri": uri("a.ts"), "range": r(1, 0, 1, 3)}},
                {"name": "Bar", "kind": 12, "location": {"uri": uri("b.ts")}},
                {"name": "Ext", "kind": 12, "location": {"uri": outside(), "range": r(0, 0, 0, 1)}},
            ]),
            &w,
        );
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].container.as_deref(), Some("mod"));
        assert_eq!(s[1].rel, "b.ts");
        assert_eq!(s[1].range, Range::default());
        let many: Vec<_> = (0..300)
            .map(|i| json!({"name": format!("s{i}"), "kind": 1, "location": {"uri": uri("a.ts"), "range": r(0, 0, 0, 1)}}))
            .collect();
        assert_eq!(symbols(Value::Array(many), &w).len(), MAX_SYMBOLS);
    }

    #[test]
    fn diagnostics_cap_and_codes() {
        let long = "x".repeat(MAX_MESSAGE + 10);
        let (u, items) = diagnostics(json!({
            "uri": uri("a.rs"),
            "diagnostics": [
                {"range": r(0, 0, 0, 1), "message": long, "severity": 2, "code": 1002, "source": "ts"},
                {"range": r(1, 0, 1, 1), "message": "m", "code": "E01"},
                {"message": "no range"},
            ],
        }))
        .unwrap();
        assert_eq!(u.as_str(), uri("a.rs"));
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].message.chars().count(), MAX_MESSAGE);
        assert_eq!(items[0].severity, 2);
        assert_eq!(items[0].code.as_deref(), Some("1002"));
        assert_eq!(items[1].severity, 1);
        assert_eq!(items[1].code.as_deref(), Some("E01"));
        let many: Vec<_> = (0..600)
            .map(|_| json!({"range": r(0, 0, 0, 1), "message": "m"}))
            .collect();
        let (_, items) = diagnostics(json!({"uri": uri("a.rs"), "diagnostics": many})).unwrap();
        assert_eq!(items.len(), MAX_DIAGNOSTICS);
        assert_eq!(diagnostics(json!({})), None);
    }

    #[test]
    fn prepare_rename_shapes() {
        let text = "let fooBar = 1;\nconst 😀x = 2;";
        let at = Pos {
            line: 0,
            character: 6,
        };
        assert_eq!(
            prepare_rename(r(0, 4, 0, 10), text, at),
            Some(rng(0, 4, 0, 10))
        );
        assert_eq!(
            prepare_rename(
                json!({"range": r(0, 4, 0, 10), "placeholder": "fooBar"}),
                text,
                at
            ),
            Some(rng(0, 4, 0, 10))
        );
        assert_eq!(
            prepare_rename(json!({"defaultBehavior": true}), text, at),
            Some(rng(0, 4, 0, 10))
        );
        assert_eq!(prepare_rename(Value::Null, text, at), None);
        // The emoji is two UTF-16 units; `x` starts at 8.
        assert_eq!(
            word_range(
                text,
                Pos {
                    line: 1,
                    character: 9
                }
            ),
            Some(rng(1, 8, 1, 9))
        );
        assert_eq!(
            word_range(
                text,
                Pos {
                    line: 0,
                    character: 3
                }
            ),
            Some(rng(0, 0, 0, 3))
        );
        assert_eq!(
            word_range(
                text,
                Pos {
                    line: 0,
                    character: 11
                }
            ),
            None
        );
        assert_eq!(
            word_range(
                text,
                Pos {
                    line: 5,
                    character: 0
                }
            ),
            None
        );
    }
}
