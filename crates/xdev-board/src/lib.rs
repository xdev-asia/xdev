//! The file-backed task board: one Markdown file per task in
//! `.xdev/tasks`. Pure logic, no UI and no Tauri.

pub mod frontmatter;
pub mod model;
pub mod store;
pub mod sync;

pub use model::{
    BoardError, BoardList, BoardTask, Priority, TaskDraft, TaskFull, TaskPatch, TaskStatus,
    Unreadable,
};
pub use store::{Board, MAX_FILE_BYTES, MAX_FILES, TASKS_DIR, valid_id};
