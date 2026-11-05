//! One JSON file: `{ version: 1, automations, runs }`. Retention bounds its size.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::extra_args::ExtraArgsError;
use crate::model::*;
use crate::{occur, precheck, schedule};

const FILE_VERSION: u32 = 1;
const DEFAULT_NAME: &str = "Untitled automation";
/// A rule that cannot be evaluated is looked at again after this long.
const RETRY_BAD_RULE_MS: i64 = 3_600_000;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("not found")]
    NotFound,
    #[error("invalid schedule")]
    InvalidSchedule,
    /// Not an IANA zone name this build knows (a stored one falls back to the system zone).
    #[error("unknown time zone")]
    UnknownTimezone,
    #[error("extra arguments: {0:?}")]
    ExtraArgs(ExtraArgsError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
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

#[derive(Serialize, Deserialize)]
struct FileData {
    version: u32,
    #[serde(default)]
    automations: Vec<Automation>,
    #[serde(default)]
    runs: Vec<AutomationRun>,
}

pub struct Store {
    path: PathBuf,
    automations: Vec<Automation>,
    runs: Vec<AutomationRun>,
}

/// The input as it is stored: trimmed, defaults filled, fields the mode cannot use dropped.
fn clean(mut i: AutomationInput, now: i64) -> Result<AutomationInput, StoreError> {
    let name = i.name.trim();
    i.name = if name.is_empty() {
        DEFAULT_NAME.into()
    } else {
        name.into()
    };
    i.precheck = precheck::normalize(i.precheck);
    i.extra_agent_args = i
        .extra_agent_args
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty());
    i.base_branch = i.base_branch.filter(|b| !b.trim().is_empty());
    match i.workspace_mode {
        WorkspaceMode::Existing => i.base_branch = None,
        WorkspaceMode::NewPerRun => {
            i.worktree = None;
            i.reuse_session = false;
        }
    }
    if i.extra_agent_args.is_some() && i.reuse_session {
        return Err(StoreError::ExtraArgs(ExtraArgsError::RequireFreshSession));
    }
    if jiff::tz::TimeZone::get(&i.timezone).is_err() {
        return Err(StoreError::UnknownTimezone);
    }
    if !schedule::is_valid_new(&i.rrule, &i.timezone, now) {
        return Err(StoreError::InvalidSchedule);
    }
    Ok(i)
}

fn next_run(rrule: &str, tz: &str, dtstart: i64, now: i64) -> Result<i64, StoreError> {
    occur::next_after(rrule, tz, dtstart, now).map_err(|_| StoreError::InvalidSchedule)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no folder"))?;
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}-{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = fs::File::create_new(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

impl Store {
    /// A missing file is an empty store; a bad file is renamed `.bad` and the store starts empty.
    pub fn open(data_dir: &Path) -> Result<Store, StoreError> {
        let path = data_dir.join("automations.json");
        let mut store = Store {
            path: path.clone(),
            automations: Vec::new(),
            runs: Vec::new(),
        };
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(store),
            Err(e) => return Err(e.into()),
        };
        match serde_json::from_str::<FileData>(&text) {
            Ok(f) if f.version == FILE_VERSION => {
                store.automations = f.automations;
                store.runs = f.runs;
            }
            _ => {
                // `.bad-<ms>`, never overwriting an earlier copy.
                let ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis());
                let bad = (0u32..)
                    .map(|n| {
                        let mut name = path.clone().into_os_string();
                        name.push(if n == 0 {
                            format!(".bad-{ms}")
                        } else {
                            format!(".bad-{ms}-{n}")
                        });
                        PathBuf::from(name)
                    })
                    .find(|p| !p.exists())
                    .unwrap_or_else(|| path.with_extension("json.bad"));
                fs::rename(&path, bad)?;
            }
        }
        Ok(store)
    }

    pub fn list(&self) -> &[Automation] {
        &self.automations
    }

    /// Newest first.
    pub fn runs(&self, automation_id: &str) -> Vec<AutomationRun> {
        let mut runs: Vec<_> = self
            .runs
            .iter()
            .filter(|r| r.automation_id == automation_id)
            .cloned()
            .collect();
        runs.sort_by_key(|r| std::cmp::Reverse(r.run_number));
        runs
    }

    pub fn run(&self, run_id: &str) -> Option<&AutomationRun> {
        self.runs.iter().find(|r| r.id == run_id)
    }

    pub fn create(
        &mut self,
        input: AutomationInput,
        now: i64,
        id: String,
    ) -> Result<Automation, StoreError> {
        let i = clean(input, now)?;
        let next_run_at = next_run(&i.rrule, &i.timezone, i.dtstart, now)?;
        let a = Automation {
            id,
            name: i.name,
            prompt: i.prompt,
            precheck: i.precheck,
            agent: i.agent,
            extra_agent_args: i.extra_agent_args,
            repo_id: i.repo_id,
            workspace_mode: i.workspace_mode,
            worktree: i.worktree,
            base_branch: i.base_branch,
            setup_decision: i.setup_decision,
            reuse_session: i.reuse_session,
            timezone: i.timezone,
            rrule: i.rrule,
            dtstart: i.dtstart,
            enabled: i.enabled,
            next_run_at,
            last_run_at: None,
            missed_run_grace_minutes: i.missed_run_grace_minutes,
            created_at: now,
            updated_at: now,
        };
        self.automations.push(a.clone());
        Ok(a)
    }

    pub fn update(
        &mut self,
        id: &str,
        input: AutomationInput,
        now: i64,
    ) -> Result<Automation, StoreError> {
        let pos = self.position(id)?;
        let i = clean(input, now)?;
        let next_run_at = next_run(&i.rrule, &i.timezone, i.dtstart, now)?;
        let a = &mut self.automations[pos];
        a.name = i.name;
        a.prompt = i.prompt;
        a.precheck = i.precheck;
        a.agent = i.agent;
        a.extra_agent_args = i.extra_agent_args;
        a.repo_id = i.repo_id;
        a.workspace_mode = i.workspace_mode;
        a.worktree = i.worktree;
        a.base_branch = i.base_branch;
        a.setup_decision = i.setup_decision;
        a.reuse_session = i.reuse_session;
        a.timezone = i.timezone;
        a.rrule = i.rrule;
        a.dtstart = i.dtstart;
        a.enabled = i.enabled;
        a.missed_run_grace_minutes = i.missed_run_grace_minutes;
        a.next_run_at = next_run_at;
        a.updated_at = now;
        Ok(a.clone())
    }

    /// Resuming looks ahead from `now`, so a pause never replays what it missed.
    pub fn set_enabled(&mut self, id: &str, on: bool, now: i64) -> Result<Automation, StoreError> {
        let pos = self.position(id)?;
        let a = &mut self.automations[pos];
        a.enabled = on;
        a.updated_at = now;
        if on {
            a.next_run_at = occur::next_after(&a.rrule, &a.timezone, a.dtstart, now)
                .unwrap_or(now + RETRY_BAD_RULE_MS);
        }
        Ok(a.clone())
    }

    /// Its runs go too.
    pub fn delete(&mut self, id: &str) -> Result<(), StoreError> {
        let pos = self.position(id)?;
        self.automations.remove(pos);
        self.runs.retain(|r| r.automation_id != id);
        Ok(())
    }

    pub fn create_run(
        &mut self,
        a: &Automation,
        scheduled_for: i64,
        trigger: RunTrigger,
        now: i64,
        id: String,
    ) -> AutomationRun {
        let run_number = self
            .runs
            .iter()
            .filter(|r| r.automation_id == a.id)
            .map(|r| r.run_number)
            .max()
            .unwrap_or(0)
            + 1;
        let run = AutomationRun {
            id,
            automation_id: a.id.clone(),
            title: format!("{} run {run_number}", a.name),
            run_number,
            scheduled_for,
            status: RunStatus::Pending,
            trigger,
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
            created_at: now,
            occurrence_count: 1,
            last_occurrence_at: None,
        };
        self.runs.push(run.clone());
        if let Some(auto) = self.automations.iter_mut().find(|x| x.id == a.id) {
            auto.last_run_at = Some(now);
        }
        self.runs = prune(std::mem::take(&mut self.runs), MAX_RUNS_PER_AUTOMATION);
        run
    }

    /// Fields the patch leaves out keep their value.
    pub fn update_run(
        &mut self,
        run_id: &str,
        patch: RunPatch,
    ) -> Result<AutomationRun, StoreError> {
        let r = self
            .runs
            .iter_mut()
            .find(|r| r.id == run_id)
            .ok_or(StoreError::NotFound)?;
        r.status = patch.status;
        if patch.worktree.is_some() {
            r.worktree = patch.worktree;
        }
        if patch.worktree_name.is_some() {
            r.worktree_name = patch.worktree_name;
        }
        if patch.tab_id.is_some() {
            r.tab_id = patch.tab_id;
        }
        if patch.output_snapshot.is_some() {
            r.output_snapshot = patch.output_snapshot;
        }
        if patch.precheck_result.is_some() {
            r.precheck_result = patch.precheck_result;
        }
        if let Some((code, params)) = patch.failure {
            r.error = Some(code.english(&params));
            r.error_code = Some(code);
            r.error_params = (!params.is_empty()).then_some(params);
        }
        match patch.status {
            RunStatus::Pending => {}
            RunStatus::Dispatching => {
                r.started_at.get_or_insert(patch.at);
            }
            RunStatus::Dispatched => {
                r.started_at.get_or_insert(patch.at);
                r.dispatched_at = Some(patch.at);
            }
            _ => r.finished_at = Some(patch.at),
        }
        let out = r.clone();
        if out.status.is_final() {
            self.runs = prune(std::mem::take(&mut self.runs), MAX_RUNS_PER_AUTOMATION);
        }
        Ok(out)
    }

    /// Folds a repeated refusal into the newest run when that run is a scheduled
    /// `skipped_unavailable` with the same error; the same occurrence twice changes nothing.
    /// `None` means the caller records a new run.
    pub fn repeat_skip(
        &mut self,
        automation_id: &str,
        error: &str,
        scheduled_for: i64,
    ) -> Option<AutomationRun> {
        let newest = self
            .runs
            .iter_mut()
            .filter(|r| r.automation_id == automation_id)
            .max_by_key(|r| r.run_number)?;
        if newest.status != RunStatus::SkippedUnavailable
            || newest.trigger != RunTrigger::Scheduled
            || newest.error.as_deref() != Some(error)
        {
            return None;
        }
        if scheduled_for > newest.last_occurrence_at.unwrap_or(newest.scheduled_for) {
            newest.occurrence_count += 1;
            newest.last_occurrence_at = Some(scheduled_for);
        }
        Some(newest.clone())
    }

    /// `next_run_at` becomes the first occurrence after `now`. A rule that cannot be
    /// evaluated is looked at again in an hour, so one bad row never stalls the tick.
    pub fn advance(&mut self, id: &str, now: i64) -> Result<Automation, StoreError> {
        let pos = self.position(id)?;
        let a = &mut self.automations[pos];
        a.next_run_at = occur::next_after(&a.rrule, &a.timezone, a.dtstart, now)
            .unwrap_or(now + RETRY_BAD_RULE_MS);
        Ok(a.clone())
    }

    /// Atomic: a temp file beside it, then a rename.
    pub fn save(&self) -> Result<(), StoreError> {
        let data = FileData {
            version: FILE_VERSION,
            automations: self.automations.clone(),
            runs: self.runs.clone(),
        };
        write_atomic(&self.path, &serde_json::to_vec_pretty(&data)?)?;
        Ok(())
    }

    fn position(&self, id: &str) -> Result<usize, StoreError> {
        self.automations
            .iter()
            .position(|a| a.id == id)
            .ok_or(StoreError::NotFound)
    }
}

/// Keeps the newest `max` final runs per automation and every non-final run.
pub fn prune(runs: Vec<AutomationRun>, max: usize) -> Vec<AutomationRun> {
    let mut finals: HashMap<&str, Vec<(u32, &str)>> = HashMap::new();
    for r in runs.iter().filter(|r| r.status.is_final()) {
        finals
            .entry(&r.automation_id)
            .or_default()
            .push((r.run_number, &r.id));
    }
    let mut drop: HashSet<String> = HashSet::new();
    for list in finals.values_mut() {
        list.sort_by_key(|e| std::cmp::Reverse(e.0));
        drop.extend(list.iter().skip(max).map(|(_, id)| (*id).to_string()));
    }
    runs.into_iter().filter(|r| !drop.contains(&r.id)).collect()
}

/// `auto-<slug40>-<yyyymmddThhmm>` in UTC.
pub fn workspace_name(title: &str, scheduled_for: i64) -> String {
    let mut slug = String::new();
    for c in title.chars().map(|c| c.to_ascii_lowercase()) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(40).collect();
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() { "run" } else { slug };
    let when = jiff::Timestamp::from_millisecond(scheduled_for)
        .map(|t| {
            t.to_zoned(jiff::tz::TimeZone::UTC)
                .strftime("%Y%m%dT%H%M")
                .to_string()
        })
        .unwrap_or_else(|_| "00000000T0000".into());
    format!("auto-{slug}-{when}")
}
