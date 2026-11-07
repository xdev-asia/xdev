use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use xdev_ssh::remote_logs::{LogEntry, LogSource};
use xdev_ssh::{EntryKind, RemoteError};

use super::*;

/// 2026-11-07 12:00 UTC.
const NOW: u64 = 1_794_052_800_000;
const CLAUDE_LOG: &str = concat!(
    r#"{"type":"user","uuid":"u1","sessionId":"5f0c1e2a-0000-4000-8000-000000000001","cwd":"/srv/p","timestamp":"2026-11-06T10:00:00.000Z","message":{"role":"user","content":"hello"}}"#,
    "\n"
);
const CODEX_LOG: &str = concat!(
    r#"{"timestamp":"2026-11-06T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}"#,
    "\n"
);
const CODEX_ID: &str = "01a1a18f-2257-7d10-81b3-4888e4b169ff";
const CLAUDE_REL: &str = "home/u/.claude/projects/-srv-p/s1.jsonl";

/// A host stood in by a folder; counts the bytes read.
struct FakeHost {
    root: PathBuf,
    read: u64,
}

impl FakeHost {
    fn new(root: &Path) -> Self {
        FakeHost {
            root: root.to_path_buf(),
            read: 0,
        }
    }
}

impl LogSource for FakeHost {
    fn list(&mut self, dir: &str) -> Result<Vec<LogEntry>, RemoteError> {
        let path = self.root.join(dir.trim_start_matches('/'));
        let rd = std::fs::read_dir(path).map_err(|_| RemoteError::NotFound)?;
        Ok(rd
            .flatten()
            .map(|e| {
                let meta = e.metadata().unwrap();
                let ms = meta
                    .modified()
                    .unwrap()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64;
                let kind = if meta.is_dir() {
                    EntryKind::Dir
                } else {
                    EntryKind::File
                };
                (
                    e.file_name().to_string_lossy().into_owned(),
                    kind,
                    meta.len(),
                    ms,
                )
            })
            .collect())
    }

    fn read_at(&mut self, path: &str, offset: u64, len: u64) -> Result<Vec<u8>, RemoteError> {
        let all = std::fs::read(self.root.join(path.trim_start_matches('/')))
            .map_err(|_| RemoteError::NotFound)?;
        let from = (offset as usize).min(all.len());
        let to = (from + len as usize).min(all.len());
        self.read += (to - from) as u64;
        Ok(all[from..to].to_vec())
    }
}

fn put_log(root: &Path, rel: &str, text: &str, append: bool, mtime_ms: u64) {
    use std::io::Write;
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(append)
        .write(!append)
        .truncate(!append)
        .open(&path)
        .unwrap();
    f.write_all(text.as_bytes()).unwrap();
    f.set_modified(UNIX_EPOCH + Duration::from_millis(mtime_ms))
        .unwrap();
}

fn history() -> EffectiveHistory {
    effective(None, "box").history
}

#[test]
fn a_sync_mirrors_the_logs_and_indexes_both_agents() {
    let remote = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    put_log(
        remote.path(),
        CLAUDE_REL,
        CLAUDE_LOG,
        false,
        NOW - 3_600_000,
    );
    let codex =
        format!("home/u/.codex/sessions/2026/11/06/rollout-2026-11-06T10-00-00-{CODEX_ID}.jsonl");
    put_log(remote.path(), &codex, CODEX_LOG, false, NOW - 3_600_000);
    let mut src = FakeHost::new(remote.path());
    let st = sync_with(&mut src, "/home/u", data.path(), "ssh-a", &history(), NOW).unwrap();
    assert_eq!(
        (st.files, st.last_sync_ms, st.capped),
        (2, Some(NOW), false)
    );
    let root = host_dir(data.path(), "ssh-a");
    assert!(root.join("logs/claude/projects/-srv-p/s1.jsonl").is_file());
    let index = xdev_kit::SessionIndex::load(&root);
    let mut homes: Vec<String> = index.list().iter().map(|s| s.home_id.clone()).collect();
    homes.sort();
    assert_eq!(homes, ["ssh-a-claude", "ssh-a-codex"]);
    assert_eq!(read_status(data.path(), "ssh-a").files, 2);
}

#[test]
fn a_second_sync_fetches_only_the_tail() {
    let remote = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    put_log(
        remote.path(),
        CLAUDE_REL,
        CLAUDE_LOG,
        false,
        NOW - 3_600_000,
    );
    let mut src = FakeHost::new(remote.path());
    sync_with(&mut src, "/home/u", data.path(), "ssh-a", &history(), NOW).unwrap();
    assert_eq!(src.read, CLAUDE_LOG.len() as u64);

    // Same size and time: nothing is read.
    src.read = 0;
    sync_with(&mut src, "/home/u", data.path(), "ssh-a", &history(), NOW).unwrap();
    assert_eq!(src.read, 0);

    // Appended: only the new bytes come over, and the mirror equals the host.
    let extra = CLAUDE_LOG.replace("u1", "u2");
    put_log(remote.path(), CLAUDE_REL, &extra, true, NOW - 3_000_000);
    src.read = 0;
    sync_with(&mut src, "/home/u", data.path(), "ssh-a", &history(), NOW).unwrap();
    assert_eq!(src.read, extra.len() as u64);
    let mirrored = std::fs::read_to_string(
        host_dir(data.path(), "ssh-a").join("logs/claude/projects/-srv-p/s1.jsonl"),
    )
    .unwrap();
    assert_eq!(mirrored, format!("{CLAUDE_LOG}{extra}"));
}

#[test]
fn an_absent_agent_home_is_not_an_error() {
    let remote = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let mut src = FakeHost::new(remote.path());
    let st = sync_with(&mut src, "/home/u", data.path(), "ssh-a", &history(), NOW).unwrap();
    assert_eq!(st.files, 0);
}

#[test]
fn homes_resolve_against_the_login_folder() {
    assert_eq!(resolve_home("~/.claude", "/home/u/"), "/home/u/.claude");
    assert_eq!(resolve_home("~", "/home/u"), "/home/u");
    assert_eq!(resolve_home("/opt/c", "/home/u"), "/opt/c");
}

#[test]
fn turning_history_off_deletes_the_mirror() {
    let remote = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    put_log(
        remote.path(),
        CLAUDE_REL,
        CLAUDE_LOG,
        false,
        NOW - 3_600_000,
    );
    let mut src = FakeHost::new(remote.path());
    sync_with(&mut src, "/home/u", data.path(), "ssh-a", &history(), NOW).unwrap();
    assert!(host_dir(data.path(), "ssh-a").join("logs").is_dir());
    remove_mirror(data.path(), "ssh-a");
    assert!(!host_dir(data.path(), "ssh-a").exists());
}
