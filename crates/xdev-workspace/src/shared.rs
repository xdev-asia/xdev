//! `[worktree] shared` of `xdev.toml`: paths of the main checkout linked into
//! each new worktree, so they share dependency folders and local files.

use serde::Serialize;

/// What linking one shared path did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Linked {
    /// The entry, as `xdev.toml` spells it after normalizing.
    pub path: String,
    pub ok: bool,
    /// Why it was not linked; `None` when `ok`.
    pub error: Option<String>,
}

/// Why a shared path is refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SharedError {
    #[error("the path is empty")]
    Empty,
    #[error("the path must be relative to the repo")]
    Absolute,
    #[error("the path has an empty segment")]
    EmptySegment,
    #[error("`.` and `..` are not allowed")]
    Dots,
    #[error(".git cannot be shared")]
    Git,
}

/// The repo-relative path an entry names, spelled with `/`. A backslash
/// counts as a separator; a trailing separator is dropped.
pub fn validate(entry: &str) -> Result<String, SharedError> {
    let text = entry.trim().replace('\\', "/");
    let text = text.strip_suffix('/').unwrap_or(&text);
    if text.is_empty() {
        return Err(SharedError::Empty);
    }
    let bytes = text.as_bytes();
    if text.starts_with('/')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    {
        return Err(SharedError::Absolute);
    }
    for segment in text.split('/') {
        match segment {
            "" => return Err(SharedError::EmptySegment),
            "." | ".." => return Err(SharedError::Dots),
            s if s.eq_ignore_ascii_case(".git") => return Err(SharedError::Git),
            _ => {}
        }
    }
    Ok(text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_relative_paths() {
        assert_eq!(validate("node_modules").unwrap(), "node_modules");
        assert_eq!(
            validate("apps/desktop/node_modules").unwrap(),
            "apps/desktop/node_modules"
        );
        assert_eq!(validate(".env.local").unwrap(), ".env.local");
        assert_eq!(validate(" target/ ").unwrap(), "target");
    }

    #[test]
    fn a_backslash_becomes_a_slash() {
        assert_eq!(
            validate("apps\\desktop\\node_modules").unwrap(),
            "apps/desktop/node_modules"
        );
    }

    #[test]
    fn refuses_what_leaves_the_repo_or_touches_git() {
        assert_eq!(validate(""), Err(SharedError::Empty));
        assert_eq!(validate("  "), Err(SharedError::Empty));
        assert_eq!(validate("/etc"), Err(SharedError::Absolute));
        assert_eq!(validate("C:\\x"), Err(SharedError::Absolute));
        assert_eq!(validate("c:x"), Err(SharedError::Absolute));
        assert_eq!(validate("\\\\server\\share"), Err(SharedError::Absolute));
        assert_eq!(validate("//server/share"), Err(SharedError::Absolute));
        assert_eq!(validate("../x"), Err(SharedError::Dots));
        assert_eq!(validate("a/../b"), Err(SharedError::Dots));
        assert_eq!(validate("."), Err(SharedError::Dots));
        assert_eq!(validate("./a"), Err(SharedError::Dots));
        assert_eq!(validate("a//b"), Err(SharedError::EmptySegment));
        assert_eq!(validate(".git"), Err(SharedError::Git));
        assert_eq!(validate("a/.git/hooks"), Err(SharedError::Git));
        assert_eq!(validate(".GIT"), Err(SharedError::Git));
    }
}
