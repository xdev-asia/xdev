//! Agent kit: reads the agent homes, their skills and memory files, and the
//! CLI session logs on this machine. Writes only through `write`.

mod homes;

pub use homes::{Agent, Home, HomeSource, KitError, approx_tokens, homes};
