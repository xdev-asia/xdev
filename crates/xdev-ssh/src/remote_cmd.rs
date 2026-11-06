//! The command line a terminal or agent runs on the host, for `ssh -tt`:
//! a `cd` into the project folder and the program, or the same inside a
//! named tmux session that outlives a dropped connection.

use crate::rpath::sh_quote;

/// `xdev-<tab id>` with every byte outside `[A-Za-z0-9_-]` dropped.
pub fn tmux_session_name(tab_id: &str) -> String {
    let id: String = tab_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    format!("xdev-{id}")
}

/// A name `env` takes: a letter or `_`, then letters, digits or `_`.
fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Attaches the session of `tab_id` in `path`, or starts it with `inner`
/// (the login shell when `None`).
fn tmux_cmd(path: &str, tab_id: &str, inner: Option<&str>) -> String {
    let mut out = format!(
        "tmux new-session -A -s {} -c {}",
        sh_quote(&tmux_session_name(tab_id)),
        sh_quote(path)
    );
    if let Some(inner) = inner {
        out.push(' ');
        out.push_str(&sh_quote(inner));
    }
    out
}

/// A login shell in `path`. `keep_alive` is the tab id when the host has
/// tmux and the project keeps sessions alive.
pub fn remote_shell_cmd(path: &str, keep_alive: Option<&str>) -> String {
    match keep_alive {
        Some(tab) => tmux_cmd(path, tab, None),
        None => format!("cd {} && exec \"$SHELL\" -l", sh_quote(path)),
    }
}

/// `argv` in `path` with `env` set; each word quoted. An env name `env`
/// would not take is left out.
pub fn remote_agent_cmd(
    path: &str,
    argv: &[String],
    env: &[(String, String)],
    keep_alive: Option<&str>,
) -> String {
    let mut inner = String::from("exec");
    let vars: Vec<String> = env
        .iter()
        .filter(|(k, _)| valid_env_name(k))
        .map(|(k, v)| format!("{k}={}", sh_quote(v)))
        .collect();
    if !vars.is_empty() {
        inner.push_str(" env");
        for v in vars {
            inner.push(' ');
            inner.push_str(&v);
        }
    }
    for word in argv {
        inner.push(' ');
        inner.push_str(&sh_quote(word));
    }
    match keep_alive {
        Some(tab) => tmux_cmd(path, tab, Some(&inner)),
        None => format!("cd {} && {inner}", sh_quote(path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn shell_without_and_with_tmux() {
        assert_eq!(
            remote_shell_cmd("/home/dev/my app", None),
            "cd '/home/dev/my app' && exec \"$SHELL\" -l"
        );
        assert_eq!(
            remote_shell_cmd("/home/dev/app", Some("tab:1/x")),
            "tmux new-session -A -s 'xdev-tab1x' -c '/home/dev/app'"
        );
    }

    #[test]
    fn agent_without_tmux() {
        let env = vec![
            ("FOO".to_owned(), "a b".to_owned()),
            ("bad name".to_owned(), "x".to_owned()),
            ("_K2".to_owned(), "it's".to_owned()),
        ];
        assert_eq!(
            remote_agent_cmd("/srv/it's", &s(&["claude", "--resume", "$x"]), &env, None),
            "cd '/srv/it'\\''s' && exec env FOO='a b' _K2='it'\\''s' 'claude' '--resume' '$x'"
        );
        assert_eq!(
            remote_agent_cmd("/srv", &s(&["codex"]), &[], None),
            "cd '/srv' && exec 'codex'"
        );
    }

    #[test]
    fn agent_with_tmux() {
        let env = vec![("FOO".to_owned(), "1".to_owned())];
        assert_eq!(
            remote_agent_cmd("/srv", &s(&["claude"]), &env, Some("t1")),
            "tmux new-session -A -s 'xdev-t1' -c '/srv' 'exec env FOO='\\''1'\\'' '\\''claude'\\'''"
        );
    }

    #[test]
    fn session_names_are_reduced() {
        assert_eq!(tmux_session_name("a.b c;d_e-f"), "xdev-abcd_e-f");
        assert_eq!(tmux_session_name(""), "xdev-");
    }
}
