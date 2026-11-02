//! Terminals for the desktop app: a shell or an agent CLI in a pseudo
//! console, its output batched for the UI and paused when the UI falls
//! behind.

mod pump;

pub use pump::{COALESCE, Flow, READ_CHUNK, WINDOW};
