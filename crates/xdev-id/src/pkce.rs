//! PKCE S256 (RFC 7636): a random verifier that never leaves the app, and the
//! challenge the browser page sends to the service.

use std::fmt;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

/// A credential-like string. It prints as `***` and cannot be serialised.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(s: String) -> Secret {
        Secret(s)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

impl PartialEq for Secret {
    fn eq(&self, other: &Secret) -> bool {
        self.0 == other.0
    }
}

impl Eq for Secret {}

/// Base64url without padding.
pub fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `b64url(sha256(verifier))`.
pub fn s256(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

/// 32 OS random bytes as 43 base64url characters.
pub fn random_43() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(b64url(&bytes))
}

pub struct PkcePair {
    pub verifier: Secret,
    pub challenge: String,
}

impl PkcePair {
    pub fn from_bytes(bytes: [u8; 32]) -> PkcePair {
        let verifier = b64url(&bytes);
        let challenge = s256(&verifier);
        PkcePair {
            verifier: Secret::new(verifier),
            challenge,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 7636 Appendix B.
    const RFC_OCTETS: [u8; 32] = [
        116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37,
        77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
    ];
    const RFC_VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const RFC_CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    #[test]
    fn rfc_octets_encode_to_the_rfc_verifier() {
        assert_eq!(b64url(&RFC_OCTETS), RFC_VERIFIER);
    }

    #[test]
    fn s256_matches_the_rfc_vector() {
        assert_eq!(s256(RFC_VERIFIER), RFC_CHALLENGE);
    }

    #[test]
    fn pair_from_bytes_matches_the_rfc_vector() {
        let pair = PkcePair::from_bytes(RFC_OCTETS);
        assert_eq!(pair.verifier.expose(), RFC_VERIFIER);
        assert_eq!(pair.challenge, RFC_CHALLENGE);
    }

    #[test]
    fn random_43_is_43_url_safe_characters_and_differs() {
        let a = random_43().unwrap();
        let b = random_43().unwrap();
        for s in [&a, &b] {
            assert_eq!(s.len(), 43);
            assert!(
                s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            );
        }
        assert_ne!(a, b);
    }

    #[test]
    fn secret_debug_is_masked() {
        assert_eq!(format!("{:?}", Secret::new("x".into())), "***");
    }
}
