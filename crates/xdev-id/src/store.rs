//! Where the session token lives: the OS keychain, never a file.
//!
//! One entry holds the token and the last profile, so the app can show who is signed in
//! while offline without a plaintext file of personal data.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use crate::pkce::Secret;
use crate::{KEYRING_SERVICE, KEYRING_USER};

/// Windows Credential Manager limits a blob to 2560 bytes and keyring may store UTF-16,
/// so the JSON stays well under half of that.
const MAX_JSON: usize = 1200;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredUser {
    pub name: String,
    pub email: String,
    pub image: Option<String>,
}

#[derive(Clone)]
pub struct Stored {
    pub token: Secret,
    pub user: Option<StoredUser>,
    /// The server the token belongs to. A token is only ever sent to this origin.
    pub origin: String,
}

#[derive(Serialize)]
struct Out<'a> {
    v: u32,
    token: &'a str,
    user: Option<&'a StoredUser>,
    origin: &'a str,
}

#[derive(Deserialize)]
struct In {
    v: u32,
    token: String,
    user: Option<StoredUser>,
    origin: String,
}

fn render(token: &str, user: Option<&StoredUser>, origin: &str) -> String {
    serde_json::to_string(&Out {
        v: 1,
        token,
        user,
        origin,
    })
    .unwrap_or_default()
}

/// `{"v":1,"token":…,"user":…,"origin":…}`, at most 1200 characters: the image goes first, then
/// the longer of name and email is cut. The token is always kept.
pub fn encode_stored(s: &Stored) -> String {
    let token = s.token.expose();
    let origin = s.origin.as_str();
    let Some(user) = &s.user else {
        return render(token, None, origin);
    };
    let mut user = user.clone();
    let mut text = render(token, Some(&user), origin);
    if text.chars().count() <= MAX_JSON {
        return text;
    }
    user.image = None;
    text = render(token, Some(&user), origin);
    while text.chars().count() > MAX_JSON && !(user.name.is_empty() && user.email.is_empty()) {
        let longer = if user.name.chars().count() >= user.email.chars().count() {
            &mut user.name
        } else {
            &mut user.email
        };
        longer.pop();
        text = render(token, Some(&user), origin);
    }
    text
}

/// `None` on any shape error, an unknown version, an empty token or a missing origin.
pub fn decode_stored(raw: &str) -> Option<Stored> {
    let parsed: In = serde_json::from_str(raw).ok()?;
    if parsed.v != 1 || parsed.token.is_empty() || parsed.origin.is_empty() {
        return None;
    }
    Some(Stored {
        token: Secret::new(parsed.token),
        user: parsed.user,
        origin: parsed.origin,
    })
}

/// The keychain could not be read or written. The cause is dropped on purpose.
#[derive(Debug)]
pub struct StoreError;

pub trait TokenStore: Send + Sync {
    /// No entry, or an entry that does not decode, is `Ok(None)`.
    fn load(&self) -> Result<Option<Stored>, StoreError>;
    fn save(&self, s: &Stored) -> Result<(), StoreError>;
    /// `Ok(false)` when there was nothing to delete.
    fn clear(&self) -> Result<bool, StoreError>;
}

pub struct Keychain;

fn entry() -> Result<keyring::Entry, StoreError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|_| StoreError)
}

impl TokenStore for Keychain {
    fn load(&self) -> Result<Option<Stored>, StoreError> {
        match entry()?.get_password() {
            Ok(raw) => Ok(decode_stored(&raw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(StoreError),
        }
    }

    fn save(&self, s: &Stored) -> Result<(), StoreError> {
        entry()?
            .set_password(&encode_stored(s))
            .map_err(|_| StoreError)
    }

    fn clear(&self) -> Result<bool, StoreError> {
        match entry()?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(_) => Err(StoreError),
        }
    }
}

/// An in-memory store for tests, with a switch that makes every call fail.
#[derive(Default)]
pub struct MemoryStore {
    raw: Mutex<Option<String>>,
    fail: AtomicBool,
}

impl MemoryStore {
    pub fn set_fail(&self, fail: bool) {
        self.fail.store(fail, Ordering::SeqCst);
    }

    /// The stored JSON, for assertions.
    pub fn raw(&self) -> Option<String> {
        self.raw.lock().ok().and_then(|r| r.clone())
    }

    fn check(&self) -> Result<(), StoreError> {
        if self.fail.load(Ordering::SeqCst) {
            Err(StoreError)
        } else {
            Ok(())
        }
    }
}

impl TokenStore for MemoryStore {
    fn load(&self) -> Result<Option<Stored>, StoreError> {
        self.check()?;
        let raw = self.raw.lock().map_err(|_| StoreError)?;
        Ok(raw.as_deref().and_then(decode_stored))
    }

    fn save(&self, s: &Stored) -> Result<(), StoreError> {
        self.check()?;
        *self.raw.lock().map_err(|_| StoreError)? = Some(encode_stored(s));
        Ok(())
    }

    fn clear(&self) -> Result<bool, StoreError> {
        self.check()?;
        Ok(self.raw.lock().map_err(|_| StoreError)?.take().is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(name: &str, email: &str, image: Option<&str>) -> Stored {
        Stored {
            token: Secret::new("tok_tok_tok_tok_tok_tok".into()),
            user: Some(StoredUser {
                name: name.into(),
                email: email.into(),
                image: image.map(str::to_owned),
            }),
            origin: "https://id.corp.test".into(),
        }
    }

    #[test]
    fn round_trips() {
        let s = stored(
            "Duy",
            "d@x.test",
            Some("https://avatars.githubusercontent.com/u/1"),
        );
        let back = decode_stored(&encode_stored(&s)).unwrap();
        assert_eq!(back.token.expose(), "tok_tok_tok_tok_tok_tok");
        assert_eq!(back.user, s.user);
        assert_eq!(back.origin, "https://id.corp.test");
        let bare = Stored {
            token: Secret::new("t".into()),
            user: None,
            origin: "https://id.corp.test".into(),
        };
        assert!(decode_stored(&encode_stored(&bare)).unwrap().user.is_none());
    }

    #[test]
    fn rejects_other_versions_and_garbage() {
        assert!(decode_stored(r#"{"v":2,"token":"t","user":null}"#).is_none());
        assert!(decode_stored(r#"{"token":"t"}"#).is_none());
        assert!(decode_stored(r#"{"v":1,"token":""}"#).is_none());
        // An entry with no origin cannot say where its token may go.
        assert!(decode_stored(r#"{"v":1,"token":"t","user":null}"#).is_none());
        assert!(decode_stored(r#"{"v":1,"token":"t","user":null,"origin":""}"#).is_none());
        assert!(decode_stored("garbage").is_none());
        assert!(decode_stored("").is_none());
    }

    #[test]
    fn cap_drops_the_image_first() {
        let image = format!("https://avatars.githubusercontent.com/{}", "a".repeat(1500));
        let s = stored("Duy", "d@x.test", Some(&image));
        let text = encode_stored(&s);
        assert!(text.chars().count() <= MAX_JSON);
        let back = decode_stored(&text).unwrap();
        let user = back.user.unwrap();
        assert_eq!(
            (user.name.as_str(), user.email.as_str()),
            ("Duy", "d@x.test")
        );
        assert!(user.image.is_none());
        assert_eq!(back.origin, "https://id.corp.test");
    }

    #[test]
    fn cap_then_cuts_name_and_email_and_keeps_the_token() {
        let s = stored(&"n".repeat(900), &"e".repeat(900), Some("https://x"));
        let text = encode_stored(&s);
        assert!(text.chars().count() <= MAX_JSON);
        let back = decode_stored(&text).unwrap();
        assert_eq!(back.token.expose(), "tok_tok_tok_tok_tok_tok");
        assert_eq!(back.origin, "https://id.corp.test");
        let user = back.user.unwrap();
        assert!(!user.name.is_empty() && !user.email.is_empty());
        // Multi-byte names stay valid text.
        let s = stored(&"Đ".repeat(1300), "d@x.test", None);
        assert!(encode_stored(&s).chars().count() <= MAX_JSON);
    }

    #[test]
    fn memory_store_loads_saves_clears_and_fails() {
        let store = MemoryStore::default();
        assert!(store.load().unwrap().is_none());
        assert!(!store.clear().unwrap());
        store.save(&stored("Duy", "d@x.test", None)).unwrap();
        assert_eq!(store.load().unwrap().unwrap().user.unwrap().name, "Duy");
        assert!(store.clear().unwrap());
        assert!(store.load().unwrap().is_none());
        store.set_fail(true);
        assert!(store.load().is_err());
        assert!(store.save(&stored("a", "b", None)).is_err());
        assert!(store.clear().is_err());
    }

    /// Touches the real OS keychain: `cargo test -p xdev-id -- --ignored`.
    #[test]
    #[ignore = "touches the OS keychain"]
    fn keychain_round_trip_manual() {
        let keychain = Keychain;
        keychain.save(&stored("Duy", "d@x.test", None)).unwrap();
        assert_eq!(keychain.load().unwrap().unwrap().user.unwrap().name, "Duy");
        assert!(keychain.clear().unwrap());
        assert!(keychain.load().unwrap().is_none());
    }
}
