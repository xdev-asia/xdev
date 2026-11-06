//! `remote_projects.json` and `remote_targets.json` in the data folder.
//! A missing file is empty; a file of another version is left alone and
//! every call on it fails, so nothing overwrites what a newer app wrote.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use xdev_ssh::{RemoteProject, RemoteTarget};

use crate::commands::CmdError;

pub(crate) const PROJECTS_FILE: &str = "remote_projects.json";
pub(crate) const TARGETS_FILE: &str = "remote_targets.json";
const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct Projects {
    v: u32,
    #[serde(default)]
    projects: Vec<RemoteProject>,
}

#[derive(Serialize, Deserialize)]
struct Targets {
    v: u32,
    #[serde(default)]
    targets: BTreeMap<String, RemoteTarget>,
}

#[derive(Deserialize)]
struct Versioned {
    v: u32,
}

fn io_error(file: &str, detail: impl std::fmt::Display) -> CmdError {
    CmdError {
        code: "io",
        detail: Some(format!("{file}: {detail}")),
    }
}

/// The file's content, `None` when it does not exist.
fn read<T: DeserializeOwned>(data: &Path, file: &str) -> Result<Option<T>, CmdError> {
    let bytes = match std::fs::read(data.join(file)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error(file, e)),
    };
    let v: Versioned = serde_json::from_slice(&bytes).map_err(|e| io_error(file, e))?;
    if v.v != VERSION {
        return Err(io_error(file, format!("version {}", v.v)));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| io_error(file, e))
}

fn write<T: Serialize>(data: &Path, file: &str, value: &T) -> Result<(), CmdError> {
    std::fs::create_dir_all(data).map_err(|e| io_error(file, e))?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| io_error(file, e))?;
    crate::atomic::write_atomic(&data.join(file), &bytes).map_err(|e| io_error(file, e))
}

pub(crate) fn load_projects(data: &Path) -> Result<Vec<RemoteProject>, CmdError> {
    Ok(read::<Projects>(data, PROJECTS_FILE)?
        .map(|f| f.projects)
        .unwrap_or_default())
}

pub(crate) fn save_projects(data: &Path, projects: &[RemoteProject]) -> Result<(), CmdError> {
    write(
        data,
        PROJECTS_FILE,
        &Projects {
            v: VERSION,
            projects: projects.to_vec(),
        },
    )
}

pub(crate) fn load_targets(data: &Path) -> Result<BTreeMap<String, RemoteTarget>, CmdError> {
    Ok(read::<Targets>(data, TARGETS_FILE)?
        .map(|f| f.targets)
        .unwrap_or_default())
}

pub(crate) fn save_targets(
    data: &Path,
    targets: &BTreeMap<String, RemoteTarget>,
) -> Result<(), CmdError> {
    write(
        data,
        TARGETS_FILE,
        &Targets {
            v: VERSION,
            targets: targets.clone(),
        },
    )
}

/// `rp_` and 12 random hex digits.
pub(crate) fn new_id() -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("rp_{}", &hex[..12])
}
