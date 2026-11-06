//! The root public keys official builds trust (D-R4). A root signs the signing-key
//! certificates; the certificates sign the tokens.
//!
//! The release root (owner step M5) is not added yet, so `RELEASE_ROOTS` is empty: a build
//! without the `test-util` feature then verifies no certificate and every user stays Free.
//! That is fail-safe, and a release can never ship the test root, because the test root
//! exists only under `cfg(any(test, feature = "test-util"))`.

/// The official roots, at most 2 (one current, one next). Empty until owner step M5.
pub const RELEASE_ROOTS: &[[u8; 32]] = &[];

/// RFC 8032 section 7.1, test 1: the public key. Its seed is public, so it must never be
/// trusted outside tests.
pub const RFC8032_TEST1_PUBLIC: [u8; 32] = [
    0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07, 0x3a,
    0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
];

/// The roots the default server is trusted under.
#[cfg(not(any(test, feature = "test-util")))]
pub const BUILTIN_ROOTS: &[[u8; 32]] = RELEASE_ROOTS;
/// Tests and the mock server: the RFC 8032 test 1 key only.
#[cfg(any(test, feature = "test-util"))]
pub const BUILTIN_ROOTS: &[[u8; 32]] = &[RFC8032_TEST1_PUBLIC];

/// RFC 8032 section 7.1, test 1: the seed.
#[cfg(any(test, feature = "test-util"))]
pub const RFC8032_TEST1_SEED: [u8; 32] = [
    0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
    0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
];

/// The test root: (seed, public key) of RFC 8032 test 1.
#[cfg(any(test, feature = "test-util"))]
pub fn test_root() -> ([u8; 32], [u8; 32]) {
    (RFC8032_TEST1_SEED, RFC8032_TEST1_PUBLIC)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    #[test]
    fn release_root_is_not_the_rfc8032_test_key() {
        assert!(!RELEASE_ROOTS.contains(&RFC8032_TEST1_PUBLIC));
        assert!(RELEASE_ROOTS.len() <= 2);
    }

    #[test]
    fn test_seed_matches_test_public_key() {
        let (seed, public) = test_root();
        assert_eq!(
            SigningKey::from_bytes(&seed).verifying_key().to_bytes(),
            public
        );
    }

    #[test]
    fn test_public_key_matches_the_golden_vector() {
        assert_eq!(crate::jws::tests::golden().public, RFC8032_TEST1_PUBLIC);
    }
}
