//! The agent kit's commands: the agent homes, their skills and memory files,
//! checked writes, the token usage index and the prompt history. Every path
//! the UI sends is checked by `xdev_kit::Roots`; a worktree the UI names must
//! also be one the workspace registry knows, or the call is `outside`.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::State;
use xdev_kit::{
    Agent, Home, KitError, MemorySet, Roots, Skill, UsageIndex, UsageQuery, UsageSummary,
};
use xdev_workspace::{Registry, path_key};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};

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

impl From<KitError> for CmdError {
    fn from(e: KitError) -> CmdError {
        let code = match e {
            KitError::Changed => "changed",
            KitError::Outside(_) => "outside",
            KitError::Io(_) => "io",
            KitError::Parse(ref m) => match m.as_str() {
                "bad skill name" => "bad_name",
                "not UTF-8 text" => "not_utf8",
                _ => "kit_bad_input",
            },
        };
        CmdError {
            code,
            detail: Some(e.to_string()),
        }
    }
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
        Ok(xdev_kit::scan_skills(&self.homes(), wt.as_deref()))
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
