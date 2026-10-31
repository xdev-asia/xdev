//! Domain model and use cases. Runtimes (desktop, CLI, server) depend on this
//! crate, never the other way round, so it must stay free of Tauri.

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
