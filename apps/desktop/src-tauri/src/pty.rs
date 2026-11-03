//! Terminals in the UI: a shell or an agent CLI in a pseudo console per tab.
//! An agent launch passes the policy gate first; a shell does not.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use xdev_agent::{
    Cli, Context, HookEvent, Launch, LaunchError, Permissions, Profile, Profiles, ShellEntry,
    ShellKind, default_shell_id, find_builtin, find_program, list_shells, resolve, wsl_distros,
};
use xdev_ai::Registry;
use xdev_policy::{Action, Audited, Policy, Verdict, agent_fingerprint};
use xdev_pty::{PtyError, Session, SpawnSpec};
use xdev_workspace::{HookKind, Registry as Workspace, WorkspaceError, hook_env, hooks_for};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError, cli_beside};
use crate::settings::StatusSettings;
use crate::settings_store;

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

/// The reserved profile id that runs the worktree's setup script, from
/// `repo_hooks`, in the default shell.
pub const SETUP_PROFILE: &str = "xdev:setup";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    id: String,
    pid: Option<u32>,
    // What was spawned: the startup wrapper's shell when there are startup
    // lines, else the CLI or shell itself.
    program: String,
    agent: bool,
    // The id the tab was opened with.
    profile: String,
    // The approval mode the launch stands for: ask, accept-edits or skip.
    permissions: String,
    account: Option<String>,
    // Whether the launch got the status hook flags.
    hooks: bool,
    // The hook events the launch reports (version gate, codex private home or
    // notify alone); the UI picks its caps from these.
    hook_events: Vec<HookEvent>,
    // The CLI the profile runs, also for a custom profile; null for a shell
    // or an unknown program.
    cli: Option<Cli>,
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
pub struct Ptys {
    sessions: Mutex<HashMap<String, Session>>,
    /// Fingerprints of skip-mode launches a person has just approved. A start
    /// takes its fingerprint out, so each approval covers one start.
    passes: Mutex<HashSet<String>>,
}

impl Ptys {
    fn map(&self) -> MutexGuard<'_, HashMap<String, Session>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn passes(&self) -> MutexGuard<'_, HashSet<String>> {
        self.passes.lock().unwrap_or_else(PoisonError::into_inner)
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

/// The WSL distros, asked for once per app run.
static WSL: OnceLock<Vec<String>> = OnceLock::new();

pub(crate) fn distros() -> &'static [String] {
    WSL.get_or_init(wsl_distros)
}

/// The `xdev` an agent's status hooks run, when they are on (R4): the
/// setting is on and the CLI sits next to the desktop exe.
pub(crate) fn hook_program(status: &StatusSettings, exe: &Path) -> Option<PathBuf> {
    if status.hooks { cli_beside(exe) } else { None }
}

/// `hook_program` for this app run, read fresh so a changed setting applies
/// to the next session.
fn hooks_now(app: &AppHandle) -> Option<PathBuf> {
    let status = settings_store::store(app)?.read().status;
    hook_program(&status, &std::env::current_exe().ok()?)
}

/// The launch of profile or shell `id`, from the stores in `data_dir`.
/// `account` replaces the profile's own account (a restart keeps the tab's).
/// With `hooks`, an agent CLI that has status hooks gets the flags that run
/// that `xdev`.
pub(crate) fn launch_for(
    data_dir: &Path,
    id: &str,
    account: Option<&str>,
    hooks: Option<&Path>,
) -> Result<Launch, CmdError> {
    let profiles = Profiles::load(data_dir).map_err(LaunchError::from)?;
    let accounts = Registry::load(data_dir)?;
    // Only the shell ids look at the shells; `wsl.exe` is not asked for an agent.
    let distros: &[String] = if id == "shell" || id.starts_with("shell:") {
        distros()
    } else {
        &[]
    };
    let shells = list_shells(&profiles.shells, distros);
    let find = |profile: &Profile| match profile.cli {
        Some(cli) => find_builtin(cli),
        None => profile.program.as_deref().and_then(find_program),
    };
    let ctx = Context {
        profiles: &profiles,
        accounts: &accounts,
        shells: &shells,
        find: &find,
        account,
    };
    let mut launch = resolve(id, &ctx)?;
    if let Some(xdev) = hooks {
        launch.add_hooks(xdev, data_dir);
    }
    Ok(launch)
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
    // A skip approval covers one start attempt: taken out first, so a start
    // that fails early cannot leave it behind for a later one.
    let approved_now = launch.agent && ptys.passes().remove(&fingerprint(&launch));
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
        match gate.check_confirmed(&launch_action(&launch), approved_now) {
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
    let (program, args) = launch.command();
    let mut env = launch.env;
    env.push(("XDEV_PTY_ID".to_owned(), OsString::from(&id)));
    let spec = SpawnSpec {
        program: program.clone(),
        args,
        env,
        cwd,
        cols,
        rows,
    };
    let session = Session::spawn(spec, on_output, on_exit)?;
    let info = PtyInfo {
        id: id.clone(),
        pid: session.pid(),
        program: program.display().to_string(),
        agent: launch.agent,
        profile: launch.profile,
        permissions: launch.permissions.as_str().to_owned(),
        account: launch.account,
        hooks: launch.hooks,
        hook_events: launch.hook_events,
        cli: launch.cli,
    };
    map.insert(id, session);
    Ok(info)
}

/// Records that a person approved this exact launch line. Skip mode is never
/// a standing approval: it is kept in memory for the next start only.
pub(crate) fn approve_launch(
    ptys: &Ptys,
    data_dir: &Path,
    launch: &Launch,
) -> Result<(), CmdError> {
    let print = fingerprint(launch);
    if launch.permissions == Permissions::Skip {
        ptys.passes().insert(print);
        return Ok(());
    }
    let mut policy = Policy::load(data_dir)?;
    if !policy.approved_agents.contains(&print) {
        policy.approved_agents.push(print);
        policy.save(data_dir)?;
    }
    Ok(())
}

/// The CLI's own program, args and mode; never the startup wrapper.
fn fingerprint(launch: &Launch) -> String {
    agent_fingerprint(
        &launch.program.to_string_lossy(),
        &launch.args,
        launch.permissions.as_str(),
    )
}

fn launch_action(launch: &Launch) -> Action {
    Action::LaunchAgent {
        profile: launch.profile.clone(),
        program: launch.program.to_string_lossy().into_owned(),
        args: launch.args.clone(),
        permissions: launch.permissions.as_str().to_owned(),
    }
}

/// The program and args that run `script` in `shell` and end with it.
/// CMD runs one line, so the script's lines are joined with ` & `. A WSL
/// shell runs it with `sh -lc` in its distro.
pub(crate) fn setup_command(shell: &ShellEntry, script: &str) -> (PathBuf, Vec<String>) {
    let own = |args: &[&str]| -> Vec<String> {
        args.iter()
            .map(|a| (*a).to_owned())
            .chain([script.to_owned()])
            .collect()
    };
    let args = match shell.kind {
        ShellKind::Powershell => own(&["-NoLogo", "-NoProfile", "-Command"]),
        ShellKind::Cmd => {
            let line = script
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join(" & ");
            vec!["/D".to_owned(), "/C".to_owned(), line]
        }
        ShellKind::Wsl => shell
            .args
            .iter()
            .cloned()
            .chain(own(&["--exec", "sh", "-lc"]))
            .collect(),
        ShellKind::Login => own(&["-l", "-c"]),
        ShellKind::Custom => own(&["-c"]),
    };
    (shell.program.clone(), args)
}

/// A hook script ready to run: the shell line, and `hook_env`.
pub(crate) struct HookCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, OsString)>,
}

/// The `kind` script of the worktree at `cwd` as a command in the default
/// shell; `None` when there is no script. Refuses an untrusted shared
/// script. Not an agent: it passes the gate as a command the person
/// confirmed by trusting the script or typing it.
pub(crate) fn hook_command(
    data_dir: &Path,
    cwd: &Path,
    kind: HookKind,
) -> Result<Option<HookCommand>, CmdError> {
    let reg = Workspace::load(data_dir)?;
    let hooks = hooks_for(&reg, data_dir, cwd)?;
    let (script, name) = match kind {
        HookKind::Setup => (hooks.setup, "setup"),
        HookKind::Archive => (hooks.archive, "archive"),
    };
    let Some(script) = script else {
        return Ok(None);
    };
    if !script.trusted {
        return Err(WorkspaceError::HookUntrusted(name.to_owned()).into());
    }
    let profiles = Profiles::load(data_dir).map_err(LaunchError::from)?;
    // `wsl.exe` is asked only when the default shell is a distro.
    let wsl = profiles
        .default_shell
        .as_deref()
        .is_some_and(|id| id.starts_with("wsl:"));
    let shells = list_shells(&profiles.shells, if wsl { distros() } else { &[] });
    let id = default_shell_id(&profiles, &shells);
    let shell = shells
        .iter()
        .find(|s| s.id == id)
        .or(shells.first())
        .ok_or(CmdError {
            code: "not_found",
            detail: Some("shell".to_owned()),
        })?;
    let (program, args) = setup_command(shell, &script.text);
    let mut env: Vec<(String, OsString)> = hook_env(&reg, cwd)?
        .into_iter()
        .map(|(k, v)| (k, OsString::from(v)))
        .collect();
    if shell.kind == ShellKind::Wsl {
        // Carries the variables into the distro, the paths translated.
        let ours = "XDEV_ROOT_PATH/p:XDEV_WORKTREE_PATH/p:XDEV_WORKSPACE_NAME";
        let joined = match std::env::var("WSLENV") {
            Ok(theirs) if !theirs.is_empty() => format!("{theirs}:{ours}"),
            _ => ours.to_owned(),
        };
        env.push(("WSLENV".to_owned(), joined.into()));
    }
    let gate = Audited::new(Policy::load(data_dir)?, data_dir);
    let action = Action::RunCommand {
        program: program.to_string_lossy().into_owned(),
        args: args.clone(),
        cwd: cwd.to_owned(),
    };
    if let Verdict::Deny { reason } = gate.check_confirmed(&action, true) {
        return Err(CmdError {
            code: "denied",
            detail: Some(reason),
        });
    }
    Ok(Some(HookCommand { program, args, env }))
}

/// The launch that runs the setup script of the worktree at `cwd` in a
/// terminal; `hook_none` when it has none.
pub(crate) fn setup_launch(data_dir: &Path, cwd: &Path) -> Result<Launch, CmdError> {
    let HookCommand { program, args, env } = hook_command(data_dir, cwd, HookKind::Setup)?
        .ok_or_else(|| WorkspaceError::NoHook("setup".to_owned()))?;
    Ok(Launch {
        profile: SETUP_PROFILE.to_owned(),
        program,
        args,
        env,
        agent: false,
        permissions: Permissions::Ask,
        account: None,
        startup: Vec::new(),
        cli: None,
        hooks: false,
        hook_events: Vec::new(),
    })
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
    account: Option<String>,
    cols: u16,
    rows: u16,
    out: Channel<InvokeResponseBody>,
) -> Result<PtyInfo, CmdError> {
    let data = data_dir(&state)?;
    let launch = if profile_id == SETUP_PROFILE {
        setup_launch(data, &cwd)?
    } else {
        let hooks = hooks_now(&app);
        launch_for(data, &profile_id, account.as_deref(), hooks.as_deref())?
    };
    let exit_id = id.clone();
    spawn_launch(
        &ptys,
        data,
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
pub fn pty_approve(
    app: AppHandle,
    state: State<'_, AppState>,
    ptys: State<'_, Ptys>,
    profile_id: String,
    account: Option<String>,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    let hooks = hooks_now(&app);
    let launch = launch_for(data, &profile_id, account.as_deref(), hooks.as_deref())?;
    approve_launch(&ptys, data, &launch)
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
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    use super::*;
    use xdev_agent::{Cli, hook_args};

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
            permissions: Permissions::Ask,
            account: None,
            startup: vec![],
            cli: Some(Cli::Claude),
            hooks: false,
            hook_events: Vec::new(),
        }
    }

    fn hooked() -> Launch {
        let mut l = agent();
        l.add_hooks_with(Path::new("/opt/xdev"), None, None);
        l
    }

    #[test]
    fn hook_program_needs_the_setting_and_the_cli() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("xdev-desktop.exe");
        let on = StatusSettings::default();
        let off = StatusSettings {
            hooks: false,
            ..StatusSettings::default()
        };
        assert_eq!(hook_program(&on, &exe), None);
        let cli = dir
            .path()
            .join(format!("xdev{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&cli, "").unwrap();
        assert_eq!(hook_program(&on, &exe), Some(cli));
        assert_eq!(hook_program(&off, &exe), None);
    }

    #[test]
    fn launch_gets_hooks_only_when_on_and_cli_found() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let l = hooked();
        assert_eq!(
            l.args[l.args.len() - 2..],
            hook_args(Cli::Claude, Path::new("/opt/xdev"), None)[..]
        );
        approve_launch(&ptys, data.path(), &l).unwrap();
        let (info, _) = start(&ptys, data.path(), "a", l);
        let info = info.unwrap();
        assert!(info.hooks);
        // An unknown claude: the two ungated events.
        assert_eq!(info.hook_events, [HookEvent::Prompt, HookEvent::TurnDone]);
        assert_eq!(info.cli, Some(Cli::Claude));
        ptys.kill_all();

        // Turning hooks off is a different launch line: asked again.
        let (plain, _) = start(&ptys, data.path(), "b", agent());
        assert_eq!(plain.unwrap_err().code, "needs_approval");
        let shell = launch_for(data.path(), "shell", None, Some(Path::new("/opt/xdev"))).unwrap();
        assert!(!shell.hooks);
        assert!(!shell.args.iter().any(|a| a == "--settings"));
    }

    #[test]
    fn toggling_hooks_changes_the_fingerprint() {
        assert_ne!(print_of(&agent()), print_of(&hooked()));
        let mut moved = agent();
        moved.add_hooks_with(Path::new("/elsewhere/xdev"), None, None);
        assert_ne!(print_of(&hooked()), print_of(&moved));
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

    /// Runs `launch` and returns what it printed once the output holds
    /// `until` (exit is reported on its own thread, so it says nothing about
    /// whether the last output has arrived).
    fn run_until(ptys: &Ptys, data: &Path, launch: Launch, until: &str) -> (PtyInfo, String) {
        let out = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&out);
        let info = spawn_launch(
            ptys,
            data,
            "w".into(),
            std::env::temp_dir(),
            launch,
            80,
            24,
            move |bytes| sink.lock().unwrap().extend(bytes),
            |_| {},
        )
        .unwrap();
        let text =
            |out: &Mutex<Vec<u8>>| String::from_utf8_lossy(&out.lock().unwrap()).into_owned();
        // The console asks where the cursor is and waits; a terminal answers.
        let mut answered = false;
        for _ in 0..400 {
            let seen = text(&out);
            if seen.contains(until) {
                break;
            }
            if !answered && seen.contains("\x1b[6n") {
                answered = true;
                let _ = ptys.with("w", |s| s.write(b"\x1b[1;1R".to_vec()));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        ptys.kill_all();
        (info, text(&out))
    }

    fn wrapper_shell() -> String {
        if cfg!(windows) {
            "powershell.exe".to_owned()
        } else {
            std::env::var("SHELL")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "/bin/sh".into())
        }
    }

    fn with_extra_args(extra: [&str; 2]) -> Launch {
        let mut l = agent();
        l.args.extend(extra.map(String::from));
        l
    }

    fn print_of(l: &Launch) -> String {
        agent_fingerprint(
            &l.program.to_string_lossy(),
            &l.args,
            l.permissions.as_str(),
        )
    }

    #[test]
    fn agent_needs_approval_then_spawns() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let (first, _) = start(&ptys, data.path(), "a", agent());
        assert_eq!(first.unwrap_err().code, "needs_approval");
        approve_launch(&ptys, data.path(), &agent()).unwrap();
        let (second, _) = start(&ptys, data.path(), "a", agent());
        assert!(second.unwrap().agent);
        ptys.kill_all();
    }

    #[test]
    fn skip_asks_every_start() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let l = Launch {
            permissions: Permissions::Skip,
            ..agent()
        };
        let (first, _) = start(&ptys, data.path(), "a", l.clone());
        assert_eq!(first.unwrap_err().code, "needs_approval");
        approve_launch(&ptys, data.path(), &l).unwrap();
        start(&ptys, data.path(), "a", l.clone()).0.unwrap();
        ptys.kill_all();
        let (again, _) = start(&ptys, data.path(), "b", l);
        assert_eq!(again.unwrap_err().code, "needs_approval");
        assert!(
            Policy::load(data.path())
                .unwrap()
                .approved_agents
                .is_empty()
        );
    }

    #[test]
    fn skip_pass_is_spent_by_a_start_and_audited() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let l = Launch {
            permissions: Permissions::Skip,
            ..agent()
        };
        approve_launch(&ptys, data.path(), &l).unwrap();
        assert!(ptys.passes().contains(&print_of(&l)));
        start(&ptys, data.path(), "a", l).0.unwrap();
        assert!(ptys.passes().is_empty());
        ptys.kill_all();
        let log = xdev_policy::read_audit(data.path()).unwrap();
        assert_eq!(log.last().unwrap().verdict, Verdict::Allow);
    }

    #[test]
    fn ask_approval_does_not_cover_skip() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        approve_launch(&ptys, data.path(), &agent()).unwrap();
        let skip = Launch {
            permissions: Permissions::Skip,
            ..agent()
        };
        let (result, _) = start(&ptys, data.path(), "a", skip);
        assert_eq!(result.unwrap_err().code, "needs_approval");
        assert!(ptys.passes().is_empty());
    }

    #[test]
    fn accept_edits_approval_is_saved() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let l = Launch {
            permissions: Permissions::AcceptEdits,
            ..agent()
        };
        approve_launch(&ptys, data.path(), &l).unwrap();
        assert!(ptys.passes().is_empty());
        assert_eq!(
            Policy::load(data.path()).unwrap().approved_agents,
            [print_of(&l)]
        );
        start(&ptys, data.path(), "a", l.clone()).0.unwrap();
        ptys.kill_all();
        start(&ptys, data.path(), "b", l).0.unwrap();
        ptys.kill_all();
    }

    #[test]
    fn model_change_asks_again() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        approve_launch(&ptys, data.path(), &with_extra_args(["--model", "a"])).unwrap();
        start(&ptys, data.path(), "a", with_extra_args(["--model", "a"]))
            .0
            .unwrap();
        ptys.kill_all();
        let (changed, _) = start(&ptys, data.path(), "b", with_extra_args(["--model", "b"]));
        assert_eq!(changed.unwrap_err().code, "needs_approval");
    }

    #[test]
    fn shell_never_touches_passes() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        ptys.passes().insert("keep".into());
        let launch = launch_for(data.path(), "shell", None, None).unwrap();
        start(&ptys, data.path(), "s", launch).0.unwrap();
        ptys.kill_all();
        assert_eq!(ptys.passes().len(), 1);
    }

    #[test]
    fn info_reports_profile_permissions_account() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let l = Launch {
            permissions: Permissions::AcceptEdits,
            account: Some("work".into()),
            ..agent()
        };
        approve_launch(&ptys, data.path(), &l).unwrap();
        let info = start(&ptys, data.path(), "a", l).0.unwrap();
        ptys.kill_all();
        assert_eq!(info.profile, "claude");
        assert_eq!(info.permissions, "accept-edits");
        assert_eq!(info.account.as_deref(), Some("work"));
    }

    #[test]
    fn startup_launch_runs_wrapper() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let (program, args) = shell("echo done");
        let l = Launch {
            profile: "shell".into(),
            program,
            args,
            agent: false,
            startup: vec!["echo hi".into()],
            ..agent()
        };
        let (info, output) = run_until(&ptys, data.path(), l, "done");
        assert_eq!(info.program, wrapper_shell());
        // The startup line runs first, then the program.
        let lines: Vec<&str> = output
            .split('\n')
            .map(|l| l.trim_end_matches('\r'))
            .collect();
        assert!(
            lines
                .windows(2)
                .any(|w| w[0].ends_with("hi") && w[1] == "done"),
            "output: {output:?}"
        );
    }

    #[test]
    fn startup_agent_is_gated_on_the_cli_not_the_wrapper() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let l = Launch {
            startup: vec!["echo hi".into()],
            ..agent()
        };
        approve_launch(&ptys, data.path(), &l).unwrap();
        let info = start(&ptys, data.path(), "a", l.clone()).0.unwrap();
        ptys.kill_all();
        assert_eq!(info.program, wrapper_shell());
        assert!(info.agent);
        let cli_print = agent_fingerprint(&l.program.to_string_lossy(), &l.args, "ask");
        assert_eq!(
            Policy::load(data.path()).unwrap().approved_agents,
            [cli_print]
        );
    }

    #[test]
    fn failed_early_start_does_not_leave_a_skip_pass() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let l = Launch {
            permissions: Permissions::Skip,
            ..agent()
        };
        approve_launch(&ptys, data.path(), &l).unwrap();
        let missing = spawn_launch(
            &ptys,
            data.path(),
            "m".into(),
            data.path().join("nope"),
            l.clone(),
            80,
            24,
            |_| {},
            |_| {},
        );
        assert_eq!(missing.unwrap_err().code, "not_found");
        assert!(ptys.passes().is_empty());
        let (later, _) = start(&ptys, data.path(), "a", l);
        assert_eq!(later.unwrap_err().code, "needs_approval");
    }

    #[test]
    fn launch_for_reports_unknown_and_bad_stores() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(
            launch_for(data.path(), "vim", None, None).unwrap_err().code,
            "unknown_profile"
        );
        std::fs::write(data.path().join("profiles.json"), "not json").unwrap();
        assert_eq!(
            launch_for(data.path(), "claude", None, None)
                .unwrap_err()
                .code,
            "bad_profiles"
        );
    }

    #[test]
    fn shell_spawns_without_policy() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let launch = launch_for(data.path(), "shell", None, None).unwrap();
        let (result, _) = start(&ptys, data.path(), "s", launch);
        assert!(!result.unwrap().agent);
        assert!(!data.path().join("audit.jsonl").exists());
        ptys.kill_all();
    }

    #[test]
    fn duplicate_id_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let launch = launch_for(data.path(), "shell", None, None).unwrap();
        start(&ptys, data.path(), "d", launch.clone()).0.unwrap();
        let (again, _) = start(&ptys, data.path(), "d", launch);
        assert_eq!(again.unwrap_err().code, "pty_exists");
        ptys.kill_all();
    }

    #[test]
    fn kill_all_ends_every_session() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let launch = launch_for(data.path(), "shell", None, None).unwrap();
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
        let launch = launch_for(data.path(), "shell", None, None).unwrap();
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

    fn entry(kind: ShellKind, program: &str, args: &[&str]) -> ShellEntry {
        ShellEntry {
            id: "s".into(),
            name: "S".into(),
            kind,
            program: program.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
        }
    }

    #[test]
    fn setup_command_ends_each_shell_with_the_script() {
        let script = "pnpm i\n\n  cargo fetch\n";
        let ps = setup_command(
            &entry(ShellKind::Powershell, "pwsh.exe", &["-NoLogo"]),
            script,
        );
        assert_eq!(ps.0, PathBuf::from("pwsh.exe"));
        assert_eq!(ps.1, ["-NoLogo", "-NoProfile", "-Command", script]);
        let cmd = setup_command(&entry(ShellKind::Cmd, "cmd.exe", &[]), script);
        assert_eq!(cmd.1, ["/D", "/C", "pnpm i & cargo fetch"]);
        let wsl = setup_command(&entry(ShellKind::Wsl, "wsl.exe", &["-d", "Ubuntu"]), script);
        assert_eq!(wsl.1, ["-d", "Ubuntu", "--exec", "sh", "-lc", script]);
        let login = setup_command(&entry(ShellKind::Login, "/bin/zsh", &["-l"]), script);
        assert_eq!(login.1, ["-l", "-c", script]);
        let custom = setup_command(&entry(ShellKind::Custom, "fish", &[]), script);
        assert_eq!(custom.1, ["-c", script]);
    }

    /// A data dir and a repo at `<tmp>/xdev` that the registry tracks.
    struct SetupFixture {
        _tmp: tempfile::TempDir,
        data: PathBuf,
        repo: PathBuf,
    }

    fn setup_fixture(local_setup: &str) -> SetupFixture {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let repo = tmp.path().join("xdev");
        std::fs::create_dir_all(&repo).unwrap();
        let mut reg = Workspace::load(&data).unwrap();
        reg.repos.push(xdev_workspace::RepoEntry {
            id: "abc".into(),
            short_name: "xdev".into(),
            path: repo.clone(),
            base_ref: "main".into(),
            worktree_root: tmp.path().join("wt"),
            local_setup: local_setup.into(),
            ..xdev_workspace::RepoEntry::default()
        });
        reg.save(&data).unwrap();
        SetupFixture {
            _tmp: tmp,
            data,
            repo,
        }
    }

    #[test]
    fn setup_launch_runs_the_local_script_in_the_default_shell() {
        let f = setup_fixture("echo hi");
        let l = setup_launch(&f.data, &f.repo).unwrap();
        assert_eq!(l.profile, SETUP_PROFILE);
        assert!(!l.agent);
        assert_eq!(l.args.last().map(String::as_str), Some("echo hi"));
        let env: HashMap<_, _> = l.env.iter().cloned().collect();
        assert_eq!(
            env["XDEV_ROOT_PATH"],
            OsString::from(f.repo.display().to_string())
        );
        assert_eq!(env["XDEV_WORKSPACE_NAME"], OsString::from("xdev"));
    }

    #[test]
    fn setup_launch_refuses_unknown_missing_and_untrusted() {
        let f = setup_fixture("");
        let code = |cwd: &Path| setup_launch(&f.data, cwd).unwrap_err().code;
        assert_eq!(code(&f.data), "worktree_unknown");
        assert_eq!(code(&f.repo), "hook_none");
        std::fs::write(f.repo.join("xdev.toml"), "[scripts]\nsetup = \"make\"\n").unwrap();
        assert_eq!(code(&f.repo), "hook_untrusted");
    }
}
