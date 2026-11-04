//! Redaction for text that leaves the app's own memory: the log, crash
//! reports and the diagnostics file. One place, so every sink hides the same
//! things. Redacting twice gives the same output as redacting once.

use regex::{Captures, Regex};
use serde_json::Value;
use std::path::Path;
use std::sync::LazyLock;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("redaction pattern compiles")
}

static PEM: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----")
});
static USERINFO: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@:]+(?::[^\s/@]*)?@"));
static LABELLED: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r#"(?i)\b(api[ _-]?key|apikey|token|secret|password|bearer|authorization)(\s*[=:]\s*)((?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;"']+))"#,
    )
});
static ENV_LINE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?m)^([A-Z][A-Z0-9_]*)=([^\r\n]*\S[^\r\n]*)$"));
/// Provider token shapes and the tag each one is replaced with. Order
/// matters: `sk-ant-` must run before the broader `sk-`.
static TOKENS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    vec![
        ("anthropic-key", re(r"sk-ant-[A-Za-z0-9_-]{8,}")),
        ("openai-key", re(r"sk-[A-Za-z0-9_-]{16,}")),
        (
            "github-token",
            re(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
        ),
        ("gitlab-token", re(r"glpat-[A-Za-z0-9_-]{16,}")),
        ("slack-token", re(r"xox[abprs]-[A-Za-z0-9-]{10,}")),
        ("aws-access-key-id", re(r"\bAKIA[0-9A-Z]{16}\b")),
        (
            "jwt",
            re(r"eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}"),
        ),
    ]
});
/// Keys whose value is dropped whole, matched on the lowercased key.
static DROP_EXACT: &[&str] = &[
    "env",
    "environment",
    "env_vars",
    "envvars",
    "cookie",
    "set-cookie",
    "headers.authorization",
];
static DROP_FAMILY: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)token|secret|password|passwd|private[_-]?key|api[_-]?key|authorization|bearer|credential",
    )
});

fn home_regex(home: &Path) -> Option<Regex> {
    let text = home.to_string_lossy();
    let text = text.trim_end_matches(['/', '\\']);
    if text.is_empty() {
        return None;
    }
    // Either separator matches either way, so a path written with `/` on
    // Windows is still caught.
    let body: String = text
        .chars()
        .map(|c| match c {
            '/' | '\\' => r"[\\/]".to_string(),
            c => regex::escape(&c.to_string()),
        })
        .collect();
    let end = if text
        .chars()
        .last()
        .is_some_and(|c| c.is_alphanumeric() || c == '_')
    {
        r"\b"
    } else {
        ""
    };
    Regex::new(&format!(r"(?i){body}{end}")).ok()
}

/// Hides secrets and the home folder in free text.
pub(crate) fn redact_text(s: &str, home: Option<&Path>) -> String {
    let mut out = PEM.replace_all(s, "[redacted:pem]").into_owned();
    out = USERINFO
        .replace_all(&out, "${1}[redacted-credential]@")
        .into_owned();
    for (tag, regex) in TOKENS.iter() {
        out = regex
            .replace_all(&out, format!("[redacted:{tag}]").as_str())
            .into_owned();
    }
    out = LABELLED
        .replace_all(&out, |c: &Captures| {
            if c[3].starts_with("[redacted") {
                c[0].to_string()
            } else {
                format!("{}=[redacted]", &c[1])
            }
        })
        .into_owned();
    out = ENV_LINE
        .replace_all(&out, |c: &Captures| {
            if c[2].starts_with("[redacted") {
                c[0].to_string()
            } else {
                format!("{}=[redacted:env-value]", &c[1])
            }
        })
        .into_owned();
    if let Some(regex) = home.and_then(home_regex) {
        out = regex.replace_all(&out, "~").into_owned();
    }
    out
}

fn dropped(key: &str) -> bool {
    let lower = key.to_lowercase();
    DROP_EXACT.contains(&lower.as_str()) || DROP_FAMILY.is_match(&lower)
}

/// Redacts a JSON value in place. Secret-like keys are removed; every string
/// goes through `redact_text`, which also puts `~` in paths under home. Paths
/// stay readable otherwise: the person reviews the file before sharing it.
pub(crate) fn redact_value(v: &mut Value, home: Option<&Path>) {
    match v {
        Value::String(s) => *s = redact_text(s, home),
        Value::Array(items) => items.iter_mut().for_each(|i| redact_value(i, home)),
        Value::Object(map) => {
            map.retain(|k, _| !dropped(k));
            map.values_mut().for_each(|i| redact_value(i, home));
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn r(s: &str) -> String {
        redact_text(s, None)
    }

    #[test]
    fn provider_tokens_get_their_tag() {
        let cases = [
            ("sk-ant-api03-abcdefghij", "[redacted:anthropic-key]"),
            ("sk-abcdefghijklmnopqrstuv", "[redacted:openai-key]"),
            ("ghp_abcdefghijklmnopqrstuvwx", "[redacted:github-token]"),
            (
                "github_pat_abcdefghijklmnopqrstuvwx",
                "[redacted:github-token]",
            ),
            ("glpat-abcdefghijklmnopqrst", "[redacted:gitlab-token]"),
            ("xoxb-1234567890-abcdef", "[redacted:slack-token]"),
            ("AKIAABCDEFGHIJKLMNOP", "[redacted:aws-access-key-id]"),
            ("eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM", "[redacted:jwt]"),
        ];
        for (raw, tag) in cases {
            assert_eq!(
                r(&format!("key {raw} end")),
                format!("key {tag} end"),
                "{raw}"
            );
        }
    }

    #[test]
    fn pem_block_is_removed() {
        let text =
            "a\n-----BEGIN RSA PRIVATE KEY-----\nMIIB\nxyz\n-----END RSA PRIVATE KEY-----\nb";
        assert_eq!(r(text), "a\n[redacted:pem]\nb");
    }

    #[test]
    fn url_userinfo_is_removed() {
        assert_eq!(
            r("clone https://user:pw@github.com/a/b.git"),
            "clone https://[redacted-credential]@github.com/a/b.git"
        );
        assert_eq!(r("ssh://git@host/x"), "ssh://[redacted-credential]@host/x");
        assert_eq!(r("https://github.com/a@b"), "https://github.com/a@b");
    }

    #[test]
    fn labelled_pairs_keep_the_label() {
        assert_eq!(r("password=hunter2 ok"), "password=[redacted] ok");
        assert_eq!(r("API_KEY: abc123"), "API_KEY=[redacted]");
        assert_eq!(r("api key = \"a b\""), "api key=[redacted]");
        assert_eq!(
            r("Authorization: Bearer abc.def"),
            "Authorization=[redacted]"
        );
        assert_eq!(r("the token is fine"), "the token is fine");
    }

    #[test]
    fn env_lines_are_redacted() {
        assert_eq!(
            r("PATH_X=/a/b\nFOO=bar baz\nlower=keep"),
            "PATH_X=[redacted:env-value]\nFOO=[redacted:env-value]\nlower=keep"
        );
    }

    #[test]
    fn home_prefix_becomes_tilde_with_either_separator_and_case() {
        let home = Path::new(r"C:\Users\Duy");
        assert_eq!(
            redact_text(r"open C:\Users\Duy\code and c:/users/duy/x", Some(home)),
            r"open ~\code and ~/x"
        );
        // A longer name that starts the same is not the home folder.
        assert_eq!(
            redact_text(r"C:\Users\Duyen\x", Some(home)),
            r"C:\Users\Duyen\x"
        );
        assert_eq!(
            redact_text("/Users/me/a", Some(Path::new("/Users/me/"))),
            "~/a"
        );
    }

    #[test]
    fn redacting_twice_changes_nothing() {
        let home = Path::new("/home/me");
        let text = "TOKEN=abc\nhttps://u:p@h/x\nsk-ant-abcdefghijk /home/me/a\npassword: x\n\
                    -----BEGIN PRIVATE KEY-----\nzz\n-----END PRIVATE KEY-----\nghp_abcdefghijklmnopqrstuvwx";
        let once = redact_text(text, Some(home));
        assert_eq!(redact_text(&once, Some(home)), once);
    }

    #[test]
    fn value_drops_secret_keys_nested_and_in_arrays() {
        let mut v = json!({
            "name": "x",
            "env": {"A": "b"},
            "Cookie": "c",
            "apiKey": "k",
            "githubToken": "t",
            "nested": {"password": "p", "keep": 1, "list": [{"secret": "s", "ok": "yes"}]},
        });
        redact_value(&mut v, None);
        assert_eq!(
            v,
            json!({"name": "x", "nested": {"keep": 1, "list": [{"ok": "yes"}]}})
        );
    }

    #[test]
    fn value_strings_are_redacted_and_paths_keep_a_tilde_prefix() {
        let home = Path::new("/home/me");
        let mut v = json!({
            "worktreePath": "/home/me/code/app",
            "cmd": "curl https://u:p@h sk-ant-abcdefghijk",
            "n": [1, "AKIAABCDEFGHIJKLMNOP"],
        });
        redact_value(&mut v, Some(home));
        assert_eq!(v["worktreePath"], "~/code/app");
        assert_eq!(
            v["cmd"],
            "curl https://[redacted-credential]@h [redacted:anthropic-key]"
        );
        assert_eq!(v["n"][1], "[redacted:aws-access-key-id]");
        let once = v.clone();
        redact_value(&mut v, Some(home));
        assert_eq!(v, once);
    }
}
