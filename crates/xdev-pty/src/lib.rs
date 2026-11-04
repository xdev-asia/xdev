//! Terminals for the desktop app: a shell or an agent CLI in a pseudo
//! console, its output batched for the UI and paused when the UI falls
//! behind. `proto` is what the app and the `xdev-ptyd` service say to each
//! other.

pub mod proto;
mod pump;
pub mod ring;
mod session;

pub use pump::{COALESCE, Flow, READ_CHUNK, WINDOW};
pub use session::{PtyError, Session, SpawnSpec};
