//! Which avatar URLs the app may fetch, and the `data:` URL it hands the webview.
//!
//! The webview CSP blocks remote images, so Rust fetches the picture and returns it
//! inline. The host list matches the portal's CSP.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use url::Url;

pub const AVATAR_MAX: usize = 256 * 1024;

/// `server` is the origin of the xDev ID server in use: its own pictures are allowed too.
pub fn avatar_allowed(url: &str, server: &str) -> bool {
    let Ok(url) = Url::parse(url) else {
        return false;
    };
    if url.username().is_empty()
        && url.password().is_none()
        && url.origin().ascii_serialization() == server
    {
        return true;
    }
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return false;
    }
    match url.host_str() {
        Some(host) => {
            host == "avatars.githubusercontent.com" || host.ends_with(".googleusercontent.com")
        }
        None => false,
    }
}

/// `data:<type>;base64,…` for png, jpeg, gif or webp within the size cap. Never SVG.
pub fn data_url(content_type: Option<&str>, body: &[u8]) -> Option<String> {
    let kind = content_type?.split(';').next()?.trim().to_ascii_lowercase();
    if !matches!(
        kind.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) || body.is_empty()
        || body.len() > AVATAR_MAX
    {
        return None;
    }
    Some(format!("data:{kind};base64,{}", STANDARD.encode(body)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEFAULT: &str = "https://id.xdev.asia";

    #[test]
    fn allowed_hosts() {
        for ok in [
            "https://avatars.githubusercontent.com/u/1?v=4",
            "https://lh3.googleusercontent.com/a/abc=s96-c",
        ] {
            assert!(avatar_allowed(ok, DEFAULT), "{ok}");
        }
        for bad in [
            "https://googleusercontent.com.evil.test/a",
            "https://evil.test/avatars.githubusercontent.com",
            "https://googleusercontent.com/a",
            "http://avatars.githubusercontent.com/u/1",
            "https://user@avatars.githubusercontent.com/u/1",
            "https://avatars.githubusercontent.com:8443/u/1",
            "https://evilgoogleusercontent.com/a",
            "data:image/png;base64,AAAA",
            "not a url",
            "",
        ] {
            assert!(!avatar_allowed(bad, DEFAULT), "{bad}");
        }
    }

    #[test]
    fn the_current_server_may_serve_avatars() {
        let corp = "https://id.corp.test";
        assert!(avatar_allowed("https://id.corp.test/img/1.png", corp));
        assert!(avatar_allowed(
            "https://id.corp.test:8443/a.png",
            "https://id.corp.test:8443"
        ));
        assert!(avatar_allowed(
            "http://localhost:8787/a.png",
            "http://localhost:8787"
        ));
        // Another host, scheme, port or user info is not the server.
        for bad in [
            "https://other.corp.test/a.png",
            "http://id.corp.test/a.png",
            "https://id.corp.test:8443/a.png",
            "https://u@id.corp.test/a.png",
            "https://id.corp.test.evil.test/a.png",
        ] {
            assert!(!avatar_allowed(bad, corp), "{bad}");
        }
        // The default server's host is not trusted once another server is in use.
        assert!(!avatar_allowed("https://id.xdev.asia/a.png", corp));
    }

    #[test]
    fn data_url_accepts_raster_types_only() {
        assert_eq!(
            data_url(Some("image/png"), b"abc").as_deref(),
            Some("data:image/png;base64,YWJj")
        );
        assert_eq!(
            data_url(Some("IMAGE/JPEG; charset=x"), b"abc").as_deref(),
            Some("data:image/jpeg;base64,YWJj")
        );
        assert!(data_url(Some("image/gif"), b"a").is_some());
        assert!(data_url(Some("image/webp"), b"a").is_some());
        assert!(data_url(Some("image/svg+xml"), b"<svg/>").is_none());
        assert!(data_url(Some("text/html"), b"a").is_none());
        assert!(data_url(None, b"a").is_none());
        assert!(data_url(Some("image/png"), b"").is_none());
        assert!(data_url(Some("image/png"), &vec![0u8; AVATAR_MAX]).is_some());
        assert!(data_url(Some("image/png"), &vec![0u8; AVATAR_MAX + 1]).is_none());
    }
}
