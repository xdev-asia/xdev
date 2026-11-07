//! A terminal or agent of a remote project: the launch resolved for this
//! machine, turned into `ssh -tt <host> <command>` that runs it in the
//! project folder on the host.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use xdev_agent::Launch;
use xdev_ssh::{SshHost, login_shell_cmd, remote_agent_cmd, remote_shell_cmd, ssh_argv, tty_argv};

use crate::commands::CmdError;
use crate::settings::HostsSettings;

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
    /// The host's own env (Settings → Host settings), set for agents and shells alike; the
    /// profile's declared names win.
    pub host_env: Vec<(String, String)>,
    /// The host's login shell for shell tabs; `None` is its `"$SHELL"`.
    pub shell: Option<String>,
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

/// `host` first, then `declared`; a declared name replaces the host's. A host variable named
/// like a local-only one (`PATH`, `XDEV_*`, an account home) is dropped.
fn merge_env(host: &[(String, String)], declared: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (k, v) in host.iter().filter(|(k, _)| !local_only(k)) {
        out.retain(|(name, _)| name != k);
        out.push((k.clone(), v.clone()));
    }
    for (k, v) in declared {
        out.retain(|(name, _)| *name != k);
        out.push((k, v));
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
/// folder with its declared env, a shell as a login shell with the host env and the declared
/// env (declared wins); both inside a
/// tmux session named for `tab_id` when `keep_alive`. The local startup
/// lines are not run on the host.
pub(crate) fn wrap(mut launch: Launch, spec: &RemoteSpec, tab_id: &str) -> Launch {
    let keep = spec.keep_alive.then_some(tab_id);
    let env = merge_env(&spec.host_env, env_subset(&launch.env, &spec.declared));
    let cmd = if launch.agent || launch.cli.is_some() {
        let mut argv = vec![remote_program(&launch.program)];
        argv.extend(launch.args.iter().cloned());
        argv.extend(launch.prompt_argv.iter().cloned());
        remote_agent_cmd(&spec.path, &argv, &env, keep)
    } else {
        remote_shell_cmd(&spec.path, keep, spec.shell.as_deref(), &env)
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

/// A `shell:ssh:<alias>` tab: the saved host with that alias gives its shell and env (declared
/// names are none, so `local_only` names drop). No such host, or no override left: unchanged.
/// With overrides the tab runs `ssh -tt <host> 'exec env K=v <shell> -l'` in the home folder.
pub(crate) fn ssh_tab_host(
    launch: &mut Launch,
    alias: &str,
    saved: &[SshHost],
    hosts: &HostsSettings,
) -> Result<(), CmdError> {
    let Some(host) = saved.iter().find(|h| h.alias == alias) else {
        return Ok(());
    };
    let values = crate::hosts::launch_values(hosts.0.get(&host.id))?;
    let env = merge_env(&values.env, Vec::new());
    let Some(cmd) = login_shell_cmd(&env, values.shell.as_deref()) else {
        return Ok(());
    };
    let mut args = vec!["-tt".to_owned()];
    args.extend(ssh_argv(host));
    args.push(cmd);
    launch.args = args;
    Ok(())
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
            host_env: Vec::new(),
            shell: None,
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
            wsl: None,
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
    fn host_env_goes_first_and_declared_env_wins() {
        let mut sp = spec(false, &["API_MODE"]);
        sp.host_env = vec![
            ("API_MODE".into(), "slow".into()),
            ("B".into(), "2".into()),
            ("PATH".into(), "/x".into()),
            ("XDEV_Y".into(), "1".into()),
        ];
        let out = wrap(launch(true), &sp, "t1");
        let mut want = ssh_head();
        want.push(
            "cd '/home/dev/app' && exec env B='2' API_MODE='fast' 'claude' '--model' 'opus' 'hi'"
                .into(),
        );
        assert_eq!(out.args, want);
    }

    #[test]
    fn a_shell_gets_the_host_env_with_and_without_tmux() {
        let mut sp = spec(false, &[]);
        sp.host_env = vec![
            ("B".into(), "2".into()),
            ("PATH".into(), "/x".into()),
            ("XDEV_Y".into(), "1".into()),
        ];
        let out = wrap(launch(false), &sp, "t2");
        let mut want = ssh_head();
        want.push("cd '/home/dev/app' && exec env B='2' \"$SHELL\" -l".into());
        assert_eq!(out.args, want);

        sp.shell = Some("/bin/zsh".into());
        sp.keep_alive = true;
        let out = wrap(launch(false), &sp, "t2");
        let mut want = ssh_head();
        want.push(
            "tmux new-session -A -s 'xdev-t2' -c '/home/dev/app' 'exec env B='\\''2'\\'' '\\''/bin/zsh'\\'' -l'"
                .into(),
        );
        assert_eq!(out.args, want);
    }

    #[test]
    fn a_shells_declared_env_wins_over_host_env() {
        let mut sp = spec(false, &["B"]);
        sp.host_env = vec![("B".into(), "2".into())];
        let mut l = launch(false);
        l.env = vec![("B".into(), "9".into())];
        let out = wrap(l, &sp, "t2");
        assert_eq!(
            out.args.last().unwrap(),
            "cd '/home/dev/app' && exec env B='9' \"$SHELL\" -l"
        );
    }

    #[test]
    fn a_host_shell_runs_for_shell_tabs_only() {
        let mut sp = spec(false, &[]);
        sp.shell = Some("/bin/zsh".into());
        let out = wrap(launch(false), &sp, "t2");
        let mut want = ssh_head();
        want.push("cd '/home/dev/app' && exec '/bin/zsh' -l".into());
        assert_eq!(out.args, want);
        let agent = wrap(launch(true), &sp, "t2");
        assert!(!agent.args.last().unwrap().contains("zsh"));
    }

    fn saved() -> Vec<SshHost> {
        vec![SshHost {
            id: "ssh-a".into(),
            alias: "devbox".into(),
            host_name: "devbox".into(),
            ..SshHost::default()
        }]
    }

    fn tab() -> Launch {
        let mut l = launch(false);
        l.program = PathBuf::from("ssh");
        l.args = ssh_argv(&saved()[0]);
        l
    }

    fn hosts_with(env: &[(&str, &str)], shell: Option<&str>) -> HostsSettings {
        let mut h = HostsSettings::default();
        h.0.insert(
            "ssh-a".into(),
            crate::settings::HostSettings {
                shell: shell.map(str::to_owned),
                env: env
                    .iter()
                    .map(|(n, v)| crate::settings::HostEnvVar {
                        name: (*n).into(),
                        value: (*v).into(),
                    })
                    .collect(),
                ..Default::default()
            },
        );
        h
    }

    #[test]
    fn an_ssh_tab_without_overrides_is_unchanged() {
        let plain = ssh_argv(&saved()[0]);
        let mut l = tab();
        ssh_tab_host(&mut l, "devbox", &saved(), &HostsSettings::default()).unwrap();
        assert_eq!(l.args, plain);
        // An alias that is not saved.
        let mut l = tab();
        ssh_tab_host(&mut l, "other", &saved(), &hosts_with(&[("A", "1")], None)).unwrap();
        assert_eq!(l.args, plain);
        // PATH is dropped, so nothing is left.
        let mut l = tab();
        ssh_tab_host(
            &mut l,
            "devbox",
            &saved(),
            &hosts_with(&[("PATH", "/x")], None),
        )
        .unwrap();
        assert_eq!(l.args, plain);
        assert_eq!(l.program, PathBuf::from("ssh"));
    }

    #[test]
    fn an_ssh_tab_runs_the_host_shell_with_env() {
        let mut l = tab();
        ssh_tab_host(&mut l, "devbox", &saved(), &hosts_with(&[("A", "1")], None)).unwrap();
        let mut want = vec!["-tt".to_owned()];
        want.extend(ssh_argv(&saved()[0]));
        want.push("exec env A='1' \"$SHELL\" -l".into());
        assert_eq!(l.args, want);
        let n = l.args.len();
        assert_eq!(l.args[n - 3], "--");
        assert_eq!(l.args[n - 2], "devbox");

        let mut l = tab();
        ssh_tab_host(
            &mut l,
            "devbox",
            &saved(),
            &hosts_with(&[], Some("/bin/zsh")),
        )
        .unwrap();
        assert_eq!(l.args.last().unwrap(), "exec '/bin/zsh' -l");
    }

    #[test]
    fn an_ssh_tab_refuses_a_bad_stored_entry() {
        let mut l = tab();
        let before = l.args.clone();
        let e = ssh_tab_host(
            &mut l,
            "devbox",
            &saved(),
            &hosts_with(&[("1A", "x")], None),
        )
        .unwrap_err();
        assert_eq!(e.code, "bad_env");
        assert_eq!(l.args, before);
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
