//! The task status and the worktree kanban's `WorkStatus`, as one table.

use crate::model::TaskStatus;

/// The worktree status for a task status, as its serde name; `"none"` clears
/// the worktree's status.
pub fn status_to_work(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Backlog => "none",
        TaskStatus::Todo => "todo",
        TaskStatus::InProgress => "in-progress",
        TaskStatus::InReview => "in-review",
        TaskStatus::Done => "completed",
    }
}

/// The task status for a worktree status (`"none"` for no status).
pub fn work_to_status(work: &str) -> Option<TaskStatus> {
    Some(match work {
        "none" => TaskStatus::Backlog,
        "todo" => TaskStatus::Todo,
        "in-progress" => TaskStatus::InProgress,
        "in-review" => TaskStatus::InReview,
        "completed" => TaskStatus::Done,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [TaskStatus; 5] = [
        TaskStatus::Backlog,
        TaskStatus::Todo,
        TaskStatus::InProgress,
        TaskStatus::InReview,
        TaskStatus::Done,
    ];

    #[test]
    fn every_status_maps_both_ways() {
        for s in ALL {
            assert_eq!(work_to_status(status_to_work(s)), Some(s));
        }
        assert_eq!(status_to_work(TaskStatus::Done), "completed");
        assert_eq!(status_to_work(TaskStatus::Backlog), "none");
        assert_eq!(work_to_status("bogus"), None);
    }
}
