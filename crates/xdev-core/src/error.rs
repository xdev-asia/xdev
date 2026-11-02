use xdev_export::ExportError;
use xdev_git::GitError;
use xdev_store::StoreError;
use xdev_vault::VaultError;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error(transparent)]
    Vault(#[from] VaultError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Export(#[from] ExportError),
    #[error("pending edits that are not the agent's own")]
    Conflict,
    #[error("a change was edited after it was reviewed")]
    Changed,
}

impl CoreError {
    /// Stable code the UI and CLI translate. Store failures are all `io`: the
    /// index is a rebuildable cache, so the user cannot act on the difference.
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::Vault(e) => e.code(),
            CoreError::Store(_) => "io",
            CoreError::Git(e) => e.code(),
            CoreError::Export(e) => e.code(),
            CoreError::Conflict => "conflict",
            CoreError::Changed => "changed",
        }
    }
}
