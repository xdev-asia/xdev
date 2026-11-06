//! OpenAI speech-to-text for voice dictation.
//!
//! The HTTP call sits behind [`Transport`], so tests never touch the network.
//! Errors carry a status number at most: never the response body or the key.

use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

pub const TRANSCRIBE_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
pub const TRANSCRIBE_HOST: &str = "api.openai.com";

const MAX_BODY: u64 = 1 << 20;

/// A transport that could not deliver the request or read the reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportError;

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the request could not be sent")
    }
}

impl std::error::Error for TransportError {}

/// One POST: returns the status and the body text.
pub trait Transport {
    fn post(
        &self,
        url: &str,
        headers: &[(&str, String)],
        body: Vec<u8>,
    ) -> Result<(u16, String), TransportError>;
}

/// The production transport on `ureq`.
pub struct UreqTransport {
    /// Proxy URL, `None` for a direct connection.
    pub proxy: Option<String>,
}

impl UreqTransport {
    fn agent(&self) -> Result<ureq::Agent, TransportError> {
        let proxy = match &self.proxy {
            Some(url) => Some(ureq::Proxy::new(url).map_err(|_| TransportError)?),
            None => None,
        };
        Ok(ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_global(Some(Duration::from_secs(60)))
            // A redirect could carry the key somewhere else.
            .max_redirects(0)
            .http_status_as_error(false)
            .proxy(proxy)
            .build()
            .into())
    }
}

impl Transport for UreqTransport {
    fn post(
        &self,
        url: &str,
        headers: &[(&str, String)],
        body: Vec<u8>,
    ) -> Result<(u16, String), TransportError> {
        let mut request = self.agent()?.post(url);
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        let mut response = request.send(&body[..]).map_err(|_| TransportError)?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(MAX_BODY)
            .read_to_string()
            .map_err(|_| TransportError)?;
        Ok((status, text))
    }
}

/// What to transcribe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscribeRequest {
    /// A complete WAV file.
    pub wav: Vec<u8>,
    pub model: String,
    /// ISO-639-1 code; `None` lets the model detect it.
    pub language: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TranscribeError {
    #[error("OpenAI rejected the key")]
    BadKey,
    #[error("OpenAI rate limit reached")]
    RateLimited,
    #[error("transcription failed with HTTP status {0}")]
    Engine(u16),
    #[error("OpenAI is unreachable")]
    Offline,
    #[error("no speech was recognised")]
    Empty,
}

impl TranscribeError {
    /// Stable code the UI translates.
    pub fn code(&self) -> &'static str {
        match self {
            TranscribeError::BadKey => "speech_bad_key",
            TranscribeError::RateLimited => "speech_rate_limited",
            TranscribeError::Engine(_) => "speech_engine",
            TranscribeError::Offline => "speech_offline",
            TranscribeError::Empty => "speech_empty",
        }
    }
}

/// The multipart/form-data body for `req`.
pub fn build_multipart(boundary: &str, req: &TranscribeRequest) -> Vec<u8> {
    let mut body = Vec::with_capacity(req.wav.len() + 512);
    let text_part = |body: &mut Vec<u8>, name: &str, value: &str| {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    };
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&req.wav);
    body.extend_from_slice(b"\r\n");
    text_part(&mut body, "model", &req.model);
    text_part(&mut body, "response_format", "json");
    if let Some(language) = req.language.as_deref().filter(|l| !l.is_empty()) {
        text_part(&mut body, "language", language);
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

fn boundary() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("xdev-dictation-{nanos:x}")
}

/// Sends `req` and returns the trimmed text.
pub fn transcribe(
    transport: &dyn Transport,
    key: &str,
    req: &TranscribeRequest,
) -> Result<String, TranscribeError> {
    #[derive(Deserialize)]
    struct Reply {
        text: String,
    }
    let boundary = boundary();
    let headers = [
        ("Authorization", format!("Bearer {key}")),
        (
            "Content-Type",
            format!("multipart/form-data; boundary={boundary}"),
        ),
    ];
    let (status, body) = transport
        .post(TRANSCRIBE_URL, &headers, build_multipart(&boundary, req))
        .map_err(|_| TranscribeError::Offline)?;
    match status {
        200..=299 => {}
        401 | 403 => return Err(TranscribeError::BadKey),
        429 => return Err(TranscribeError::RateLimited),
        other => return Err(TranscribeError::Engine(other)),
    }
    let reply: Reply = serde_json::from_str(&body).map_err(|_| TranscribeError::Engine(status))?;
    let text = reply.text.trim();
    if text.is_empty() {
        return Err(TranscribeError::Empty);
    }
    Ok(text.to_owned())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    struct Seen {
        url: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    struct FakeTransport {
        reply: Result<(u16, String), TransportError>,
        seen: RefCell<Vec<Seen>>,
    }

    impl FakeTransport {
        fn new(status: u16, body: &str) -> Self {
            Self {
                reply: Ok((status, body.to_owned())),
                seen: RefCell::new(Vec::new()),
            }
        }

        fn failing() -> Self {
            Self {
                reply: Err(TransportError),
                seen: RefCell::new(Vec::new()),
            }
        }
    }

    impl Transport for FakeTransport {
        fn post(
            &self,
            url: &str,
            headers: &[(&str, String)],
            body: Vec<u8>,
        ) -> Result<(u16, String), TransportError> {
            self.seen.borrow_mut().push(Seen {
                url: url.to_owned(),
                headers: headers
                    .iter()
                    .map(|(n, v)| ((*n).to_owned(), v.clone()))
                    .collect(),
                body,
            });
            self.reply.clone()
        }
    }

    fn request(language: Option<&str>) -> TranscribeRequest {
        TranscribeRequest {
            wav: b"RIFF\x00\x01WAVE".to_vec(),
            model: "gpt-4o-mini-transcribe".to_owned(),
            language: language.map(str::to_owned),
        }
    }

    fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }

    #[test]
    fn multipart_has_every_part() {
        let req = request(Some("vi"));
        let body = build_multipart("BOUND", &req);
        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with("--BOUND\r\n"));
        let file = "Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n";
        let at = find(&body, file.as_bytes()).expect("file part") + file.len();
        assert_eq!(&body[at..at + req.wav.len()], &req.wav[..]);
        assert_eq!(&body[at + req.wav.len()..at + req.wav.len() + 2], b"\r\n");
        assert!(text.contains("name=\"model\"\r\n\r\ngpt-4o-mini-transcribe\r\n"));
        assert!(text.contains("name=\"response_format\"\r\n\r\njson\r\n"));
        assert!(text.contains("name=\"language\"\r\n\r\nvi\r\n"));
        assert!(text.ends_with("--BOUND--\r\n"));
    }

    #[test]
    fn multipart_skips_an_unset_language() {
        let text = String::from_utf8_lossy(&build_multipart("B", &request(None))).into_owned();
        assert!(!text.contains("name=\"language\""));
        assert!(text.ends_with("--B--\r\n"));
    }

    #[test]
    fn transcribe_returns_trimmed_text() {
        let fake = FakeTransport::new(200, r#"{"text":" hello "}"#);
        assert_eq!(
            transcribe(&fake, "sk-test", &request(None)),
            Ok("hello".to_owned())
        );
        let seen = fake.seen.borrow();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            seen[0].url,
            "https://api.openai.com/v1/audio/transcriptions"
        );
        assert!(
            seen[0]
                .headers
                .contains(&("Authorization".to_owned(), "Bearer sk-test".to_owned()))
        );
        let content_type = &seen[0]
            .headers
            .iter()
            .find(|(n, _)| n == "Content-Type")
            .unwrap()
            .1;
        let boundary = content_type
            .strip_prefix("multipart/form-data; boundary=")
            .unwrap();
        assert!(
            seen[0]
                .body
                .ends_with(format!("--{boundary}--\r\n").as_bytes())
        );
    }

    #[test]
    fn statuses_map_to_errors() {
        let run = |status: u16, body: &str| {
            transcribe(&FakeTransport::new(status, body), "sk-test", &request(None))
        };
        assert_eq!(run(401, ""), Err(TranscribeError::BadKey));
        assert_eq!(run(403, ""), Err(TranscribeError::BadKey));
        assert_eq!(run(429, ""), Err(TranscribeError::RateLimited));
        assert_eq!(run(500, "oops"), Err(TranscribeError::Engine(500)));
        assert_eq!(run(200, r#"{"text":""}"#), Err(TranscribeError::Empty));
        assert_eq!(run(200, "not json"), Err(TranscribeError::Engine(200)));
        assert_eq!(
            transcribe(&FakeTransport::failing(), "sk-test", &request(None)),
            Err(TranscribeError::Offline)
        );
    }

    #[test]
    fn codes_are_stable() {
        assert_eq!(TranscribeError::BadKey.code(), "speech_bad_key");
        assert_eq!(TranscribeError::RateLimited.code(), "speech_rate_limited");
        assert_eq!(TranscribeError::Engine(500).code(), "speech_engine");
        assert_eq!(TranscribeError::Offline.code(), "speech_offline");
        assert_eq!(TranscribeError::Empty.code(), "speech_empty");
    }

    #[test]
    fn no_error_carries_the_key() {
        let echo = r#"{"error":{"message":"Incorrect API key provided: sk-test"}}"#;
        let mut errors = vec![
            TranscribeError::BadKey,
            TranscribeError::RateLimited,
            TranscribeError::Engine(500),
            TranscribeError::Offline,
            TranscribeError::Empty,
        ];
        for status in [400, 401, 500] {
            errors.push(
                transcribe(&FakeTransport::new(status, echo), "sk-test", &request(None))
                    .unwrap_err(),
            );
        }
        for e in errors {
            assert!(!format!("{e}").contains("sk-test"));
            assert!(!format!("{e:?}").contains("sk-test"));
        }
        assert!(!format!("{TransportError}").contains("sk-test"));
    }
}
