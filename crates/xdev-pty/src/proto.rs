//! The frames between the app and `xdev-ptyd`.
//!
//! Wire: u32 length (LE), u8 kind, body. Control bodies are JSON; Output is
//! id + u64 seq + bytes. A reader skips a kind it does not know.

use std::io::{self, Read, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const PROTOCOL: u32 = 1;
pub const FRAME_MAX: usize = 1024 * 1024;
pub const RING_DEFAULT: usize = 2 * 1024 * 1024;
pub const RING_MAX: usize = 16 * 1024 * 1024;

/// JSON keeps the tag in the body too, so a body read under the wrong kind
/// fails instead of passing for another frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Frame {
    Hello {
        protocol: u32,
        minor: u32,
        token: String,
        app_version: String,
    },
    Welcome {
        protocol: u32,
        minor: u32,
        features: Vec<String>,
        service_version: String,
        pid: u32,
    },
    Spawn {
        id: String,
        program: PathBuf,
        args: Vec<String>,
        env: Vec<(String, String)>,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        meta: serde_json::Value,
    },
    Spawned {
        id: String,
        pid: Option<u32>,
    },
    Write {
        id: String,
        data: Vec<u8>,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
    },
    Ack {
        id: String,
        n: u64,
    },
    Kill {
        id: String,
    },
    List,
    Sessions {
        sessions: Vec<SessionInfo>,
    },
    Attach {
        id: String,
        from_seq: u64,
    },
    Detach {
        id: String,
    },
    Output {
        id: String,
        seq: u64,
        data: Vec<u8>,
    },
    Gap {
        id: String,
        lost: u64,
    },
    Detached {
        id: String,
        reason: String,
    },
    Exited {
        id: String,
        code: Option<i32>,
    },
    QuitAll,
    /// Empties the ring and the snapshot of one PTY; it keeps running.
    ClearScrollback {
        id: String,
    },
    Cleared {
        id: String,
    },
    Error {
        id: Option<String>,
        code: String,
    },
}

/// One PTY the service holds, for the sessions list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub pid: Option<u32>,
    pub program: String,
    pub cwd: String,
    pub started_ms: i64,
    pub last_output_ms: i64,
    pub last_input_ms: i64,
    /// What the app passed at spawn: `{ worktree, tabId, profile }`.
    #[cfg_attr(
        feature = "ts",
        ts(type = "{ worktree?: string, tabId?: string, profile?: string }")
    )]
    pub meta: serde_json::Value,
    pub attached: bool,
    pub exited: Option<i32>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProtoError {
    #[error("frame larger than {FRAME_MAX} bytes")]
    TooLarge,
    #[error("bad frame: {0}")]
    Bad(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

const KIND_HELLO: u8 = 1;
const KIND_WELCOME: u8 = 2;
const KIND_SPAWN: u8 = 3;
const KIND_SPAWNED: u8 = 4;
const KIND_WRITE: u8 = 5;
const KIND_RESIZE: u8 = 6;
const KIND_ACK: u8 = 7;
const KIND_KILL: u8 = 8;
const KIND_LIST: u8 = 9;
const KIND_SESSIONS: u8 = 10;
const KIND_ATTACH: u8 = 11;
const KIND_DETACH: u8 = 12;
const KIND_OUTPUT: u8 = 13;
const KIND_GAP: u8 = 14;
const KIND_DETACHED: u8 = 15;
const KIND_EXITED: u8 = 16;
const KIND_QUIT_ALL: u8 = 17;
const KIND_ERROR: u8 = 18;
const KIND_CLEAR_SCROLLBACK: u8 = 19;
const KIND_CLEARED: u8 = 20;

fn kind(f: &Frame) -> u8 {
    match f {
        Frame::Hello { .. } => KIND_HELLO,
        Frame::Welcome { .. } => KIND_WELCOME,
        Frame::Spawn { .. } => KIND_SPAWN,
        Frame::Spawned { .. } => KIND_SPAWNED,
        Frame::Write { .. } => KIND_WRITE,
        Frame::Resize { .. } => KIND_RESIZE,
        Frame::Ack { .. } => KIND_ACK,
        Frame::Kill { .. } => KIND_KILL,
        Frame::List => KIND_LIST,
        Frame::Sessions { .. } => KIND_SESSIONS,
        Frame::Attach { .. } => KIND_ATTACH,
        Frame::Detach { .. } => KIND_DETACH,
        Frame::Output { .. } => KIND_OUTPUT,
        Frame::Gap { .. } => KIND_GAP,
        Frame::Detached { .. } => KIND_DETACHED,
        Frame::Exited { .. } => KIND_EXITED,
        Frame::QuitAll => KIND_QUIT_ALL,
        Frame::Error { .. } => KIND_ERROR,
        Frame::ClearScrollback { .. } => KIND_CLEAR_SCROLLBACK,
        Frame::Cleared { .. } => KIND_CLEARED,
    }
}

/// The room an Output or Write body leaves for its data, with the longest id
/// the binary layout holds; the sender splits bigger chunks.
pub const DATA_MAX: usize = FRAME_MAX - 1 - 2 - u8::MAX as usize - 8;

pub fn write_frame(w: &mut impl Write, f: &Frame) -> io::Result<()> {
    let kind = kind(f);
    let body = match f {
        // Terminal bytes go as they are; JSON would make each byte a number.
        Frame::Write { id, data } => binary(id, None, data)?,
        Frame::Output { id, seq, data } => binary(id, Some(*seq), data)?,
        _ => serde_json::to_vec(f)?,
    };
    let len = body.len() + 1;
    if len > FRAME_MAX {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            ProtoError::TooLarge,
        ));
    }
    // One write per frame: two threads may share the stream behind a lock.
    let mut buf = Vec::with_capacity(4 + len);
    buf.extend((len as u32).to_le_bytes());
    buf.push(kind);
    buf.extend(body);
    w.write_all(&buf)?;
    w.flush()
}

/// u8 id length, id, the u64 seq (Output only), the data.
fn binary(id: &str, seq: Option<u64>, data: &[u8]) -> io::Result<Vec<u8>> {
    let id_len = u8::try_from(id.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "pty id too long"))?;
    let mut body = Vec::with_capacity(1 + id.len() + 8 + data.len());
    body.push(id_len);
    body.extend(id.as_bytes());
    if let Some(seq) = seq {
        body.extend(seq.to_le_bytes());
    }
    body.extend(data);
    Ok(body)
}

/// `None` at a clean end of stream, between frames. A kind this build does
/// not know is skipped.
pub fn read_frame(r: &mut impl Read) -> Result<Option<Frame>, ProtoError> {
    loop {
        let mut head = [0u8; 4];
        match r.read(&mut head[..1])? {
            0 => return Ok(None),
            _ => r.read_exact(&mut head[1..])?,
        }
        let len = u32::from_le_bytes(head) as usize;
        if len > FRAME_MAX {
            return Err(ProtoError::TooLarge);
        }
        if len == 0 {
            return Err(ProtoError::Bad("empty frame".into()));
        }
        let mut buf = vec![0u8; len];
        r.read_exact(&mut buf)?;
        let (kind, body) = (buf[0], &buf[1..]);
        let frame = match kind {
            KIND_WRITE => {
                let (id, data) = unbinary(body, false)?;
                Frame::Write {
                    id,
                    data: data.to_vec(),
                }
            }
            KIND_OUTPUT => {
                let (id, rest) = unbinary(body, true)?;
                let (seq, data) = rest.split_at(8);
                Frame::Output {
                    id,
                    seq: u64::from_le_bytes(seq.try_into().expect("8 bytes")),
                    data: data.to_vec(),
                }
            }
            KIND_HELLO..=KIND_CLEARED => {
                let f: Frame =
                    serde_json::from_slice(body).map_err(|e| ProtoError::Bad(e.to_string()))?;
                if self::kind(&f) != kind {
                    return Err(ProtoError::Bad(format!("kind {kind} holds another frame")));
                }
                f
            }
            // A newer peer's frame; its length lets this one step over it.
            _ => continue,
        };
        return Ok(Some(frame));
    }
}

fn unbinary(body: &[u8], seq: bool) -> Result<(String, &[u8]), ProtoError> {
    let bad = || ProtoError::Bad("short binary frame".into());
    let (&id_len, rest) = body.split_first().ok_or_else(bad)?;
    let id_len = usize::from(id_len);
    if rest.len() < id_len + if seq { 8 } else { 0 } {
        return Err(bad());
    }
    let (id, rest) = rest.split_at(id_len);
    let id = String::from_utf8(id.to_vec()).map_err(|_| ProtoError::Bad("pty id".into()))?;
    Ok((id, rest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn every_frame() -> Vec<Frame> {
        let id = || "tab-1".to_owned();
        vec![
            Frame::Hello {
                protocol: PROTOCOL,
                minor: 0,
                token: "ab".repeat(32),
                app_version: "0.4.0".into(),
            },
            Frame::Welcome {
                protocol: PROTOCOL,
                minor: 2,
                features: vec!["ring".into()],
                service_version: "0.4.0".into(),
                pid: 42,
            },
            Frame::Spawn {
                id: id(),
                program: "/bin/sh".into(),
                args: vec!["-c".into(), "echo hi".into()],
                env: vec![("A".into(), "1".into())],
                cwd: "/tmp".into(),
                cols: 80,
                rows: 24,
                meta: serde_json::json!({ "worktree": "/w", "tabId": "t1", "profile": "shell" }),
            },
            Frame::Spawned {
                id: id(),
                pid: Some(7),
            },
            Frame::Write {
                id: id(),
                data: vec![0, 1, 255, b'\n'],
            },
            Frame::Resize {
                id: id(),
                cols: 120,
                rows: 40,
            },
            Frame::Ack {
                id: id(),
                n: 1 << 40,
            },
            Frame::Kill { id: id() },
            Frame::List,
            Frame::Sessions {
                sessions: vec![SessionInfo {
                    id: id(),
                    pid: None,
                    program: "sh".into(),
                    cwd: "/".into(),
                    started_ms: 1,
                    last_output_ms: 2,
                    last_input_ms: 3,
                    meta: serde_json::Value::Null,
                    attached: true,
                    exited: Some(1),
                }],
            },
            Frame::Attach {
                id: id(),
                from_seq: 99,
            },
            Frame::Detach { id: id() },
            Frame::Output {
                id: id(),
                seq: u64::MAX - 1,
                data: b"\x1b[31mred\x1b[0m".to_vec(),
            },
            Frame::Gap { id: id(), lost: 5 },
            Frame::Detached {
                id: id(),
                reason: "taken".into(),
            },
            Frame::Exited {
                id: id(),
                code: None,
            },
            Frame::QuitAll,
            Frame::Error {
                id: None,
                code: "pty_gone".into(),
            },
            Frame::ClearScrollback { id: id() },
            Frame::Cleared { id: id() },
        ]
    }

    fn encode(frames: &[Frame]) -> Vec<u8> {
        let mut buf = Vec::new();
        for f in frames {
            write_frame(&mut buf, f).unwrap();
        }
        buf
    }

    #[test]
    fn every_frame_round_trips() {
        let frames = every_frame();
        let mut r = Cursor::new(encode(&frames));
        for want in &frames {
            assert_eq!(read_frame(&mut r).unwrap().as_ref(), Some(want));
        }
        assert!(read_frame(&mut r).unwrap().is_none());
    }

    #[test]
    fn output_is_raw_bytes_not_json() {
        let data = vec![7u8; 1000];
        let buf = encode(&[Frame::Output {
            id: "x".into(),
            seq: 0,
            data,
        }]);
        assert!(buf.len() < 1100, "{}", buf.len());
    }

    #[test]
    fn a_frame_over_the_limit_is_too_large() {
        let mut buf = Vec::new();
        buf.extend(((FRAME_MAX + 1) as u32).to_le_bytes());
        buf.push(KIND_OUTPUT);
        assert!(matches!(
            read_frame(&mut Cursor::new(buf)),
            Err(ProtoError::TooLarge)
        ));
        let big = Frame::Write {
            id: "x".into(),
            data: vec![0; FRAME_MAX],
        };
        assert!(write_frame(&mut Vec::new(), &big).is_err());
    }

    #[test]
    fn an_unknown_kind_is_skipped() {
        let mut buf = Vec::new();
        buf.extend(4u32.to_le_bytes());
        buf.extend([200, 1, 2, 3]);
        buf.extend(encode(&[Frame::List]));
        assert_eq!(
            read_frame(&mut Cursor::new(buf)).unwrap(),
            Some(Frame::List)
        );
    }

    #[test]
    fn clear_scrollback_round_trips() {
        let frames = [
            Frame::ClearScrollback { id: "t".into() },
            Frame::Cleared { id: "t".into() },
        ];
        let mut r = Cursor::new(encode(&frames));
        for want in &frames {
            assert_eq!(read_frame(&mut r).unwrap().as_ref(), Some(want));
        }
    }

    #[test]
    fn old_reader_skips_kind_19() {
        // A reader from before kinds 19 and 20 steps over them by length.
        let mut buf = encode(&[Frame::ClearScrollback { id: "t".into() }]);
        buf.extend(encode(&[Frame::List]));
        assert_eq!(buf[4], KIND_CLEAR_SCROLLBACK);
        // Simulate the old reader: the kind falls to the unknown arm.
        buf[4] = 200;
        assert_eq!(
            read_frame(&mut Cursor::new(buf)).unwrap(),
            Some(Frame::List)
        );
    }

    #[test]
    fn a_truncated_frame_is_an_error() {
        let full = encode(&[Frame::Kill { id: "abc".into() }]);
        for cut in [2, 5, full.len() - 1] {
            assert!(
                read_frame(&mut Cursor::new(&full[..cut])).is_err(),
                "cut at {cut}"
            );
        }
        // A body that is not the kind it says.
        let mut bad = Vec::new();
        bad.extend(3u32.to_le_bytes());
        bad.extend([KIND_KILL, b'{', b'}']);
        assert!(matches!(
            read_frame(&mut Cursor::new(bad)),
            Err(ProtoError::Bad(_))
        ));
    }
}
