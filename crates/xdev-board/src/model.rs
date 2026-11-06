//! The values that cross the desktop boundary, and the store's errors.

use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum TaskStatus {
    Backlog,
    Todo,
    InProgress,
    InReview,
    Done,
}

impl TaskStatus {
    /// The text written in the file.
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Backlog => "backlog",
            TaskStatus::Todo => "todo",
            TaskStatus::InProgress => "in-progress",
            TaskStatus::InReview => "in-review",
            TaskStatus::Done => "done",
        }
    }

    pub fn parse(text: &str) -> Option<TaskStatus> {
        Some(match text {
            "backlog" => TaskStatus::Backlog,
            "todo" => TaskStatus::Todo,
            "in-progress" => TaskStatus::InProgress,
            "in-review" => TaskStatus::InReview,
            "done" => TaskStatus::Done,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    P0,
    P1,
    P2,
    P3,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Priority::P0 => "p0",
            Priority::P1 => "p1",
            Priority::P2 => "p2",
            Priority::P3 => "p3",
        }
    }

    pub fn parse(text: &str) -> Option<Priority> {
        Some(match text {
            "p0" => Priority::P0,
            "p1" => Priority::P1,
            "p2" => Priority::P2,
            "p3" => Priority::P3,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BoardTask {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    pub priority: Priority,
    pub assignee: Option<String>,
    pub labels: Vec<String>,
    pub created: String,
    pub updated: String,
    pub branch: Option<String>,
    /// Relative to the repo root, with `/`.
    pub file: String,
    /// The start of the body, at most 200 characters.
    pub body_preview: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TaskDraft {
    pub title: String,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub status: Option<TaskStatus>,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub priority: Option<Priority>,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub assignee: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub body: String,
}

/// Reads a present JSON value, `null` included, as `Some`, so an absent key
/// and `null` differ.
fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Edits to a task. An outer `None` (an absent key) keeps the field;
/// `Some(None)` (`null`) clears it.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub title: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub status: Option<TaskStatus>,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub priority: Option<Priority>,
    #[serde(default, deserialize_with = "present")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub assignee: Option<Option<String>>,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub labels: Option<Vec<String>>,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub body: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub branch: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Unreadable {
    pub file: String,
    pub reason: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BoardList {
    pub tasks: Vec<BoardTask>,
    pub unreadable: Vec<Unreadable>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TaskFull {
    pub task: BoardTask,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BoardError {
    #[error("task not found")]
    NotFound,
    #[error("not a task id")]
    BadId,
    /// The file changed since the caller read it; `current` is what is there.
    #[error("task changed on disk")]
    Conflict { current: Box<BoardTask> },
    #[error("task file is too large")]
    TooLarge,
    #[error("{0}")]
    Parse(String),
    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for BoardError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            BoardError::NotFound
        } else {
            BoardError::Io(e.to_string())
        }
    }
}
