//! Shipping a worktree's work: where the branch stands against its remote
//! and its base, push, pull, sync, fetch, gated force push and amend.
//! Each command returns a fresh `ShipView` so the UI never guesses.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use xdev_agent::{AgentError, Cancel, RunRequest, Runner};
use xdev_ai::Provider;
use xdev_git::{
    BaseRange, Check, GhExec, PrDraft, PrView, Repo, SystemGh, Upstream, pr_checks, pr_create,
    pr_open_web, pr_view,
};
use xdev_policy::{Action, Gate, Verdict};
use xdev_workspace::{Registry, WorkspaceError, path_key};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::tasks::{gate, provider_runner};
use crate::workspace::{bad_arg, inside, parent_within, start_of};

/// Commits listed in `ShipView::range`.
const RANGE_LIMIT: usize = 50;
/// What a draft prompt carries of the changes; the rest is cut.
const DRAFT_CAP: usize = 60_000;

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
    checked_files(path, files)?;
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

fn checked_files(path: &Path, files: &[String]) -> Result<(), CmdError> {
    for file in files {
        let disk = inside(path, file).ok_or_else(|| bad_arg(file))?;
        if !parent_within(path, &disk)? {
            return Err(bad_arg(file));
        }
    }
    Ok(())
}

fn pr_with(gh: &dyn GhExec, path: &Path) -> Result<Option<PrView>, CmdError> {
    Ok(pr_view(gh, path)?)
}

/// The base without its remote's name: `origin/main` -> `main`.
fn plain_base(repo: &Repo, base_ref: &str) -> String {
    let remote = repo
        .current_branch()
        .ok()
        .flatten()
        .and_then(|b| repo.remote_for(&b).ok());
    match remote {
        Some(r) => base_ref
            .strip_prefix(&format!("{r}/"))
            .unwrap_or(base_ref)
            .to_owned(),
        None => base_ref.to_owned(),
    }
}

fn create_pr_with(
    gh: &dyn GhExec,
    repo: &Repo,
    base_ref: &str,
    draft: PrDraft,
) -> Result<PrView, CmdError> {
    let branch = repo
        .current_branch()?
        .ok_or_else(|| err("detached", None))?;
    match repo.upstream()? {
        Some(up) if up.ahead == 0 => {}
        _ => return Err(err("not_pushed", None)),
    }
    let title = draft.title.trim();
    if title.is_empty() {
        return Err(err("empty_title", None));
    }
    let base = match draft.base.trim() {
        "" => plain_base(repo, base_ref),
        given => given.to_owned(),
    };
    if !repo.valid_branch_name(&base)? {
        return Err(err("bad_ref", Some(base)));
    }
    let draft = PrDraft {
        base,
        title: title.to_owned(),
        body: draft.body,
        draft: draft.draft,
    };
    Ok(pr_create(gh, &repo.root(), &branch, &draft)?)
}

/// `text` cut to `max` bytes on a char boundary, with a marker when cut.
fn cap(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[cut]\n", &text[..end])
}

/// Drops a surrounding code fence, with or without a language tag.
fn unfence(answer: &str) -> String {
    let text = answer.trim();
    let Some(rest) = text.strip_prefix("```") else {
        return text.to_owned();
    };
    let body = rest.split_once('\n').map_or("", |(_, b)| b).trim_end();
    body.strip_suffix("```").unwrap_or(body).trim().to_owned()
}

/// Asks the agent, with no tools, and returns its unfenced answer.
fn ask(runner: &dyn Runner, repo: &Repo, prompt: String) -> Result<String, CmdError> {
    let req = RunRequest {
        worktree: repo.root(),
        prompt,
        resume: None,
        tools: vec![],
        model: None,
        cancel: Cancel::new(),
    };
    let failed = |detail: &str| err("draft_failed", Some(detail.to_owned()));
    let outcome = runner.run(&req).map_err(|e| match &e {
        AgentError::Runner(code) => failed(code),
        other => failed(other.code()),
    })?;
    if outcome.is_error {
        return Err(failed("agent_error"));
    }
    let answer = unfence(&outcome.result);
    if answer.is_empty() {
        return Err(failed("empty"));
    }
    Ok(answer)
}

fn draft_commit_with(
    runner: &dyn Runner,
    repo: &Repo,
    files: &[String],
) -> Result<String, CmdError> {
    let mut changes = repo.diff_text(files)?;
    // Untracked files are not in `git diff`; show them whole.
    let untracked = repo.untracked()?;
    for file in files.iter().filter(|f| untracked.contains(f)) {
        let Ok(bytes) = fs::read(repo.root().join(file)) else {
            continue;
        };
        if bytes.contains(&0) {
            continue;
        }
        changes.push_str(&format!(
            "\nNew file {file}:\n{}\n",
            String::from_utf8_lossy(&bytes)
        ));
    }
    let prompt = format!(
        "Write a concise conventional commit message for the changes below. \
         The subject line is at most 72 characters; add a short body only if it helps. \
         Answer with the message only, no quotes and no commentary.\n\n{}",
        cap(&changes, DRAFT_CAP)
    );
    ask(runner, repo, prompt)
}

fn draft_pr_with(runner: &dyn Runner, repo: &Repo, base: &str) -> Result<PrDraft, CmdError> {
    // The plain name may exist only as a remote branch.
    let remote = repo
        .current_branch()?
        .and_then(|b| repo.remote_for(&b).ok());
    let mut candidates = vec![base.to_owned()];
    candidates.extend(remote.map(|r| format!("{r}/{base}")));
    let mut rev = None;
    for c in candidates {
        if repo.resolve_ref(&c)?.is_some() {
            rev = Some(c);
            break;
        }
    }
    let rev = rev.ok_or_else(|| err("bad_ref", Some(base.to_owned())))?;
    let data = format!(
        "Commits:\n{}\nFiles:\n{}\nDiff:\n{}",
        repo.range_subjects(&rev)?,
        repo.range_stat(&rev)?,
        repo.range_diff(&rev)?
    );
    let prompt = format!(
        "Write a pull request title and description for merging the current branch into {base}. \
         Put the title on the first line, then a blank line, then the description in Markdown. \
         Answer with that only, no commentary.\n\n{}",
        cap(&data, DRAFT_CAP)
    );
    let answer = ask(runner, repo, prompt)?;
    let mut lines = answer.lines().skip_while(|l| l.trim().is_empty());
    let first = lines.next().unwrap_or_default();
    let title = first.trim_start_matches('#').trim();
    let title = title.strip_prefix("Title:").unwrap_or(title).trim();
    if title.is_empty() {
        return Err(err("draft_failed", Some("empty".to_owned())));
    }
    let body = lines.collect::<Vec<_>>().join("\n").trim().to_owned();
    Ok(PrDraft {
        base: base.to_owned(),
        title: title.to_owned(),
        body,
        draft: false,
    })
}

/// A draft run goes through the same gate as a task's.
fn draft_runner(data: &Path, path: &Path) -> Result<Box<dyn Runner>, CmdError> {
    let action = Action::SpawnAgent {
        provider: "claude".to_owned(),
        account: None,
        worktree: path.to_owned(),
        tools: vec![],
    };
    match gate(data)?.check(&action) {
        Verdict::Allow => {}
        Verdict::Ask { reason } => return Err(err("needs_approval", Some(reason))),
        Verdict::Deny { reason } => return Err(err("denied", Some(reason))),
    }
    Ok(provider_runner(Provider::Claude, None))
}

#[tauri::command(async)]
pub fn worktree_pr(state: State<'_, AppState>, path: PathBuf) -> Result<Option<PrView>, CmdError> {
    locate(data_dir(&state)?, &path)?;
    pr_with(&SystemGh, &path)
}

#[tauri::command(async)]
pub fn worktree_pr_create(
    state: State<'_, AppState>,
    path: PathBuf,
    draft: PrDraft,
) -> Result<PrView, CmdError> {
    let known = locate(data_dir(&state)?, &path)?;
    create_pr_with(&SystemGh, &Repo::discover(&path)?, &known.base_ref, draft)
}

#[tauri::command(async)]
pub fn worktree_pr_checks(
    state: State<'_, AppState>,
    path: PathBuf,
    number: u64,
) -> Result<Vec<Check>, CmdError> {
    locate(data_dir(&state)?, &path)?;
    Ok(pr_checks(&SystemGh, &path, number)?)
}

#[tauri::command(async)]
pub fn worktree_pr_open(
    state: State<'_, AppState>,
    path: PathBuf,
    checks: bool,
) -> Result<(), CmdError> {
    locate(data_dir(&state)?, &path)?;
    Ok(pr_open_web(&SystemGh, &path, checks)?)
}

#[tauri::command(async)]
pub fn worktree_draft_commit(
    state: State<'_, AppState>,
    path: PathBuf,
    files: Vec<String>,
) -> Result<String, CmdError> {
    let data = data_dir(&state)?;
    locate(data, &path)?;
    checked_files(&path, &files)?;
    let runner = draft_runner(data, &path)?;
    draft_commit_with(runner.as_ref(), &Repo::discover(&path)?, &files)
}

#[tauri::command(async)]
pub fn worktree_draft_pr(state: State<'_, AppState>, path: PathBuf) -> Result<PrDraft, CmdError> {
    let data = data_dir(&state)?;
    let known = locate(data, &path)?;
    let repo = Repo::discover(&path)?;
    let runner = draft_runner(data, &path)?;
    draft_pr_with(runner.as_ref(), &repo, &plain_base(&repo, &known.base_ref))
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
        git(
            &main,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );

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

    use std::cell::RefCell;
    use xdev_agent::RunOutcome;
    use xdev_git::{GhOutput, GitError};

    struct FakeGh {
        calls: RefCell<Vec<Vec<String>>>,
        script: RefCell<Vec<GhOutput>>,
    }

    impl FakeGh {
        fn new(mut script: Vec<GhOutput>) -> FakeGh {
            script.reverse();
            FakeGh {
                calls: RefCell::default(),
                script: RefCell::new(script),
            }
        }
    }

    impl GhExec for FakeGh {
        fn run(&self, _: &Path, args: &[&str], _: Option<&str>) -> Result<GhOutput, GitError> {
            self.calls
                .borrow_mut()
                .push(args.iter().map(|a| a.to_string()).collect());
            Ok(self.script.borrow_mut().pop().expect("scripted gh call"))
        }
    }

    fn gh_out(status: i32, stdout: &str, stderr: &str) -> GhOutput {
        GhOutput {
            status: Some(status),
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    fn draft(title: &str) -> PrDraft {
        PrDraft {
            base: "main".into(),
            title: title.into(),
            body: "body".into(),
            draft: false,
        }
    }

    struct FakeRunner {
        reqs: RefCell<Vec<RunRequest>>,
        answer: Result<String, String>,
    }

    impl FakeRunner {
        fn new(answer: Result<&str, &str>) -> FakeRunner {
            FakeRunner {
                reqs: RefCell::default(),
                answer: answer.map(str::to_owned).map_err(str::to_owned),
            }
        }
    }

    impl Runner for FakeRunner {
        fn run(&self, req: &RunRequest) -> Result<RunOutcome, AgentError> {
            self.reqs.borrow_mut().push(req.clone());
            match &self.answer {
                Ok(text) => Ok(RunOutcome {
                    session_id: None,
                    cost_usd: None,
                    is_error: false,
                    result: text.clone(),
                    context: None,
                }),
                Err(code) => Err(AgentError::Runner(code.clone())),
            }
        }
    }

    fn repo_of(fx: &Fixture) -> Repo {
        Repo::discover(&fx.wt).unwrap()
    }

    #[test]
    fn pr_none_without_pr() {
        let gh = FakeGh::new(vec![gh_out(
            1,
            "",
            "no pull requests found for branch \"feat\"",
        )]);
        assert_eq!(pr_with(&gh, Path::new(".")).unwrap(), None);
    }

    #[test]
    fn create_pr_refuses_unpushed() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        let gh = FakeGh::new(vec![]);
        let repo = repo_of(&fx);
        // No upstream.
        assert_eq!(
            code(create_pr_with(&gh, &repo, "origin/main", draft("T"))),
            "not_pushed"
        );
        // Ahead of the upstream.
        push_with(&fx.data, &fx.wt).unwrap();
        commit_file(&fx.wt, "c.txt", "three");
        assert_eq!(
            code(create_pr_with(&gh, &repo, "origin/main", draft("T"))),
            "not_pushed"
        );
        assert!(gh.calls.borrow().is_empty());
    }

    #[test]
    fn create_pr_refuses_empty_title() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        push_with(&fx.data, &fx.wt).unwrap();
        let gh = FakeGh::new(vec![]);
        assert_eq!(
            code(create_pr_with(&gh, &repo_of(&fx), "main", draft("  "))),
            "empty_title"
        );
        let mut bad = draft("T");
        bad.base = "-x".into();
        assert_eq!(
            code(create_pr_with(&gh, &repo_of(&fx), "main", bad)),
            "bad_ref"
        );
    }

    #[test]
    fn create_pr_uses_branch_as_head() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        push_with(&fx.data, &fx.wt).unwrap();
        let name = branch(&fx);
        let view = format!(
            r#"{{"number":3,"url":"https://x/pull/3","state":"OPEN","isDraft":false,"title":"T","baseRefName":"main","headRefName":"{name}"}}"#
        );
        let gh = FakeGh::new(vec![
            gh_out(0, "https://x/pull/3\n", ""),
            gh_out(0, &view, ""),
        ]);
        let pr = create_pr_with(&gh, &repo_of(&fx), "main", draft(" T ")).unwrap();
        assert_eq!(pr.number, 3);
        let calls = gh.calls.borrow();
        let args = &calls[0];
        let at = args.iter().position(|a| a == "--head").unwrap();
        assert_eq!(args[at + 1], name);
        assert!(args.contains(&"T".to_owned()));
    }

    #[test]
    fn draft_commit_sends_diff_and_strips_fences() {
        let fx = fixture();
        fs::write(fx.wt.join("a.txt"), "changed line").unwrap();
        fs::write(fx.wt.join("new.txt"), "brand new text").unwrap();
        let runner = FakeRunner::new(Ok("```\nfix: x\n```"));
        let files = vec!["a.txt".to_owned(), "new.txt".to_owned()];
        let msg = draft_commit_with(&runner, &repo_of(&fx), &files).unwrap();
        assert_eq!(msg, "fix: x");
        let prompt = runner.reqs.borrow()[0].prompt.clone();
        assert!(prompt.contains("+changed line"), "{prompt}");
        assert!(prompt.contains("brand new text"), "{prompt}");
    }

    #[test]
    fn draft_prompt_is_capped() {
        let fx = fixture();
        fs::write(fx.wt.join("big.txt"), "é".repeat(100_000)).unwrap();
        let runner = FakeRunner::new(Ok("feat: big"));
        draft_commit_with(&runner, &repo_of(&fx), &["big.txt".to_owned()]).unwrap();
        let prompt = runner.reqs.borrow()[0].prompt.clone();
        assert!(prompt.len() <= 61_000, "{}", prompt.len());
        assert!(prompt.contains("[cut]"));
    }

    #[test]
    fn draft_pr_splits_title_and_body() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two lines");
        let runner = FakeRunner::new(Ok("```markdown\n# Title: Add b\n\nAdds b.\n\n- one\n```"));
        let base = locate(&fx.data, &fx.wt).unwrap().base_ref;
        let d = draft_pr_with(&runner, &repo_of(&fx), &base).unwrap();
        assert_eq!(d.title, "Add b");
        assert_eq!(d.body, "Adds b.\n\n- one");
        assert_eq!((d.base, d.draft), (base, false));
        let prompt = runner.reqs.borrow()[0].prompt.clone();
        assert!(
            prompt.contains("b.txt") && prompt.contains("+two lines"),
            "{prompt}"
        );
    }

    #[test]
    fn draft_runs_without_tools() {
        let fx = fixture();
        fs::write(fx.wt.join("a.txt"), "x").unwrap();
        let runner = FakeRunner::new(Ok("fix: y"));
        draft_commit_with(&runner, &repo_of(&fx), &["a.txt".to_owned()]).unwrap();
        let req = runner.reqs.borrow()[0].clone();
        assert!(req.tools.is_empty());
        assert_eq!(req.model, None);
    }

    #[test]
    fn draft_failure_is_draft_failed() {
        let fx = fixture();
        let runner = FakeRunner::new(Err("claude_missing"));
        let e = draft_commit_with(&runner, &repo_of(&fx), &["a.txt".to_owned()]).unwrap_err();
        assert_eq!(e.code, "draft_failed");
        assert_eq!(e.detail.as_deref(), Some("claude_missing"));

        let empty = FakeRunner::new(Ok("  "));
        assert_eq!(
            code(draft_commit_with(&empty, &repo_of(&fx), &[])),
            "draft_failed"
        );
    }
}
