use std::collections::BTreeMap;
use std::fmt;

use crate::AiError;

pub const PROVIDERS: [&str; 3] = ["anthropic", "openai", "gemini"];

pub fn validate_provider(provider: &str) -> Result<(), AiError> {
    if PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(AiError::UnknownProvider)
    }
}

pub struct Secret(String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

pub trait SecretStore {
    fn set(&mut self, provider: &str, key: &str) -> Result<(), AiError>;
    fn get(&self, provider: &str) -> Result<Option<Secret>, AiError>;
    fn remove(&mut self, provider: &str) -> Result<bool, AiError>;

    fn list(&self) -> Result<Vec<(String, bool)>, AiError> {
        PROVIDERS
            .iter()
            .map(|provider| Ok(((*provider).to_owned(), self.get(provider)?.is_some())))
            .collect()
    }
}

pub struct Keychain;

fn entry(provider: &str) -> Result<keyring::Entry, AiError> {
    validate_provider(provider)?;
    keyring::Entry::new("xdev", provider).map_err(|_| AiError::SecretStore)
}

impl SecretStore for Keychain {
    fn set(&mut self, provider: &str, key: &str) -> Result<(), AiError> {
        entry(provider)?
            .set_password(key)
            .map_err(|_| AiError::SecretStore)
    }

    fn get(&self, provider: &str) -> Result<Option<Secret>, AiError> {
        match entry(provider)?.get_password() {
            Ok(key) => Ok(Some(Secret(key))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AiError::SecretStore),
        }
    }

    fn remove(&mut self, provider: &str) -> Result<bool, AiError> {
        match entry(provider)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(_) => Err(AiError::SecretStore),
        }
    }
}

#[derive(Default)]
pub struct MemoryStore {
    keys: BTreeMap<String, Secret>,
}

impl SecretStore for MemoryStore {
    fn set(&mut self, provider: &str, key: &str) -> Result<(), AiError> {
        validate_provider(provider)?;
        self.keys
            .insert(provider.to_owned(), Secret(key.to_owned()));
        Ok(())
    }

    fn get(&self, provider: &str) -> Result<Option<Secret>, AiError> {
        validate_provider(provider)?;
        Ok(self.keys.get(provider).map(|key| Secret(key.0.clone())))
    }

    fn remove(&mut self, provider: &str) -> Result<bool, AiError> {
        validate_provider(provider)?;
        Ok(self.keys.remove(provider).is_some())
    }
}
