//! The HTTP seam: a trait the clients call, so tests never touch the network.

use std::fmt;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use crate::BODY_MAX;

/// A token. `Debug` never shows it.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Auth {
    None,
    /// The token as the whole header value (Linear personal keys).
    Raw(Secret),
    Bearer(Secret),
    Basic { user: String, secret: Secret },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Clone)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub auth: Auth,
    pub json: Option<String>,
}

impl fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub retry_after: Option<u64>,
    pub body: Vec<u8>,
}

/// No connection, DNS, TLS or timeout. The cause is dropped: its text may carry the URL.
#[derive(Debug)]
pub struct Offline;

pub trait HttpSend: Send + Sync {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, Offline>;
}

/// The value of the `Authorization` header, if any.
pub fn auth_header(auth: &Auth) -> Option<String> {
    match auth {
        Auth::None => None,
        Auth::Raw(s) => Some(s.expose().to_owned()),
        Auth::Bearer(s) => Some(format!("Bearer {}", s.expose())),
        Auth::Basic { user, secret } => Some(format!(
            "Basic {}",
            STANDARD.encode(format!("{user}:{}", secret.expose()))
        )),
    }
}

/// What an agent is built from. Pure, so it is tested without a network.
#[derive(Debug, PartialEq, Eq)]
pub struct TransportConfig {
    pub timeout: Duration,
    /// A redirect could carry the token to another host.
    pub max_redirects: u32,
    pub body_max: usize,
}

pub fn agent_config() -> TransportConfig {
    TransportConfig {
        timeout: Duration::from_secs(15),
        max_redirects: 0,
        body_max: BODY_MAX,
    }
}

/// `Retry-After` in seconds; HTTP dates are not parsed.
pub fn retry_after(raw: &str) -> Option<u64> {
    raw.trim().parse().ok()
}

#[cfg(any(test, feature = "test-util"))]
pub use fake::FakeHttp;

#[cfg(any(test, feature = "test-util"))]
mod fake {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use super::*;

    /// Queued replies in order, then `Offline`; records every request.
    #[derive(Default)]
    pub struct FakeHttp {
        replies: Mutex<VecDeque<Result<HttpResponse, Offline>>>,
        sent: Mutex<Vec<HttpRequest>>,
    }

    impl FakeHttp {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn push(&self, status: u16, body: &str) -> &Self {
            self.push_full(status, None, body.as_bytes().to_vec())
        }

        pub fn push_retry(&self, status: u16, retry_after: u64, body: &str) -> &Self {
            self.push_full(status, Some(retry_after), body.as_bytes().to_vec())
        }

        pub fn push_full(&self, status: u16, retry_after: Option<u64>, body: Vec<u8>) -> &Self {
            self.replies.lock().unwrap().push_back(Ok(HttpResponse {
                status,
                retry_after,
                body,
            }));
            self
        }

        pub fn push_offline(&self) -> &Self {
            self.replies.lock().unwrap().push_back(Err(Offline));
            self
        }

        pub fn requests(&self) -> Vec<HttpRequest> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl HttpSend for FakeHttp {
        fn send(&self, req: &HttpRequest) -> Result<HttpResponse, Offline> {
            self.sent.lock().unwrap().push(req.clone());
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Err(Offline))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_and_request_debug_hide_the_token() {
        assert!(!format!("{:?}", Secret::new("tok-SENTINEL")).contains("tok-SENTINEL"));
        for auth in [
            Auth::None,
            Auth::Raw(Secret::new("tok-SENTINEL")),
            Auth::Bearer(Secret::new("tok-SENTINEL")),
            Auth::Basic {
                user: "a@x.io".into(),
                secret: Secret::new("tok-SENTINEL"),
            },
        ] {
            let req = HttpRequest {
                method: Method::Post,
                url: "https://h/x".into(),
                auth: auth.clone(),
                json: Some("{\"t\":\"tok-SENTINEL\"}".into()),
            };
            assert!(!format!("{req:?}").contains("tok-SENTINEL"));
            assert!(!format!("{auth:?}").contains("tok-SENTINEL"));
        }
    }

    #[test]
    fn auth_headers() {
        assert_eq!(auth_header(&Auth::None), None);
        assert_eq!(
            auth_header(&Auth::Raw(Secret::new("tok"))).as_deref(),
            Some("tok")
        );
        assert_eq!(
            auth_header(&Auth::Bearer(Secret::new("tok"))).as_deref(),
            Some("Bearer tok")
        );
        let basic = Auth::Basic {
            user: "a@x.io".into(),
            secret: Secret::new("tok"),
        };
        assert_eq!(
            auth_header(&basic).as_deref(),
            Some("Basic YUB4LmlvOnRvaw==")
        );
    }

    #[test]
    fn config_rules() {
        let c = agent_config();
        assert_eq!(c.timeout, Duration::from_secs(15));
        assert_eq!(c.max_redirects, 0);
        assert_eq!(c.body_max, BODY_MAX);
    }

    #[test]
    fn retry_after_parses_seconds_only() {
        assert_eq!(retry_after("120"), Some(120));
        assert_eq!(retry_after("soon"), None);
    }

    #[test]
    fn fake_replays_in_order_then_offline_and_records() {
        let fake = FakeHttp::new();
        fake.push(200, "a").push(500, "b");
        let req = HttpRequest {
            method: Method::Get,
            url: "https://h/".into(),
            auth: Auth::None,
            json: None,
        };
        assert_eq!(fake.send(&req).unwrap().status, 200);
        assert_eq!(fake.send(&req).unwrap().status, 500);
        assert!(fake.send(&req).is_err());
        assert_eq!(fake.requests().len(), 3);
    }
}
