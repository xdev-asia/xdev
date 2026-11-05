//! Provider API keys for Settings → Stats & Usage. The same OS keychain
//! entries as `xdev ai key`; a stored key is never returned to the web view.

use serde::Serialize;
use xdev_ai::secrets::{Keychain, SecretStore};

use crate::commands::CmdError;

/// Longest key accepted after trimming.
pub const MAX_KEY_CHARS: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AiKeyStatus {
    pub provider: String,
    pub saved: bool,
}

fn not_ready() -> CmdError {
    CmdError {
        code: "io",
        detail: None,
    }
}

/// Every provider in `PROVIDERS` order, with whether a key is stored.
pub fn list_with(_store: &dyn SecretStore) -> Result<Vec<AiKeyStatus>, CmdError> {
    Err(not_ready())
}

/// Trims `key`; `empty_key`, `too_large` or `unknown_provider` before touching the store.
pub fn set_with(_store: &mut dyn SecretStore, _provider: &str, _key: &str) -> Result<(), CmdError> {
    Err(not_ready())
}

/// Ok(true) when a key was removed, Ok(false) when none was stored.
pub fn remove_with(_store: &mut dyn SecretStore, _provider: &str) -> Result<bool, CmdError> {
    Err(not_ready())
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
}
