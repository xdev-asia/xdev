//! Pairing offers (the `xdev://pair?d=` link, M-R5), pairing codes and the
//! window a host keeps open while it pairs.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use snow::resolvers::{CryptoResolver, DefaultResolver};

use crate::error::LinkError;

pub const OFFER_VERSION: u8 = 1;
pub const URI_PREFIX: &str = "xdev://pair?d=";
pub const NAME_MAX: usize = 32;
/// How long a code or an offer stays valid.
pub const WINDOW_TTL_MS: u64 = 5 * 60 * 1000;
/// Failed handshakes before the window closes.
pub const WINDOW_MAX_FAILURES: u8 = 5;

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN: usize = 10;
const PSK_LABEL: &[u8] = b"xdev-pair-v1";

/// What a pairing link carries. `secret` is the psk a phone uses (the QR
/// path); a desktop types the code instead and uses the link only for the
/// host key and addresses.
#[derive(Clone, PartialEq, Eq)]
pub struct PairOffer {
    pub v: u8,
    pub name: String,
    pub host_pub: [u8; 32],
    pub host_id: String,
    pub secret: [u8; 32],
    /// Unix milliseconds.
    pub expires_ms: u64,
    pub candidates: Vec<String>,
}

impl std::fmt::Debug for PairOffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairOffer")
            .field("v", &self.v)
            .field("name", &self.name)
            .field("host_id", &self.host_id)
            .field("expires_ms", &self.expires_ms)
            .field("candidates", &self.candidates)
            .finish_non_exhaustive()
    }
}

#[derive(Serialize, Deserialize)]
struct OfferJson {
    v: u8,
    n: String,
    k: String,
    h: Vec<String>,
    s: String,
    e: u64,
    f: String,
}

fn key32(s: &str) -> Result<[u8; 32], LinkError> {
    URL_SAFE_NO_PAD
        .decode(s)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or(LinkError::Offer("key"))
}

impl PairOffer {
    pub fn to_uri(&self) -> String {
        let json = OfferJson {
            v: self.v,
            n: self.name.clone(),
            k: URL_SAFE_NO_PAD.encode(self.host_pub),
            h: self.candidates.clone(),
            s: URL_SAFE_NO_PAD.encode(self.secret),
            e: self.expires_ms,
            f: self.host_id.clone(),
        };
        let body = serde_json::to_vec(&json).unwrap_or_default();
        format!("{URI_PREFIX}{}", URL_SAFE_NO_PAD.encode(body))
    }

    /// Parses a link and rejects another version, a bad key or an expired
    /// offer.
    pub fn from_uri(uri: &str, now_ms: u64) -> Result<PairOffer, LinkError> {
        let d = uri
            .trim()
            .strip_prefix(URI_PREFIX)
            .ok_or(LinkError::Offer("prefix"))?;
        let body = URL_SAFE_NO_PAD
            .decode(d)
            .map_err(|_| LinkError::Offer("encoding"))?;
        let json: OfferJson =
            serde_json::from_slice(&body).map_err(|_| LinkError::Offer("json"))?;
        if json.v != OFFER_VERSION {
            return Err(LinkError::Offer("version"));
        }
        if json.e <= now_ms {
            return Err(LinkError::Offer("expired"));
        }
        if json.n.chars().count() > NAME_MAX {
            return Err(LinkError::Offer("name"));
        }
        let host_pub = key32(&json.k)?;
        if crate::identity::host_id_of(&host_pub) != json.f {
            return Err(LinkError::Offer("host id"));
        }
        Ok(PairOffer {
            v: json.v,
            name: json.n,
            host_pub,
            host_id: json.f,
            secret: key32(&json.s)?,
            expires_ms: json.e,
            candidates: json.h,
        })
    }
}

/// Ten Crockford base32 characters (50 bits). `Debug` hides it.
#[derive(Clone, PartialEq, Eq)]
pub struct PairCode(String);

impl std::fmt::Debug for PairCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PairCode(..)")
    }
}

impl PairCode {
    pub fn generate() -> Result<PairCode, LinkError> {
        let mut bytes = [0u8; CODE_LEN];
        getrandom::fill(&mut bytes).map_err(|_| LinkError::KeyStore)?;
        // 256 is a multiple of 32, so masking keeps every character equally likely.
        let code = bytes
            .iter()
            .map(|b| CROCKFORD[(b & 0x1f) as usize] as char)
            .collect();
        Ok(PairCode(code))
    }

    /// Accepts lower case, no dash or spaces, and the look-alikes O→0, I/L→1.
    pub fn parse(s: &str) -> Result<PairCode, LinkError> {
        let mut out = String::with_capacity(CODE_LEN);
        for c in s.chars() {
            if c == '-' || c.is_whitespace() {
                continue;
            }
            let c = match c.to_ascii_uppercase() {
                'O' => '0',
                'I' | 'L' => '1',
                c => c,
            };
            if !CROCKFORD.contains(&(c as u8)) || !c.is_ascii() {
                return Err(LinkError::PairCode);
            }
            out.push(c);
        }
        if out.len() != CODE_LEN {
            return Err(LinkError::PairCode);
        }
        Ok(PairCode(out))
    }

    /// `XXXXX-XXXXX`.
    pub fn display(&self) -> String {
        format!("{}-{}", &self.0[..5], &self.0[5..])
    }

    /// BLAKE2s-256("xdev-pair-v1" ‖ normalized code).
    pub fn psk(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        if let Some(mut h) = DefaultResolver.resolve_hash(&snow::params::HashChoice::Blake2s) {
            h.input(PSK_LABEL);
            h.input(self.0.as_bytes());
            h.result(&mut out);
        }
        out
    }
}

/// What the host holds while "Pair a computer" is open: single use, a
/// 5 minute life and 5 failed handshakes before it closes.
pub struct PairWindow {
    pub name: String,
    code: PairCode,
    secret: [u8; 32],
    expires_ms: u64,
    failures: u8,
    used: bool,
    busy: bool,
}

impl std::fmt::Debug for PairWindow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairWindow")
            .field("expires_ms", &self.expires_ms)
            .field("failures", &self.failures)
            .field("used", &self.used)
            .finish_non_exhaustive()
    }
}

impl PairWindow {
    pub fn new(name: &str, now_ms: u64) -> Result<PairWindow, LinkError> {
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|_| LinkError::KeyStore)?;
        Ok(PairWindow::with(
            name,
            PairCode::generate()?,
            secret,
            now_ms,
        ))
    }

    pub fn with(name: &str, code: PairCode, secret: [u8; 32], now_ms: u64) -> PairWindow {
        PairWindow {
            name: name.chars().take(NAME_MAX).collect(),
            code,
            secret,
            expires_ms: now_ms + WINDOW_TTL_MS,
            failures: 0,
            used: false,
            busy: false,
        }
    }

    pub fn code(&self) -> &PairCode {
        &self.code
    }

    pub fn expires_ms(&self) -> u64 {
        self.expires_ms
    }

    pub fn offer(&self, host_pub: [u8; 32], candidates: Vec<String>) -> PairOffer {
        PairOffer {
            v: OFFER_VERSION,
            name: self.name.clone(),
            host_pub,
            host_id: crate::identity::host_id_of(&host_pub),
            secret: self.secret,
            expires_ms: self.expires_ms,
            candidates,
        }
    }

    pub(crate) fn code_psk(&self) -> [u8; 32] {
        self.code.psk()
    }

    pub(crate) fn secret_psk(&self) -> [u8; 32] {
        self.secret
    }

    pub fn is_open(&self, now_ms: u64) -> bool {
        !self.used && self.failures < WINDOW_MAX_FAILURES && now_ms < self.expires_ms
    }

    pub fn is_busy(&self) -> bool {
        self.busy
    }

    /// Marks a handshake as in progress; `false` when one already is or the
    /// window is closed.
    pub fn begin(&mut self, now_ms: u64) -> bool {
        if !self.is_open(now_ms) || self.busy {
            return false;
        }
        self.busy = true;
        true
    }

    /// The handshake ended without a pairing.
    pub fn end(&mut self) {
        self.busy = false;
    }

    /// A wrong code or psk.
    pub fn fail(&mut self) {
        self.failures = self.failures.saturating_add(1);
        self.busy = false;
    }

    /// Uses the window for a completed pairing. `false` if it was already
    /// used, expired or closed by failures.
    pub fn try_consume(&mut self, now_ms: u64) -> bool {
        if !self.is_open(now_ms) {
            return false;
        }
        self.used = true;
        self.busy = false;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_code_uses_the_alphabet() {
        for _ in 0..50 {
            let code = PairCode::generate().unwrap();
            let shown = code.display();
            assert_eq!(shown.len(), 11);
            assert_eq!(&shown[5..6], "-");
            assert!(
                shown
                    .chars()
                    .filter(|c| *c != '-')
                    .all(|c| CROCKFORD.contains(&(c as u8)))
            );
            assert_eq!(PairCode::parse(&shown).unwrap(), code);
        }
    }

    #[test]
    fn parse_normalises() {
        let a = PairCode::parse("7K4QM-2XD9P").unwrap();
        assert_eq!(PairCode::parse("7k4qm2xd9p").unwrap(), a);
        assert_eq!(PairCode::parse(" 7k4qm 2xd9p ").unwrap(), a);
        assert_eq!(
            PairCode::parse("0O1IL-00000").unwrap().display(),
            "00111-00000"
        );
        assert!(PairCode::parse("7K4QM-2XD9").is_err());
        assert!(PairCode::parse("7K4QM-2XD9U").is_err());
        assert!(PairCode::parse("7K4QM-2XD9PP").is_err());
    }

    #[test]
    fn psk_is_stable_and_depends_on_the_code() {
        let a = PairCode::parse("7K4QM-2XD9P").unwrap();
        assert_eq!(a.psk(), PairCode::parse("7k4qm2xd9p").unwrap().psk());
        assert_ne!(a.psk(), PairCode::parse("7K4QM-2XD9Q").unwrap().psk());
        assert_ne!(a.psk(), [0u8; 32]);
    }

    #[test]
    fn code_debug_hides_the_code() {
        let a = PairCode::parse("7K4QM-2XD9P").unwrap();
        assert!(!format!("{a:?}").contains("7K4QM"));
    }

    fn sample(now: u64) -> PairOffer {
        let key = crate::identity::HostKey::from_private([3u8; 32]).unwrap();
        let w = PairWindow::with("studio-mac", PairCode::generate().unwrap(), [9u8; 32], now);
        w.offer(key.public(), vec!["192.168.1.20:47821".into()])
    }

    #[test]
    fn offer_uri_round_trip() {
        let offer = sample(1_000);
        let uri = offer.to_uri();
        assert!(uri.starts_with(URI_PREFIX));
        assert_eq!(PairOffer::from_uri(&uri, 2_000).unwrap(), offer);
        assert!(!format!("{offer:?}").contains("secret"));
    }

    #[test]
    fn offer_rejects_bad_version_and_expired() {
        let mut offer = sample(1_000);
        let expired = offer.to_uri();
        assert_eq!(
            PairOffer::from_uri(&expired, 1_000 + WINDOW_TTL_MS),
            Err(LinkError::Offer("expired"))
        );
        offer.v = 2;
        assert_eq!(
            PairOffer::from_uri(&offer.to_uri(), 2_000),
            Err(LinkError::Offer("version"))
        );
        assert!(PairOffer::from_uri("xdev://pair?d=!!", 0).is_err());
        assert!(PairOffer::from_uri("https://example.invalid", 0).is_err());
    }

    #[test]
    fn window_is_single_use() {
        let mut w = PairWindow::with("a", PairCode::generate().unwrap(), [0; 32], 0);
        assert!(w.begin(1));
        assert!(!w.begin(1), "a second handshake waits");
        assert!(w.try_consume(2));
        assert!(!w.is_open(3));
        assert!(!w.try_consume(3));
    }

    #[test]
    fn window_closes_after_five_failures_or_ttl() {
        let mut w = PairWindow::with("a", PairCode::generate().unwrap(), [0; 32], 0);
        for _ in 0..4 {
            assert!(w.begin(1));
            w.fail();
        }
        assert!(w.is_open(1));
        assert!(w.begin(1));
        w.fail();
        assert!(!w.is_open(1));
        assert!(!w.begin(1));

        let w = PairWindow::with("a", PairCode::generate().unwrap(), [0; 32], 0);
        assert!(!w.is_open(WINDOW_TTL_MS));
    }
}
