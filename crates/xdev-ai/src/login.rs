//! Reading what an agent CLI's login prints: the sign-in page to open and,
//! for a device flow, the one-time code to type there. Pure text work; the
//! caller owns the process.

/// What one line of login output carries.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoginHint {
    pub url: Option<String>,
    pub code: Option<String>,
}

impl LoginHint {
    /// Keeps the first url and the first code seen.
    pub fn merge(&mut self, other: LoginHint) {
        if self.url.is_none() {
            self.url = other.url;
        }
        if self.code.is_none() {
            self.code = other.code;
        }
    }
}

/// Removes terminal escapes: CSI sequences (colours) and OSC ones (links,
/// titles), keeping the visible text.
pub fn strip_escapes(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// A sign-in page, not the CLI's own loopback listener.
fn sign_in_url(word: &str) -> Option<String> {
    let start = word.find("https://").or_else(|| word.find("http://"))?;
    let url = word[start..].trim_end_matches(['.', ',', ')', ']', '>', '"', '\'', ';']);
    let rest = url.split_once("://")?.1;
    let host = rest.split(['/', '?', '#', ':']).next().unwrap_or("");
    let local = matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "0.0.0.0");
    (!host.is_empty() && !local).then(|| url.to_owned())
}

/// `ABCD-1234`: two runs of 4 to 8 capitals or digits around a dash, with at
/// least one letter so a date or a phone number is not taken for a code.
fn device_code(word: &str) -> Option<String> {
    let word = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-');
    let (left, right) = word.split_once('-')?;
    let run = |s: &str| {
        (4..=8).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    };
    (run(left) && run(right) && word.bytes().any(|b| b.is_ascii_uppercase()))
        .then(|| word.to_owned())
}

/// The url and device code on one output line, if any. A code counts when it
/// is alone on its line or the line mentions a code.
pub fn scan_line(line: &str) -> LoginHint {
    let text = strip_escapes(line);
    let text = text.trim();
    let mut hint = LoginHint::default();
    let mut words = text.split_whitespace();
    let alone = words.clone().count() == 1;
    let mentions_code = text.to_ascii_lowercase().contains("code");
    for word in words.by_ref() {
        if hint.url.is_none() {
            hint.url = sign_in_url(word);
        }
        if hint.code.is_none() && (alone || mentions_code) && !word.contains("://") {
            hint.code = device_code(word);
        }
    }
    hint
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(line: &str) -> Option<String> {
        scan_line(line).url
    }
    fn code(line: &str) -> Option<String> {
        scan_line(line).code
    }

    #[test]
    fn finds_the_sign_in_url() {
        assert_eq!(
            url(
                "If your browser did not open, visit: https://claude.ai/oauth/authorize?code=true&client_id=abc&state=x1"
            ),
            Some("https://claude.ai/oauth/authorize?code=true&client_id=abc&state=x1".into())
        );
        assert_eq!(
            url("  Open https://auth.openai.com/codex/device."),
            Some("https://auth.openai.com/codex/device".into())
        );
        assert_eq!(
            url("\u{1b}[94mhttps://example.com/login\u{1b}[0m"),
            Some("https://example.com/login".into())
        );
        assert_eq!(
            url("\u{1b}]8;;https://example.com/a\u{7}sign in\u{1b}]8;;\u{7}"),
            None,
            "only visible text counts"
        );
    }

    #[test]
    fn ignores_the_loopback_listener_and_plain_text() {
        assert_eq!(
            url("Starting local login server on http://localhost:1455."),
            None
        );
        assert_eq!(url("callback at http://127.0.0.1:5000/cb"), None);
        assert_eq!(url("Waiting for the browser..."), None);
        assert_eq!(url(""), None);
    }

    #[test]
    fn finds_a_device_code() {
        assert_eq!(code("ABCD-12345"), Some("ABCD-12345".into()));
        assert_eq!(code("   K7QX-9P2M   "), Some("K7QX-9P2M".into()));
        assert_eq!(
            code("Enter this one-time code: WDJB-MJHT"),
            Some("WDJB-MJHT".into())
        );
        assert_eq!(
            code("\u{1b}[1mWDJB-MJHT\u{1b}[0m"),
            Some("WDJB-MJHT".into())
        );
    }

    #[test]
    fn does_not_mistake_other_words_for_a_code() {
        assert_eq!(code("Opening the browser to sign in"), None);
        assert_eq!(code("2026-1234"), None, "digits only");
        assert_eq!(
            code("see ABCD-12345 for details"),
            None,
            "not alone, no code word"
        );
        assert_eq!(code("a-b"), None);
        assert_eq!(code("lowercase-letters"), None);
    }

    #[test]
    fn merge_keeps_the_first_of_each() {
        let mut hint = LoginHint::default();
        hint.merge(scan_line("Go to https://a.example/x"));
        hint.merge(scan_line("ABCD-1234"));
        hint.merge(scan_line("https://b.example/y"));
        hint.merge(scan_line("ZZZZ-9999"));
        assert_eq!(hint.url.as_deref(), Some("https://a.example/x"));
        assert_eq!(hint.code.as_deref(), Some("ABCD-1234"));
    }
}
