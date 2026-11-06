//! Handshake framing shared by the host and the dialer.
//!
//! The dialer's first message starts with one byte that picks the pattern:
//! - `0x10`: XXpsk3, psk from the 10-character code (desktops),
//! - `0x11`: IK, a peer that paired before,
//! - `0x12`: XXpsk3, psk = the offer secret (phones that scanned the link).
//!
//! Every later message until the link starts begins with `0x00` (a Noise
//! message follows) or `0xEE` (an ASCII error code follows, in plaintext; it
//! is one of the `LinkError` codes and carries nothing secret). Once the link
//! starts, messages are bare Noise transport messages.

use std::time::Instant;

use serde_json::Value;

use crate::error::LinkError;
use crate::frame::{self, Msg};
use crate::noise::Session;
use crate::wire::{Wire, recv_until};

pub const TAG_PAIR_CODE: u8 = 0x10;
pub const TAG_IK: u8 = 0x11;
pub const TAG_PAIR_SECRET: u8 = 0x12;
pub const OK: u8 = 0x00;
pub const REJECT: u8 = 0xEE;

pub const M_READY: &str = "pair.ready";
pub const M_CONFIRM: &str = "pair.confirm";
pub const M_RESULT: &str = "pair.result";

pub fn tagged(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + body.len());
    out.push(tag);
    out.extend_from_slice(body);
    out
}

pub fn send_ok(wire: &mut dyn Wire, body: &[u8]) -> Result<(), LinkError> {
    wire.send(&tagged(OK, body)).map_err(LinkError::from)
}

/// Sends a plaintext reject and closes.
pub fn reject(wire: &mut dyn Wire, err: &LinkError) {
    let _ = wire.send(&tagged(REJECT, err.code().as_bytes()));
    wire.close();
}

/// The body of one `0x00` message; a `0xEE` message becomes its error.
pub fn split(msg: &[u8]) -> Result<&[u8], LinkError> {
    match msg.split_first() {
        Some((&OK, body)) => Ok(body),
        Some((&REJECT, code)) => Err(LinkError::from_code(
            std::str::from_utf8(code).unwrap_or_default(),
        )),
        _ => Err(LinkError::BadFrame),
    }
}

pub fn recv_step(wire: &mut dyn Wire, deadline: Instant) -> Result<Vec<u8>, LinkError> {
    let msg = recv_until(wire, deadline)?;
    split(&msg).map(<[u8]>::to_vec)
}

/// An encrypted pairing-stage notice.
pub fn send_sealed(
    wire: &mut dyn Wire,
    session: &mut Session,
    m: &str,
    p: Value,
) -> Result<(), LinkError> {
    let plain = frame::encode(&Msg::Req {
        id: None,
        m: m.to_owned(),
        p,
    })?;
    let cipher = session.encrypt(&plain)?;
    send_ok(wire, &cipher)
}

/// Opens one pairing-stage notice: its method and params.
pub fn open_sealed(session: &mut Session, body: &[u8]) -> Result<(String, Value), LinkError> {
    let plain = session.decrypt(body)?;
    match frame::decode(&plain)? {
        Msg::Req { id: None, m, p } => Ok((m, p)),
        _ => Err(LinkError::BadFrame),
    }
}

pub fn recv_sealed(
    wire: &mut dyn Wire,
    session: &mut Session,
    deadline: Instant,
) -> Result<(String, Value), LinkError> {
    let body = recv_step(wire, deadline)?;
    open_sealed(session, &body)
}
