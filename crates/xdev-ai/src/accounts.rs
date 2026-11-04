use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::AiError;
use crate::claude::AccountStatus;

const FILE: &str = "accounts.json";
const VERSION: u32 = 1;
const DEFAULT_RESERVE: u8 = 30;
const MAX_RESERVE: u8 = 90;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }

    pub fn parse(text: &str) -> Result<Provider, AiError> {
        match text {
            "claude" => Ok(Provider::Claude),
            "codex" => Ok(Provider::Codex),
            _ => Err(AiError::UnknownProvider),
        }
    }

    /// The provider's CLI, or `no_claude` / `no_codex`.
    pub fn command(self) -> Result<Command, AiError> {
        match self {
            Provider::Claude => crate::claude::claude_command(),
            Provider::Codex => crate::codex::codex_command(),
        }
    }

    /// The variable that points the CLI at the account's folder.
    pub fn home_var(self) -> &'static str {
        match self {
            Provider::Claude => "CLAUDE_CONFIG_DIR",
            Provider::Codex => "CODEX_HOME",
        }
    }

    /// The CLI arguments that sign an account in.
    pub fn login_args(self) -> &'static [&'static str] {
        match self {
            Provider::Claude => &["auth", "login"],
            Provider::Codex => &["login"],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountEntry {
    pub name: String,
    pub provider: Provider,
    pub dir: PathBuf,
}

/// The account a provider's new agent tabs run as when neither the tab nor
/// the profile names one. At most one per provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ActiveAccount {
    pub provider: Provider,
    pub name: String,
}

/// The accounts registered on this machine, kept in `<data dir>/accounts.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registry {
    pub reserve_percent: u8,
    pub accounts: Vec<AccountEntry>,
    /// The active account per provider; none means the CLI's own home.
    pub active: Vec<ActiveAccount>,
}

#[derive(Serialize, Deserialize)]
struct OnDisk {
    version: u32,
    reserve_percent: u8,
    accounts: Vec<AccountEntry>,
    // A file from before active accounts has none.
    #[serde(default)]
    active: Vec<ActiveAccount>,
}

impl Default for Registry {
    fn default() -> Self {
        Registry {
            reserve_percent: DEFAULT_RESERVE,
            accounts: Vec::new(),
            active: Vec::new(),
        }
    }
}

impl Registry {
    /// A file this version cannot fully understand is an error rather than
    /// an empty registry, so a later `save` never wipes it.
    pub fn load(data_dir: &Path) -> Result<Registry, AiError> {
        let text = match fs::read_to_string(data_dir.join(FILE)) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Registry::default()),
            Err(e) if e.kind() == io::ErrorKind::InvalidData => return Err(AiError::BadRegistry),
            Err(e) => return Err(AiError::Io(e)),
        };
        let disk: OnDisk = serde_json::from_str(&text).map_err(|_| AiError::BadRegistry)?;
        if disk.version != VERSION || disk.reserve_percent > MAX_RESERVE {
            return Err(AiError::BadRegistry);
        }
        let mut reg = Registry {
            reserve_percent: disk.reserve_percent,
            accounts: Vec::with_capacity(disk.accounts.len()),
            active: Vec::new(),
        };
        for entry in disk.accounts {
            reg.add(&entry.name, entry.provider, entry.dir)
                .map_err(|_| AiError::BadRegistry)?;
        }
        // A hand edit that names no such account, or a second one for a
        // provider, is left out: the effect is the CLI's own home, which is
        // safer than refusing the whole file.
        for entry in disk.active {
            if reg.active(entry.provider).is_none() {
                let _ = reg.activate(entry.provider, Some(&entry.name));
            }
        }
        Ok(reg)
    }

    pub fn save(&self, data_dir: &Path) -> Result<(), AiError> {
        let disk = OnDisk {
            version: VERSION,
            reserve_percent: self.reserve_percent,
            accounts: self.accounts.clone(),
            active: self.active.clone(),
        };
        let mut text = serde_json::to_string_pretty(&disk).map_err(io::Error::other)?;
        text.push('\n');
        write_atomic(data_dir, &text)?;
        Ok(())
    }

    pub fn add(
        &mut self,
        name: &str,
        provider: Provider,
        dir: PathBuf,
    ) -> Result<&AccountEntry, AiError> {
        if !valid_name(name) {
            return Err(AiError::BadName);
        }
        if self.get(name).is_some() {
            return Err(AiError::Exists);
        }
        self.accounts.push(AccountEntry {
            name: name.to_owned(),
            provider,
            dir,
        });
        Ok(self.accounts.last().expect("just pushed"))
    }

    /// Only unregisters: the folder holds the person's credentials, which
    /// xDev never deletes.
    pub fn remove(&mut self, name: &str) -> Result<AccountEntry, AiError> {
        let index = self
            .accounts
            .iter()
            .position(|a| a.name == name)
            .ok_or(AiError::NotFound)?;
        self.active.retain(|a| a.name != name);
        Ok(self.accounts.remove(index))
    }

    pub fn set_reserve(&mut self, percent: u8) -> Result<(), AiError> {
        if percent > MAX_RESERVE {
            return Err(AiError::BadReserve);
        }
        self.reserve_percent = percent;
        Ok(())
    }

    pub fn get(&self, name: &str) -> Option<&AccountEntry> {
        self.accounts.iter().find(|a| a.name == name)
    }

    /// Makes `name` the active account of `provider`; `None` clears it, so
    /// the provider's tabs run on the CLI's own home. An unknown name or
    /// another provider's account is `NotFound`.
    pub fn activate(&mut self, provider: Provider, name: Option<&str>) -> Result<(), AiError> {
        if let Some(name) = name
            && !self
                .get(name)
                .is_some_and(|entry| entry.provider == provider)
        {
            return Err(AiError::NotFound);
        }
        self.active.retain(|a| a.provider != provider);
        if let Some(name) = name {
            self.active.push(ActiveAccount {
                provider,
                name: name.to_owned(),
            });
        }
        Ok(())
    }

    /// The active account of `provider`, when it names a registered one.
    pub fn active(&self, provider: Provider) -> Option<&AccountEntry> {
        let active = self.active.iter().find(|a| a.provider == provider)?;
        self.get(&active.name)
            .filter(|entry| entry.provider == provider)
    }
}

/// Copies the session log `session` (the CLI's session id) from `from`'s
/// home into `to`'s, at the same path under the home, when `to` does not
/// have it yet; returns whether it copied. `cwd` is the folder the session
/// ran in. A log that is not in `from` is `SessionMissing`. Never moves nor
/// overwrites a log.
pub fn carry_session(
    from: &AccountEntry,
    to: &AccountEntry,
    session: &str,
    cwd: &Path,
) -> Result<bool, AiError> {
    // A plain token, like the resume id: nothing in it can climb out of
    // the home.
    let plain = !session.is_empty()
        && session.len() <= 128
        && session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !plain {
        return Err(AiError::SessionMissing);
    }
    let src = find_session(from, session, cwd).ok_or(AiError::SessionMissing)?;
    if find_session(to, session, cwd).is_some() {
        return Ok(false);
    }
    let rel = src
        .strip_prefix(&from.dir)
        .map_err(|_| AiError::SessionMissing)?;
    let dest = to.dir.join(rel);
    let parent = dest.parent().ok_or(AiError::SessionMissing)?;
    fs::create_dir_all(parent)?;
    // Copy beside the target, then link it in: a link never replaces a file
    // that appeared meanwhile, and a reader never sees half a log.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = parent.join(format!(
        ".carry-{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let linked = fs::copy(&src, &tmp).and_then(|_| fs::hard_link(&tmp, &dest));
    let _ = fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// The log of `session` under the account's home. Claude keeps it at
/// `projects/<cwd key>/<id>.jsonl` (any project folder will do), Codex at
/// `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`.
fn find_session(account: &AccountEntry, session: &str, cwd: &Path) -> Option<PathBuf> {
    match account.provider {
        Provider::Claude => {
            let projects = account.dir.join("projects");
            let file = format!("{session}.jsonl");
            let own = projects.join(claude_project_key(cwd)).join(&file);
            if own.is_file() {
                return Some(own);
            }
            fs::read_dir(&projects)
                .ok()?
                .flatten()
                .map(|e| e.path().join(&file))
                .find(|p| p.is_file())
        }
        Provider::Codex => {
            let suffix = format!("-{session}.jsonl");
            find_file(&account.dir.join("sessions"), &|name| {
                name.starts_with("rollout-") && name.ends_with(&suffix)
            })
        }
    }
}

/// The folder Claude keeps a project's sessions under: every char that is
/// not ASCII alphanumeric becomes `-`.
fn claude_project_key(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The first file under `dir` whose name matches, depth first.
fn find_file(dir: &Path, matches: &dyn Fn(&str) -> bool) -> Option<PathBuf> {
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            if let Some(found) = find_file(&path, matches) {
                return Some(found);
            }
        } else if kind.is_file() && entry.file_name().to_str().is_some_and(matches) {
            return Some(path);
        }
    }
    None
}

/// The home a provider's CLI uses with no account: its home variable from
/// the environment, else `~/.claude` or `~/.codex`.
pub fn default_home(provider: Provider) -> Option<PathBuf> {
    match provider {
        Provider::Claude => {
            if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
                return Some(PathBuf::from(dir));
            }
            let user = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .filter(|h| !h.is_empty())?;
            Some(PathBuf::from(user).join(".claude"))
        }
        Provider::Codex => crate::codex::codex_home(None),
    }
}

/// Sign-in state from the account's own CLI. Never fails: a missing CLI is
/// `no_claude` / `no_codex`, anything else unexpected is `error`.
pub fn status(entry: &AccountEntry) -> AccountStatus {
    match entry.provider {
        Provider::Claude => crate::claude::status(&entry.dir),
        Provider::Codex => crate::codex::status(&entry.dir),
    }
}

/// The command that signs an account in, in the platform shell's own syntax.
pub fn login_command(provider: Provider, dir: &Path, windows: bool) -> String {
    let dir = dir.to_string_lossy();
    let var = provider.home_var();
    let run = format!("{} {}", provider.as_str(), provider.login_args().join(" "));
    if windows {
        format!("$env:{var}='{}'; {run}", dir.replace('\'', "''"))
    } else {
        format!("{var}='{}' {run}", dir.replace('\'', r"'\''"))
    }
}

/// Where a new account's folder (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`) goes.
pub fn account_dir(data_dir: &Path, name: &str) -> PathBuf {
    data_dir.join("accounts").join(name)
}

/// `^[a-z0-9][a-z0-9-]{0,31}$`. The name becomes a folder name, so nothing
/// that could climb out of `accounts/` gets through.
pub fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0] != b'-'
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn write_atomic(data_dir: &Path, content: &str) -> io::Result<()> {
    fs::create_dir_all(data_dir)?;
    // Same folder as the target so the rename never crosses a filesystem and
    // a reader never sees a half-written registry.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = data_dir.join(format!(
        ".{FILE}-{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = File::create_new(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, data_dir.join(FILE))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
