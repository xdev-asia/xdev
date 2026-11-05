use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::HomeSource;

fn home(id: &str, agent: Agent, path: &Path) -> Home {
    Home {
        id: id.to_string(),
        agent,
        path: path.to_path_buf(),
        source: HomeSource::Own,
    }
}

fn claude_home(content: &str) -> (tempfile::TempDir, Home, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let proj = dir.path().join("projects").join("-work-demo");
    fs::create_dir_all(&proj).unwrap();
    let file = proj.join("sess-1.jsonl");
    fs::write(&file, content).unwrap();
    let h = home("own-claude", Agent::Claude, dir.path());
    (dir, h, file)
}

fn codex_home(content: &str) -> (tempfile::TempDir, Home, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let day = dir
        .path()
        .join("sessions")
        .join("2026")
        .join("11")
        .join("04");
    fs::create_dir_all(&day).unwrap();
    let file = day.join("rollout-2026-11-04T10-00-00-01a1a18f-2257-7d10-81b3-4888e4b169ff.jsonl");
    fs::write(&file, content).unwrap();
    let h = home("own-codex", Agent::Codex, dir.path());
    (dir, h, file)
}

fn scan(homes: &[Home], marks: &mut BTreeMap<String, FileMark>) -> Vec<TranscriptEvent> {
    let mut out = Vec::new();
    scan_transcripts(homes, marks, None, &mut |e| out.push(e));
    out
}

fn texts(events: &[TranscriptEvent]) -> Vec<(TextRole, String)> {
    events
        .iter()
        .filter_map(|e| match e {
            TranscriptEvent::Text(t) => Some((t.role, t.text.clone())),
            _ => None,
        })
        .collect()
}

fn lines(items: &[&str]) -> String {
    let mut out = items.join("\n");
    out.push('\n');
    out
}

fn claude_log() -> String {
    lines(&[
        r#"{"type":"user","timestamp":"2026-11-04T10:00:00Z","message":{"role":"user","content":"Fix the parser"}}"#,
        r#"{"type":"assistant","timestamp":"2026-11-04T10:00:05Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Looking at it now"},{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}"#,
        r#"{"type":"user","timestamp":"2026-11-04T10:00:06Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"secret file text"}]}}"#,
        r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"side prompt"}}"#,
        r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"meta prompt"}}"#,
        r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#,
        r#"{"type":"assistant","message":{"id":"m2","role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{}}]}}"#,
    ])
}

#[test]
fn claude_user_and_assistant_text_only() {
    let (_dir, h, _) = claude_home(&claude_log());
    let mut marks = BTreeMap::new();
    let events = scan(&[h], &mut marks);
    assert_eq!(
        texts(&events),
        vec![
            (TextRole::User, "Fix the parser".to_string()),
            (TextRole::Assistant, "Looking at it now".to_string()),
        ]
    );
    assert!(matches!(events[0], TranscriptEvent::Reset { .. }));
    let TranscriptEvent::Text(first) = &events[1] else {
        panic!("text first: {events:?}");
    };
    assert_eq!(first.session_key, "own-claude:sess-1");
    assert_eq!(first.at, 1_793_786_400_000);
    assert_eq!(marks.len(), 1);
}

#[test]
fn codex_texts_are_keyed_by_the_session_meta_id() {
    let log = lines(&[
        r#"{"type":"response_item","timestamp":"2026-11-04T10:00:01Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Add a panel"}]}}"#,
        r#"{"type":"session_meta","payload":{"id":"cafe0000-0000-4000-8000-00000000beef","cwd":"/w"}}"#,
        r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done, see the diff"}]}}"#,
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}"#,
        r#"{"type":"response_item","payload":{"type":"function_call","name":"shell"}}"#,
    ]);
    let (_dir, h, _) = codex_home(&log);
    let mut marks = BTreeMap::new();
    let events = scan(&[h], &mut marks);
    assert_eq!(
        texts(&events),
        vec![
            (TextRole::User, "Add a panel".to_string()),
            (TextRole::Assistant, "Done, see the diff".to_string()),
        ]
    );
    for e in &events {
        if let TranscriptEvent::Text(t) = e {
            assert_eq!(
                t.session_key,
                "own-codex:cafe0000-0000-4000-8000-00000000beef"
            );
        }
    }
}

#[test]
fn a_second_scan_reads_only_what_was_appended() {
    let (_dir, h, file) = claude_home(&claude_log());
    let mut marks = BTreeMap::new();
    scan(std::slice::from_ref(&h), &mut marks);
    assert!(scan(std::slice::from_ref(&h), &mut marks).is_empty());
    let mut more = fs::read_to_string(&file).unwrap();
    more.push_str(r#"{"type":"user","message":{"role":"user","content":"And the docs?"}}"#);
    more.push('\n');
    fs::write(&file, more).unwrap();
    let events = scan(&[h], &mut marks);
    assert_eq!(
        texts(&events),
        vec![(TextRole::User, "And the docs?".to_string())]
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, TranscriptEvent::Reset { .. }))
    );
}

#[test]
fn a_cut_file_resets_then_reads_again() {
    let (_dir, h, file) = claude_home(&claude_log());
    let mut marks = BTreeMap::new();
    scan(std::slice::from_ref(&h), &mut marks);
    fs::write(
        &file,
        lines(&[r#"{"type":"user","message":{"role":"user","content":"Fresh"}}"#]),
    )
    .unwrap();
    let events = scan(&[h], &mut marks);
    assert!(matches!(events[0], TranscriptEvent::Reset { .. }));
    assert_eq!(texts(&events), vec![(TextRole::User, "Fresh".to_string())]);
}

#[test]
fn a_deleted_file_is_gone() {
    let (_dir, h, file) = claude_home(&claude_log());
    let mut marks = BTreeMap::new();
    scan(std::slice::from_ref(&h), &mut marks);
    fs::remove_file(&file).unwrap();
    let events = scan(&[h], &mut marks);
    assert!(matches!(events.as_slice(), [TranscriptEvent::Gone { .. }]));
    assert!(marks.is_empty());
}

#[test]
fn a_long_message_is_cut_at_the_cap() {
    let long = "a".repeat(TEXT_CHARS_MAX + 500);
    let log = lines(&[&format!(
        r#"{{"type":"user","message":{{"role":"user","content":"{long}"}}}}"#
    )]);
    let (_dir, h, _) = claude_home(&log);
    let mut marks = BTreeMap::new();
    let got = texts(&scan(&[h], &mut marks));
    assert_eq!(got[0].1.chars().count(), TEXT_CHARS_MAX);
}

#[test]
fn each_file_ends_with_a_done_event_carrying_its_mark() {
    let log = lines(&[
        r#"{"type":"user","timestamp":"2026-11-04T10:00:00Z","message":{"content":"first"}}"#,
    ]);
    let (_dir, h, file) = claude_home(&log);
    let mut marks = BTreeMap::new();
    let events = scan(&[h], &mut marks);
    let key = fs::canonicalize(&file)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(matches!(events[0], TranscriptEvent::Reset { .. }));
    assert!(matches!(events[1], TranscriptEvent::Text(_)));
    let Some(TranscriptEvent::Done { file, mark }) = events.last() else {
        panic!("no done event: {events:?}");
    };
    assert_eq!(file, &key);
    assert_eq!(Some(mark), marks.get(&key));
}

#[test]
fn an_unmarked_log_older_than_the_window_is_not_opened() {
    let (_dir, h, file) = claude_home(&claude_log());
    let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
    fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let mut marks = BTreeMap::new();
    let mut events = Vec::new();
    let stats = scan_transcripts(
        std::slice::from_ref(&h),
        &mut marks,
        Some(1_700_000_001_000),
        &mut |e| events.push(e),
    );
    assert_eq!(stats.files_read, 0);
    assert!(events.is_empty());
    assert!(marks.is_empty());
}

#[test]
fn a_codex_log_without_session_meta_still_sends_its_texts() {
    let mut items = Vec::new();
    for i in 0..(HOLD_MAX + 3) {
        items.push(format!(
            r#"{{"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"p{i}"}}]}}}}"#
        ));
    }
    let refs: Vec<&str> = items.iter().map(String::as_str).collect();
    let (_dir, h, _) = codex_home(&lines(&refs));
    let mut marks = BTreeMap::new();
    let events = scan(&[h], &mut marks);
    let got = texts(&events);
    assert_eq!(got.len(), HOLD_MAX + 3);
    assert_eq!(got[0].1, "p0");
    assert!(matches!(events[0], TranscriptEvent::Reset { .. }));
}

fn claude_turn(role: &str, text: &str) -> String {
    format!(
        "{{\"type\":\"{role}\",\"timestamp\":\"2026-11-02T10:00:00Z\",\"message\":{{\"content\":\"{text}\"}}}}"
    )
}

#[test]
fn tail_keeps_the_last_turns_in_order() {
    let items: Vec<String> = (0..10)
        .map(|i| {
            claude_turn(
                if i % 2 == 0 { "user" } else { "assistant" },
                &format!("t{i}"),
            )
        })
        .collect();
    let refs: Vec<&str> = items.iter().map(String::as_str).collect();
    let (_d, h, file) = claude_home(&lines(&refs));
    let tail = tail_turns(&h, &file, 6, 100);
    let got: Vec<&str> = tail.iter().map(|t| t.text.as_str()).collect();
    assert_eq!(got, ["t4", "t5", "t6", "t7", "t8", "t9"]);
    assert_eq!(tail[0].role, TextRole::User);
    assert_eq!(tail[1].role, TextRole::Assistant);
    assert!(tail[0].at > 0);
}

#[test]
fn tail_cuts_each_turn_and_skips_tool_lines() {
    let log = lines(&[
        &claude_turn("user", "abcdefghij"),
        "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"input\":{}}]}}",
        "not json",
    ]);
    let (_d, h, file) = claude_home(&log);
    let tail = tail_turns(&h, &file, 6, 4);
    assert_eq!(tail.len(), 1);
    assert_eq!(tail[0].text, "abcd");
}

#[test]
fn tail_of_an_empty_or_missing_log_is_empty() {
    let (_d, h, file) = claude_home("");
    assert!(tail_turns(&h, &file, 6, 10).is_empty());
    assert!(tail_turns(&h, &file.with_extension("gone"), 6, 10).is_empty());
    assert!(tail_turns(&h, &file, 0, 10).is_empty());
}

#[test]
fn tail_of_a_long_log_starts_on_a_line_and_keeps_the_end() {
    let filler = "x".repeat(1000);
    let mut items: Vec<String> = (0..5000)
        .map(|i| claude_turn("user", &format!("{i}{filler}")))
        .collect();
    items.push(claude_turn("assistant", "last"));
    let refs: Vec<&str> = items.iter().map(String::as_str).collect();
    let (_d, h, file) = claude_home(&lines(&refs));
    assert!(fs::metadata(&file).unwrap().len() > TAIL_BYTES);
    let tail = tail_turns(&h, &file, 3, 20);
    assert_eq!(tail.len(), 3);
    assert_eq!(tail[2].text, "last");
    assert!(tail[0].text.starts_with("49"), "{}", tail[0].text);
}

#[test]
fn tail_reads_a_codex_log() {
    let log = lines(&[
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"s1\"}}",
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hello\"}]}}",
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hi there\"}]}}",
    ]);
    let (_d, h, file) = codex_home(&log);
    let tail = tail_turns(&h, &file, 6, 100);
    let got: Vec<(TextRole, &str)> = tail.iter().map(|t| (t.role, t.text.as_str())).collect();
    assert_eq!(
        got,
        [(TextRole::User, "hello"), (TextRole::Assistant, "hi there")]
    );
}
