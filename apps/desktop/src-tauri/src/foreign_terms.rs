//! Terminals and agent CLIs that run outside xDev: the list behind
//! "Terminals on this machine". It only reads the process table; nothing
//! here signals a process.

use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use xdev_agent::Cli;
use xdev_kit::{Agent, AgentSession};
use xdev_ports::{OsProbe, Probe, Proc};

use crate::commands::{AppState, CmdError};
use crate::pty::Ptys;

/// At most this many rows per scan.
pub const ROWS_MAX: usize = 500;
/// A scan, the process table read included, stops after this long.
pub const BUDGET: Duration = Duration::from_secs(2);

/// A parent chain longer than this is cut; a broken table cannot loop.
const DEPTH_MAX: usize = 64;
/// The clock is read once per this many processes.
const CLOCK_EVERY: usize = 64;

/// Interactive shells, by program name without `.exe`.
const SHELLS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "tcsh",
    "csh",
    "nu",
    "elvish",
    "xonsh",
    "pwsh",
    "powershell",
    "cmd",
];

/// Runtimes that run an agent CLI as a script: the agent is in the args.
const LAUNCHERS: &[&str] = &["node", "bun", "deno", "python", "python3"];

/// Top of the tree on each OS; never named as a parent app.
const ROOTS: &[&str] = &["launchd", "init", "systemd", "kernel_task", "system"];

/// One terminal session or agent CLI that xDev did not start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ForeignTerm {
    pub pid: u32,
    /// The program name, without a login dash or `.exe`.
    pub name: String,
    /// None when the OS would not say.
    pub cwd: Option<String>,
    /// The cwd is a folder that exists now, so it can open as a project.
    pub cwd_is_dir: bool,
    /// Unix ms.
    pub start_ms: Option<i64>,
    /// The app the session runs in, e.g. "Terminal"; the top process of the
    /// chain when no app bundle holds it.
    pub parent_app: Option<String>,
    /// The built-in profile id when this is an agent CLI, e.g. "claude".
    pub agent: Option<String>,
    pub agent_title: Option<String>,
    /// The indexed session this CLI runs, when the index knows it.
    pub session: Option<AgentSession>,
}

/// The rows of one scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ForeignScan {
    pub rows: Vec<ForeignTerm>,
    /// Rows were left out: more than `ROWS_MAX`, or the time ran out.
    pub truncated: bool,
}

/// How much one scan may do.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    pub rows: usize,
    pub deadline: Instant,
}

/// The program name: no directory, no login dash, no `.exe`, lowercased.
fn base(name: &str) -> String {
    let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let name = name.strip_prefix('-').unwrap_or(name);
    let lower = name.to_ascii_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_owned()
}

/// The display name: `base` with the case kept.
fn display_name(name: &str) -> String {
    let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let name = name.strip_prefix('-').unwrap_or(name);
    match name.len().checked_sub(4) {
        Some(cut) if name[cut..].eq_ignore_ascii_case(".exe") => name[..cut].to_owned(),
        _ => name.to_owned(),
    }
}

fn is_shell(p: &Proc) -> bool {
    SHELLS.contains(&base(&p.name).as_str())
}

/// The built-in agent whose binary name is `program`.
fn cli_named(program: &str) -> Option<Cli> {
    Cli::ALL
        .into_iter()
        .find(|cli| xdev_agent::spec(*cli).commands.contains(&program))
}

/// The agent CLI `p` runs: by its program name, or by the script a runtime
/// such as node runs.
pub(crate) fn agent_of(p: &Proc) -> Option<Cli> {
    let program = base(&p.name);
    if let Some(cli) = cli_named(&program) {
        return Some(cli);
    }
    if !LAUNCHERS.contains(&program.as_str()) {
        return None;
    }
    p.cmd
        .split_whitespace()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .take(2)
        .find_map(|arg| {
            let script = base(arg);
            let script = [".js", ".mjs", ".cjs", ".py"]
                .iter()
                .find_map(|ext| script.strip_suffix(ext))
                .unwrap_or(&script);
            cli_named(script)
        })
}

/// The name of the app bundle `p` runs from: the outermost `.app` on its
/// command line, so a helper inside an app counts as that app.
pub(crate) fn bundle_app(p: &Proc) -> Option<String> {
    let exe = p.cmd.split(" -").next().unwrap_or(&p.cmd);
    exe.split('/')
        .find_map(|part| part.strip_suffix(".app"))
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

/// The program runs a script or a command it was handed, not a prompt.
fn runs_a_command(p: &Proc) -> bool {
    p.cmd.split_whitespace().skip(1).any(|arg| {
        matches!(
            arg.to_ascii_lowercase().as_str(),
            "-c" | "/c" | "/k" | "-command" | "-file"
        )
    })
}

/// A process that can hold a session: not the top of the tree, a login
/// step, a shell, a runtime or an agent.
fn is_host(p: &Proc) -> bool {
    let program = base(&p.name);
    p.pid > 1
        && !ROOTS.contains(&program.as_str())
        && !matches!(program.as_str(), "login" | "su")
        && !is_shell(p)
        && !LAUNCHERS.contains(&program.as_str())
        && agent_of(p).is_none()
}

/// The process table by pid, with the parent links that hold.
struct Tree<'a> {
    by_pid: HashMap<u32, &'a Proc>,
}

impl<'a> Tree<'a> {
    fn new(procs: &'a [Proc]) -> Self {
        Self {
            by_pid: procs.iter().map(|p| (p.pid, p)).collect(),
        }
    }

    fn parent(&self, p: &Proc) -> Option<&'a Proc> {
        let parent = self.by_pid.get(&p.ppid?)?;
        parent.is_parent_of(p).then_some(*parent)
    }

    /// The parents of `p`, nearest first.
    fn ancestors(&self, p: &'a Proc) -> impl Iterator<Item = &'a Proc> + '_ {
        let mut at = p;
        (0..DEPTH_MAX).map_while(move |_| {
            at = self.parent(at)?;
            Some(at)
        })
    }
}

/// `p` is one of xDev's own processes or runs under one.
fn is_own(tree: &Tree, p: &Proc, own: &[u32]) -> bool {
    own.contains(&p.pid) || tree.ancestors(p).any(|a| own.contains(&a.pid))
}

/// The app `p` runs in: the app bundle of the nearest process above it that
/// has one, else the topmost process that can hold a session.
fn parent_app(tree: &Tree, p: &Proc) -> Option<String> {
    let mut top = None;
    for a in tree.ancestors(p) {
        if let Some(name) = bundle_app(a) {
            return Some(name);
        }
        if is_host(a) {
            top = Some(a);
        }
    }
    top.map(|a| display_name(&a.name))
}

/// A shell a person opened: it runs no handed command, its parent (past
/// `login`) is no shell, runtime or agent, and some app holds it. A shell
/// an agent, a script or another shell started is not a session of its own.
fn is_session_shell(tree: &Tree, p: &Proc) -> bool {
    if !is_shell(p) || runs_a_command(p) {
        return false;
    }
    let Some(parent) = tree
        .ancestors(p)
        .find(|a| base(&a.name) != "login" && base(&a.name) != "su")
    else {
        return false;
    };
    is_host(parent)
}

/// An agent CLI that is not a helper of the same CLI above it.
fn is_agent_root(tree: &Tree, p: &Proc, cli: Cli) -> bool {
    !tree.ancestors(p).any(|a| agent_of(a) == Some(cli))
}

/// The session index's agent for a built-in CLI.
fn indexed_agent(cli: Cli) -> Option<Agent> {
    match cli {
        Cli::Claude => Some(Agent::Claude),
        Cli::Codex => Some(Agent::Codex),
        _ => None,
    }
}

/// The session id the command line names: `--resume <id>`, `-r <id>`,
/// `--session-id <id>`, `--resume=<id>`, or `resume <id>`.
pub(crate) fn session_arg(cmd: &str) -> Option<&str> {
    let args: Vec<&str> = cmd.split_whitespace().collect();
    for (i, arg) in args.iter().enumerate() {
        for flag in ["--resume=", "--session-id="] {
            if let Some(id) = arg.strip_prefix(flag) {
                return (!id.is_empty()).then_some(id);
            }
        }
        if matches!(*arg, "--resume" | "-r" | "--session-id" | "resume")
            && let Some(next) = args.get(i + 1).filter(|n| !n.starts_with('-'))
        {
            return Some(next);
        }
    }
    None
}

/// The indexed session `p` runs. The id on its command line when the index
/// has it; else the newest session of that agent in the same folder that
/// was active after the process started.
fn session_of(p: &Proc, cli: Cli, sessions: &[&AgentSession]) -> Option<AgentSession> {
    let agent = indexed_agent(cli)?;
    let of_agent = || sessions.iter().filter(move |s| s.agent == agent);
    if let Some(id) = session_arg(&p.cmd)
        && let Some(s) = of_agent().filter(|s| s.id == id).max_by_key(|s| s.last)
    {
        return Some((*s).clone());
    }
    let cwd = p.cwd.as_deref()?.to_string_lossy().into_owned();
    let since = p.start.map_or(i64::MAX, |s| {
        i64::try_from(s).unwrap_or(i64::MAX).saturating_mul(1000)
    });
    of_agent()
        .filter(|s| s.cwd.as_deref() == Some(cwd.as_str()) && s.last >= since)
        .max_by_key(|s| s.last)
        .map(|s| (*s).clone())
}

/// The terminals and agent CLIs in `procs` that xDev did not start. `own`
/// holds xDev's pids: the app, the terminal service, each terminal's root;
/// they and everything under them are left out. Agents come first, then the
/// newest. `clock` is read as the scan goes and the scan stops at the
/// deadline.
pub(crate) fn scan(
    procs: &[Proc],
    own: &[u32],
    sessions: &[&AgentSession],
    is_dir: &dyn Fn(&Path) -> bool,
    limits: Limits,
    clock: &mut dyn FnMut() -> Instant,
) -> ForeignScan {
    let tree = Tree::new(procs);
    let mut truncated = false;
    let mut picked: Vec<(&Proc, Option<Cli>)> = Vec::new();
    for (i, p) in procs.iter().enumerate() {
        if i % CLOCK_EVERY == 0 && clock() >= limits.deadline {
            truncated = true;
            break;
        }
        let agent = agent_of(p);
        let keep = match agent {
            Some(cli) => is_agent_root(&tree, p, cli),
            None => is_session_shell(&tree, p),
        };
        if keep && !is_own(&tree, p, own) {
            picked.push((p, agent));
        }
    }
    picked.sort_by(|(a, x), (b, y)| {
        y.is_some()
            .cmp(&x.is_some())
            .then_with(|| b.start.cmp(&a.start))
            .then_with(|| a.pid.cmp(&b.pid))
    });
    if picked.len() > limits.rows {
        picked.truncate(limits.rows);
        truncated = true;
    }
    let rows = picked
        .into_iter()
        .map(|(p, agent)| ForeignTerm {
            pid: p.pid,
            name: display_name(&p.name),
            cwd: p.cwd.as_ref().map(|c| c.to_string_lossy().into_owned()),
            cwd_is_dir: p.cwd.as_deref().is_some_and(is_dir),
            start_ms: p
                .start
                .and_then(|s| i64::try_from(s).ok())
                .map(|s| s.saturating_mul(1000)),
            parent_app: parent_app(&tree, p),
            agent: agent.map(|cli| cli.as_str().to_owned()),
            agent_title: agent.map(|cli| xdev_agent::spec(cli).title.to_owned()),
            session: agent.and_then(|cli| session_of(p, cli, sessions)),
        })
        .collect();
    ForeignScan { rows, truncated }
}

/// Reads the process table on its own thread, so a slow read ends at
/// `deadline` instead of holding the call.
fn processes_until(deadline: Instant) -> Result<Vec<Proc>, CmdError> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(OsProbe.processes());
    });
    let wait = deadline.saturating_duration_since(Instant::now());
    match rx.recv_timeout(wait) {
        Ok(Ok(procs)) => Ok(procs),
        Ok(Err(e)) => Err(CmdError {
            code: "io",
            detail: Some(e.to_string()),
        }),
        Err(_) => Err(CmdError {
            code: "timeout",
            detail: None,
        }),
    }
}

/// One scan of this machine, within `BUDGET` and `ROWS_MAX`.
#[tauri::command(async)]
pub fn foreign_terms_scan(
    state: State<'_, AppState>,
    ptys: State<'_, Ptys>,
) -> Result<ForeignScan, CmdError> {
    let deadline = Instant::now() + BUDGET;
    let mut own = vec![std::process::id()];
    own.extend(ptys.service_pid());
    own.extend(ptys.roots().iter().map(|r| r.pid));
    let procs = processes_until(deadline)?;
    let index = crate::accounts::data_dir(&state)
        .map(crate::agent_sessions::index_copy)
        .ok();
    let sessions = index.as_ref().map(|i| i.list()).unwrap_or_default();
    Ok(scan(
        &procs,
        &own,
        &sessions,
        &|p| p.is_dir(),
        Limits {
            rows: ROWS_MAX,
            deadline,
        },
        &mut Instant::now,
    ))
}

#[cfg(test)]
#[path = "foreign_terms_tests.rs"]
mod tests;
