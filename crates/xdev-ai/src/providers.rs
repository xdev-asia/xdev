//! The agent CLIs xDev keeps accounts for, as one data table: how each is
//! found, how an account's sign-in is kept apart, how a sign-in is detected
//! and whether it has a quota source. Everything that differs between
//! providers besides the Claude and Codex specifics is a row here.

use std::env;
use std::path::{Path, PathBuf};

use crate::accounts::Provider;

/// How the CLI keeps one account's sign-in apart from another's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Isolation {
    /// The CLI's documented variable points it at the account's folder, so
    /// each account has its own sign-in and tabs can switch between them.
    Home(&'static str),
    /// No documented way to relocate the sign-in: xDev registers the CLI's
    /// own sign-in once, detects it and never switches it.
    Single,
}

#[derive(Debug, Clone, Copy)]
pub struct ProviderSpec {
    pub provider: Provider,
    /// The id in the registry and the API; the same as the CLI's agent
    /// profile id.
    pub id: &'static str,
    /// The program name probed on `PATH`.
    pub program: &'static str,
    /// xDev's own variable that names the program instead.
    pub bin_var: &'static str,
    pub isolation: Isolation,
    /// The folder, under the user's home, the CLI uses with no account.
    /// For a `Home` provider it is what its variable would default to.
    pub default_home: &'static [&'static str],
    /// The file, under an account's folder, whose presence means signed in.
    /// `None` when no such file is known: the sign-in is not detected.
    /// Only ever checked for presence, never read.
    pub login_marker: Option<&'static [&'static str]>,
    /// The CLI arguments that sign an account in; empty runs the CLI
    /// itself, which asks for a sign-in on its first start.
    pub login_args: &'static [&'static str],
    /// Whether xDev can read the account's quota.
    pub quota: bool,
}

/// One row per `Provider`, in `Provider::ALL` order.
static SPECS: [ProviderSpec; 7] = [
    ProviderSpec {
        provider: Provider::Claude,
        id: "claude",
        program: "claude",
        bin_var: "XDEV_CLAUDE_BIN",
        isolation: Isolation::Home("CLAUDE_CONFIG_DIR"),
        default_home: &[".claude"],
        login_marker: None,
        login_args: &["auth", "login"],
        quota: true,
    },
    ProviderSpec {
        provider: Provider::Codex,
        id: "codex",
        program: "codex",
        bin_var: "XDEV_CODEX_BIN",
        isolation: Isolation::Home("CODEX_HOME"),
        default_home: &[".codex"],
        login_marker: None,
        login_args: &["login"],
        quota: true,
    },
    // `GEMINI_CLI_HOME` is the root the CLI makes its `.gemini` folder in,
    // the user's home by default.
    ProviderSpec {
        provider: Provider::Gemini,
        id: "gemini",
        program: "gemini",
        bin_var: "XDEV_GEMINI_BIN",
        isolation: Isolation::Home("GEMINI_CLI_HOME"),
        default_home: &[],
        login_marker: Some(&[".gemini", "oauth_creds.json"]),
        login_args: &[],
        quota: false,
    },
    ProviderSpec {
        provider: Provider::QwenCode,
        id: "qwen-code",
        program: "qwen",
        bin_var: "XDEV_QWEN_BIN",
        isolation: Isolation::Single,
        default_home: &[".qwen"],
        login_marker: Some(&["oauth_creds.json"]),
        login_args: &[],
        quota: false,
    },
    ProviderSpec {
        provider: Provider::Opencode,
        id: "opencode",
        program: "opencode",
        bin_var: "XDEV_OPENCODE_BIN",
        isolation: Isolation::Single,
        default_home: &[".local", "share", "opencode"],
        login_marker: Some(&["auth.json"]),
        login_args: &[],
        quota: false,
    },
    ProviderSpec {
        provider: Provider::Amp,
        id: "amp",
        program: "amp",
        bin_var: "XDEV_AMP_BIN",
        isolation: Isolation::Single,
        default_home: &[".config", "amp"],
        login_marker: None,
        login_args: &[],
        quota: false,
    },
    ProviderSpec {
        provider: Provider::Cursor,
        id: "cursor",
        program: "cursor-agent",
        bin_var: "XDEV_CURSOR_BIN",
        isolation: Isolation::Single,
        default_home: &[".cursor"],
        login_marker: None,
        login_args: &[],
        quota: false,
    },
];

pub fn spec(provider: Provider) -> &'static ProviderSpec {
    SPECS
        .iter()
        .find(|s| s.provider == provider)
        .expect("every Provider has a row")
}

/// The user's home: `USERPROFILE` on Windows, else `HOME`.
pub(crate) fn user_home() -> Option<PathBuf> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// `default_home` under `user`.
pub(crate) fn home_under(provider: Provider, user: &Path) -> PathBuf {
    spec(provider)
        .default_home
        .iter()
        .fold(user.to_path_buf(), |dir, part| dir.join(part))
}

/// Whether the sign-in file is in `dir`; `None` when the provider has none.
/// Looks at the file's presence only.
pub(crate) fn signed_in(provider: Provider, dir: &Path) -> Option<bool> {
    let marker = spec(provider).login_marker?;
    let file = marker
        .iter()
        .fold(dir.to_path_buf(), |p, part| p.join(part));
    Some(file.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_row_per_provider_in_order() {
        assert_eq!(SPECS.len(), Provider::ALL.len());
        for (row, provider) in SPECS.iter().zip(Provider::ALL) {
            assert_eq!(row.provider, provider);
        }
    }

    #[test]
    fn markers_are_checked_by_presence() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(signed_in(Provider::Gemini, tmp.path()), Some(false));
        std::fs::create_dir_all(tmp.path().join(".gemini")).unwrap();
        std::fs::write(tmp.path().join(".gemini/oauth_creds.json"), "").unwrap();
        assert_eq!(signed_in(Provider::Gemini, tmp.path()), Some(true));
        assert_eq!(signed_in(Provider::Cursor, tmp.path()), None);
        assert_eq!(signed_in(Provider::Claude, tmp.path()), None);
    }
}
