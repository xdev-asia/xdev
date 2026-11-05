//! The extra agent arguments an automation may carry: a small allowlist, checked here and
//! again by the backend before a launch.

use serde::{Deserialize, Serialize};
use xdev_agent::Cli;

pub const EXTRA_ARGS_MAX_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum ExtraArgsError {
    TooLarge,
    ControlCharacters,
    ShellSyntax { text: String },
    Terminator,
    NotAnOption { token: String },
    OptionNotAllowed { option: String },
    MissingValue { option: String },
    ValueNotAllowed { option: String, value: String },
    ModelRepeated,
    EffortRepeated,
    Unsupported,
    RequireFreshSession,
}

/// Characters that mean something to a shell; the text is never run by one, but a person who
/// writes them expects it, so they are refused instead of passed on as literals.
const SHELL_SYNTAX: &[char] = &[
    '|', '&', ';', '<', '>', '`', '$', '(', ')', '{', '}', '[', ']', '\\', '!', '*', '?', '#',
    '\'', '"', '~', '^',
];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORT: &str = "model_reasoning_effort=";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Model,
    Effort,
    Dir,
    Config,
}

fn kind_of(cli: Cli, option: &str) -> Option<Kind> {
    match (cli, option) {
        (Cli::Claude, "--model") | (Cli::Codex, "-m" | "--model") => Some(Kind::Model),
        (Cli::Claude, "--effort") => Some(Kind::Effort),
        (Cli::Claude, "--add-dir") => Some(Kind::Dir),
        (Cli::Codex, "-c" | "--config") => Some(Kind::Config),
        _ => None,
    }
}

fn plain_word(v: &str) -> bool {
    let mut chars = v.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || "._:/@+-".contains(c))
}

/// The argv to append for `cli`, or why the text is refused. `None` is a custom shell profile.
pub fn parse_extra_args(cli: Option<Cli>, text: &str) -> Result<Vec<String>, ExtraArgsError> {
    use ExtraArgsError as E;
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let cli = match cli {
        Some(c @ (Cli::Claude | Cli::Codex)) => c,
        _ => return Err(E::Unsupported),
    };
    if text.len() > EXTRA_ARGS_MAX_BYTES {
        return Err(E::TooLarge);
    }
    if text.chars().any(char::is_control) {
        return Err(E::ControlCharacters);
    }
    if let Some(c) = text.chars().find(|c| SHELL_SYNTAX.contains(c)) {
        return Err(E::ShellSyntax {
            text: c.to_string(),
        });
    }
    let mut tokens = text.split_whitespace().peekable();
    let mut out = Vec::new();
    let (mut model, mut effort) = (false, false);
    while let Some(token) = tokens.next() {
        if token == "--" {
            return Err(E::Terminator);
        }
        if !token.starts_with('-') {
            return Err(E::NotAnOption {
                token: token.into(),
            });
        }
        let (option, inline) = match token.split_once('=') {
            Some((o, v)) if o.starts_with("--") => (o, Some(v)),
            _ => (token, None),
        };
        let kind = kind_of(cli, option).ok_or_else(|| E::OptionNotAllowed {
            option: option.into(),
        })?;
        let missing = || E::MissingValue {
            option: option.into(),
        };
        let value = match inline {
            Some("") => return Err(missing()),
            Some(v) => v,
            None => match tokens.peek() {
                Some(v) if !v.starts_with('-') => tokens.next().unwrap_or_default(),
                _ => return Err(missing()),
            },
        };
        let refuse = || E::ValueNotAllowed {
            option: option.into(),
            value: value.into(),
        };
        match kind {
            Kind::Model => {
                if std::mem::replace(&mut model, true) {
                    return Err(E::ModelRepeated);
                }
                if !plain_word(value) {
                    return Err(refuse());
                }
            }
            Kind::Effort => {
                if std::mem::replace(&mut effort, true) {
                    return Err(E::EffortRepeated);
                }
                if !EFFORTS.contains(&value) {
                    return Err(refuse());
                }
            }
            Kind::Config => {
                value
                    .strip_prefix(CODEX_EFFORT)
                    .filter(|l| plain_word(l))
                    .ok_or_else(refuse)?;
                if std::mem::replace(&mut effort, true) {
                    return Err(E::EffortRepeated);
                }
            }
            Kind::Dir => {}
        }
        out.push(option.to_string());
        out.push(value.to_string());
    }
    Ok(out)
}
