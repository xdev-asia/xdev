use xdev_store::StoreError;
use xdev_vault::VaultError;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error(transparent)]
    Vault(#[from] VaultError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl CoreError {
    /// Stable code the UI and CLI translate. Store failures are all `io`: the
    /// index is a rebuildable cache, so the user cannot act on the difference.
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::Vault(e) => e.code(),
            CoreError::Store(_) => "io",
        }
    }
}
