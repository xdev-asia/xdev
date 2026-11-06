//! A terminal or agent of a remote project: the launch resolved for this
//! machine, turned into `ssh -tt <host> <command>` that runs it in the
//! project folder on the host.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use xdev_agent::Launch;
use xdev_ssh::{SshHost, remote_agent_cmd, remote_shell_cmd, tty_argv};

/// What a launch needs to run on a host.
#[derive(Debug, Clone)]
pub(crate) struct RemoteSpec {
    pub host: SshHost,
    /// The project folder on the host.
    pub path: String,
    /// The ControlMaster folder; `None` where ssh has no multiplexing.
    pub mux: Option<PathBuf>,
    /// The project keeps sessions alive and the host has tmux.
    pub keep_alive: bool,
    /// The env names the profile declares; only these go to the host.
    pub declared: Vec<String>,
    /// `ssh://<host id><path>`, what the service lists the PTY with.
    pub worktree: String,
}

/// Names that never go to the host: this machine's PATH, the hook and CLI
/// variables, and any account home.
fn local_only(name: &str) -> bool {
    let same = |a: &str, b: &str| {
        if cfg!(windows) {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    same(name, "PATH")
        || name.to_ascii_uppercase().starts_with("XDEV_")
        || xdev_ai::Provider::ALL
            .iter()
            .filter_map(|p| p.home_var())
            .any(|var| same(name, var))
}

/// A value that names a file on this machine: an absolute path here, a
/// drive path or a UNC path.
fn local_path(value: &str) -> bool {
    let b = value.as_bytes();
    let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
    drive || value.starts_with("\\\\") || (cfg!(windows) && Path::new(value).is_absolute())
}

/// The launch env names the profile declares, without local paths, hook
/// variables or account homes; in launch order, the last of a name wins.
pub(crate) fn env_subset(env: &[(String, OsString)], declared: &[String]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (k, v) in env {
        if !declared.iter().any(|d| d == k) || local_only(k) {
            continue;
        }
        let v = v.to_string_lossy().into_owned();
        if local_path(&v) {
            continue;
        }
        out.retain(|(name, _)| name != k);
        out.push((k.clone(), v));
    }
    out
}

/// The program name the host runs: the file stem of the local program
/// (`claude.cmd` → `claude`).
fn remote_program(program: &Path) -> String {
    program
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `launch` as `ssh -tt` to the host: an agent or program in the project
/// folder with its declared env, a shell as a login shell; both inside a
/// tmux session named for `tab_id` when `keep_alive`. The local startup
/// lines are not run on the host.
pub(crate) fn wrap(mut launch: Launch, spec: &RemoteSpec, tab_id: &str) -> Launch {
    let keep = spec.keep_alive.then_some(tab_id);
    let cmd = if launch.agent || launch.cli.is_some() {
        let mut argv = vec![remote_program(&launch.program)];
        argv.extend(launch.args.iter().cloned());
        argv.extend(launch.prompt_argv.iter().cloned());
        let env = env_subset(&launch.env, &spec.declared);
        remote_agent_cmd(&spec.path, &argv, &env, keep)
    } else {
        remote_shell_cmd(&spec.path, keep)
    };
    launch.program = xdev_agent::system_ssh();
    launch.args = tty_argv(&spec.host, spec.mux.as_deref(), &cmd);
    launch.prompt_argv = Vec::new();
    launch.startup = Vec::new();
    launch.env = Vec::new();
    // The hook CLI and its settings files are on this machine, not the host.
    launch.hooks = false;
    launch.hook_events = Vec::new();
    launch
}

#[cfg(test)]
mod tests {
    use xdev_agent::{Cli, Permissions};

    use super::*;

    fn host() -> SshHost {
        SshHost {
            id: "devbox".into(),
            alias: "devbox".into(),
            host_name: "devbox".into(),
            ..SshHost::default()
        }
    }

    fn spec(keep_alive: bool, declared: &[&str]) -> RemoteSpec {
        RemoteSpec {
            host: host(),
            path: "/home/dev/app".into(),
            mux: None,
            keep_alive,
            declared: declared.iter().map(|s| (*s).to_owned()).collect(),
            worktree: "ssh://devbox/home/dev/app".into(),
        }
    }

    fn launch(agent: bool) -> Launch {
        let local = if cfg!(windows) {
            PathBuf::from("C:\\tools\\claude.cmd")
        } else {
            PathBuf::from("/usr/local/bin/claude")
        };
        Launch {
            profile: if agent { "claude" } else { "shell" }.into(),
            program: if agent { local } else { PathBuf::from("bash") },
            args: if agent {
                vec!["--model".into(), "opus".into()]
            } else {
                vec!["-l".into()]
            },
            env: vec![
                ("API_MODE".into(), "fast".into()),
                ("PATH".into(), "/local/bin".into()),
                ("CLAUDE_CONFIG_DIR".into(), "/home/me/.claude-a".into()),
                ("XDEV_PTY_ID".into(), "t1".into()),
                ("DATA".into(), "C:\\data".into()),
                ("UNDECLARED".into(), "x".into()),
            ],
            agent,
            permissions: Permissions::Ask,
            account: None,
            account_source: None,
            startup: vec!["cd src".into()],
            cli: agent.then_some(Cli::Claude),
            hooks: false,
            hook_events: Vec::new(),
            prompt_after: None,
            prompt_argv: if agent { vec!["hi".into()] } else { Vec::new() },
        }
    }

    const DECLARED: &[&str] = &[
        "API_MODE",
        "PATH",
        "CLAUDE_CONFIG_DIR",
        "XDEV_PTY_ID",
        "DATA",
    ];

    fn ssh_head() -> Vec<String> {
        [
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "-tt",
            "--",
            "devbox",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect()
    }

    #[test]
    fn an_agent_runs_in_the_folder_with_declared_env_only() {
        let out = wrap(launch(true), &spec(false, DECLARED), "t1");
        assert_eq!(out.program, xdev_agent::system_ssh());
        let mut want = ssh_head();
        want.push(
            "cd '/home/dev/app' && exec env API_MODE='fast' 'claude' '--model' 'opus' 'hi'".into(),
        );
        assert_eq!(out.args, want);
        assert!(out.env.is_empty());
        assert!(out.startup.is_empty());
        assert!(out.prompt_argv.is_empty());
        assert!(out.agent);
    }

    #[test]
    fn an_agent_with_tmux_attaches_the_tab_session() {
        let out = wrap(launch(true), &spec(true, DECLARED), "t1");
        let mut want = ssh_head();
        want.push(
            "tmux new-session -A -s 'xdev-t1' -c '/home/dev/app' 'exec env API_MODE='\\''fast'\\'' '\\''claude'\\'' '\\''--model'\\'' '\\''opus'\\'' '\\''hi'\\'''"
                .into(),
        );
        assert_eq!(out.args, want);
    }

    #[test]
    fn a_shell_is_a_login_shell_with_and_without_tmux() {
        let off = wrap(launch(false), &spec(false, &[]), "t2");
        let mut want = ssh_head();
        want.push("cd '/home/dev/app' && exec \"$SHELL\" -l".into());
        assert_eq!(off.args, want);
        let on = wrap(launch(false), &spec(true, &[]), "t2");
        let mut want = ssh_head();
        want.push("tmux new-session -A -s 'xdev-t2' -c '/home/dev/app'".into());
        assert_eq!(on.args, want);
    }

    #[test]
    fn a_hooked_agent_has_no_local_hooks_on_the_host() {
        let mut hooked = launch(true);
        hooked.hooks = true;
        hooked.hook_events = vec![xdev_agent::HookEvent::Prompt];
        let out = wrap(hooked, &spec(false, DECLARED), "t1");
        assert!(!out.hooks);
        assert!(out.hook_events.is_empty());
    }

    #[test]
    fn env_subset_drops_local_values_and_keeps_the_last() {
        let env = vec![
            ("A".into(), OsString::from("1")),
            ("A".into(), OsString::from("2")),
            ("B".into(), OsString::from("\\\\server\\share")),
            ("XDEV_HOOK".into(), OsString::from("1")),
        ];
        let declared: Vec<String> = ["A", "B", "XDEV_HOOK"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        assert_eq!(
            env_subset(&env, &declared),
            [("A".to_owned(), "2".to_owned())]
        );
    }
}
