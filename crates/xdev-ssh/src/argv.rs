//! The arguments `ssh` is given for a host: one builder for the terminal, and
//! the test and connect runs that add their own options in front.

use std::path::Path;

use crate::{LocalForward, SshHost, TIMEOUT_MAX, TIMEOUT_MIN};

/// The connect timeout of a host that sets none, in seconds.
pub const CONNECT_TIMEOUT_DEFAULT: u16 = 10;

/// `local:host:remote` for `-L`; an IPv6 remote host goes in brackets.
pub fn forward_spec(f: &LocalForward) -> String {
    if f.remote_host.contains(':') {
        format!("{}:[{}]:{}", f.local_port, f.remote_host, f.remote_port)
    } else {
        format!("{}:{}:{}", f.local_port, f.remote_host, f.remote_port)
    }
}

/// The host's connect timeout, or the default, within the allowed range.
pub fn effective_timeout(host: &SshHost) -> u16 {
    host.connect_timeout_secs
        .unwrap_or(CONNECT_TIMEOUT_DEFAULT)
        .clamp(TIMEOUT_MIN, TIMEOUT_MAX)
}

/// The args after `ssh` for `host`, ending with the alias. The alias is the
/// destination so the `Host` blocks of the user's config still apply; the
/// stored address goes in `-o HostName=` when it differs, so a host added by
/// hand reaches its address too. `ssh` keeps the first value of an option,
/// so a caller that wants its own value puts it in front.
pub fn ssh_argv(host: &SshHost) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut pair = |flag: &str, value: String| {
        out.push(flag.to_owned());
        out.push(value);
    };
    if let Some(jump) = &host.proxy_jump {
        pair("-J", jump.clone());
    }
    for f in &host.local_forwards {
        pair("-L", forward_spec(f));
    }
    if let Some(t) = host.connect_timeout_secs {
        pair(
            "-o",
            format!("ConnectTimeout={}", t.clamp(TIMEOUT_MIN, TIMEOUT_MAX)),
        );
    }
    if !host.host_name.is_empty() && host.host_name != host.alias {
        pair("-o", format!("HostName={}", host.host_name));
    }
    for option in &host.extra_options {
        pair("-o", option.clone());
    }
    if let Some(port) = host.port {
        pair("-p", port.to_string());
    }
    if let Some(identity) = &host.identity_file {
        pair("-i", identity.clone());
    }
    if let Some(user) = &host.user {
        pair("-l", user.clone());
    }
    if host.forward_agent {
        out.push("-A".to_owned());
    }
    out.push(host.alias.clone());
    out
}

/// A test run: no prompts, no tty, the connect timeout first, then `exit`
/// on the server.
pub fn test_argv(host: &SshHost) -> Vec<String> {
    let mut out = vec![
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        "-o".to_owned(),
        format!("ConnectTimeout={}", effective_timeout(host)),
        "-T".to_owned(),
    ];
    out.extend(ssh_argv(host));
    out.push("exit".to_owned());
    out
}

/// A kept connection: no command (`-N`), so it holds the forwards; it exits
/// when a forward cannot listen or the server stops answering; `VERBOSE` so
/// the success line shows on stderr.
pub fn connect_argv(host: &SshHost) -> Vec<String> {
    let mut out: Vec<String> = [
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "LogLevel=VERBOSE",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    out.push("-o".to_owned());
    out.push(format!("ConnectTimeout={}", effective_timeout(host)));
    out.extend(ssh_argv(host));
    out
}

/// The options every remote-project process starts with: keep-alives, and
/// with `mux` a shared master connection in `mux`, so later processes skip
/// the login. The caller passes `None` where ssh has no multiplexing
/// (Windows).
fn remote_opts(mux: Option<&Path>) -> Vec<String> {
    let mut out: Vec<String> = [
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    if let Some(dir) = mux {
        out.push("-o".to_owned());
        out.push("ControlMaster=auto".to_owned());
        out.push("-o".to_owned());
        out.push(format!("ControlPath={}", dir.join("cm-%C").display()));
        out.push("-o".to_owned());
        out.push("ControlPersist=60".to_owned());
    }
    out
}

/// The remote options, the host's own, then `flags`, the destination and
/// `tail`.
fn remote_argv(host: &SshHost, mux: Option<&Path>, flags: &[&str], tail: &[&str]) -> Vec<String> {
    let mut out = remote_opts(mux);
    let mut base = ssh_argv(host);
    let dest = base.pop().unwrap_or_default();
    out.extend(base);
    out.extend(flags.iter().map(|s| (*s).to_owned()));
    out.push(dest);
    out.extend(tail.iter().map(|s| (*s).to_owned()));
    out
}

/// The SFTP session of a remote project: `-T -s <dest> sftp`.
pub fn sftp_argv(host: &SshHost, mux: Option<&Path>) -> Vec<String> {
    remote_argv(host, mux, &["-T", "-s"], &["sftp"])
}

/// The exec channel of a remote project: `-T <dest> sh`.
pub fn exec_argv(host: &SshHost, mux: Option<&Path>) -> Vec<String> {
    remote_argv(host, mux, &["-T"], &["sh"])
}

/// A terminal or agent on the host: `-tt <dest> <remote_cmd>`.
pub fn tty_argv(host: &SshHost, mux: Option<&Path>, remote_cmd: &str) -> Vec<String> {
    remote_argv(host, mux, &["-tt"], &[remote_cmd])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host;

    fn strs(v: &[String]) -> Vec<&str> {
        v.iter().map(String::as_str).collect()
    }

    #[test]
    fn plain_host_is_the_alias_and_its_address() {
        let h = host("web");
        assert_eq!(
            strs(&ssh_argv(&h)),
            ["-o", "HostName=web.example.com", "web"]
        );
        let mut same = host("web");
        same.host_name = "web".into();
        assert_eq!(strs(&ssh_argv(&same)), ["web"]);
    }

    #[test]
    fn port_identity_and_user() {
        let mut h = host("web");
        h.host_name = "web".into();
        h.port = Some(2222);
        h.identity_file = Some("~/.ssh/k".into());
        h.user = Some("deploy".into());
        assert_eq!(
            strs(&ssh_argv(&h)),
            ["-p", "2222", "-i", "~/.ssh/k", "-l", "deploy", "web"]
        );
    }

    #[test]
    fn proxy_jump() {
        let mut h = host("web");
        h.host_name = "web".into();
        h.proxy_jump = Some("bastion,me@jump:22".into());
        assert_eq!(strs(&ssh_argv(&h)), ["-J", "bastion,me@jump:22", "web"]);
    }

    #[test]
    fn forward_agent() {
        let mut h = host("web");
        h.host_name = "web".into();
        h.forward_agent = true;
        assert_eq!(strs(&ssh_argv(&h)), ["-A", "web"]);
    }

    #[test]
    fn local_forwards() {
        let mut h = host("web");
        h.host_name = "web".into();
        h.local_forwards = vec![
            LocalForward {
                local_port: 5432,
                remote_host: "db.internal".into(),
                remote_port: 5432,
            },
            LocalForward {
                local_port: 8080,
                remote_host: "::1".into(),
                remote_port: 80,
            },
        ];
        assert_eq!(
            strs(&ssh_argv(&h)),
            ["-L", "5432:db.internal:5432", "-L", "8080:[::1]:80", "web"]
        );
    }

    #[test]
    fn connect_timeout_and_extra_options() {
        let mut h = host("web");
        h.host_name = "web".into();
        h.connect_timeout_secs = Some(300);
        h.extra_options = vec!["ServerAliveInterval=30".into(), "SetEnv=A=b c".into()];
        assert_eq!(
            strs(&ssh_argv(&h)),
            [
                "-o",
                "ConnectTimeout=120",
                "-o",
                "ServerAliveInterval=30",
                "-o",
                "SetEnv=A=b c",
                "web"
            ]
        );
    }

    #[test]
    fn effective_timeout_defaults_and_clamps() {
        let mut h = host("web");
        assert_eq!(effective_timeout(&h), CONNECT_TIMEOUT_DEFAULT);
        h.connect_timeout_secs = Some(0);
        assert_eq!(effective_timeout(&h), TIMEOUT_MIN);
        h.connect_timeout_secs = Some(999);
        assert_eq!(effective_timeout(&h), TIMEOUT_MAX);
    }

    #[test]
    fn test_run_puts_batch_mode_first_and_runs_exit() {
        let mut h = host("web");
        h.host_name = "web".into();
        h.connect_timeout_secs = Some(5);
        assert_eq!(
            strs(&test_argv(&h)),
            [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=5",
                "-T",
                "-o",
                "ConnectTimeout=5",
                "web",
                "exit"
            ]
        );
    }

    #[test]
    fn connect_run_holds_no_command() {
        let mut h = host("web");
        h.host_name = "web".into();
        let argv = connect_argv(&h);
        assert_eq!(argv[0], "-N");
        assert!(argv.iter().any(|a| a == "ExitOnForwardFailure=yes"));
        assert!(argv.iter().any(|a| a == "ConnectTimeout=10"));
        assert!(!argv.iter().any(|a| a == "BatchMode=yes"));
        assert_eq!(argv.last().map(String::as_str), Some("web"));
    }

    #[test]
    fn remote_argv_without_mux() {
        let mut h = host("web");
        h.host_name = "web".into();
        h.user = Some("dev".into());
        let keep = [
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
        ];
        let with = |rest: &[&'static str]| [&keep[..], &["-l", "dev"], rest].concat();
        assert_eq!(
            strs(&sftp_argv(&h, None)),
            with(&["-T", "-s", "web", "sftp"])
        );
        assert_eq!(strs(&exec_argv(&h, None)), with(&["-T", "web", "sh"]));
        assert_eq!(
            strs(&tty_argv(&h, None, "cd '/srv' && exec \"$SHELL\" -l")),
            with(&["-tt", "web", "cd '/srv' && exec \"$SHELL\" -l"])
        );
    }

    #[test]
    fn remote_argv_with_mux() {
        let mut h = host("web");
        h.host_name = "web".into();
        let dir = Path::new("/data/ssh");
        // The socket path uses the OS separator (`\` on Windows).
        let control = format!("ControlPath={}", dir.join("cm-%C").display());
        assert_eq!(
            strs(&exec_argv(&h, Some(dir))),
            [
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "ControlMaster=auto",
                "-o",
                control.as_str(),
                "-o",
                "ControlPersist=60",
                "-T",
                "web",
                "sh"
            ]
        );
        let sftp = sftp_argv(&host("db"), Some(dir));
        assert_eq!(
            strs(&sftp[10..]),
            ["-o", "HostName=db.example.com", "-T", "-s", "db", "sftp"]
        );
    }
}
