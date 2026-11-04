//! The verbs of the app endpoint, one function each, testable without a
//! socket; and the commands through which the UI feeds them.

use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use xdev_workspace::{MadeBy, Registry, RepoView, WorkStatus, WorktreeView, list, path_key};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};
use crate::endpoint::{APP_PROTOCOL, AppError, Caller, Handler, Request, caller_worktree};
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

/// What the endpoint shares with the UI's commands.
#[derive(Default)]
pub struct CliHub {
    pub board: TabBoard,
}

/// The UI's tabs, replacing the last report; `selected` is the worktree in front.
#[tauri::command]
pub fn cli_tabs_report(hub: State<'_, CliHub>, tabs: Vec<TabReport>, selected: Option<String>) {
    hub.board.replace(tabs, selected);
}

/// The person's answer to a `cli://ask`.
#[tauri::command]
pub fn cli_approve(hub: State<'_, CliHub>, request: u64, allow: bool) {
    let _ = (hub, request, allow);
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
        let ctx = Ctx {
            data,
            lock: &lock,
            board: &hub.board,
            cwd_of: &cwd_of,
            emit: &emit,
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
                self.events
                    .lock()
                    .unwrap()
                    .push((event.to_owned(), payload))
            };
            let ctx = Ctx {
                data: &self.data,
                lock: &self.lock,
                board: &self.board,
                cwd_of: &cwd_of,
                emit: &emit,
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
