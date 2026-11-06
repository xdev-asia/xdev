//! The base protocol's framing: `Content-Length` headers, a blank line, then
//! a JSON body.

use std::io::{self, BufRead, Read, Write};

use serde_json::Value;

/// The largest body read, in bytes.
pub const MAX_BODY: usize = 32 * 1024 * 1024;
/// The longest header line read, in bytes.
const MAX_HEADER_LINE: u64 = 4096;

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("i/o: {0}")]
    Io(#[from] io::Error),
    #[error("a message without Content-Length")]
    NoLength,
    #[error("a header that does not parse")]
    BadHeader,
    /// The body was read and dropped; the next message is still in step.
    #[error("a message of {0} bytes is over the cap")]
    TooLarge(usize),
    /// The body was read; the next message is still in step.
    #[error("a body that is not JSON: {0}")]
    Json(#[from] serde_json::Error),
}

impl FrameError {
    /// The stream is still at a message boundary, so reading may go on.
    pub fn recoverable(&self) -> bool {
        matches!(self, FrameError::TooLarge(_) | FrameError::Json(_))
    }
}

/// The next message, or None at the end of the stream before a header.
pub fn read_message(r: &mut impl BufRead) -> Result<Option<Value>, FrameError> {
    let mut len = None;
    let mut seen = false;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = r
            .by_ref()
            .take(MAX_HEADER_LINE)
            .read_until(b'\n', &mut line)?;
        if n == 0 {
            if seen {
                return Err(io::Error::from(io::ErrorKind::UnexpectedEof).into());
            }
            return Ok(None);
        }
        if line.last() != Some(&b'\n') {
            return Err(FrameError::BadHeader);
        }
        let text = std::str::from_utf8(&line).map_err(|_| FrameError::BadHeader)?;
        let text = text.trim_end_matches(['\r', '\n']);
        if text.is_empty() {
            if seen {
                break;
            }
            // A stray blank line between messages.
            continue;
        }
        seen = true;
        let (name, value) = text.split_once(':').ok_or(FrameError::BadHeader)?;
        if name.trim().eq_ignore_ascii_case("content-length") {
            len = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| FrameError::BadHeader)?,
            );
        }
    }
    let len = len.ok_or(FrameError::NoLength)?;
    if len > MAX_BODY {
        io::copy(&mut r.by_ref().take(len as u64), &mut io::sink())?;
        return Err(FrameError::TooLarge(len));
    }
    let mut body = vec![0; len];
    r.read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body)?))
}

/// Writes one message and flushes it.
pub fn write_message(w: &mut impl Write, v: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(v)?;
    write!(w, "Content-Length: {}\r\n\r\n", body.len())?;
    w.write_all(&body)?;
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::BufReader;

    fn frame(body: &str) -> Vec<u8> {
        format!("Content-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
    }

    /// A reader that hands out at most `step` bytes a call.
    struct Trickle {
        bytes: Vec<u8>,
        at: usize,
        step: usize,
    }

    impl Read for Trickle {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.step.min(buf.len()).min(self.bytes.len() - self.at);
            buf[..n].copy_from_slice(&self.bytes[self.at..self.at + n]);
            self.at += n;
            Ok(n)
        }
    }

    #[test]
    fn two_messages_in_one_read() {
        let mut bytes = frame(r#"{"a":1}"#);
        bytes.extend(frame(r#"{"b":2}"#));
        let mut r = BufReader::new(&bytes[..]);
        assert_eq!(read_message(&mut r).unwrap(), Some(json!({"a": 1})));
        assert_eq!(read_message(&mut r).unwrap(), Some(json!({"b": 2})));
        assert_eq!(read_message(&mut r).unwrap(), None);
    }

    #[test]
    fn a_header_split_over_reads_and_other_headers_ignored() {
        let body = r#"{"jsonrpc":"2.0","method":"x"}"#;
        let bytes = format!(
            "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes();
        let mut r = BufReader::with_capacity(
            4,
            Trickle {
                bytes,
                at: 0,
                step: 3,
            },
        );
        assert_eq!(
            read_message(&mut r).unwrap(),
            Some(json!({"jsonrpc": "2.0", "method": "x"}))
        );
    }

    #[test]
    fn a_missing_length_fails() {
        let bytes = b"Content-Type: x\r\n\r\n{}".to_vec();
        let err = read_message(&mut BufReader::new(&bytes[..])).unwrap_err();
        assert!(matches!(err, FrameError::NoLength), "{err}");
        assert!(!err.recoverable());
    }

    #[test]
    fn an_oversize_body_is_skipped_and_the_next_message_reads() {
        let mut bytes = format!("Content-Length: {}\r\n\r\n", MAX_BODY + 1).into_bytes();
        bytes.resize(bytes.len() + MAX_BODY + 1, b' ');
        bytes.extend(frame("[1]"));
        let mut r = BufReader::new(&bytes[..]);
        let err = read_message(&mut r).unwrap_err();
        assert!(matches!(err, FrameError::TooLarge(n) if n == MAX_BODY + 1));
        assert!(err.recoverable());
        assert_eq!(read_message(&mut r).unwrap(), Some(json!([1])));
    }

    #[test]
    fn eof_before_a_header_is_none_and_inside_one_is_an_error() {
        assert_eq!(read_message(&mut BufReader::new(&b""[..])).unwrap(), None);
        let cut = b"Content-Length: 10\r\n".to_vec();
        assert!(matches!(
            read_message(&mut BufReader::new(&cut[..])),
            Err(FrameError::Io(_))
        ));
        let short = b"Content-Length: 10\r\n\r\n{}".to_vec();
        assert!(matches!(
            read_message(&mut BufReader::new(&short[..])),
            Err(FrameError::Io(_))
        ));
    }

    #[test]
    fn write_then_read_round_trips() {
        let mut out = Vec::new();
        let v = json!({"id": 1, "text": "héllo"});
        write_message(&mut out, &v).unwrap();
        assert!(out.starts_with(b"Content-Length: "));
        assert_eq!(
            read_message(&mut BufReader::new(&out[..])).unwrap(),
            Some(v)
        );
    }
}
