//! Orchestration: runs, a task DAG, workers, mail and decision gates, kept in
//! one SQLite store. Pure logic: no Tauri, no terminals. The app owns the
//! only connection and talks to the UI and the PTYs around these functions.

pub mod error;
pub mod gates;
pub mod guide;
pub mod ids;
pub mod mail;
pub mod model;
pub mod preamble;
pub mod receipts;
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
pub use receipts::{RECEIPT_ROWS, RECEIPT_TTL_MS, Receipt, Reserve, ResetCounts, ResetScope};
pub use runs::RunDetail;
pub use skills::{
    Action, How, INSTALL_COMMAND, InstallOpts, InstallReport, SKILL_NAME, SkillAgent, SkillEnv,
    SkillStatus, SkillTarget, TargetOutcome,
};
pub use store::Store;
pub use tasks::{BRIEF_CHARS, NewTask, TaskFilter, brief};
pub use workers::{
    BREAKER_LIMIT, CLOSE_AFTER_MS, CLOSE_RETRY_MS, StartPlan, StartResult, Swept, WorkerView,
};
