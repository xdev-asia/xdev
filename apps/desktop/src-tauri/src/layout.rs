//! The tab and split layout of every worktree, kept in `<data_dir>/layout.json`
//! so it comes back after a restart. The shape belongs to the UI (R3): the
//! backend stores it as opaque JSON and checks only its `version` and size.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use tauri::State;

use crate::accounts::data_dir;
use crate::atomic::write_atomic;
use crate::commands::{AppState, CmdError};

/// The snapshot version this build reads and writes.
pub const LAYOUT_VERSION: u32 = 1;
/// The largest snapshot stored, in bytes; a larger one is refused.
pub const LAYOUT_MAX: usize = 1024 * 1024;
/// The file under the data folder.
pub const FILE_NAME: &str = "layout.json";

/// The saved snapshot; `None` when there is none, when it is from a newer
/// build (left as it is), or when it does not parse (then kept as
/// `layout.json.bad`).
#[tauri::command(async)]
pub fn layout_load(state: State<'_, AppState>) -> Result<Option<serde_json::Value>, CmdError> {
    load(data_dir(&state)?)
}

/// Replaces the saved snapshot. Rejects with `bad_arg` when its `version` is
/// not [`LAYOUT_VERSION`] and `too_large` past [`LAYOUT_MAX`] bytes. A newer
/// build's file is first moved aside as `layout.json.v<version>`.
#[tauri::command(async)]
pub fn layout_save(
    state: State<'_, AppState>,
    snapshot: serde_json::Value,
) -> Result<(), CmdError> {
    save(data_dir(&state)?, &snapshot)
}

/// Saves run one at a time, so moving a newer file aside and writing ours
/// are not interleaved with another save.
static SAVE: Mutex<()> = Mutex::new(());

fn io_err(e: impl ToString) -> CmdError {
    CmdError {
        code: "io",
        detail: Some(e.to_string()),
    }
}

/// The snapshot's `version`, when it is an object with a whole number there.
fn version_of(value: &serde_json::Value) -> Option<u64> {
    value.get("version")?.as_u64()
}

/// What is on disk: nothing, a snapshot this build reads, one from a newer
/// build (left alone), or bytes that do not parse.
enum OnDisk {
    Missing,
    Current(serde_json::Value),
    Other(u64),
    Broken,
}

fn read(path: &Path) -> Result<OnDisk, CmdError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(OnDisk::Missing),
        Err(e) => return Err(io_err(e)),
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Ok(OnDisk::Broken);
    };
    Ok(match version_of(&value) {
        Some(v) if v == u64::from(LAYOUT_VERSION) => OnDisk::Current(value),
        Some(v) if v > u64::from(LAYOUT_VERSION) => OnDisk::Other(v),
        _ => OnDisk::Broken,
    })
}

/// `<file>.<suffix>` beside the file.
fn beside(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{suffix}"));
    PathBuf::from(name)
}

fn load(dir: &Path) -> Result<Option<serde_json::Value>, CmdError> {
    let path = dir.join(FILE_NAME);
    match read(&path)? {
        OnDisk::Current(value) => Ok(Some(value)),
        OnDisk::Missing | OnDisk::Other(_) => Ok(None),
        OnDisk::Broken => {
            // Kept, not deleted: a person can still look at it.
            let _guard = SAVE.lock().unwrap_or_else(PoisonError::into_inner);
            let _ = fs::rename(&path, beside(&path, "bad"));
            Ok(None)
        }
    }
}

fn save(dir: &Path, snapshot: &serde_json::Value) -> Result<(), CmdError> {
    if version_of(snapshot) != Some(u64::from(LAYOUT_VERSION)) {
        return Err(CmdError {
            code: "bad_arg",
            detail: Some(format!("layout version is not {LAYOUT_VERSION}")),
        });
    }
    let bytes = serde_json::to_vec(snapshot).map_err(io_err)?;
    if bytes.len() > LAYOUT_MAX {
        return Err(CmdError {
            code: "too_large",
            detail: Some(format!("layout is over {LAYOUT_MAX} bytes")),
        });
    }
    let path = dir.join(FILE_NAME);
    let _guard = SAVE.lock().unwrap_or_else(PoisonError::into_inner);
    // A newer build's file is kept under its version, not written over.
    if let OnDisk::Other(v) = read(&path)? {
        fs::rename(&path, beside(&path, &format!("v{v}"))).map_err(io_err)?;
    }
    write_atomic(&path, &bytes).map_err(io_err)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::*;

    fn snapshot(n: u32) -> serde_json::Value {
        json!({
            "version": LAYOUT_VERSION,
            "savedAt": 1,
            "worktrees": { "C:/w/oak": { "layout": { "n": n }, "tabs": { "t1": { "kind": "review" } } } },
        })
    }

    fn code(r: Result<(), CmdError>) -> &'static str {
        r.unwrap_err().code
    }

    /// Every name in `dir`, sorted.
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn no_file_loads_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), None);
        assert_eq!(load(&dir.path().join("not-made-yet")).unwrap(), None);
    }

    #[test]
    fn a_saved_snapshot_loads_back_the_same() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        save(&data, &snapshot(1)).unwrap();
        assert_eq!(load(&data).unwrap(), Some(snapshot(1)));
        save(&data, &snapshot(2)).unwrap();
        assert_eq!(load(&data).unwrap(), Some(snapshot(2)));
        assert_eq!(names(&data), [FILE_NAME]);
    }

    #[test]
    fn a_wrong_version_is_refused_and_the_file_kept() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &snapshot(1)).unwrap();
        let before = fs::read(dir.path().join(FILE_NAME)).unwrap();
        for bad in [
            json!({ "version": LAYOUT_VERSION + 1, "worktrees": {} }),
            json!({ "version": "1", "worktrees": {} }),
            json!({ "worktrees": {} }),
            json!([1]),
        ] {
            assert_eq!(code(save(dir.path(), &bad)), "bad_arg", "{bad}");
        }
        assert_eq!(fs::read(dir.path().join(FILE_NAME)).unwrap(), before);
    }

    #[test]
    fn a_snapshot_over_the_cap_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &snapshot(1)).unwrap();
        let mut big = snapshot(1);
        big["pad"] = json!("x".repeat(LAYOUT_MAX));
        assert_eq!(code(save(dir.path(), &big)), "too_large");
        assert_eq!(load(dir.path()).unwrap(), Some(snapshot(1)));
    }

    #[test]
    fn a_broken_file_loads_none_and_is_kept_as_bad() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), "{ not json").unwrap();
        assert_eq!(load(dir.path()).unwrap(), None);
        assert_eq!(names(dir.path()), [format!("{FILE_NAME}.bad")]);
        let kept = fs::read_to_string(dir.path().join(format!("{FILE_NAME}.bad"))).unwrap();
        assert_eq!(kept, "{ not json");
        save(dir.path(), &snapshot(1)).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Some(snapshot(1)));
    }

    #[test]
    fn a_newer_file_is_ignored_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let newer = json!({ "version": LAYOUT_VERSION + 1, "worktrees": { "x": 1 } }).to_string();
        fs::write(dir.path().join(FILE_NAME), &newer).unwrap();
        assert_eq!(load(dir.path()).unwrap(), None);
        assert_eq!(
            fs::read_to_string(dir.path().join(FILE_NAME)).unwrap(),
            newer
        );
        // A save does not overwrite it: it moves aside under its version.
        save(dir.path(), &snapshot(1)).unwrap();
        let aside = format!("{FILE_NAME}.v{}", LAYOUT_VERSION + 1);
        assert_eq!(fs::read_to_string(dir.path().join(&aside)).unwrap(), newer);
        assert_eq!(load(dir.path()).unwrap(), Some(snapshot(1)));
    }
}
