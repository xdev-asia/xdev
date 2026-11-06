//! The entitlement token claims, in the server's key order, and their verification.
//! Expiry is not checked here: `grace::evaluate` decides what an old token still grants.

use serde::{Deserialize, Serialize};

use crate::certs::KeySet;
use crate::jws::{self, ENT_TYP, VerifyError};

pub const AUD: &str = "xdev-desktop";
/// A device clock this far behind is tolerated, for `nbf` and for `last_seen_time`.
pub const CLOCK_TOLERANCE_S: i64 = 60 * 60;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProClaim {
    pub grant: String,
    pub perpetual: bool,
    pub updates_until: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncClaim {
    pub until: Option<i64>,
    pub quota_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamClaim {
    pub org: String,
    pub role: String,
    pub seat: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicesClaim {
    pub max: u32,
    pub active: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub jti: String,
    pub iat: i64,
    pub nbf: i64,
    pub exp: i64,
    pub rfa: i64,
    /// The device fingerprint the token is bound to.
    pub dev: String,
    pub plan: Vec<String>,
    pub features: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pro: Option<ProClaim>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync: Option<SyncClaim>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<TeamClaim>,
    pub devices: DevicesClaim,
}

/// Order: malformed, alg/typ, kid (revoked, unknown), signature, iss, aud, nbf, device.
/// `iss` is the effective server base; `dev` is this device's fingerprint.
pub fn verify(
    token: &str,
    keys: &KeySet,
    iss: &str,
    dev: &str,
    now: i64,
) -> Result<Claims, VerifyError> {
    let jws = jws::parse(token)?;
    if jws.typ() != ENT_TYP {
        return Err(VerifyError::BadAlg);
    }
    let kid = jws.header.kid.as_deref().ok_or(VerifyError::UnknownKid)?;
    jws.verify_with(keys.get(kid)?)?;
    let claims: Claims =
        serde_json::from_slice(&jws.payload_json).map_err(|_| VerifyError::Malformed)?;
    if claims.iss != iss {
        return Err(VerifyError::WrongIss);
    }
    if claims.aud != AUD {
        return Err(VerifyError::WrongAud);
    }
    if now + CLOCK_TOLERANCE_S < claims.nbf {
        return Err(VerifyError::NotYetValid);
    }
    if claims.dev != dev {
        return Err(VerifyError::WrongDevice);
    }
    Ok(claims)
}

/// Signs `claims` as an entitlement token. Tests and the mock server only.
#[cfg(any(test, feature = "test-util"))]
pub fn sign_token(claims: &Claims, kid: &str, seed: &[u8; 32]) -> String {
    // The server writes alg, typ, kid in that order; `json!` would sort the keys.
    let header = format!(
        r#"{{"alg":"EdDSA","typ":"{ENT_TYP}","kid":{}}}"#,
        serde_json::Value::from(kid)
    );
    let payload = serde_json::to_vec(claims).unwrap_or_default();
    jws::sign(&header, &payload, seed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jws::tests::golden;
    use crate::roots::RFC8032_TEST1_SEED;

    const NOW: i64 = 1_793_836_800 + 3_600;
    const ISS: &str = "https://id.xdev.asia";
    const DEV: &str = "GOLDENDEVICEFINGERPRINT";

    fn keys() -> KeySet {
        let g = golden();
        KeySet::from_keys(&[(g.kid.as_str(), g.public)])
    }

    #[test]
    fn verifies_the_golden_vector() {
        let c = verify(&golden().token, &keys(), ISS, DEV, NOW).unwrap();
        assert_eq!(serde_json::to_value(&c).unwrap(), golden().claims);
    }

    #[test]
    fn signing_the_golden_claims_reproduces_the_golden_token() {
        let g = golden();
        let c: Claims = serde_json::from_value(g.claims).unwrap();
        assert_eq!(sign_token(&c, &g.kid, &RFC8032_TEST1_SEED), g.token);
    }

    #[test]
    fn checks_iss_aud_nbf_and_device_in_order() {
        let g = golden();
        let k = keys();
        assert_eq!(
            verify(&g.token, &k, "https://other.test", DEV, NOW).unwrap_err(),
            VerifyError::WrongIss
        );
        assert_eq!(
            verify(&g.token, &k, ISS, "OTHER", NOW).unwrap_err(),
            VerifyError::WrongDevice
        );
        let c: Claims = serde_json::from_value(g.claims.clone()).unwrap();
        let wrong_aud = Claims {
            aud: "web".into(),
            ..c.clone()
        };
        let t = sign_token(&wrong_aud, &g.kid, &RFC8032_TEST1_SEED);
        assert_eq!(
            verify(&t, &k, ISS, DEV, NOW).unwrap_err(),
            VerifyError::WrongAud
        );
        assert_eq!(
            verify(&g.token, &k, ISS, DEV, c.nbf - 2 * CLOCK_TOLERANCE_S).unwrap_err(),
            VerifyError::NotYetValid
        );
        // A clock a few minutes slow still reads a token issued just now.
        assert!(verify(&g.token, &k, ISS, DEV, c.nbf - 300).is_ok());
    }

    #[test]
    fn unknown_kid_and_wrong_key() {
        let g = golden();
        assert_eq!(
            verify(&g.token, &KeySet::default(), ISS, DEV, NOW).unwrap_err(),
            VerifyError::UnknownKid
        );
        let other = KeySet::from_keys(&[(
            g.kid.as_str(),
            crate::keystore::tests::public_of(&[5u8; 32]),
        )]);
        assert_eq!(
            verify(&g.token, &other, ISS, DEV, NOW).unwrap_err(),
            VerifyError::BadSignature
        );
    }

    #[test]
    fn a_cert_is_not_an_entitlement_token() {
        let cert = crate::certs::sign_cert(
            "ent-test",
            crate::certs::KeyUse::Ent,
            &[1u8; 32],
            0,
            i64::MAX,
            &RFC8032_TEST1_SEED,
        );
        assert_eq!(
            verify(&cert, &keys(), ISS, DEV, NOW).unwrap_err(),
            VerifyError::BadAlg
        );
    }
}
