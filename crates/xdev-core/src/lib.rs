//! Domain model and use cases. Runtimes (desktop, CLI, server) depend on this
//! crate, never the other way round, so it must stay free of Tauri.

mod error;
mod sync;

pub use error::CoreError;
pub use sync::{DocEntry, Skip, index_path, search, sync_vault};
// Runtimes open these directly; re-exporting keeps core their only dependency.
pub use xdev_store::{SearchHit, Store, StoreError};
pub use xdev_vault::{Vault, VaultError, VaultWatcher};

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
