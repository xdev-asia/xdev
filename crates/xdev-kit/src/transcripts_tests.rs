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
    scan_transcripts(homes, marks, &mut |e| out.push(e));
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
    let TranscriptEvent::Text(first) = &events[0] else {
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
    assert!(matches!(events[0], TranscriptEvent::Text(_)));
    let Some(TranscriptEvent::Done { file, mark }) = events.last() else {
        panic!("no done event: {events:?}");
    };
    assert_eq!(file, &key);
    assert_eq!(Some(mark), marks.get(&key));
}
