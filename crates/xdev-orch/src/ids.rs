//! Ids: `<prefix>_<12 hex>`, from a seed the caller supplies so tests are exact.

use sha2::{Digest, Sha256};

/// One round of splitmix64: spreads a counter-like seed over all bits.
fn mix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// `run`, `task`, `disp`, `msg`, `gate` or `req`, then 12 hex digits.
pub fn new_id(prefix: &str, seed: u64) -> String {
    format!("{prefix}_{:012x}", mix(seed) & 0xFFFF_FFFF_FFFF)
}

/// The id of the escalation raised when `dispatch`'s worker stops at `edge`;
/// the same edge always gives the same id, so a repeat is dropped.
pub fn stop_message_id(dispatch: &str, edge: &str) -> String {
    let digest = Sha256::digest(format!("{dispatch}\n{edge}").as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("msg_stop_{}", &hex[..24])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_is_the_prefix_and_twelve_hex_digits() {
        let id = new_id("run", 42);
        let (prefix, hex) = id.split_once('_').unwrap();
        assert_eq!(prefix, "run");
        assert_eq!(hex.len(), 12);
        assert!(hex.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn the_same_seed_gives_the_same_id_and_neighbours_differ() {
        assert_eq!(new_id("task", 7), new_id("task", 7));
        assert_ne!(new_id("task", 7), new_id("task", 8));
    }

    #[test]
    fn a_stop_id_is_stable_and_24_hex_digits_long() {
        let a = stop_message_id("disp_1", "working->done");
        assert_eq!(a, stop_message_id("disp_1", "working->done"));
        assert_ne!(a, stop_message_id("disp_1", "working->exited"));
        assert_ne!(a, stop_message_id("disp_2", "working->done"));
        assert_eq!(a.len(), "msg_stop_".len() + 24);
    }
}
