//! Settings that belong to one SSH host: what resolves for it (its own
//! value, else the global one, else the built-in default) and which host a
//! path runs on. Local is the global settings; only SSH hosts have overrides.

use std::path::Path;

use serde::Serialize;

use crate::agent_sessions::HISTORY_DAYS;
use crate::settings::{HOST_DAYS_RANGE, HostEnvVar, HostSettings};

/// Where a path runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostScope {
    Local,
    Ssh(String),
}

/// `Ssh(id)` for an `ssh://<id>/...` worktree, or for a local checkout that has a remote target
/// ("run on host"); `Local` for anything else, including an `ssh://` string with a bad host id.
pub fn scope_of(path: &str, data: &Path) -> HostScope {
    if let Some(r) = crate::remote_ssh::remote_ref(Path::new(path)) {
        return HostScope::Ssh(r.host_id);
    }
    if path.starts_with("ssh://") {
        return HostScope::Local;
    }
    match crate::remote_ssh::target_of(data, Path::new(path)) {
        Ok(Some(target)) => HostScope::Ssh(target.host_id),
        _ => HostScope::Local,
    }
}

pub const DEFAULT_CLAUDE_HOME: &str = "~/.claude";
pub const DEFAULT_CODEX_HOME: &str = "~/.codex";

/// A host's values with every default filled in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EffectiveHost {
    /// The label, else the host alias.
    pub label: String,
    /// `None` = the host's `"$SHELL" -l`.
    pub shell: Option<String>,
    pub env: Vec<HostEnvVar>,
    pub history: EffectiveHistory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EffectiveHistory {
    pub enabled: bool,
    pub claude_home: String,
    pub codex_home: String,
    pub days: u32,
}

/// `stored` over the defaults; `alias` names the host when it has no label.
pub fn effective(stored: Option<&HostSettings>, alias: &str) -> EffectiveHost {
    let empty = HostSettings::default();
    let s = stored.unwrap_or(&empty);
    let days = s.history.days.unwrap_or(HISTORY_DAYS);
    EffectiveHost {
        label: s.label.clone().unwrap_or_else(|| alias.to_owned()),
        shell: s.shell.clone(),
        env: s.env.clone(),
        history: EffectiveHistory {
            enabled: s.history.enabled.unwrap_or(true),
            claude_home: s
                .history
                .claude_home
                .clone()
                .unwrap_or_else(|| DEFAULT_CLAUDE_HOME.to_owned()),
            codex_home: s
                .history
                .codex_home
                .clone()
                .unwrap_or_else(|| DEFAULT_CODEX_HOME.to_owned()),
            days: days.clamp(*HOST_DAYS_RANGE.start(), *HOST_DAYS_RANGE.end()),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::settings::HostHistory;
    use xdev_ssh::RemoteTarget;

    #[test]
    fn nothing_stored_gives_the_defaults() {
        let e = effective(None, "box");
        assert_eq!(e.label, "box");
        assert_eq!(e.shell, None);
        assert!(e.env.is_empty());
        assert!(e.history.enabled);
        assert_eq!(e.history.claude_home, "~/.claude");
        assert_eq!(e.history.codex_home, "~/.codex");
        assert_eq!(e.history.days, 90);
        assert_eq!(effective(Some(&HostSettings::default()), "box"), e);
    }

    #[test]
    fn each_override_wins_alone() {
        let base = effective(None, "box");
        let with = |f: &dyn Fn(&mut HostSettings)| {
            let mut h = HostSettings::default();
            f(&mut h);
            effective(Some(&h), "box")
        };
        assert_eq!(with(&|h| h.label = Some("Dev".into())).label, "Dev");
        assert_eq!(
            with(&|h| h.shell = Some("/bin/zsh".into()))
                .shell
                .as_deref(),
            Some("/bin/zsh")
        );
        let env = vec![HostEnvVar {
            name: "A".into(),
            value: "1".into(),
        }];
        assert_eq!(with(&|h| h.env = env.clone()).env, env);
        assert!(!with(&|h| h.history.enabled = Some(false)).history.enabled);
        assert_eq!(
            with(&|h| h.history.claude_home = Some("/opt/c".into()))
                .history
                .claude_home,
            "/opt/c"
        );
        assert_eq!(
            with(&|h| h.history.codex_home = Some("/opt/x".into()))
                .history
                .codex_home,
            "/opt/x"
        );
        assert_eq!(with(&|h| h.history.days = Some(7)).history.days, 7);
        // The others stay at their defaults.
        let one = with(&|h| h.history.days = Some(7));
        assert_eq!(one.label, base.label);
        assert_eq!(one.history.claude_home, base.history.claude_home);
    }

    #[test]
    fn days_are_clamped() {
        let h = HostSettings {
            history: HostHistory {
                days: Some(0),
                ..HostHistory::default()
            },
            ..HostSettings::default()
        };
        assert_eq!(effective(Some(&h), "b").history.days, 1);
        let h = HostSettings {
            history: HostHistory {
                days: Some(99_999),
                ..HostHistory::default()
            },
            ..HostSettings::default()
        };
        assert_eq!(effective(Some(&h), "b").history.days, 3650);
    }

    #[test]
    fn scope_of_an_ssh_worktree_is_its_host() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            scope_of("ssh://ssh-a/home/u/p", dir.path()),
            HostScope::Ssh("ssh-a".into())
        );
        assert_eq!(scope_of("ssh://bad id/x", dir.path()), HostScope::Local);
    }

    #[test]
    fn scope_of_a_checkout_follows_its_remote_target() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let repo = dir.path().join("repo");
        let other = dir.path().join("other");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let entry: xdev_workspace::RepoEntry = serde_json::from_value(serde_json::json!({
            "id": "r1",
            "short_name": "repo",
            "path": repo,
            "base_ref": "main",
            "worktree_root": dir.path().join("wt"),
        }))
        .unwrap();
        xdev_workspace::Registry {
            version: 1,
            repos: vec![entry],
            ..xdev_workspace::Registry::default()
        }
        .save(&data)
        .unwrap();
        let mut targets = BTreeMap::new();
        targets.insert(
            "r1".to_owned(),
            RemoteTarget {
                host_id: "ssh-b".into(),
                path: "/srv/p".into(),
            },
        );
        crate::remote_ssh::store::save_targets(&data, &targets).unwrap();
        assert_eq!(
            scope_of(repo.to_str().unwrap(), &data),
            HostScope::Ssh("ssh-b".into())
        );
        assert_eq!(scope_of(other.to_str().unwrap(), &data), HostScope::Local);
        assert_eq!(
            scope_of(other.to_str().unwrap(), dir.path()),
            HostScope::Local
        );
    }
}
