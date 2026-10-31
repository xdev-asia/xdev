/// Hit markers passed to `snippet()`. Private-use characters survive HTML
/// escaping untouched, so they can be swapped for `<mark>` afterwards.
pub(crate) const MARK_OPEN: char = '\u{E000}';
pub(crate) const MARK_CLOSE: char = '\u{E001}';

/// Turns user input into an FTS5 query that cannot contain operators: each
/// whitespace-separated term becomes a quoted prefix phrase, and terms are
/// ANDed.
pub fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = fold(input)
        .split_whitespace()
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

/// `remove_diacritics` strips combining marks, but `đ` is a letter of its own
/// with no decomposition, so "duong" would miss "đường". Swapping one char for
/// one char keeps positions aligned with the original for `restore_snippet`.
pub(crate) fn fold(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'đ' => 'd',
            'Đ' => 'D',
            c => c,
        })
        .collect()
}

/// `snippet()` runs on the folded column; this puts the doc's own letters
/// back. The ellipses are added here because only here is the window's
/// position in the full text known.
pub(crate) fn restore_snippet(snippet: &str, folded: &str, raw: &str) -> String {
    let plain: String = snippet
        .chars()
        .filter(|&c| c != MARK_OPEN && c != MARK_CLOSE)
        .collect();
    let Some(byte_start) = folded.find(&plain) else {
        return snippet.to_owned();
    };
    let start = folded[..byte_start].chars().count();
    let end = start + plain.chars().count();
    let mut original = raw.chars().skip(start);
    let mut out = String::with_capacity(snippet.len() + 8);
    if start > 0 {
        out.push('…');
    }
    for c in snippet.chars() {
        if c == MARK_OPEN || c == MARK_CLOSE {
            out.push(c);
        } else {
            out.push(original.next().unwrap_or(c));
        }
    }
    if end < raw.chars().count() {
        out.push('…');
    }
    out
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
