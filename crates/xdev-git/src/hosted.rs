//! The web URL of a file at a line on a hosted remote (GitHub, GitLab, Bitbucket). Pure string
//! work: nothing here runs git or touches the network.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Host {
    GitHub,
    GitLab,
    Bitbucket,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hosted {
    host: Host,
    /// `owner/repo`; a GitLab project may sit in subgroups (`group/sub/repo`).
    path: Vec<String>,
}

fn host_of(name: &str) -> Option<Host> {
    match name.to_ascii_lowercase().as_str() {
        "github.com" => Some(Host::GitHub),
        "gitlab.com" => Some(Host::GitLab),
        "bitbucket.org" => Some(Host::Bitbucket),
        _ => None,
    }
}

/// The host name of `authority` (`user:pw@host:port`).
fn host_name(authority: &str) -> &str {
    let after_user = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    after_user.split(':').next().unwrap_or(after_user)
}

fn project(host: Host, path: &str) -> Option<Hosted> {
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<String> = path.split('/').map(str::to_owned).collect();
    let fine = parts
        .iter()
        .all(|p| !p.is_empty() && p != "." && p != ".." && !p.chars().any(char::is_control));
    let count_ok = match host {
        Host::GitLab => parts.len() >= 2,
        _ => parts.len() == 2,
    };
    (fine && count_ok).then_some(Hosted { host, path: parts })
}

/// The project a remote URL names, when it lives on a host this module knows: scp-like
/// (`git@github.com:o/r.git`), `ssh://`, `git://`, `http(s)://` and the `github:o/r` shorthand.
pub(crate) fn parse_hosted(remote: &str) -> Option<Hosted> {
    let remote = remote.trim();
    for (prefix, host) in [
        ("github:", Host::GitHub),
        ("gitlab:", Host::GitLab),
        ("bitbucket:", Host::Bitbucket),
    ] {
        if let Some(rest) = remote.strip_prefix(prefix)
            && !rest.starts_with("//")
        {
            return project(host, rest);
        }
    }
    if let Some((scheme, rest)) = remote.split_once("://") {
        if !["ssh", "git", "http", "https"].contains(&scheme.to_ascii_lowercase().as_str()) {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        return project(host_of(host_name(authority))?, path);
    }
    // scp-like: `[user@]host:path`; a path with a `/` before the colon is a local one.
    let (authority, path) = remote.split_once(':')?;
    if authority.contains('/') || authority.contains('\\') {
        return None;
    }
    project(host_of(host_name(authority))?, path)
}

/// `text` with everything but `A-Za-z0-9-._~` percent-encoded; `/` stays when `keep_slash`.
fn encode(text: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            b'/' if keep_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The hosted web URL of `rel` (forward slashes) at `git_ref`, line `line` or the lines `line` to
/// `end_line` when that is greater. `None` for an unknown host, an empty `rel` or `ref`, or line 0.
pub fn hosted_file_url(
    remote_url: &str,
    rel: &str,
    git_ref: &str,
    line: u32,
    end_line: Option<u32>,
) -> Option<String> {
    let hosted = parse_hosted(remote_url)?;
    let rel = rel.trim_matches('/');
    if rel.is_empty() || git_ref.is_empty() || line == 0 {
        return None;
    }
    let end = end_line.filter(|e| *e > line);
    let project = hosted
        .path
        .iter()
        .map(|p| encode(p, false))
        .collect::<Vec<_>>()
        .join("/");
    let (rel_enc, ref_enc) = (encode(rel, true), encode(git_ref, true));
    Some(match hosted.host {
        Host::GitHub => {
            let range = end.map_or(format!("L{line}"), |e| format!("L{line}-L{e}"));
            format!("https://github.com/{project}/blob/{ref_enc}/{rel_enc}#{range}")
        }
        Host::GitLab => {
            let range = end.map_or(format!("L{line}"), |e| format!("L{line}-{e}"));
            format!("https://gitlab.com/{project}/-/blob/{ref_enc}/{rel_enc}#{range}")
        }
        Host::Bitbucket => {
            let file = encode(rel.rsplit('/').next().unwrap_or(rel), false);
            let range = end.map_or(format!("{line}"), |e| format!("{line}:{e}"));
            format!("https://bitbucket.org/{project}/src/{ref_enc}/{rel_enc}#{file}-{range}")
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gh(remote: &str) -> Option<String> {
        hosted_file_url(remote, "src/a.ts", "main", 12, None)
    }

    #[test]
    fn reads_every_remote_spelling() {
        let want = Some("https://github.com/o/r/blob/main/src/a.ts#L12".to_owned());
        for remote in [
            "git@github.com:o/r.git",
            "git@github.com:o/r",
            "ssh://git@github.com/o/r.git",
            "ssh://git@github.com:22/o/r.git",
            "git://github.com/o/r.git",
            "https://github.com/o/r.git",
            "https://github.com/o/r",
            "https://github.com/o/r/",
            "https://user:token@github.com/o/r.git",
            "http://github.com/o/r.git",
            "HTTPS://GitHub.com/o/r.git",
            "github:o/r",
            "github.com:o/r.git",
            "  https://github.com/o/r.git\n",
        ] {
            assert_eq!(gh(remote), want, "{remote}");
        }
    }

    #[test]
    fn refuses_unknown_hosts_and_odd_remotes() {
        for remote in [
            "git@example.com:o/r.git",
            "https://github.example.com/o/r.git",
            "https://notgithub.com/o/r.git",
            "https://github.com/o",
            "https://github.com/o/r/extra",
            "https://github.com/",
            "file:///srv/git/r.git",
            "/srv/git/r.git",
            "../r.git",
            r"C:\repos\r.git",
            "origin",
            "",
            "ftp://github.com/o/r.git",
            "https://github.com/o/../r.git",
        ] {
            assert_eq!(gh(remote), None, "{remote}");
        }
    }

    #[test]
    fn builds_gitlab_urls_with_subgroups() {
        assert_eq!(
            hosted_file_url("git@gitlab.com:g/s/r.git", "src/a.ts", "main", 3, Some(9)).as_deref(),
            Some("https://gitlab.com/g/s/r/-/blob/main/src/a.ts#L3-9")
        );
        assert_eq!(
            hosted_file_url("https://gitlab.com/g/r.git", "a.ts", "main", 3, None).as_deref(),
            Some("https://gitlab.com/g/r/-/blob/main/a.ts#L3")
        );
        assert_eq!(
            hosted_file_url("https://gitlab.com/g.git", "a.ts", "main", 3, None),
            None
        );
    }

    #[test]
    fn builds_bitbucket_urls_with_the_file_in_the_fragment() {
        assert_eq!(
            hosted_file_url("git@bitbucket.org:w/r.git", "src/a.ts", "abc123", 4, None).as_deref(),
            Some("https://bitbucket.org/w/r/src/abc123/src/a.ts#a.ts-4")
        );
        assert_eq!(
            hosted_file_url(
                "https://bitbucket.org/w/r.git",
                "src/a b.ts",
                "main",
                4,
                Some(8)
            )
            .as_deref(),
            Some("https://bitbucket.org/w/r/src/main/src/a%20b.ts#a%20b.ts-4:8")
        );
    }

    #[test]
    fn github_ranges_need_an_end_after_the_start() {
        let r = |end| hosted_file_url("github:o/r", "a.ts", "main", 5, end);
        assert_eq!(
            r(Some(9)).as_deref(),
            Some("https://github.com/o/r/blob/main/a.ts#L5-L9")
        );
        assert_eq!(
            r(Some(5)).as_deref(),
            Some("https://github.com/o/r/blob/main/a.ts#L5")
        );
        assert_eq!(
            r(Some(2)).as_deref(),
            Some("https://github.com/o/r/blob/main/a.ts#L5")
        );
        assert_eq!(
            r(None).as_deref(),
            Some("https://github.com/o/r/blob/main/a.ts#L5")
        );
        assert_eq!(hosted_file_url("github:o/r", "a.ts", "main", 0, None), None);
    }

    #[test]
    fn encodes_paths_and_refs_but_keeps_their_slashes() {
        assert_eq!(
            hosted_file_url("github:o/r", "my dir/a #1?.ts", "feat/x y", 1, None).as_deref(),
            Some("https://github.com/o/r/blob/feat/x%20y/my%20dir/a%20%231%3F.ts#L1")
        );
        assert_eq!(
            hosted_file_url("github:o/r", "ドキュメント/é.md", "main", 1, None).as_deref(),
            Some(
                "https://github.com/o/r/blob/main/%E3%83%89%E3%82%AD%E3%83%A5%E3%83%A1%E3%83%B3%E3%83%88/%C3%A9.md#L1"
            )
        );
        assert_eq!(
            hosted_file_url("https://github.com/o/r%20x.git", "a.ts", "main", 1, None).as_deref(),
            Some("https://github.com/o/r%2520x/blob/main/a.ts#L1")
        );
    }

    #[test]
    fn refuses_an_empty_path_or_ref() {
        assert_eq!(hosted_file_url("github:o/r", "", "main", 1, None), None);
        assert_eq!(hosted_file_url("github:o/r", "a.ts", "", 1, None), None);
    }
}
