//! Secret values of a repo's Environment rows. A secret row's value is kept
//! in the OS keychain under the service `xdev-env`, one entry per repo and
//! key; the registry holds only the key and the `secret` flag.

use xdev_workspace::{EnvPreviewRow, Registry, SecretStore, WorkspaceError};

use crate::commands::{AppState, CmdError};

const SERVICE: &str = "xdev-env";
/// Windows Credential Manager holds a blob of 2560 bytes and keyring may write
/// UTF-16, so a value stays under half of that.
const SECRET_MAX: usize = 1200;

/// The OS keychain.
pub struct Keychain;

fn entry(repo_id: &str, key: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, &format!("{repo_id}:{key}")).ok()
}

impl SecretStore for Keychain {
    fn get(&self, repo_id: &str, key: &str) -> Option<String> {
        entry(repo_id, key)?.get_password().ok()
    }

    fn set(&self, repo_id: &str, key: &str, value: &str) -> Result<(), WorkspaceError> {
        if value.len() > SECRET_MAX {
            return Err(WorkspaceError::TooLarge(format!("secret {key}")));
        }
        entry(repo_id, key)
            .ok_or_else(|| WorkspaceError::BadEnv(key.to_owned()))?
            .set_password(value)
            .map_err(|e| WorkspaceError::Io(std::io::Error::other(e.to_string())))
    }

    fn remove(&self, repo_id: &str, key: &str) {
        if let Some(e) = entry(repo_id, key) {
            let _ = e.delete_credential();
        }
    }
}

/// In memory, for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemorySecrets(std::sync::Mutex<std::collections::HashMap<(String, String), String>>);

#[cfg(test)]
impl SecretStore for MemorySecrets {
    fn get(&self, repo_id: &str, key: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .get(&(repo_id.to_owned(), key.to_owned()))
            .cloned()
    }

    fn set(&self, repo_id: &str, key: &str, value: &str) -> Result<(), WorkspaceError> {
        self.0
            .lock()
            .unwrap()
            .insert((repo_id.to_owned(), key.to_owned()), value.to_owned());
        Ok(())
    }

    fn remove(&self, repo_id: &str, key: &str) {
        self.0
            .lock()
            .unwrap()
            .remove(&(repo_id.to_owned(), key.to_owned()));
    }
}

fn repo_env_of(reg: &Registry, repo_id: &str) -> Result<Vec<xdev_workspace::RepoEnvVar>, CmdError> {
    reg.repos
        .iter()
        .find(|r| r.id == repo_id)
        .map(|r| r.env.clone())
        .ok_or_else(|| WorkspaceError::RepoUnknown(repo_id.to_owned()).into())
}

/// Stores one secret value, for a key the repo lists as a secret row.
pub(crate) fn set_secret(
    reg: &Registry,
    store: &dyn SecretStore,
    repo_id: &str,
    key: &str,
    value: &str,
) -> Result<(), CmdError> {
    let rows = repo_env_of(reg, repo_id)?;
    if !rows.iter().any(|r| r.secret && r.key == key) {
        return Err(WorkspaceError::BadEnv(key.to_owned()).into());
    }
    if value.contains('\0') {
        return Err(WorkspaceError::BadEnv(key.to_owned()).into());
    }
    Ok(store.set(repo_id, key, value)?)
}

/// The keys of the repo's secret rows that have a stored value.
pub(crate) fn stored_keys(
    reg: &Registry,
    store: &dyn SecretStore,
    repo_id: &str,
) -> Result<Vec<String>, CmdError> {
    Ok(repo_env_of(reg, repo_id)?
        .into_iter()
        .filter(|r| r.secret && store.get(repo_id, &r.key).is_some())
        .map(|r| r.key)
        .collect())
}

/// The effective project env, secrets masked. `inherited` says whether the
/// process env already has a name.
pub(crate) fn preview(
    reg: &Registry,
    store: &dyn SecretStore,
    repo_id: &str,
    inherited: &dyn Fn(&str) -> bool,
) -> Result<Vec<EnvPreviewRow>, CmdError> {
    let rows = repo_env_of(reg, repo_id)?;
    Ok(xdev_workspace::preview_env(
        &rows,
        &|k| store.get(repo_id, k).is_some(),
        inherited,
    ))
}

/// Which secret rows have a value, by key. Never returns a value.
#[tauri::command(async)]
pub fn repo_env_secrets(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<String>, CmdError> {
    let reg = Registry::load(crate::accounts::data_dir(&state)?)?;
    stored_keys(&reg, &Keychain, &repo_id)
}

/// Stores a secret row's value in the keychain. Save the row first.
#[tauri::command(async)]
pub fn repo_env_secret_set(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    key: String,
    value: String,
) -> Result<(), CmdError> {
    let reg = Registry::load(crate::accounts::data_dir(&state)?)?;
    set_secret(&reg, &Keychain, &repo_id, &key, &value)
}

/// Removes the stored value of a key (a row that was deleted or made plain).
#[tauri::command(async)]
pub fn repo_env_secret_clear(repo_id: String, key: String) -> Result<(), CmdError> {
    Keychain.remove(&repo_id, &key);
    Ok(())
}

/// The effective env of the repo with secrets masked.
#[tauri::command(async)]
pub fn repo_env_preview(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<EnvPreviewRow>, CmdError> {
    let reg = Registry::load(crate::accounts::data_dir(&state)?)?;
    preview(&reg, &Keychain, &repo_id, &|k| {
        std::env::var_os(k).is_some()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use xdev_workspace::{MASK, RepoEntry, RepoEnvVar};

    fn reg() -> Registry {
        let mut r = Registry::default();
        r.repos.push(RepoEntry {
            id: "a".into(),
            env: vec![
                RepoEnvVar {
                    key: "TOKEN".into(),
                    value: String::new(),
                    secret: true,
                },
                RepoEnvVar {
                    key: "PLAIN".into(),
                    value: "v".into(),
                    secret: false,
                },
            ],
            ..Default::default()
        });
        r
    }

    #[test]
    fn a_secret_is_stored_only_for_a_secret_row() {
        let (r, s) = (reg(), MemorySecrets::default());
        set_secret(&r, &s, "a", "TOKEN", "hunter2").unwrap();
        assert_eq!(s.get("a", "TOKEN").as_deref(), Some("hunter2"));
        assert_eq!(
            set_secret(&r, &s, "a", "PLAIN", "x").unwrap_err().code,
            "bad_env"
        );
        assert_eq!(
            set_secret(&r, &s, "a", "NOPE", "x").unwrap_err().code,
            "bad_env"
        );
        assert_eq!(
            set_secret(&r, &s, "zz", "TOKEN", "x").unwrap_err().code,
            "repo_unknown"
        );
    }

    #[test]
    fn stored_keys_lists_keys_never_values() {
        let (r, s) = (reg(), MemorySecrets::default());
        assert!(stored_keys(&r, &s, "a").unwrap().is_empty());
        s.set("a", "TOKEN", "hunter2").unwrap();
        assert_eq!(stored_keys(&r, &s, "a").unwrap(), ["TOKEN"]);
    }

    #[test]
    fn the_preview_masks_the_secret() {
        let (r, s) = (reg(), MemorySecrets::default());
        s.set("a", "TOKEN", "hunter2").unwrap();
        let rows = preview(&r, &s, "a", &|k| k == "PLAIN").unwrap();
        assert_eq!(rows[0].value, MASK);
        assert!(rows[1].overrides);
        assert!(!format!("{rows:?}").contains("hunter2"));
    }
}
