//! Shipping a worktree's work: where the branch stands against its remote
//! and its base, push, pull, sync, fetch, gated force push and amend.
//! Each command returns a fresh `ShipView` so the UI never guesses.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};
use xdev_agent::{AgentError, Cancel, Cli, Profiles, RunRequest, Runner};
use xdev_ai::Provider;
use xdev_git::{
    BaseRange, Check, ForkSync, GhAccount, GhEnv, GhExec, GhLogin, GhOutput, GitError, PrDraft,
    PrView, PullPolicy, Repo, SystemGh, TokenGh, Upstream, pr_checks, pr_create, pr_open_web,
    pr_view, run_failed_log,
};
use xdev_policy::{Action, Gate, Verdict};
use xdev_workspace::{Registry, WorkspaceError, path_key};

use crate::accounts::data_dir;
use crate::agent_sessions::{SessionRow, worktree_sessions};
use crate::commands::{AppState, CmdError, load_git_settings};
use crate::kit::Ctx;
use crate::profiles::{Find, default_agent_id, detect};
use crate::recipes::{BRANCH_VARS, COMMIT_VARS, PR_VARS, render};
use crate::settings::Recipe;
use crate::tasks::{gate, provider_runner};
use crate::workspace::{bad_arg, inside, parent_within, start_of};

/// Commits listed in `ShipView::range`.
const RANGE_LIMIT: usize = 50;
/// What a draft prompt carries of the changes; the rest is cut.
const DRAFT_CAP: usize = 60_000;
/// The built-in commit message prompt; `{basePrompt}` is this and the changes.
const COMMIT_BASE: &str = "Write a concise conventional commit message for the changes below. \
     The subject line is at most 72 characters; add a short body only if it helps. \
     Answer with the message only, no quotes and no commentary.";
/// The built-in pull request prompt; `{baseBranch}` is filled when it is built.
const PR_BASE: &str = "Write a pull request title and description for merging the current branch into {baseBranch}. \
     Put the title on the first line, then a blank line, then the description in Markdown. \
     Answer with that only, no commentary.";

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
    /// What the branch adds to `range_base`; `None` for the primary checkout.
    pub range: Option<BaseRange>,
    /// What `range` counts from: the base, or the upstream when
    /// Settings → Git compares against it and the branch has one.
    pub range_base: String,
    /// The branch has commits its base lacks, whatever `range` counts from;
    /// what offering a pull request goes by.
    pub ahead_of_base: bool,
    /// The repo has remotes named both `origin` and `upstream`, so Sync fork
    /// is offered.
    pub has_fork_upstream: bool,
}

/// What the registry knows about a checkout.
struct Known {
    base_ref: String,
    /// `None` for the primary checkout.
    start: Option<String>,
    /// The `gh` login the repo is bound to; `None` is `gh`'s own default.
    gh_account: Option<GhAccount>,
}

/// Runs `f` with `gh` as the repo's bound login, or plain `gh` when it has
/// none. A login `gh` no longer holds fails the call with `gh_account_missing`.
pub(crate) fn run_gh<E: GhEnv, R>(
    inner: &E,
    account: Option<GhAccount>,
    f: impl FnOnce(&dyn GhExec) -> R,
) -> R {
    match account {
        Some(account) => f(&TokenGh { inner, account }),
        None => f(&GhPlain(inner)),
    }
}

/// An unbound call: no token, so `gh` picks its own login.
struct GhPlain<'a, E: GhEnv>(&'a E);

impl<E: GhEnv> GhExec for GhPlain<'_, E> {
    fn run(&self, cwd: &Path, args: &[&str], stdin: Option<&str>) -> Result<GhOutput, GitError> {
        self.0.run_env(cwd, args, stdin, &[])
    }
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
            gh_account: repo.gh_account.clone(),
        });
    }
    match reg.repos.iter().find(|r| path_key(&r.path) == key) {
        Some(repo) => Ok(Known {
            base_ref: repo.base_ref.clone(),
            start: None,
            gh_account: repo.gh_account.clone(),
        }),
        None => Err(WorkspaceError::WorktreeUnknown(path.to_owned()).into()),
    }
}

/// The `gh` login the checkout's repo is bound to, for commands outside this
/// module that run `gh` through `run_gh`.
pub(crate) fn gh_account_for(data: &Path, path: &Path) -> Result<Option<GhAccount>, CmdError> {
    Ok(locate(data, path)?.gh_account)
}

fn err(code: &'static str, detail: Option<String>) -> CmdError {
    CmdError { code, detail }
}

fn view(data: &Path, path: &Path, against_upstream: bool) -> Result<ShipView, CmdError> {
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
    // The full ref, so a local branch named like `origin/feat` is not read instead.
    let (range_base, range_rev) = match &upstream {
        Some(up) if against_upstream && up.id.is_some() => (
            format!("{}/{}", up.remote, up.branch),
            format!("refs/remotes/{}/{}", up.remote, up.branch),
        ),
        _ => (known.base_ref.clone(), known.base_ref.clone()),
    };
    let range = match known.start {
        Some(_) => repo.branch_vs_base(&range_rev, RANGE_LIMIT).ok(),
        None => None,
    };
    let ahead_of_base = match (&known.start, &range) {
        (None, _) => false,
        (Some(_), Some(r)) if range_rev == known.base_ref => !r.commits.is_empty(),
        (Some(_), _) => has_commits_over(&repo, &known.base_ref),
    };
    Ok(ShipView {
        branch,
        base: known.base_ref,
        remote,
        upstream,
        head_pushed,
        at_start,
        range,
        range_base,
        ahead_of_base,
        has_fork_upstream: repo.has_fork_upstream()?,
    })
}

/// `HEAD` has a commit that `base` lacks; `false` when `base` does not resolve.
fn has_commits_over(repo: &Repo, base: &str) -> bool {
    let Ok(Some(merge_base)) = repo.merge_base(base, "HEAD") else {
        return false;
    };
    repo.commits_since(&merge_base, &["**".to_owned()], 1)
        .is_ok_and(|(commits, _)| !commits.is_empty())
}

fn push_with(data: &Path, path: &Path, against_upstream: bool) -> Result<ShipView, CmdError> {
    locate(data, path)?;
    Repo::discover(path)?.push()?;
    view(data, path, against_upstream)
}

/// Fast-forwards `origin`'s copy of `upstream`'s default branch. A plain
/// push like `push_with`, so no policy gate, as Push has none; it never
/// forces, and the worktree's branch, index and files are not touched.
fn sync_fork_with(data: &Path, path: &Path) -> Result<ForkSync, CmdError> {
    locate(data, path)?;
    Ok(Repo::discover(path)?.sync_fork()?)
}

fn pull_with(
    data: &Path,
    path: &Path,
    policy: PullPolicy,
    against_upstream: bool,
) -> Result<ShipView, CmdError> {
    locate(data, path)?;
    Repo::discover(path)?.pull_with(policy)?;
    view(data, path, against_upstream)
}

fn fast_forward_with(
    data: &Path,
    path: &Path,
    against_upstream: bool,
) -> Result<ShipView, CmdError> {
    locate(data, path)?;
    Repo::discover(path)?.fast_forward()?;
    view(data, path, against_upstream)
}

/// Rebases onto the registered base. Local history only, so no policy gate
/// (like `amend_with`); pushing the result later needs a force push.
fn rebase_from_base_with(
    data: &Path,
    path: &Path,
    against_upstream: bool,
) -> Result<ShipView, CmdError> {
    let known = locate(data, path)?;
    Repo::discover(path)?.rebase_from_base(&known.base_ref)?;
    view(data, path, against_upstream)
}

fn fetch_with(data: &Path, path: &Path, against_upstream: bool) -> Result<ShipView, CmdError> {
    locate(data, path)?;
    Repo::discover(path)?.fetch()?;
    view(data, path, against_upstream)
}

/// Fetches, then fast-forwards when behind or pushes when ahead. Split
/// histories are `pull_diverged` and nothing is pushed.
fn sync_with(
    data: &Path,
    path: &Path,
    policy: PullPolicy,
    against_upstream: bool,
) -> Result<ShipView, CmdError> {
    locate(data, path)?;
    let repo = Repo::discover(path)?;
    repo.fetch()?;
    let up = repo.upstream()?.ok_or_else(|| err("no_upstream", None))?;
    // The remote holds only old copies of our commits: a pull would replay
    // them, so the way on is a force push, which the user confirms.
    if up.rewritten {
        return Err(err("needs_force", None));
    }
    match (up.ahead, up.behind) {
        (0, 0) => {}
        (_, 0) => repo.push()?,
        // Behind, or both: `pull` refuses a split history itself. A policy
        // that merges or rebases leaves commits to publish afterwards.
        _ => {
            repo.pull_with(policy)?;
            if repo
                .upstream()?
                .is_some_and(|u| u.ahead > 0 && u.behind == 0)
            {
                repo.push()?;
            }
        }
    }
    view(data, path, against_upstream)
}

fn force_push_with(
    data: &Path,
    path: &Path,
    expected: &str,
    confirmed: bool,
    against_upstream: bool,
) -> Result<ShipView, CmdError> {
    let known = locate(data, path)?;
    let repo = Repo::discover(path)?;
    let branch = repo
        .current_branch()?
        .ok_or_else(|| err("detached", None))?;
    // The base ref may carry a remote's name: `origin/main` -> `main`.
    if branch == plain_base(&repo, &known.base_ref) {
        return Err(err("force_base", Some(branch)));
    }
    let remote = repo.remote_for(&branch)?;
    // The lease names the local branch's ref on the remote; with a differently named upstream
    // it would point at the wrong ref.
    if let Some(up) = repo.upstream()?
        && up.branch != branch
    {
        return Err(err(
            "push_rejected",
            Some(format!("{}/{}", up.remote, up.branch)),
        ));
    }
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
    view(data, path, against_upstream)
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

/// The base without a remote's name: `origin/main` -> `main`. Any configured remote counts.
fn plain_base(repo: &Repo, base_ref: &str) -> String {
    let mut remotes = repo.remote_names().unwrap_or_default();
    // Longest first, so `a/b` wins over `a`.
    remotes.sort_by_key(|r| std::cmp::Reverse(r.len()));
    for r in remotes {
        if let Some(rest) = base_ref.strip_prefix(&format!("{r}/")) {
            return rest.to_owned();
        }
    }
    base_ref.to_owned()
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
        Some(up) if up.ahead == 0 && up.id.is_some() => {}
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
pub(crate) fn ask(
    runner: &dyn Runner,
    repo: &Repo,
    prompt: String,
    args: &[String],
) -> Result<String, CmdError> {
    let req = RunRequest {
        worktree: repo.root(),
        prompt,
        resume: None,
        tools: vec![],
        model: None,
        args: args.to_vec(),
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

/// At most `DRAFT_CAP` bytes of a file: a huge file must not be loaded whole.
fn read_capped(path: &Path) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(DRAFT_CAP as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(bytes)
}

fn draft_commit_with(
    runner: &dyn Runner,
    repo: &Repo,
    files: &[String],
    recipe: &Recipe,
) -> Result<String, CmdError> {
    let mut changes = repo.diff_text(files)?;
    // Untracked files are not in `git diff`; show them whole.
    let untracked = repo.untracked()?;
    for file in files.iter().filter(|f| untracked.contains(f)) {
        let Some(bytes) = read_capped(&repo.root().join(file)) else {
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
    let changes = cap(&changes, DRAFT_CAP);
    let base = format!("{COMMIT_BASE}\n\n{changes}");
    let branch = repo.current_branch()?.unwrap_or_default();
    let staged = files.join("\n");
    // Work items arrive with worktree lifecycle (R4).
    let vars = [
        ("basePrompt", base.as_str()),
        ("branch", branch.as_str()),
        ("stagedFiles", staged.as_str()),
        ("stagedPatch", changes.as_str()),
        ("linkedIssue", ""),
    ];
    debug_assert!(vars.iter().map(|(name, _)| *name).eq(COMMIT_VARS));
    ask(runner, repo, render(&recipe.template, &vars), &recipe.args)
}

fn draft_pr_with(
    runner: &dyn Runner,
    repo: &Repo,
    base: &str,
    recipe: &Recipe,
) -> Result<PrDraft, CmdError> {
    // The plain name may exist only as a remote branch.
    let branch = repo.current_branch()?;
    let remote = branch.as_ref().and_then(|b| repo.remote_for(b).ok());
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
    let commits = repo.range_subjects(&rev)?;
    let files = repo.range_stat(&rev)?;
    let patch = repo.range_diff(&rev)?;
    let data = format!("Commits:\n{commits}\nFiles:\n{files}\nDiff:\n{patch}");
    let base_prompt = format!(
        "{}\n\n{}",
        render(PR_BASE, &[("baseBranch", base)]),
        cap(&data, DRAFT_CAP)
    );
    let patch = cap(&patch, DRAFT_CAP);
    let branch = branch.unwrap_or_default();
    // The dialog's own title and body are not passed in, so they are empty;
    // work items arrive with worktree lifecycle (R4).
    let vars = [
        ("basePrompt", base_prompt.as_str()),
        ("branch", branch.as_str()),
        ("baseBranch", base),
        ("currentTitle", ""),
        ("currentBody", ""),
        ("commitSummary", commits.as_str()),
        ("changedFiles", files.as_str()),
        ("patch", patch.as_str()),
        ("linkedIssue", ""),
    ];
    debug_assert!(vars.iter().map(|(name, _)| *name).eq(PR_VARS));
    let prompt = render(&recipe.template, &vars);
    let answer = ask(runner, repo, prompt, &recipe.args)?;
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

/// The provider a recipe's agent runs drafts through: its profile's CLI, or
/// the default agent's, resolved like the UI's. Only Claude and Codex have a
/// runner; Gemini and a custom program do not.
fn recipe_provider(data: &Path, recipe: &Recipe, find: Find<'_>) -> Result<Provider, CmdError> {
    let profiles = Profiles::load(data)?;
    let default_id = default_agent_id(&profiles, find);
    let id = recipe.agent.as_deref().unwrap_or(&default_id);
    let profile = profiles
        .get(id)
        .ok_or_else(|| err("unknown_profile", Some(id.to_owned())))?;
    match profile.cli {
        Some(Cli::Claude) => Ok(Provider::Claude),
        Some(Cli::Codex) => Ok(Provider::Codex),
        _ => Err(err("unsupported_agent", Some(id.to_owned()))),
    }
}

/// A draft run goes through the same gate as a task's, for the provider the
/// recipe names. `make` builds the runner once the gate allows it.
fn draft_runner_with(
    data: &Path,
    path: &Path,
    recipe: &Recipe,
    gate: &dyn Gate,
    find: Find<'_>,
    make: impl FnOnce(Provider) -> Result<Box<dyn Runner>, AgentError>,
) -> Result<Box<dyn Runner>, CmdError> {
    let provider = recipe_provider(data, recipe, find)?;
    let action = Action::SpawnAgent {
        provider: provider.as_str().to_owned(),
        account: None,
        worktree: path.to_owned(),
        tools: vec![],
    };
    match gate.check(&action) {
        Verdict::Allow => {}
        Verdict::Ask { reason } => return Err(err("needs_approval", Some(reason))),
        Verdict::Deny { reason } => return Err(err("denied", Some(reason))),
    }
    Ok(make(provider)?)
}

pub(crate) fn draft_runner(
    data: &Path,
    path: &Path,
    recipe: &Recipe,
) -> Result<Box<dyn Runner>, CmdError> {
    draft_runner_with(data, path, recipe, &gate(data)?, &detect, |p| {
        provider_runner(p, None)
    })
}

/// The URL of a PR the stats count when a lookup finds it: only for a worktree xDev made
/// (`start` is set), never the primary checkout. A PR someone else opened for a branch later
/// checked out in an xDev worktree counts too; that is a known limit.
fn pr_to_count<'a>(start: Option<&str>, pr: Option<&'a PrView>) -> Option<&'a str> {
    start?;
    pr.map(|p| p.url.as_str())
}

/// The URL of a PR xDev just created.
fn created_pr_url(pr: &PrView) -> &str {
    &pr.url
}

#[tauri::command(async)]
pub fn worktree_pr(
    state: State<'_, AppState>,
    stats: State<'_, crate::app_stats::AppStatsHub>,
    path: PathBuf,
) -> Result<Option<PrView>, CmdError> {
    let data = data_dir(&state)?;
    let known = locate(data, &path)?;
    let pr = run_gh(&SystemGh, known.gh_account, |gh| pr_with(gh, &path))?;
    if let Some(url) = pr_to_count(known.start.as_deref(), pr.as_ref()) {
        stats.record_pr(data, url);
    }
    Ok(pr)
}

#[tauri::command(async)]
pub fn worktree_pr_create(
    state: State<'_, AppState>,
    stats: State<'_, crate::app_stats::AppStatsHub>,
    path: PathBuf,
    draft: PrDraft,
) -> Result<PrView, CmdError> {
    let data = data_dir(&state)?;
    let known = locate(data, &path)?;
    let repo = Repo::discover(&path)?;
    let view = run_gh(&SystemGh, known.gh_account, |gh| {
        create_pr_with(gh, &repo, &known.base_ref, draft)
    })?;
    stats.record_pr(data, created_pr_url(&view));
    Ok(view)
}

#[tauri::command(async)]
pub fn worktree_pr_checks(
    state: State<'_, AppState>,
    path: PathBuf,
    number: u64,
) -> Result<Vec<Check>, CmdError> {
    let known = locate(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, known.gh_account, |gh| {
        Ok(pr_checks(gh, &path, number)?)
    })
}

/// The log of the failed job behind a check's `link`, for the Fix checks
/// recipe; `None` when it cannot be had.
#[tauri::command(async)]
pub fn worktree_check_log(
    state: State<'_, AppState>,
    path: PathBuf,
    link: String,
) -> Result<Option<String>, CmdError> {
    let known = locate(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, known.gh_account, |gh| {
        Ok(run_failed_log(gh, &path, &link)?)
    })
}

#[tauri::command(async)]
pub fn worktree_pr_open(
    state: State<'_, AppState>,
    path: PathBuf,
    checks: bool,
) -> Result<(), CmdError> {
    let known = locate(data_dir(&state)?, &path)?;
    run_gh(&SystemGh, known.gh_account, |gh| {
        Ok(pr_open_web(gh, &path, checks)?)
    })
}

/// The logins `gh` holds, for the project settings picker.
#[tauri::command(async)]
pub fn gh_logins() -> Result<Vec<GhLogin>, CmdError> {
    Ok(xdev_git::gh_logins(&SystemGh)?)
}

#[tauri::command(async)]
pub fn worktree_draft_commit(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
    files: Vec<String>,
) -> Result<String, CmdError> {
    let data = data_dir(&state)?;
    locate(data, &path)?;
    checked_files(&path, &files)?;
    let recipe = load_git_settings(&app).recipes.commit_message;
    let runner = draft_runner(data, &path, &recipe)?;
    draft_commit_with(runner.as_ref(), &Repo::discover(&path)?, &files, &recipe)
}

#[tauri::command(async)]
pub fn worktree_draft_pr(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<PrDraft, CmdError> {
    let data = data_dir(&state)?;
    let known = locate(data, &path)?;
    let repo = Repo::discover(&path)?;
    let recipe = load_git_settings(&app).recipes.pull_request;
    let runner = draft_runner(data, &path, &recipe)?;
    draft_pr_with(
        runner.as_ref(),
        &repo,
        &plain_base(&repo, &known.base_ref),
        &recipe,
    )
}

/// The built-in branch name prompt; `{basePrompt}` is this and the request.
const BRANCH_BASE: &str = "Name a git branch for the work that starts with the request below. \
     Answer with the name only: at most 4 lowercase words joined with dashes, \
     no quotes and no commentary.";

/// A branch leaf for the work that starts with `first_prompt`: the agent's
/// first line through the slug rules, cut to 4 words. Whatever the agent
/// does wrong (no runner, an error, nothing usable) falls back to the first
/// words of the prompt; a prompt with no usable word is `bad_name`.
fn suggest_with(
    runner: Option<&dyn Runner>,
    repo: &Repo,
    first_prompt: &str,
    recipe: &Recipe,
) -> Result<String, CmdError> {
    let fallback = names_from_work(first_prompt);
    if fallback.is_empty() {
        return Err(err("bad_name", None));
    }
    let Some(runner) = runner else {
        return Ok(fallback);
    };
    let base = format!("{BRANCH_BASE}\n\n{first_prompt}");
    // `xDev keeps no assistant text (R2): the variable is there, empty.
    let vars = [
        ("basePrompt", base.as_str()),
        ("firstPrompt", first_prompt),
        ("assistantMessage", ""),
    ];
    debug_assert!(vars.iter().map(|(name, _)| *name).eq(BRANCH_VARS));
    let answer = ask(runner, repo, render(&recipe.template, &vars), &recipe.args);
    let line = answer
        .ok()
        .and_then(|a| a.lines().find(|l| !l.trim().is_empty()).map(str::to_owned));
    // The agent's dashes separate words, so 4 words are 4 dashed parts.
    let named = line
        .map(|l| names_from_work(&l.replace(['-', '_', '/', '.'], " ")))
        .unwrap_or_default();
    Ok(if named.is_empty() { fallback } else { named })
}

fn names_from_work(prompt: &str) -> String {
    xdev_workspace::from_work(prompt)
}

/// The title of the session `session` names (its id or `<home>:<id>`), else
/// of the first row, which is the latest.
fn first_prompt(rows: &[SessionRow], session: Option<&str>) -> Option<String> {
    let row = match session {
        Some(id) => rows
            .iter()
            .find(|r| r.session.id == id || r.session.key == id)?,
        None => rows.first()?,
    };
    row.session.title.clone().filter(|t| !t.trim().is_empty())
}

/// A branch name for the work of `session` (else the latest session of the
/// worktree), from the branch-name recipe's agent or the first words of the
/// prompt. Makes no change; Settings → Git, auto rename, does not apply.
#[tauri::command(async)]
pub fn worktree_suggest_branch(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
    session: Option<String>,
) -> Result<String, CmdError> {
    let data = data_dir(&state)?;
    locate(data, &path)?;
    let ctx = Ctx::of(&state)?;
    let rows = worktree_sessions(&ctx.data, || ctx.homes(), &path)?;
    let prompt = first_prompt(&rows, session.as_deref()).ok_or_else(|| err("bad_name", None))?;
    let recipe = load_git_settings(&app).recipes.branch_name;
    // A recipe whose agent cannot run drafts (or the gate says no) still
    // names the branch, from the prompt.
    let runner = draft_runner(data, &path, &recipe).ok();
    suggest_with(runner.as_deref(), &Repo::discover(&path)?, &prompt, &recipe)
}

/// Settings → Git: count the range against the upstream.
fn against_upstream(app: &AppHandle) -> bool {
    load_git_settings(app).compare_against_upstream
}

#[tauri::command(async)]
pub fn worktree_ship(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<ShipView, CmdError> {
    view(data_dir(&state)?, &path, against_upstream(&app))
}

#[tauri::command(async)]
pub fn worktree_push(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<ShipView, CmdError> {
    push_with(data_dir(&state)?, &path, against_upstream(&app))
}

/// Sync fork: brings `origin`'s default branch up to `upstream`'s. A refusal
/// is a `blocked` result, not an error.
#[tauri::command(async)]
pub fn worktree_sync_fork(state: State<'_, AppState>, path: PathBuf) -> Result<ForkSync, CmdError> {
    sync_fork_with(data_dir(&state)?, &path)
}

#[tauri::command(async)]
pub fn worktree_pull(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<ShipView, CmdError> {
    pull_with(
        data_dir(&state)?,
        &path,
        load_git_settings(&app).pull_policy,
        against_upstream(&app),
    )
}

#[tauri::command(async)]
pub fn worktree_fast_forward(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<ShipView, CmdError> {
    fast_forward_with(data_dir(&state)?, &path, against_upstream(&app))
}

#[tauri::command(async)]
pub fn worktree_rebase_from_base(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<ShipView, CmdError> {
    rebase_from_base_with(data_dir(&state)?, &path, against_upstream(&app))
}

#[tauri::command(async)]
pub fn worktree_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<ShipView, CmdError> {
    sync_with(
        data_dir(&state)?,
        &path,
        load_git_settings(&app).pull_policy,
        against_upstream(&app),
    )
}

#[tauri::command(async)]
pub fn worktree_fetch(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<ShipView, CmdError> {
    fetch_with(data_dir(&state)?, &path, against_upstream(&app))
}

#[tauri::command(async)]
pub fn worktree_force_push(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
    expected: String,
    confirmed: bool,
) -> Result<ShipView, CmdError> {
    force_push_with(
        data_dir(&state)?,
        &path,
        &expected,
        confirmed,
        against_upstream(&app),
    )
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

    fn pr_view(url: &str) -> PrView {
        PrView {
            number: 1,
            url: url.to_owned(),
            state: xdev_git::PrState::Open,
            title: String::new(),
            base: "main".to_owned(),
            head: "feat".to_owned(),
        }
    }

    #[test]
    fn pr_counts_only_for_xdev_worktrees() {
        let pr = pr_view("https://x/pr/1");
        assert_eq!(pr_to_count(Some("main"), Some(&pr)), Some("https://x/pr/1"));
        assert_eq!(pr_to_count(None, Some(&pr)), None);
        assert_eq!(pr_to_count(Some("main"), None), None);
    }

    #[test]
    fn created_pr_always_counts() {
        assert_eq!(created_pr_url(&pr_view("https://x/pr/2")), "https://x/pr/2");
    }

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
        let tmp = crate::test_dirs::long_temp_dir("ship cmd ");
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
    fn view_reports_fork_upstream() {
        let fx = fixture();
        assert!(!view(&fx.data, &fx.wt, false).unwrap().has_fork_upstream);
        let up = fx.tmp.path().join("upstream.git");
        git(
            &fx.main,
            &["remote", "add", "upstream", up.to_str().unwrap()],
        );
        assert!(view(&fx.data, &fx.wt, false).unwrap().has_fork_upstream);
    }

    #[test]
    fn sync_fork_fast_forwards_origin_from_upstream() {
        let fx = fixture();
        let base = git(&fx.main, &["rev-parse", "--abbrev-ref", "HEAD"]);
        git(&fx.main, &["push", "-q", "origin", &base]);
        let up = fx.tmp.path().join("upstream.git");
        git(
            fx.tmp.path(),
            &[
                "clone",
                "-q",
                "--bare",
                fx.main.to_str().unwrap(),
                "upstream.git",
            ],
        );
        git(
            &fx.main,
            &["remote", "add", "upstream", up.to_str().unwrap()],
        );
        commit_file(&fx.main, "c.txt", "three");
        git(&fx.main, &["push", "-q", "upstream", &base]);
        let tip = git(&fx.main, &["rev-parse", "HEAD"]);
        let wt_head = git(&fx.wt, &["rev-parse", "HEAD"]);

        let done = sync_fork_with(&fx.data, &fx.wt).unwrap();
        assert_eq!(done.status, xdev_git::ForkSyncStatus::Synced);
        assert_eq!(done.branch.as_deref(), Some(base.as_str()));
        assert_eq!(done.behind, 1);
        let heads = format!("refs/heads/{base}");
        assert_eq!(git(&fx.origin, &["rev-parse", &heads]), tip);
        assert_eq!(git(&fx.wt, &["rev-parse", "HEAD"]), wt_head);

        let again = sync_fork_with(&fx.data, &fx.wt).unwrap();
        assert_eq!(again.status, xdev_git::ForkSyncStatus::UpToDate);
    }

    #[test]
    fn sync_fork_refuses_an_unknown_worktree() {
        let fx = fixture();
        let other = fx.tmp.path().join("other");
        fs::create_dir(&other).unwrap();
        assert_eq!(code(sync_fork_with(&fx.data, &other)), "worktree_unknown");
    }

    #[test]
    fn ship_view_reports_range_and_no_upstream() {
        let fx = fixture();
        let v = view(&fx.data, &fx.wt, false).unwrap();
        assert!(v.at_start && !v.head_pushed && !v.ahead_of_base);
        assert_eq!(v.remote.as_deref(), Some("origin"));
        assert_eq!(v.upstream, None);
        assert_eq!(v.range.as_ref().unwrap().commits.len(), 0);

        commit_file(&fx.wt, "b.txt", "two");
        let v = view(&fx.data, &fx.wt, false).unwrap();
        assert!(!v.at_start && v.ahead_of_base);
        let range = v.range.unwrap();
        assert_eq!(range.commits.len(), 1);
        assert_eq!(range.added, 1);

        // The primary checkout has no start and no range.
        let v = view(&fx.data, &fx.main, false).unwrap();
        assert_eq!((v.range, v.at_start), (None, false));
    }

    #[test]
    fn ship_view_counts_against_the_upstream_when_asked() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        // No upstream yet: the base stays.
        let v = view(&fx.data, &fx.wt, true).unwrap();
        assert_eq!(v.range_base, v.base);
        assert_eq!(v.range.unwrap().commits.len(), 1);

        push_with(&fx.data, &fx.wt, false).unwrap();
        commit_file(&fx.wt, "c.txt", "three");
        let by_base = view(&fx.data, &fx.wt, false).unwrap();
        assert_eq!(by_base.range_base, by_base.base);
        assert_eq!(by_base.range.unwrap().commits.len(), 2);

        let by_upstream = view(&fx.data, &fx.wt, true).unwrap();
        assert_eq!(by_upstream.range_base, format!("origin/{}", branch(&fx)));
        assert_eq!(by_upstream.base, by_base.base);
        assert!(by_upstream.ahead_of_base);
        let range = by_upstream.range.unwrap();
        assert_eq!(range.commits.len(), 1);
        assert_eq!(range.commits[0].message, "c.txt");

        // Everything pushed: nothing over the upstream, still work over the base.
        push_with(&fx.data, &fx.wt, false).unwrap();
        let v = view(&fx.data, &fx.wt, true).unwrap();
        assert_eq!(v.range.unwrap().commits.len(), 0);
        assert!(v.ahead_of_base);
    }

    #[test]
    fn push_then_ship_shows_upstream() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        let v = push_with(&fx.data, &fx.wt, false).unwrap();
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
        push_with(&fx.data, &fx.wt, false).unwrap();
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

        let v = sync_with(&fx.data, &fx.wt, PullPolicy::FfOnly, false).unwrap();
        assert!(fx.wt.join("c.txt").exists());
        assert_eq!(v.upstream.unwrap().behind, 0);

        commit_file(&fx.wt, "d.txt", "four");
        let v = sync_with(&fx.data, &fx.wt, PullPolicy::FfOnly, false).unwrap();
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
        assert_eq!(
            code(sync_with(&fx.data, &fx.wt, PullPolicy::FfOnly, false)),
            "pull_diverged"
        );
        assert_eq!(git(&fx.origin, &["rev-parse", &name]), remote_before);

        // With a merge policy the same split history is joined and pushed.
        let v = sync_with(&fx.data, &fx.wt, PullPolicy::Merge, false).unwrap();
        let up = v.upstream.unwrap();
        assert_eq!((up.ahead, up.behind), (0, 0));
        assert_eq!(
            git(&fx.origin, &["rev-parse", &name]),
            git(&fx.wt, &["rev-parse", "HEAD"])
        );
    }

    #[test]
    fn rebase_from_base_follows_the_registered_base() {
        let fx = fixture();
        commit_file(&fx.wt, "f.txt", "f");
        // The base has no remote counterpart yet.
        assert_eq!(
            code(rebase_from_base_with(&fx.data, &fx.wt, false)),
            "base_not_remote"
        );
        let base = Registry::load(&fx.data).unwrap().repos[0].base_ref.clone();
        git(&fx.main, &["push", "-q", "-u", "origin", &base]);
        commit_file(&fx.main, "m.txt", "m");
        git(&fx.main, &["push", "-q", "origin", &base]);
        rebase_from_base_with(&fx.data, &fx.wt, false).unwrap();
        assert!(fx.wt.join("m.txt").exists() && fx.wt.join("f.txt").exists());
    }

    #[test]
    fn fast_forward_refuses_a_branch_without_upstream() {
        let fx = fixture();
        assert_eq!(
            code(fast_forward_with(&fx.data, &fx.wt, false)),
            "no_upstream"
        );
    }

    #[test]
    fn sync_with_a_rewritten_branch_asks_for_a_force_push() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        push_with(&fx.data, &fx.wt, false).unwrap();
        let name = branch(&fx);
        git(&fx.wt, &["commit", "-q", "--amend", "-m", "reworded"]);
        let remote_before = git(&fx.origin, &["rev-parse", &name]);
        assert_eq!(
            code(sync_with(&fx.data, &fx.wt, PullPolicy::Merge, false)),
            "needs_force"
        );
        assert_eq!(git(&fx.origin, &["rev-parse", &name]), remote_before);
    }

    #[test]
    fn force_push_needs_confirmation() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        let v = push_with(&fx.data, &fx.wt, false).unwrap();
        let expected = v.upstream.unwrap().id.unwrap();
        git(&fx.wt, &["commit", "-q", "--amend", "-m", "reworded"]);
        let name = branch(&fx);

        assert_eq!(
            code(force_push_with(&fx.data, &fx.wt, &expected, false, false)),
            "needs_approval"
        );
        assert_eq!(git(&fx.origin, &["rev-parse", &name]), expected);

        let v = force_push_with(&fx.data, &fx.wt, &expected, true, false).unwrap();
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
            code(force_push_with(&fx.data, &fx.main, &head, true, false)),
            "force_base"
        );
    }

    #[test]
    fn plain_base_strips_any_remote() {
        let fx = fixture();
        git(
            &fx.wt,
            &["remote", "add", "upstream", fx.origin.to_str().unwrap()],
        );
        let repo = repo_of(&fx);
        assert_eq!(plain_base(&repo, "upstream/main"), "main");
        assert_eq!(plain_base(&repo, "origin/main"), "main");
        assert_eq!(plain_base(&repo, "main"), "main");
        assert_eq!(plain_base(&repo, "feature/x"), "feature/x");
    }

    #[test]
    fn force_push_refuses_renamed_upstream() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        let name = branch(&fx);
        git(&fx.wt, &["push", "-q", "origin", &format!("{name}:other")]);
        git(
            &fx.wt,
            &["config", &format!("branch.{name}.remote"), "origin"],
        );
        git(
            &fx.wt,
            &[
                "config",
                &format!("branch.{name}.merge"),
                "refs/heads/other",
            ],
        );
        git(&fx.wt, &["fetch", "-q", "origin"]);
        let id = git(&fx.wt, &["rev-parse", "HEAD"]);
        let before = git(&fx.origin, &["rev-parse", "other"]);
        assert_eq!(
            code(force_push_with(&fx.data, &fx.wt, &id, true, false)),
            "push_rejected"
        );
        assert_eq!(git(&fx.origin, &["rev-parse", "other"]), before);
    }

    #[test]
    fn create_pr_refuses_deleted_remote_branch() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two");
        push_with(&fx.data, &fx.wt, false).unwrap();
        let name = branch(&fx);
        git(&fx.origin, &["branch", "-D", &name]);
        git(&fx.wt, &["fetch", "-q", "--prune", "origin"]);
        let gh = FakeGh::new(vec![]);
        assert_eq!(
            code(create_pr_with(
                &gh,
                &repo_of(&fx),
                "origin/main",
                draft("T")
            )),
            "not_pushed"
        );
        assert!(gh.calls.borrow().is_empty());
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
        push_with(&fx.data, &fx.wt, false).unwrap();
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
        push_with(&fx.data, &fx.wt, false).unwrap();
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
        let hook = hooks.join("pre-commit");
        fs::write(&hook, "#!/bin/sh\necho lint failed >&2\nexit 1\n").unwrap();
        // Git skips hooks that are not executable on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }
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
    use xdev_git::{GhAccount, GhEnv, GhOutput, GitError};

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

    fn prompt_row(id: &str, title: Option<&str>) -> SessionRow {
        SessionRow {
            session: xdev_kit::AgentSession {
                key: format!("h:{id}"),
                id: id.to_owned(),
                home_id: "h".to_owned(),
                agent: xdev_kit::Agent::Claude,
                cwd: None,
                branch: None,
                title: title.map(str::to_owned),
                model: None,
                first: 0,
                last: 0,
                messages: 1,
            },
            worktree: None,
            repo: None,
            resumable: true,
            hit: None,
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
        push_with(&fx.data, &fx.wt, false).unwrap();
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
        push_with(&fx.data, &fx.wt, false).unwrap();
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
        push_with(&fx.data, &fx.wt, false).unwrap();
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
        let msg = draft_commit_with(&runner, &repo_of(&fx), &files, &Recipe::default()).unwrap();
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
        draft_commit_with(
            &runner,
            &repo_of(&fx),
            &["big.txt".to_owned()],
            &Recipe::default(),
        )
        .unwrap();
        let prompt = runner.reqs.borrow()[0].prompt.clone();
        assert!(prompt.len() <= 61_000, "{}", prompt.len());
        assert!(prompt.contains("[cut]"));
    }

    #[test]
    fn untracked_files_are_read_capped() {
        let fx = fixture();
        fs::write(fx.wt.join("huge.txt"), "x".repeat(DRAFT_CAP * 3)).unwrap();
        let bytes = read_capped(&fx.wt.join("huge.txt")).unwrap();
        assert_eq!(bytes.len(), DRAFT_CAP);
    }

    #[test]
    fn draft_pr_splits_title_and_body() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two lines");
        let runner = FakeRunner::new(Ok("```markdown\n# Title: Add b\n\nAdds b.\n\n- one\n```"));
        let base = locate(&fx.data, &fx.wt).unwrap().base_ref;
        let d = draft_pr_with(&runner, &repo_of(&fx), &base, &Recipe::default()).unwrap();
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
        draft_commit_with(
            &runner,
            &repo_of(&fx),
            &["a.txt".to_owned()],
            &Recipe::default(),
        )
        .unwrap();
        let req = runner.reqs.borrow()[0].clone();
        assert!(req.tools.is_empty());
        assert_eq!(req.model, None);
    }

    #[test]
    fn suggest_takes_the_runner_answer_through_the_slug_rules() {
        let fx = fixture();
        let runner = FakeRunner::new(Ok(
            "```\nFix the Footer's usage-meter rounding\n```\nbecause",
        ));
        let name = suggest_with(
            Some(&runner),
            &repo_of(&fx),
            "fix the footer usage meter rounding",
            &Recipe::default(),
        )
        .unwrap();
        assert_eq!(name, "fix-the-footers-usage");
        // The prompt carries the request, with no tools.
        let req = runner.reqs.borrow()[0].clone();
        assert!(req.prompt.contains("fix the footer usage meter rounding"));
        assert!(req.tools.is_empty());
    }

    #[test]
    fn suggest_renders_the_recipe_template_with_its_variables() {
        let fx = fixture();
        let runner = FakeRunner::new(Ok("name-it"));
        let recipe = Recipe {
            agent: None,
            args: vec!["--x".to_owned()],
            template: "FIRST[{firstPrompt}] ASSISTANT[{assistantMessage}] BASE[{basePrompt}]"
                .to_owned(),
        };
        suggest_with(Some(&runner), &repo_of(&fx), "do the thing", &recipe).unwrap();
        let req = runner.reqs.borrow()[0].clone();
        assert!(
            req.prompt
                .starts_with("FIRST[do the thing] ASSISTANT[] BASE[")
        );
        assert_eq!(req.args, ["--x"]);
    }

    #[test]
    fn suggest_falls_back_to_the_first_words_when_the_runner_fails_or_says_nothing() {
        let fx = fixture();
        for answer in [Err("claude_missing"), Ok("   "), Ok("日本語")] {
            let runner = FakeRunner::new(answer);
            let name = suggest_with(
                Some(&runner),
                &repo_of(&fx),
                "fix the footer usage meter rounding",
                &Recipe::default(),
            )
            .unwrap();
            assert_eq!(name, "fix-the-footer-usage", "{answer:?}");
        }
        // No runner at all (a profile without one): the same fallback.
        let name = suggest_with(
            None,
            &repo_of(&fx),
            "Add login page now please",
            &Recipe::default(),
        )
        .unwrap();
        assert_eq!(name, "add-login-page-now");
    }

    #[test]
    fn suggest_without_a_usable_prompt_is_bad_name() {
        let fx = fixture();
        let runner = FakeRunner::new(Ok("anything"));
        for prompt in ["", "   ", "日本語 だけ", "... ---"] {
            let e =
                suggest_with(Some(&runner), &repo_of(&fx), prompt, &Recipe::default()).unwrap_err();
            assert_eq!(e.code, "bad_name", "{prompt:?}");
        }
        // The runner is not asked about nothing.
        assert!(runner.reqs.borrow().is_empty());
    }

    #[test]
    fn the_prompt_comes_from_the_named_session_else_the_latest() {
        let row = |id: &str, title: Option<&str>| prompt_row(id, title);
        let rows = [
            row("new", Some("latest work")),
            row("old", Some("older work")),
        ];
        assert_eq!(
            first_prompt(&rows, Some("old")).as_deref(),
            Some("older work")
        );
        assert_eq!(first_prompt(&rows, None).as_deref(), Some("latest work"));
        // `<home>:<id>` keys work too.
        assert_eq!(
            first_prompt(&rows, Some("h:old")).as_deref(),
            Some("older work")
        );
        assert_eq!(first_prompt(&rows, Some("nope")), None);
        assert_eq!(first_prompt(&[row("x", None)], None), None);
    }

    #[test]
    fn draft_failure_is_draft_failed() {
        let fx = fixture();
        let runner = FakeRunner::new(Err("claude_missing"));
        let e = draft_commit_with(
            &runner,
            &repo_of(&fx),
            &["a.txt".to_owned()],
            &Recipe::default(),
        )
        .unwrap_err();
        assert_eq!(e.code, "draft_failed");
        assert_eq!(e.detail.as_deref(), Some("claude_missing"));

        let empty = FakeRunner::new(Ok("  "));
        assert_eq!(
            code(draft_commit_with(
                &empty,
                &repo_of(&fx),
                &[],
                &Recipe::default()
            )),
            "draft_failed"
        );
    }

    fn recipe_of(agent: Option<&str>) -> Recipe {
        Recipe {
            agent: agent.map(str::to_owned),
            ..Recipe::default()
        }
    }

    /// A runner that only says which provider it was built for.
    struct Labeled(&'static str);

    impl Runner for Labeled {
        fn run(&self, _req: &RunRequest) -> Result<RunOutcome, AgentError> {
            Err(AgentError::Runner(self.0.to_owned()))
        }

        fn provider(&self) -> &str {
            self.0
        }
    }

    /// Rules as set, remembering the provider it was asked about.
    struct FakeGate {
        verdict: Verdict,
        asked: RefCell<Vec<String>>,
    }

    impl FakeGate {
        fn new(verdict: Verdict) -> FakeGate {
            FakeGate {
                verdict,
                asked: RefCell::default(),
            }
        }
    }

    impl Gate for FakeGate {
        fn check(&self, action: &Action) -> Verdict {
            if let Action::SpawnAgent { provider, .. } = action {
                self.asked.borrow_mut().push(provider.clone());
            }
            self.verdict.clone()
        }
    }

    fn all_found(_: &xdev_agent::Profile) -> Option<PathBuf> {
        Some(PathBuf::from("/bin/x"))
    }

    fn built_with(data: &Path, recipe: &Recipe, gate: &FakeGate) -> Result<String, CmdError> {
        built_found(data, recipe, gate, &all_found)
    }

    fn built_found(
        data: &Path,
        recipe: &Recipe,
        gate: &FakeGate,
        find: &dyn Fn(&xdev_agent::Profile) -> Option<PathBuf>,
    ) -> Result<String, CmdError> {
        draft_runner_with(data, Path::new("wt"), recipe, gate, find, |p| {
            Ok(Box::new(Labeled(p.as_str())))
        })
        .map(|r| r.provider().to_owned())
    }

    #[test]
    fn no_profile_under_auto_is_the_agent_auto_resolves() {
        let dir = tempfile::tempdir().unwrap();
        let gate = FakeGate::new(Verdict::Allow);
        let codex =
            |p: &xdev_agent::Profile| (p.id == "codex").then(|| PathBuf::from("/bin/codex"));
        assert_eq!(
            built_found(dir.path(), &recipe_of(None), &gate, &codex).unwrap(),
            "codex"
        );
        // Auto resolving to an agent with no runner says which one.
        let gemini = |p: &xdev_agent::Profile| (p.id == "gemini").then(|| PathBuf::from("/bin/g"));
        let e = built_found(dir.path(), &recipe_of(None), &gate, &gemini)
            .err()
            .unwrap();
        assert_eq!(
            (e.code, e.detail.as_deref()),
            ("unsupported_agent", Some("gemini"))
        );
    }

    fn built_for(data: &Path, recipe: &Recipe) -> Result<String, CmdError> {
        built_with(data, recipe, &FakeGate::new(Verdict::Allow))
    }

    #[test]
    fn a_recipe_picks_the_runner_of_its_profile() {
        let dir = tempfile::tempdir().unwrap();
        // No profile named: the default agent, Claude.
        assert_eq!(built_for(dir.path(), &recipe_of(None)).unwrap(), "claude");
        assert_eq!(
            built_for(dir.path(), &recipe_of(Some("codex"))).unwrap(),
            "codex"
        );
        // A default agent other than Claude is what "no profile" means.
        let mut profiles = Profiles::load(dir.path()).unwrap();
        profiles.default_agent = xdev_agent::DefaultAgent::Agent("codex".to_owned());
        profiles.save(dir.path()).unwrap();
        assert_eq!(built_for(dir.path(), &recipe_of(None)).unwrap(), "codex");
    }

    #[test]
    fn gemini_custom_and_unknown_profiles_have_no_runner() {
        let dir = tempfile::tempdir().unwrap();
        let mut profiles = Profiles::load(dir.path()).unwrap();
        profiles
            .put(xdev_agent::Profile {
                id: "mine".to_owned(),
                name: "Mine".to_owned(),
                cli: None,
                program: Some("my-agent".to_owned()),
                args: vec![],
                env: vec![],
                model: None,
                effort: None,
                permissions: None,
                account: None,
                startup: vec![],
                enabled: true,
            })
            .unwrap();
        profiles.save(dir.path()).unwrap();
        for id in ["gemini", "mine"] {
            let e = built_for(dir.path(), &recipe_of(Some(id))).err().unwrap();
            assert_eq!(e.code, "unsupported_agent", "{id}");
        }
        let e = built_for(dir.path(), &recipe_of(Some("ghost")))
            .err()
            .unwrap();
        assert_eq!(e.code, "unknown_profile");
    }

    #[test]
    fn the_gate_rules_on_the_recipes_provider() {
        let dir = tempfile::tempdir().unwrap();
        let gate = FakeGate::new(Verdict::Allow);
        built_with(dir.path(), &recipe_of(Some("codex")), &gate).unwrap();
        built_with(dir.path(), &recipe_of(None), &gate).unwrap();
        assert_eq!(*gate.asked.borrow(), ["codex", "claude"]);

        let deny = FakeGate::new(Verdict::Deny {
            reason: "no".to_owned(),
        });
        let e = built_with(dir.path(), &recipe_of(Some("codex")), &deny)
            .err()
            .unwrap();
        assert_eq!((e.code, e.detail.as_deref()), ("denied", Some("no")));
        let ask = FakeGate::new(Verdict::Ask {
            reason: "sure?".to_owned(),
        });
        let e = built_with(dir.path(), &recipe_of(None), &ask)
            .err()
            .unwrap();
        assert_eq!(e.code, "needs_approval");

        // No profile, no ask: the gate is not reached for an agent with no runner.
        let gate = FakeGate::new(Verdict::Allow);
        assert!(built_with(dir.path(), &recipe_of(Some("gemini")), &gate).is_err());
        assert!(gate.asked.borrow().is_empty());
    }

    #[test]
    fn draft_args_reach_the_runner() {
        let fx = fixture();
        let runner = FakeRunner::new(Ok("fix: a"));
        let args = vec!["--model".to_owned(), "x".to_owned()];
        let recipe = Recipe {
            args: args.clone(),
            ..Recipe::default()
        };
        draft_commit_with(&runner, &repo_of(&fx), &["a.txt".to_owned()], &recipe).unwrap();
        assert_eq!(runner.reqs.borrow()[0].args, args);
    }

    #[test]
    fn the_default_template_gives_the_built_in_commit_prompt() {
        let fx = fixture();
        fs::write(fx.wt.join("a.txt"), "changed line").unwrap();
        let repo = repo_of(&fx);
        let files = vec!["a.txt".to_owned()];
        let runner = FakeRunner::new(Ok("fix: x"));
        draft_commit_with(&runner, &repo, &files, &Recipe::default()).unwrap();
        // Golden: the prompt as it was before recipes, word for word.
        let expected = format!(
            "Write a concise conventional commit message for the changes below. \
             The subject line is at most 72 characters; add a short body only if it helps. \
             Answer with the message only, no quotes and no commentary.\n\n{}",
            repo.diff_text(&files).unwrap()
        );
        assert_eq!(runner.reqs.borrow()[0].prompt, expected);
    }

    #[test]
    fn a_commit_template_gets_its_variables() {
        let fx = fixture();
        fs::write(fx.wt.join("a.txt"), "changed line").unwrap();
        let recipe = Recipe {
            template: "House style.\n{basePrompt}\n--\nOn {branch}: {stagedFiles} [{linkedIssue}] {{x}}\n{stagedPatch}"
                .to_owned(),
            ..Recipe::default()
        };
        let runner = FakeRunner::new(Ok("fix: x"));
        let repo = repo_of(&fx);
        draft_commit_with(&runner, &repo, &["a.txt".to_owned()], &recipe).unwrap();
        let prompt = runner.reqs.borrow()[0].prompt.clone();
        let branch = repo.current_branch().unwrap().unwrap();
        assert!(
            prompt.starts_with("House style.\nWrite a concise conventional"),
            "{prompt}"
        );
        assert!(
            prompt.contains(&format!("--\nOn {branch}: a.txt [] {{x}}\n")),
            "{prompt}"
        );
        assert!(
            prompt
                .trim_end()
                .ends_with("+changed line\n\\ No newline at end of file"),
            "{prompt}"
        );
    }

    #[test]
    fn the_default_template_gives_the_built_in_pr_prompt() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two lines");
        let repo = repo_of(&fx);
        let base = locate(&fx.data, &fx.wt).unwrap().base_ref;
        let runner = FakeRunner::new(Ok("Title\n\nBody"));
        draft_pr_with(&runner, &repo, &base, &Recipe::default()).unwrap();
        let expected = format!(
            "Write a pull request title and description for merging the current branch into {base}. \
             Put the title on the first line, then a blank line, then the description in Markdown. \
             Answer with that only, no commentary.\n\nCommits:\n{}\nFiles:\n{}\nDiff:\n{}",
            repo.range_subjects(&base).unwrap(),
            repo.range_stat(&base).unwrap(),
            repo.range_diff(&base).unwrap()
        );
        assert_eq!(runner.reqs.borrow()[0].prompt, expected);
    }

    #[test]
    fn a_pr_template_gets_its_variables() {
        let fx = fixture();
        commit_file(&fx.wt, "b.txt", "two lines");
        let repo = repo_of(&fx);
        let base = locate(&fx.data, &fx.wt).unwrap().base_ref;
        let recipe = Recipe {
            template: "{branch}->{baseBranch}|{commitSummary}|{changedFiles}|{patch}|{currentTitle}|{linkedIssue}"
                .to_owned(),
            ..Recipe::default()
        };
        let runner = FakeRunner::new(Ok("T"));
        draft_pr_with(&runner, &repo, &base, &recipe).unwrap();
        let prompt = runner.reqs.borrow()[0].prompt.clone();
        let branch = repo.current_branch().unwrap().unwrap();
        assert!(
            prompt.starts_with(&format!("{branch}->{base}|")),
            "{prompt}"
        );
        assert!(prompt.contains("b.txt"), "{prompt}");
        assert!(prompt.contains("+two lines"), "{prompt}");
        assert!(prompt.ends_with("||"), "{prompt}");
    }

    /// The args and the environment of one call.
    type EnvCall = (Vec<String>, Vec<(String, String)>);

    /// A `gh` that records the environment of each call.
    struct EnvGh {
        calls: RefCell<Vec<EnvCall>>,
        script: RefCell<Vec<GhOutput>>,
    }

    impl EnvGh {
        fn new(mut script: Vec<GhOutput>) -> EnvGh {
            script.reverse();
            EnvGh {
                calls: RefCell::default(),
                script: RefCell::new(script),
            }
        }
    }

    impl GhEnv for EnvGh {
        fn run_env(
            &self,
            _: &Path,
            args: &[&str],
            _: Option<&str>,
            env: &[(&str, &str)],
        ) -> Result<GhOutput, GitError> {
            self.calls.borrow_mut().push((
                args.iter().map(|a| a.to_string()).collect(),
                env.iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            ));
            Ok(self.script.borrow_mut().pop().expect("scripted gh call"))
        }
    }

    fn bound(user: &str) -> Option<GhAccount> {
        Some(GhAccount {
            host: "github.com".into(),
            user: user.into(),
        })
    }

    const NO_PR: &str = "no pull requests found for branch \"feat\"";

    #[test]
    fn locate_carries_the_repos_gh_binding() {
        let fx = fixture();
        assert_eq!(locate(&fx.data, &fx.wt).unwrap().gh_account, None);
        let mut reg = Registry::load(&fx.data).unwrap();
        reg.repos[0].gh_account = bound("u");
        reg.save(&fx.data).unwrap();
        // The worktree and the primary checkout both read the repo's binding.
        assert_eq!(locate(&fx.data, &fx.wt).unwrap().gh_account, bound("u"));
        assert_eq!(locate(&fx.data, &fx.main).unwrap().gh_account, bound("u"));
    }

    #[test]
    fn a_bound_call_gets_the_token_first_and_runs_with_it() {
        let inner = EnvGh::new(vec![gh_out(0, "gho_x\n", ""), gh_out(1, "", NO_PR)]);
        let view = run_gh(&inner, bound("u"), |gh| pr_with(gh, Path::new(".")));
        assert_eq!(view.unwrap(), None);
        let calls = inner.calls.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0].0,
            ["auth", "token", "--hostname", "github.com", "--user", "u"]
        );
        assert_eq!(&calls[1].0[..2], ["pr", "view"]);
        assert_eq!(calls[1].1, [("GH_TOKEN".to_owned(), "gho_x".to_owned())]);
    }

    #[test]
    fn a_call_bound_to_a_gone_login_is_not_run_as_another() {
        let inner = EnvGh::new(vec![gh_out(1, "", "no oauth token found")]);
        let res = run_gh(&inner, bound("u"), |gh| pr_with(gh, Path::new(".")));
        assert_eq!(code(res), "gh_account_missing");
        assert_eq!(inner.calls.borrow().len(), 1);
    }

    #[test]
    fn an_unbound_call_is_one_plain_call() {
        let inner = EnvGh::new(vec![gh_out(1, "", NO_PR)]);
        let view = run_gh(&inner, None, |gh| pr_with(gh, Path::new(".")));
        assert_eq!(view.unwrap(), None);
        let calls = inner.calls.borrow();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].1.is_empty(), "no token without a binding");
    }
}
