//! Shipping a worktree's work: where the branch stands against its remote
//! and its base, push, pull, sync, fetch, gated force push and amend.
//! Each command returns a fresh `ShipView` so the UI never guesses.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use xdev_git::{BaseRange, Repo, Upstream};
use xdev_policy::{Action, Verdict};
use xdev_workspace::{Registry, WorkspaceError, path_key};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::tasks::gate;
use crate::workspace::{bad_arg, inside, parent_within, start_of};

/// Commits listed in `ShipView::range`.
const RANGE_LIMIT: usize = 50;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ShipView {
    /// `None` when `HEAD` is detached.
    pub branch: Option<String>,
    /// The repo's base ref, as registered.
    pub base: String,
    /// Where the branch pushes; `None` when the repo has no usable remote.
    pub remote: Option<String>,
    pub upstream: Option<Upstream>,
    /// `HEAD` is already on the upstream.
    pub head_pushed: bool,
    /// `HEAD` is still the commit the worktree started from.
    pub at_start: bool,
    /// What the branch adds to its base; `None` for the primary checkout.
    pub range: Option<BaseRange>,
}

/// What the registry knows about a checkout.
struct Known {
    base_ref: String,
    /// `None` for the primary checkout.
    start: Option<String>,
}

fn locate(data: &Path, path: &Path) -> Result<Known, CmdError> {
    let key = path_key(path);
    let reg = Registry::load(data)?;
    if let Some(meta) = reg.worktrees.iter().find(|m| path_key(&m.path) == key)
        && let Some(repo) = reg.repos.iter().find(|r| r.id == meta.repo_id)
    {
        return Ok(Known {
            base_ref: repo.base_ref.clone(),
            start: Some(meta.start.clone()),
        });
    }
    match reg.repos.iter().find(|r| path_key(&r.path) == key) {
        Some(repo) => Ok(Known {
            base_ref: repo.base_ref.clone(),
            start: None,
        }),
        None => Err(WorkspaceError::WorktreeUnknown(path.to_owned()).into()),
    }
}

fn err(code: &'static str, detail: Option<String>) -> CmdError {
    CmdError { code, detail }
}

fn view(data: &Path, path: &Path) -> Result<ShipView, CmdError> {
    let known = locate(data, path)?;
    let repo = Repo::discover(path)?;
    let branch = repo.current_branch()?;
    let remote = branch.as_deref().and_then(|b| repo.remote_for(b).ok());
    let upstream = repo.upstream()?;
    let head_pushed = upstream.is_some() && repo.head_on_upstream()?;
    let at_start = match (&known.start, repo.head_id()?) {
        (Some(start), Some(head)) => *start == head,
        _ => false,
    };
    let range = match known.start {
        Some(_) => repo.branch_vs_base(&known.base_ref, RANGE_LIMIT).ok(),
        None => None,
    };
    Ok(ShipView {
        branch,
        base: known.base_ref,
        remote,
        upstream,
        head_pushed,
        at_start,
        range,
    })
}

fn push_with(data: &Path, path: &Path) -> Result<ShipView, CmdError> {
    locate(data, path)?;
    Repo::discover(path)?.push()?;
    view(data, path)
}

fn pull_with(data: &Path, path: &Path) -> Result<ShipView, CmdError> {
    locate(data, path)?;
    Repo::discover(path)?.pull()?;
    view(data, path)
}

fn fetch_with(data: &Path, path: &Path) -> Result<ShipView, CmdError> {
    locate(data, path)?;
    Repo::discover(path)?.fetch()?;
    view(data, path)
}

/// Fetches, then fast-forwards when behind or pushes when ahead. Split
/// histories are `pull_diverged` and nothing is pushed.
fn sync_with(data: &Path, path: &Path) -> Result<ShipView, CmdError> {
    locate(data, path)?;
    let repo = Repo::discover(path)?;
    repo.fetch()?;
    let up = repo.upstream()?.ok_or_else(|| err("no_upstream", None))?;
    match (up.ahead, up.behind) {
        (0, 0) => {}
        (_, 0) => repo.push()?,
        // Behind, or both: `pull` refuses a split history itself.
        _ => repo.pull()?,
    }
    view(data, path)
}

fn force_push_with(
    data: &Path,
    path: &Path,
    expected: &str,
    confirmed: bool,
) -> Result<ShipView, CmdError> {
    let known = locate(data, path)?;
    let repo = Repo::discover(path)?;
    let branch = repo
        .current_branch()?
        .ok_or_else(|| err("detached", None))?;
    let remote = repo.remote_for(&branch);
    // The base ref may carry its remote's name: `origin/main` -> `main`.
    let base = match &remote {
        Ok(r) => known
            .base_ref
            .strip_prefix(&format!("{r}/"))
            .unwrap_or(&known.base_ref),
        Err(_) => &known.base_ref,
    };
    if branch == base {
        return Err(err("force_base", Some(branch)));
    }
    let remote = remote?;
    let action = Action::ForcePush {
        worktree: path.to_owned(),
        remote,
        branch,
    };
    match gate(data)?.check_confirmed(&action, confirmed) {
        Verdict::Allow => {}
        Verdict::Ask { reason } => return Err(err("needs_approval", Some(reason))),
        Verdict::Deny { reason } => return Err(err("denied", Some(reason))),
    }
    repo.force_push(expected)?;
    view(data, path)
}

/// Rewrites `HEAD`. Local only, so no policy gate; pushing the result later
/// needs a force push, which has one.
fn amend_with(
    data: &Path,
    path: &Path,
    files: &[String],
    message: &str,
    confirmed: bool,
) -> Result<String, CmdError> {
    if message.trim().is_empty() {
        return Err(err("empty_message", None));
    }
    for file in files {
        let disk = inside(path, file).ok_or_else(|| bad_arg(file))?;
        if !parent_within(path, &disk)? {
            return Err(bad_arg(file));
        }
    }
    let start = start_of(data, path)?;
    let repo = Repo::discover(path)?;
    // Amending the start commit would rewrite the base's own history.
    if repo.head_id()?.as_deref() == Some(start.as_str()) {
        return Err(err("nothing_to_amend", None));
    }
    if !confirmed && repo.head_on_upstream()? {
        return Err(err("amend_pushed", None));
    }
    Ok(repo.amend(files, message)?)
}

#[tauri::command(async)]
pub fn worktree_ship(state: State<'_, AppState>, path: PathBuf) -> Result<ShipView, CmdError> {
    view(data_dir(&state)?, &path)
}

#[tauri::command(async)]
pub fn worktree_push(state: State<'_, AppState>, path: PathBuf) -> Result<ShipView, CmdError> {
    push_with(data_dir(&state)?, &path)
}

#[tauri::command(async)]
pub fn worktree_pull(state: State<'_, AppState>, path: PathBuf) -> Result<ShipView, CmdError> {
    pull_with(data_dir(&state)?, &path)
}

#[tauri::command(async)]
pub fn worktree_sync(state: State<'_, AppState>, path: PathBuf) -> Result<ShipView, CmdError> {
    sync_with(data_dir(&state)?, &path)
}

#[tauri::command(async)]
pub fn worktree_fetch(state: State<'_, AppState>, path: PathBuf) -> Result<ShipView, CmdError> {
    fetch_with(data_dir(&state)?, &path)
}

#[tauri::command(async)]
pub fn worktree_force_push(
    state: State<'_, AppState>,
    path: PathBuf,
    expected: String,
    confirmed: bool,
) -> Result<ShipView, CmdError> {
    force_push_with(data_dir(&state)?, &path, &expected, confirmed)
}

#[tauri::command(async)]
pub fn worktree_amend(
    state: State<'_, AppState>,
    path: PathBuf,
    files: Vec<String>,
    message: String,
    confirmed: bool,
) -> Result<String, CmdError> {
    amend_with(data_dir(&state)?, &path, &files, &message, confirmed)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::process::Command;

    use tempfile::TempDir;
    use xdev_workspace::{add_repo, create_worktree};

    use super::*;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    }

    struct Fixture {
        tmp: TempDir,
        main: PathBuf,
        origin: PathBuf,
        data: PathBuf,
        wt: PathBuf,
    }

    /// A repo with a local bare `origin` and one worktree.
    fn fixture() -> Fixture {
        let tmp = TempDir::with_prefix("ship cmd ").unwrap();
        let main = tmp.path().join("main");
        let origin = tmp.path().join("origin.git");
        let data = tmp.path().join("data");
        fs::create_dir(&main).unwrap();
        fs::create_dir(&origin).unwrap();
        git(&origin, &["init", "-q", "--bare"]);
        git(&main, &["init", "-q"]);
        for (key, value) in [
            ("user.name", "Test User"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&main, &["config", key, value]);
        }
        fs::write(main.join("a.txt"), "one").unwrap();
        git(&main, &["add", "-A"]);
        git(&main, &["commit", "-q", "-m", "one"]);
        git(&main, &["remote", "add", "origin", origin.to_str().unwrap()]);

        let mut reg = Registry::load(&data).unwrap();
        let id = add_repo(&mut reg, &main, 0).unwrap().id;
        let wt = create_worktree(&mut reg, &id, "feat", None, 1, 1).unwrap();
        reg.save(&data).unwrap();
        Fixture {
            tmp,
            main,
            origin,
            data,
            wt: PathBuf::from(wt.path),
        }
    }

    fn commit_file(dir: &Path, name: &str, body: &str) {
        fs::write(dir.join(name), body).unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", name]);
    }

    fn code<T: std::fmt::Debug>(r: Result<T, CmdError>) -> &'static str {
        r.unwrap_err().code
    }

    fn branch(fx: &Fixture) -> String {
        git(&fx.wt, &["rev-parse", "--abbrev-ref", "HEAD"])
    }

    #[test]
    fn ship_view_reports_range_and_no_upstream() {
        let fx = fixture();
        let v = view(&fx.data, &fx.wt).unwrap();
        assert!(v.at_start && !v.head_pushed);
        assert_eq!(v.remote.as_deref(), Some("origin"));
        assert_eq!(v.upstream, None);
        assert_eq!(v.range.as_ref().unwrap().commits.len(), 0);

        commit_file(&fx.wt, "b.txt", "two");
        let v = view(&fx.data, &fx.wt).unwrap();
        assert!(!v.at_start);
        let range = v.range.unwrap();
        assert_eq!(range.commits.len(), 1);
        assert_eq!(range.added, 1);

        // The primary checkout has no start and no range.
        let v = view(&fx.data, &fx.main).unwrap();
        assert_eq!((v.range, v.at_start), (None, false));
    }

    #[test]
    fn push_then_ship_shows_upstream() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        let v = push_with(&fx.data, &fx.wt).unwrap();
        let up = v.upstream.unwrap();
        assert_eq!((up.ahead, up.behind), (0, 0));
        assert_eq!(up.branch, branch(&fx));
        assert!(v.head_pushed);
        assert_eq!(
            git(&fx.origin, &["rev-parse", &up.branch]),
            git(&fx.wt, &["rev-parse", "HEAD"])
        );
    }

    #[test]
    fn sync_pulls_then_pushes() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        push_with(&fx.data, &fx.wt).unwrap();
        let name = branch(&fx);

        let other = fx.tmp.path().join("other");
        git(
            fx.tmp.path(),
            &["clone", "-q", fx.origin.to_str().unwrap(), "other"],
        );
        git(&other, &["checkout", "-q", &name]);
        for (key, value) in [("user.name", "O"), ("user.email", "o@example.com")] {
            git(&other, &["config", key, value]);
        }
        commit_file(&other, "c.txt", "three");
        git(&other, &["push", "-q", "origin", &name]);

        let v = sync_with(&fx.data, &fx.wt).unwrap();
        assert!(fx.wt.join("c.txt").exists());
        assert_eq!(v.upstream.unwrap().behind, 0);

        commit_file(&fx.wt, "d.txt", "four");
        let v = sync_with(&fx.data, &fx.wt).unwrap();
        assert_eq!(v.upstream.unwrap().ahead, 0);
        assert_eq!(
            git(&fx.origin, &["rev-parse", &name]),
            git(&fx.wt, &["rev-parse", "HEAD"])
        );

        // Both sides move: nothing is pushed.
        git(&other, &["pull", "-q", "--ff-only", "origin", &name]);
        commit_file(&other, "e.txt", "five");
        git(&other, &["push", "-q", "origin", &name]);
        commit_file(&fx.wt, "f.txt", "six");
        let remote_before = git(&fx.origin, &["rev-parse", &name]);
        assert_eq!(code(sync_with(&fx.data, &fx.wt)), "pull_diverged");
        assert_eq!(git(&fx.origin, &["rev-parse", &name]), remote_before);
    }

    #[test]
    fn force_push_needs_confirmation() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        let v = push_with(&fx.data, &fx.wt).unwrap();
        let expected = v.upstream.unwrap().id.unwrap();
        git(&fx.wt, &["commit", "-q", "--amend", "-m", "reworded"]);
        let name = branch(&fx);

        assert_eq!(
            code(force_push_with(&fx.data, &fx.wt, &expected, false)),
            "needs_approval"
        );
        assert_eq!(git(&fx.origin, &["rev-parse", &name]), expected);

        let v = force_push_with(&fx.data, &fx.wt, &expected, true).unwrap();
        assert!(v.head_pushed);
        assert_eq!(
            git(&fx.origin, &["rev-parse", &name]),
            git(&fx.wt, &["rev-parse", "HEAD"])
        );
    }

    #[test]
    fn force_push_refuses_base_branch() {
        let fx = fixture();
        // The primary checkout sits on the base branch.
        let head = git(&fx.main, &["rev-parse", "HEAD"]);
        assert_eq!(
            code(force_push_with(&fx.data, &fx.main, &head, true)),
            "force_base"
        );
    }

    #[test]
    fn amend_refuses_start_commit() {
        let fx = fixture();
        assert_eq!(
            code(amend_with(&fx.data, &fx.wt, &[], "msg", true)),
            "nothing_to_amend"
        );
        assert_eq!(
            code(amend_with(&fx.data, &fx.wt, &[], "  ", true)),
            "empty_message"
        );
    }

    #[test]
    fn amend_pushed_needs_confirmation() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        push_with(&fx.data, &fx.wt).unwrap();
        let head = git(&fx.wt, &["rev-parse", "HEAD"]);
        assert_eq!(
            code(amend_with(&fx.data, &fx.wt, &[], "again", false)),
            "amend_pushed"
        );
        assert_eq!(git(&fx.wt, &["rev-parse", "HEAD"]), head);
    }

    #[test]
    fn amend_confirmed_rewrites_pushed_head() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        push_with(&fx.data, &fx.wt).unwrap();
        let old = git(&fx.wt, &["rev-parse", "HEAD"]);
        fs::write(fx.wt.join("b.txt"), "three").unwrap();
        let new = amend_with(&fx.data, &fx.wt, &["b.txt".to_owned()], "again", true).unwrap();
        assert_ne!(new, old);
        assert_eq!(git(&fx.wt, &["rev-parse", "HEAD"]), new);
        assert_eq!(git(&fx.wt, &["log", "-1", "--format=%s"]), "again");
        assert_eq!(fs::read_to_string(fx.wt.join("b.txt")).unwrap(), "three");
    }

    #[test]
    fn commit_hook_failure_maps_to_hook_failed_code() {
        let fx = fixture();
        let hooks = fx.main.join(".git").join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        fs::write(
            hooks.join("pre-commit"),
            "#!/bin/sh\necho lint failed >&2\nexit 1\n",
        )
        .unwrap();
        fs::write(fx.wt.join("x.txt"), "x").unwrap();
        let e: CmdError = Repo::discover(&fx.wt)
            .unwrap()
            .commit(&["x.txt".to_owned()], "msg")
            .unwrap_err()
            .into();
        assert_eq!(e.code, "hook_failed");
        assert!(e.detail.unwrap().contains("lint failed"));
    }
}
