use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::HomeSource;

const T_NOV2_10H: i64 = 1_793_613_600_000;
const T_NOV3_09H: i64 = 1_793_696_400_000;
const CLAUDE_ID: &str = "5f0c1e2a-0000-4000-8000-000000000001";
const CODEX_ID: &str = "01a1a18f-2257-7d10-81b3-4888e4b169ff";

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("sessions")
        .join(name)
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn home(id: &str, agent: Agent, path: &Path) -> Home {
    Home {
        id: id.to_string(),
        agent,
        path: path.to_path_buf(),
        source: HomeSource::Own,
    }
}

fn fixture_home(agent: Agent) -> (tempfile::TempDir, Home) {
    let dir = tempfile::tempdir().unwrap();
    let (name, id) = match agent {
        Agent::Claude => ("claude", "own-claude"),
        Agent::Codex => ("codex", "own-codex"),
    };
    copy_tree(&fixture(name), dir.path());
    let h = home(id, agent, dir.path());
    (dir, h)
}

/// A temp claude home with one session file; returns (dir, home, file).
fn claude_home_with(content: &str) -> (tempfile::TempDir, Home, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let proj = dir.path().join("projects").join("-work-demo");
    fs::create_dir_all(&proj).unwrap();
    let file = proj.join("s-x.jsonl");
    fs::write(&file, content).unwrap();
    let h = home("own-claude", Agent::Claude, dir.path());
    (dir, h, file)
}

fn prompt(ts: &str, text: &str) -> String {
    format!(
        r#"{{"type":"user","cwd":"/work/demo","gitBranch":"main","timestamp":"{ts}","message":{{"role":"user","content":"{text}"}}}}"#
    ) + "\n"
}

fn reply(ts: &str, id: &str) -> String {
    format!(
        r#"{{"type":"assistant","cwd":"/work/demo","timestamp":"{ts}","message":{{"id":"{id}","model":"model-a","content":[]}}}}"#
    ) + "\n"
}

fn append(path: &Path, text: &str) {
    use std::io::Write;
    let mut f = fs::OpenOptions::new().append(true).open(path).unwrap();
    f.write_all(text.as_bytes()).unwrap();
}

fn only(index: &SessionIndex) -> &AgentSession {
    assert_eq!(index.sessions.len(), 1, "{:?}", index.sessions.keys());
    index.sessions.values().next().unwrap()
}

#[test]
fn a_claude_log_gives_its_folder_branch_model_times_and_first_prompt() {
    let (_dir, h) = fixture_home(Agent::Claude);
    let mut index = SessionIndex::default();
    let stats = index.refresh(&[h]);
    assert_eq!(stats.files_read, 1);
    assert_eq!(stats.bad_lines, 0);
    let s = only(&index);
    assert_eq!(s.key, format!("own-claude:{CLAUDE_ID}"));
    assert_eq!(s.id, CLAUDE_ID);
    assert_eq!(s.home_id, "own-claude");
    assert_eq!(s.agent, Agent::Claude);
    assert_eq!(s.cwd.as_deref(), Some("/work/demo"));
    assert_eq!(s.branch.as_deref(), Some("feat/parser"));
    assert_eq!(s.model.as_deref(), Some("model-b"));
    assert_eq!(s.title.as_deref(), Some("Fix the parser on Windows paths"));
    assert_eq!(s.first, T_NOV2_10H);
    assert_eq!(s.last, T_NOV3_09H);
    // Two prompts (not the meta line, the command or the tool result) and
    // two replies (msg_01 is logged twice).
    assert_eq!(s.messages, 4);
}

#[test]
fn the_index_keeps_no_conversation_text() {
    for agent in [Agent::Claude, Agent::Codex] {
        let (_dir, h) = fixture_home(agent);
        let mut index = SessionIndex::default();
        index.refresh(&[h]);
        assert_eq!(index.sessions.len(), 1);
        let json = serde_json::to_string(&index).unwrap();
        assert!(!json.contains("SECRET"), "{json}");
    }
}

#[test]
fn a_codex_log_gives_its_session_id_branch_model_and_first_prompt() {
    let (_dir, h) = fixture_home(Agent::Codex);
    let mut index = SessionIndex::default();
    index.refresh(&[h]);
    let s = only(&index);
    assert_eq!(s.key, format!("own-codex:{CODEX_ID}"));
    assert_eq!(s.id, CODEX_ID);
    assert_eq!(s.agent, Agent::Codex);
    assert_eq!(s.cwd.as_deref(), Some("/work/cli-demo"));
    assert_eq!(s.branch.as_deref(), Some("main"));
    assert_eq!(s.model.as_deref(), Some("model-c"));
    assert_eq!(s.title.as_deref(), Some("Add a sessions panel"));
    assert_eq!(s.first, T_NOV2_10H);
    assert_eq!(s.last, T_NOV2_10H + 10_000);
    assert_eq!(s.messages, 2);
}

#[test]
fn a_codex_log_without_meta_takes_the_id_from_the_file_name() {
    let dir = tempfile::tempdir().unwrap();
    let day = dir
        .path()
        .join("sessions")
        .join("2026")
        .join("11")
        .join("02");
    fs::create_dir_all(&day).unwrap();
    fs::write(
        day.join(format!("rollout-2026-11-02T10-00-00-{CODEX_ID}.jsonl")),
        concat!(
            r#"{"timestamp":"2026-11-02T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}"#,
            "\n"
        ),
    )
    .unwrap();
    let mut index = SessionIndex::default();
    index.refresh(&[home("own-codex", Agent::Codex, dir.path())]);
    let s = only(&index);
    assert_eq!(s.id, CODEX_ID);
    assert_eq!(s.title.as_deref(), Some("hi"));
    assert_eq!(s.cwd, None);
}

#[test]
fn an_appended_log_is_read_from_its_mark_only() {
    let first = prompt("2026-11-02T10:00:00Z", "one") + &reply("2026-11-02T10:00:01Z", "m1");
    let (_dir, h, file) = claude_home_with(&first);
    let mut index = SessionIndex::default();
    let stats = index.refresh(std::slice::from_ref(&h));
    assert_eq!(stats.bytes, first.len() as u64);
    assert_eq!(only(&index).messages, 2);

    // The same reply logged again, a new prompt, and half a line.
    let more = reply("2026-11-02T10:00:02Z", "m1") + &prompt("2026-11-02T10:00:03Z", "two");
    append(&file, &more);
    append(&file, r#"{"type":"assistant","#);
    let stats = index.refresh(std::slice::from_ref(&h));
    assert_eq!(stats.files_read, 1);
    assert_eq!(stats.bytes, more.len() as u64);
    let s = only(&index);
    assert_eq!(s.messages, 3);
    assert_eq!(s.title.as_deref(), Some("one"));
    assert_eq!(s.last, T_NOV2_10H + 3_000);

    // Unchanged: not opened.
    let stats = index.refresh(std::slice::from_ref(&h));
    assert_eq!((stats.files_read, stats.bytes), (0, 0));
}

#[test]
fn a_cut_log_is_read_again_from_the_start() {
    let long = prompt("2026-11-02T10:00:00Z", "old prompt")
        + &reply("2026-11-02T10:00:01Z", "m1")
        + &reply("2026-11-02T10:00:02Z", "m2");
    let (_dir, h, file) = claude_home_with(&long);
    let mut index = SessionIndex::default();
    index.refresh(std::slice::from_ref(&h));
    assert_eq!(only(&index).messages, 3);

    let short = prompt("2026-11-02T11:00:00Z", "new");
    fs::write(&file, &short).unwrap();
    let stats = index.refresh(std::slice::from_ref(&h));
    assert_eq!(stats.bytes, short.len() as u64);
    let s = only(&index);
    assert_eq!(s.messages, 1);
    assert_eq!(s.title.as_deref(), Some("new"));
    assert_eq!(s.first, T_NOV2_10H + 3_600_000);
}

#[test]
fn bad_lines_are_skipped_and_counted() {
    let content = prompt("2026-11-02T10:00:00Z", "ok")
        + "not json\n\n"
        + &reply("2026-11-02T10:00:01Z", "m1");
    let (_dir, h, _file) = claude_home_with(&content);
    let mut index = SessionIndex::default();
    let stats = index.refresh(&[h]);
    assert_eq!(stats.bad_lines, 1);
    assert_eq!(only(&index).messages, 2);
}

#[test]
fn a_session_without_a_prompt_has_no_title() {
    let (_dir, h, _file) = claude_home_with(&reply("2026-11-02T10:00:01Z", "m1"));
    let mut index = SessionIndex::default();
    index.refresh(&[h]);
    let s = only(&index);
    assert_eq!(s.title, None);
    assert_eq!(s.messages, 1);
}

#[test]
fn the_list_skips_empty_sessions_and_puts_the_newest_first() {
    let (_dir, h, file) = claude_home_with(&prompt("2026-11-02T10:00:00Z", "older"));
    let proj = file.parent().unwrap();
    fs::write(
        proj.join("s-y.jsonl"),
        prompt("2026-11-03T09:00:00Z", "newer"),
    )
    .unwrap();
    fs::write(
        proj.join("s-z.jsonl"),
        r#"{"type":"user","isMeta":true,"timestamp":"2026-11-03T10:00:00Z","message":{"content":"<x>y</x>"}}"#
            .to_string()
            + "\n",
    )
    .unwrap();
    let mut index = SessionIndex::default();
    index.refresh(&[h]);
    assert_eq!(index.sessions.len(), 3);
    let titles: Vec<_> = index
        .list()
        .iter()
        .map(|s| s.title.clone().unwrap())
        .collect();
    assert_eq!(titles, ["newer", "older"]);
}

#[test]
fn a_deleted_log_drops_its_session() {
    let (_dir, h, file) = claude_home_with(&prompt("2026-11-02T10:00:00Z", "gone"));
    let mut index = SessionIndex::default();
    index.refresh(std::slice::from_ref(&h));
    assert_eq!(index.sessions.len(), 1);
    fs::remove_file(&file).unwrap();
    index.refresh(std::slice::from_ref(&h));
    assert!(index.sessions.is_empty());
    assert!(index.files.is_empty());
}

#[test]
fn a_long_prompt_is_cut_to_200_chars() {
    let long = "é".repeat(250);
    let (_dir, h, _file) = claude_home_with(&prompt("2026-11-02T10:00:00Z", &long));
    let mut index = SessionIndex::default();
    index.refresh(&[h]);
    assert_eq!(only(&index).title.as_ref().unwrap().chars().count(), 200);
}

/// A directory link like the private Codex home's `sessions` bridge.
fn link_dir(real: &Path, link: &Path) {
    #[cfg(windows)]
    {
        let ok = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(real)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok, "mklink /J");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(real, link).unwrap();
}

#[test]
fn a_log_seen_through_two_homes_is_one_session() {
    // A private Codex home links its `sessions` to the real one: the same
    // file is reached from both homes. The first home keeps it.
    let (_dir, own) = fixture_home(Agent::Codex);
    let private_dir = tempfile::tempdir().unwrap();
    link_dir(
        &own.path.join("sessions"),
        &private_dir.path().join("sessions"),
    );
    let private = home("acct-codex", Agent::Codex, private_dir.path());
    let mut index = SessionIndex::default();
    let homes = [own, private];
    index.refresh(&homes);
    assert_eq!(only(&index).key, format!("own-codex:{CODEX_ID}"));
    assert_eq!(index.files.len(), 1);
    // Stable on the next refresh.
    index.refresh(&homes);
    assert_eq!(only(&index).key, format!("own-codex:{CODEX_ID}"));
}

#[test]
fn save_then_load_is_equal() {
    let (_dir, h) = fixture_home(Agent::Claude);
    let mut index = SessionIndex::default();
    index.refresh(&[h]);
    let data = tempfile::tempdir().unwrap();
    index.save(data.path()).unwrap();
    assert!(data.path().join("kit").join("sessions.json").is_file());
    assert_eq!(SessionIndex::load(data.path()), index);
}

#[test]
fn a_missing_bad_or_other_version_file_loads_empty() {
    let data = tempfile::tempdir().unwrap();
    assert_eq!(SessionIndex::load(data.path()), SessionIndex::default());
    let kit = data.path().join("kit");
    fs::create_dir_all(&kit).unwrap();
    fs::write(kit.join("sessions.json"), "{not json").unwrap();
    assert_eq!(SessionIndex::load(data.path()), SessionIndex::default());

    let (_dir, h) = fixture_home(Agent::Claude);
    let mut index = SessionIndex::default();
    index.refresh(&[h]);
    index.version = 99;
    index.save(data.path()).unwrap();
    assert_eq!(SessionIndex::load(data.path()), SessionIndex::default());
}

#[test]
fn prune_drops_old_sessions_only() {
    let (_dir, h, file) = claude_home_with(&prompt("2026-11-02T10:00:00Z", "old"));
    let proj = file.parent().unwrap();
    fs::write(
        proj.join("s-y.jsonl"),
        prompt("2026-11-03T09:00:00Z", "new"),
    )
    .unwrap();
    let mut index = SessionIndex::default();
    index.refresh(std::slice::from_ref(&h));
    index.prune(T_NOV3_09H);
    let titles: Vec<_> = index
        .list()
        .iter()
        .map(|s| s.title.clone().unwrap())
        .collect();
    assert_eq!(titles, ["new"]);

    // The old log is not read again while it does not change.
    let stats = index.refresh(std::slice::from_ref(&h));
    assert_eq!((stats.files_read, stats.bytes), (0, 0));
    assert_eq!(index.list().len(), 1);

    // It comes back when it is written to again.
    append(&file, &prompt("2026-11-03T10:00:00Z", "again"));
    index.refresh(std::slice::from_ref(&h));
    index.prune(T_NOV3_09H);
    let titles: Vec<_> = index
        .list()
        .iter()
        .map(|s| s.title.clone().unwrap())
        .collect();
    assert_eq!(titles, ["old", "new"]);
}

fn set_mtime_ms(file: &Path, ms: i64) {
    let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64);
    fs::File::options()
        .write(true)
        .open(file)
        .unwrap()
        .set_modified(at)
        .unwrap();
}

#[test]
fn a_log_last_written_before_the_window_is_not_opened() {
    let (_dir, h, file) = claude_home_with(
        "{\"type\":\"user\",\"timestamp\":\"2026-11-02T10:00:00Z\",\"message\":{\"content\":\"old\"}}\n",
    );
    set_mtime_ms(&file, T_NOV2_10H);
    let mut index = SessionIndex::default();
    let stats = index.refresh_since(std::slice::from_ref(&h), Some(T_NOV3_09H), &mut |_| {});
    assert_eq!(stats.files_read, 0);
    assert!(index.files.is_empty(), "an old log gets no mark");
    assert!(index.sessions.is_empty());
    // A wider window reads it.
    let stats = index.refresh_since(&[h], Some(T_NOV2_10H), &mut |_| {});
    assert_eq!(stats.files_read, 1);
    assert_eq!(index.list().len(), 1);
}

#[test]
fn a_line_of_many_mb_is_read_for_its_fields_only() {
    let blob = "A".repeat(3 << 20);
    let log = [
        format!(
            "{{\"type\":\"user\",\"timestamp\":\"2026-11-02T10:00:00Z\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"Look at this\"}},{{\"type\":\"image\",\"source\":{{\"data\":\"{blob}\"}}}}]}}}}"
        ),
        format!(
            "{{\"type\":\"user\",\"toolUseResult\":{{\"stdout\":\"{blob}\"}},\"message\":{{\"content\":[{{\"type\":\"tool_result\",\"content\":\"{blob}\"}}]}}}}"
        ),
        format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"2026-11-03T09:00:00Z\",\"message\":{{\"id\":\"m1\",\"model\":\"claude-x\",\"content\":[{{\"type\":\"tool_use\",\"input\":{{\"content\":\"{blob}\"}}}}]}}}}"
        ),
    ]
    .join("\n")
        + "\n";
    let (_dir, h, _) = claude_home_with(&log);
    let mut index = SessionIndex::default();
    let stats = index.refresh(&[h]);
    assert_eq!(stats.bad_lines, 0);
    let list = index.list();
    assert_eq!(list.len(), 1);
    let s = list[0];
    assert_eq!(s.title.as_deref(), Some("Look at this"));
    assert_eq!(s.messages, 2);
    assert_eq!(s.model.as_deref(), Some("claude-x"));
    assert_eq!((s.first, s.last), (T_NOV2_10H, T_NOV3_09H));
}

#[test]
fn a_log_over_the_size_limit_is_skipped_and_listed() {
    let line = "{\"type\":\"user\",\"timestamp\":\"2026-11-02T10:00:00Z\",\"message\":{\"content\":\"hi\"}}\n";
    let (_dir, h, file) = claude_home_with(line);
    let key = fs::canonicalize(&file)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let mut index = SessionIndex::default();
    index.refresh_limited(std::slice::from_ref(&h), None, 10, &mut |_| {});
    assert_eq!(index.skipped, std::slice::from_ref(&key));
    assert!(index.sessions.is_empty());
    // With room for it the log is read and nothing is skipped.
    index.refresh_limited(&[h], None, 1 << 20, &mut |_| {});
    assert!(index.skipped.is_empty());
    assert_eq!(index.file_of("own-claude:s-x"), Some(key.as_str()));
    assert_eq!(index.file_of("own-claude:none"), None);
}

#[test]
fn skipped_logs_are_not_saved_with_the_index() {
    let mut index = SessionIndex::default();
    index.skipped.push("/a/b.jsonl".into());
    let dir = tempfile::tempdir().unwrap();
    index.save(dir.path()).unwrap();
    assert!(SessionIndex::load(dir.path()).skipped.is_empty());
}
