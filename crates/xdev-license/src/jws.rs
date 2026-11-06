//! Compact JWS with EdDSA (Ed25519) only: three base64url parts, no padding, a JSON object
//! header and payload, and a 64-byte signature checked with `verify_strict`.

use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;

use crate::b64;

/// The entitlement token.
pub const ENT_TYP: &str = "xdev-ent+jwt";
/// A signing-key certificate, signed by a root.
pub const KEY_TYP: &str = "xdev-key+jwt";
const TYPS: &[&str] = &[ENT_TYP, KEY_TYP];

/// Why a token or certificate does not verify. Expiry is not one: grace decides.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum VerifyError {
    #[error("malformed")]
    Malformed,
    #[error("bad_alg")]
    BadAlg,
    #[error("unknown_kid")]
    UnknownKid,
    #[error("bad_signature")]
    BadSignature,
    #[error("not_yet_valid")]
    NotYetValid,
    #[error("wrong_aud")]
    WrongAud,
    #[error("wrong_iss")]
    WrongIss,
    #[error("wrong_device")]
    WrongDevice,
    #[error("revoked_kid")]
    RevokedKid,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Header {
    pub alg: String,
    #[serde(default)]
    pub typ: Option<String>,
    #[serde(default)]
    pub kid: Option<String>,
}

/// A parsed, not yet verified, compact JWS. `payload_json` is owned: it is decoded bytes.
#[derive(Clone, Debug)]
pub struct Jws<'a> {
    pub header: Header,
    pub payload_json: Vec<u8>,
    pub signing_input: &'a str,
    pub sig: [u8; 64],
}

fn json_object(bytes: &[u8]) -> Option<serde_json::Map<String, serde_json::Value>> {
    match serde_json::from_slice(bytes).ok()? {
        serde_json::Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Malformed shape first, then the algorithm and type (`BadAlg`).
pub fn parse(compact: &str) -> Result<Jws<'_>, VerifyError> {
    let mut parts = compact.split('.');
    let (Some(h), Some(p), Some(s), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(VerifyError::Malformed);
    };
    let header_bytes = b64::decode(h).ok_or(VerifyError::Malformed)?;
    let payload_json = b64::decode(p).ok_or(VerifyError::Malformed)?;
    let sig_bytes = b64::decode(s).ok_or(VerifyError::Malformed)?;
    let header_map = json_object(&header_bytes).ok_or(VerifyError::Malformed)?;
    json_object(&payload_json).ok_or(VerifyError::Malformed)?;
    let sig: [u8; 64] = sig_bytes.try_into().map_err(|_| VerifyError::Malformed)?;
    let header: Header = serde_json::from_value(serde_json::Value::Object(header_map))
        .map_err(|_| VerifyError::Malformed)?;
    if header.alg != "EdDSA" || !header.typ.as_deref().is_some_and(|t| TYPS.contains(&t)) {
        return Err(VerifyError::BadAlg);
    }
    let signing_input = &compact[..h.len() + 1 + p.len()];
    Ok(Jws {
        header,
        payload_json,
        signing_input,
        sig,
    })
}

impl Jws<'_> {
    /// `verify_strict`: rejects a non-canonical `s` and small-order keys.
    pub fn verify_with(&self, key: &VerifyingKey) -> Result<(), VerifyError> {
        key.verify_strict(
            self.signing_input.as_bytes(),
            &Signature::from_bytes(&self.sig),
        )
        .map_err(|_| VerifyError::BadSignature)
    }

    pub fn typ(&self) -> &str {
        self.header.typ.as_deref().unwrap_or("")
    }
}

/// Signs `header.payload` with a raw Ed25519 seed. Both are JSON text, kept byte for byte.
/// Test and mock use only.
#[cfg(any(test, feature = "test-util"))]
pub fn sign(header_json: &str, payload: &[u8], seed: &[u8; 32]) -> String {
    use ed25519_dalek::{Signer, SigningKey};
    let input = format!(
        "{}.{}",
        b64::encode(header_json.as_bytes()),
        b64::encode(payload)
    );
    let sig = SigningKey::from_bytes(seed).sign(input.as_bytes());
    format!("{input}.{}", b64::encode(&sig.to_bytes()))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) struct Golden {
        pub token: String,
        pub public: [u8; 32],
        pub claims: serde_json::Value,
        pub kid: String,
    }

    pub(crate) fn golden() -> Golden {
        let raw = include_str!("../tests/vectors/ent-v1.json");
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let hex = v["publicKeyHex"].as_str().unwrap();
        let mut public = [0u8; 32];
        for (i, byte) in public.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        Golden {
            token: v["token"].as_str().unwrap().to_owned(),
            public,
            claims: v["claims"].clone(),
            kid: v["kid"].as_str().unwrap().to_owned(),
        }
    }

    fn key() -> VerifyingKey {
        VerifyingKey::from_bytes(&golden().public).unwrap()
    }

    fn parts(token: &str) -> Vec<String> {
        token.split('.').map(str::to_owned).collect()
    }

    #[test]
    fn parses_golden_vector() {
        let g = golden();
        let jws = parse(&g.token).unwrap();
        assert_eq!(jws.header.alg, "EdDSA");
        assert_eq!(jws.typ(), ENT_TYP);
        assert_eq!(jws.header.kid.as_deref(), Some(g.kid.as_str()));
        let payload: serde_json::Value = serde_json::from_slice(&jws.payload_json).unwrap();
        assert_eq!(payload, g.claims);
        jws.verify_with(&key()).unwrap();
    }

    #[test]
    fn rejects_two_parts() {
        let p = parts(&golden().token);
        assert_eq!(
            parse(&format!("{}.{}", p[0], p[1])).unwrap_err(),
            VerifyError::Malformed
        );
        assert_eq!(
            parse(&format!("{}.{}.{}.x", p[0], p[1], p[2])).unwrap_err(),
            VerifyError::Malformed
        );
    }

    #[test]
    fn rejects_padding() {
        let p = parts(&golden().token);
        assert_eq!(
            parse(&format!("{}.{}.{}=", p[0], p[1], p[2])).unwrap_err(),
            VerifyError::Malformed
        );
    }

    fn with_header(header: &str) -> String {
        let p = parts(&golden().token);
        format!("{}.{}.{}", b64::encode(header.as_bytes()), p[1], p[2])
    }

    #[test]
    fn rejects_alg_none() {
        let t = with_header(r#"{"alg":"none","typ":"xdev-ent+jwt","kid":"ent-test"}"#);
        assert_eq!(parse(&t).unwrap_err(), VerifyError::BadAlg);
    }

    #[test]
    fn rejects_alg_hs256() {
        let t = with_header(r#"{"alg":"HS256","typ":"xdev-ent+jwt","kid":"ent-test"}"#);
        assert_eq!(parse(&t).unwrap_err(), VerifyError::BadAlg);
    }

    #[test]
    fn rejects_unknown_typ() {
        let t = with_header(r#"{"alg":"EdDSA","typ":"JWT","kid":"ent-test"}"#);
        assert_eq!(parse(&t).unwrap_err(), VerifyError::BadAlg);
    }

    #[test]
    fn rejects_flipped_signature_byte() {
        let p = parts(&golden().token);
        let mut sig = b64::decode(&p[2]).unwrap();
        sig[5] ^= 0x01;
        let t = format!("{}.{}.{}", p[0], p[1], b64::encode(&sig));
        assert_eq!(
            parse(&t).unwrap().verify_with(&key()).unwrap_err(),
            VerifyError::BadSignature
        );
    }

    #[test]
    fn rejects_flipped_payload_byte() {
        let p = parts(&golden().token);
        let mut payload = b64::decode(&p[1]).unwrap();
        // Inside the "sub" value, so the payload stays valid JSON.
        let at = payload
            .windows(6)
            .position(|w| w == b"golden")
            .expect("sub has golden");
        payload[at] = b'G';
        let t = format!("{}.{}.{}", p[0], b64::encode(&payload), p[2]);
        assert_eq!(
            parse(&t).unwrap().verify_with(&key()).unwrap_err(),
            VerifyError::BadSignature
        );
    }

    /// The group order L, little-endian.
    const L: [u8; 32] = [
        0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde,
        0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
    ];

    #[test]
    fn rejects_non_canonical_s() {
        let p = parts(&golden().token);
        let mut sig = b64::decode(&p[2]).unwrap();
        // s + L is the same scalar mod L; verify_strict must still refuse it.
        let mut carry = 0u16;
        for i in 0..32 {
            let sum = u16::from(sig[32 + i]) + u16::from(L[i]) + carry;
            sig[32 + i] = (sum & 0xff) as u8;
            carry = sum >> 8;
        }
        assert_eq!(carry, 0);
        let t = format!("{}.{}.{}", p[0], p[1], b64::encode(&sig));
        assert_eq!(
            parse(&t).unwrap().verify_with(&key()).unwrap_err(),
            VerifyError::BadSignature
        );
    }

    #[test]
    fn rejects_short_signature_and_non_object_payload() {
        let p = parts(&golden().token);
        let t = format!("{}.{}.{}", p[0], p[1], b64::encode(&[0u8; 63]));
        assert_eq!(parse(&t).unwrap_err(), VerifyError::Malformed);
        let t = format!("{}.{}.{}", p[0], b64::encode(b"[1,2]"), p[2]);
        assert_eq!(parse(&t).unwrap_err(), VerifyError::Malformed);
    }
}
