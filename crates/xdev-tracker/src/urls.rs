//! Base URL rules for Jira, and the origin check every built URL passes before it is sent.

use url::Url;

use crate::TrackerError;

const BASE_MAX: usize = 512;

fn valid_label(s: &str) -> bool {
    (1..=63).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `acme`, `acme.atlassian.net` or `https://acme.atlassian.net[/]` -> `https://acme.atlassian.net`.
pub fn jira_cloud_base(site: &str) -> Result<String, TrackerError> {
    let s = site.trim().to_ascii_lowercase();
    let s = s.strip_prefix("https://").unwrap_or(&s);
    let s = s.trim_end_matches('/');
    let label = s.strip_suffix(".atlassian.net").unwrap_or(s);
    if !valid_label(label) {
        return Err(TrackerError::BadUrl);
    }
    Ok(format!("https://{label}.atlassian.net"))
}

/// A self-hosted base: https only, a host, no userinfo, query or fragment; the path is kept.
pub fn jira_server_base(raw: &str) -> Result<String, TrackerError> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > BASE_MAX || !raw.starts_with("https://") {
        return Err(TrackerError::BadUrl);
    }
    if raw.contains('?') || raw.contains('#') {
        return Err(TrackerError::BadUrl);
    }
    let url = Url::parse(raw).map_err(|_| TrackerError::BadUrl)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(TrackerError::BadUrl);
    }
    let host = url.host_str().unwrap_or_default();
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    let path = url.path().trim_end_matches('/');
    Ok(format!("https://{host}{port}{path}"))
}

/// Host (with a non-default port) of a base URL.
pub fn host_of(base: &str) -> Option<String> {
    let url = Url::parse(base).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_owned(),
    })
}

/// Same scheme, host and port: the token never goes anywhere else.
pub fn same_origin(base: &str, url: &str) -> bool {
    let (Ok(a), Ok(b)) = (Url::parse(base), Url::parse(url)) else {
        return false;
    };
    a.scheme() == "https"
        && a.scheme() == b.scheme()
        && a.host_str().is_some()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn key_ok(key: &str) -> bool {
    let Some((project, num)) = key.rsplit_once('-') else {
        return false;
    };
    let mut chars = project.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_uppercase());
    first_ok
        && project.len() >= 2
        && project
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !num.is_empty()
        && num.chars().all(|c| c.is_ascii_digit())
}

/// Whether `key` looks like a Jira issue key (`PROJ-3`).
pub fn jira_key_ok(key: &str) -> bool {
    key_ok(key)
}

pub fn jira_browse_url(base: &str, key: &str) -> Option<String> {
    key_ok(key).then(|| format!("{base}/browse/{key}"))
}

/// `+0700` -> `+07:00`; other forms are unchanged.
pub fn jira_time(raw: &str) -> String {
    let b = raw.as_bytes();
    let n = b.len();
    if n >= 5 {
        let tail = &raw[n - 5..];
        let sign = tail.as_bytes()[0];
        if (sign == b'+' || sign == b'-') && tail[1..].bytes().all(|c| c.is_ascii_digit()) {
            return format!("{}:{}", &raw[..n - 2], &raw[n - 2..]);
        }
    }
    raw.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_base() {
        for ok in ["acme", "ACME.atlassian.net", "https://acme.atlassian.net/"] {
            assert_eq!(jira_cloud_base(ok).unwrap(), "https://acme.atlassian.net");
        }
        let long = "a".repeat(64);
        for bad in ["acme.example.com", "a b", "", long.as_str()] {
            assert_eq!(jira_cloud_base(bad), Err(TrackerError::BadUrl), "{bad}");
        }
    }

    #[test]
    fn server_base() {
        assert_eq!(
            jira_server_base("https://jira.corp.example/jira/").unwrap(),
            "https://jira.corp.example/jira"
        );
        assert_eq!(
            jira_server_base("https://jira.corp.example").unwrap(),
            "https://jira.corp.example"
        );
        let long = format!("https://h.example/{}", "a".repeat(500));
        for bad in [
            "http://jira.corp.example",
            "https://u:p@host",
            "https://host/?q=1",
            "https://host/#x",
            "ftp://host",
            "",
            long.as_str(),
        ] {
            assert_eq!(jira_server_base(bad), Err(TrackerError::BadUrl), "{bad}");
        }
    }

    #[test]
    fn origin_check() {
        let base = "https://acme.atlassian.net";
        assert!(same_origin(
            base,
            "https://acme.atlassian.net/rest/api/3/myself"
        ));
        assert!(!same_origin(
            base,
            "https://acme.atlassian.net.evil.example/x"
        ));
        assert!(!same_origin(base, "http://acme.atlassian.net/x"));
        assert!(!same_origin(base, "https://acme.atlassian.net:8443/x"));
        assert!(!same_origin(base, "nonsense"));
    }

    #[test]
    fn browse_url() {
        assert_eq!(
            jira_browse_url("https://a.atlassian.net", "PROJ-3").as_deref(),
            Some("https://a.atlassian.net/browse/PROJ-3")
        );
        for bad in ["proj-3", "PROJ-", "../x", "P-1", "PROJ-3x"] {
            assert_eq!(
                jira_browse_url("https://a.atlassian.net", bad),
                None,
                "{bad}"
            );
        }
    }

    #[test]
    fn time_offsets() {
        assert_eq!(
            jira_time("2026-11-05T10:12:00.000+0700"),
            "2026-11-05T10:12:00.000+07:00"
        );
        assert_eq!(
            jira_time("2026-11-05T10:12:00.000-0330"),
            "2026-11-05T10:12:00.000-03:30"
        );
        assert_eq!(
            jira_time("2026-11-05T10:12:00.000+07:00"),
            "2026-11-05T10:12:00.000+07:00"
        );
        assert_eq!(jira_time("2026-11-05T10:12:00Z"), "2026-11-05T10:12:00Z");
    }
}
