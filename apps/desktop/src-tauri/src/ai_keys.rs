//! Provider API keys for Settings → Stats & Usage. The same OS keychain
//! entries as `xdev ai key`; a stored key is never returned to the web view.

use serde::Serialize;
use xdev_ai::secrets::{Keychain, SecretStore, validate_provider};

use crate::commands::CmdError;

/// Longest key accepted after trimming.
pub const MAX_KEY_CHARS: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AiKeyStatus {
    pub provider: String,
    pub saved: bool,
}

fn plain(code: &'static str) -> CmdError {
    CmdError { code, detail: None }
}

/// Every provider in `PROVIDERS` order, with whether a key is stored.
pub fn list_with(store: &dyn SecretStore) -> Result<Vec<AiKeyStatus>, CmdError> {
    Ok(store
        .list()?
        .into_iter()
        .map(|(provider, saved)| AiKeyStatus { provider, saved })
        .collect())
}

/// Trims `key`; `empty_key`, `too_large` or `unknown_provider` before touching the store.
pub fn set_with(store: &mut dyn SecretStore, provider: &str, key: &str) -> Result<(), CmdError> {
    validate_provider(provider)?;
    let key = key.trim();
    if key.is_empty() {
        return Err(plain("empty_key"));
    }
    if key.chars().count() > MAX_KEY_CHARS {
        return Err(plain("too_large"));
    }
    Ok(store.set(provider, key)?)
}

/// Ok(true) when a key was removed, Ok(false) when none was stored.
pub fn remove_with(store: &mut dyn SecretStore, provider: &str) -> Result<bool, CmdError> {
    validate_provider(provider)?;
    Ok(store.remove(provider)?)
}

#[tauri::command(async)]
pub fn ai_keys_list() -> Result<Vec<AiKeyStatus>, CmdError> {
    list_with(&Keychain)
}

#[tauri::command(async)]
pub fn ai_key_set(provider: String, key: String) -> Result<(), CmdError> {
    set_with(&mut Keychain, &provider, &key)
}

#[tauri::command(async)]
pub fn ai_key_remove(provider: String) -> Result<bool, CmdError> {
    remove_with(&mut Keychain, &provider)
}

#[cfg(test)]
mod tests {
    use super::*;
    use xdev_ai::AiError;
    use xdev_ai::secrets::{MemoryStore, Secret};

    const KEY: &str = "test-placeholder";

    struct FailingStore;

    impl SecretStore for FailingStore {
        fn set(&mut self, _: &str, _: &str) -> Result<(), AiError> {
            Err(AiError::SecretStore)
        }
        fn get(&self, _: &str) -> Result<Option<Secret>, AiError> {
            Err(AiError::SecretStore)
        }
        fn remove(&mut self, _: &str) -> Result<bool, AiError> {
            Err(AiError::SecretStore)
        }
    }

    fn code<T: std::fmt::Debug>(r: Result<T, CmdError>) -> &'static str {
        r.unwrap_err().code
    }

    #[test]
    fn status_serializes_as_provider_and_saved() {
        let status = AiKeyStatus {
            provider: "openai".into(),
            saved: true,
        };
        assert_eq!(
            serde_json::to_string(&status).unwrap(),
            r#"{"provider":"openai","saved":true}"#
        );
    }

    #[test]
    fn list_reports_every_provider_in_order() {
        let mut store = MemoryStore::default();
        let rows = list_with(&store).unwrap();
        let names: Vec<&str> = rows.iter().map(|r| r.provider.as_str()).collect();
        assert_eq!(names, ["anthropic", "openai", "gemini"]);
        assert!(rows.iter().all(|r| !r.saved));
        store.set("openai", KEY).unwrap();
        let saved: Vec<bool> = list_with(&store).unwrap().iter().map(|r| r.saved).collect();
        assert_eq!(saved, [false, true, false]);
    }

    #[test]
    fn set_trims_and_stores() {
        let mut store = MemoryStore::default();
        set_with(&mut store, "openai", "  test-placeholder \n").unwrap();
        assert_eq!(store.get("openai").unwrap().unwrap().expose(), KEY);
    }

    #[test]
    fn set_rejects_blank_as_empty_key() {
        let mut store = MemoryStore::default();
        assert_eq!(code(set_with(&mut store, "openai", "   ")), "empty_key");
        assert!(store.get("openai").unwrap().is_none());
    }

    #[test]
    fn set_rejects_over_4096_chars_as_too_large() {
        let mut store = MemoryStore::default();
        let long = "a".repeat(MAX_KEY_CHARS + 1);
        assert_eq!(code(set_with(&mut store, "openai", &long)), "too_large");
        assert!(store.get("openai").unwrap().is_none());
        set_with(&mut store, "openai", &"a".repeat(MAX_KEY_CHARS)).unwrap();
        assert!(store.get("openai").unwrap().is_some());
    }

    #[test]
    fn unknown_provider_is_rejected() {
        let mut store = MemoryStore::default();
        assert_eq!(code(set_with(&mut store, "other", KEY)), "unknown_provider");
        assert_eq!(code(remove_with(&mut store, "other")), "unknown_provider");
    }

    #[test]
    fn remove_reports_whether_a_key_was_stored() {
        let mut store = MemoryStore::default();
        assert!(!remove_with(&mut store, "gemini").unwrap());
        store.set("gemini", KEY).unwrap();
        assert!(remove_with(&mut store, "gemini").unwrap());
        assert!(store.get("gemini").unwrap().is_none());
    }

    #[test]
    fn store_failure_maps_to_secret_store() {
        assert_eq!(code(list_with(&FailingStore)), "secret_store");
        assert_eq!(
            code(set_with(&mut FailingStore, "openai", KEY)),
            "secret_store"
        );
        assert_eq!(
            code(remove_with(&mut FailingStore, "openai")),
            "secret_store"
        );
    }

    #[test]
    fn errors_never_carry_the_key() {
        let err = set_with(&mut FailingStore, "openai", KEY).unwrap_err();
        assert!(!format!("{err:?}").contains(KEY));
        let too_long = format!("{KEY}{}", "a".repeat(MAX_KEY_CHARS));
        let err = set_with(&mut MemoryStore::default(), "openai", &too_long).unwrap_err();
        assert!(!format!("{err:?}").contains(KEY));
    }
}
