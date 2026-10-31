/// Hit markers passed to `snippet()`. Private-use characters survive HTML
/// escaping untouched, so they can be swapped for `<mark>` afterwards.
pub(crate) const MARK_OPEN: char = '\u{E000}';
pub(crate) const MARK_CLOSE: char = '\u{E001}';

/// Turns user input into an FTS5 query that cannot contain operators: each
/// whitespace-separated term becomes a quoted prefix phrase, and terms are
/// ANDed.
pub fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

/// Escapes the snippet text, then turns the markers into `<mark>` tags. The
/// UI relies on everything else being inert text.
pub(crate) fn render_snippet(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 16);
    for c in raw.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            MARK_OPEN => out.push_str("<mark>"),
            MARK_CLOSE => out.push_str("</mark>"),
            c => out.push(c),
        }
    }
    out
}

/// A doc that already contains the marker characters would produce stray
/// `<mark>` tags, so they are replaced before indexing.
pub(crate) fn strip_markers(text: &str) -> std::borrow::Cow<'_, str> {
    if text.contains([MARK_OPEN, MARK_CLOSE]) {
        text.replace([MARK_OPEN, MARK_CLOSE], "\u{FFFD}").into()
    } else {
        text.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_escapes_then_marks() {
        let raw = format!("<b>{MARK_OPEN}x{MARK_CLOSE}</b>");
        assert_eq!(render_snippet(&raw), "&lt;b&gt;<mark>x</mark>&lt;/b&gt;");
    }

    #[test]
    fn markers_in_text_are_neutralized() {
        let text = format!("a{MARK_OPEN}b");
        assert_eq!(strip_markers(&text), "a\u{FFFD}b");
        assert!(matches!(
            strip_markers("plain"),
            std::borrow::Cow::Borrowed(_)
        ));
    }
}
