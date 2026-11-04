//! Orchestration: runs, a task DAG, workers, mail and decision gates, kept in
//! one SQLite store. Pure logic: no Tauri, no terminals. The app owns the
//! only connection and talks to the UI and the PTYs around these functions.

pub mod error;
pub mod gates;
pub mod ids;
pub mod mail;
pub mod model;
pub mod preamble;
pub mod render;
pub mod runs;
pub mod skills;
pub mod store;
pub mod tasks;
pub mod workers;

pub use error::OrchError;
pub use gates::AskAnswer;
pub use mail::{CheckOpts, Identity, InboxRow, NewMessage, SendReceipt, Wake};
pub use model::*;
pub use preamble::{PreambleInput, SPEC_BUDGET, build as build_preamble};
pub use runs::RunDetail;
pub use skills::{SKILL_NAME, SkillAgent, SkillStatus, SkillTarget};
pub use store::Store;
pub use tasks::{BRIEF_CHARS, NewTask, TaskFilter, brief};
pub use workers::{BREAKER_LIMIT, CLOSE_AFTER_MS, StartPlan, StartResult, WorkerView};
