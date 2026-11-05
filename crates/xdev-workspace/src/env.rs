//! Per-project environment variables for terminals. The rows are plain data
//! except a secret row's value, which never reaches the registry: it lives
//! in the OS keychain (see `SecretStore`) and a secret row keeps an empty
//! `value` here. Every function in this file is pure.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::WorkspaceError;

/// Most rows a repo keeps.
pub const ENV_MAX: usize = 100;
/// Longest key, in bytes.
pub const ENV_KEY_MAX: usize = 128;
/// Longest value, in bytes.
pub const ENV_VALUE_MAX: usize = 32 * 1024;
/// Keys with this prefix belong to the app; a project cannot set them.
pub const RESERVED_PREFIX: &str = "XDEV_";
/// What a masked secret shows as.
pub const MASK: &str = "••••••••";

/// One row of a repo's Environment list.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(default)]
pub struct RepoEnvVar {
    pub key: String,
    /// Empty for a secret row: that value is in the keychain.
    pub value: String,
    pub secret: bool,
}

/// `[A-Za-z_][A-Za-z0-9_]*`, at most `ENV_KEY_MAX` bytes.
pub fn valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && key.len() <= ENV_KEY_MAX
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Whether the app owns `key` (any case on Windows, where names are
/// case-insensitive; exact elsewhere).
pub fn is_reserved(key: &str) -> bool {
    if cfg!(windows) {
        key.to_ascii_uppercase().starts_with(RESERVED_PREFIX)
    } else {
        key.starts_with(RESERVED_PREFIX)
    }
}

fn same_key(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Rows as a repo keeps them. Keys are trimmed. A key that is not valid or
/// is reserved is refused (`bad_env`), as are more than `ENV_MAX` rows, a
/// value over `ENV_VALUE_MAX` or holding a NUL (`too_large` / `bad_env`). A
/// later row replaces an earlier one with the same key. A secret row's value
/// is dropped.
pub fn clean_env(rows: &[RepoEnvVar]) -> Result<Vec<RepoEnvVar>, WorkspaceError> {
    let mut out: Vec<RepoEnvVar> = Vec::new();
    for row in rows {
        let key = row.key.trim();
        if !valid_key(key) || is_reserved(key) {
            return Err(WorkspaceError::BadEnv(key.to_owned()));
        }
        if row.value.contains('\0') {
            return Err(WorkspaceError::BadEnv(key.to_owned()));
        }
        if row.value.len() > ENV_VALUE_MAX {
            return Err(WorkspaceError::TooLarge(format!("env {key}")));
        }
        let clean = RepoEnvVar {
            key: key.to_owned(),
            value: if row.secret {
                String::new()
            } else {
                row.value.clone()
            },
            secret: row.secret,
        };
        match out.iter().position(|r| same_key(&r.key, key)) {
            Some(i) => out[i] = clean,
            None => out.push(clean),
        }
    }
    if out.len() > ENV_MAX {
        return Err(WorkspaceError::TooLarge("env".to_owned()));
    }
    Ok(out)
}

/// The variables a terminal gets from a project. `inherited` is what the
/// terminal would have without the project (the process and the profile).
/// Precedence, lowest first: `inherited`, the project, the app's own
/// `XDEV_*` variables. So the result lists every project row that is usable
/// and does not touch an `XDEV_*` name; the caller applies it over its env.
///
/// A row is skipped when its key is not valid or is reserved. A plain row
/// with an empty value is kept: it sets the variable to empty. A secret row
/// takes its value from `secret` and is skipped when none is stored.
pub fn merge_env(
    project: &[RepoEnvVar],
    secret: &dyn Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for row in project {
        let key = row.key.trim();
        if !valid_key(key) || is_reserved(key) {
            continue;
        }
        let value = if row.secret {
            match secret(key) {
                Some(v) => v,
                None => continue,
            }
        } else {
            row.value.clone()
        };
        if value.contains('\0') {
            continue;
        }
        match out.iter().position(|(k, _)| same_key(k, key)) {
            Some(i) => out[i].1 = value,
            None => out.push((key.to_owned(), value)),
        }
    }
    out
}

/// One line of the read-only preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EnvPreviewRow {
    pub key: String,
    /// A secret shows as `MASK`; a secret with no stored value is empty.
    pub value: String,
    pub secret: bool,
    /// The terminal's own env already has this name and the project row wins.
    pub overrides: bool,
}

/// The effective project env with secrets masked. `is_set(key)` says the
/// inherited env already has that name.
pub fn preview_env(
    project: &[RepoEnvVar],
    has_secret: &dyn Fn(&str) -> bool,
    is_set: &dyn Fn(&str) -> bool,
) -> Vec<EnvPreviewRow> {
    let merged = merge_env(project, &|k| has_secret(k).then(|| "x".to_owned()));
    let plain: BTreeMap<&str, &RepoEnvVar> = project.iter().map(|r| (r.key.trim(), r)).collect();
    merged
        .into_iter()
        .map(|(key, value)| {
            let secret = plain.get(key.as_str()).is_some_and(|r| r.secret);
            EnvPreviewRow {
                overrides: is_set(&key),
                value: if secret { MASK.to_owned() } else { value },
                secret,
                key,
            }
        })
        .collect()
}

/// Where secret values are kept: the OS keychain in the app, memory in tests.
pub trait SecretStore {
    fn get(&self, repo_id: &str, key: &str) -> Option<String>;
    fn set(&self, repo_id: &str, key: &str, value: &str) -> Result<(), WorkspaceError>;
    fn remove(&self, repo_id: &str, key: &str);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(key: &str, value: &str, secret: bool) -> RepoEnvVar {
        RepoEnvVar {
            key: key.into(),
            value: value.into(),
            secret,
        }
    }

    #[test]
    fn keys_follow_the_shell_name_rule() {
        for ok in ["A", "_", "_a1", "Path_2"] {
            assert!(valid_key(ok), "{ok}");
        }
        for bad in ["", "1A", "A-B", "A B", "A=B", "é", "A.B"] {
            assert!(!valid_key(bad), "{bad}");
        }
        assert!(!valid_key(&"A".repeat(ENV_KEY_MAX + 1)));
    }

    #[test]
    fn clean_refuses_bad_and_reserved_keys() {
        let code = |r: &[RepoEnvVar]| clean_env(r).unwrap_err().code();
        assert_eq!(code(&[row("1A", "x", false)]), "bad_env");
        assert_eq!(code(&[row("XDEV_ROOT_PATH", "x", false)]), "bad_env");
        assert_eq!(code(&[row("A", "a\0b", false)]), "bad_env");
        assert_eq!(code(&[row("", "x", false)]), "bad_env");
    }

    #[test]
    fn clean_trims_dedupes_and_drops_secret_values() {
        let got = clean_env(&[
            row(" A ", "1", false),
            row("B", "s3cret", true),
            row("A", "2", false),
        ])
        .unwrap();
        assert_eq!(got, vec![row("A", "2", false), row("B", "", true)]);
    }

    #[test]
    fn clean_caps_rows_and_value_size() {
        let many: Vec<RepoEnvVar> = (0..=ENV_MAX)
            .map(|i| row(&format!("K{i}"), "", false))
            .collect();
        assert_eq!(clean_env(&many).unwrap_err().code(), "too_large");
        assert!(clean_env(&many[..ENV_MAX]).is_ok());
        let big = row("A", &"x".repeat(ENV_VALUE_MAX + 1), false);
        assert_eq!(clean_env(&[big]).unwrap_err().code(), "too_large");
    }

    #[test]
    fn merge_keeps_empty_plain_values_and_skips_unset_secrets() {
        let rows = [
            row("EMPTY", "", false),
            row("TOKEN", "", true),
            row("GOT", "", true),
        ];
        let got = merge_env(&rows, &|k| (k == "GOT").then(|| "v".to_owned()));
        assert_eq!(
            got,
            vec![("EMPTY".into(), "".into()), ("GOT".into(), "v".into())]
        );
    }

    #[test]
    fn merge_never_sets_the_apps_own_vars_or_invalid_keys() {
        let rows = [
            row("XDEV_ROOT_PATH", "evil", false),
            row("1BAD", "x", false),
            row("OK", "y", false),
        ];
        assert_eq!(
            merge_env(&rows, &|_| None),
            vec![("OK".to_owned(), "y".to_owned())]
        );
    }

    #[test]
    fn merge_lets_a_later_row_win() {
        let rows = [row("A", "1", false), row("A", "2", false)];
        assert_eq!(merge_env(&rows, &|_| None), vec![("A".into(), "2".into())]);
    }

    #[test]
    fn preview_masks_secrets_and_flags_overrides() {
        let rows = [
            row("TOKEN", "", true),
            row("HOME", "/x", false),
            row("NOPE", "", true),
        ];
        let got = preview_env(&rows, &|k| k == "TOKEN", &|k| k == "HOME");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].value, MASK);
        assert!(got[0].secret && !got[0].overrides);
        assert_eq!(got[1].value, "/x");
        assert!(got[1].overrides);
        assert!(!format!("{got:?}").contains("\"x\""));
    }
}
