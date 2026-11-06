//! `terminal.create | split | stop | close` and `agent.launch`: the CLI
//! opening, splitting, stopping and closing tabs. The window owns the tabs,
//! so all but `stop` go to it as an event (`cli://terminal`, or for an agent
//! the `cli://open-tab` of `worktree create --agent`); an open then waits for
//! the new tab on the board, a close for it to go.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use xdev_workspace::path_key;

use crate::cli_file::fold;
use crate::cli_terminal::SEND_MAX_BYTES;
use crate::cli_verbs::{CliOpenTab, Ctx, TabReport, bad_request, downward, params, target};
use crate::endpoint::{AppError, Caller, Request, caller_worktree, scope_of};

/// Emitted for the window to act on a tab.
pub const TERMINAL_EVENT: &str = "cli://terminal";
/// The longest tab or pane title.
pub const TITLE_MAX_CHARS: usize = 200;

/// What the window does with a `cli://terminal` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum TerminalOp {
    /// A new shell tab in the worktree's focused pane, active there.
    Create,
    /// A new shell tab in a new pane beside the source tab's.
    Split,
    Close,
}

/// Where a split puts the new pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum SplitDir {
    Right,
    Down,
}

/// The payload of `TERMINAL_EVENT`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CliTerminal {
    pub op: TerminalOp,
    /// The tab: the new one of a create or split, else the one acted on.
    pub id: String,
    pub worktree: String,
    /// split: the tab whose pane is split.
    pub source: Option<String>,
    /// split: where the new pane goes.
    pub dir: Option<SplitDir>,
    /// create and split: the folder the shell starts in, relative to
    /// `worktree` with `/` separators; none for the worktree itself.
    pub cwd: Option<String>,
    /// create: typed into the shell once it runs, then Enter.
    pub cmd: Option<String>,
    /// create: the tab's name.
    pub title: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    /// Id, unique prefix, name or path; default the caller's worktree.
    worktree: Option<String>,
    cmd: Option<String>,
    title: Option<String>,
    /// Absolute, or relative to `here`.
    cwd: Option<String>,
    /// The CLI's own folder.
    here: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitParams {
    /// Default: the caller's own tab.
    tab: Option<String>,
    dir: SplitDir,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabParams {
    /// Default: the caller's own tab.
    tab: Option<String>,
}

/// `dir` relative to `worktree` with `/` separators, none for the worktree
/// itself; `outside_worktree` when a `..` or the path leaves it.
pub(crate) fn inside(worktree: &Path, dir: &Path) -> Result<Option<String>, AppError> {
    let outside = || {
        AppError::new(
            "outside_worktree",
            format!("{} is not inside {}", dir.display(), worktree.display()),
        )
    };
    let key = path_key(&fold(dir).ok_or_else(outside)?);
    let root = path_key(worktree);
    if key == root {
        return Ok(None);
    }
    key.strip_prefix(&format!("{root}/"))
        .map(|rel| Some(rel.to_owned()))
        .ok_or_else(outside)
}

/// The worktree a new tab goes to: `named`, else the caller's terminal's,
/// else the one holding `here` (the CLI's folder).
fn worktree_for(
    ctx: &Ctx<'_>,
    caller: &Caller,
    named: Option<&str>,
    here: Option<&Path>,
) -> Result<PathBuf, AppError> {
    let me = match ctx.caller_worktree(caller)? {
        Some(me) => Some(me),
        None => here.and_then(|d| caller_worktree(&ctx.registry().ok()?, d)),
    };
    let all = ctx.listed()?;
    Ok(PathBuf::from(
        &target(&all, named, me.as_deref())?.view.path,
    ))
}

/// Waits for the tab `id` to be on the board.
fn wait_open(ctx: &Ctx<'_>, id: &str, gone: &dyn Fn() -> bool) -> Result<(), AppError> {
    ctx.board.wait_until(
        ctx.orch.waits.open_slack,
        gone,
        &format!("tab {id} did not open in time"),
        |tabs| tabs.iter().any(|t| t.id == id).then_some(()),
    )
}

/// A title the window takes: trimmed, one line, at most `TITLE_MAX_CHARS`.
fn clean_title(title: &str) -> Result<String, AppError> {
    let t = title.trim();
    if t.chars().any(char::is_control) {
        return Err(bad_request("a title is one line of text"));
    }
    if t.chars().count() > TITLE_MAX_CHARS {
        return Err(bad_request(format!(
            "a title is at most {TITLE_MAX_CHARS} characters"
        )));
    }
    Ok(t.to_owned())
}

/// The tab `named`, or the caller's own.
fn tab_of(ctx: &Ctx<'_>, named: Option<&str>, caller: &Caller) -> Result<TabReport, AppError> {
    match (named, &caller.pty) {
        (Some(tab), _) => ctx.board.resolve(tab),
        (None, Some(pty)) => ctx.board.resolve(pty),
        (None, None) => Err(AppError::new(
            "no_terminal",
            "not called from an xDev terminal; pass --terminal",
        )),
    }
}

/// Asks the policy whether the caller may `op` in `worktree`, as `terminal
/// send` does: its own worktree passes, the rest by rule or by the person.
fn gate(
    ctx: &Ctx<'_>,
    caller: &Caller,
    verb: &str,
    op: &str,
    worktree: &Path,
) -> Result<(), AppError> {
    let all = ctx.listed()?;
    let me = ctx.caller_worktree(caller)?;
    let scope = downward(
        scope_of(me.as_deref(), worktree, &ctx.registry()?),
        &all,
        me.as_deref(),
        worktree,
    );
    ctx.gate(verb, op, me.as_deref(), worktree, scope)
}

/// Sends `ev` and waits for its tab to be on the board.
fn open(ctx: &Ctx<'_>, ev: &CliTerminal, gone: &dyn Fn() -> bool) -> Result<Value, AppError> {
    (ctx.emit)(TERMINAL_EVENT, json!(ev));
    wait_open(ctx, &ev.id, gone)?;
    Ok(json!({
        "id": ev.id,
        "worktree": ev.worktree,
        "cwd": ev.cwd,
        "title": ev.title,
    }))
}

/// `terminal.create`: a new shell tab in a worktree (default: the caller's),
/// in a folder inside it, with a name and a first command.
pub(crate) fn terminal_create(
    ctx: &Ctx<'_>,
    req: &Request,
    caller: &Caller,
    gone: &dyn Fn() -> bool,
) -> Result<Value, AppError> {
    let p: CreateParams = params(req)?;
    if p.cmd.as_ref().is_some_and(|c| c.len() > SEND_MAX_BYTES) {
        return Err(bad_request(format!(
            "--cmd is at most {SEND_MAX_BYTES} bytes"
        )));
    }
    if p.cmd.as_ref().is_some_and(|c| c.contains(['\r', '\n'])) {
        return Err(bad_request("--cmd is one line"));
    }
    let title = p.title.as_deref().map(clean_title).transpose()?;
    let here = p.here.as_deref().map(PathBuf::from);
    let worktree = worktree_for(ctx, caller, p.worktree.as_deref(), here.as_deref())?;
    let cwd = match p.cwd.as_deref().map(Path::new) {
        None => None,
        Some(dir) => {
            let full = match (dir.is_absolute(), &here) {
                (true, _) => dir.to_owned(),
                (false, Some(here)) => here.join(dir),
                (false, None) => worktree.join(dir),
            };
            let rel = inside(&worktree, &full)?;
            if !full.is_dir() {
                return Err(bad_request(format!("{} is not a folder", full.display())));
            }
            rel
        }
    };
    gate(ctx, caller, "terminal.create", "create", &worktree)?;
    let ev = CliTerminal {
        op: TerminalOp::Create,
        id: uuid::Uuid::new_v4().to_string(),
        worktree: worktree.display().to_string(),
        source: None,
        dir: None,
        cwd,
        cmd: p.cmd.filter(|c| !c.trim().is_empty()),
        title: title.filter(|t| !t.is_empty()),
    };
    open(ctx, &ev, gone)
}

/// `terminal.split`: a new shell tab in a new pane beside the tab's (default:
/// the caller's), in the folder the tab's shell is in when that is inside
/// the worktree.
pub(crate) fn terminal_split(
    ctx: &Ctx<'_>,
    req: &Request,
    caller: &Caller,
    gone: &dyn Fn() -> bool,
) -> Result<Value, AppError> {
    let p: SplitParams = params(req)?;
    let t = tab_of(ctx, p.tab.as_deref(), caller)?;
    let worktree = PathBuf::from(&t.worktree);
    let cwd = (ctx.cwd_of)(&t.id).and_then(|dir| inside(&worktree, &dir).ok().flatten());
    gate(ctx, caller, "terminal.split", "create", &worktree)?;
    let ev = CliTerminal {
        op: TerminalOp::Split,
        id: uuid::Uuid::new_v4().to_string(),
        worktree: t.worktree.clone(),
        source: Some(t.id.clone()),
        dir: Some(p.dir),
        cwd,
        cmd: None,
        title: None,
    };
    open(ctx, &ev, gone)
}

/// `terminal.stop`: ends the tab's process; the tab stays, exited.
pub(crate) fn terminal_stop(
    ctx: &Ctx<'_>,
    req: &Request,
    caller: &Caller,
) -> Result<Value, AppError> {
    let p: TabParams = params(req)?;
    let t = tab_of(ctx, p.tab.as_deref(), caller)?;
    let closed = || AppError::new("closed", format!("tab {} has exited", t.id));
    if t.exited {
        return Err(closed());
    }
    gate(ctx, caller, "terminal.stop", "send", Path::new(&t.worktree))?;
    if !(ctx.kill_pty)(&t.id) {
        return Err(closed());
    }
    Ok(json!({ "id": t.id, "stopped": true }))
}

/// `terminal.close`: closes the tab, ending its process, and waits for it to
/// leave the board.
pub(crate) fn terminal_close(
    ctx: &Ctx<'_>,
    req: &Request,
    caller: &Caller,
    gone: &dyn Fn() -> bool,
) -> Result<Value, AppError> {
    let p: TabParams = params(req)?;
    let t = tab_of(ctx, p.tab.as_deref(), caller)?;
    gate(
        ctx,
        caller,
        "terminal.close",
        "close",
        Path::new(&t.worktree),
    )?;
    let ev = CliTerminal {
        op: TerminalOp::Close,
        id: t.id.clone(),
        worktree: t.worktree.clone(),
        source: None,
        dir: None,
        cwd: None,
        cmd: None,
        title: None,
    };
    (ctx.emit)(TERMINAL_EVENT, json!(ev));
    let id = t.id.clone();
    ctx.board.wait_until(
        ctx.orch.waits.stop,
        gone,
        &format!("tab {id} did not close in time"),
        |tabs| (!tabs.iter().any(|t| t.id == id)).then_some(()),
    )?;
    Ok(json!({ "id": t.id, "closed": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchParams {
    /// A profile id: a catalogue agent or one of the person's own.
    cli: String,
    worktree: Option<String>,
    account: Option<String>,
    prompt: Option<String>,
    here: Option<String>,
}

/// `agent.launch`: an agent tab in an existing worktree (default: the
/// caller's), opened the way `worktree create --agent` opens one, on an
/// account and with a first prompt when given.
pub(crate) fn agent_launch(
    ctx: &Ctx<'_>,
    req: &Request,
    caller: &Caller,
    gone: &dyn Fn() -> bool,
) -> Result<Value, AppError> {
    let p: LaunchParams = params(req)?;
    let profiles =
        xdev_agent::Profiles::load(ctx.data).map_err(|e| AppError::new("io", e.to_string()))?;
    match profiles.get(&p.cli) {
        None => {
            return Err(AppError::new(
                "unknown_agent",
                format!("no agent {}", p.cli),
            ));
        }
        Some(found) if !found.enabled => {
            return Err(bad_request(format!("agent {} is turned off", p.cli)));
        }
        Some(_) => {}
    }
    let account = p
        .account
        .map(|a| a.trim().to_owned())
        .filter(|a| !a.is_empty());
    if account
        .as_ref()
        .is_some_and(|a| a.chars().any(char::is_control))
    {
        return Err(bad_request("an account is one name"));
    }
    if p.prompt.as_ref().is_some_and(|t| t.len() > SEND_MAX_BYTES) {
        return Err(bad_request(format!(
            "a prompt is at most {SEND_MAX_BYTES} bytes"
        )));
    }
    let here = p.here.as_deref().map(PathBuf::from);
    let worktree = worktree_for(ctx, caller, p.worktree.as_deref(), here.as_deref())?;
    gate(ctx, caller, "agent.launch", "create", &worktree)?;
    let id = uuid::Uuid::new_v4().to_string();
    let open = CliOpenTab {
        worktree: worktree.display().to_string(),
        profile: p.cli.clone(),
        prompt: p.prompt.filter(|t| !t.trim().is_empty()),
        id: Some(id.clone()),
        account: account.clone(),
    };
    (ctx.emit)("cli://open-tab", json!(open));
    wait_open(ctx, &id, gone)?;
    Ok(json!({
        "id": id,
        "worktree": open.worktree,
        "profile": p.cli,
        "account": account,
    }))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use serde_json::{Value, json};

    use super::*;
    use crate::cli_verbs::tests::{Fixture, fixture, tab};

    fn sent(f: &Fixture) -> Vec<Value> {
        f.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == TERMINAL_EVENT)
            .map(|(_, p)| p.clone())
            .collect()
    }

    fn asked(f: &Fixture) -> usize {
        f.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == "cli://ask")
            .count()
    }

    #[test]
    fn inside_gives_the_folder_relative_to_the_worktree() {
        let w = Path::new("/w/one");
        assert_eq!(inside(w, Path::new("/w/one")).unwrap(), None);
        assert_eq!(
            inside(w, Path::new("/w/one/src/lib")).unwrap().as_deref(),
            Some("src/lib")
        );
        assert_eq!(
            inside(w, Path::new("/w/one/src/../docs"))
                .unwrap()
                .as_deref(),
            Some("docs")
        );
        for out in ["/w/one/..", "/w/other", "/w/one-two", "/w/one/../two/x"] {
            let e = inside(w, Path::new(out)).unwrap_err();
            assert_eq!(e.code, "outside_worktree", "{out}");
        }
    }

    #[test]
    fn create_opens_a_shell_in_the_callers_worktree_and_returns_its_id() {
        let f = fixture();
        let r = f
            .call(Some("p-lead"), "terminal.create", json!({}))
            .unwrap();
        let ev = sent(&f);
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0]["op"], "create");
        assert_eq!(ev[0]["worktree"], f.lead.display().to_string());
        assert_eq!(ev[0]["cwd"], Value::Null);
        assert_eq!(r["id"], ev[0]["id"]);
        assert_eq!(r["worktree"], f.lead.display().to_string());
        let id = r["id"].as_str().unwrap();
        assert!(f.board.resolve(id).is_ok());
        assert_eq!(asked(&f), 0);
    }

    #[test]
    fn create_takes_a_title_a_command_and_a_folder_inside() {
        let mut f = fixture();
        // From outside xDev: the person is asked.
        f.answer = Some(true);
        fs::create_dir_all(f.lead.join("src").join("app")).unwrap();
        let r = f
            .call(
                None,
                "terminal.create",
                json!({
                    "here": f.lead.join("src").display().to_string(),
                    "cwd": "app",
                    "title": "  build ",
                    "cmd": "make test",
                }),
            )
            .unwrap();
        assert_eq!(r["cwd"], "src/app");
        assert_eq!(r["title"], "build");
        let ev = &sent(&f)[0];
        assert_eq!(ev["cmd"], "make test");
        assert_eq!(ev["worktree"], f.lead.display().to_string());
        assert_eq!(asked(&f), 1);
    }

    #[test]
    fn create_refuses_a_folder_outside_or_missing_and_a_bad_command() {
        let f = fixture();
        let here = f.lead.display().to_string();
        let call = |p: Value| f.call(Some("p-lead"), "terminal.create", p);
        let e = call(json!({"cwd": f.other.display().to_string()})).unwrap_err();
        assert_eq!(e.code, "outside_worktree");
        let e = call(json!({"cwd": "..", "here": here})).unwrap_err();
        assert_eq!(e.code, "outside_worktree");
        let e = call(json!({"cwd": "nope"})).unwrap_err();
        assert_eq!(e.code, "bad_request");
        let e = call(json!({"cmd": "a\nb"})).unwrap_err();
        assert_eq!(e.code, "bad_request");
        let e = call(json!({"title": "a\u{7}"})).unwrap_err();
        assert_eq!(e.code, "bad_request");
        let e = call(json!({"cmd": "x".repeat(SEND_MAX_BYTES + 1)})).unwrap_err();
        assert_eq!(e.code, "bad_request");
        assert!(sent(&f).is_empty());
        // From outside xDev with no folder to go by: no worktree.
        let e = f.call(None, "terminal.create", json!({})).unwrap_err();
        assert_eq!(e.code, "no_worktree");
    }

    #[test]
    fn create_in_another_family_asks_first() {
        let mut f = fixture();
        f.answer = Some(false);
        let other = f.other.display().to_string();
        let e = f
            .call(
                Some("p-lead"),
                "terminal.create",
                json!({"worktree": other}),
            )
            .unwrap_err();
        assert_eq!(e.code, "denied");
        assert!(sent(&f).is_empty());
        f.answer = Some(true);
        let r = f
            .call(
                Some("p-lead"),
                "terminal.create",
                json!({"worktree": other}),
            )
            .unwrap();
        assert_eq!(r["worktree"], other);
        // A child of the caller is family: no question.
        let before = asked(&f);
        let child = f.child.display().to_string();
        f.call(
            Some("p-lead"),
            "terminal.create",
            json!({"worktree": child}),
        )
        .unwrap();
        assert_eq!(asked(&f), before);
    }

    #[test]
    fn create_times_out_when_the_window_never_opens_the_tab() {
        let mut f = fixture();
        f.terminal_ui = false;
        // Meant to expire: the fake UI never answers.
        f.orch.waits.open_slack = Duration::from_millis(100);
        let e = f
            .call(Some("p-lead"), "terminal.create", json!({}))
            .unwrap_err();
        assert_eq!(e.code, "timeout");
        assert_eq!(sent(&f).len(), 1);
    }

    #[test]
    fn split_opens_beside_the_callers_tab_in_its_folder() {
        let f = fixture();
        f.board
            .replace(vec![tab("p-lead", &f.lead, false, "idle")], None);
        let r = f
            .call(Some("p-lead"), "terminal.split", json!({"dir": "down"}))
            .unwrap();
        let ev = &sent(&f)[0];
        assert_eq!(ev["op"], "split");
        assert_eq!(ev["source"], "p-lead");
        assert_eq!(ev["dir"], "down");
        // p-lead's shell started in lead/src.
        assert_eq!(ev["cwd"], "src");
        assert_eq!(r["id"], ev["id"]);
        assert_ne!(r["id"], "p-lead");
    }

    #[test]
    fn split_of_a_named_tab_and_of_nothing() {
        let f = fixture();
        f.board
            .replace(vec![tab("p-child", &f.child, true, "idle")], None);
        f.call(
            Some("p-lead"),
            "terminal.split",
            json!({"tab": "p-ch", "dir": "right"}),
        )
        .unwrap();
        let ev = &sent(&f)[0];
        assert_eq!(ev["source"], "p-child");
        assert_eq!(ev["dir"], "right");
        assert_eq!(ev["cwd"], Value::Null);
        let e = f
            .call(None, "terminal.split", json!({"dir": "right"}))
            .unwrap_err();
        assert_eq!(e.code, "no_terminal");
        let e = f
            .call(
                None,
                "terminal.split",
                json!({"tab": "p-child", "dir": "up"}),
            )
            .unwrap_err();
        assert_eq!(e.code, "bad_request");
    }

    #[test]
    fn stop_ends_the_process_and_keeps_the_tab() {
        let mut f = fixture();
        f.board
            .replace(vec![tab("p-lead", &f.lead, false, "idle")], None);
        let r = f.call(Some("p-lead"), "terminal.stop", json!({})).unwrap();
        assert_eq!(r, json!({"id": "p-lead", "stopped": true}));
        assert_eq!(*f.pty_kills.lock().unwrap(), vec!["p-lead".to_owned()]);
        assert!(sent(&f).is_empty());
        // No PTY behind the tab: closed.
        f.pty_alive = false;
        let e = f
            .call(Some("p-lead"), "terminal.stop", json!({}))
            .unwrap_err();
        assert_eq!(e.code, "closed");
        let mut gone = tab("p-lead", &f.lead, false, "idle");
        gone.exited = true;
        f.board.replace(vec![gone], None);
        let e = f
            .call(Some("p-lead"), "terminal.stop", json!({}))
            .unwrap_err();
        assert_eq!(e.code, "closed");
    }

    #[test]
    fn close_waits_for_the_tab_to_leave_the_board() {
        let f = fixture();
        f.board.replace(
            vec![
                tab("p-lead", &f.lead, false, "idle"),
                tab("t-lead", &f.lead, false, "idle"),
            ],
            None,
        );
        let r = f
            .call(Some("p-lead"), "terminal.close", json!({"tab": "t-lead"}))
            .unwrap();
        assert_eq!(r, json!({"id": "t-lead", "closed": true}));
        assert_eq!(sent(&f)[0]["op"], "close");
        assert!(f.board.resolve("t-lead").is_err());
        assert!(f.board.resolve("p-lead").is_ok());
        assert_eq!(asked(&f), 0);
    }

    #[test]
    fn close_in_a_child_asks_and_times_out_without_the_window() {
        let mut f = fixture();
        f.board
            .replace(vec![tab("p-child", &f.child, false, "idle")], None);
        f.answer = Some(false);
        let e = f
            .call(Some("p-lead"), "terminal.close", json!({"tab": "p-child"}))
            .unwrap_err();
        assert_eq!(e.code, "denied");
        assert_eq!(asked(&f), 1);
        f.answer = Some(true);
        f.terminal_ui = false;
        // Meant to expire: the fake UI never closes it.
        f.orch.waits.stop = Duration::from_millis(100);
        let e = f
            .call(Some("p-lead"), "terminal.close", json!({"tab": "p-child"}))
            .unwrap_err();
        assert_eq!(e.code, "timeout");
    }

    fn opened_tabs(f: &Fixture) -> Vec<Value> {
        f.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == "cli://open-tab")
            .map(|(_, p)| p.clone())
            .collect()
    }

    #[test]
    fn launch_opens_the_agent_like_worktree_create_and_returns_its_tab() {
        let f = fixture();
        let r = f
            .call(
                Some("p-lead"),
                "agent.launch",
                json!({"cli": "codex", "account": " codex-2 ", "prompt": "fix the build"}),
            )
            .unwrap();
        let ev = &opened_tabs(&f)[0];
        assert_eq!(ev["profile"], "codex");
        assert_eq!(ev["worktree"], f.lead.display().to_string());
        assert_eq!(ev["prompt"], "fix the build");
        assert_eq!(ev["account"], "codex-2");
        assert_eq!(r["id"], ev["id"]);
        assert_eq!(r["profile"], "codex");
        assert!(f.board.resolve(r["id"].as_str().unwrap()).is_ok());
        assert_eq!(asked(&f), 0);
        // In a named worktree outside the family: asked first.
        let mut f = f;
        f.answer = Some(false);
        let other = f.other.display().to_string();
        let e = f
            .call(
                Some("p-lead"),
                "agent.launch",
                json!({"cli": "claude", "worktree": other}),
            )
            .unwrap_err();
        assert_eq!(e.code, "denied");
        assert_eq!(opened_tabs(&f).len(), 1);
    }

    #[test]
    fn launch_refuses_an_unknown_or_turned_off_agent_and_a_bad_account() {
        let f = fixture();
        let call = |p: Value| f.call(Some("p-lead"), "agent.launch", p).unwrap_err();
        assert_eq!(call(json!({"cli": "nope"})).code, "unknown_agent");
        assert_eq!(
            call(json!({"cli": "claude", "account": "a
b"}))
            .code,
            "bad_request"
        );
        let big = "x".repeat(SEND_MAX_BYTES + 1);
        assert_eq!(
            call(json!({"cli": "claude", "prompt": big})).code,
            "bad_request"
        );
        let mut profiles = xdev_agent::Profiles::default();
        let mut off = profiles.get("claude").unwrap().clone();
        off.enabled = false;
        profiles.put(off).unwrap();
        profiles.save(&f.data).unwrap();
        assert_eq!(call(json!({"cli": "claude"})).code, "bad_request");
        assert!(opened_tabs(&f).is_empty());
    }

    #[test]
    fn launch_times_out_when_the_window_does_not_open_it() {
        let mut f = fixture();
        f.terminal_ui = false;
        // Meant to expire: the fake UI never opens it.
        f.orch.waits.open_slack = Duration::from_millis(100);
        let e = f
            .call(Some("p-lead"), "agent.launch", json!({"cli": "claude"}))
            .unwrap_err();
        assert_eq!(e.code, "timeout");
    }
}
