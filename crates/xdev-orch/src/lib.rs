//! Orchestration: runs, a task DAG, workers, mail and decision gates, kept in
//! one SQLite store. Pure logic: no Tauri, no terminals. The app owns the
//! only connection and talks to the UI and the PTYs around these functions.

pub mod error;
pub mod ids;
pub mod model;
pub mod runs;
pub mod skills;
pub mod store;

pub use error::OrchError;
pub use model::*;
pub use runs::RunDetail;
pub use skills::{SKILL_NAME, SkillAgent, SkillStatus, SkillTarget};
pub use store::Store;
