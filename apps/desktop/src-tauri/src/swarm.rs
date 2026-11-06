//! Headless swarm: N workers on one goal through the ordinary worker start,
//! each asked to open hidden (no tab until the person opens it). The rules
//! (size, cap, stop all) are in `xdev_orch::workers`; this is the real
//! spawner and the commands the Swarm panel calls.

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use xdev_orch::{
    OrchError, Spawner, SwarmSpawn, SwarmStarted, SwarmStopped, SwarmWorker, WorkerReceipt,
    WorkerState, swarm_start, swarm_stop,
};

use crate::accounts::data_dir;
use crate::cli_verbs::AppVerbs;
use crate::commands::{AppState, CmdError};
use crate::endpoint::{Caller, Handler, Request};
use crate::orchestration::OrchHub;
use crate::term_tail::TermTails;

/// Longest last line shown in the progress list.
const LINE_MAX: usize = 160;

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SwarmStart {
    pub run: String,
    pub started: SwarmStarted,
}

/// One worker of the progress list.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SwarmRow {
    pub dispatch: String,
    pub tab: Option<String>,
    pub agent: String,
    pub state: WorkerState,
    /// The last non-empty line its terminal printed.
    pub last_line: String,
}

/// Payload of `orchestration://reveal-tab`: show this worker's tab.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RevealTab {
    pub tab: String,
}

fn cmd_err(e: OrchError) -> CmdError {
    CmdError {
        code: "orchestration",
        detail: Some(format!("{}: {}", e.code, e.message)),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The last non-empty line of `text`, cut to [`LINE_MAX`] characters.
pub(crate) fn last_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("");
    if line.chars().count() <= LINE_MAX {
        return line.to_owned();
    }
    let cut: String = line.chars().take(LINE_MAX - 1).collect();
    format!("{cut}…")
}

/// Where a swarm worker's checkout comes from: a new child of the worktree
/// the person's tab is in, else the worktree named, shared.
pub(crate) fn worktree_pick(tab: Option<&str>, worktree: Option<&str>) -> Result<Value, OrchError> {
    match (tab, worktree) {
        (Some(_), _) => Ok(json!("new_child")),
        (None, Some(w)) if !w.trim().is_empty() => Ok(json!({ "selector": w })),
        _ => Err(OrchError::bad_request(
            "a swarm needs the tab or the worktree it starts from",
        )),
    }
}

/// Starts and stops workers through the app's own verbs.
struct AppSpawner {
    verbs: AppVerbs,
    run: String,
    caller: Caller,
    pick: Value,
}

impl AppSpawner {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let req = Request {
            id: 0,
            method: format!("orchestration.{method}"),
            params,
            caller: None,
        };
        self.verbs
            .handle(&req, &self.caller, &|| false)
            .map_err(|e| format!("{}: {}", e.code, e.message))
    }
}

impl Spawner for AppSpawner {
    fn spawn(&mut self, req: &SwarmSpawn) -> Result<SwarmWorker, String> {
        let spec = format!(
            "{}\n\nYou are worker {} of {} on this goal. Take your own part of it and report when done.",
            req.goal, req.index, req.size
        );
        let answer = self.call(
            "worker-start",
            json!({
                "run": self.run,
                "spec": spec,
                "agent": req.agent,
                "worktree": self.pick,
                "name": format!("swarm-{}", req.index),
                "hidden": req.hidden,
            }),
        )?;
        let receipt: WorkerReceipt = serde_json::from_value(answer).map_err(|e| e.to_string())?;
        if matches!(receipt.state, WorkerState::Failed) {
            return Err(receipt
                .last_error
                .unwrap_or_else(|| "the worker did not start".to_owned()));
        }
        let app = &self.verbs.app;
        let tab = app
            .state::<OrchHub>()
            .with_store(
                data_dir(&app.state::<AppState>()).map_err(|e| e.code.to_owned())?,
                |s| s.worker_get(&receipt.dispatch_id),
            )
            .ok()
            .and_then(|w| w.tab)
            .unwrap_or_default();
        Ok(SwarmWorker {
            dispatch: receipt.dispatch_id,
            tab,
        })
    }

    fn stop(&mut self, dispatch: &str) -> Result<(), String> {
        self.call("worker-stop", json!({ "handle": dispatch }))
            .map(|_| ())
    }
}

/// Starts a swarm on `goal`: `count` (default 4, at most 12) hidden workers
/// of `agent`, in one new run. `tab` is the person's current tab, from which
/// each worker gets its own child worktree; without one `worktree` is shared.
#[tauri::command(async)]
pub fn swarm_start_workers(
    app: AppHandle,
    state: State<'_, AppState>,
    goal: String,
    count: Option<u32>,
    agent: String,
    tab: Option<String>,
    worktree: Option<String>,
) -> Result<SwarmStart, CmdError> {
    let pick = worktree_pick(tab.as_deref(), worktree.as_deref()).map_err(cmd_err)?;
    let data = data_dir(&state)?;
    let hub = app.state::<OrchHub>();
    let run = hub
        .with_store(data, |s| {
            s.run_create(goal.trim(), tab.as_deref(), now_ms())
        })
        .map_err(cmd_err)?
        .id;
    let mut spawner = AppSpawner {
        verbs: AppVerbs { app },
        run: run.clone(),
        caller: Caller { pty: tab },
        pick,
    };
    let started = swarm_start(&mut spawner, &goal, count, &agent).map_err(cmd_err)?;
    Ok(SwarmStart { run, started })
}

/// The workers of a swarm's run with the last line each terminal printed.
#[tauri::command(async)]
pub fn swarm_workers(
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
    tails: State<'_, TermTails>,
    run: String,
) -> Result<Vec<SwarmRow>, CmdError> {
    let views = hub
        .with_store(data_dir(&state)?, |s| s.worker_list(&run, None))
        .map_err(cmd_err)?;
    Ok(views
        .into_iter()
        .map(|v| {
            let last = v
                .worker
                .tab
                .as_deref()
                .and_then(|t| tails.read(t, None, 20))
                .map(|r| last_line(&r.text))
                .unwrap_or_default();
            SwarmRow {
                dispatch: v.worker.dispatch_id,
                tab: v.worker.tab,
                agent: v.worker.agent,
                state: v.worker.state,
                last_line: last,
            }
        })
        .collect())
}

/// Stops every live worker of the run; the swarm's confirmation is the UI's.
#[tauri::command(async)]
pub fn swarm_stop_all(
    app: AppHandle,
    state: State<'_, AppState>,
    hub: State<'_, OrchHub>,
    run: String,
) -> Result<SwarmStopped, CmdError> {
    let live: Vec<String> = hub
        .with_store(data_dir(&state)?, |s| s.worker_list(&run, None))
        .map_err(cmd_err)?
        .into_iter()
        .filter(|v| {
            !matches!(
                v.worker.state,
                WorkerState::Succeeded
                    | WorkerState::Failed
                    | WorkerState::Stopped
                    | WorkerState::Abandoned
            )
        })
        .map(|v| v.worker.dispatch_id)
        .collect();
    let mut spawner = AppSpawner {
        verbs: AppVerbs { app },
        run,
        caller: Caller::default(),
        pick: Value::Null,
    };
    Ok(swarm_stop(&mut spawner, &live))
}

/// Asks the window to show a hidden worker's tab.
#[tauri::command(async)]
pub fn swarm_open_tab(app: AppHandle, tab: String) -> Result<(), CmdError> {
    app.emit("orchestration://reveal-tab", RevealTab { tab })
        .map_err(|_| CmdError {
            code: "orchestration",
            detail: Some("the window could not be told".to_owned()),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_line_is_the_last_one_with_text_and_is_cut() {
        assert_eq!(last_line("one\n  two  \n\n  \n"), "two");
        assert_eq!(last_line(""), "");
        let long = "x".repeat(300);
        let cut = last_line(&long);
        assert_eq!(cut.chars().count(), LINE_MAX);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn a_swarm_starts_from_a_tab_or_a_named_worktree() {
        assert_eq!(worktree_pick(Some("t1"), None).unwrap(), json!("new_child"));
        assert_eq!(
            worktree_pick(Some("t1"), Some("/w")).unwrap(),
            json!("new_child")
        );
        assert_eq!(
            worktree_pick(None, Some("/w")).unwrap(),
            json!({ "selector": "/w" })
        );
        assert_eq!(
            worktree_pick(None, Some(" ")).unwrap_err().code,
            "bad_request"
        );
        assert_eq!(worktree_pick(None, None).unwrap_err().code, "bad_request");
    }
}
