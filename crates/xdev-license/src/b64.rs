//! Strict base64url: the URL-safe alphabet, no padding, no stray trailing bits.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `None` for padding, a character outside the URL-safe alphabet or non-canonical trailing bits.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text).ok()
}

/// Exactly 32 bytes, as a key.
pub fn decode_32(text: &str) -> Option<[u8; 32]> {
    decode(text)?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let bytes = [0u8, 1, 2, 250, 251, 252, 253, 254, 255];
        assert_eq!(decode(&encode(&bytes)).unwrap(), bytes);
    }

    #[test]
    fn rejects_padding_and_standard_alphabet() {
        assert!(decode("AA==").is_none());
        assert!(decode("+/8").is_none());
        assert!(decode("-_8").is_some());
    }

    #[test]
    fn rejects_trailing_bits() {
        // "AB" decodes to one byte only if the low 4 bits are zero.
        assert!(decode("AB").is_none());
        assert!(decode("AA").is_some());
    }

    #[test]
    fn decode_32_needs_exactly_32_bytes() {
        assert!(decode_32(&encode(&[7u8; 32])).is_some());
        assert!(decode_32(&encode(&[7u8; 31])).is_none());
    }
}
