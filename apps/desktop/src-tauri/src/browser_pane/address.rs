//! What the browser tab's address field turns into a URL, and which URLs a page may load.
//!
//! The one place these rules live: the front end sends the typed text and shows what comes back.

use url::Url;

/// Why typed text did not become an address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressError {
    /// Nothing but whitespace.
    Empty,
    /// A scheme other than `http`, `https` or `about:blank`.
    Scheme,
    /// It did not parse as a URL.
    Invalid,
}

impl AddressError {
    pub fn code(self) -> &'static str {
        match self {
            AddressError::Empty => "browser_empty",
            AddressError::Scheme => "browser_scheme",
            AddressError::Invalid => "browser_invalid",
        }
    }
}

pub const BLANK: &str = "about:blank";

/// The URL the typed `input` names.
///
/// - `about:blank` stays as it is; another scheme than `http`/`https` is refused.
/// - `localhost`, `*.localhost`, an IPv4 address or a bracketed IPv6 address (each with an optional
///   port) gets `http://`.
/// - Any other host with a dot gets `https://`.
/// - Anything else is a search through `template` (`%s` is the query), or, when the template is
///   empty, is read as a host with `https://`.
pub fn normalize_address(input: &str, template: &str) -> Result<String, AddressError> {
    let text = input.trim();
    if text.is_empty() {
        return Err(AddressError::Empty);
    }
    if text.eq_ignore_ascii_case(BLANK) {
        return Ok(BLANK.to_owned());
    }
    if let Some(scheme) = scheme_of(text) {
        if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") {
            return Err(AddressError::Scheme);
        }
        return web_url(text);
    }
    if text.chars().any(char::is_whitespace) {
        return search(text, template);
    }
    let host = host_part(text);
    if is_local_host(host) {
        return web_url(&format!("http://{text}"));
    }
    if host.contains('.') || template.trim().is_empty() {
        return web_url(&format!("https://{text}"));
    }
    search(text, template)
}

/// Whether a page in a browser tab may load `url`: `about:blank`, or `http`/`https` to a place
/// that is not the app itself. `dev_origin` is the app's dev server in a debug build.
pub fn navigation_allowed(url: &Url, dev_origin: Option<&Url>) -> bool {
    if url.as_str() == BLANK {
        return true;
    }
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    // The app's own protocols: `http://tauri.localhost`, `http://ipc.localhost` and every custom
    // protocol as `http://<name>.localhost` with no port (how Windows serves them).
    if matches!(
        host.as_str(),
        "tauri.localhost" | "ipc.localhost" | "asset.localhost"
    ) {
        return false;
    }
    if host.ends_with(".localhost") && url.port().is_none() {
        return false;
    }
    !dev_origin.is_some_and(|dev| {
        dev.scheme() == url.scheme()
            && dev.host_str().map(str::to_ascii_lowercase).as_deref() == Some(host.as_str())
            && dev.port_or_known_default() == url.port_or_known_default()
    })
}

/// Whether `template` can be a search address: empty, or `http(s)` with `%s` in it.
pub fn template_valid(template: &str) -> bool {
    let t = template.trim();
    t.is_empty()
        || (t.contains("%s")
            && Url::parse(&t.replace("%s", "q"))
                .is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some()))
}

fn search(text: &str, template: &str) -> Result<String, AddressError> {
    let template = template.trim();
    if template.is_empty() {
        return web_url(&format!("https://{text}"));
    }
    if !template_valid(template) {
        return Err(AddressError::Invalid);
    }
    let query: String = url::form_urlencoded::byte_serialize(text.as_bytes()).collect();
    web_url(&template.replace("%s", &query))
}

fn web_url(text: &str) -> Result<String, AddressError> {
    let url = Url::parse(text).map_err(|_| AddressError::Invalid)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AddressError::Scheme);
    }
    match url.host_str() {
        Some(h) if !h.is_empty() => Ok(url.into()),
        _ => Err(AddressError::Invalid),
    }
}

/// The scheme of `text` when it has one. `localhost:3000` and `example.com:8080/x` have a port,
/// not a scheme.
fn scheme_of(text: &str) -> Option<&str> {
    let colon = text.find(':')?;
    let scheme = &text[..colon];
    let mut chars = scheme.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    let rest = &text[colon + 1..];
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    let port_like = digits > 0
        && rest[digits..]
            .chars()
            .next()
            .is_none_or(|c| matches!(c, '/' | '?' | '#'));
    (!port_like).then_some(scheme)
}

/// The host of scheme-less text, without its port.
fn host_part(text: &str) -> &str {
    let end = text.find(['/', '?', '#']).unwrap_or(text.len());
    let authority = &text[..end];
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if authority.starts_with('[') {
        return authority.find(']').map_or(authority, |i| &authority[..=i]);
    }
    authority.split(':').next().unwrap_or(authority)
}

fn is_local_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || host.parse::<std::net::Ipv4Addr>().is_ok()
        || (host.starts_with('[')
            && host.ends_with(']')
            && host[1..host.len() - 1]
                .parse::<std::net::Ipv6Addr>()
                .is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "https://search.example/?q=%s";

    #[test]
    fn normalizes_typed_text() {
        let ok: &[(&str, &str, &str)] = &[
            ("about:blank", T, "about:blank"),
            ("  ABOUT:BLANK ", T, "about:blank"),
            ("https://example.com", T, "https://example.com/"),
            (
                "HTTP://Example.com/a?b=1#c",
                T,
                "http://example.com/a?b=1#c",
            ),
            ("example.com", T, "https://example.com/"),
            ("example.com:8080/path", T, "https://example.com:8080/path"),
            ("sub.example.co.uk/x?y", T, "https://sub.example.co.uk/x?y"),
            ("localhost", T, "http://localhost/"),
            ("localhost:3000", T, "http://localhost:3000/"),
            ("localhost:3000/app", T, "http://localhost:3000/app"),
            ("app.localhost:5173", T, "http://app.localhost:5173/"),
            ("127.0.0.1:8080", T, "http://127.0.0.1:8080/"),
            ("192.168.1.10", T, "http://192.168.1.10/"),
            ("[::1]:8080", T, "http://[::1]:8080/"),
            ("rust", T, "https://search.example/?q=rust"),
            (
                "how to center a div",
                T,
                "https://search.example/?q=how+to+center+a+div",
            ),
            (
                "what is 2.5 & 3",
                T,
                "https://search.example/?q=what+is+2.5+%26+3",
            ),
            ("rust", "", "https://rust/"),
            ("intranet", "  ", "https://intranet/"),
        ];
        for (input, template, want) in ok {
            assert_eq!(
                normalize_address(input, template).as_deref(),
                Ok(*want),
                "input {input:?} template {template:?}"
            );
        }
    }

    #[test]
    fn refuses_what_is_not_a_web_address() {
        let bad: &[(&str, &str, AddressError)] = &[
            ("", T, AddressError::Empty),
            ("   ", T, AddressError::Empty),
            ("javascript:alert(1)", T, AddressError::Scheme),
            ("file:///C:/Windows", T, AddressError::Scheme),
            ("data:text/html,hi", T, AddressError::Scheme),
            ("mailto:a@b.c", T, AddressError::Scheme),
            ("ftp://example.com", T, AddressError::Scheme),
            ("about:config", T, AddressError::Scheme),
            ("http://", T, AddressError::Invalid),
            ("two words", "", AddressError::Invalid),
            ("rust", "ftp://x/%s", AddressError::Invalid),
            (
                "rust",
                "https://no-placeholder.example/",
                AddressError::Invalid,
            ),
        ];
        for (input, template, want) in bad {
            assert_eq!(
                normalize_address(input, template),
                Err(*want),
                "input {input:?}"
            );
        }
    }

    #[test]
    fn keeps_pages_away_from_the_app() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        let cases: &[(&str, Option<&Url>, bool)] = &[
            ("about:blank", None, true),
            ("https://example.com/", None, true),
            ("http://localhost:3000/", Some(&dev), true),
            ("http://app.localhost:5173/", None, true),
            ("http://localhost:1420/", None, true),
            ("http://localhost:1420/", Some(&dev), false),
            ("http://LOCALHOST:1420/x", Some(&dev), false),
            ("http://tauri.localhost/", None, false),
            ("https://tauri.localhost/index.html", None, false),
            ("http://ipc.localhost/cmd", None, false),
            ("http://asset.localhost/x", None, false),
            ("http://asset.localhost:80/x", None, false),
            ("http://myproto.localhost/", None, false),
            ("tauri://localhost/", None, false),
            ("file:///etc/passwd", None, false),
            ("javascript:alert(1)", None, false),
            ("data:text/html,x", None, false),
            ("about:srcdoc", None, false),
        ];
        for (raw, dev, want) in cases {
            let url = Url::parse(raw).unwrap();
            assert_eq!(navigation_allowed(&url, *dev), *want, "{raw}");
        }
    }

    #[test]
    fn checks_search_templates() {
        for (t, want) in [
            ("", true),
            ("  ", true),
            ("https://search.example/?q=%s", true),
            ("http://intranet.local/find?q=%s&x=1", true),
            ("https://search.example/", false),
            ("ftp://x/%s", false),
            ("%s", false),
            ("javascript:%s", false),
        ] {
            assert_eq!(template_valid(t), want, "{t:?}");
        }
    }
}
