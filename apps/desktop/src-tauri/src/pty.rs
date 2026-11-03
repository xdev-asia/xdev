//! Terminals in the UI: a shell or an agent CLI in a pseudo console per tab.
//! An agent launch passes the policy gate first; a shell does not.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use xdev_agent::{Launch, LaunchError, launch};
use xdev_policy::{Action, Audited, Gate, Policy, Verdict, agent_fingerprint};
use xdev_pty::{PtyError, Session, SpawnSpec};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError};

/// The approval mode an agent starts in from a terminal.
const PERMISSIONS: &str = "ask";

impl From<LaunchError> for CmdError {
    fn from(e: LaunchError) -> CmdError {
        CmdError {
            code: e.code(),
            detail: Some(e.to_string()),
        }
    }
}

impl From<PtyError> for CmdError {
    fn from(e: PtyError) -> CmdError {
        CmdError {
            code: e.code(),
            detail: Some(e.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    id: String,
    pid: Option<u32>,
    program: String,
    agent: bool,
}

/// Payload of the `pty://exit` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    id: String,
    code: Option<i32>,
}

#[derive(Default)]
pub struct Ptys(Mutex<HashMap<String, Session>>);

impl Ptys {
    fn map(&self) -> MutexGuard<'_, HashMap<String, Session>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// On app exit, so no agent outlives the window.
    pub fn kill_all(&self) {
        // Taken out first, so killing never runs under the lock.
        let sessions = std::mem::take(&mut *self.map());
        for session in sessions.values() {
            session.kill();
        }
    }

    fn with<T>(&self, id: &str, f: impl FnOnce(&Session) -> T) -> Result<T, CmdError> {
        self.map().get(id).map(f).ok_or(CmdError {
            code: "pty_unknown",
            detail: None,
        })
    }
}

/// Gates an agent, then starts `launch` in `cwd`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_launch(
    ptys: &Ptys,
    data_dir: &Path,
    id: String,
    cwd: PathBuf,
    launch: Launch,
    cols: u16,
    rows: u16,
    on_output: impl FnMut(Vec<u8>) + Send + 'static,
    on_exit: impl FnOnce(Option<i32>) + Send + 'static,
) -> Result<PtyInfo, CmdError> {
    if !cwd.is_dir() {
        return Err(CmdError {
            code: "not_found",
            detail: Some(cwd.display().to_string()),
        });
    }
    let mut map = ptys.map();
    if map.contains_key(&id) {
        return Err(CmdError {
            code: "pty_exists",
            detail: None,
        });
    }
    if launch.agent {
        let gate = Audited::new(Policy::load(data_dir)?, data_dir);
        match gate.check(&launch_action(&launch)) {
            Verdict::Allow => {}
            Verdict::Ask { reason } => {
                return Err(CmdError {
                    code: "needs_approval",
                    detail: Some(reason),
                });
            }
            Verdict::Deny { reason } => {
                return Err(CmdError {
                    code: "denied",
                    detail: Some(reason),
                });
            }
        }
    }
    let mut env = launch.env;
    env.push(("XDEV_PTY_ID".to_owned(), OsString::from(&id)));
    let spec = SpawnSpec {
        program: launch.program.clone(),
        args: launch.args,
        env,
        cwd,
        cols,
        rows,
    };
    let session = Session::spawn(spec, on_output, on_exit)?;
    let info = PtyInfo {
        id: id.clone(),
        pid: session.pid(),
        program: launch.program.display().to_string(),
        agent: launch.agent,
    };
    map.insert(id, session);
    Ok(info)
}

/// Records that a person approved this exact launch line.
pub(crate) fn approve_launch(data_dir: &Path, launch: &Launch) -> Result<(), CmdError> {
    let mut policy = Policy::load(data_dir)?;
    let print = agent_fingerprint(&launch.program.to_string_lossy(), &launch.args, PERMISSIONS);
    if !policy.approved_agents.contains(&print) {
        policy.approved_agents.push(print);
        policy.save(data_dir)?;
    }
    Ok(())
}

fn launch_action(launch: &Launch) -> Action {
    Action::LaunchAgent {
        profile: launch.profile.clone(),
        program: launch.program.to_string_lossy().into_owned(),
        args: launch.args.clone(),
        permissions: PERMISSIONS.to_owned(),
    }
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    ptys: State<'_, Ptys>,
    id: String,
    cwd: PathBuf,
    profile_id: String,
    cols: u16,
    rows: u16,
    out: Channel<InvokeResponseBody>,
) -> Result<PtyInfo, CmdError> {
    let launch = launch(&profile_id)?;
    let exit_id = id.clone();
    spawn_launch(
        &ptys,
        data_dir(&state)?,
        id,
        cwd,
        launch,
        cols,
        rows,
        move |bytes| {
            // A closed channel means the tab is gone; `pty_kill` follows.
            let _ = out.send(InvokeResponseBody::Raw(bytes));
        },
        move |code| {
            // The session stays until `pty_kill`: dropping it now would stop
            // the pump before the last output (often the error) is sent.
            let _ = app.emit("pty://exit", PtyExit { id: exit_id, code });
        },
    )
}

#[tauri::command(async)]
pub fn pty_approve(state: State<'_, AppState>, profile_id: String) -> Result<(), CmdError> {
    approve_launch(data_dir(&state)?, &launch(&profile_id)?)
}

#[tauri::command]
pub fn pty_write(ptys: State<'_, Ptys>, id: String, data: Vec<u8>) -> Result<(), CmdError> {
    ptys.with(&id, |s| s.write(data))
}

#[tauri::command]
pub fn pty_resize(ptys: State<'_, Ptys>, id: String, cols: u16, rows: u16) -> Result<(), CmdError> {
    ptys.with(&id, |s| s.resize(cols, rows))??;
    Ok(())
}

#[tauri::command]
pub fn pty_ack(ptys: State<'_, Ptys>, id: String, n: usize) -> Result<(), CmdError> {
    ptys.with(&id, |s| s.ack(n))
}

// Off the main thread: ending a process tree waits on taskkill and the console.
#[tauri::command(async)]
pub fn pty_kill(ptys: State<'_, Ptys>, id: String) {
    // Dropping the session kills it; an unknown id has already ended.
    let session = ptys.map().remove(&id);
    drop(session);
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    fn shell(script: &str) -> (PathBuf, Vec<String>) {
        if cfg!(windows) {
            (
                "cmd.exe".into(),
                ["/d", "/c", script].map(String::from).to_vec(),
            )
        } else {
            ("/bin/sh".into(), ["-c", script].map(String::from).to_vec())
        }
    }

    fn agent() -> Launch {
        let (program, args) = shell("echo agent");
        Launch {
            profile: "claude".into(),
            program,
            args,
            env: Vec::new(),
            agent: true,
            permissions: xdev_agent::Permissions::Ask,
            account: None,
            startup: vec![],
        }
    }

    fn start(
        ptys: &Ptys,
        data: &Path,
        id: &str,
        launch: Launch,
    ) -> (Result<PtyInfo, CmdError>, mpsc::Receiver<Option<i32>>) {
        let (tx, rx) = mpsc::channel();
        let result = spawn_launch(
            ptys,
            data,
            id.into(),
            std::env::temp_dir(),
            launch,
            80,
            24,
            |_| {},
            move |code| {
                let _ = tx.send(code);
            },
        );
        (result, rx)
    }

    #[test]
    fn agent_needs_approval_then_spawns() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let (first, _) = start(&ptys, data.path(), "a", agent());
        assert_eq!(first.unwrap_err().code, "needs_approval");
        approve_launch(data.path(), &agent()).unwrap();
        let (second, _) = start(&ptys, data.path(), "a", agent());
        assert!(second.unwrap().agent);
    }

    #[test]
    fn shell_spawns_without_policy() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let launch = xdev_agent::launch("shell").unwrap();
        let (result, _) = start(&ptys, data.path(), "s", launch);
        assert!(!result.unwrap().agent);
        assert!(!data.path().join("audit.jsonl").exists());
        ptys.kill_all();
    }

    #[test]
    fn duplicate_id_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let launch = xdev_agent::launch("shell").unwrap();
        start(&ptys, data.path(), "d", launch.clone()).0.unwrap();
        let (again, _) = start(&ptys, data.path(), "d", launch);
        assert_eq!(again.unwrap_err().code, "pty_exists");
        ptys.kill_all();
    }

    #[test]
    fn kill_all_ends_every_session() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let launch = xdev_agent::launch("shell").unwrap();
        let (one, rx1) = start(&ptys, data.path(), "1", launch.clone());
        let (two, rx2) = start(&ptys, data.path(), "2", launch);
        one.unwrap();
        two.unwrap();
        ptys.kill_all();
        for rx in [rx1, rx2] {
            rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        assert!(ptys.map().is_empty());
    }

    #[test]
    fn missing_cwd_is_not_found() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let launch = xdev_agent::launch("shell").unwrap();
        let err = spawn_launch(
            &ptys,
            data.path(),
            "m".into(),
            data.path().join("nope"),
            launch,
            80,
            24,
            |_| {},
            |_| {},
        )
        .unwrap_err();
        assert_eq!(err.code, "not_found");
    }
}
