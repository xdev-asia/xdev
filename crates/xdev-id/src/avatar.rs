//! Which avatar URLs the app may fetch, and the `data:` URL it hands the webview.
//!
//! The webview CSP blocks remote images, so Rust fetches the picture and returns it
//! inline. The host list matches the portal's CSP.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use url::Url;

pub const AVATAR_MAX: usize = 256 * 1024;

pub fn avatar_allowed(url: &str) -> bool {
    let Ok(url) = Url::parse(url) else {
        return false;
    };
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

    #[test]
    fn allowed_hosts() {
        for ok in [
            "https://avatars.githubusercontent.com/u/1?v=4",
            "https://lh3.googleusercontent.com/a/abc=s96-c",
        ] {
            assert!(avatar_allowed(ok), "{ok}");
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
            assert!(!avatar_allowed(bad), "{bad}");
        }
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
