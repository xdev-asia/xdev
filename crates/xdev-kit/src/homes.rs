use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use xdev_ai::{Provider, Registry};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum HomeSource {
    Own,
    Env,
    Account(String),
}

/// One agent home: the folder a CLI reads its settings, skills and memory from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Home {
    pub id: String,
    pub agent: Agent,
    /// Canonical.
    pub path: PathBuf,
    pub source: HomeSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum KitError {
    #[error("io: {0}")]
    Io(String),
    #[error("outside every known folder: {}", .0.display())]
    Outside(PathBuf),
    #[error("the file changed since it was read")]
    Changed,
    #[error("parse: {0}")]
    Parse(String),
}

impl From<std::io::Error> for KitError {
    fn from(e: std::io::Error) -> Self {
        KitError::Io(e.to_string())
    }
}

/// `ceil(bytes / 4)`: a rough size, always shown with "≈".
pub fn approx_tokens(bytes: u64) -> u64 {
    bytes.div_ceil(4)
}

/// The homes on this machine, in the order Own, Env, Account. A folder seen
/// twice is kept once, under the first source; a folder that is missing is
/// left out.
pub fn homes(
    data_dir: &Path,
    user_home: &Path,
    env: &dyn Fn(&str) -> Option<String>,
) -> Vec<Home> {
    let mut found: Vec<Home> = Vec::new();
    let mut add = |id: String, agent: Agent, path: PathBuf, source: HomeSource| {
        let Ok(path) = path.canonicalize() else {
            return;
        };
        if !path.is_dir() || found.iter().any(|h| h.path == path) {
            return;
        }
        found.push(Home {
            id,
            agent,
            path,
            source,
        });
    };

    add(
        "own-claude".into(),
        Agent::Claude,
        user_home.join(".claude"),
        HomeSource::Own,
    );
    add(
        "own-codex".into(),
        Agent::Codex,
        user_home.join(".codex"),
        HomeSource::Own,
    );
    for (var, agent, id) in [
        ("CLAUDE_CONFIG_DIR", Agent::Claude, "env-claude"),
        ("CODEX_HOME", Agent::Codex, "env-codex"),
    ] {
        if let Some(dir) = env(var).filter(|d| !d.is_empty()) {
            add(id.into(), agent, PathBuf::from(dir), HomeSource::Env);
        }
    }
    // A registry this version cannot read adds nothing; it is never rewritten here.
    for entry in Registry::load(data_dir).unwrap_or_default().accounts {
        let agent = match entry.provider {
            Provider::Claude => Agent::Claude,
            Provider::Codex => Agent::Codex,
        };
        add(
            format!("acct-{}", entry.name),
            agent,
            entry.dir,
            HomeSource::Account(entry.name),
        );
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use xdev_ai::{Provider, Registry};

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn own_homes_found() {
        let user = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        fs::create_dir(user.path().join(".claude")).unwrap();
        fs::create_dir(user.path().join(".codex")).unwrap();
        let found = homes(data.path(), user.path(), &no_env);
        let ids: Vec<&str> = found.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["own-claude", "own-codex"]);
        assert_eq!(found[0].agent, Agent::Claude);
        assert_eq!(found[1].agent, Agent::Codex);
        assert_eq!(found[0].source, HomeSource::Own);
    }

    #[test]
    fn env_home_same_as_own_is_kept_once() {
        let user = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let claude = user.path().join(".claude");
        fs::create_dir(&claude).unwrap();
        let var = claude.to_string_lossy().into_owned();
        let env = move |k: &str| (k == "CLAUDE_CONFIG_DIR").then(|| var.clone());
        let found = homes(data.path(), user.path(), &env);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "own-claude");
    }

    #[test]
    fn env_home_elsewhere_gets_env_id() {
        let user = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let var = other.path().to_string_lossy().into_owned();
        let env = move |k: &str| (k == "CODEX_HOME").then(|| var.clone());
        let found = homes(data.path(), user.path(), &env);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "env-codex");
        assert_eq!(found[0].source, HomeSource::Env);
    }

    #[test]
    fn account_homes_from_registry() {
        let user = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut reg = Registry::default();
        for (name, provider) in [("claude-2", Provider::Claude), ("codex-2", Provider::Codex)] {
            let dir = xdev_ai::account_dir(data.path(), name);
            fs::create_dir_all(&dir).unwrap();
            reg.add(name, provider, dir).unwrap();
        }
        reg.save(data.path()).unwrap();
        let found = homes(data.path(), user.path(), &no_env);
        let got: Vec<(&str, Agent)> = found.iter().map(|h| (h.id.as_str(), h.agent)).collect();
        assert_eq!(
            got,
            [
                ("acct-claude-2", Agent::Claude),
                ("acct-codex-2", Agent::Codex)
            ]
        );
        assert_eq!(found[0].source, HomeSource::Account("claude-2".into()));
    }

    #[test]
    fn missing_folder_is_skipped() {
        let user = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let mut reg = Registry::default();
        reg.add("gone", Provider::Claude, data.path().join("accounts/gone"))
            .unwrap();
        reg.save(data.path()).unwrap();
        let env = |k: &str| (k == "CODEX_HOME").then(|| "Z:/no/such/dir".to_owned());
        assert!(homes(data.path(), user.path(), &env).is_empty());
    }

    #[test]
    fn approx_tokens_rounds_up() {
        assert_eq!(approx_tokens(0), 0);
        assert_eq!(approx_tokens(1), 1);
        assert_eq!(approx_tokens(4), 1);
        assert_eq!(approx_tokens(5), 2);
    }
}
