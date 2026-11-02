use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use crate::id::valid_id;
use crate::{AgentError, Task, TaskState};

const FILE: &str = "task.json";

/// Tasks with a run going in this process. A task saved as `running` that
/// is not in here was left by a run that is gone.
static LIVE: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

fn live() -> MutexGuard<'static, BTreeSet<String>> {
    // A panic elsewhere must not stop every later task from loading.
    LIVE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Marks a task live until dropped, so a run that panics still lets go.
pub(crate) struct LiveGuard(String);

impl LiveGuard {
    /// `None` when a run of this task is already going here.
    pub(crate) fn take(id: &str) -> Option<LiveGuard> {
        live()
            .insert(id.to_owned())
            .then(|| LiveGuard(id.to_owned()))
    }
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        live().remove(&self.0);
    }
}

/// Task records under `<data_dir>/tasks/<id>/task.json`, worktrees of new
/// tasks under `<local_dir>/worktrees/<id>`. A task keeps the worktree path
/// it was made with, so moving the local dir never strands one.
#[derive(Debug, Clone)]
pub struct TaskStore {
    pub data_dir: PathBuf,
    pub local_dir: PathBuf,
}

impl TaskStore {
    /// Records and worktrees in one dir.
    pub fn new(data_dir: impl Into<PathBuf>) -> TaskStore {
        let data_dir = data_dir.into();
        TaskStore {
            local_dir: data_dir.clone(),
            data_dir,
        }
    }

    /// Records in `data_dir`, worktrees in `local_dir`, where a roaming
    /// profile does not sync them.
    pub fn with_local(data_dir: impl Into<PathBuf>, local_dir: impl Into<PathBuf>) -> TaskStore {
        TaskStore {
            data_dir: data_dir.into(),
            local_dir: local_dir.into(),
        }
    }

    pub fn worktree_path(&self, id: &str) -> PathBuf {
        self.local_dir.join("worktrees").join(id)
    }

    fn task_dir(&self, id: &str) -> PathBuf {
        self.data_dir.join("tasks").join(id)
    }

    /// Writes a new record; fails if one with this id exists.
    pub fn create(&self, task: &Task) -> Result<(), AgentError> {
        fs::create_dir_all(self.data_dir.join("tasks"))?;
        fs::create_dir(self.task_dir(&task.id))?;
        self.save(task)
    }

    pub fn load(&self, id: &str) -> Result<Task, AgentError> {
        if !valid_id(id) {
            return Err(AgentError::NotFound);
        }
        let text = match fs::read_to_string(self.task_dir(id).join(FILE)) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(AgentError::NotFound),
            Err(e) => return Err(e.into()),
        };
        let mut task: Task = serde_json::from_str(&text)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        if task.state == TaskState::Running && !live().contains(&task.id) {
            task.state = TaskState::Paused;
        }
        Ok(task)
    }

    pub fn save(&self, task: &Task) -> Result<(), AgentError> {
        let mut text = serde_json::to_string_pretty(task).map_err(io::Error::other)?;
        text.push('\n');
        write_atomic(&self.task_dir(&task.id), FILE, &text)?;
        Ok(())
    }

    /// Every readable task, newest first. A folder that is not a task, or a
    /// record that does not parse, is skipped rather than hiding the rest.
    pub fn list(&self) -> Result<Vec<Task>, AgentError> {
        let entries = match fs::read_dir(self.data_dir.join("tasks")) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut tasks = Vec::new();
        for entry in entries {
            let name = entry?.file_name();
            if let Some(task) = name.to_str().and_then(|id| self.load(id).ok()) {
                tasks.push(task);
            }
        }
        // Ids start with the UTC time, so they order like `created`.
        tasks.sort_by(|a, b| b.id.cmp(&a.id));
        Ok(tasks)
    }
}

pub(crate) fn write_atomic(dir: &Path, name: &str, content: &str) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    // Same folder as the target so the rename never crosses a filesystem and
    // a reader never sees a half-written record.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".{name}-{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = File::create_new(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, dir.join(name))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
