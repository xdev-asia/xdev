//! The page the browser opens, and the name this device shows on it.

use url::{Host, Url};

use crate::DEFAULT_BASE;

const MAX_DEVICE: usize = 64;

/// The service origin. `XDEV_ID_URL` may point at a local dev server; only https or a
/// loopback host over http is accepted, so a set variable cannot send the sign-in to a
/// plain-http remote host.
pub fn base_url(env_override: Option<&str>) -> String {
    env_override
        .and_then(check_origin)
        .unwrap_or_else(|| DEFAULT_BASE.to_owned())
}

/// `https://host[:port]`, or `http://` to a loopback host; no path, query, fragment or
/// user info. The normalised origin, or `None`.
pub fn check_origin(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return None;
    }
    match url.scheme() {
        "https" => url.host()?,
        "http" => {
            let host = url.host()?;
            let loopback = match &host {
                Host::Domain(d) => *d == "localhost",
                Host::Ipv4(ip) => ip.is_loopback(),
                Host::Ipv6(_) => false,
            };
            if !loopback {
                return None;
            }
            host
        }
        _ => return None,
    };
    Some(url.origin().ascii_serialization())
}

/// `{base}/desktop?challenge=…&state=…&device=…`, form encoded.
pub fn authorize_url(base: &str, challenge: &str, state: &str, device: &str) -> String {
    let params = [
        ("challenge", challenge),
        ("state", state),
        ("device", device),
    ];
    match Url::parse_with_params(&format!("{base}/desktop"), params) {
        Ok(url) => url.into(),
        // `base` comes from `base_url`, so this is unreachable in practice.
        Err(_) => format!("{DEFAULT_BASE}/desktop"),
    }
}

/// Trim, drop control characters, keep the first 64 code points.
pub fn clean_device(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    cleaned.trim().chars().take(MAX_DEVICE).collect()
}

/// The OS host name, cleaned; empty when unknown.
pub fn device_name() -> String {
    clean_device(&raw_host_name())
}

#[cfg(target_os = "windows")]
fn raw_host_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn raw_host_name() -> String {
    use std::process::Command;
    let run = |program: &str, args: &[&str]| {
        Command::new(program)
            .args(args)
            .output()
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .filter(|s| !s.trim().is_empty())
    };
    run("scutil", &["--get", "ComputerName"])
        .or_else(|| run("hostname", &[]))
        .unwrap_or_default()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn raw_host_name() -> String {
    ["/etc/hostname", "/proc/sys/kernel/hostname"]
        .iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .find(|s| !s.trim().is_empty())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn challenge_ok(s: &str) -> bool {
        s.len() == 43
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    }

    #[test]
    fn authorize_url_round_trips_awkward_device_names() {
        let challenge = crate::pkce::s256("v");
        assert!(challenge_ok(&challenge));
        for device in ["Duy's MacBook Pro", "Máy của Duy", "a&b=c", "💻 laptop", ""] {
            let link = authorize_url("https://id.xdev.asia", &challenge, "st ate/+", device);
            let url = Url::parse(&link).unwrap();
            assert_eq!(url.path(), "/desktop");
            let pairs: Vec<(String, String)> = url
                .query_pairs()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            assert_eq!(
                pairs,
                vec![
                    ("challenge".to_owned(), challenge.clone()),
                    ("state".to_owned(), "st ate/+".to_owned()),
                    ("device".to_owned(), device.to_owned()),
                ]
            );
        }
    }

    #[test]
    fn base_url_accepts_https_and_loopback_only() {
        assert_eq!(base_url(None), DEFAULT_BASE);
        assert_eq!(base_url(Some("https://x.test/")), "https://x.test");
        assert_eq!(base_url(Some("https://x.test")), "https://x.test");
        assert_eq!(
            base_url(Some("http://127.0.0.1:8787")),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            base_url(Some("http://localhost:8787/")),
            "http://localhost:8787"
        );
        for bad in [
            "http://evil.test",
            "ftp://x.test",
            "not a url",
            "",
            "http://127.0.0.1:@evil.test",
            "https://u:p@x.test",
            "https://x.test/path",
            "https://x.test/?q=1",
            "http://127.0.0.1.evil.test",
        ] {
            assert_eq!(base_url(Some(bad)), DEFAULT_BASE, "{bad}");
        }
    }

    #[test]
    fn clean_device_trims_strips_controls_and_caps() {
        assert_eq!(clean_device("  Duy PC  "), "Duy PC");
        assert_eq!(clean_device("a\nb\tc\0d"), "abcd");
        assert_eq!(clean_device(""), "");
        let long = "😀".repeat(70);
        assert_eq!(clean_device(&long), "😀".repeat(64));
    }

    #[test]
    fn device_name_is_at_most_64_characters() {
        assert!(device_name().chars().count() <= 64);
    }
}
