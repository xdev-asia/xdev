//! Scheduled agent runs: the model, schedule parsing, occurrences in the automation's time
//! zone, the JSON store, the tick decision, retention, the extra-args allowlist and the
//! precheck runner. Pure logic; the desktop app owns tabs, worktrees and the tick thread.

pub mod extra_args;
pub mod model;
pub mod occur;
pub mod precheck;
pub mod schedule;
pub mod store;
pub mod tick;

pub use extra_args::{ExtraArgsError, parse_extra_args};
pub use model::*;
pub use schedule::{Describe, ParseOptions, Preset, Schedule, ScheduleError};
pub use store::{RunPatch, Store, StoreError};
