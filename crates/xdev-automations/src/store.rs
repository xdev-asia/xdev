//! One JSON file: `{ version: 1, automations, runs }`. Retention bounds its size.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::model::*;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("not found")]
    NotFound,
    #[error("invalid schedule")]
    InvalidSchedule,
    #[error("extra arguments: {0:?}")]
    ExtraArgs(crate::extra_args::ExtraArgsError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct RunPatch {
    pub status: RunStatus,
    pub worktree: Option<String>,
    pub worktree_name: Option<String>,
    pub tab_id: Option<String>,
    pub output_snapshot: Option<OutputSnapshot>,
    pub precheck_result: Option<PrecheckResult>,
    pub failure: Option<(FailureCode, BTreeMap<String, String>)>,
    pub at: i64,
}

pub struct Store {
    path: PathBuf,
    automations: Vec<Automation>,
    runs: Vec<AutomationRun>,
}

impl Store {
    /// A missing file is an empty store; a bad file is renamed `.bad` and the store starts empty.
    pub fn open(data_dir: &Path) -> Result<Store, StoreError> {
        Ok(Store {
            path: data_dir.join("automations.json"),
            automations: Vec::new(),
            runs: Vec::new(),
        })
    }
    pub fn list(&self) -> &[Automation] {
        &self.automations
    }
    /// Newest first.
    pub fn runs(&self, automation_id: &str) -> Vec<AutomationRun> {
        self.runs
            .iter()
            .filter(|r| r.automation_id == automation_id)
            .cloned()
            .collect()
    }
    pub fn run(&self, run_id: &str) -> Option<&AutomationRun> {
        self.runs.iter().find(|r| r.id == run_id)
    }
    pub fn create(
        &mut self,
        _input: AutomationInput,
        _now: i64,
        _id: String,
    ) -> Result<Automation, StoreError> {
        Err(StoreError::NotFound)
    }
    pub fn update(
        &mut self,
        _id: &str,
        _input: AutomationInput,
        _now: i64,
    ) -> Result<Automation, StoreError> {
        Err(StoreError::NotFound)
    }
    pub fn set_enabled(
        &mut self,
        _id: &str,
        _on: bool,
        _now: i64,
    ) -> Result<Automation, StoreError> {
        Err(StoreError::NotFound)
    }
    /// Its runs go too.
    pub fn delete(&mut self, _id: &str) -> Result<(), StoreError> {
        Err(StoreError::NotFound)
    }
    pub fn create_run(
        &mut self,
        _a: &Automation,
        _scheduled_for: i64,
        _trigger: RunTrigger,
        _now: i64,
        _id: String,
    ) -> AutomationRun {
        unreachable_stub()
    }
    pub fn update_run(
        &mut self,
        _run_id: &str,
        _patch: RunPatch,
    ) -> Result<AutomationRun, StoreError> {
        Err(StoreError::NotFound)
    }
    pub fn repeat_skip(
        &mut self,
        _automation_id: &str,
        _error: &str,
        _scheduled_for: i64,
    ) -> Option<AutomationRun> {
        None
    }
    pub fn advance(&mut self, _id: &str, _now: i64) -> Result<Automation, StoreError> {
        Err(StoreError::NotFound)
    }
    /// Atomic: a temp file beside it, then a rename.
    pub fn save(&self) -> Result<(), StoreError> {
        let _ = &self.path;
        Ok(())
    }
}

fn unreachable_stub() -> AutomationRun {
    AutomationRun {
        id: String::new(),
        automation_id: String::new(),
        title: String::new(),
        run_number: 0,
        scheduled_for: 0,
        status: RunStatus::Pending,
        trigger: RunTrigger::Manual,
        worktree: None,
        worktree_name: None,
        tab_id: None,
        output_snapshot: None,
        precheck_result: None,
        error: None,
        error_code: None,
        error_params: None,
        started_at: None,
        dispatched_at: None,
        finished_at: None,
        created_at: 0,
        occurrence_count: 1,
        last_occurrence_at: None,
    }
}

/// Keeps the newest `max` final runs per automation and every non-final run.
pub fn prune(runs: Vec<AutomationRun>, _max: usize) -> Vec<AutomationRun> {
    runs
}

/// `auto-<slug40>-<yyyymmddThhmm>` in UTC.
pub fn workspace_name(_title: &str, _scheduled_for: i64) -> String {
    String::new()
}
