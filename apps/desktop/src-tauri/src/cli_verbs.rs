//! The verbs of the app endpoint, one function each, testable without a
//! socket; and the commands through which the UI feeds them.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use xdev_policy::{Action, Audited, Policy, Verdict};
use xdev_workspace::{
    COMMENT_MAX, CreateOptions, DetailsPatch, MadeBy, Registry, RepoView, WorkStatus, WorktreeView,
    create_worktree_linked, list, path_key, refresh_base, set_details, shared_to_link,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError, load_git_settings};
use crate::endpoint::{
    APP_PROTOCOL, AppError, Caller, Handler, Request, Scope, caller_worktree, scope_of,
};
use crate::pty::Ptys;
use crate::workspace::{WorkspaceLock, clock, update};

/// One terminal tab as the UI sees it; the UI owns the state machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TabReport {
    pub id: String,
    /// The worktree's path.
    pub worktree: String,
    pub title: Option<String>,
    pub profile: String,
    pub agent: bool,
    /// `working`, `needs-you`, `done` or `idle`.
    pub status: String,
    /// Epoch ms of the last output; 0 when there was none.
    pub last_output_ms: i64,
    pub exited: bool,
}

impl TabReport {
    /// What `terminal list` shows: the status, or `exited`.
    fn state(&self) -> &str {
        if self.exited { "exited" } else { &self.status }
    }
}

/// Payload of `cli://open-tab`: open `profile` (empty: the default agent)
/// in `worktree` without focusing it, then type `prompt` once it is ready.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CliOpenTab {
    pub worktree: String,
    pub profile: String,
    pub prompt: Option<String>,
}

/// Payload of `cli://ask`: a CLI write that needs the person; answered with
/// `cli_approve(request, allow)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CliAsk {
    pub request: u64,
    /// The caller's worktree path; null for a caller outside the app.
    pub caller: Option<String>,
    /// `worktree.create` or `worktree.set`.
    pub verb: String,
    /// The worktree path the write is for.
    pub target: String,
}

/// The most tabs a report may carry; the rest are dropped.
pub const TABS_MAX: usize = 500;

#[derive(Default)]
struct Board {
    tabs: Vec<TabReport>,
    selected: Option<String>,
    stopped: bool,
}

/// The UI's last tab report; `terminal wait` sleeps on it.
pub struct TabBoard {
    board: Mutex<Board>,
    changed: Condvar,
    clock: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl Default for TabBoard {
    fn default() -> TabBoard {
        TabBoard::with_clock(|| clock().0)
    }
}

impl TabBoard {
    /// `clock` gives epoch ms; tests pass a fake one.
    pub fn with_clock(clock: impl Fn() -> i64 + Send + Sync + 'static) -> TabBoard {
        TabBoard {
            board: Mutex::default(),
            changed: Condvar::new(),
            clock: Box::new(clock),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Board> {
        self.board.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Replaces the board and wakes every waiter.
    pub fn replace(&self, mut tabs: Vec<TabReport>, selected: Option<String>) {
        tabs.truncate(TABS_MAX);
        let mut board = self.lock();
        board.tabs = tabs;
        board.selected = selected;
        drop(board);
        self.changed.notify_all();
    }

    /// The app is quitting: every waiter ends with `app_stopped`.
    pub fn stop(&self) {
        self.lock().stopped = true;
        self.changed.notify_all();
    }

    fn tabs(&self) -> (Vec<TabReport>, Option<String>) {
        let board = self.lock();
        (board.tabs.clone(), board.selected.clone())
    }
}

/// How long a write waits for the person's answer.
pub const ASK_WAIT: Duration = Duration::from_secs(60);

/// The person's answers to CLI writes: the ones waiting, and the (caller
/// worktree, target) pairs allowed for the rest of the session.
#[derive(Default)]
pub struct Approvals {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<bool>>>,
    allowed: Mutex<HashSet<(String, String)>>,
}

impl Approvals {
    fn allowed(&self) -> MutexGuard<'_, HashSet<(String, String)>> {
        self.allowed.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn pending(&self) -> MutexGuard<'_, HashMap<u64, mpsc::Sender<bool>>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Sends `cli://ask` and waits up to `wait`; `None` without an answer.
    fn ask(&self, emit: &dyn Fn(&str, Value), ask: CliAsk, wait: Duration) -> Option<bool> {
        let (tx, rx) = mpsc::channel();
        let request = ask.request;
        self.pending().insert(request, tx);
        emit("cli://ask", json!(ask));
        let answer = rx.recv_timeout(wait).ok();
        self.pending().remove(&request);
        answer
    }

    fn next_request(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// An unknown or late request is ignored.
    pub fn answer(&self, request: u64, allow: bool) {
        if let Some(tx) = self.pending().remove(&request) {
            let _ = tx.send(allow);
        }
    }
}

/// What the endpoint shares with the UI's commands.
#[derive(Default)]
pub struct CliHub {
    pub board: TabBoard,
    pub approvals: Approvals,
}

/// The UI's tabs, replacing the last report; `selected` is the worktree in front.
#[tauri::command]
pub fn cli_tabs_report(hub: State<'_, CliHub>, tabs: Vec<TabReport>, selected: Option<String>) {
    hub.board.replace(tabs, selected);
}

/// The person's answer to a `cli://ask`.
#[tauri::command]
pub fn cli_approve(hub: State<'_, CliHub>, request: u64, allow: bool) {
    hub.approvals.answer(request, allow);
}

impl From<CmdError> for AppError {
    fn from(e: CmdError) -> AppError {
        AppError::new(e.code, e.detail.unwrap_or_default())
    }
}

fn bad_request(message: impl Into<String>) -> AppError {
    AppError::new("bad_request", message)
}

fn no_worktree() -> AppError {
    AppError::new(
        "no_worktree",
        "not called from an xDev terminal; pass --worktree",
    )
}

/// Everything a verb needs from the app, so tests can stand in for it.
pub struct Ctx<'a> {
    pub data: &'a Path,
    pub lock: &'a WorkspaceLock,
    pub board: &'a TabBoard,
    /// The folder a PTY started in.
    pub cwd_of: &'a dyn Fn(&str) -> Option<PathBuf>,
    pub emit: &'a dyn Fn(&str, Value),
    pub approvals: &'a Approvals,
    /// Settings → Git: how a new branch is named, and whether the base is
    /// fetched first.
    pub create: CreateOptions,
    pub refresh_base: bool,
    pub now_ms: i64,
    pub seed: u64,
    pub ask_wait: Duration,
}

/// One worktree as the verbs know it.
struct Listed {
    repo_id: String,
    repo: String,
    view: WorktreeView,
}

/// A worktree row of `worktree ps | current | set`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Row<'a> {
    id: String,
    path: &'a str,
    repo: &'a str,
    name: &'a str,
    title: Option<&'a str>,
    branch: Option<&'a str>,
    primary: bool,
    status: Option<WorkStatus>,
    comment: &'a str,
    /// The parent's id.
    parent: Option<String>,
    made_by: MadeBy,
    set_by_cli_ms: Option<i64>,
    /// The states of its agent tabs.
    agents: Vec<String>,
}

fn params<T: for<'de> Deserialize<'de>>(req: &Request) -> Result<T, AppError> {
    let value = if req.params.is_null() {
        json!({})
    } else {
        req.params.clone()
    };
    serde_json::from_value(value).map_err(|e| bad_request(e.to_string()))
}

impl Ctx<'_> {
    /// Every repo's worktrees, brought in line with git, as the sidebar does.
    fn listed(&self) -> Result<Vec<Listed>, AppError> {
        let repos: Vec<RepoView> = update(self.data, self.lock, list)?;
        Ok(repos
            .into_iter()
            .flat_map(|r| {
                let (id, short) = (r.id, r.short_name);
                r.worktrees.into_iter().map(move |view| Listed {
                    repo_id: id.clone(),
                    repo: short.clone(),
                    view,
                })
            })
            .collect())
    }

    fn registry(&self) -> Result<Registry, AppError> {
        Ok(Registry::load(self.data).map_err(CmdError::from)?)
    }

    /// The caller's worktree, from the folder its PTY started in.
    fn caller_worktree(&self, caller: &Caller) -> Result<Option<PathBuf>, AppError> {
        let Some(cwd) = caller.pty.as_deref().and_then(|p| (self.cwd_of)(p)) else {
            return Ok(None);
        };
        Ok(caller_worktree(&self.registry()?, &cwd))
    }

    fn row<'a>(&self, l: &'a Listed, tabs: &[TabReport]) -> Row<'a> {
        let v = &l.view;
        let id = path_key(Path::new(&v.path));
        let agents = tabs
            .iter()
            .filter(|t| t.agent && path_key(Path::new(&t.worktree)) == id)
            .map(|t| t.state().to_owned())
            .collect();
        Row {
            id,
            path: &v.path,
            repo: &l.repo,
            name: &v.name,
            title: v.title.as_deref(),
            branch: v.branch.as_deref(),
            primary: v.primary,
            status: v.status,
            comment: &v.comment,
            parent: v.parent.as_deref().map(|p| path_key(Path::new(p))),
            made_by: v.made_by,
            set_by_cli_ms: v.set_by_cli_ms,
            agents,
        }
    }
}

/// `text` as a worktree: its path or id, a name (or title) unique in the
/// caller's repo or else everywhere, or a unique prefix of an id.
fn resolve<'a>(all: &'a [Listed], text: &str, repo: Option<&str>) -> Result<&'a Listed, AppError> {
    let key_of = |l: &Listed| path_key(Path::new(&l.view.path));
    let wanted = path_key(Path::new(text));
    if let Some(l) = all.iter().find(|l| key_of(l) == wanted) {
        return Ok(l);
    }
    let named = |l: &&Listed| l.view.name == text || l.view.title.as_deref() == Some(text);
    let one = |found: Vec<&'a Listed>| match found.len() {
        0 => Ok(None),
        1 => Ok(Some(found[0])),
        _ => Err(AppError::new(
            "ambiguous",
            format!("more than one worktree is {text}"),
        )),
    };
    if let Some(repo) = repo
        && let Some(l) = one(all
            .iter()
            .filter(|l| l.repo_id == repo)
            .filter(named)
            .collect())?
    {
        return Ok(l);
    }
    if let Some(l) = one(all.iter().filter(named).collect())? {
        return Ok(l);
    }
    one(all
        .iter()
        .filter(|l| key_of(l).starts_with(&wanted))
        .collect())?
    .ok_or_else(|| AppError::new("not_found", format!("no worktree {text}")))
}

/// The worktree a verb is for: the one named, else the caller's own.
fn target<'a>(
    all: &'a [Listed],
    named: Option<&str>,
    caller: Option<&Path>,
) -> Result<&'a Listed, AppError> {
    let mine = caller.and_then(|c| {
        let key = path_key(c);
        all.iter()
            .find(|l| path_key(Path::new(&l.view.path)) == key)
    });
    match named {
        Some(text) => resolve(all, text, mine.map(|l| l.repo_id.as_str())),
        None => mine.ok_or_else(no_worktree),
    }
}

#[derive(Deserialize)]
struct PsParams {
    #[serde(default)]
    all: bool,
}

#[derive(Deserialize)]
struct ListParams {
    worktree: Option<String>,
}

/// `status`: the app, the worktree in front and the tabs by state.
pub fn status(ctx: &Ctx<'_>) -> Value {
    let (tabs, selected) = ctx.board.tabs();
    let count = |s: &str| tabs.iter().filter(|t| !t.exited && t.status == s).count();
    let idle = tabs
        .iter()
        .filter(|t| t.exited || t.status == "idle")
        .count();
    json!({
        "version": xdev_core::version(),
        "protocol": APP_PROTOCOL,
        "selected": selected,
        "tabs": {
            "working": count("working"),
            "needsYou": count("needs-you"),
            "done": count("done"),
            "idle": idle,
        },
    })
}

/// `worktree.ps`: the caller's repo, or every repo with `all` or no caller.
pub fn worktree_ps(ctx: &Ctx<'_>, req: &Request, caller: &Caller) -> Result<Value, AppError> {
    let p: PsParams = params(req)?;
    let all = ctx.listed()?;
    let me = ctx.caller_worktree(caller)?;
    let repo = match (&me, p.all) {
        (Some(me), false) => target(&all, None, Some(me)).ok().map(|l| l.repo_id.clone()),
        _ => None,
    };
    let (tabs, _) = ctx.board.tabs();
    let rows: Vec<Row<'_>> = all
        .iter()
        .filter(|l| repo.as_ref().is_none_or(|r| &l.repo_id == r))
        .map(|l| ctx.row(l, &tabs))
        .collect();
    Ok(json!(rows))
}

/// `worktree.current`: the caller's worktree, or `no_worktree`.
pub fn worktree_current(ctx: &Ctx<'_>, caller: &Caller) -> Result<Value, AppError> {
    let all = ctx.listed()?;
    let me = ctx.caller_worktree(caller)?;
    let l = target(&all, None, me.as_deref())?;
    Ok(json!(ctx.row(l, &ctx.board.tabs().0)))
}

/// `terminal.list`: the tabs of the named worktree or the caller's.
pub fn terminal_list(ctx: &Ctx<'_>, req: &Request, caller: &Caller) -> Result<Value, AppError> {
    let p: ListParams = params(req)?;
    let all = ctx.listed()?;
    let me = ctx.caller_worktree(caller)?;
    let l = target(&all, p.worktree.as_deref(), me.as_deref())?;
    let key = path_key(Path::new(&l.view.path));
    let tabs: Vec<Value> = ctx
        .board
        .tabs()
        .0
        .iter()
        .filter(|t| path_key(Path::new(&t.worktree)) == key)
        .map(|t| {
            json!({
                "id": t.id,
                "title": t.title,
                "kind": if t.agent { "agent" } else { "shell" },
                "profile": t.profile,
                "state": t.state(),
                "lastOutputMs": t.last_output_ms,
            })
        })
        .collect();
    Ok(json!(tabs))
}

impl Ctx<'_> {
    /// The policy gate for a write. `own`, and `family` for create and set,
    /// pass; anything else asks the person once per (caller, target) for
    /// the session. Every decision has an audit line.
    fn gate(
        &self,
        verb: &str,
        op: &str,
        caller: Option<&Path>,
        target: &Path,
        scope: Scope,
    ) -> Result<(), AppError> {
        let action = Action::CliWorktree {
            op: op.to_owned(),
            worktree: target.to_owned(),
            scope: scope.as_str().to_owned(),
        };
        let policy = Policy::load(self.data).map_err(|e| AppError::new(e.code(), e.to_string()))?;
        let gate = Audited::new(policy, self.data);
        let pair = (caller.map(path_key).unwrap_or_default(), path_key(target));
        let remembered = self.approvals.allowed().contains(&pair);
        let denied = |reason: String| AppError::new("denied", reason);
        match gate.check_confirmed(&action, remembered) {
            Verdict::Allow => return Ok(()),
            Verdict::Deny { reason } => return Err(denied(reason)),
            Verdict::Ask { .. } => {}
        }
        let ask = CliAsk {
            request: self.approvals.next_request(),
            caller: caller.map(|c| c.display().to_string()),
            verb: verb.to_owned(),
            target: target.display().to_string(),
        };
        match self.approvals.ask(self.emit, ask, self.ask_wait) {
            Some(true) => {
                self.approvals.allowed().insert(pair);
                match gate.check_confirmed(&action, true) {
                    Verdict::Allow => Ok(()),
                    Verdict::Deny { reason } | Verdict::Ask { reason } => Err(denied(reason)),
                }
            }
            Some(false) => {
                gate.refused(&action, "the person said no");
                Err(denied("the person said no".to_owned()))
            }
            None => {
                gate.refused(&action, "no answer in time");
                Err(AppError::new(
                    "needs_approval",
                    "no answer from the person in time",
                ))
            }
        }
    }

    /// Marks the worktree at `path` as changed by the CLI now.
    fn mark(&self, reg: &mut Registry, path: &Path) {
        let key = path_key(path);
        if let Some(m) = reg.worktrees.iter_mut().find(|m| path_key(&m.path) == key) {
            m.set_by_cli_ms = Some(self.now_ms);
        }
    }
}

#[derive(Deserialize)]
struct SetParams {
    worktree: Option<String>,
    status: Option<String>,
    comment: Option<String>,
    title: Option<String>,
}

/// `todo`, `in-progress`, `in-review`, `completed`; `none` clears.
fn work_status(text: &str) -> Result<Option<WorkStatus>, AppError> {
    if text == "none" {
        return Ok(None);
    }
    serde_json::from_value(json!(text)).map(Some).map_err(|_| {
        bad_request(format!(
            "status {text}: todo, in-progress, in-review, completed or none"
        ))
    })
}

/// `worktree.set`: status, comment and title of the named worktree or the
/// caller's. A write on the caller's parent asks like one on another worktree.
pub fn worktree_set(ctx: &Ctx<'_>, req: &Request, caller: &Caller) -> Result<Value, AppError> {
    let p: SetParams = params(req)?;
    if p.status.is_none() && p.comment.is_none() && p.title.is_none() {
        return Err(bad_request(
            "nothing to set: give --status, --comment or --title",
        ));
    }
    let status = p.status.as_deref().map(work_status).transpose()?;
    if p.comment
        .as_ref()
        .is_some_and(|c| c.chars().count() > COMMENT_MAX)
    {
        return Err(bad_request(format!(
            "a comment is at most {COMMENT_MAX} characters"
        )));
    }
    let all = ctx.listed()?;
    let me = ctx.caller_worktree(caller)?;
    let t = target(&all, p.worktree.as_deref(), me.as_deref())?;
    if t.view.primary {
        return Err(AppError::new(
            "primary_worktree",
            "the main checkout has no details",
        ));
    }
    let path = PathBuf::from(&t.view.path);
    let mut scope = scope_of(me.as_deref(), &path, &ctx.registry()?);
    // Family writes go down only: a child may not set its parent.
    let my_parent = me.as_deref().and_then(|me| {
        let key = path_key(me);
        all.iter()
            .find(|l| path_key(Path::new(&l.view.path)) == key)
            .and_then(|l| l.view.parent.clone())
    });
    if scope == Scope::Family
        && my_parent.is_some_and(|p| path_key(Path::new(&p)) == path_key(&path))
    {
        scope = Scope::Other;
    }
    ctx.gate("worktree.set", "set", me.as_deref(), &path, scope)?;
    let patch = DetailsPatch {
        title: p.title.map(Some),
        comment: p.comment,
        status,
        ..Default::default()
    };
    update(ctx.data, ctx.lock, |reg| {
        set_details(reg, &path, patch)?;
        ctx.mark(reg, &path);
        Ok(())
    })?;
    (ctx.emit)("workspace://changed", Value::Null);
    let all = ctx.listed()?;
    let l = target(&all, Some(&t.view.path), None)?;
    Ok(json!(ctx.row(l, &ctx.board.tabs().0)))
}

#[derive(Deserialize)]
struct CreateParams {
    name: Option<String>,
    from: Option<String>,
    parent: Option<String>,
    agent: Option<String>,
    prompt: Option<String>,
}

/// `worktree.create`: a new worktree of the parent's repo, recorded under
/// the parent (default: the caller's worktree; under a child it goes beside
/// it, one level only). An agent or prompt opens a tab through the UI.
pub fn worktree_create(ctx: &Ctx<'_>, req: &Request, caller: &Caller) -> Result<Value, AppError> {
    let p: CreateParams = params(req)?;
    let all = ctx.listed()?;
    let me = ctx.caller_worktree(caller)?;
    let holder = target(&all, p.parent.as_deref(), me.as_deref())?;
    let holder_path = PathBuf::from(&holder.view.path);
    let record_parent = (!holder.view.primary).then(|| {
        holder
            .view
            .parent
            .as_deref()
            .map_or_else(|| holder_path.clone(), PathBuf::from)
    });
    let reg = ctx.registry()?;
    let scope = scope_of(me.as_deref(), &holder_path, &reg);
    ctx.gate(
        "worktree.create",
        "create",
        me.as_deref(),
        &holder_path,
        scope,
    )?;
    let repo_id = holder.repo_id.clone();
    if ctx.refresh_base {
        // As the app's create: a failed fetch leaves the base as it was.
        let _ = refresh_base(&reg, &repo_id, p.from.as_deref());
    }
    let name = p.name.unwrap_or_default();
    let view = update(ctx.data, ctx.lock, |reg| {
        let opts = CreateOptions {
            made_by: MadeBy::Cli,
            shared: shared_to_link(reg, ctx.data, &repo_id),
            ..ctx.create.clone()
        };
        let (view, _) = create_worktree_linked(
            reg,
            &repo_id,
            &name,
            p.from.as_deref(),
            ctx.now_ms,
            ctx.seed,
            &opts,
        )?;
        let path = PathBuf::from(&view.path);
        if let Some(parent) = &record_parent {
            // Checked above to be a top-level worktree of this repo; a
            // refusal leaves the new one top-level rather than half made.
            let patch = DetailsPatch {
                parent: Some(Some(parent.clone())),
                ..Default::default()
            };
            let _ = set_details(reg, &path, patch);
        }
        ctx.mark(reg, &path);
        Ok(view)
    })?;
    (ctx.emit)("workspace://changed", Value::Null);
    if p.agent.is_some() || p.prompt.is_some() {
        let open = CliOpenTab {
            worktree: view.path.clone(),
            profile: p.agent.unwrap_or_default(),
            prompt: p.prompt,
        };
        (ctx.emit)("cli://open-tab", json!(open));
    }
    Ok(json!({
        "id": path_key(Path::new(&view.path)),
        "path": view.path,
        "branch": view.branch,
    }))
}

/// Runs one request.
pub fn dispatch(
    ctx: &Ctx<'_>,
    req: &Request,
    caller: &Caller,
    gone: &dyn Fn() -> bool,
) -> Result<Value, AppError> {
    let _ = gone;
    match req.method.as_str() {
        "status" => Ok(status(ctx)),
        "worktree.ps" => worktree_ps(ctx, req, caller),
        "worktree.current" => worktree_current(ctx, caller),
        "terminal.list" => terminal_list(ctx, req, caller),
        "worktree.set" => worktree_set(ctx, req, caller),
        "worktree.create" => worktree_create(ctx, req, caller),
        other => Err(bad_request(format!("unknown method {other}"))),
    }
}

/// The endpoint's handler in the running app: reads the app's state per call.
pub struct AppVerbs {
    pub app: AppHandle,
}

impl Handler for AppVerbs {
    fn handle(
        &self,
        req: &Request,
        caller: &Caller,
        gone: &dyn Fn() -> bool,
    ) -> Result<Value, AppError> {
        let app = &self.app;
        let state = app.state::<AppState>();
        let data = data_dir(&state)?;
        let lock = app.state::<WorkspaceLock>();
        let hub = app.state::<CliHub>();
        let ptys = app.state::<Ptys>();
        let cwd_of = |id: &str| ptys.cwd_of(id);
        let emit = |event: &str, payload: Value| {
            let _ = app.emit(event, payload);
        };
        let git = load_git_settings(app);
        let (now_ms, seed) = clock();
        let ctx = Ctx {
            data,
            lock: &lock,
            board: &hub.board,
            cwd_of: &cwd_of,
            emit: &emit,
            approvals: &hub.approvals,
            create: git.create_options(),
            refresh_base: git.refresh_local_base_on_create,
            now_ms,
            seed,
            ask_wait: ASK_WAIT,
        };
        dispatch(&ctx, req, caller, gone)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::process::Command;

    use tempfile::TempDir;
    use xdev_workspace::{DetailsPatch, add_repo, create_worktree, set_details};

    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    /// A repo with a lead worktree, a child of it and another; a PTY per
    /// worktree, named after it.
    pub(crate) struct Fixture {
        _tmp: TempDir,
        pub data: PathBuf,
        pub main: PathBuf,
        pub lead: PathBuf,
        pub child: PathBuf,
        pub other: PathBuf,
        pub lock: WorkspaceLock,
        pub board: TabBoard,
        pub events: Mutex<Vec<(String, Value)>>,
        pub approvals: Approvals,
        /// The fake person: answers every ask with this, or never.
        pub answer: Option<bool>,
    }

    pub(crate) fn fixture() -> Fixture {
        let tmp = crate::test_dirs::long_temp_dir("cli verbs ");
        let main = tmp.path().join("main");
        let data = tmp.path().join("data");
        fs::create_dir(&main).unwrap();
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
        let mut reg = Registry::load(&data).unwrap();
        let id = add_repo(&mut reg, &main, 0).unwrap().id;
        let lead = PathBuf::from(
            create_worktree(&mut reg, &id, "lead", None, 1, 1)
                .unwrap()
                .path,
        );
        let child = PathBuf::from(
            create_worktree(&mut reg, &id, "child", None, 2, 2)
                .unwrap()
                .path,
        );
        let other = PathBuf::from(
            create_worktree(&mut reg, &id, "other", None, 3, 3)
                .unwrap()
                .path,
        );
        let patch = DetailsPatch {
            parent: Some(Some(lead.clone())),
            ..Default::default()
        };
        set_details(&mut reg, &child, patch).unwrap();
        reg.save(&data).unwrap();
        Fixture {
            _tmp: tmp,
            data,
            main,
            lead,
            child,
            other,
            lock: WorkspaceLock::default(),
            board: TabBoard::default(),
            events: Mutex::default(),
            approvals: Approvals::default(),
            answer: None,
        }
    }

    impl Fixture {
        pub(crate) fn ptys(&self) -> HashMap<String, PathBuf> {
            HashMap::from([
                ("p-lead".to_owned(), self.lead.join("src")),
                ("p-child".to_owned(), self.child.clone()),
                ("p-other".to_owned(), self.other.clone()),
            ])
        }

        /// Runs `method` as the PTY `pty` (none: from outside).
        pub(crate) fn call(
            &self,
            pty: Option<&str>,
            method: &str,
            params: Value,
        ) -> Result<Value, AppError> {
            let ptys = self.ptys();
            let cwd_of = |id: &str| ptys.get(id).cloned();
            let emit = |event: &str, payload: Value| {
                if event == "cli://ask"
                    && let Some(allow) = self.answer
                {
                    self.approvals
                        .answer(payload["request"].as_u64().unwrap(), allow);
                }
                self.events
                    .lock()
                    .unwrap()
                    .push((event.to_owned(), payload));
            };
            let ctx = Ctx {
                data: &self.data,
                lock: &self.lock,
                board: &self.board,
                cwd_of: &cwd_of,
                emit: &emit,
                approvals: &self.approvals,
                create: CreateOptions::default(),
                refresh_base: false,
                now_ms: 777,
                seed: 9,
                ask_wait: Duration::from_millis(50),
            };
            let req = Request {
                id: 1,
                method: method.to_owned(),
                params,
                caller: None,
            };
            let caller = Caller {
                pty: pty.map(str::to_owned),
            };
            dispatch(&ctx, &req, &caller, &|| false)
        }
    }

    pub(crate) fn tab(id: &str, worktree: &Path, agent: bool, status: &str) -> TabReport {
        TabReport {
            id: id.to_owned(),
            worktree: worktree.display().to_string(),
            title: None,
            profile: if agent { "claude" } else { "shell" }.to_owned(),
            agent,
            status: status.to_owned(),
            last_output_ms: 0,
            exited: false,
        }
    }

    fn key(p: &Path) -> String {
        path_key(p)
    }

    #[test]
    fn status_counts_tabs_and_names_the_selected_worktree() {
        let f = fixture();
        let mut exited = tab("t4", &f.lead, true, "working");
        exited.exited = true;
        f.board.replace(
            vec![
                tab("t1", &f.lead, true, "working"),
                tab("t2", &f.lead, true, "needs-you"),
                tab("t3", &f.child, false, "idle"),
                exited,
            ],
            Some(f.lead.display().to_string()),
        );
        let s = f.call(None, "status", Value::Null).unwrap();
        assert_eq!(s["protocol"], APP_PROTOCOL);
        assert_eq!(s["version"], xdev_core::version());
        assert_eq!(s["selected"], f.lead.display().to_string());
        assert_eq!(
            s["tabs"],
            json!({ "working": 1, "needsYou": 1, "done": 0, "idle": 2 })
        );
    }

    #[test]
    fn ps_lists_the_callers_repo_with_parents_and_agent_states() {
        let f = fixture();
        f.board.replace(
            vec![
                tab("t1", &f.child, true, "done"),
                tab("t2", &f.child, false, "idle"),
            ],
            None,
        );
        let rows = f.call(Some("p-lead"), "worktree.ps", json!({})).unwrap();
        let rows = rows.as_array().unwrap();
        // The primary checkout and the three worktrees.
        assert_eq!(rows.len(), 4);
        let child = rows.iter().find(|r| r["id"] == key(&f.child)).unwrap();
        assert_eq!(child["parent"], key(&f.lead));
        assert_eq!(child["agents"], json!(["done"]));
        assert_eq!(child["name"], "child");
        assert_eq!(child["madeBy"], "app");
        assert!(
            rows.iter()
                .any(|r| r["primary"] == true && r["id"] == key(&f.main))
        );
        // From outside, every repo.
        assert_eq!(
            f.call(None, "worktree.ps", json!({ "all": true }))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn current_is_the_worktree_the_pty_started_in() {
        let f = fixture();
        // The lead PTY started in a subfolder of its worktree.
        let row = f
            .call(Some("p-lead"), "worktree.current", Value::Null)
            .unwrap();
        assert_eq!(row["id"], key(&f.lead));
        let e = f.call(None, "worktree.current", Value::Null).unwrap_err();
        assert_eq!(e.code, "no_worktree");
        let e = f
            .call(Some("p-unknown"), "worktree.current", Value::Null)
            .unwrap_err();
        assert_eq!(e.code, "no_worktree");
    }

    #[test]
    fn terminal_list_takes_a_name_id_prefix_or_the_callers_worktree() {
        let f = fixture();
        let mut t1 = tab("t1", &f.other, true, "working");
        t1.title = Some("fix".into());
        t1.last_output_ms = 9;
        f.board
            .replace(vec![t1, tab("t2", &f.lead, false, "idle")], None);
        let by_name = f
            .call(None, "terminal.list", json!({ "worktree": "other" }))
            .unwrap();
        assert_eq!(
            by_name,
            json!([{ "id": "t1", "title": "fix", "kind": "agent", "profile": "claude", "state": "working", "lastOutputMs": 9 }])
        );
        let by_path = f
            .call(
                None,
                "terminal.list",
                json!({ "worktree": f.other.display().to_string() }),
            )
            .unwrap();
        assert_eq!(by_path, by_name);
        let mine = f
            .call(Some("p-lead"), "terminal.list", Value::Null)
            .unwrap();
        assert_eq!(mine[0]["id"], "t2");
        assert_eq!(mine[0]["kind"], "shell");
        let e = f.call(None, "terminal.list", Value::Null).unwrap_err();
        assert_eq!(e.code, "no_worktree");
        let e = f
            .call(None, "terminal.list", json!({ "worktree": "nope" }))
            .unwrap_err();
        assert_eq!(e.code, "not_found");
    }

    #[test]
    fn a_shared_prefix_is_ambiguous_and_an_unknown_method_bad_request() {
        let f = fixture();
        // Every worktree folder starts with the root folder.
        let root = key(f.lead.parent().unwrap());
        let e = f
            .call(
                None,
                "terminal.list",
                json!({ "worktree": format!("{root}/") }),
            )
            .unwrap_err();
        assert_eq!(e.code, "ambiguous");
        assert_eq!(
            f.call(None, "nope", Value::Null).unwrap_err().code,
            "bad_request"
        );
        assert_eq!(
            f.call(None, "worktree.ps", json!({ "all": "x" }))
                .unwrap_err()
                .code,
            "bad_request"
        );
    }

    fn asks(f: &Fixture) -> Vec<Value> {
        let events = f.events.lock().unwrap();
        events
            .iter()
            .filter(|(e, _)| e == "cli://ask")
            .map(|(_, p)| p.clone())
            .collect()
    }

    fn audit(f: &Fixture) -> Vec<(String, String)> {
        xdev_policy::read_audit(&f.data)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|e| match e.action {
                Action::CliWorktree { scope, .. } => Some((
                    scope,
                    serde_json::to_value(&e.verdict).unwrap()["verdict"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                )),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn set_on_its_own_worktree_needs_no_one_and_marks_it() {
        let f = fixture();
        let row = f
            .call(
                Some("p-lead"),
                "worktree.set",
                json!({ "status": "in-review", "comment": "ready", "title": "Lead" }),
            )
            .unwrap();
        assert_eq!(row["status"], "in-review");
        assert_eq!(row["comment"], "ready");
        assert_eq!(row["title"], "Lead");
        assert_eq!(row["setByCliMs"], 777);
        assert!(asks(&f).is_empty());
        assert_eq!(audit(&f), [("own".to_owned(), "allow".to_owned())]);
        assert!(
            f.events
                .lock()
                .unwrap()
                .iter()
                .any(|(e, _)| e == "workspace://changed")
        );
        let row = f
            .call(Some("p-lead"), "worktree.set", json!({ "status": "none" }))
            .unwrap();
        assert_eq!(row["status"], Value::Null);
    }

    #[test]
    fn set_checks_its_input_before_anything_runs() {
        let f = fixture();
        let code = |params: Value| {
            f.call(Some("p-lead"), "worktree.set", params)
                .unwrap_err()
                .code
        };
        assert_eq!(code(json!({})), "bad_request");
        assert_eq!(code(json!({ "status": "later" })), "bad_request");
        assert_eq!(
            code(json!({ "comment": "x".repeat(COMMENT_MAX + 1) })),
            "bad_request"
        );
        assert_eq!(
            code(json!({ "worktree": "main", "title": "x" })),
            "primary_worktree"
        );
        assert!(xdev_policy::read_audit(&f.data).is_err());
    }

    #[test]
    fn the_parent_may_set_its_child_but_the_child_must_ask_for_its_parent() {
        let mut f = fixture();
        f.call(
            Some("p-lead"),
            "worktree.set",
            json!({ "worktree": "child", "status": "todo" }),
        )
        .unwrap();
        assert!(asks(&f).is_empty());
        // Nobody answers: not approved.
        let e = f
            .call(
                Some("p-child"),
                "worktree.set",
                json!({ "worktree": "lead", "status": "todo" }),
            )
            .unwrap_err();
        assert_eq!(e.code, "needs_approval");
        let ask = &asks(&f)[0];
        assert_eq!(ask["verb"], "worktree.set");
        assert_eq!(ask["caller"], f.child.display().to_string());
        assert_eq!(ask["target"], f.lead.display().to_string());
        f.answer = Some(false);
        let e = f
            .call(
                Some("p-child"),
                "worktree.set",
                json!({ "worktree": "lead", "status": "todo" }),
            )
            .unwrap_err();
        assert_eq!(e.code, "denied");
        assert_eq!(
            audit(&f),
            [
                ("family", "allow"),
                ("other", "ask"),
                ("other", "deny"),
                ("other", "ask"),
                ("other", "deny")
            ]
            .map(|(a, b)| (a.to_owned(), b.to_owned()))
        );
    }

    #[test]
    fn an_allowed_pair_is_remembered_for_the_session() {
        let mut f = fixture();
        f.answer = Some(true);
        f.call(
            Some("p-other"),
            "worktree.set",
            json!({ "worktree": "lead", "comment": "a" }),
        )
        .unwrap();
        f.answer = None;
        f.call(
            Some("p-other"),
            "worktree.set",
            json!({ "worktree": "lead", "comment": "b" }),
        )
        .unwrap();
        assert_eq!(asks(&f).len(), 1);
        // Another target asks again; an outside caller is its own pair.
        assert_eq!(
            f.call(
                Some("p-other"),
                "worktree.set",
                json!({ "worktree": "child", "comment": "c" })
            )
            .unwrap_err()
            .code,
            "needs_approval"
        );
        assert_eq!(
            f.call(
                None,
                "worktree.set",
                json!({ "worktree": "lead", "comment": "d" })
            )
            .unwrap_err()
            .code,
            "needs_approval"
        );
        assert_eq!(asks(&f)[2]["caller"], Value::Null);
    }

    #[test]
    fn create_makes_a_child_of_the_caller_by_cli_and_asks_the_ui_for_a_tab() {
        let f = fixture();
        let made = f
            .call(
                Some("p-lead"),
                "worktree.create",
                json!({ "name": "sub", "agent": "claude", "prompt": "say hi" }),
            )
            .unwrap();
        assert_eq!(made["branch"], "sub");
        assert!(asks(&f).is_empty());
        let rows = f.call(Some("p-lead"), "worktree.ps", json!({})).unwrap();
        let row = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == made["id"])
            .unwrap()
            .clone();
        assert_eq!(row["parent"], key(&f.lead));
        assert_eq!(row["madeBy"], "cli");
        assert_eq!(row["setByCliMs"], 777);
        let events = f.events.lock().unwrap();
        let open = events.iter().find(|(e, _)| e == "cli://open-tab").unwrap();
        assert_eq!(
            open.1,
            json!({ "worktree": made["path"], "profile": "claude", "prompt": "say hi" })
        );
    }

    #[test]
    fn create_under_a_child_goes_beside_it_and_elsewhere_asks() {
        let mut f = fixture();
        let made = f
            .call(Some("p-child"), "worktree.create", json!({ "name": "sib" }))
            .unwrap();
        let rows = f.call(None, "worktree.ps", json!({})).unwrap();
        let row = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == made["id"])
            .unwrap()
            .clone();
        assert_eq!(row["parent"], key(&f.lead));
        assert!(
            !f.events
                .lock()
                .unwrap()
                .iter()
                .any(|(e, _)| e == "cli://open-tab")
        );
        // Under another worktree, or from outside: the person is asked.
        assert_eq!(
            f.call(
                Some("p-child"),
                "worktree.create",
                json!({ "parent": "other" })
            )
            .unwrap_err()
            .code,
            "needs_approval"
        );
        assert_eq!(
            f.call(None, "worktree.create", Value::Null)
                .unwrap_err()
                .code,
            "no_worktree"
        );
        f.answer = Some(true);
        let top = f
            .call(
                None,
                "worktree.create",
                json!({ "parent": "main", "name": "top" }),
            )
            .unwrap();
        let rows = f.call(None, "worktree.ps", json!({})).unwrap();
        let row = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == top["id"])
            .unwrap()
            .clone();
        assert_eq!(row["parent"], Value::Null);
    }

    #[test]
    fn an_answer_reaches_only_a_waiting_request() {
        let a = Approvals::default();
        a.answer(5, true);
        let ask = CliAsk {
            request: 1,
            caller: None,
            verb: "worktree.set".into(),
            target: "/w".into(),
        };
        assert_eq!(
            a.ask(&|_, _| {}, ask.clone(), Duration::from_millis(20)),
            None
        );
        let got = a.ask(
            &|_, p| a.answer(p["request"].as_u64().unwrap(), true),
            ask,
            Duration::from_secs(5),
        );
        assert_eq!(got, Some(true));
    }

    #[test]
    fn a_report_is_capped() {
        let board = TabBoard::default();
        let tabs = (0..TABS_MAX + 5)
            .map(|i| tab(&i.to_string(), Path::new("/w"), false, "idle"))
            .collect();
        board.replace(tabs, None);
        assert_eq!(board.tabs().0.len(), TABS_MAX);
    }
}
