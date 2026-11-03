//! Domain model and use cases. Runtimes (desktop, CLI, server) depend on this
//! crate, never the other way round, so it must stay free of Tauri.

mod data_dir;
mod error;
mod export;
mod freshness;
mod links;
mod review;
mod sync;

pub use data_dir::{APP_ID, data_dir, local_dir, move_indexes};
pub use error::CoreError;
pub use export::{ExportPlan, ExportedDoc, export_plan, export_root, export_write};
pub use freshness::{
    DocState, FRESHNESS_COMMITS, Freshness, LinkedRepo, Links, StaleDoc, freshness, split_prefix,
    stale_docs,
};
pub use links::{BrokenLink, DocLink, backlinks, broken_links};
pub use review::{
    AiWrites, Change, Origin, Seen, Written, ai_writes, approve, default_message, forget_ai_writes,
    history, list_changes, propose_update, read_base, read_version, reject,
};
pub use sync::{DocEntry, Skip, index_path, search, sync_vault};
// Runtimes open these directly; re-exporting keeps core their only dependency.
pub use xdev_export::{FileStatus, PlannedFile};
pub use xdev_git::{ChangeKind, Commit, GitError, Repo};
pub use xdev_store::{
    AiWrite, ContextPack, ContextSection, Embedder, SearchHit, Store, StoreError,
};
pub use xdev_vault::{
    Frontmatter, Link, LinkKind, Resolver, Target, Vault, VaultError, VaultWatcher, content_hash,
    is_doc_path, parse_frontmatter, parse_links,
};

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
