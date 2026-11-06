//! Signing-key certificates: `typ: "xdev-key+jwt"`, signed by a pinned root, valid for
//! `nbf <= now < exp`, for one use. Certificates that fail any check are dropped, not errors.

use std::collections::HashMap;

use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};

use crate::b64;
use crate::jws::{self, KEY_TYP, VerifyError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyUse {
    Ent,
    Access,
    Push,
}

impl KeyUse {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyUse::Ent => "ent",
            KeyUse::Access => "access",
            KeyUse::Push => "push",
        }
    }
}

/// The certificate payload, in the server's key order.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CertClaims {
    pub kid: String,
    #[serde(rename = "use")]
    pub key_use: String,
    /// base64url of the raw 32-byte Ed25519 public key.
    #[serde(rename = "pub")]
    pub public: String,
    pub nbf: i64,
    pub exp: i64,
}

/// kid -> verifying key, for one use, plus the kids the service revoked.
#[derive(Clone, Debug, Default)]
pub struct KeySet {
    keys: HashMap<String, VerifyingKey>,
    revoked: Vec<String>,
}

impl KeySet {
    /// The `ent` keys: what verifies an entitlement token.
    pub fn from_certs(
        certs: &[String],
        roots: &[[u8; 32]],
        now: i64,
        revoked_kids: &[String],
    ) -> KeySet {
        KeySet::from_certs_for(certs, roots, now, revoked_kids, KeyUse::Ent)
    }

    pub fn from_certs_for(
        certs: &[String],
        roots: &[[u8; 32]],
        now: i64,
        revoked_kids: &[String],
        key_use: KeyUse,
    ) -> KeySet {
        let roots: Vec<VerifyingKey> = roots
            .iter()
            .filter_map(|r| VerifyingKey::from_bytes(r).ok())
            .collect();
        let mut keys = HashMap::new();
        for cert in certs {
            let Some((kid, key)) = accept(cert, &roots, now, key_use) else {
                continue;
            };
            if revoked_kids.contains(&kid) {
                continue;
            }
            keys.insert(kid, key);
        }
        KeySet {
            keys,
            revoked: revoked_kids.to_vec(),
        }
    }

    /// `RevokedKid` before `UnknownKid`, so a revoked key reads as revoked.
    pub fn get(&self, kid: &str) -> Result<&VerifyingKey, VerifyError> {
        if self.revoked.iter().any(|k| k == kid) {
            return Err(VerifyError::RevokedKid);
        }
        self.keys.get(kid).ok_or(VerifyError::UnknownKid)
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Raw keys, without certificates. Tests and the golden vector only.
    #[cfg(any(test, feature = "test-util"))]
    pub fn from_keys(pairs: &[(&str, [u8; 32])]) -> KeySet {
        KeySet {
            keys: pairs
                .iter()
                .filter_map(|(kid, k)| Some(((*kid).to_owned(), VerifyingKey::from_bytes(k).ok()?)))
                .collect(),
            revoked: Vec::new(),
        }
    }
}

fn accept(
    cert: &str,
    roots: &[VerifyingKey],
    now: i64,
    key_use: KeyUse,
) -> Option<(String, VerifyingKey)> {
    let jws = jws::parse(cert).ok()?;
    if jws.typ() != KEY_TYP {
        return None;
    }
    if !roots.iter().any(|root| jws.verify_with(root).is_ok()) {
        return None;
    }
    let c: CertClaims = serde_json::from_slice(&jws.payload_json).ok()?;
    if c.key_use != key_use.as_str() || now < c.nbf || now >= c.exp {
        return None;
    }
    let key = VerifyingKey::from_bytes(&b64::decode_32(&c.public)?).ok()?;
    Some((c.kid, key))
}

/// A certificate for `public`, signed by `root_seed`. Tests and the mock server only.
#[cfg(any(test, feature = "test-util"))]
pub fn sign_cert(
    kid: &str,
    key_use: KeyUse,
    public: &[u8; 32],
    nbf: i64,
    exp: i64,
    root_seed: &[u8; 32],
) -> String {
    let claims = CertClaims {
        kid: kid.to_owned(),
        key_use: key_use.as_str().to_owned(),
        public: b64::encode(public),
        nbf,
        exp,
    };
    let payload = serde_json::to_vec(&claims).unwrap_or_default();
    jws::sign(
        r#"{"alg":"EdDSA","typ":"xdev-key+jwt"}"#,
        &payload,
        root_seed,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roots::test_root;
    use ed25519_dalek::SigningKey;

    const NOW: i64 = 1_793_836_800;
    const DAY: i64 = 86_400;

    fn public(seed: &[u8; 32]) -> [u8; 32] {
        SigningKey::from_bytes(seed).verifying_key().to_bytes()
    }

    fn cert(kid: &str, key_use: KeyUse, nbf: i64, exp: i64, root: &[u8; 32]) -> String {
        sign_cert(kid, key_use, &public(&[2u8; 32]), nbf, exp, root)
    }

    #[test]
    fn accepts_cert_under_pinned_root() {
        let (seed, root) = test_root();
        let c = cert("ent-1", KeyUse::Ent, NOW - DAY, NOW + DAY, &seed);
        let keys = KeySet::from_certs(&[c], &[root], NOW, &[]);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys.get("ent-1").unwrap().to_bytes(), public(&[2u8; 32]));
    }

    #[test]
    fn rejects_cert_under_other_root() {
        let (_, root) = test_root();
        let c = cert("ent-1", KeyUse::Ent, NOW - DAY, NOW + DAY, &[9u8; 32]);
        let keys = KeySet::from_certs(&[c], &[root], NOW, &[]);
        assert!(keys.is_empty());
        assert_eq!(keys.get("ent-1").unwrap_err(), VerifyError::UnknownKid);
    }

    #[test]
    fn drops_expired_cert() {
        let (seed, root) = test_root();
        let expired = cert("old", KeyUse::Ent, NOW - 2 * DAY, NOW, &seed);
        let future = cert("new", KeyUse::Ent, NOW + 1, NOW + DAY, &seed);
        let keys = KeySet::from_certs(&[expired, future], &[root], NOW, &[]);
        assert!(keys.is_empty());
    }

    #[test]
    fn drops_revoked_kid() {
        let (seed, root) = test_root();
        let c = cert("ent-1", KeyUse::Ent, NOW - DAY, NOW + DAY, &seed);
        let keys = KeySet::from_certs(&[c], &[root], NOW, &["ent-1".to_owned()]);
        assert!(keys.is_empty());
        assert_eq!(keys.get("ent-1").unwrap_err(), VerifyError::RevokedKid);
    }

    #[test]
    fn two_overlapping_certs_both_verify() {
        let (seed, root) = test_root();
        let a = sign_cert(
            "a",
            KeyUse::Ent,
            &public(&[2u8; 32]),
            NOW - DAY,
            NOW + DAY,
            &seed,
        );
        let b = sign_cert(
            "b",
            KeyUse::Ent,
            &public(&[3u8; 32]),
            NOW - 1,
            NOW + 9 * DAY,
            &seed,
        );
        let keys = KeySet::from_certs(&[a, b], &[root], NOW, &[]);
        assert_eq!(keys.len(), 2);
        assert!(keys.get("a").is_ok());
        assert!(keys.get("b").is_ok());
    }

    #[test]
    fn use_access_cert_cannot_verify_ent_token() {
        let (seed, root) = test_root();
        let c = cert("acc-1", KeyUse::Access, NOW - DAY, NOW + DAY, &seed);
        let ent = KeySet::from_certs(std::slice::from_ref(&c), &[root], NOW, &[]);
        assert_eq!(ent.get("acc-1").unwrap_err(), VerifyError::UnknownKid);
        let access = KeySet::from_certs_for(&[c], &[root], NOW, &[], KeyUse::Access);
        assert!(access.get("acc-1").is_ok());
    }

    #[test]
    fn entitlement_token_is_not_a_cert() {
        let (_, root) = test_root();
        let token = crate::jws::tests::golden().token;
        assert!(KeySet::from_certs(&[token], &[root], NOW, &[]).is_empty());
    }
}
