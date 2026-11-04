//! The only code in this crate that touches the network.

use std::io::Read;
use std::time::Duration;

use crate::avatar::AVATAR_MAX;
use crate::http::{Method, Offline, Request, Response, Transport};

const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const SIGN_OUT_TIMEOUT: Duration = Duration::from_secs(5);

/// What an agent is built from. Pure, so it is tested without a network.
#[derive(Debug, PartialEq, Eq)]
pub struct TransportConfig {
    pub timeout: Duration,
    /// A redirect could carry the bearer token to another host.
    pub max_redirects: u32,
    /// No proxy: plain HTTP to a loopback dev server would show the token to the proxy.
    pub direct: bool,
}

/// `url` is a request URL; `/signout` gets the short timeout.
pub fn agent_config(url: &str) -> TransportConfig {
    let timeout = if url.ends_with("/api/desktop/signout") {
        SIGN_OUT_TIMEOUT
    } else {
        CALL_TIMEOUT
    };
    TransportConfig {
        timeout,
        max_redirects: 0,
        direct: url.starts_with("http://"),
    }
}

/// At most `cap` bytes; the rest of the stream is left unread.
pub fn read_capped(reader: impl Read, cap: usize) -> std::io::Result<Vec<u8>> {
    let mut body = Vec::new();
    reader.take(cap as u64).read_to_end(&mut body)?;
    Ok(body)
}

pub struct UreqTransport;

impl Transport for UreqTransport {
    fn send(&self, req: &Request) -> Result<Response, Offline> {
        let cfg = agent_config(&req.url);
        let mut builder = ureq::Agent::config_builder()
            .timeout_global(Some(cfg.timeout))
            .max_redirects(cfg.max_redirects)
            .http_status_as_error(false)
            .user_agent(format!("xDev/{}", env!("CARGO_PKG_VERSION")));
        if cfg.direct {
            builder = builder.proxy(None);
        }
        let agent: ureq::Agent = builder.build().into();
        // Errors are dropped, never formatted: their text may carry the URL.
        let result = match req.method {
            Method::Get => {
                let mut call = agent.get(&req.url);
                if let Some(token) = &req.bearer {
                    call = call.header("Authorization", format!("Bearer {}", token.expose()));
                }
                call.call()
            }
            Method::Post => {
                let mut call = agent
                    .post(&req.url)
                    .header("Content-Type", "application/json");
                if let Some(token) = &req.bearer {
                    call = call.header("Authorization", format!("Bearer {}", token.expose()));
                }
                match &req.json {
                    Some(body) => call.send(body.expose()),
                    None => call.send_empty(),
                }
            }
        };
        let mut response = result.map_err(|_| Offline)?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body =
            read_capped(response.body_mut().as_reader(), AVATAR_MAX + 1).map_err(|_| Offline)?;
        Ok(Response {
            status,
            content_type,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn config_never_follows_redirects() {
        assert_eq!(
            agent_config("https://id.xdev.asia/api/desktop/me").max_redirects,
            0
        );
    }

    #[test]
    fn config_skips_the_proxy_for_plain_http_only() {
        assert!(agent_config("http://127.0.0.1:8787/api/desktop/me").direct);
        assert!(agent_config("http://localhost:8787/api/desktop/me").direct);
        assert!(!agent_config("https://id.xdev.asia/api/desktop/me").direct);
    }

    #[test]
    fn config_timeouts() {
        assert_eq!(
            agent_config("https://id.xdev.asia/api/desktop/me").timeout,
            Duration::from_secs(15)
        );
        assert_eq!(
            agent_config("https://id.xdev.asia/api/desktop/token").timeout,
            Duration::from_secs(15)
        );
        assert_eq!(
            agent_config("https://id.xdev.asia/api/desktop/signout").timeout,
            Duration::from_secs(5)
        );
    }

    #[test]
    fn read_capped_stops_at_the_cap() {
        let data = vec![7u8; 100];
        assert_eq!(read_capped(Cursor::new(&data), 10).unwrap().len(), 10);
        assert_eq!(read_capped(Cursor::new(&data), 100).unwrap().len(), 100);
        assert_eq!(read_capped(Cursor::new(&data), 500).unwrap().len(), 100);
        assert!(
            read_capped(Cursor::new(Vec::<u8>::new()), 10)
                .unwrap()
                .is_empty()
        );
    }
}
