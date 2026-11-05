//! Folder trust, written before an agent starts so its first-run "do you
//! trust this folder" menu cannot swallow a typed prompt.
//!
//! What is written, per agent:
//! - claude: `projects["<path>"].hasTrustDialogAccepted = true` in the global
//!   config (`<CLAUDE_CONFIG_DIR>/.config.json` when it exists, else
//!   `<CLAUDE_CONFIG_DIR or home>/.claude.json`). A missing file is never
//!   created and every other field is kept.
//! - codex: `[projects."<path>"] trust_level = "trusted"` in the private
//!   `config.toml` only. The person's own codex home is never written.
//! - cursor: `<home>/.cursor/projects/<slug>/.workspace-trusted`.
//! - copilot: `trustedFolders[]` in `<home>/.copilot/config.json` (owner-only).
//! - kimi: `<kimi home>/workspace-trust/wd_<slug>_<sha256-12>`.
//!
//! Every write goes through a temporary file in the same folder and a
//! rename. A file that cannot be read as what it should be is left as it is
//! (`Bad`). The home folder and a filesystem root are never trusted.
//! [Unverified] against the vendor CLIs: the file formats come from reading
//! another app's source, not from running the agents.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::catalog::TrustKind;

/// Where each agent keeps its trust, so a test can point it at a tempdir.
#[derive(Debug, Clone)]
pub struct TrustTarget {
    /// The person's home folder.
    pub home: PathBuf,
    /// `CLAUDE_CONFIG_DIR`, when the claude launch sets it.
    pub claude_config: Option<PathBuf>,
    /// `KIMI_CODE_HOME`, when the kimi launch sets it.
    pub kimi_home: Option<PathBuf>,
    /// The private codex home xDev runs codex on. `None` when codex runs on
    /// the person's own home: nothing is written then.
    pub codex_home: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum TrustError {
    /// The folder is the home folder or a filesystem root.
    #[error("refusing to trust the home folder or a root")]
    Unsafe,
    #[error("{0}")]
    Io(#[from] io::Error),
    /// A file that should be JSON or TOML is not; it is left untouched.
    #[error("not valid: {0}")]
    Bad(String),
}

impl TrustError {
    /// The code the app logs.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsafe => "trust_unsafe",
            Self::Io(_) => "io",
            Self::Bad(_) => "bad_trust_file",
        }
    }
}

/// Marks `folder` trusted for `kind`. `Ok` also covers "nothing to do": a
/// missing claude config, codex on its real home, an already trusted folder.
pub fn trust_folder(kind: TrustKind, folder: &Path, at: &TrustTarget) -> Result<(), TrustError> {
    let real = real_path(folder);
    if folder.as_os_str().is_empty()
        || folder.parent().is_none()
        || real.parent().is_none()
        || same(&real, &real_path(&at.home))
        || same(folder, &at.home)
    {
        return Err(TrustError::Unsafe);
    }
    match kind {
        TrustKind::Claude => claude(folder, &real, at),
        TrustKind::Codex => codex(&real, at),
        TrustKind::Cursor => cursor(&real, at),
        TrustKind::Copilot => copilot(&real, at),
        TrustKind::Kimi => kimi(folder, &real, at),
    }
}

// ---------------------------------------------------------------- claude

/// The key Claude looks a folder up by: the path with `/` separators on
/// Windows. [Unverified] Claude also normalizes to Unicode NFC; no
/// normalization crate is in the workspace, so a decomposed name (macOS
/// filenames) is written as given.
fn claude_key(path: &Path) -> String {
    let clean: PathBuf = path.components().collect();
    let text = clean.to_string_lossy().into_owned();
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text
    }
}

fn claude_file(at: &TrustTarget) -> PathBuf {
    let dir = at
        .claude_config
        .clone()
        .unwrap_or_else(|| at.home.join(".claude"));
    let legacy = dir.join(".config.json");
    if legacy.is_file() {
        return legacy;
    }
    at.claude_config
        .clone()
        .unwrap_or_else(|| at.home.clone())
        .join(".claude.json")
}

/// `config` with the keys trusted; `None` when they already are.
fn claude_apply(config: &mut Map<String, Value>, keys: &[String]) -> Result<bool, TrustError> {
    let projects = match config.get_mut("projects") {
        None => {
            config.insert("projects".to_owned(), Value::Object(Map::new()));
            config.get_mut("projects")
        }
        Some(v) => Some(v),
    };
    let Some(Value::Object(projects)) = projects else {
        return Err(TrustError::Bad("projects".to_owned()));
    };
    let trusted = |entry: Option<&Value>| {
        entry
            .and_then(|e| e.get("hasTrustDialogAccepted"))
            .and_then(Value::as_bool)
            == Some(true)
    };
    if keys.iter().any(|k| trusted(projects.get(k))) {
        return Ok(false);
    }
    for key in keys {
        match projects.get_mut(key) {
            Some(Value::Object(entry)) => {
                entry.insert("hasTrustDialogAccepted".to_owned(), Value::Bool(true));
            }
            _ => {
                let mut entry = Map::new();
                entry.insert("hasTrustDialogAccepted".to_owned(), Value::Bool(true));
                projects.insert(key.clone(), Value::Object(entry));
            }
        }
    }
    Ok(true)
}

fn claude(folder: &Path, real: &Path, at: &TrustTarget) -> Result<(), TrustError> {
    let file = claude_file(at);
    // Through a link, so the rename keeps the link.
    let target = match fs::canonicalize(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let mut keys = vec![claude_key(folder)];
    let real_key = claude_key(real);
    if !keys.contains(&real_key) {
        keys.push(real_key);
    }
    let read = |path: &Path| -> Result<Map<String, Value>, TrustError> {
        match serde_json::from_slice(&fs::read(path)?) {
            Ok(Value::Object(map)) => Ok(map),
            _ => Err(TrustError::Bad(path.display().to_string())),
        }
    };
    // Cheap check first: a trusted folder takes no lock.
    if !claude_apply(&mut read(&target)?, &keys)? {
        return Ok(());
    }
    // Claude locks `<file>.lock` (a folder) while it writes: wait for it by
    // giving up, never by breaking its lock.
    let lock = LockDir::take(&file)?;
    let mut config = read(&target)?;
    if claude_apply(&mut config, &keys)? {
        let mut text = serde_json::to_string_pretty(&Value::Object(config)).unwrap_or_default();
        text.push('\n');
        let mode = fs::metadata(&target)?.permissions();
        write_atomic(&target, text.as_bytes(), Mode::Copy(mode))?;
    }
    drop(lock);
    Ok(())
}

/// A `<file>.lock` folder, taken with `create_dir` and removed on drop.
struct LockDir(PathBuf);

impl LockDir {
    fn take(file: &Path) -> io::Result<Self> {
        let mut name = file.as_os_str().to_owned();
        name.push(".lock");
        let dir = PathBuf::from(name);
        match fs::create_dir(&dir) {
            Ok(()) => Ok(Self(dir)),
            // Held by Claude (or a crashed one): leave it alone.
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "config is locked",
            )),
            Err(e) => Err(e),
        }
    }
}

impl Drop for LockDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

// ----------------------------------------------------------------- codex

fn codex(real: &Path, at: &TrustTarget) -> Result<(), TrustError> {
    let Some(home) = &at.codex_home else {
        return Ok(());
    };
    let file = home.join("config.toml");
    let mut config = match fs::read_to_string(&file) {
        Ok(text) => text
            .parse::<toml::Table>()
            .map_err(|_| TrustError::Bad(file.display().to_string()))?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => toml::Table::new(),
        Err(e) => return Err(e.into()),
    };
    let key = real.to_string_lossy().into_owned();
    let projects = config
        .entry("projects")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    let toml::Value::Table(projects) = projects else {
        return Err(TrustError::Bad("projects".to_owned()));
    };
    let entry = projects
        .entry(key)
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    let toml::Value::Table(entry) = entry else {
        return Err(TrustError::Bad("projects".to_owned()));
    };
    if entry.get("trust_level").and_then(toml::Value::as_str) == Some("trusted") {
        return Ok(());
    }
    entry.insert(
        "trust_level".to_owned(),
        toml::Value::String("trusted".to_owned()),
    );
    let text = toml::to_string(&config).map_err(|e| TrustError::Bad(e.to_string()))?;
    fs::create_dir_all(home)?;
    write_atomic(&file, text.as_bytes(), Mode::Default)?;
    Ok(())
}

// ---------------------------------------------------------------- cursor

/// The folder name Cursor keeps a project under: the path without its
/// leading separators, with each run of separators and characters Windows
/// forbids in a name turned into `-`.
pub(crate) fn cursor_slug(path: &str) -> String {
    let stripped = path.trim_start_matches(['/', '\\']);
    let mut out = String::with_capacity(stripped.len());
    let mut in_run = false;
    for c in stripped.chars() {
        if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            if !in_run {
                out.push('-');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

fn cursor(real: &Path, at: &TrustTarget) -> Result<(), TrustError> {
    let text = real.to_string_lossy().into_owned();
    let slug = cursor_slug(&text);
    if slug.is_empty() {
        return Ok(());
    }
    let dir = at.home.join(".cursor").join("projects").join(slug);
    let file = dir.join(".workspace-trusted");
    if file.exists() {
        return Ok(());
    }
    fs::create_dir_all(&dir)?;
    let payload = serde_json::json!({ "trustedAt": iso_utc_now(), "workspacePath": text });
    let mut out = serde_json::to_string_pretty(&payload).unwrap_or_default();
    out.push('\n');
    write_atomic(&file, out.as_bytes(), Mode::Default)?;
    Ok(())
}

// --------------------------------------------------------------- copilot

fn copilot(real: &Path, at: &TrustTarget) -> Result<(), TrustError> {
    let dir = at.home.join(".copilot");
    let file = dir.join("config.json");
    let mut config = match fs::read(&file) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(Value::Object(map)) => map,
            _ => return Err(TrustError::Bad(file.display().to_string())),
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => Map::new(),
        Err(e) => return Err(e.into()),
    };
    let key = real.to_string_lossy().into_owned();
    let mut folders = match config.remove("trustedFolders") {
        None => Vec::new(),
        Some(Value::Array(list)) => list,
        Some(_) => return Err(TrustError::Bad("trustedFolders".to_owned())),
    };
    let known = folders
        .iter()
        .filter_map(Value::as_str)
        .any(|f| same(&real_path(Path::new(f)), real));
    if !known {
        folders.push(Value::String(key));
    }
    let changed = !known;
    config.insert("trustedFolders".to_owned(), Value::Array(folders));
    if changed {
        fs::create_dir_all(&dir)?;
        let mut out = serde_json::to_string_pretty(&Value::Object(config)).unwrap_or_default();
        out.push('\n');
        // The file may hold tokens: owner-only.
        write_atomic(&file, out.as_bytes(), Mode::Private)?;
    }
    Ok(())
}

// ------------------------------------------------------------------ kimi

/// The record name Kimi keeps a folder under: `wd_<slug>_<sha256-12>`, from
/// the folder with `/` separators and no trailing one; a drive or UNC path
/// is lowercased first.
pub(crate) fn kimi_key(root: &str) -> String {
    let slashed = root.replace('\\', "/");
    let trimmed = slashed.trim_end_matches('/');
    let b = slashed.as_bytes();
    let windows_like = (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/')
        || slashed.starts_with("//");
    let normalized = if windows_like {
        trimmed.to_lowercase()
    } else {
        trimmed.to_owned()
    };
    let last = normalized.rsplit('/').next().unwrap_or("").to_lowercase();
    let mut slug = String::new();
    let mut in_run = false;
    for c in last.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            slug.push(c);
            in_run = false;
        } else {
            if !in_run {
                slug.push('-');
            }
            in_run = true;
        }
    }
    let slug = slug.trim_matches('-');
    let slug: String = slug.chars().take(40).collect();
    let slug = slug.trim_matches('-');
    let name = if slug.is_empty() || slug == "." || slug == ".." {
        "workspace"
    } else {
        slug
    };
    let digest = Sha256::digest(normalized.as_bytes());
    let hash: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    format!("wd_{name}_{hash}")
}

fn kimi(folder: &Path, real: &Path, at: &TrustTarget) -> Result<(), TrustError> {
    // Kimi keys on its cwd: the physical path on Unix, the path as given on
    // Windows.
    let root = if cfg!(windows) { folder } else { real };
    let root = root.to_string_lossy().into_owned();
    let home = at
        .kimi_home
        .clone()
        .unwrap_or_else(|| at.home.join(".kimi-code"));
    let dir = home.join("workspace-trust");
    let file = dir.join(kimi_key(&root));
    if file.exists() {
        return Ok(());
    }
    fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let record = serde_json::json!({ "root": root, "trustedAt": ms as u64 });
    write_atomic(&file, record.to_string().as_bytes(), Mode::Private)?;
    Ok(())
}

// --------------------------------------------------------------- helpers

/// `path` with links resolved and no `\\?\` prefix; `path` itself when it
/// does not exist.
fn real_path(path: &Path) -> PathBuf {
    let Ok(full) = fs::canonicalize(path) else {
        return path.to_path_buf();
    };
    let text = full.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => full,
    }
}

/// Whether two paths are the same place; case-blind on Windows.
fn same(a: &Path, b: &Path) -> bool {
    let a: PathBuf = a.components().collect();
    let b: PathBuf = b.components().collect();
    if cfg!(windows) {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

#[derive(Clone)]
enum Mode {
    Default,
    /// Owner-only on Unix; the default elsewhere.
    Private,
    /// The permissions of the file it replaces.
    Copy(fs::Permissions),
}

fn write_atomic(path: &Path, bytes: &[u8], mode: Mode) -> io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(
        ".{name}-{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            if matches!(mode, Mode::Private) {
                options.mode(0o600);
            }
        }
        let mut file = options.open(&tmp)?;
        if let Mode::Copy(permissions) = &mode {
            // Before the data goes in: a narrower mode never shows wider.
            file.set_permissions(permissions.clone())?;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Now as `2026-11-05T09:30:00.000Z`.
fn iso_utc_now() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    iso_utc(d.as_secs(), d.subsec_millis())
}

fn iso_utc(secs: u64, millis: u32) -> String {
    let days = (secs / 86_400) as i64;
    let rest = secs % 86_400;
    // Days since 1970-01-01 to a civil date (Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fx {
        _tmp: tempfile::TempDir,
        home: PathBuf,
        folder: PathBuf,
    }

    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let folder = tmp.path().join("work").join("My Project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&folder).unwrap();
        Fx {
            _tmp: tmp,
            home,
            folder,
        }
    }

    fn target(f: &Fx) -> TrustTarget {
        TrustTarget {
            home: f.home.clone(),
            claude_config: None,
            kimi_home: None,
            codex_home: None,
        }
    }

    fn json(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn real_key(f: &Fx) -> String {
        claude_key(&real_path(&f.folder))
    }

    #[test]
    fn home_and_root_are_unsafe_for_every_agent() {
        let f = fx();
        let at = target(&f);
        let root = f.folder.ancestors().last().unwrap().to_path_buf();
        for kind in [
            TrustKind::Claude,
            TrustKind::Codex,
            TrustKind::Cursor,
            TrustKind::Copilot,
            TrustKind::Kimi,
        ] {
            for bad in [&f.home, &root, &PathBuf::new()] {
                let err = trust_folder(kind, bad, &at).unwrap_err();
                assert!(matches!(err, TrustError::Unsafe), "{kind:?} {bad:?}");
                assert_eq!(err.code(), "trust_unsafe");
            }
        }
        // Nothing was written.
        assert_eq!(fs::read_dir(&f.home).unwrap().count(), 0);
    }

    #[test]
    fn claude_keeps_other_fields_and_adds_the_folder() {
        let f = fx();
        let file = f.home.join(".claude.json");
        fs::write(
            &file,
            r#"{"oauthAccount":{"emailAddress":"x"},"projects":{"/other":{"hasTrustDialogAccepted":true,"allowedTools":[]}}}"#,
        )
        .unwrap();
        trust_folder(TrustKind::Claude, &f.folder, &target(&f)).unwrap();
        let v = json(&file);
        assert_eq!(v["oauthAccount"]["emailAddress"], "x");
        assert_eq!(
            v["projects"]["/other"]["allowedTools"],
            serde_json::json!([])
        );
        assert_eq!(v["projects"][real_key(&f)]["hasTrustDialogAccepted"], true);
        // No lock or temp file is left.
        let names: Vec<_> = fs::read_dir(&f.home)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [".claude.json"]);
    }

    #[test]
    fn claude_keeps_the_fields_of_an_untrusted_entry() {
        let f = fx();
        let file = f.home.join(".claude.json");
        let key = real_key(&f);
        fs::write(
            &file,
            serde_json::json!({"projects": {key.clone(): {"allowedTools": ["x"]}}}).to_string(),
        )
        .unwrap();
        trust_folder(TrustKind::Claude, &f.folder, &target(&f)).unwrap();
        let v = json(&file);
        assert_eq!(v["projects"][&key]["allowedTools"][0], "x");
        assert_eq!(v["projects"][&key]["hasTrustDialogAccepted"], true);
    }

    #[test]
    fn claude_never_creates_a_missing_config() {
        let f = fx();
        trust_folder(TrustKind::Claude, &f.folder, &target(&f)).unwrap();
        assert_eq!(fs::read_dir(&f.home).unwrap().count(), 0);
    }

    #[test]
    fn claude_prefers_the_legacy_config_in_the_config_dir() {
        let f = fx();
        let cfg = f.home.join("cfg");
        fs::create_dir_all(&cfg).unwrap();
        fs::write(cfg.join(".config.json"), "{}").unwrap();
        fs::write(cfg.join(".claude.json"), "{}").unwrap();
        let mut at = target(&f);
        at.claude_config = Some(cfg.clone());
        trust_folder(TrustKind::Claude, &f.folder, &at).unwrap();
        assert!(json(&cfg.join(".config.json"))["projects"].is_object());
        assert_eq!(json(&cfg.join(".claude.json")), serde_json::json!({}));
        // Without the legacy file, the config dir's `.claude.json`.
        fs::remove_file(cfg.join(".config.json")).unwrap();
        trust_folder(TrustKind::Claude, &f.folder, &at).unwrap();
        assert!(json(&cfg.join(".claude.json"))["projects"].is_object());
    }

    #[test]
    fn claude_broken_json_is_bad_and_untouched() {
        let f = fx();
        let file = f.home.join(".claude.json");
        fs::write(&file, r#"{"oauthAccount": "#).unwrap();
        let err = trust_folder(TrustKind::Claude, &f.folder, &target(&f)).unwrap_err();
        assert!(matches!(err, TrustError::Bad(_)));
        assert_eq!(err.code(), "bad_trust_file");
        assert_eq!(fs::read_to_string(&file).unwrap(), r#"{"oauthAccount": "#);
        // A projects value of the wrong type is not replaced either.
        fs::write(&file, r#"{"projects":[]}"#).unwrap();
        assert!(trust_folder(TrustKind::Claude, &f.folder, &target(&f)).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), r#"{"projects":[]}"#);
    }

    #[test]
    fn claude_waits_out_a_held_lock_without_breaking_it() {
        let f = fx();
        let file = f.home.join(".claude.json");
        fs::write(&file, "{}").unwrap();
        let lock = f.home.join(".claude.json.lock");
        fs::create_dir(&lock).unwrap();
        let err = trust_folder(TrustKind::Claude, &f.folder, &target(&f)).unwrap_err();
        assert!(matches!(&err, TrustError::Io(e) if e.kind() == io::ErrorKind::WouldBlock));
        assert!(lock.is_dir());
        assert_eq!(fs::read_to_string(&file).unwrap(), "{}");
    }

    #[test]
    fn claude_trusted_folder_takes_no_lock() {
        let f = fx();
        let file = f.home.join(".claude.json");
        let key = real_key(&f);
        fs::write(
            &file,
            serde_json::json!({"projects": {key: {"hasTrustDialogAccepted": true}}}).to_string(),
        )
        .unwrap();
        fs::create_dir(f.home.join(".claude.json.lock")).unwrap();
        trust_folder(TrustKind::Claude, &f.folder, &target(&f)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn claude_keeps_the_mode_and_a_symlink() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let f = fx();
        let real = f.home.join("dotfiles.json");
        fs::write(&real, "{}").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let link = f.home.join(".claude.json");
        symlink(&real, &link).unwrap();
        trust_folder(TrustKind::Claude, &f.folder, &target(&f)).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
        assert_eq!(
            fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(json(&real)["projects"].is_object());
    }

    #[test]
    fn codex_writes_only_the_private_home() {
        let f = fx();
        // The person's own home is never touched, even when it exists.
        let own = f.home.join(".codex");
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join("config.toml"), "model = \"x\"\n").unwrap();
        trust_folder(TrustKind::Codex, &f.folder, &target(&f)).unwrap();
        assert_eq!(
            fs::read_to_string(own.join("config.toml")).unwrap(),
            "model = \"x\"\n"
        );
        let private = f.home.join("private");
        fs::create_dir_all(&private).unwrap();
        fs::write(
            private.join("config.toml"),
            "model = \"x\"\n[projects.\"/a\"]\nnotes = \"k\"\n",
        )
        .unwrap();
        let mut at = target(&f);
        at.codex_home = Some(private.clone());
        trust_folder(TrustKind::Codex, &f.folder, &at).unwrap();
        let config: toml::Table = fs::read_to_string(private.join("config.toml"))
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(config["model"].as_str(), Some("x"));
        assert_eq!(config["projects"]["/a"]["notes"].as_str(), Some("k"));
        let key = real_path(&f.folder).to_string_lossy().into_owned();
        assert_eq!(
            config["projects"][key.as_str()]["trust_level"].as_str(),
            Some("trusted")
        );
        // An untrusted entry is upgraded, its other keys kept; a repeat is a no-op.
        trust_folder(TrustKind::Codex, &f.folder, &at).unwrap();
    }

    #[test]
    fn codex_broken_toml_is_bad_and_untouched() {
        let f = fx();
        let private = f.home.join("private");
        fs::create_dir_all(&private).unwrap();
        fs::write(private.join("config.toml"), "[projects\n").unwrap();
        let mut at = target(&f);
        at.codex_home = Some(private.clone());
        assert!(matches!(
            trust_folder(TrustKind::Codex, &f.folder, &at),
            Err(TrustError::Bad(_))
        ));
        assert_eq!(
            fs::read_to_string(private.join("config.toml")).unwrap(),
            "[projects\n"
        );
    }

    #[test]
    fn cursor_writes_the_slug_folder_once() {
        let f = fx();
        let at = target(&f);
        trust_folder(TrustKind::Cursor, &f.folder, &at).unwrap();
        let real = real_path(&f.folder);
        let file = f
            .home
            .join(".cursor/projects")
            .join(cursor_slug(&real.to_string_lossy()))
            .join(".workspace-trusted");
        let v = json(&file);
        assert_eq!(v["workspacePath"], real.to_string_lossy().as_ref());
        assert!(v["trustedAt"].as_str().unwrap().ends_with('Z'));
        // An existing record is not rewritten.
        fs::write(&file, "{\"kept\":true}").unwrap();
        trust_folder(TrustKind::Cursor, &f.folder, &at).unwrap();
        assert_eq!(json(&file)["kept"], true);
    }

    #[test]
    fn cursor_slug_vectors() {
        assert_eq!(cursor_slug("/Users/me/My Project"), "Users-me-My Project");
        assert_eq!(cursor_slug(r"C:\Users\me\wt"), "C-Users-me-wt");
        assert_eq!(cursor_slug(r"\\server\share\a"), "server-share-a");
        assert_eq!(cursor_slug("/"), "");
    }

    #[test]
    fn copilot_appends_once_and_keeps_other_keys() {
        let f = fx();
        let dir = f.home.join(".copilot");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("config.json"),
            r#"{"copilotTokens":{"a":"secret"},"trustedFolders":["/old"]}"#,
        )
        .unwrap();
        let at = target(&f);
        trust_folder(TrustKind::Copilot, &f.folder, &at).unwrap();
        trust_folder(TrustKind::Copilot, &f.folder, &at).unwrap();
        let v = json(&dir.join("config.json"));
        assert_eq!(v["copilotTokens"]["a"], "secret");
        let list = v["trustedFolders"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], "/old");
        assert_eq!(list[1], real_path(&f.folder).to_string_lossy().as_ref());
    }

    #[test]
    fn copilot_creates_the_file_and_leaves_a_broken_one() {
        let f = fx();
        let file = f.home.join(".copilot/config.json");
        trust_folder(TrustKind::Copilot, &f.folder, &target(&f)).unwrap();
        assert_eq!(json(&file)["trustedFolders"].as_array().unwrap().len(), 1);
        fs::write(&file, "{").unwrap();
        assert!(matches!(
            trust_folder(TrustKind::Copilot, &f.folder, &target(&f)),
            Err(TrustError::Bad(_))
        ));
        assert_eq!(fs::read_to_string(&file).unwrap(), "{");
    }

    #[cfg(unix)]
    #[test]
    fn copilot_and_kimi_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let f = fx();
        let at = target(&f);
        // A restrictive umask must not hide a missing creation mode.
        trust_folder(TrustKind::Copilot, &f.folder, &at).unwrap();
        trust_folder(TrustKind::Kimi, &f.folder, &at).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&f.home.join(".copilot/config.json")), 0o600);
        let records: Vec<_> = fs::read_dir(f.home.join(".kimi-code/workspace-trust"))
            .unwrap()
            .collect();
        assert_eq!(records.len(), 1);
        assert_eq!(mode(&records[0].as_ref().unwrap().path()), 0o600);
        assert_eq!(mode(&f.home.join(".kimi-code/workspace-trust")), 0o700);
    }

    #[test]
    fn kimi_key_vectors() {
        // Captured from a real Kimi Code 2.3.1 run on macOS (reference).
        assert_eq!(
            kimi_key("/private/tmp/kimi-inst/ws/Sample Project"),
            "wd_sample-project_017c73b76124"
        );
        // Windows paths are lowercased, whatever the case or separators.
        assert_eq!(
            kimi_key(r"C:\projects\Sample Project"),
            "wd_sample-project_f415ab4f33c6"
        );
        assert_eq!(
            kimi_key(r"c:\PROJECTS\sample project"),
            "wd_sample-project_f415ab4f33c6"
        );
        assert!(kimi_key("/").starts_with("wd_workspace_"));
        assert!(kimi_key("/a/---").starts_with("wd_workspace_"));
        // The slug is cut at 40 characters.
        let long = format!("/x/{}", "a".repeat(60));
        assert!(kimi_key(&long).starts_with(&format!("wd_{}_", "a".repeat(40))));
    }

    #[test]
    fn kimi_writes_one_record_under_the_kimi_home() {
        let f = fx();
        let mut at = target(&f);
        let kimi_home = f.home.join("kimi");
        at.kimi_home = Some(kimi_home.clone());
        trust_folder(TrustKind::Kimi, &f.folder, &at).unwrap();
        trust_folder(TrustKind::Kimi, &f.folder, &at).unwrap();
        let records: Vec<_> = fs::read_dir(kimi_home.join("workspace-trust"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(records.len(), 1);
        let name = records[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(name.starts_with("wd_my-project_"), "{name}");
        let v = json(&records[0]);
        assert!(v["root"].is_string() && v["trustedAt"].is_u64());
    }

    #[test]
    fn iso_utc_formats_a_known_instant() {
        assert_eq!(iso_utc(0, 0), "1970-01-01T00:00:00.000Z");
        // 2026-11-05 09:30:07.042 UTC
        assert_eq!(iso_utc(1_793_871_007, 42), "2026-11-05T09:30:07.042Z");
        assert_eq!(iso_utc(951_782_400, 0), "2000-02-29T00:00:00.000Z");
    }
}
