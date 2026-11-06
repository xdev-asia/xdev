//! The service calls, behind a `Transport` so tests never touch the network.
//!
//! Every call comes from Rust: the service sends no CORS headers, and the token must not
//! reach the webview.

use std::fmt;

use serde_json::{Value, json};

use crate::avatar::{avatar_allowed, data_url};
use crate::pkce::Secret;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    /// Added for the license device and activation calls.
    Delete,
}

#[derive(Clone)]
pub struct Request {
    pub method: Method,
    pub url: String,
    pub bearer: Option<Secret>,
    /// The JSON body, kept as a `Secret` because it holds the code and verifier.
    pub json: Option<Secret>,
}

impl fmt::Debug for Request {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Request")
            .field("method", &self.method)
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

pub struct Response {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

/// No connection, DNS, TLS or timeout. The cause is dropped: its text may carry the URL.
#[derive(Debug)]
pub struct Offline;

pub trait Transport: Send + Sync {
    fn send(&self, req: &Request) -> Result<Response, Offline>;
}

pub struct TokenReply {
    pub token: Secret,
    pub expires_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Me {
    pub name: String,
    pub email: String,
    pub image: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CallError {
    Unauthorized,
    InvalidCode,
    Unavailable,
}

fn json_body(res: &Response) -> Option<Value> {
    serde_json::from_slice(&res.body).ok()
}

fn token_ok(s: &str) -> bool {
    (20..=256).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Trade the one-time code and the PKCE verifier for a session token.
pub fn exchange(
    t: &dyn Transport,
    base: &str,
    code: &Secret,
    verifier: &Secret,
) -> Result<TokenReply, CallError> {
    let body = json!({ "code": code.expose(), "verifier": verifier.expose() }).to_string();
    let req = Request {
        method: Method::Post,
        url: format!("{base}/api/desktop/token"),
        bearer: None,
        json: Some(Secret::new(body)),
    };
    let res = t.send(&req).map_err(|_| CallError::Unavailable)?;
    match res.status {
        200 => {
            let json = json_body(&res).ok_or(CallError::Unavailable)?;
            let token = json.get("token").and_then(Value::as_str);
            let expires_at = json.get("expiresAt").and_then(Value::as_str);
            match (token, expires_at) {
                (Some(token), Some(expires_at)) if token_ok(token) => Ok(TokenReply {
                    token: Secret::new(token.to_owned()),
                    expires_at: expires_at.to_owned(),
                }),
                _ => Err(CallError::Unavailable),
            }
        }
        400 => {
            let invalid = json_body(&res)
                .and_then(|j| j.get("error").and_then(Value::as_str).map(str::to_owned))
                .is_some_and(|e| e == "invalid_code");
            Err(if invalid {
                CallError::InvalidCode
            } else {
                CallError::Unavailable
            })
        }
        _ => Err(CallError::Unavailable),
    }
}

/// The profile for a token. The service renews the session here, at most once a day.
pub fn me(t: &dyn Transport, base: &str, token: &Secret) -> Result<Me, CallError> {
    let req = Request {
        method: Method::Get,
        url: format!("{base}/api/desktop/me"),
        bearer: Some(token.clone()),
        json: None,
    };
    let res = t.send(&req).map_err(|_| CallError::Unavailable)?;
    match res.status {
        200 => {
            let json = json_body(&res).ok_or(CallError::Unavailable)?;
            let user = json.get("user").ok_or(CallError::Unavailable)?;
            let text = |key: &str| user.get(key).and_then(Value::as_str).map(str::to_owned);
            match (text("name"), text("email")) {
                (Some(name), Some(email)) => Ok(Me {
                    name,
                    email,
                    image: text("image"),
                }),
                _ => Err(CallError::Unavailable),
            }
        }
        401 => Err(CallError::Unauthorized),
        _ => Err(CallError::Unavailable),
    }
}

/// Best effort: the result is ignored.
pub fn sign_out(t: &dyn Transport, base: &str, token: &Secret) {
    let req = Request {
        method: Method::Post,
        url: format!("{base}/api/desktop/signout"),
        bearer: Some(token.clone()),
        json: None,
    };
    let _ = t.send(&req);
}

/// The avatar as a `data:` URL, or `None` when the host, type or size is not allowed.
pub fn fetch_avatar(t: &dyn Transport, image: &str, server: &str) -> Option<String> {
    if !avatar_allowed(image, server) {
        return None;
    }
    let req = Request {
        method: Method::Get,
        url: image.to_owned(),
        bearer: None,
        json: None,
    };
    let res = t.send(&req).ok()?;
    if res.status != 200 {
        return None;
    }
    data_url(res.content_type.as_deref(), &res.body)
}

/// A scripted transport for tests: replies in order, records every request.
#[cfg(any(test, feature = "test-util"))]
pub struct FakeTransport {
    replies: std::sync::Mutex<std::collections::VecDeque<Result<Response, Offline>>>,
    sent: std::sync::Mutex<Vec<Request>>,
}

#[cfg(any(test, feature = "test-util"))]
impl FakeTransport {
    pub fn new(replies: Vec<Result<Response, Offline>>) -> FakeTransport {
        FakeTransport {
            replies: std::sync::Mutex::new(replies.into()),
            sent: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub fn requests(&self) -> Vec<Request> {
        self.sent.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

#[cfg(any(test, feature = "test-util"))]
impl Response {
    pub fn json(status: u16, body: &str) -> Response {
        Response {
            status,
            content_type: Some("application/json".to_owned()),
            body: body.as_bytes().to_vec(),
        }
    }
}

#[cfg(any(test, feature = "test-util"))]
impl Transport for FakeTransport {
    fn send(&self, req: &Request) -> Result<Response, Offline> {
        if let Ok(mut sent) = self.sent.lock() {
            sent.push(req.clone());
        }
        self.replies
            .lock()
            .ok()
            .and_then(|mut q| q.pop_front())
            .unwrap_or(Err(Offline))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://id.test";
    const TOKEN: &str = "tok_tok_tok_tok_tok_tok_tok_tok_tok_to";

    fn code() -> Secret {
        Secret::new("the-one-time-code-value".into())
    }

    fn verifier() -> Secret {
        Secret::new("the-pkce-verifier-value".into())
    }

    fn fake(replies: Vec<Result<Response, Offline>>) -> FakeTransport {
        FakeTransport::new(replies)
    }

    fn token_ok_reply() -> Result<Response, Offline> {
        Ok(Response::json(
            200,
            &format!(r#"{{"token":"{TOKEN}","expiresAt":"2027-02-01T00:00:00.000Z"}}"#),
        ))
    }

    #[test]
    fn exchange_posts_code_and_verifier() {
        let t = fake(vec![token_ok_reply()]);
        let reply = exchange(&t, BASE, &code(), &verifier()).unwrap();
        assert_eq!(reply.token.expose(), TOKEN);
        assert_eq!(reply.expires_at, "2027-02-01T00:00:00.000Z");
        let sent = t.requests();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].method, Method::Post);
        assert_eq!(sent[0].url, "https://id.test/api/desktop/token");
        assert!(sent[0].bearer.is_none());
        let body: Value = serde_json::from_str(sent[0].json.as_ref().unwrap().expose()).unwrap();
        assert_eq!(
            body,
            json!({"code": "the-one-time-code-value", "verifier": "the-pkce-verifier-value"})
        );
    }

    #[test]
    fn exchange_maps_each_reply() {
        let cases: Vec<(Result<Response, Offline>, CallError)> = vec![
            (
                Ok(Response::json(400, r#"{"error":"invalid_code"}"#)),
                CallError::InvalidCode,
            ),
            (
                Ok(Response::json(400, r#"{"error":"bad_request"}"#)),
                CallError::Unavailable,
            ),
            (Ok(Response::json(500, "oops")), CallError::Unavailable),
            (Err(Offline), CallError::Unavailable),
            (Ok(Response::json(200, "not json")), CallError::Unavailable),
            (
                Ok(Response::json(
                    200,
                    r#"{"token":"abc.def.ghi.abc.def.ghi.abc.def","expiresAt":"x"}"#,
                )),
                CallError::Unavailable,
            ),
            (
                Ok(Response::json(200, r#"{"token":"short","expiresAt":"x"}"#)),
                CallError::Unavailable,
            ),
            (
                Ok(Response::json(200, &format!(r#"{{"token":"{TOKEN}"}}"#))),
                CallError::Unavailable,
            ),
        ];
        for (reply, want) in cases {
            let t = fake(vec![reply]);
            assert_eq!(exchange(&t, BASE, &code(), &verifier()).err(), Some(want));
        }
    }

    #[test]
    fn me_sends_the_bearer_and_reads_the_profile() {
        let t = fake(vec![
            Ok(Response::json(
                200,
                r#"{"user":{"id":"1","name":"Duy","email":"d@x.test","image":null}}"#,
            )),
            Ok(Response::json(
                200,
                r#"{"user":{"id":"1","name":"Duy","email":"d@x.test","image":"https://avatars.githubusercontent.com/u/1"}}"#,
            )),
        ]);
        let token = Secret::new(TOKEN.into());
        let got = me(&t, BASE, &token).unwrap();
        assert_eq!(
            got,
            Me {
                name: "Duy".into(),
                email: "d@x.test".into(),
                image: None
            }
        );
        assert_eq!(
            me(&t, BASE, &token).unwrap().image.as_deref(),
            Some("https://avatars.githubusercontent.com/u/1")
        );
        let sent = t.requests();
        assert_eq!(sent[0].method, Method::Get);
        assert_eq!(sent[0].url, "https://id.test/api/desktop/me");
        assert_eq!(sent[0].bearer.as_ref().unwrap().expose(), TOKEN);
    }

    #[test]
    fn me_maps_failures() {
        let cases: Vec<(Result<Response, Offline>, CallError)> = vec![
            (
                Ok(Response::json(401, r#"{"error":"unauthorized"}"#)),
                CallError::Unauthorized,
            ),
            (Ok(Response::json(503, "")), CallError::Unavailable),
            (Err(Offline), CallError::Unavailable),
            (Ok(Response::json(200, "{}")), CallError::Unavailable),
            (
                Ok(Response::json(200, r#"{"user":{"name":"x"}}"#)),
                CallError::Unavailable,
            ),
        ];
        for (reply, want) in cases {
            let t = fake(vec![reply]);
            assert_eq!(me(&t, BASE, &Secret::new(TOKEN.into())).err(), Some(want));
        }
    }

    #[test]
    fn sign_out_posts_and_swallows_offline() {
        let t = fake(vec![Err(Offline)]);
        sign_out(&t, BASE, &Secret::new(TOKEN.into()));
        let sent = t.requests();
        assert_eq!(sent[0].url, "https://id.test/api/desktop/signout");
        assert_eq!(sent[0].method, Method::Post);
        assert_eq!(sent[0].bearer.as_ref().unwrap().expose(), TOKEN);
    }

    #[test]
    fn request_debug_hides_secrets() {
        let t = fake(vec![token_ok_reply(), Err(Offline)]);
        let _ = exchange(&t, BASE, &code(), &verifier());
        let _ = me(&t, BASE, &Secret::new(TOKEN.into()));
        for req in t.requests() {
            let text = format!("{req:?}");
            for secret in [TOKEN, "the-one-time-code-value", "the-pkce-verifier-value"] {
                assert!(!text.contains(secret), "{text}");
            }
        }
    }

    #[test]
    fn fetch_avatar_checks_host_status_and_type() {
        let png = |status: u16, kind: &str| {
            Ok(Response {
                status,
                content_type: Some(kind.to_owned()),
                body: b"abc".to_vec(),
            })
        };
        let url = "https://avatars.githubusercontent.com/u/1";
        let t = fake(vec![png(200, "image/png")]);
        assert_eq!(
            fetch_avatar(&t, url, BASE).as_deref(),
            Some("data:image/png;base64,YWJj")
        );
        assert_eq!(t.requests()[0].url, url);
        assert!(t.requests()[0].bearer.is_none());
        assert!(fetch_avatar(&fake(vec![png(404, "image/png")]), url, BASE).is_none());
        assert!(fetch_avatar(&fake(vec![png(200, "image/svg+xml")]), url, BASE).is_none());
        assert!(fetch_avatar(&fake(vec![Err(Offline)]), url, BASE).is_none());
        // A disallowed host is never requested.
        let t = fake(vec![png(200, "image/png")]);
        assert!(fetch_avatar(&t, "https://evil.test/a.png", BASE).is_none());
        assert!(t.requests().is_empty());
    }
}
