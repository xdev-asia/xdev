//! Remote paths: the `ssh://<host id><abs path>` worktree string the UI
//! passes, POSIX shell quoting, and joining a worktree-relative path onto a
//! remote root without leaving it. Also the error every remote call returns.

use std::fmt;

/// A folder or file on a saved host. `path` is absolute, with `/`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RemoteRef {
    pub host_id: String,
    pub path: String,
}

impl RemoteRef {
    /// `ssh://<host_id><abs path>`; `None` for anything else, a host id
    /// outside `[A-Za-z0-9_-]+`, a relative path or one with NUL.
    pub fn parse(s: &str) -> Option<RemoteRef> {
        let rest = s.strip_prefix("ssh://")?;
        let at = rest.find('/')?;
        let (host_id, path) = rest.split_at(at);
        if !valid_host_id(host_id) || path.contains('\0') {
            return None;
        }
        Some(RemoteRef {
            host_id: host_id.to_owned(),
            path: path.to_owned(),
        })
    }
}

impl fmt::Display for RemoteRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ssh://{}{}", self.host_id, self.path)
    }
}

/// `[A-Za-z0-9_-]+`: what a host id in a remote worktree string may be.
pub fn valid_host_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `s` as one POSIX shell word: single quotes, each `'` as `'\''`.
pub fn sh_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// `root` + `rel`, for a `rel` that names something inside `root`: not
/// empty, not absolute, no `..`, no `.git` (any case), no NUL and no `\`.
/// `.` segments and empty ones (`a//b`) are dropped.
pub fn join_rel(root: &str, rel: &str) -> Result<String, RemoteError> {
    let bad = || RemoteError::BadPath(rel.to_owned());
    if rel.starts_with('/') || rel.contains('\0') || rel.contains('\\') {
        return Err(bad());
    }
    let mut parts = Vec::new();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => return Err(bad()),
            // Like a local path: git's own folder is not edited from here.
            s if s.eq_ignore_ascii_case(".git") => return Err(bad()),
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        return Err(bad());
    }
    let root = root.trim_end_matches('/');
    Ok(format!("{root}/{}", parts.join("/")))
}

/// The folder above an absolute path; `None` for `/`.
pub fn parent_of(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    match trimmed.rfind('/') {
        Some(0) => Some("/".to_owned()),
        Some(at) => Some(trimmed[..at].to_owned()),
        None => None,
    }
}

/// What a remote read, write or command fails with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RemoteError {
    #[error("not_found")]
    NotFound,
    #[error("denied")]
    Denied,
    #[error("too_large")]
    TooLarge,
    /// A path that is not inside the root, or names the wrong kind of item.
    #[error("bad_path: {0}")]
    BadPath(String),
    #[error("exists")]
    Exists,
    /// git is not installed on the host.
    #[error("no_git")]
    NoGit,
    /// The `ssh` process ended: the host dropped or the link is gone.
    #[error("closed")]
    Closed,
    #[error("timeout")]
    Timeout,
    #[error("io: {0}")]
    Io(String),
    /// The other side sent something this client does not read.
    #[error("protocol: {0}")]
    Protocol(String),
}

impl RemoteError {
    /// The UI error code (`ERROR_CODES` in `api.ts`).
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "remote_path",
            Self::Denied => "remote_denied",
            Self::TooLarge => "remote_too_large",
            Self::BadPath(_) => "bad_path",
            Self::Exists => "exists",
            Self::NoGit => "remote_no_git",
            Self::Closed | Self::Timeout => "remote_offline",
            Self::Io(_) | Self::Protocol(_) => "io",
        }
    }
}

impl From<std::io::Error> for RemoteError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof => Self::Closed,
            _ => Self::Io(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_format_round_trip() {
        for s in [
            "ssh://devbox/home/dev/app",
            "ssh://h_1-x/",
            "ssh://a/x y/'z'",
        ] {
            let r = RemoteRef::parse(s).unwrap();
            assert_eq!(r.to_string(), s);
        }
        let r = RemoteRef::parse("ssh://devbox/home/dev").unwrap();
        assert_eq!(r.host_id, "devbox");
        assert_eq!(r.path, "/home/dev");
    }

    #[test]
    fn parse_rejects_others() {
        for s in [
            "/home/dev",
            "ssh://",
            "ssh://devbox",
            "ssh:///home",
            "ssh://dev.box/x",
            "ssh://dev box/x",
            "ssh://a/x\0y",
            "sftp://a/x",
        ] {
            assert_eq!(RemoteRef::parse(s), None, "{s:?}");
        }
    }

    #[test]
    fn join_rel_rejects_escapes() {
        for rel in ["..", "a/../b", "/x", "a\0b", "a\\b", "", ".", "./"] {
            assert!(
                matches!(join_rel("/r", rel), Err(RemoteError::BadPath(_))),
                "{rel:?}"
            );
        }
    }

    #[test]
    fn join_rel_refuses_git() {
        for rel in [".git", ".git/config", "a/.GIT/hooks/x", "./.Git", "a//.git"] {
            assert!(
                matches!(join_rel("/r", rel), Err(RemoteError::BadPath(_))),
                "{rel:?}"
            );
        }
        assert_eq!(join_rel("/r", ".github/x").unwrap(), "/r/.github/x");
        assert_eq!(join_rel("/r", "a.git").unwrap(), "/r/a.git");
    }

    #[test]
    fn join_rel_normalises() {
        assert_eq!(join_rel("/r", "a/b.txt").unwrap(), "/r/a/b.txt");
        assert_eq!(join_rel("/r/", "./a//./b").unwrap(), "/r/a/b");
        assert_eq!(join_rel("/", "a").unwrap(), "/a");
        assert_eq!(join_rel("/r", "..a/b..").unwrap(), "/r/..a/b..");
    }

    #[test]
    fn sh_quote_cases() {
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("$x"), "'$x'");
        assert_eq!(sh_quote("`id`"), "'`id`'");
        assert_eq!(sh_quote("a\nb"), "'a\nb'");
        assert_eq!(sh_quote("''"), r"''\'''\'''");
    }

    #[test]
    fn parent_of_paths() {
        assert_eq!(parent_of("/"), None);
        assert_eq!(parent_of("/home"), Some("/".into()));
        assert_eq!(parent_of("/home/dev/"), Some("/home".into()));
    }
}
