//! The agent kit's commands: the agent homes, their skills and memory files,
//! checked writes, the token usage index, the prompt history, and the
//! composer's drafts and prompt templates. Every path
//! the UI sends is checked by `xdev_kit::Roots`; a worktree the UI names must
//! also be one the workspace registry knows, or the call is `outside`.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use xdev_kit::{
    Agent, Drafts, Home, KitError, MemorySet, PromptTemplate, RefreshStats, ReportQuery, Roots,
    Skill, Templates, UsageIndex, UsageQuery, UsageReport, UsageSummary,
};
use xdev_workspace::{Registry, path_key};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::settings::ProviderSwitches;
use crate::settings_store;

/// The newest part of a history file that is read. The UI shows a short list,
/// so older lines of a huge file are never opened.
const HISTORY_TAIL_BYTES: u64 = 4 << 20;
/// The most prompts one call returns.
const HISTORY_MAX: usize = 1000;

/// One refresh at a time: each loads the index, reads the new log bytes and
/// saves, so two at once would drop one of the two updates. The index is
/// loaded from the file on every call and not kept in memory: it can hold
/// every session of every home, and the file is the one source of truth.
static USAGE_LOCK: Mutex<()> = Mutex::new(());
/// One read-modify-write of the drafts file at a time.
static DRAFTS_LOCK: Mutex<()> = Mutex::new(());
/// One read-modify-write of the templates file at a time.
static TEMPLATES_LOCK: Mutex<()> = Mutex::new(());

impl From<KitError> for CmdError {
    fn from(e: KitError) -> CmdError {
        let code = match e {
            KitError::Changed => "changed",
            KitError::Outside(_) => "outside",
            KitError::Io(_) => "io",
            KitError::Parse(ref m) => match m.as_str() {
                "bad skill name" => "bad_name",
                "not UTF-8 text" => "not_utf8",
                "draft too large" | "template too large" => "too_large",
                "too many templates" => "too_many",
                _ => "kit_bad_input",
            },
        };
        CmdError {
            code,
            detail: Some(e.to_string()),
        }
    }
}

/// Whose usage the Stats page counts: the sessions under the registry's repos
/// and worktrees, or everything the logs hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum UsageScope {
    Xdev,
    All,
}

/// The arguments of `kit_usage_report`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct UsageReportArgs {
    /// `None` is All time.
    pub since_day: Option<String>,
    pub until_day: String,
    /// `None` is the overview of both agents.
    pub agent: Option<Agent>,
    pub scope: UsageScope,
    pub refresh: bool,
    pub utc_offset_minutes: i32,
}

/// What a file holds and the stamp to give back when saving it.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct KitText {
    text: String,
    stamp: String,
}

/// One prompt the person typed into an agent CLI.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PromptEntry {
    agent: Agent,
    text: String,
    /// Milliseconds since the epoch; 0 when the line has no time.
    at: i64,
}

fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// `USERPROFILE`, else `HOME`; an empty value counts as unset.
fn user_home_from(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    ["USERPROFILE", "HOME"]
        .into_iter()
        .find_map(|k| env(k).filter(|v| !v.is_empty()))
        .map(PathBuf::from)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// What every call needs: the app data dir and the user's home folder.
pub(crate) struct Ctx {
    pub(crate) data: PathBuf,
    user_home: PathBuf,
    env: fn(&str) -> Option<String>,
}

impl Ctx {
    pub(crate) fn of(state: &AppState) -> Result<Ctx, CmdError> {
        let user_home = user_home_from(&process_env).ok_or(CmdError {
            code: "io",
            detail: Some("no home dir".into()),
        })?;
        Ok(Ctx {
            data: data_dir(state)?.to_owned(),
            user_home,
            env: process_env,
        })
    }

    pub(crate) fn user_home(&self) -> &Path {
        &self.user_home
    }

    pub(crate) fn homes(&self) -> Vec<Home> {
        xdev_kit::homes(&self.data, &self.user_home, &self.env)
    }

    /// The registry's own spelling of a repo or worktree folder, when `path` is one.
    fn known_folders(&self) -> Result<Vec<PathBuf>, CmdError> {
        let reg = Registry::load(&self.data)?;
        Ok(reg
            .repos
            .into_iter()
            .map(|r| r.path)
            .chain(reg.worktrees.into_iter().map(|m| m.path))
            .collect())
    }

    /// A worktree the UI names must be a repo or worktree the workspace
    /// registry holds, so a crafted call cannot widen the writable roots to
    /// any folder on the disk. `None` stays `None`.
    fn worktree(&self, worktree: Option<String>) -> Result<Option<PathBuf>, CmdError> {
        let Some(given) = worktree else {
            return Ok(None);
        };
        let key = path_key(Path::new(&given));
        match self
            .known_folders()?
            .into_iter()
            .find(|p| path_key(p) == key)
        {
            Some(known) => Ok(Some(known)),
            None => Err(KitError::Outside(PathBuf::from(given)).into()),
        }
    }

    fn roots(&self, worktree: Option<String>) -> Result<Roots, CmdError> {
        Ok(Roots {
            homes: self.homes().into_iter().map(|h| h.path).collect(),
            worktree: self.worktree(worktree)?,
            data_dir: self.data.clone(),
        })
    }

    fn skills(&self, worktree: Option<String>) -> Result<Vec<Skill>, CmdError> {
        let wt = self.worktree(worktree)?;
        let mut all = xdev_kit::scan_skills(&self.homes(), wt.as_deref());
        all.extend(xdev_kit::scan_agent_roots(self.user_home()));
        xdev_kit::mark_duplicates(&mut all);
        Ok(all)
    }

    fn memory(&self, worktree: Option<String>) -> Result<MemorySet, CmdError> {
        let wt = self.worktree(worktree)?;
        Ok(xdev_kit::scan_memory(&self.homes(), wt.as_deref()))
    }

    fn read(&self, path: &str, worktree: Option<String>) -> Result<KitText, CmdError> {
        let roots = self.roots(worktree)?;
        let (text, stamp) = xdev_kit::read_for_edit(&roots, Path::new(path))?;
        Ok(KitText { text, stamp })
    }

    fn write(
        &self,
        path: &str,
        text: &str,
        stamp: Option<String>,
        worktree: Option<String>,
    ) -> Result<String, CmdError> {
        let roots = self.roots(worktree)?;
        Ok(xdev_kit::write_checked(
            &roots,
            Path::new(path),
            text,
            stamp.as_deref(),
        )?)
    }

    fn copy(&self, from: &str, to: &str, worktree: Option<String>) -> Result<(), CmdError> {
        let roots = self.roots(worktree)?;
        Ok(xdev_kit::copy_file(&roots, Path::new(from), Path::new(to))?)
    }

    fn skill_copy(
        &self,
        dir: &str,
        to_skills_dir: &str,
        worktree: Option<String>,
    ) -> Result<String, CmdError> {
        let roots = self.roots(worktree)?;
        let made = xdev_kit::copy_skill_dir(&roots, Path::new(dir), Path::new(to_skills_dir))?;
        Ok(path_string(&made))
    }

    fn skill_new(
        &self,
        skills_dir: &str,
        name: &str,
        description: &str,
        worktree: Option<String>,
    ) -> Result<String, CmdError> {
        let roots = self.roots(worktree)?;
        let made = xdev_kit::new_skill(&roots, Path::new(skills_dir), name, description)?;
        Ok(path_string(&made))
    }

    fn skill_remove(&self, dir: &str, worktree: Option<String>) -> Result<String, CmdError> {
        let roots = self.roots(worktree)?;
        let moved = xdev_kit::remove_skill(&roots, Path::new(dir))?;
        Ok(path_string(&moved))
    }

    fn skill_restore(
        &self,
        removed: &str,
        to: &str,
        worktree: Option<String>,
    ) -> Result<(), CmdError> {
        let roots = self.roots(worktree)?;
        Ok(xdev_kit::restore_skill(
            &roots,
            Path::new(removed),
            Path::new(to),
        )?)
    }

    /// Whether each relative path exists under `root`. `root` must be an
    /// agent home or a repo or worktree the workspace knows; a path that is
    /// absolute, empty or leaves `root` is reported as missing.
    fn paths_exist(&self, root: &str, paths: &[String]) -> Result<Vec<bool>, CmdError> {
        let outside = || CmdError::from(KitError::Outside(PathBuf::from(root)));
        let root = Path::new(root).canonicalize().map_err(|_| outside())?;
        let allowed: Vec<PathBuf> = self
            .homes()
            .into_iter()
            .map(|h| h.path)
            .chain(self.known_folders()?)
            .filter_map(|p| p.canonicalize().ok())
            .collect();
        if !allowed.iter().any(|a| root.starts_with(a)) {
            return Err(outside());
        }
        Ok(paths
            .iter()
            .map(|p| {
                let rel = Path::new(p);
                let plain = rel.components().all(|c| matches!(c, Component::Normal(_)));
                // `a.txt:stream` would name a stream of the file, not a path.
                let stream = cfg!(windows) && p.contains(':');
                !p.is_empty() && plain && !stream && root.join(rel).exists()
            })
            .collect())
    }

    /// Reads the new bytes of the session logs, when asked, and sums a range
    /// of days. The index is saved after each refresh.
    fn usage(
        &self,
        since_day: &str,
        until_day: &str,
        refresh: bool,
        utc_offset_minutes: i32,
    ) -> Result<UsageSummary, CmdError> {
        let _guard = USAGE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let mut index = UsageIndex::load(&self.data);
        if refresh {
            index.refresh(&self.homes(), utc_offset_minutes);
            index.save(&self.data)?;
        }
        Ok(xdev_kit::summarize(
            &index,
            &UsageQuery {
                since_day: since_day.to_owned(),
                until_day: until_day.to_owned(),
            },
        ))
    }

    /// The Stats page: the report of the agents whose scan switch is on. A
    /// refresh reads only their homes; with both off no log is opened.
    fn usage_report(
        &self,
        args: &UsageReportArgs,
        scan: ProviderSwitches,
    ) -> Result<(UsageReport, RefreshStats), CmdError> {
        let wanted = match args.agent {
            Some(agent) => vec![agent],
            None => vec![Agent::Claude, Agent::Codex],
        };
        let agents: Vec<Agent> = wanted
            .into_iter()
            .filter(|a| match a {
                Agent::Claude => scan.claude,
                Agent::Codex => scan.codex,
            })
            .collect();
        let folders = match args.scope {
            UsageScope::All => None,
            UsageScope::Xdev => Some(
                self.known_folders()?
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect(),
            ),
        };
        let _guard = USAGE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let mut index = UsageIndex::load(&self.data);
        let mut stats = RefreshStats::default();
        if args.refresh {
            let homes: Vec<Home> = self
                .homes()
                .into_iter()
                .filter(|h| agents.contains(&h.agent))
                .collect();
            stats = index.refresh(&homes, args.utc_offset_minutes);
            index.save(&self.data)?;
        }
        let report = xdev_kit::report(
            &index,
            &ReportQuery {
                since_day: args.since_day.clone(),
                until_day: args.until_day.clone(),
                agents,
                folders,
            },
        );
        Ok((report, stats))
    }

    /// The newest prompts of the own Claude home and of every Codex home,
    /// newest first. Read on every call and never kept: prompts can hold
    /// secrets.
    fn prompt_history(&self, limit: usize) -> Vec<PromptEntry> {
        let mut found: Vec<PromptEntry> = Vec::new();
        for home in self.homes() {
            let claude = home.agent == Agent::Claude;
            if claude && home.id != "own-claude" {
                continue;
            }
            let Some(text) = read_tail(&home.path.join("history.jsonl")) else {
                continue;
            };
            // A file is oldest first; reversed, a stable sort keeps the
            // later line first among lines with the same time.
            for line in text.lines().rev() {
                if let Some(entry) = history_line(home.agent, line) {
                    found.push(entry);
                }
            }
        }
        found.sort_by_key(|e| std::cmp::Reverse(e.at));
        found.truncate(limit.min(HISTORY_MAX));
        found
    }
}

impl Ctx {
    fn draft_get(&self, tab_id: &str) -> Option<String> {
        let _guard = DRAFTS_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        Drafts::load(&self.data).get(tab_id).map(str::to_owned)
    }

    fn draft_put(&self, tab_id: &str, text: &str, at: i64) -> Result<(), CmdError> {
        let _guard = DRAFTS_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let mut drafts = Drafts::load(&self.data);
        drafts.put(tab_id, text, at)?;
        drafts.save(&self.data)?;
        Ok(())
    }

    fn draft_clear(&self, tab_id: &str) -> Result<bool, CmdError> {
        let _guard = DRAFTS_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let mut drafts = Drafts::load(&self.data);
        let had = drafts.clear(tab_id);
        if had {
            drafts.save(&self.data)?;
        }
        Ok(had)
    }

    fn templates_list(&self) -> Vec<PromptTemplate> {
        let _guard = TEMPLATES_LOCK
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        Templates::load(&self.data).list()
    }

    fn templates_put(&self, template: PromptTemplate) -> Result<Vec<PromptTemplate>, CmdError> {
        let _guard = TEMPLATES_LOCK
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut all = Templates::load(&self.data);
        all.put(template)?;
        all.save(&self.data)?;
        Ok(all.list())
    }

    fn templates_delete(&self, id: &str) -> Result<Vec<PromptTemplate>, CmdError> {
        let _guard = TEMPLATES_LOCK
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut all = Templates::load(&self.data);
        if all.delete(id) {
            all.save(&self.data)?;
        }
        Ok(all.list())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The last `HISTORY_TAIL_BYTES` of a file as text. When the file was cut,
/// the first line is dropped, as it may be a part of one.
fn read_tail(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let cut = len > HISTORY_TAIL_BYTES;
    if cut {
        file.seek(SeekFrom::Start(len - HISTORY_TAIL_BYTES)).ok()?;
    }
    let mut bytes = Vec::new();
    file.take(HISTORY_TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if !cut {
        return Some(text);
    }
    Some(
        text.split_once('\n')
            .map_or_else(String::new, |(_, rest)| rest.to_owned()),
    )
}

/// One history line. Claude writes `display` and a time in milliseconds;
/// Codex writes `text` and a time in seconds
/// [Unverified: the Codex file name and fields, from one observed format].
fn history_line(agent: Agent, line: &str) -> Option<PromptEntry> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let (text_key, time_key, unit) = match agent {
        Agent::Claude => ("display", "timestamp", 1.0),
        Agent::Codex => ("text", "ts", 1000.0),
    };
    let text = value.get(text_key)?.as_str()?;
    if text.trim().is_empty() {
        return None;
    }
    let at = value
        .get(time_key)
        .and_then(serde_json::Value::as_f64)
        .map_or(0, |t| (t * unit) as i64);
    Some(PromptEntry {
        agent,
        text: text.to_owned(),
        at,
    })
}

#[tauri::command(async)]
pub fn kit_homes(state: State<'_, AppState>) -> Result<Vec<Home>, CmdError> {
    Ok(Ctx::of(&state)?.homes())
}

#[tauri::command(async)]
pub fn kit_skills(
    state: State<'_, AppState>,
    worktree: Option<String>,
) -> Result<Vec<Skill>, CmdError> {
    Ctx::of(&state)?.skills(worktree)
}

#[tauri::command(async)]
pub fn kit_memory(
    state: State<'_, AppState>,
    worktree: Option<String>,
) -> Result<MemorySet, CmdError> {
    Ctx::of(&state)?.memory(worktree)
}

#[tauri::command(async)]
pub fn kit_read(
    state: State<'_, AppState>,
    path: String,
    worktree: Option<String>,
) -> Result<KitText, CmdError> {
    Ctx::of(&state)?.read(&path, worktree)
}

#[tauri::command(async)]
pub fn kit_write(
    state: State<'_, AppState>,
    path: String,
    text: String,
    stamp: Option<String>,
    worktree: Option<String>,
) -> Result<String, CmdError> {
    Ctx::of(&state)?.write(&path, &text, stamp, worktree)
}

#[tauri::command(async)]
pub fn kit_copy(
    state: State<'_, AppState>,
    from: String,
    to: String,
    worktree: Option<String>,
) -> Result<(), CmdError> {
    Ctx::of(&state)?.copy(&from, &to, worktree)
}

#[tauri::command(async)]
pub fn kit_skill_copy(
    state: State<'_, AppState>,
    dir: String,
    to_skills_dir: String,
    worktree: Option<String>,
) -> Result<String, CmdError> {
    Ctx::of(&state)?.skill_copy(&dir, &to_skills_dir, worktree)
}

#[tauri::command(async)]
pub fn kit_skill_new(
    state: State<'_, AppState>,
    skills_dir: String,
    name: String,
    description: String,
    worktree: Option<String>,
) -> Result<String, CmdError> {
    Ctx::of(&state)?.skill_new(&skills_dir, &name, &description, worktree)
}

#[tauri::command(async)]
pub fn kit_skill_remove(
    state: State<'_, AppState>,
    dir: String,
    worktree: Option<String>,
) -> Result<String, CmdError> {
    Ctx::of(&state)?.skill_remove(&dir, worktree)
}

#[tauri::command(async)]
pub fn kit_skill_restore(
    state: State<'_, AppState>,
    removed: String,
    to: String,
    worktree: Option<String>,
) -> Result<(), CmdError> {
    Ctx::of(&state)?.skill_restore(&removed, &to, worktree)
}

/// A refresh walks every session log of every home, so it runs on a blocking
/// thread and not on the async runtime's workers.
#[tauri::command]
pub async fn kit_usage(
    state: State<'_, AppState>,
    since_day: String,
    until_day: String,
    refresh: bool,
    utc_offset_minutes: i32,
) -> Result<UsageSummary, CmdError> {
    let ctx = Ctx::of(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        ctx.usage(&since_day, &until_day, refresh, utc_offset_minutes)
    })
    .await
    .map_err(|e| CmdError {
        code: "io",
        detail: Some(e.to_string()),
    })?
}

/// The Stats page's report. Which agents are read follows `usage.scan`; the
/// refresh runs on a blocking thread like `kit_usage`.
#[tauri::command(async)]
pub async fn kit_usage_report(
    app: AppHandle,
    state: State<'_, AppState>,
    args: UsageReportArgs,
) -> Result<UsageReport, CmdError> {
    let ctx = Ctx::of(&state)?;
    let scan = settings_store::read(&app).usage.scan;
    tauri::async_runtime::spawn_blocking(move || ctx.usage_report(&args, scan).map(|(r, _)| r))
        .await
        .map_err(|e| CmdError {
            code: "io",
            detail: Some(e.to_string()),
        })?
}

#[tauri::command(async)]
pub fn kit_paths_exist(
    state: State<'_, AppState>,
    root: String,
    paths: Vec<String>,
) -> Result<Vec<bool>, CmdError> {
    Ctx::of(&state)?.paths_exist(&root, &paths)
}

#[tauri::command(async)]
pub fn kit_prompt_history(
    state: State<'_, AppState>,
    limit: usize,
) -> Result<Vec<PromptEntry>, CmdError> {
    Ok(Ctx::of(&state)?.prompt_history(limit))
}

/// The composer's unsent text of the tab `tab_id`; `None` when it has none.
#[tauri::command(async)]
pub fn composer_draft_get(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Option<String>, CmdError> {
    Ok(Ctx::of(&state)?.draft_get(&tab_id))
}

/// Keeps the composer's text of `tab_id` (64 KB at most, `too_large` past
/// it); an empty text clears it.
#[tauri::command(async)]
pub fn composer_draft_put(
    state: State<'_, AppState>,
    tab_id: String,
    text: String,
) -> Result<(), CmdError> {
    Ctx::of(&state)?.draft_put(&tab_id, &text, now_ms())
}

/// Forgets the draft of `tab_id`; true when there was one.
#[tauri::command(async)]
pub fn composer_draft_clear(state: State<'_, AppState>, tab_id: String) -> Result<bool, CmdError> {
    Ctx::of(&state)?.draft_clear(&tab_id)
}

/// Every prompt template, by name.
#[tauri::command(async)]
pub fn prompt_templates_list(state: State<'_, AppState>) -> Result<Vec<PromptTemplate>, CmdError> {
    Ok(Ctx::of(&state)?.templates_list())
}

/// Adds a template or replaces the one with its id; the list after. A new
/// one past 200 is `too_many`.
#[tauri::command(async)]
pub fn prompt_templates_put(
    state: State<'_, AppState>,
    template: PromptTemplate,
) -> Result<Vec<PromptTemplate>, CmdError> {
    Ctx::of(&state)?.templates_put(template)
}

/// Removes the template `id`; the list after.
#[tauri::command(async)]
pub fn prompt_templates_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<PromptTemplate>, CmdError> {
    Ctx::of(&state)?.templates_delete(&id)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use xdev_kit::{Agent, KitError};
    use xdev_workspace::{Registry, RepoEntry, WorktreeMeta};

    use super::*;
    use crate::commands::CmdError;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        ctx: Ctx,
        user_home: PathBuf,
        repo: PathBuf,
        linked: PathBuf,
    }

    /// A user home with a Claude and a Codex home, and a registry that knows
    /// one repo and one linked worktree. Nothing outside the temp dir.
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let user_home = root.join("user");
        let data = root.join("data");
        let repo = root.join("repo");
        let linked = root.join("repo-oak");
        for d in [
            user_home.join(".claude"),
            user_home.join(".codex"),
            data.clone(),
            repo.clone(),
            linked.clone(),
        ] {
            fs::create_dir_all(d).unwrap();
        }
        let reg = Registry {
            repos: vec![RepoEntry {
                id: "r1".into(),
                short_name: "repo".into(),
                path: repo.clone(),
                base_ref: "main".into(),
                worktree_root: root.clone(),
                ..RepoEntry::default()
            }],
            worktrees: vec![WorktreeMeta {
                repo_id: "r1".into(),
                path: linked.clone(),
                start: "0".repeat(40),
                pinned: false,
                created_ms: 0,
                made_here: true,
                ..WorktreeMeta::default()
            }],
            ..Registry::default()
        };
        reg.save(&data).unwrap();
        let ctx = Ctx {
            data,
            user_home: user_home.clone(),
            env: no_env,
        };
        Fixture {
            _dir: dir,
            ctx,
            user_home,
            repo,
            linked,
        }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn changed_error_maps_to_code() {
        let e = CmdError::from(KitError::Changed);
        assert_eq!(e.code, "changed");
    }

    #[test]
    fn outside_and_other_errors_map_to_codes() {
        let e = CmdError::from(KitError::Outside(PathBuf::from("/x")));
        assert_eq!(e.code, "outside");
        assert!(e.detail.is_some());
        let io = CmdError::from(KitError::Io("disk".into()));
        assert_eq!(io.code, "io");
        assert!(io.detail.unwrap().contains("disk"));
    }

    #[test]
    fn parse_errors_map_to_fitting_codes() {
        let code = |m: &str| CmdError::from(KitError::Parse(m.into()));
        assert_eq!(code("bad skill name").code, "bad_name");
        assert_eq!(code("not UTF-8 text").code, "not_utf8");
        for other in [
            "the description is one line",
            "not a skill folder",
            "expected value at line 1",
        ] {
            let e = code(other);
            assert_eq!(e.code, "kit_bad_input");
            assert!(e.detail.unwrap().contains(other));
        }

        // The same through the commands, with the messages xdev-kit really gives.
        let f = fixture();
        let skills = f.user_home.join(".claude").join("skills");
        fs::create_dir_all(skills.join("plain")).unwrap();
        let bad_name = f.ctx.skill_new(&s(&skills), "Bad Name", "x", None);
        assert_eq!(bad_name.unwrap_err().code, "bad_name");
        let two_lines = f.ctx.skill_new(&s(&skills), "ok", "a\nb", None);
        assert_eq!(two_lines.unwrap_err().code, "kit_bad_input");
        let not_skill = f.ctx.skill_remove(&s(&skills.join("plain")), None);
        assert_eq!(not_skill.unwrap_err().code, "kit_bad_input");
        let binary = f.user_home.join(".claude").join("blob.md");
        fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(f.ctx.read(&s(&binary), None).unwrap_err().code, "not_utf8");
    }

    #[test]
    fn composer_drafts_put_get_clear_through_the_data_dir() {
        let f = fixture();
        assert_eq!(f.ctx.draft_get("tab-1"), None);
        f.ctx.draft_put("tab-1", "fix the bug", 1).unwrap();
        assert_eq!(f.ctx.draft_get("tab-1").as_deref(), Some("fix the bug"));
        assert_eq!(f.ctx.draft_get("tab-2"), None);
        assert!(f.ctx.draft_clear("tab-1").unwrap());
        assert!(!f.ctx.draft_clear("tab-1").unwrap());
        assert_eq!(f.ctx.draft_get("tab-1"), None);
    }

    #[test]
    fn a_draft_over_64_kb_is_too_large() {
        let f = fixture();
        let big = "a".repeat(xdev_kit::DRAFT_MAX_BYTES + 1);
        assert_eq!(f.ctx.draft_put("t", &big, 1).unwrap_err().code, "too_large");
        assert_eq!(
            f.ctx.draft_put("", "x", 1).unwrap_err().code,
            "kit_bad_input"
        );
    }

    #[test]
    fn prompt_templates_put_list_delete_and_the_count_bound() {
        let f = fixture();
        assert!(f.ctx.templates_list().is_empty());
        let one = |id: &str| PromptTemplate {
            id: id.to_owned(),
            name: format!("n {id}"),
            body: "b".to_owned(),
            mode: xdev_kit::TemplateMode::Insert,
        };
        let after = f.ctx.templates_put(one("a")).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(f.ctx.templates_list(), after);
        for i in 1..xdev_kit::TEMPLATES_MAX {
            f.ctx.templates_put(one(&format!("t{i}"))).unwrap();
        }
        assert_eq!(
            f.ctx.templates_put(one("over")).unwrap_err().code,
            "too_many"
        );
        let left = f.ctx.templates_delete("a").unwrap();
        assert_eq!(left.len(), xdev_kit::TEMPLATES_MAX - 1);
        assert!(left.iter().all(|t| t.id != "a"));
    }

    #[test]
    fn user_home_comes_from_userprofile_then_home() {
        let both = |k: &str| match k {
            "USERPROFILE" => Some("/a".to_owned()),
            "HOME" => Some("/b".to_owned()),
            _ => None,
        };
        assert_eq!(user_home_from(&both), Some(PathBuf::from("/a")));
        let only_home = |k: &str| (k == "HOME").then(|| "/b".to_owned());
        assert_eq!(user_home_from(&only_home), Some(PathBuf::from("/b")));
        let empty = |_: &str| Some(String::new());
        assert_eq!(user_home_from(&empty), None);
        assert_eq!(user_home_from(&no_env), None);
    }

    #[test]
    fn worktree_must_be_a_known_repo_or_worktree() {
        let f = fixture();
        assert_eq!(f.ctx.worktree(None).unwrap(), None);
        assert_eq!(
            f.ctx.worktree(Some(s(&f.repo))).unwrap(),
            Some(f.repo.clone())
        );
        assert_eq!(
            f.ctx.worktree(Some(s(&f.linked))).unwrap(),
            Some(f.linked.clone())
        );
        let stranger = f.user_home.join("elsewhere");
        let err = f.ctx.worktree(Some(s(&stranger))).unwrap_err();
        assert_eq!(err.code, "outside");
    }

    #[test]
    fn worktree_match_ignores_slash_style_and_trailing_slash() {
        let f = fixture();
        let spelled = format!("{}/", s(&f.linked).replace('\\', "/"));
        assert!(f.ctx.worktree(Some(spelled)).unwrap().is_some());
    }

    #[test]
    fn homes_list_both_agent_homes() {
        let f = fixture();
        let homes = f.ctx.homes();
        let ids: Vec<_> = homes.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["own-claude", "own-codex"]);
    }

    #[test]
    fn write_read_roundtrip_and_stale_stamp_is_changed() {
        let f = fixture();
        let file = f.user_home.join(".claude").join("CLAUDE.md");
        let stamp = f.ctx.write(&s(&file), "one", None, None).unwrap();
        let read = f.ctx.read(&s(&file), None).unwrap();
        assert_eq!(read.text, "one");
        assert_eq!(read.stamp, stamp);
        let next = f
            .ctx
            .write(&s(&file), "two", Some(stamp.clone()), None)
            .unwrap();
        assert_ne!(next, stamp);
        // The old stamp no longer matches.
        let err = f
            .ctx
            .write(&s(&file), "three", Some(stamp), None)
            .unwrap_err();
        assert_eq!(err.code, "changed");
        assert_eq!(fs::read_to_string(&file).unwrap(), "two");
        // A new file must not exist yet.
        let err = f.ctx.write(&s(&file), "x", None, None).unwrap_err();
        assert_eq!(err.code, "changed");
    }

    #[test]
    fn write_outside_every_root_is_outside() {
        let f = fixture();
        let stray = f.user_home.join("stray.md");
        let err = f.ctx.write(&s(&stray), "x", None, None).unwrap_err();
        assert_eq!(err.code, "outside");
        assert!(!stray.exists());
    }

    #[test]
    fn a_worktree_arg_widens_the_roots_only_when_known() {
        let f = fixture();
        let file = f.linked.join("AGENTS.md");
        let err = f.ctx.write(&s(&file), "x", None, None).unwrap_err();
        assert_eq!(err.code, "outside");
        f.ctx
            .write(&s(&file), "x", None, Some(s(&f.linked)))
            .unwrap();
        assert!(file.exists());
        // A worktree the registry does not know is refused before any write.
        let other = f.user_home.join("other");
        fs::create_dir_all(&other).unwrap();
        let err = f
            .ctx
            .write(&s(&other.join("a.md")), "x", None, Some(s(&other)))
            .unwrap_err();
        assert_eq!(err.code, "outside");
    }

    #[test]
    fn skill_new_copy_remove_restore() {
        let f = fixture();
        let claude_skills = f.user_home.join(".claude").join("skills");
        let codex_skills = f.user_home.join(".codex").join("skills");
        let made = f
            .ctx
            .skill_new(&s(&claude_skills), "demo", "One line", None)
            .unwrap();
        assert!(Path::new(&made).ends_with("SKILL.md"));
        let dir = claude_skills.join("demo");
        let copied = f.ctx.skill_copy(&s(&dir), &s(&codex_skills), None).unwrap();
        assert!(Path::new(&copied).join("SKILL.md").is_file());
        let err = f
            .ctx
            .skill_copy(&s(&dir), &s(&codex_skills), None)
            .unwrap_err();
        assert_eq!(err.code, "changed");
        let removed = f.ctx.skill_remove(&s(&dir), None).unwrap();
        assert!(!dir.exists());
        assert!(Path::new(&removed).join("SKILL.md").is_file());
        f.ctx.skill_restore(&removed, &s(&dir), None).unwrap();
        assert!(dir.join("SKILL.md").is_file());
        let bad = f
            .ctx
            .skill_new(&s(&claude_skills), "../up", "d", None)
            .unwrap_err();
        assert_eq!(bad.code, "bad_name");
    }

    #[test]
    fn copy_file_between_homes() {
        let f = fixture();
        let from = f.user_home.join(".claude").join("CLAUDE.md");
        fs::write(&from, "rules").unwrap();
        let to = f.user_home.join(".codex").join("AGENTS.md");
        f.ctx.copy(&s(&from), &s(&to), None).unwrap();
        assert_eq!(fs::read_to_string(&to).unwrap(), "rules");
        assert_eq!(
            f.ctx.copy(&s(&from), &s(&to), None).unwrap_err().code,
            "changed"
        );
    }

    #[test]
    fn skills_and_memory_scan_with_a_known_worktree() {
        let f = fixture();
        let dir = f.linked.join(".claude").join("skills").join("local");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: local\ndescription: d\n---\n",
        )
        .unwrap();
        fs::write(f.linked.join("CLAUDE.md"), "hi\n").unwrap();
        let skills = f.ctx.skills(Some(s(&f.linked))).unwrap();
        assert!(skills.iter().any(|k| k.name == "local"));
        assert!(
            f.ctx
                .skills(None)
                .unwrap()
                .iter()
                .all(|k| k.name != "local")
        );
        let memory = f.ctx.memory(Some(s(&f.linked))).unwrap();
        assert!(memory.files.iter().any(|m| m.path.ends_with("CLAUDE.md")));
        assert_eq!(
            f.ctx.skills(Some(s(&f.user_home))).unwrap_err().code,
            "outside"
        );
    }

    #[test]
    fn paths_exist_checks_relative_paths_under_a_known_root() {
        let f = fixture();
        fs::create_dir_all(f.repo.join("src")).unwrap();
        fs::write(f.repo.join("src").join("a.rs"), "").unwrap();
        let paths = [
            "src/a.rs",
            "src",
            "nope.rs",
            "../repo/src/a.rs",
            "/etc/hosts",
            "",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            f.ctx.paths_exist(&s(&f.repo), &paths).unwrap(),
            [true, true, false, false, false, false]
        );
        let err = f.ctx.paths_exist(&s(&f.user_home), &paths).unwrap_err();
        assert_eq!(err.code, "outside");
    }

    #[test]
    fn paths_exist_accepts_an_agent_home_as_root() {
        let f = fixture();
        fs::write(f.user_home.join(".claude").join("CLAUDE.md"), "").unwrap();
        let got = f
            .ctx
            .paths_exist(&s(&f.user_home.join(".claude")), &["CLAUDE.md".to_owned()])
            .unwrap();
        assert_eq!(got, [true]);
    }

    fn lines(dir: &Path, name: &str, lines: &[&str]) {
        fs::write(dir.join(name), lines.join("\n") + "\n").unwrap();
    }

    #[test]
    fn prompt_history_is_newest_first_across_agents() {
        let f = fixture();
        lines(
            &f.user_home.join(".claude"),
            "history.jsonl",
            &[
                r#"{"display":"old claude","timestamp":1000}"#,
                "not json",
                r#"{"display":"new claude","timestamp":5000}"#,
                r#"{"display":"   ","timestamp":6000}"#,
                r#"{"project":"x","timestamp":7000}"#,
            ],
        );
        lines(
            &f.user_home.join(".codex"),
            "history.jsonl",
            &[r#"{"session_id":"s","ts":3,"text":"mid codex"}"#],
        );
        let got = f.ctx.prompt_history(10);
        let texts: Vec<_> = got.iter().map(|p| p.text.as_str()).collect();
        assert_eq!(texts, ["new claude", "mid codex", "old claude"]);
        assert_eq!(got[0].agent, Agent::Claude);
        assert_eq!(got[0].at, 5000);
        assert_eq!(got[1].agent, Agent::Codex);
        // Codex stamps seconds.
        assert_eq!(got[1].at, 3000);
        assert_eq!(f.ctx.prompt_history(2).len(), 2);
        assert!(f.ctx.prompt_history(0).is_empty());
    }

    #[test]
    fn prompt_history_without_files_is_empty() {
        assert!(fixture().ctx.prompt_history(10).is_empty());
    }

    #[test]
    fn prompt_history_reads_only_the_tail_of_a_big_file() {
        let f = fixture();
        let path = f.user_home.join(".claude").join("history.jsonl");
        let filler = format!(r#"{{"display":"{}","timestamp":1}}"#, "x".repeat(1000));
        // The first line is far outside the tail and has the newest time of all, so it
        // comes first in the answer if, and only if, the whole file was read.
        let mut text = String::from(r#"{"display":"head","timestamp":9000000000000}"#);
        text.push('\n');
        while text.len() < HISTORY_TAIL_BYTES as usize + 5000 {
            text.push_str(&filler);
            text.push('\n');
        }
        text.push_str(r#"{"display":"last","timestamp":9}"#);
        text.push('\n');
        fs::write(&path, text).unwrap();
        let got = f.ctx.prompt_history(HISTORY_MAX);
        assert_eq!(got[0].text, "last");
        assert!(got.iter().all(|p| p.text != "head"));
        // The cut line at the start of the tail is dropped, not half-parsed.
        assert!(got.iter().all(|p| p.text == "last" || p.text.len() == 1000));
        assert!(got.len() > 1000 - 1);
    }

    #[test]
    fn usage_saves_the_index_only_when_refreshed() {
        let f = fixture();
        let index = f.ctx.data.join("kit").join("usage.json");
        let summary = f.ctx.usage("2026-11-01", "2026-11-07", false, 420).unwrap();
        assert!(summary.days.iter().all(|(_, t)| t.sum() == 0));
        assert!(!index.exists());
        f.ctx.usage("2026-11-01", "2026-11-07", true, 420).unwrap();
        assert!(index.is_file());
        let saved = xdev_kit::UsageIndex::load(&f.ctx.data);
        assert_eq!(saved.utc_offset_minutes, 420);
    }

    #[test]
    fn usage_reads_session_logs_of_the_homes() {
        let f = fixture();
        let logs = f
            .user_home
            .join(".claude")
            .join("projects")
            .join("-work-demo");
        fs::create_dir_all(&logs).unwrap();
        fs::write(
            logs.join("s1.jsonl"),
            concat!(
                r#"{"type":"assistant","cwd":"/work/demo","timestamp":"2026-11-03T05:00:00.000Z","message":{"id":"m1","model":"model-a","usage":{"input_tokens":10,"output_tokens":5}}}"#,
                "\n"
            ),
        )
        .unwrap();
        let summary = f.ctx.usage("2026-11-03", "2026-11-03", true, 0).unwrap();
        let total: u64 = summary.days.iter().map(|(_, t)| t.sum()).sum();
        assert_eq!(total, 15);
    }

    fn write_claude_log(f: &Fixture, name: &str, cwd: &Path) {
        let logs = f.user_home.join(".claude").join("projects").join("-p");
        fs::create_dir_all(&logs).unwrap();
        let cwd = cwd.to_string_lossy().replace('\\', "\\\\");
        fs::write(
            logs.join(format!("{name}.jsonl")),
            format!(
                r#"{{"type":"assistant","cwd":"{cwd}","timestamp":"2026-11-03T05:00:00.000Z","message":{{"id":"{name}","model":"model-a","usage":{{"input_tokens":10,"output_tokens":5}}}}}}"#
            ) + "\n",
        )
        .unwrap();
    }

    fn write_codex_log(f: &Fixture, name: &str, cwd: &Path) {
        let dir = f
            .user_home
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("11")
            .join("03");
        fs::create_dir_all(&dir).unwrap();
        let cwd = cwd.to_string_lossy().replace('\\', "\\\\");
        fs::write(
            dir.join(format!("rollout-2026-11-03T05-00-00-{name}.jsonl")),
            format!(
                r#"{{"timestamp":"2026-11-03T05:00:00.000Z","type":"session_meta","payload":{{"id":"{name}","cwd":"{cwd}"}}}}"#
            ) + "\n"
                + r#"{"timestamp":"2026-11-03T05:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":20,"output_tokens":4},"last_token_usage":{"input_tokens":20,"output_tokens":4}}}}"#
                + "\n",
        )
        .unwrap();
    }

    fn report_args(agent: Option<Agent>, scope: UsageScope, refresh: bool) -> UsageReportArgs {
        UsageReportArgs {
            since_day: None,
            until_day: "2026-11-30".into(),
            agent,
            scope,
            refresh,
            utc_offset_minutes: 0,
        }
    }

    const BOTH_ON: ProviderSwitches = ProviderSwitches {
        claude: true,
        codex: true,
    };

    #[test]
    fn a_report_with_both_scans_off_opens_no_log() {
        let f = fixture();
        write_claude_log(&f, "s1", &f.repo);
        let off = ProviderSwitches {
            claude: false,
            codex: false,
        };
        let (report, stats) = f
            .ctx
            .usage_report(&report_args(None, UsageScope::All, true), off)
            .unwrap();
        assert_eq!(stats.files_read, 0);
        assert_eq!(report.sessions, 0);
        assert!(report.by_agent.is_empty());
    }

    #[test]
    fn a_report_counts_only_the_agents_whose_scan_is_on() {
        let f = fixture();
        write_claude_log(&f, "s1", &f.repo);
        write_codex_log(&f, "c1", &f.repo);
        let all = report_args(None, UsageScope::All, true);
        let (both, _) = f.ctx.usage_report(&all, BOTH_ON).unwrap();
        assert_eq!(both.sessions, 2);
        // The Codex session is in the index now; with Codex off it is not
        // counted, and the refresh does not read its logs.
        let claude_only = ProviderSwitches {
            claude: true,
            codex: false,
        };
        let (report, stats) = f.ctx.usage_report(&all, claude_only).unwrap();
        assert_eq!(report.sessions, 1);
        assert_eq!(report.by_agent.len(), 1);
        assert_eq!(report.by_agent[0].0, Agent::Claude);
        assert_eq!(stats.files_read, 0, "nothing changed since the last read");
    }

    #[test]
    fn the_xdev_scope_keeps_only_registry_folders() {
        let f = fixture();
        write_claude_log(&f, "mine", &f.linked);
        write_claude_log(&f, "elsewhere", Path::new("/not/in/the/registry"));
        let (all, _) = f
            .ctx
            .usage_report(&report_args(None, UsageScope::All, true), BOTH_ON)
            .unwrap();
        assert_eq!(all.sessions, 2);
        let (xdev, _) = f
            .ctx
            .usage_report(&report_args(None, UsageScope::Xdev, false), BOTH_ON)
            .unwrap();
        assert_eq!(xdev.sessions, 1);
        assert_eq!(xdev.summary.by_folder[0].0, f.linked.to_string_lossy());
    }

    #[test]
    fn a_report_without_refresh_does_not_save_the_index() {
        let f = fixture();
        write_claude_log(&f, "s1", &f.repo);
        let index = f.ctx.data.join("kit").join("usage.json");
        f.ctx
            .usage_report(&report_args(None, UsageScope::All, false), BOTH_ON)
            .unwrap();
        assert!(!index.exists());
        f.ctx
            .usage_report(&report_args(None, UsageScope::All, true), BOTH_ON)
            .unwrap();
        assert!(index.exists());
    }

    #[test]
    fn a_nonzero_offset_moves_a_log_line_to_the_next_day_key() {
        let f = fixture();
        let logs = f
            .user_home
            .join(".claude")
            .join("projects")
            .join("-work-demo");
        fs::create_dir_all(&logs).unwrap();
        // 20:30 UTC on the 3rd is 03:30 on the 4th at UTC+7.
        fs::write(
            logs.join("s1.jsonl"),
            concat!(
                r#"{"type":"assistant","cwd":"/work/demo","timestamp":"2026-11-03T20:30:00.000Z","message":{"id":"m1","model":"model-a","usage":{"input_tokens":10,"output_tokens":5}}}"#,
                "
"
            ),
        )
        .unwrap();
        let by_day = |s: &UsageSummary| -> Vec<(String, u64)> {
            s.days
                .iter()
                .map(|(d, t)| (d.clone(), t.sum()))
                .filter(|(_, n)| *n > 0)
                .collect()
        };
        let local = f.ctx.usage("2026-11-03", "2026-11-04", true, 420).unwrap();
        assert_eq!(by_day(&local), [("2026-11-04".to_owned(), 15)]);
        let utc = f.ctx.usage("2026-11-03", "2026-11-04", true, 0).unwrap();
        assert_eq!(by_day(&utc), [("2026-11-03".to_owned(), 15)]);
    }
}
