//! The plaintext inside one Noise transport message.
//!
//! - Byte 0 `{`: JSON. `{id?, m, p}` is a request (with `id`) or a notice
//!   (without); `{id, r}` a result; `{id, e:{code, msg}}` an error.
//! - Byte 0 `0x01`: a stream frame `[0x01][u32 BE stream id][bytes]`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::LinkError;
use crate::noise::{MSG_MAX, TAG_LEN};

/// The largest plaintext one frame carries.
pub const PLAIN_MAX: usize = MSG_MAX - TAG_LEN;
pub const STREAM_TAG: u8 = 0x01;
const STREAM_HEADER: usize = 5;
/// The largest chunk of stream bytes in one frame.
pub const STREAM_CHUNK: usize = PLAIN_MAX - STREAM_HEADER;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: String,
    #[serde(default)]
    pub msg: String,
}

impl RpcError {
    pub fn new(code: &str, msg: &str) -> RpcError {
        RpcError {
            code: code.into(),
            msg: msg.into(),
        }
    }

    pub fn code(code: &str) -> RpcError {
        RpcError::new(code, "")
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.code)
    }
}

impl std::error::Error for RpcError {}

#[derive(Debug, Clone, PartialEq)]
pub enum Msg {
    /// A request when `id` is set, a notice otherwise.
    Req {
        id: Option<u64>,
        m: String,
        p: Value,
    },
    Res {
        id: u64,
        r: Value,
    },
    Err {
        id: u64,
        e: RpcError,
    },
    Stream {
        id: u32,
        data: Vec<u8>,
    },
}

#[derive(Serialize, Deserialize)]
struct Json {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    m: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    p: Option<Value>,
    /// `Some(Null)` for `"r": null`; plain `Option` would read it as absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    r: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    e: Option<RpcError>,
}

fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

pub fn encode(msg: &Msg) -> Result<Vec<u8>, LinkError> {
    let out = match msg {
        Msg::Stream { id, data } => {
            let mut out = Vec::with_capacity(STREAM_HEADER + data.len());
            out.push(STREAM_TAG);
            out.extend_from_slice(&id.to_be_bytes());
            out.extend_from_slice(data);
            out
        }
        Msg::Req { id, m, p } => serde_json::to_vec(&Json {
            id: *id,
            m: Some(m.clone()),
            p: Some(p.clone()),
            r: None,
            e: None,
        })
        .map_err(|_| LinkError::BadFrame)?,
        Msg::Res { id, r } => serde_json::to_vec(&Json {
            id: Some(*id),
            m: None,
            p: None,
            // `null` must survive, so a result is always present.
            r: Some(r.clone()),
            e: None,
        })
        .map_err(|_| LinkError::BadFrame)?,
        Msg::Err { id, e } => serde_json::to_vec(&Json {
            id: Some(*id),
            m: None,
            p: None,
            r: None,
            e: Some(e.clone()),
        })
        .map_err(|_| LinkError::BadFrame)?,
    };
    if out.len() > PLAIN_MAX {
        return Err(LinkError::BadFrame);
    }
    Ok(out)
}

pub fn decode(buf: &[u8]) -> Result<Msg, LinkError> {
    if buf.len() > PLAIN_MAX {
        return Err(LinkError::BadFrame);
    }
    match buf.first() {
        Some(&STREAM_TAG) => {
            if buf.len() < STREAM_HEADER {
                return Err(LinkError::BadFrame);
            }
            let id = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]);
            Ok(Msg::Stream {
                id,
                data: buf[STREAM_HEADER..].to_vec(),
            })
        }
        Some(b'{') => {
            let j: Json = serde_json::from_slice(buf).map_err(|_| LinkError::BadFrame)?;
            match (j.id, j.m, j.r, j.e) {
                (id, Some(m), None, None) => Ok(Msg::Req {
                    id,
                    m,
                    p: j.p.unwrap_or(Value::Null),
                }),
                (Some(id), None, Some(r), None) => Ok(Msg::Res { id, r }),
                (Some(id), None, None, Some(e)) => Ok(Msg::Err { id, e }),
                _ => Err(LinkError::BadFrame),
            }
        }
        _ => Err(LinkError::BadFrame),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round(m: Msg) {
        assert_eq!(decode(&encode(&m).unwrap()).unwrap(), m);
    }

    #[test]
    fn json_frames_round_trip() {
        round(Msg::Req {
            id: Some(7),
            m: "terms.list".into(),
            p: json!({}),
        });
        round(Msg::Req {
            id: None,
            m: "ping".into(),
            p: Value::Null,
        });
        round(Msg::Res {
            id: 7,
            r: Value::Null,
        });
        round(Msg::Err {
            id: 7,
            e: RpcError::new("peer_role", "viewer"),
        });
    }

    #[test]
    fn wire_shape() {
        let b = encode(&Msg::Req {
            id: Some(1),
            m: "hello".into(),
            p: json!({"a":1}),
        })
        .unwrap();
        assert_eq!(b[0], b'{');
        let v: Value = serde_json::from_slice(&b).unwrap();
        assert_eq!(v, json!({"id":1,"m":"hello","p":{"a":1}}));
        let e = encode(&Msg::Err {
            id: 2,
            e: RpcError::new("x", "y"),
        })
        .unwrap();
        let v: Value = serde_json::from_slice(&e).unwrap();
        assert_eq!(v, json!({"id":2,"e":{"code":"x","msg":"y"}}));
    }

    #[test]
    fn stream_frame() {
        let m = Msg::Stream {
            id: 0x0102_0304,
            data: b"abc".to_vec(),
        };
        let b = encode(&m).unwrap();
        assert_eq!(&b[..5], &[1, 1, 2, 3, 4]);
        round(m);
        round(Msg::Stream {
            id: 1,
            data: Vec::new(),
        });
        assert!(decode(&[1, 0, 0]).is_err());
    }

    #[test]
    fn max_size() {
        round(Msg::Stream {
            id: 1,
            data: vec![7; STREAM_CHUNK],
        });
        assert!(
            encode(&Msg::Stream {
                id: 1,
                data: vec![7; STREAM_CHUNK + 1],
            })
            .is_err()
        );
        assert!(decode(&vec![1u8; PLAIN_MAX + 1]).is_err());
        assert_eq!(PLAIN_MAX, 65_519);
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(decode(b"").is_err());
        assert!(decode(b"x").is_err());
        assert!(decode(b"{\"id\":1}").is_err());
        assert!(decode(b"{\"id\":1,\"r\":1,\"e\":{\"code\":\"a\"}}").is_err());
    }
}
