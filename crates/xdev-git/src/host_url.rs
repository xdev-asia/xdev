//! Web URLs of a commit or file on GitHub, GitLab or Bitbucket.

use std::time::{Duration, Instant};

use crate::remote::plain_remote;
use crate::{GitError, Repo, run};

/// The whole `file_host_target` lookup must not hang the menu.
const TARGET_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKind {
    Github,
    Gitlab,
    Bitbucket,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostRepo {
    pub kind: HostKind,
    /// `https://host/owner/repo`.
    pub base: String,
}

fn kind_of(host: &str) -> Option<(HostKind, &'static str)> {
    match host {
        "github.com" | "ssh.github.com" => Some((HostKind::Github, "github.com")),
        "gitlab.com" | "altssh.gitlab.com" => Some((HostKind::Gitlab, "gitlab.com")),
        "bitbucket.org" | "ssh.bitbucket.org" => Some((HostKind::Bitbucket, "bitbucket.org")),
        _ => None,
    }
}

/// The hosted repository a remote URL names; `None` for any other host or
/// a URL with fewer than two path segments.
pub fn parse_host_remote(url: &str) -> Option<HostRepo> {
    let url = url.trim();
    let url = url.strip_prefix("git+").unwrap_or(url);
    let (host, path) = split_remote(url)?;
    let (kind, host) = kind_of(&host.to_ascii_lowercase())?;
    let path = path.split(['?', '#']).next().unwrap_or("");
    let mut segments: Vec<String> = Vec::new();
    for raw in path.split('/').filter(|s| !s.is_empty()) {
        segments.push(decode(raw)?);
    }
    let last = segments.last_mut()?;
    if let Some(stem) = last.strip_suffix(".git") {
        *last = stem.to_owned();
    }
    if segments.len() < 2
        || segments
            .iter()
            .any(|s| s.is_empty() || s == "." || s == ".." || s.contains('/'))
    {
        return None;
    }
    let encoded: Vec<String> = segments.iter().map(|s| encode(s)).collect();
    Some(HostRepo {
        kind,
        base: format!("https://{host}/{}", encoded.join("/")),
    })
}

/// Splits a remote URL into its host and the path after it.
fn split_remote(url: &str) -> Option<(&str, &str)> {
    if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(
            scheme.to_ascii_lowercase().as_str(),
            "git" | "http" | "https" | "ssh"
        ) {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        let host = host_port.split(':').next()?;
        return Some((host, path));
    }
    // `github:o/r` and the like.
    for (alias, host) in [
        ("github:", "github.com"),
        ("gitlab:", "gitlab.com"),
        ("bitbucket:", "bitbucket.org"),
    ] {
        if let Some(path) = url.strip_prefix(alias) {
            return Some((host, path));
        }
    }
    // scp style: `[user@]host:path`, with no `/` before the colon.
    let (left, path) = url.split_once(':')?;
    if left.contains('/') {
        return None;
    }
    let host = left.rsplit_once('@').map_or(left, |(_, h)| h);
    Some((host, path))
}

fn decode(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = segment.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn encode(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for b in segment.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Encodes each `/`-separated part; the slashes stay.
fn encode_path(path: &str) -> String {
    path.split('/').map(encode).collect::<Vec<_>>().join("/")
}

pub fn commit_url(host: &HostRepo, id: &str) -> String {
    let id = encode(id);
    match host.kind {
        HostKind::Github => format!("{}/commit/{id}", host.base),
        HostKind::Gitlab => format!("{}/-/commit/{id}", host.base),
        HostKind::Bitbucket => format!("{}/commits/{id}", host.base),
    }
}

pub fn file_url(
    host: &HostRepo,
    git_ref: &str,
    path: &str,
    line: Option<u32>,
    end: Option<u32>,
) -> String {
    let git_ref = encode_path(git_ref);
    let file = encode_path(path);
    let line = line.filter(|n| *n > 0);
    // The end line only counts when it lies after the start.
    let end = line.and_then(|a| end.filter(|b| *b > a));
    let (route, fragment) = match host.kind {
        HostKind::Github => (
            "blob",
            line.map(|a| match end {
                Some(b) => format!("#L{a}-L{b}"),
                None => format!("#L{a}"),
            }),
        ),
        HostKind::Gitlab => (
            "-/blob",
            line.map(|a| match end {
                Some(b) => format!("#L{a}-{b}"),
                None => format!("#L{a}"),
            }),
        ),
        HostKind::Bitbucket => (
            "src",
            line.map(|a| {
                let name = file.rsplit('/').next().unwrap_or(&file);
                match end {
                    Some(b) => format!("#{name}-{a}:{b}"),
                    None => format!("#{name}-{a}"),
                }
            }),
        ),
    };
    format!(
        "{}/{route}/{git_ref}/{file}{}",
        host.base,
        fragment.unwrap_or_default()
    )
}

impl Repo {
    /// The hosted repository behind the `origin` remote.
    pub fn origin_host(&self) -> Result<Option<HostRepo>, GitError> {
        self.remote_host("origin")
    }

    fn remote_host(&self, remote: &str) -> Result<Option<HostRepo>, GitError> {
        let remote = plain_remote(remote.to_owned())?;
        let (status, out) =
            run::run_status(&self.workdir, &["remote", "get-url", "--", &remote], None)?;
        if status != Some(0) {
            return Ok(None);
        }
        Ok(parse_host_remote(&String::from_utf8_lossy(&out)))
    }

    /// The hosted repository and the ref a file link should use: the `HEAD`
    /// id when a hosted remote has it, else the upstream branch, else the
    /// remote's default branch, else `main` or `master`.
    pub fn file_host_target(&self) -> Result<Option<(HostRepo, String)>, GitError> {
        let deadline = Instant::now() + TARGET_DEADLINE;
        let step = || {
            if Instant::now() >= deadline {
                Err(GitError::Timeout)
            } else {
                Ok(())
            }
        };
        let upstream = self.upstream()?;
        let mut order: Vec<String> = Vec::new();
        if let Some(up) = &upstream {
            order.push(up.remote.clone());
        }
        let names = self.remote_names()?;
        if names.iter().any(|n| n == "origin") && !order.iter().any(|n| n == "origin") {
            order.push("origin".to_owned());
        }
        for name in names {
            if !order.contains(&name) {
                order.push(name);
            }
        }
        let mut hosted: Vec<(String, HostRepo)> = Vec::new();
        for name in order {
            step()?;
            if let Some(host) = self.remote_host(&name)? {
                hosted.push((name, host));
            }
        }
        let Some((first_remote, first_host)) = hosted.first().cloned() else {
            return Ok(None);
        };

        step()?;
        if let Some(head) = self.head()? {
            for (name, host) in &hosted {
                step()?;
                let pattern = format!("refs/remotes/{name}/");
                let out = run::run(
                    &self.workdir,
                    &[
                        "for-each-ref",
                        "--count=1",
                        "--format=%(refname)",
                        "--contains",
                        &head,
                        &pattern,
                    ],
                    None,
                )?;
                if !out.iter().all(u8::is_ascii_whitespace) {
                    return Ok(Some((host.clone(), head)));
                }
            }
        }

        if let Some(up) = &upstream
            && let Some((_, host)) = hosted.iter().find(|(n, _)| *n == up.remote)
        {
            return Ok(Some((host.clone(), up.branch.clone())));
        }

        // The default branch of the remote a link would point at.
        let (name, host) = (first_remote, first_host);
        step()?;
        let symbolic = format!("refs/remotes/{name}/HEAD");
        let (status, out) = run::run_status(
            &self.workdir,
            &["symbolic-ref", "--quiet", "--short", &symbolic],
            None,
        )?;
        if status == Some(0) {
            let full = String::from_utf8_lossy(&out).trim().to_owned();
            if let Some(branch) = full.strip_prefix(&format!("{name}/"))
                && !branch.is_empty()
            {
                return Ok(Some((host, branch.to_owned())));
            }
        }
        for branch in ["main", "master"] {
            step()?;
            let rev = format!("refs/remotes/{name}/{branch}");
            let (status, _) = run::run_status(
                &self.workdir,
                &["rev-parse", "--verify", "--quiet", &rev],
                None,
            )?;
            if status == Some(0) {
                return Ok(Some((host, branch.to_owned())));
            }
        }
        Ok(Some((host, "main".to_owned())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(url: &str) -> Option<String> {
        parse_host_remote(url).map(|h| h.base)
    }

    #[test]
    fn parses_every_accepted_shape() {
        let gh = Some("https://github.com/o/r".to_owned());
        for url in [
            "git@github.com:o/r.git",
            "github.com:o/r",
            "ssh://git@github.com/o/r.git",
            "ssh://git@ssh.github.com:443/o/r.git",
            "https://github.com/o/r",
            "https://user@github.com/o/r.git/",
            "https://user:token@github.com:8443/o/r.git",
            "git+https://github.com/o/r.git",
            "git://github.com/o/r.git",
            "github:o/r",
            "HTTPS://GitHub.com/o/r",
        ] {
            assert_eq!(base(url), gh, "{url}");
        }
    }

    #[test]
    fn folds_aliases_and_keeps_subgroups() {
        assert_eq!(
            base("git@altssh.gitlab.com:g/sub/deep/r.git").as_deref(),
            Some("https://gitlab.com/g/sub/deep/r")
        );
        assert_eq!(
            base("ssh://git@ssh.bitbucket.org/w/r.git").as_deref(),
            Some("https://bitbucket.org/w/r")
        );
        assert_eq!(
            base("bitbucket:w/r").as_deref(),
            Some("https://bitbucket.org/w/r")
        );
        assert_eq!(
            parse_host_remote("gitlab:g/r").map(|h| h.kind),
            Some(HostKind::Gitlab)
        );
    }

    #[test]
    fn refuses_other_hosts_and_short_paths() {
        for url in [
            "git@example.com:o/r.git",
            "https://dev.azure.com/o/p/_git/r",
            "https://github.com/onlyone",
            "https://github.com/",
            "git@github.com:r.git",
            "github:o",
            "ftp://github.com/o/r",
            "/srv/git/o/r.git",
            "../relative/r",
            "https://github.com/o/../r",
            "https://github.com/o/%2e%2e",
            "",
        ] {
            assert_eq!(base(url), None, "{url:?}");
        }
    }

    #[test]
    fn segments_are_decoded_then_encoded_again() {
        assert_eq!(
            base("https://github.com/o%20x/r%2Fy.git").as_deref(),
            None,
            "a decoded slash would add a segment"
        );
        assert_eq!(
            base("https://github.com/o%20x/r y.git").as_deref(),
            Some("https://github.com/o%20x/r%20y")
        );
        assert_eq!(
            base("https://github.com/tài/liệu").as_deref(),
            Some("https://github.com/t%C3%A0i/li%E1%BB%87u")
        );
        assert_eq!(base("https://github.com/o/%zz"), None);
    }

    #[test]
    fn query_and_fragment_are_dropped() {
        assert_eq!(
            base("https://github.com/o/r.git?x=1#y").as_deref(),
            Some("https://github.com/o/r")
        );
    }

    fn host(kind: HostKind) -> HostRepo {
        let base = match kind {
            HostKind::Github => "https://github.com/o/r",
            HostKind::Gitlab => "https://gitlab.com/g/s/r",
            HostKind::Bitbucket => "https://bitbucket.org/w/r",
        };
        HostRepo {
            kind,
            base: base.to_owned(),
        }
    }

    #[test]
    fn commit_urls_per_host() {
        assert_eq!(
            commit_url(&host(HostKind::Github), "abc123"),
            "https://github.com/o/r/commit/abc123"
        );
        assert_eq!(
            commit_url(&host(HostKind::Gitlab), "abc123"),
            "https://gitlab.com/g/s/r/-/commit/abc123"
        );
        assert_eq!(
            commit_url(&host(HostKind::Bitbucket), "abc123"),
            "https://bitbucket.org/w/r/commits/abc123"
        );
    }

    #[test]
    fn file_urls_and_line_rules_per_host() {
        let gh = host(HostKind::Github);
        let gl = host(HostKind::Gitlab);
        let bb = host(HostKind::Bitbucket);
        let path = "src/my file.rs";
        assert_eq!(
            file_url(&gh, "main", path, None, None),
            "https://github.com/o/r/blob/main/src/my%20file.rs"
        );
        assert_eq!(
            file_url(&gh, "feat/x", "a.rs", Some(3), None),
            "https://github.com/o/r/blob/feat/x/a.rs#L3"
        );
        assert_eq!(
            file_url(&gh, "main", "a.rs", Some(3), Some(9)),
            "https://github.com/o/r/blob/main/a.rs#L3-L9"
        );
        assert_eq!(
            file_url(&gl, "main", "a.rs", Some(3), Some(9)),
            "https://gitlab.com/g/s/r/-/blob/main/a.rs#L3-9"
        );
        assert_eq!(
            file_url(&bb, "main", "d/a.rs", Some(3), Some(9)),
            "https://bitbucket.org/w/r/src/main/d/a.rs#a.rs-3:9"
        );
        assert_eq!(
            file_url(&bb, "main", "a.rs", Some(3), None),
            "https://bitbucket.org/w/r/src/main/a.rs#a.rs-3"
        );
        // An end that is not after the start, or an end without a start, adds nothing.
        for end in [Some(3), Some(1)] {
            assert_eq!(
                file_url(&gh, "main", "a.rs", Some(3), end),
                "https://github.com/o/r/blob/main/a.rs#L3"
            );
        }
        assert_eq!(
            file_url(&gh, "main", "a.rs", None, Some(9)),
            "https://github.com/o/r/blob/main/a.rs"
        );
        assert_eq!(
            file_url(&gh, "main", "a.rs", Some(0), None),
            "https://github.com/o/r/blob/main/a.rs"
        );
    }
}
