//! What an account row shows beyond its sign-in state: when the sign-in
//! file last changed, and whether a managed Codex home's `config.toml` has
//! drifted from the CLI's own. Only file times and bytes are looked at; no
//! file is parsed or printed, and the sign-in files are never opened.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::accounts::{AccountEntry, Provider, default_home};
use crate::providers::spec;

const CODEX_CONFIG: &str = "config.toml";

/// The file whose change time is the last sign-in: the CLI's own credential
/// file for Claude and Codex, else the provider's sign-in marker.
fn sign_in_file(provider: Provider, dir: &Path) -> Option<PathBuf> {
    match provider {
        Provider::Claude => Some(dir.join(".credentials.json")),
        Provider::Codex => Some(dir.join("auth.json")),
        _ => spec(provider)
            .login_marker
            .map(|m| m.iter().fold(dir.to_path_buf(), |p, part| p.join(part))),
    }
}

/// Unix ms the account's sign-in file was last written; `None` when the
/// provider has no such file or it is missing. A token refresh rewrites it
/// too, so this is the last sign-in or refresh.
pub fn signed_in_at(entry: &AccountEntry) -> Option<i64> {
    let file = sign_in_file(entry.provider, &entry.dir)?;
    let modified = fs::metadata(file).ok()?.modified().ok()?;
    let ms = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
    i64::try_from(ms).ok()
}

/// Whether a Codex account's `config.toml` differs from `default`'s (the
/// CLI's own home). False when the account is the default home itself, when
/// the default has no config, or for another provider.
pub fn config_drift(entry: &AccountEntry) -> bool {
    entry.provider == Provider::Codex
        && default_home(Provider::Codex).is_some_and(|d| drifted(&entry.dir, &d))
}

/// Copies `config.toml`, and only it, from the CLI's own Codex home into the
/// account's folder.
pub fn sync_config(entry: &AccountEntry) -> io::Result<()> {
    if entry.provider != Provider::Codex {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let default = default_home(Provider::Codex).ok_or(io::ErrorKind::NotFound)?;
    copy_config(&default, &entry.dir)
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn drifted(account: &Path, default: &Path) -> bool {
    if same_dir(account, default) {
        return false;
    }
    let Ok(theirs) = fs::read(default.join(CODEX_CONFIG)) else {
        return false;
    };
    fs::read(account.join(CODEX_CONFIG)).map_or(true, |mine| mine != theirs)
}

fn copy_config(default: &Path, account: &Path) -> io::Result<()> {
    if same_dir(account, default) {
        return Ok(());
    }
    fs::create_dir_all(account)?;
    fs::copy(default.join(CODEX_CONFIG), account.join(CODEX_CONFIG)).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(provider: Provider, dir: &Path) -> AccountEntry {
        AccountEntry {
            name: "a".into(),
            provider,
            dir: dir.to_path_buf(),
        }
    }

    #[test]
    fn last_sign_in_is_the_credential_file_time() {
        let tmp = tempfile::tempdir().unwrap();
        let claude = entry(Provider::Claude, tmp.path());
        assert_eq!(signed_in_at(&claude), None);
        fs::write(tmp.path().join(".credentials.json"), "secret").unwrap();
        assert!(signed_in_at(&claude).is_some_and(|ms| ms > 0));

        let codex = entry(Provider::Codex, tmp.path());
        assert_eq!(signed_in_at(&codex), None);
        fs::write(tmp.path().join("auth.json"), "secret").unwrap();
        assert!(signed_in_at(&codex).is_some());
        assert_eq!(signed_in_at(&entry(Provider::Amp, tmp.path())), None);
    }

    #[test]
    fn config_drift_compares_contents() {
        let tmp = tempfile::tempdir().unwrap();
        let default = tmp.path().join("default");
        let account = tmp.path().join("account");
        fs::create_dir_all(&default).unwrap();
        fs::create_dir_all(&account).unwrap();
        // No default config: nothing to drift from.
        assert!(!drifted(&account, &default));
        fs::write(default.join(CODEX_CONFIG), "model = \"a\"\n").unwrap();
        assert!(drifted(&account, &default), "missing account config");
        fs::write(account.join(CODEX_CONFIG), "model = \"b\"\n").unwrap();
        assert!(drifted(&account, &default));
        fs::write(account.join(CODEX_CONFIG), "model = \"a\"\n").unwrap();
        assert!(!drifted(&account, &default));
        assert!(!drifted(&default, &default), "the default home itself");
    }

    #[test]
    fn sync_copies_the_config_and_nothing_else() {
        let tmp = tempfile::tempdir().unwrap();
        let default = tmp.path().join("default");
        let account = tmp.path().join("account");
        fs::create_dir_all(&default).unwrap();
        fs::write(default.join(CODEX_CONFIG), "model = \"a\"\n").unwrap();
        fs::write(default.join("auth.json"), "default-secret").unwrap();
        fs::create_dir_all(&account).unwrap();
        fs::write(account.join("auth.json"), "own-secret").unwrap();

        copy_config(&default, &account).unwrap();
        assert_eq!(
            fs::read_to_string(account.join(CODEX_CONFIG)).unwrap(),
            "model = \"a\"\n"
        );
        assert_eq!(
            fs::read_to_string(account.join("auth.json")).unwrap(),
            "own-secret"
        );
        assert!(!drifted(&account, &default));
    }
}
