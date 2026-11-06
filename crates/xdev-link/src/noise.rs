//! Noise handshakes over `snow`.
//!
//! - Pairing: `Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s`, psk = the code's psk
//!   (desktops) or the offer secret (phones).
//! - Reconnect: `Noise_IK_25519_ChaChaPoly_BLAKE2s`; the dialer already knows
//!   the host's static key.

use snow::{Builder, HandshakeState, TransportState};

use crate::PROLOGUE;
use crate::error::LinkError;
use crate::identity::HostKey;

pub const XX_PSK3: &str = "Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s";
pub const IK: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
/// The largest Noise message.
pub const MSG_MAX: usize = 65_535;
/// The AEAD tag on every transport message.
pub const TAG_LEN: usize = 16;

pub struct Handshake {
    hs: HandshakeState,
}

/// An established Noise session. `Debug` shows neither keys nor hash.
pub struct Session {
    pub transport: TransportState,
    pub remote_pub: [u8; 32],
    pub hash: [u8; 32],
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("initiator", &self.transport.is_initiator())
            .finish_non_exhaustive()
    }
}

fn builder<'a>(pattern: &str, local: &'a HostKey) -> Result<Builder<'a>, LinkError> {
    let params = pattern.parse().map_err(|_| LinkError::Handshake)?;
    Ok(Builder::new(params)
        .local_private_key(local.private())?
        .prologue(PROLOGUE)?)
}

pub fn xx_psk_initiator(local: &HostKey, psk: &[u8; 32]) -> Result<Handshake, LinkError> {
    let hs = builder(XX_PSK3, local)?.psk(3, psk)?.build_initiator()?;
    Ok(Handshake { hs })
}

pub fn xx_psk_responder(local: &HostKey, psk: &[u8; 32]) -> Result<Handshake, LinkError> {
    let hs = builder(XX_PSK3, local)?.psk(3, psk)?.build_responder()?;
    Ok(Handshake { hs })
}

pub fn ik_initiator(local: &HostKey, remote_pub: &[u8; 32]) -> Result<Handshake, LinkError> {
    let hs = builder(IK, local)?
        .remote_public_key(remote_pub)?
        .build_initiator()?;
    Ok(Handshake { hs })
}

pub fn ik_responder(local: &HostKey) -> Result<Handshake, LinkError> {
    let hs = builder(IK, local)?.build_responder()?;
    Ok(Handshake { hs })
}

impl Handshake {
    pub fn write(&mut self, payload: &[u8]) -> Result<Vec<u8>, LinkError> {
        let mut buf = vec![0u8; MSG_MAX];
        let n = self.hs.write_message(payload, &mut buf)?;
        buf.truncate(n);
        Ok(buf)
    }

    pub fn read(&mut self, msg: &[u8]) -> Result<Vec<u8>, LinkError> {
        let mut buf = vec![0u8; MSG_MAX];
        let n = self.hs.read_message(msg, &mut buf)?;
        buf.truncate(n);
        Ok(buf)
    }

    /// The peer's static key once the handshake has carried it.
    pub fn remote_static(&self) -> Option<[u8; 32]> {
        self.hs.get_remote_static()?.try_into().ok()
    }

    pub fn is_finished(&self) -> bool {
        self.hs.is_handshake_finished()
    }

    pub fn finish(self) -> Result<Session, LinkError> {
        let remote_pub = self.remote_static().ok_or(LinkError::Handshake)?;
        let hash: [u8; 32] = self
            .hs
            .get_handshake_hash()
            .try_into()
            .map_err(|_| LinkError::Handshake)?;
        let transport = self.hs.into_transport_mode()?;
        Ok(Session {
            transport,
            remote_pub,
            hash,
        })
    }
}

impl Session {
    pub fn is_initiator(&self) -> bool {
        self.transport.is_initiator()
    }

    pub fn encrypt(&mut self, plain: &[u8]) -> Result<Vec<u8>, LinkError> {
        if plain.len() + TAG_LEN > MSG_MAX {
            return Err(LinkError::BadFrame);
        }
        let mut buf = vec![0u8; plain.len() + TAG_LEN];
        let n = self.transport.write_message(plain, &mut buf)?;
        buf.truncate(n);
        Ok(buf)
    }

    pub fn decrypt(&mut self, msg: &[u8]) -> Result<Vec<u8>, LinkError> {
        let mut buf = vec![0u8; msg.len()];
        let n = self
            .transport
            .read_message(msg, &mut buf)
            .map_err(|_| LinkError::BadFrame)?;
        buf.truncate(n);
        Ok(buf)
    }
}

/// Six digits from the handshake hash, shown `482 913` on both screens.
pub fn sas(hash: &[u8]) -> String {
    let mut first = [0u8; 4];
    first.copy_from_slice(&hash[..4]);
    let n = u32::from_be_bytes(first) % 1_000_000;
    let s = format!("{n:06}");
    format!("{} {}", &s[..3], &s[3..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> (HostKey, HostKey) {
        (
            HostKey::from_private([1u8; 32]).unwrap(),
            HostKey::from_private([2u8; 32]).unwrap(),
        )
    }

    fn run_xx(psk_i: [u8; 32], psk_r: [u8; 32]) -> Result<(Session, Session), LinkError> {
        let (a, b) = keys();
        let mut i = xx_psk_initiator(&a, &psk_i)?;
        let mut r = xx_psk_responder(&b, &psk_r)?;
        let m1 = i.write(b"")?;
        r.read(&m1)?;
        let m2 = r.write(b"")?;
        i.read(&m2)?;
        let m3 = i.write(b"hi")?;
        assert_eq!(r.read(&m3)?, b"hi");
        Ok((i.finish()?, r.finish()?))
    }

    #[test]
    fn xx_same_hash_and_keys() {
        let (mut i, mut r) = run_xx([5; 32], [5; 32]).unwrap();
        assert_eq!(sas(&i.hash), sas(&r.hash));
        assert_eq!(i.remote_pub, keys().1.public());
        assert_eq!(r.remote_pub, keys().0.public());
        let c = i.encrypt(b"ping").unwrap();
        assert_eq!(r.decrypt(&c).unwrap(), b"ping");
    }

    #[test]
    fn xx_wrong_psk_fails() {
        assert!(run_xx([5; 32], [6; 32]).is_err());
    }

    #[test]
    fn ik_round_trip() {
        let (a, b) = keys();
        let mut i = ik_initiator(&a, &b.public()).unwrap();
        let mut r = ik_responder(&b).unwrap();
        r.read(&i.write(b"").unwrap()).unwrap();
        assert_eq!(r.remote_static(), Some(a.public()));
        i.read(&r.write(b"").unwrap()).unwrap();
        let (i, r) = (i.finish().unwrap(), r.finish().unwrap());
        assert_eq!(i.hash, r.hash);
    }

    #[test]
    fn sas_format() {
        let mut hash = [0u8; 32];
        hash[..4].copy_from_slice(&482_913u32.to_be_bytes());
        assert_eq!(sas(&hash), "482 913");
        hash[..4].copy_from_slice(&7u32.to_be_bytes());
        assert_eq!(sas(&hash), "000 007");
        hash[..4].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(sas(&hash), "967 295");
    }
}
