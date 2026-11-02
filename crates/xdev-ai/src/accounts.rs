use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::AiError;

const FILE: &str = "accounts.json";
const VERSION: u32 = 1;
const DEFAULT_RESERVE: u8 = 30;
const MAX_RESERVE: u8 = 90;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountEntry {
    pub name: String,
    pub provider: Provider,
    pub dir: PathBuf,
}

/// The accounts registered on this machine, kept in `<data dir>/accounts.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registry {
    pub reserve_percent: u8,
    pub accounts: Vec<AccountEntry>,
}

#[derive(Serialize, Deserialize)]
struct OnDisk {
    version: u32,
    reserve_percent: u8,
    accounts: Vec<AccountEntry>,
}

impl Default for Registry {
    fn default() -> Self {
        Registry {
            reserve_percent: DEFAULT_RESERVE,
            accounts: Vec::new(),
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
        };
        for entry in disk.accounts {
            reg.add(&entry.name, entry.dir)
                .map_err(|_| AiError::BadRegistry)?;
        }
        Ok(reg)
    }

    pub fn save(&self, data_dir: &Path) -> Result<(), AiError> {
        let disk = OnDisk {
            version: VERSION,
            reserve_percent: self.reserve_percent,
            accounts: self.accounts.clone(),
        };
        let mut text = serde_json::to_string_pretty(&disk).map_err(io::Error::other)?;
        text.push('\n');
        write_atomic(data_dir, &text)?;
        Ok(())
    }

    pub fn add(&mut self, name: &str, dir: PathBuf) -> Result<&AccountEntry, AiError> {
        if !valid_name(name) {
            return Err(AiError::BadName);
        }
        if self.get(name).is_some() {
            return Err(AiError::Exists);
        }
        self.accounts.push(AccountEntry {
            name: name.to_owned(),
            provider: Provider::Claude,
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
}

/// Where a new account's Claude Code config folder goes.
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
