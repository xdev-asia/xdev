//! Terminals in the UI: a shell or an agent CLI in a pseudo console per tab.
//! An agent launch passes the policy gate first; a shell does not.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use xdev_agent::{
    AccountSource, Cli, Context, HookEvent, Launch, LaunchError, Permissions, Profile, Profiles,
    ShellEntry, ShellKind, TrustKind, TrustTarget, default_shell_id, find_builtin, find_program,
    list_shells, resolve, spec, trust_folder, wsl_distros,
};
use xdev_ai::Registry;
use xdev_policy::{Action, Audited, Policy, Verdict, agent_fingerprint};
use xdev_pty::client::Sink;
use xdev_pty::proto::SessionInfo;
use xdev_pty::{PtyError, Session, SpawnSpec};
use xdev_workspace::{
    HookKind, Registry as Workspace, SetupPolicy, WorkspaceError, hook_env, hooks_for,
};

use crate::accounts::data_dir;
use crate::commands::{AppState, CmdError, cli_beside};
use crate::ptyd::{self, LocalHost, PtyHost};
use crate::settings::{OnQuit, StatusSettings};
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    // Where `account` came from: the tab, the profile or the provider's
    // active account; null without an account.
    account_source: Option<AccountSource>,
    // Whether the launch got the status hook flags.
    hooks: bool,
    // The hook events the launch reports (version gate, codex private home or
    // notify alone); the UI picks its caps from these.
    hook_events: Vec<HookEvent>,
    // The CLI the profile runs, also for a custom profile; null for a shell
    // or an unknown program.
    cli: Option<Cli>,
    // A first prompt the UI types once the agent has started (after-start
    // agents, or a Windows shim that cannot take it as an argument).
    #[serde(default)]
    prompt_after: Option<String>,
}

/// Payload of the `pty://exit` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    id: String,
    code: Option<i32>,
}

/// What `pty_attach` returns: the tab's launch as it was spawned, and the
/// byte offset the output channel starts at; the client counts from there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PtyAttached {
    pub info: PtyInfo,
    pub seq: u64,
    /// The ring had dropped output before `from_seq`; the replay starts later.
    pub truncated: bool,
}

/// Where terminals run this app run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum PtydState {
    /// Settings → Terminal → "Terminal service" is off: in the app, as before.
    Off,
    Running,
    /// The service could not start or answer: in the app, and they end with it.
    Fallback,
    /// A service of an older build answers; it runs until restarted.
    OldVersion,
}

/// Payload of `ptyd_status` and the `ptyd://status` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PtydStatus {
    pub state: PtydState,
    pub service_version: Option<String>,
    /// The error code of a fallback.
    pub reason: Option<String>,
}

/// One live PTY, in the app (`Session`) or in the service.
pub trait PtyHandle: Send + Sync {
    fn write(&self, d: Vec<u8>);
    fn resize(&self, c: u16, r: u16) -> Result<(), PtyError>;
    fn ack(&self, n: usize);
    fn kill(&self);
    fn pid(&self) -> Option<u32>;
    /// A service PTY runs on when the app ends; one in the app does not.
    fn outlives_app(&self) -> bool {
        false
    }
}

impl PtyHandle for Session {
    fn write(&self, d: Vec<u8>) {
        Session::write(self, d)
    }
    fn resize(&self, c: u16, r: u16) -> Result<(), PtyError> {
        Session::resize(self, c, r)
    }
    fn ack(&self, n: usize) {
        Session::ack(self, n)
    }
    fn kill(&self) {
        Session::kill(self)
    }
    fn pid(&self) -> Option<u32> {
        Session::pid(self)
    }
}

pub struct Ptys {
    sessions: Mutex<HashMap<String, Box<dyn PtyHandle>>>,
    /// Ids a spawn or attach has taken and not filled yet, each with the
    /// ticket of the call that holds it. Locked after `sessions`, never
    /// before.
    claims: Mutex<HashMap<String, u64>>,
    /// Signalled when a claim ends, filled or not.
    claim_ended: Condvar,
    next_claim: AtomicU64,
    /// Fingerprints of skip-mode launches a person has just approved. A start
    /// takes its fingerprint out, so each approval covers one start.
    passes: Mutex<HashSet<String>>,
    /// None until the start has picked one from the setting and the service.
    host: Mutex<Option<(Arc<dyn PtyHost>, PtydStatus)>>,
    host_set: Condvar,
    /// The UI's answer to "On quit: Ask"; none until it answers.
    quit_choice: Mutex<Option<bool>>,
    /// The folder each PTY started in, so the app CLI knows its caller's worktree.
    cwds: Mutex<HashMap<String, PathBuf>>,
}

impl Default for Ptys {
    /// In the app, as with the service off; tests start from here.
    fn default() -> Ptys {
        let ptys = Ptys::pending();
        ptys.set_host(
            Arc::new(LocalHost),
            ptyd::status(PtydState::Off, None, None),
        );
        ptys
    }
}

/// How long a spawn waits for the start to pick a host: the service's own
/// start wait, and a little more.
const HOST_WAIT: Duration = Duration::from_secs(8);

/// How long a write, resize or ack waits for a spawn or attach of its id to
/// land: the host wait, and the spawn after it.
const CLAIM_WAIT: Duration = Duration::from_secs(16);

impl Ptys {
    fn map(&self) -> MutexGuard<'_, HashMap<String, Box<dyn PtyHandle>>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// No host yet: terminals wait for `set_host`.
    pub(crate) fn pending() -> Ptys {
        Ptys {
            sessions: Mutex::default(),
            claims: Mutex::default(),
            claim_ended: Condvar::new(),
            next_claim: AtomicU64::new(0),
            passes: Mutex::default(),
            host: Mutex::new(None),
            host_set: Condvar::new(),
            quit_choice: Mutex::new(None),
            cwds: Mutex::default(),
        }
    }

    /// The host if one is set, without waiting.
    pub(crate) fn peek_host(&self) -> Option<Arc<dyn PtyHost>> {
        let host = self.host.lock().unwrap_or_else(PoisonError::into_inner);
        host.as_ref().map(|(h, _)| h.clone())
    }

    /// Back to no host: terminals wait for the next `set_host`.
    pub(crate) fn clear_host(&self) {
        *self.host.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    pub(crate) fn set_quit_choice(&self, end: bool) {
        *self
            .quit_choice
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(end);
    }

    /// On app exit. PTYs in the app always end with it; the service's end
    /// only for "End all", or "Ask" answered with End. Unanswered, Ask keeps
    /// them, as Keep running does.
    pub fn quit(&self, on_quit: OnQuit) {
        let end = match on_quit {
            OnQuit::Keep => false,
            OnQuit::End => true,
            OnQuit::Ask => {
                *self
                    .quit_choice
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    == Some(true)
            }
        };
        // Taken out first, so killing never runs under the lock.
        let handles = std::mem::take(&mut *self.map());
        for handle in handles.values() {
            if end || !handle.outlives_app() {
                handle.kill();
            }
        }
        // Also the ones no tab of this run holds, from earlier runs.
        if end && let Some(client) = self.peek_host().and_then(|h| h.service()) {
            let _ = client.quit_all();
        }
    }

    /// The host and its status; the app's own when none was set in time.
    pub(crate) fn host_status(&self) -> (Arc<dyn PtyHost>, PtydStatus) {
        let guard = self.host.lock().unwrap_or_else(PoisonError::into_inner);
        let (guard, _) = self
            .host_set
            .wait_timeout_while(guard, HOST_WAIT, |h| h.is_none())
            .unwrap_or_else(PoisonError::into_inner);
        guard.clone().unwrap_or_else(|| {
            let reason = Some("ptyd_unreachable".to_owned());
            (
                Arc::new(LocalHost) as Arc<dyn PtyHost>,
                ptyd::status(PtydState::Fallback, None, reason),
            )
        })
    }

    pub(crate) fn host(&self) -> Arc<dyn PtyHost> {
        self.host_status().0
    }

    pub(crate) fn set_host(&self, host: Arc<dyn PtyHost>, status: PtydStatus) {
        *self.host.lock().unwrap_or_else(PoisonError::into_inner) = Some((host, status));
        self.host_set.notify_all();
    }

    fn cwds(&self) -> MutexGuard<'_, HashMap<String, PathBuf>> {
        self.cwds.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The terminals this app holds, each with the pid at its root and the folder it
    /// started in. A terminal without a pid or a folder is left out.
    pub(crate) fn roots(&self) -> Vec<xdev_ports::PtyRoot> {
        let cwds = self.cwds().clone();
        self.map()
            .iter()
            .filter_map(|(id, handle)| {
                Some(xdev_ports::PtyRoot {
                    pid: handle.pid()?,
                    worktree: cwds.get(id)?.clone(),
                })
            })
            .collect()
    }

    /// The pid of the terminal service, when the terminals run in it.
    pub(crate) fn service_pid(&self) -> Option<u32> {
        Some(self.host().service()?.welcome().pid)
    }

    /// The folder the PTY `id` started in; none for an unknown id.
    pub(crate) fn cwd_of(&self, id: &str) -> Option<PathBuf> {
        self.cwds().get(id).cloned()
    }

    fn passes(&self) -> MutexGuard<'_, HashSet<String>> {
        self.passes.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Ends every PTY this app run holds.
    #[cfg(test)]
    pub fn kill_all(&self) {
        // Taken out first, so killing never runs under the lock.
        let sessions = std::mem::take(&mut *self.map());
        for session in sessions.values() {
            session.kill();
        }
    }

    fn claims(&self) -> MutexGuard<'_, HashMap<String, u64>> {
        self.claims.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes `id` for a spawn or attach, which then runs without the lock:
    /// `pty_exists` while a PTY or another claim has it.
    fn claim(&self, id: &str) -> Result<Claim<'_>, CmdError> {
        let map = self.map();
        let mut claims = self.claims();
        if map.contains_key(id) || claims.contains_key(id) {
            return Err(CmdError {
                code: "pty_exists",
                detail: None,
            });
        }
        let ticket = self.next_claim.fetch_add(1, Ordering::Relaxed);
        claims.insert(id.to_owned(), ticket);
        Ok(Claim {
            ptys: self,
            id: id.to_owned(),
            ticket,
        })
    }

    /// Lets go of `id`: its PTY, for the caller to end, or else the claim of
    /// a spawn or attach still under way, which then ends what it gets. The
    /// one place an id's folder is forgotten.
    fn take(&self, id: &str) -> Option<Box<dyn PtyHandle>> {
        let handle = {
            let mut map = self.map();
            let handle = map.remove(id);
            if handle.is_none() && self.claims().remove(id).is_some() {
                self.claim_ended.notify_all();
            }
            handle
        };
        self.cwds().remove(id);
        handle
    }

    pub(crate) fn with<T>(
        &self,
        id: &str,
        f: impl FnOnce(&dyn PtyHandle) -> T,
    ) -> Result<T, CmdError> {
        // Output, and so acks, can come before the spawn returns; a call for
        // an id still being spawned or attached waits for it to land.
        let claims = self.claims();
        let (claims, _) = self
            .claim_ended
            .wait_timeout_while(claims, CLAIM_WAIT, |c| c.contains_key(id))
            .unwrap_or_else(PoisonError::into_inner);
        drop(claims);
        self.map().get(id).map(|h| f(h.as_ref())).ok_or(CmdError {
            code: "pty_unknown",
            detail: None,
        })
    }
}

/// An id taken for a PTY that is not there yet. Dropped unfilled, it lets
/// the id go.
struct Claim<'a> {
    ptys: &'a Ptys,
    id: String,
    ticket: u64,
}

impl Claim<'_> {
    /// Puts `handle` in the id's place. When the id was let go meanwhile (its
    /// tab closed), the PTY is ended instead and the call fails `pty_gone`.
    fn fill(self, handle: Box<dyn PtyHandle>) -> Result<(), CmdError> {
        {
            let mut map = self.ptys.map();
            let mut claims = self.ptys.claims();
            if claims.get(&self.id) == Some(&self.ticket) {
                claims.remove(&self.id);
                map.insert(self.id.clone(), handle);
                return Ok(());
            }
        }
        handle.kill();
        Err(CmdError {
            code: "pty_gone",
            detail: None,
        })
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        let mut claims = self.ptys.claims();
        if claims.get(&self.id) == Some(&self.ticket) {
            claims.remove(&self.id);
        }
        // Filled or not, the claim is over.
        self.ptys.claim_ended.notify_all();
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
/// that `xdev`. With `resume`, the CLI continues that session (`add_resume`).
pub(crate) fn launch_for(
    data_dir: &Path,
    id: &str,
    account: Option<&str>,
    hooks: Option<&Path>,
    resume: Option<&str>,
    fork: bool,
) -> Result<Launch, CmdError> {
    launch_with_prompt(data_dir, id, account, hooks, resume, fork, None)
}

/// `launch_for` with a first prompt for the agent (`Launch::prompt_argv` or
/// `prompt_after`).
pub(crate) fn launch_with_prompt(
    data_dir: &Path,
    id: &str,
    account: Option<&str>,
    hooks: Option<&Path>,
    resume: Option<&str>,
    fork: bool,
    prompt: Option<&str>,
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
        prompt,
    };
    let mut launch = resolve(id, &ctx)?;
    match (resume, fork) {
        (Some(session), true) => add_fork(&mut launch, session)?,
        (Some(session), false) => add_resume(&mut launch, session)?,
        (None, true) => return Err(crate::workspace::bad_arg("fork")),
        (None, false) => {}
    }
    if let Some(xdev) = hooks {
        launch.add_hooks(xdev, data_dir);
    }
    Ok(launch)
}

/// The longest session id a resume takes.
const RESUME_ID_MAX: usize = 128;

/// `add_resume`'s id and CLI rules, shared with `add_fork`.
fn check_session_id(launch: &Launch, id: &str, arg: &'static str) -> Result<(), CmdError> {
    let plain = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    if id.is_empty() || id.len() > RESUME_ID_MAX || !id.chars().all(plain) || !launch.agent {
        return Err(crate::workspace::bad_arg(arg));
    }
    Ok(())
}

/// Adds the args that make an agent CLI continue a copy of session `id`
/// under a new session id: Claude `--resume <id> --fork-session` at the end;
/// Codex the `fork <id>` subcommand first. Same id rules as `add_resume`.
pub(crate) fn add_fork(launch: &mut Launch, id: &str) -> Result<(), CmdError> {
    check_session_id(launch, id, "fork")?;
    match launch.cli {
        Some(Cli::Claude) => launch.args.extend([
            "--resume".to_owned(),
            id.to_owned(),
            "--fork-session".to_owned(),
        ]),
        Some(Cli::Codex) => {
            launch.args.splice(0..0, ["fork".to_owned(), id.to_owned()]);
        }
        _ => return Err(crate::workspace::bad_arg("fork")),
    }
    Ok(())
}

/// Adds the args that make an agent CLI continue session `id`: Claude
/// `--resume <id>` at the end; Codex the `resume <id>` subcommand first, as
/// `codex resume` takes the same options as a plain launch. The id is
/// `[A-Za-z0-9_-]`, at most 128 chars. A shell or a custom program cannot
/// resume.
pub(crate) fn add_resume(launch: &mut Launch, id: &str) -> Result<(), CmdError> {
    check_session_id(launch, id, "resume")?;
    match launch.cli {
        Some(Cli::Claude) => launch.args.extend(["--resume".to_owned(), id.to_owned()]),
        Some(Cli::Codex) => {
            launch
                .args
                .splice(0..0, ["resume".to_owned(), id.to_owned()]);
        }
        _ => return Err(crate::workspace::bad_arg("resume")),
    }
    Ok(())
}

/// How long folder trust may delay a start; codex's private `config.toml`
/// may sit behind a slow disk or a sync client.
const TRUST_WAIT: Duration = Duration::from_millis(1500);
const TRUST_WAIT_CODEX: Duration = Duration::from_secs(20);

/// Folder trust to write before an agent starts.
pub(crate) struct TrustPlan {
    kind: TrustKind,
    folder: PathBuf,
    target: TrustTarget,
}

/// The trust a fresh agent launch gets, or `None`: the setting is off, the
/// launch resumes or forks a session, the program is a shell or custom, or
/// the agent has no trust store. `env` is the launch env, `proc_env` the
/// process one.
pub(crate) fn trust_plan(
    launch: &Launch,
    cwd: &Path,
    data_dir: &Path,
    home: Option<PathBuf>,
    enabled: bool,
    fresh: bool,
    proc_env: &dyn Fn(&str) -> Option<OsString>,
) -> Option<TrustPlan> {
    if !enabled || !fresh || !launch.agent {
        return None;
    }
    let cli = launch.cli?;
    let kind = spec(cli).trust?;
    let var = |name: &str| {
        launch
            .env
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .or_else(|| proc_env(name))
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    // Only the private home xDev runs codex on; never the person's own.
    let private = data_dir.join(xdev_agent::CODEX_HOME_DIR);
    let codex_home = var("CODEX_HOME").filter(|dir| dir.starts_with(&private));
    Some(TrustPlan {
        kind,
        folder: cwd.to_path_buf(),
        target: TrustTarget {
            home: home?,
            claude_config: var("CLAUDE_CONFIG_DIR"),
            kimi_home: var("KIMI_CODE_HOME"),
            codex_home,
        },
    })
}

/// Runs `work` on its own thread and waits at most `deadline` for its
/// result; `None` when it is still running then (it carries on in the
/// background, a write is atomic either way).
pub(crate) fn run_with_deadline<T: Send + 'static>(
    deadline: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(work());
    });
    rx.recv_timeout(deadline).ok()
}

/// Writes the trust of `plan` within its deadline. A failure or a timeout is
/// logged and the launch goes on untrusted.
fn apply_trust(plan: TrustPlan) {
    let wait = if plan.kind == TrustKind::Codex {
        TRUST_WAIT_CODEX
    } else {
        TRUST_WAIT
    };
    let kind = plan.kind;
    match run_with_deadline(wait, move || {
        trust_folder(plan.kind, &plan.folder, &plan.target)
    }) {
        Some(Ok(())) => {}
        Some(Err(e)) => eprintln!("folder trust for {kind:?}: {}: {e}", e.code()),
        None => eprintln!("folder trust for {kind:?} timed out"),
    }
}

/// Gates an agent, then starts `launch` in `cwd` (no folder trust).
#[cfg(test)]
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
    spawn_launch_trusted(
        ptys, data_dir, id, cwd, launch, cols, rows, None, on_output, on_exit,
    )
}

/// `spawn_launch` that first writes `trust`, once the policy gate has passed:
/// a launch that is refused trusts nothing.
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_launch_trusted(
    ptys: &Ptys,
    data_dir: &Path,
    id: String,
    cwd: PathBuf,
    launch: Launch,
    cols: u16,
    rows: u16,
    trust: Option<TrustPlan>,
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
    // Not under the lock: the host may wait for the service to start, and a
    // spawn there is a round trip.
    let claim = ptys.claim(&id)?;
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
    if let Some(plan) = trust {
        apply_trust(plan);
    }
    let (program, args) = launch.command();
    let prompt_after = launch.prompt_after;
    let mut env = launch.env;
    // The PATH `agents_refresh` read, unless the profile sets its own.
    if let Some(path) = xdev_agent::path_override()
        && !env.iter().any(|(k, _)| k.eq_ignore_ascii_case("PATH"))
    {
        env.push(("PATH".to_owned(), path));
    }
    env.push(("XDEV_PTY_ID".to_owned(), OsString::from(&id)));
    // Agents run `xdev orchestration ...` from here.
    if let Ok(exe) = std::env::current_exe() {
        crate::cli_path::cli_env(&exe, &mut env);
    }
    let mut info = PtyInfo {
        id: id.clone(),
        pid: None,
        program: program.display().to_string(),
        agent: launch.agent,
        profile: launch.profile,
        permissions: launch.permissions.as_str().to_owned(),
        account: launch.account,
        account_source: launch.account_source,
        hooks: launch.hooks,
        hook_events: launch.hook_events,
        cli: launch.cli,
        prompt_after,
    };
    // What the service lists the PTY with; `info` comes back on attach.
    let meta = serde_json::json!({
        "worktree": cwd.display().to_string(),
        "tabId": id,
        "profile": info.profile,
        "info": info,
    });
    ptys.cwds().insert(id.clone(), cwd.clone());
    let spec = SpawnSpec {
        program,
        args,
        env,
        cwd,
        cols,
        rows,
    };
    let sink = Sink {
        on_output: Box::new(on_output),
        on_exit: Box::new(on_exit),
    };
    let handle = ptys.host().spawn(&id, spec, meta, sink).inspect_err(|_| {
        ptys.cwds().remove(&id);
    })?;
    info.pid = handle.pid();
    claim.fill(handle).inspect_err(|_| {
        ptys.cwds().remove(&id);
    })?;
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

/// The program and args that run `script` in `shell` and end with it, as
/// the gate and the audit see them. CMD reads one line from `/C`, so
/// `hook_command` swaps its script for a batch file (`cmd_file`) when it
/// runs. A WSL shell runs it with `sh -lc` in its distro.
pub(crate) fn setup_command(shell: &ShellEntry, script: &str) -> (PathBuf, Vec<String>) {
    let own = |args: &[&str]| -> Vec<String> {
        args.iter()
            .map(|a| (*a).to_owned())
            .chain([script.to_owned()])
            .collect()
    };
    let args = match shell.kind {
        ShellKind::Powershell => own(&["-NoLogo", "-NoProfile", "-Command"]),
        ShellKind::Cmd => own(&["/D", "/C"]),
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

/// The data dir folder of the batch files CMD runs hook scripts from.
const CMD_SCRIPTS: &str = "hook-scripts";

/// `script` as a batch file in the data dir, named by the blake3 of its
/// content so the same script is written once and two runs never write
/// over a file the other is reading. The lines are the script's own, with
/// CRLF ends and `@echo off` first, as one `/C` line printed nothing but
/// the output.
fn cmd_file(data_dir: &Path, script: &str) -> io::Result<PathBuf> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = data_dir.join(CMD_SCRIPTS);
    fs::create_dir_all(&dir)?;
    let mut body = String::from("@echo off\r\n");
    for line in script.lines() {
        body.push_str(line);
        body.push_str("\r\n");
    }
    let path = dir.join(format!("{}.cmd", blake3::hash(body.as_bytes()).to_hex()));
    let written = |path: &Path| fs::read(path).is_ok_and(|b| b == body.as_bytes());
    if written(&path) {
        return Ok(path);
    }
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".{}-{n}.tmp", std::process::id()));
    fs::write(&tmp, &body)?;
    match fs::rename(&tmp, &path) {
        Ok(()) => Ok(path),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            // Another run may have put the same file there first.
            if written(&path) { Ok(path) } else { Err(e) }
        }
    }
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
        // Lists, not scripts: nothing to run.
        HookKind::Shared | HookKind::Tabs | HookKind::IssueCommand => return Ok(None),
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
    let mut args = args;
    if shell.kind == ShellKind::Cmd
        && let Some(last) = args.last_mut()
    {
        *last = cmd_file(data_dir, &script.text)?.display().to_string();
    }
    Ok(Some(HookCommand { program, args, env }))
}

/// The launch that runs the setup script of the worktree at `cwd` in a
/// terminal; `setup_skipped` when the repo's setup policy is Skip,
/// `hook_none` when it has no setup.
pub(crate) fn setup_launch(data_dir: &Path, cwd: &Path) -> Result<Launch, CmdError> {
    let reg = Workspace::load(data_dir)?;
    if hooks_for(&reg, data_dir, cwd)?.policy == SetupPolicy::Skip {
        return Err(WorkspaceError::SetupSkipped.into());
    }
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
        account_source: None,
        startup: Vec::new(),
        cli: None,
        hooks: false,
        hook_events: Vec::new(),
        prompt_after: None,
        prompt_argv: Vec::new(),
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
    resume: Option<String>,
    fork: Option<bool>,
    prompt: Option<String>,
) -> Result<PtyInfo, CmdError> {
    let data = data_dir(&state)?;
    let launch = if profile_id == SETUP_PROFILE {
        setup_launch(data, &cwd)?
    } else {
        let hooks = hooks_now(&app);
        launch_with_prompt(
            data,
            &profile_id,
            account.as_deref(),
            hooks.as_deref(),
            resume.as_deref(),
            fork.unwrap_or(false),
            prompt.as_deref(),
        )?
    };
    let exit_id = id.clone();
    let feed_id = id.clone();
    let feed_cwd = cwd.clone();
    let feed_app = app.clone();
    let trust = trust_plan(
        &launch,
        &cwd,
        data,
        app.path().home_dir().ok(),
        settings_store::read(&app).agents.workspace_trust,
        resume.is_none() && !fork.unwrap_or(false),
        &|name| std::env::var_os(name),
    );
    spawn_launch_trusted(
        &ptys,
        data,
        id,
        cwd,
        launch,
        cols,
        rows,
        trust,
        move |bytes| {
            crate::ports::feed_output(&feed_app, &feed_id, &feed_cwd, &bytes);
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
    resume: Option<String>,
    fork: Option<bool>,
) -> Result<(), CmdError> {
    let data = data_dir(&state)?;
    let hooks = hooks_now(&app);
    let launch = launch_for(
        data,
        &profile_id,
        account.as_deref(),
        hooks.as_deref(),
        resume.as_deref(),
        fork.unwrap_or(false),
    )?;
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
pub fn pty_kill(ptys: State<'_, Ptys>, ports: State<'_, crate::ports::Ports>, id: String) {
    pty_kill_in(&ptys, &ports, &id);
}

fn pty_kill_in(ptys: &Ptys, ports: &crate::ports::Ports, id: &str) {
    ports.forget_pty(id);
    // An unknown id has already ended. A service PTY ends only on `kill`.
    let handle = ptys.take(id);
    if let Some(handle) = handle {
        handle.kill();
    }
}

/// Reattaches a tab to the service's PTY `id`; the channel replays its ring
/// from `from_seq`. `pty_gone` when the service does not hold it.
#[tauri::command(async)]
pub fn pty_attach(
    app: AppHandle,
    ptys: State<'_, Ptys>,
    id: String,
    from_seq: u64,
    out: Channel<InvokeResponseBody>,
) -> Result<PtyAttached, CmdError> {
    let host = ptys.host();
    let gone = || CmdError {
        code: "pty_gone",
        detail: None,
    };
    let client = host.service().ok_or_else(gone)?;
    let listed = client.list()?.into_iter().find(|s| s.id == id);
    let session = listed.ok_or_else(gone)?;
    let exit_id = id.clone();
    let feed_id = id.clone();
    let feed_cwd = session.meta["worktree"].as_str().map(PathBuf::from);
    let feed_app = app.clone();
    let sink = Sink {
        on_output: Box::new(move |bytes| {
            if let Some(cwd) = &feed_cwd {
                crate::ports::feed_output(&feed_app, &feed_id, cwd, &bytes);
            }
            let _ = out.send(InvokeResponseBody::Raw(bytes));
        }),
        on_exit: Box::new(move |code| {
            let _ = app.emit("pty://exit", PtyExit { id: exit_id, code });
        }),
    };
    let claim = ptys.claim(&id)?;
    let (handle, attached) = host.attach(&id, from_seq, sink)?;
    if let Some(cwd) = session.meta["worktree"].as_str() {
        ptys.cwds().insert(id.clone(), PathBuf::from(cwd));
    }
    claim.fill(handle).inspect_err(|_| {
        ptys.cwds().remove(&id);
    })?;
    Ok(PtyAttached {
        info: info_of(&id, &session),
        seq: attached.seq,
        truncated: attached.truncated,
    })
}

/// The launch the service listed `session` with; a plain shell when the
/// meta is not one this build wrote.
fn info_of(id: &str, session: &SessionInfo) -> PtyInfo {
    let mut info =
        serde_json::from_value::<PtyInfo>(session.meta["info"].clone()).unwrap_or(PtyInfo {
            id: id.to_owned(),
            pid: None,
            program: session.program.clone(),
            agent: false,
            profile: "shell".to_owned(),
            permissions: Permissions::Ask.as_str().to_owned(),
            account: None,
            account_source: None,
            hooks: false,
            hook_events: Vec::new(),
            cli: None,
            prompt_after: None,
        });
    info.id = id.to_owned();
    info.pid = session.pid;
    info
}

#[tauri::command(async)]
pub fn ptyd_status(ptys: State<'_, Ptys>) -> PtydStatus {
    ptys.host_status().1
}

#[tauri::command(async)]
pub fn ptyd_sessions(ptys: State<'_, Ptys>) -> Result<Vec<SessionInfo>, CmdError> {
    match ptys.host().service() {
        Some(client) => Ok(client.list()?),
        None => Ok(Vec::new()),
    }
}

#[tauri::command(async)]
pub fn ptyd_end(ptys: State<'_, Ptys>, id: String) -> Result<(), CmdError> {
    let client = ptys.host().service().ok_or_else(unreachable_service)?;
    // A tab of this run lets go of it; its exit event follows.
    let handle = ptys.take(&id);
    drop(handle);
    client.kill(&id);
    Ok(())
}

/// Every PTY in the service; the service itself ends on its own once idle.
#[tauri::command(async)]
pub fn ptyd_end_all(ptys: State<'_, Ptys>) -> Result<(), CmdError> {
    let client = ptys.host().service().ok_or_else(unreachable_service)?;
    for session in client.list()? {
        let handle = ptys.take(&session.id);
        drop(handle);
        client.kill(&session.id);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn ptyd_restart(app: AppHandle, state: State<'_, AppState>) -> Result<(), CmdError> {
    ptyd::restart(&app, state.local_dir.as_deref())
}

/// The UI's answer to "On quit: Ask", given before it closes the window.
#[tauri::command]
pub fn ptyd_quit_choice(ptys: State<'_, Ptys>, end: bool) {
    ptys.set_quit_choice(end);
}

fn unreachable_service() -> CmdError {
    CmdError {
        code: "ptyd_unreachable",
        detail: None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

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
            account_source: None,
            startup: vec![],
            cli: Some(Cli::Claude),
            hooks: false,
            hook_events: Vec::new(),
            prompt_after: None,
            prompt_argv: Vec::new(),
        }
    }

    fn hooked() -> Launch {
        let mut l = agent();
        l.add_hooks_with(Path::new("/opt/xdev"), None, None);
        l
    }

    /// Records each spawn it is asked for; nothing runs.
    #[derive(Default)]
    struct FakeHost {
        spawns: Mutex<Vec<(String, serde_json::Value)>>,
    }

    struct FakePty;

    impl PtyHandle for FakePty {
        fn write(&self, _: Vec<u8>) {}
        fn resize(&self, _: u16, _: u16) -> Result<(), PtyError> {
            Ok(())
        }
        fn ack(&self, _: usize) {}
        fn kill(&self) {}
        fn pid(&self) -> Option<u32> {
            Some(4242)
        }
    }

    impl PtyHost for FakeHost {
        fn spawn(
            &self,
            id: &str,
            _spec: SpawnSpec,
            meta: serde_json::Value,
            _sink: Sink,
        ) -> Result<Box<dyn PtyHandle>, CmdError> {
            self.spawns.lock().unwrap().push((id.to_owned(), meta));
            Ok(Box::new(FakePty))
        }
    }

    #[test]
    fn the_gate_runs_before_the_host_hears_of_a_spawn() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let host = Arc::new(FakeHost::default());
        ptys.set_host(host.clone(), ptyd::status(PtydState::Running, None, None));
        let (first, _) = start(&ptys, data.path(), "a", agent());
        assert_eq!(first.unwrap_err().code, "needs_approval");
        assert!(host.spawns.lock().unwrap().is_empty());

        approve_launch(&ptys, data.path(), &agent()).unwrap();
        let info = start(&ptys, data.path(), "a", agent()).0.unwrap();
        assert_eq!(info.pid, Some(4242));
        let spawns = host.spawns.lock().unwrap();
        assert_eq!(spawns.len(), 1);
        let (id, meta) = &spawns[0];
        assert_eq!(id, "a");
        assert_eq!(meta["tabId"], "a");
        assert_eq!(meta["profile"], "claude");
        assert_eq!(meta["worktree"], std::env::temp_dir().display().to_string());
        assert_eq!(meta["info"]["agent"], true);
    }

    #[test]
    fn roots_pair_a_pid_with_the_folder_each_terminal_started_in() {
        let ptys = Ptys::default();
        // FakePty reports pid 4242; `Held` has none.
        ptys.map().insert("a".into(), Box::new(FakePty));
        ptys.map().insert("b".into(), Box::new(FakePty));
        ptys.map().insert(
            "nopid".into(),
            Box::new(Held {
                killed: Arc::default(),
                outlives: false,
            }),
        );
        ptys.map().insert("nocwd".into(), Box::new(FakePty));
        ptys.cwds().insert("a".into(), PathBuf::from("/w/a"));
        ptys.cwds().insert("b".into(), PathBuf::from("/w/b"));
        ptys.cwds().insert("nopid".into(), PathBuf::from("/w/c"));
        let mut roots = ptys.roots();
        roots.sort_by(|x, y| x.worktree.cmp(&y.worktree));
        assert_eq!(
            roots,
            vec![
                xdev_ports::PtyRoot {
                    pid: 4242,
                    worktree: PathBuf::from("/w/a")
                },
                xdev_ports::PtyRoot {
                    pid: 4242,
                    worktree: PathBuf::from("/w/b")
                },
            ]
        );
    }

    /// Records whether it was killed; `outlives` stands for a service PTY.
    struct Held {
        killed: Arc<std::sync::atomic::AtomicBool>,
        outlives: bool,
    }

    impl PtyHandle for Held {
        fn write(&self, _: Vec<u8>) {}
        fn resize(&self, _: u16, _: u16) -> Result<(), PtyError> {
            Ok(())
        }
        fn ack(&self, _: usize) {}
        fn kill(&self) {
            self.killed.store(true, Ordering::SeqCst);
        }
        fn pid(&self) -> Option<u32> {
            None
        }
        fn outlives_app(&self) -> bool {
            self.outlives
        }
    }

    /// Quits with one service PTY and one in the app; which were killed.
    fn quit_with(on_quit: OnQuit, choice: Option<bool>) -> (bool, bool) {
        let ptys = Ptys::default();
        let flags = [false, true].map(|outlives| {
            let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let id = if outlives { "service" } else { "local" };
            ptys.map().insert(
                id.into(),
                Box::new(Held {
                    killed: killed.clone(),
                    outlives,
                }),
            );
            killed
        });
        if let Some(end) = choice {
            ptys.set_quit_choice(end);
        }
        ptys.quit(on_quit);
        assert!(ptys.map().is_empty());
        let [local, service] = flags.map(|f| f.load(Ordering::SeqCst));
        (local, service)
    }

    #[test]
    fn quit_keeps_service_ptys_for_keep_and_ends_them_for_end() {
        // (local killed, service killed)
        assert_eq!(quit_with(OnQuit::Keep, None), (true, false));
        assert_eq!(quit_with(OnQuit::End, None), (true, true));
        // A Keep answer to a stale Ask changes nothing for Keep or End.
        assert_eq!(quit_with(OnQuit::Keep, Some(true)), (true, false));
    }

    #[test]
    fn quit_with_ask_follows_the_ui_answer_and_keeps_when_unanswered() {
        assert_eq!(quit_with(OnQuit::Ask, None), (true, false));
        assert_eq!(quit_with(OnQuit::Ask, Some(false)), (true, false));
        assert_eq!(quit_with(OnQuit::Ask, Some(true)), (true, true));
    }

    #[test]
    fn attach_reads_the_launch_back_from_the_meta() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let host = Arc::new(FakeHost::default());
        ptys.set_host(host.clone(), ptyd::status(PtydState::Running, None, None));
        approve_launch(&ptys, data.path(), &agent()).unwrap();
        let spawned = start(&ptys, data.path(), "a", agent()).0.unwrap();
        let meta = host.spawns.lock().unwrap()[0].1.clone();
        let session = SessionInfo {
            id: "a".into(),
            pid: Some(77),
            program: "sh".into(),
            cwd: "/".into(),
            started_ms: 0,
            last_output_ms: 0,
            last_input_ms: 0,
            meta,
            attached: false,
            exited: None,
        };
        let info = info_of("a", &session);
        assert_eq!(info.pid, Some(77));
        assert_eq!(
            PtyInfo {
                pid: Some(4242),
                ..info
            },
            spawned
        );
        // Meta from another build: a plain shell, never an agent.
        let other = SessionInfo {
            meta: serde_json::json!({ "x": 1 }),
            ..session
        };
        let info = info_of("a", &other);
        assert!(!info.agent);
        assert_eq!(info.program, "sh");
    }

    #[test]
    fn an_app_host_has_nothing_to_attach() {
        let (s, _) = std::sync::mpsc::channel::<()>();
        let sink = Sink {
            on_output: Box::new(|_| {}),
            on_exit: Box::new(move |_| drop(s)),
        };
        let err = LocalHost.attach("a", 0, sink).err().unwrap();
        assert_eq!(err.code, "pty_gone");
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
        let shell = launch_for(
            data.path(),
            "shell",
            None,
            Some(Path::new("/opt/xdev")),
            None,
            false,
        )
        .unwrap();
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
    fn a_claimed_id_is_taken_until_filled_or_let_go() {
        let ptys = Ptys::default();
        let claim = ptys.claim("a").unwrap();
        assert_eq!(ptys.claim("a").err().unwrap().code, "pty_exists");
        drop(claim);
        let claim = ptys.claim("a").unwrap();
        claim.fill(Box::new(FakePty)).unwrap();
        assert_eq!(ptys.claim("a").err().unwrap().code, "pty_exists");
        assert_eq!(ptys.with("a", |h| h.pid()).unwrap(), Some(4242));
    }

    #[test]
    fn a_call_for_a_claimed_id_waits_for_it_to_land() {
        let ptys = Ptys::default();
        let claim = ptys.claim("a").unwrap();
        std::thread::scope(|s| {
            let ack = s.spawn(|| ptys.with("a", |h| h.pid()));
            std::thread::sleep(Duration::from_millis(50));
            claim.fill(Box::new(FakePty)).unwrap();
            assert_eq!(ack.join().unwrap().unwrap(), Some(4242));
        });
    }

    /// Lets go of the id while its spawn is under way, as a tab closed then
    /// would, and notes whether the PTY map was free meanwhile.
    struct ClosingHost {
        ptys: OnceLock<std::sync::Weak<Ptys>>,
        killed: Arc<std::sync::atomic::AtomicBool>,
        map_free: std::sync::atomic::AtomicBool,
    }

    impl PtyHost for ClosingHost {
        fn spawn(
            &self,
            id: &str,
            _spec: SpawnSpec,
            _meta: serde_json::Value,
            _sink: Sink,
        ) -> Result<Box<dyn PtyHandle>, CmdError> {
            let ptys = self.ptys.get().unwrap().upgrade().unwrap();
            let free = ptys.sessions.try_lock().is_ok();
            self.map_free.store(free, Ordering::SeqCst);
            assert!(ptys.cwd_of(id).is_some());
            assert!(ptys.take(id).is_none());
            assert!(ptys.cwd_of(id).is_none());
            // As an attach would, record the folder after the id was let go:
            // the failed fill must forget it again.
            ptys.cwds().insert(id.to_owned(), PathBuf::from("late"));
            Ok(Box::new(Held {
                killed: self.killed.clone(),
                outlives: true,
            }))
        }
    }

    #[test]
    fn a_tab_closed_during_its_spawn_ends_the_pty() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Arc::new(Ptys::default());
        let host = Arc::new(ClosingHost {
            ptys: OnceLock::new(),
            killed: Arc::default(),
            map_free: Default::default(),
        });
        let _ = host.ptys.set(Arc::downgrade(&ptys));
        ptys.set_host(host.clone(), ptyd::status(PtydState::Running, None, None));
        let launch = launch_for(data.path(), "shell", None, None, None, false).unwrap();
        let (result, _) = start(&ptys, data.path(), "c", launch.clone());
        assert_eq!(result.unwrap_err().code, "pty_gone");
        assert!(host.map_free.load(Ordering::SeqCst));
        assert!(host.killed.load(Ordering::SeqCst));
        assert!(ptys.map().is_empty());
        assert!(ptys.cwd_of("c").is_none());
        // The id is free again.
        ptys.set_host(
            Arc::new(FakeHost::default()),
            ptyd::status(PtydState::Running, None, None),
        );
        start(&ptys, data.path(), "c", launch).0.unwrap();
    }

    #[test]
    fn kill_forgets_the_pty_folder() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        ptys.set_host(
            Arc::new(FakeHost::default()),
            ptyd::status(PtydState::Running, None, None),
        );
        let launch = launch_for(data.path(), "shell", None, None, None, false).unwrap();
        start(&ptys, data.path(), "k", launch).0.unwrap();
        assert!(ptys.cwd_of("k").is_some());
        pty_kill_in(&ptys, &crate::ports::Ports::default(), "k");
        assert!(ptys.cwd_of("k").is_none());
        assert!(ptys.map().is_empty());
    }

    #[test]
    fn shell_never_touches_passes() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        ptys.passes().insert("keep".into());
        let launch = launch_for(data.path(), "shell", None, None, None, false).unwrap();
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
            account_source: Some(AccountSource::Active),
            ..agent()
        };
        approve_launch(&ptys, data.path(), &l).unwrap();
        let info = start(&ptys, data.path(), "a", l).0.unwrap();
        ptys.kill_all();
        assert_eq!(info.profile, "claude");
        assert_eq!(info.permissions, "accept-edits");
        assert_eq!(info.account.as_deref(), Some("work"));
        assert_eq!(info.account_source, Some(AccountSource::Active));
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["accountSource"], "active");
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

    fn codex() -> Launch {
        Launch {
            profile: "codex".into(),
            cli: Some(Cli::Codex),
            ..with_extra_args(["--model", "m"])
        }
    }

    fn tail(l: &Launch, n: usize) -> Vec<&str> {
        l.args[l.args.len() - n..]
            .iter()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn a_claude_resume_appends_the_resume_flag() {
        let mut l = with_extra_args(["--model", "m"]);
        let before = l.args.clone();
        add_resume(&mut l, "4f1c-9_ab").unwrap();
        assert_eq!(l.args[..before.len()], before[..]);
        assert_eq!(tail(&l, 2), ["--resume", "4f1c-9_ab"]);
    }

    #[test]
    fn a_codex_resume_is_the_subcommand_before_the_other_args() {
        let mut l = codex();
        let before = l.args.clone();
        add_resume(&mut l, "0199a-b").unwrap();
        assert_eq!(l.args[..2], ["resume", "0199a-b"]);
        assert_eq!(l.args[2..], before[..]);
    }

    #[test]
    fn a_resume_needs_an_agent_cli_and_a_plain_id() {
        let data = tempfile::tempdir().unwrap();
        let mut shell = launch_for(data.path(), "shell", None, None, None, false).unwrap();
        assert_eq!(add_resume(&mut shell, "abc").unwrap_err().code, "bad_arg");
        let mut custom = Launch {
            cli: None,
            ..agent()
        };
        assert_eq!(add_resume(&mut custom, "abc").unwrap_err().code, "bad_arg");
        for id in [
            "",
            "a b",
            "a;b",
            "../x",
            "a
b",
            &"a".repeat(129),
        ] {
            let mut l = agent();
            let err = add_resume(&mut l, id).unwrap_err();
            assert_eq!(err.code, "bad_arg", "{id:?}");
            assert_eq!(l.args, agent().args, "{id:?} left the args alone");
        }
        assert_eq!(
            launch_for(data.path(), "shell", None, None, Some("abc"), false)
                .unwrap_err()
                .code,
            "bad_arg"
        );
    }

    #[test]
    fn a_claude_fork_adds_resume_and_fork_session() {
        let mut l = with_extra_args(["--model", "m"]);
        let before = l.args.clone();
        add_fork(&mut l, "4f1c-9_ab").unwrap();
        assert_eq!(l.args[..before.len()], before[..]);
        assert_eq!(tail(&l, 3), ["--resume", "4f1c-9_ab", "--fork-session"]);
    }

    #[test]
    fn a_codex_fork_is_the_fork_subcommand_first() {
        let mut l = codex();
        let before = l.args.clone();
        add_fork(&mut l, "0199a-b").unwrap();
        assert_eq!(l.args[..2], ["fork", "0199a-b"]);
        assert_eq!(l.args[2..], before[..]);
    }

    #[test]
    fn a_fork_needs_an_agent_cli_and_a_plain_id() {
        let data = tempfile::tempdir().unwrap();
        let mut shell = launch_for(data.path(), "shell", None, None, None, false).unwrap();
        assert_eq!(add_fork(&mut shell, "abc").unwrap_err().code, "bad_arg");
        let mut custom = Launch {
            cli: None,
            ..agent()
        };
        assert_eq!(add_fork(&mut custom, "abc").unwrap_err().code, "bad_arg");
        for id in ["", "a b", "a;b", "../x", &"a".repeat(129)] {
            let mut l = agent();
            assert_eq!(add_fork(&mut l, id).unwrap_err().code, "bad_arg", "{id:?}");
            assert_eq!(l.args, agent().args, "{id:?} left the args alone");
        }
        // A fork without a session id is a bad argument.
        assert_eq!(
            launch_for(data.path(), "shell", None, None, None, true)
                .unwrap_err()
                .code,
            "bad_arg"
        );
    }

    #[test]
    fn the_gate_sees_the_resume_args_and_asks_again() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        approve_launch(&ptys, data.path(), &agent()).unwrap();
        let mut resumed = agent();
        add_resume(&mut resumed, "s1").unwrap();
        let Action::LaunchAgent { args, .. } = launch_action(&resumed) else {
            panic!("an agent launch");
        };
        assert_eq!(args[args.len() - 2..], ["--resume", "s1"]);
        let (first, _) = start(&ptys, data.path(), "a", resumed.clone());
        assert_eq!(first.unwrap_err().code, "needs_approval");
        approve_launch(&ptys, data.path(), &resumed).unwrap();
        start(&ptys, data.path(), "a", resumed).0.unwrap();
        ptys.kill_all();
    }

    #[test]
    fn launch_for_reports_unknown_and_bad_stores() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(
            launch_for(data.path(), "vim", None, None, None, false)
                .unwrap_err()
                .code,
            "unknown_profile"
        );
        std::fs::write(data.path().join("profiles.json"), "not json").unwrap();
        assert_eq!(
            launch_for(data.path(), "claude", None, None, None, false)
                .unwrap_err()
                .code,
            "bad_profiles"
        );
    }

    #[test]
    fn shell_spawns_without_policy() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let launch = launch_for(data.path(), "shell", None, None, None, false).unwrap();
        let (result, _) = start(&ptys, data.path(), "s", launch);
        assert!(!result.unwrap().agent);
        assert!(!data.path().join("audit.jsonl").exists());
        ptys.kill_all();
    }

    #[test]
    fn a_pty_remembers_its_cwd_until_killed() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let launch = launch_for(data.path(), "shell", None, None, None, false).unwrap();
        let (result, _) = start(&ptys, data.path(), "c", launch);
        result.unwrap();
        assert_eq!(ptys.cwd_of("c"), Some(std::env::temp_dir()));
        assert_eq!(ptys.cwd_of("other"), None);
        pty_kill_in(&ptys, &crate::ports::Ports::default(), "c");
        assert_eq!(ptys.cwd_of("c"), None);
    }

    #[test]
    fn duplicate_id_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let launch = launch_for(data.path(), "shell", None, None, None, false).unwrap();
        start(&ptys, data.path(), "d", launch.clone()).0.unwrap();
        let (again, _) = start(&ptys, data.path(), "d", launch);
        assert_eq!(again.unwrap_err().code, "pty_exists");
        ptys.kill_all();
    }

    #[test]
    fn kill_all_ends_every_session() {
        let data = tempfile::tempdir().unwrap();
        let ptys = Ptys::default();
        let launch = launch_for(data.path(), "shell", None, None, None, false).unwrap();
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
        let launch = launch_for(data.path(), "shell", None, None, None, false).unwrap();
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
        assert_eq!(cmd.1, ["/D", "/C", script]);
        let wsl = setup_command(&entry(ShellKind::Wsl, "wsl.exe", &["-d", "Ubuntu"]), script);
        assert_eq!(wsl.1, ["-d", "Ubuntu", "--exec", "sh", "-lc", script]);
        let login = setup_command(&entry(ShellKind::Login, "/bin/zsh", &["-l"]), script);
        assert_eq!(login.1, ["-l", "-c", script]);
        let custom = setup_command(&entry(ShellKind::Custom, "fish", &[]), script);
        assert_eq!(custom.1, ["-c", script]);
    }

    #[test]
    fn cmd_file_writes_the_script_once_as_a_batch_file() {
        let dir = tempfile::tempdir().unwrap();
        let script = "pnpm i\nif 1==1 (\n  echo yes\n)";
        let path = cmd_file(dir.path(), script).unwrap();
        assert_eq!(path.extension().unwrap(), "cmd");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "@echo off\r\npnpm i\r\nif 1==1 (\r\n  echo yes\r\n)\r\n"
        );
        assert_eq!(cmd_file(dir.path(), script).unwrap(), path);
        assert_ne!(cmd_file(dir.path(), "make").unwrap(), path);
        // No temp file is left behind.
        let names = std::fs::read_dir(path.parent().unwrap()).unwrap().count();
        assert_eq!(names, 2);
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

    fn trust_launch(cli: Option<Cli>, agent: bool, env: &[(&str, &str)]) -> Launch {
        Launch {
            profile: "p".to_owned(),
            program: PathBuf::from("p"),
            args: Vec::new(),
            env: env
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).into()))
                .collect(),
            agent,
            permissions: Permissions::Ask,
            account: None,
            account_source: None,
            startup: Vec::new(),
            cli,
            hooks: false,
            hook_events: Vec::new(),
            prompt_after: None,
            prompt_argv: Vec::new(),
        }
    }

    fn plan(launch: &Launch, enabled: bool, fresh: bool) -> Option<TrustPlan> {
        trust_plan(
            launch,
            Path::new("/work/wt"),
            Path::new("/data"),
            Some(PathBuf::from("/home/u")),
            enabled,
            fresh,
            &|name| (name == "KIMI_CODE_HOME").then(|| "/kimi".into()),
        )
    }

    #[test]
    fn trust_is_planned_only_for_a_fresh_agent_with_the_setting_on() {
        let claude = trust_launch(Some(Cli::Claude), true, &[]);
        let p = plan(&claude, true, true).unwrap();
        assert_eq!(p.kind, TrustKind::Claude);
        assert_eq!(p.folder, Path::new("/work/wt"));
        assert_eq!(p.target.home, Path::new("/home/u"));
        assert!(plan(&claude, false, true).is_none(), "setting off");
        assert!(plan(&claude, true, false).is_none(), "resume or fork");
        assert!(plan(&trust_launch(Some(Cli::Claude), false, &[]), true, true).is_none());
        assert!(
            plan(&trust_launch(None, true, &[]), true, true).is_none(),
            "custom"
        );
        // An agent with no trust store.
        assert!(plan(&trust_launch(Some(Cli::Aider), true, &[]), true, true).is_none());
        // No home folder, no plan.
        assert!(
            trust_plan(
                &claude,
                Path::new("/w"),
                Path::new("/data"),
                None,
                true,
                true,
                &|_| None
            )
            .is_none()
        );
    }

    #[test]
    fn trust_target_follows_the_launch_env_and_the_private_codex_home_only() {
        let kimi = trust_launch(Some(Cli::Kimi), true, &[("CLAUDE_CONFIG_DIR", "/cfg")]);
        let p = plan(&kimi, true, true).unwrap();
        assert_eq!(p.target.claude_config.as_deref(), Some(Path::new("/cfg")));
        // Not set by the launch: the process env.
        assert_eq!(p.target.kimi_home.as_deref(), Some(Path::new("/kimi")));
        let private = Path::new("/data")
            .join(xdev_agent::CODEX_HOME_DIR)
            .join("default-x");
        let own = trust_launch(Some(Cli::Codex), true, &[("CODEX_HOME", "/home/u/.codex")]);
        assert_eq!(plan(&own, true, true).unwrap().target.codex_home, None);
        let mine = trust_launch(
            Some(Cli::Codex),
            true,
            &[("CODEX_HOME", private.to_str().unwrap())],
        );
        assert_eq!(
            plan(&mine, true, true).unwrap().target.codex_home,
            Some(private)
        );
    }

    #[test]
    fn a_blocked_trust_writer_does_not_hold_the_start() {
        let start = std::time::Instant::now();
        let (hold_tx, hold_rx) = mpsc::channel::<()>();
        let got = run_with_deadline(Duration::from_millis(200), move || {
            let _ = hold_rx.recv_timeout(Duration::from_secs(30));
        });
        assert!(got.is_none());
        assert!(start.elapsed() < Duration::from_secs(3));
        drop(hold_tx);
        assert_eq!(run_with_deadline(Duration::from_secs(2), || 7), Some(7));
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

    #[test]
    fn setup_launch_refuses_a_repo_whose_policy_is_skip() {
        let f = setup_fixture("echo hi");
        let mut reg = Workspace::load(&f.data).unwrap();
        reg.repos[0].setup_policy = SetupPolicy::Skip;
        reg.save(&f.data).unwrap();
        let err = setup_launch(&f.data, &f.repo).unwrap_err();
        assert_eq!(err.code, "setup_skipped");
    }
}
