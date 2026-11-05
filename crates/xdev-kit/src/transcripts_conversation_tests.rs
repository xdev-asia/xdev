use std::fs;

use super::*;
use crate::HomeSource;

fn lines(items: &[&str]) -> String {
    let mut out = items.join("\n");
    out.push('\n');
    out
}

fn claude_log() -> String {
    lines(&[
        r#"{"type":"user","sessionId":"s1","timestamp":"2026-11-04T10:00:00Z","message":{"role":"user","content":"Fix the parser in src/lib.rs"}}"#,
        r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-11-04T10:00:05Z","message":{"id":"m1","model":"claude-opus-5-5","role":"assistant","content":[{"type":"thinking","thinking":"SECRET-THOUGHT","signature":"SIG"},{"type":"text","text":"Looking at it now"}]}}"#,
        r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-11-04T10:00:06Z","message":{"id":"m1","model":"claude-opus-5-5","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/w/src/lib.rs"}}]}}"#,
        r#"{"type":"user","sessionId":"s1","timestamp":"2026-11-04T10:00:07Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"fn main() {}"}]}}"#,
        r#"{"type":"assistant","sessionId":"s1","message":{"id":"m2","model":"claude-opus-5-5","role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"cargo   test\n --all","description":"Run tests"}}]}}"#,
        r#"{"type":"user","sessionId":"s1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":[{"type":"text","text":"error: 2 tests failed"}]}]}}"#,
        r#"{"type":"user","isSidechain":true,"sessionId":"s1","message":{"role":"user","content":"SECRET-SIDE"}}"#,
        r#"{"type":"user","isMeta":true,"sessionId":"s1","message":{"role":"user","content":"SECRET-META"}}"#,
        r#"{"type":"user","sessionId":"s1","message":{"role":"user","content":"<system-reminder>SECRET-WRAP</system-reminder>"}}"#,
        r#"{"type":"user","sessionId":"s1","message":{"role":"user","content":[{"type":"image","source":{"data":"SECRET-IMAGE"}},{"type":"text","text":"What about this?"}]}}"#,
        r#"{"type":"system","subtype":"compact_boundary","sessionId":"s1","timestamp":"2026-11-04T11:00:00Z","content":"Conversation compacted"}"#,
        r#"{"type":"user","isCompactSummary":true,"sessionId":"s1","message":{"role":"user","content":"Summary of the earlier talk"}}"#,
        r#"{"type":"assistant","sessionId":"s1","message":{"id":"m3","model":"claude-sonnet-5-5","role":"assistant","content":[{"type":"text","text":"Switched"}]}}"#,
        r#"{"type":"assistant","sessionId":"s2","message":{"id":"m4","model":"claude-sonnet-5-5","role":"assistant","content":[{"type":"text","text":"Back again"}]}}"#,
    ])
}

fn kinds(page: &ConversationPage) -> Vec<&'static str> {
    page.items.iter().map(|i| i.kind.as_str()).collect()
}

#[test]
fn claude_items_in_order_with_tools_and_markers() {
    let page = conversation_of_text(Agent::Claude, &claude_log(), None, None);
    assert_eq!(
        kinds(&page),
        vec![
            "user",
            "assistant",
            "tool",
            "tool",
            "user",
            "marker",
            "marker",
            "assistant",
            "marker",
            "assistant"
        ]
    );
    assert_eq!(page.items[0].text, "Fix the parser in src/lib.rs");
    assert_eq!(page.items[0].at, 1_793_786_400_000);
    let read = page.items[2].tool.as_ref().unwrap();
    assert_eq!(read.name, "Read");
    assert_eq!(read.summary, "/w/src/lib.rs");
    assert_eq!(read.status, ToolStatus::Ok);
    assert_eq!(read.output, "fn main() {}");
    let bash = page.items[3].tool.as_ref().unwrap();
    assert_eq!(bash.summary, "cargo test --all");
    assert_eq!(bash.status, ToolStatus::Error);
    assert_eq!(bash.output, "error: 2 tests failed");
    assert_eq!(page.items[4].text, "What about this?");
    assert_eq!(page.items[5].marker, Some(MarkerKind::Compact));
    assert_eq!(page.items[6].marker, Some(MarkerKind::Model));
    assert_eq!(page.items[6].text, "claude-sonnet-5-5");
    assert_eq!(page.items[8].marker, Some(MarkerKind::Resume));
    assert_eq!(page.model.as_deref(), Some("claude-sonnet-5-5"));
    assert_eq!(page.turns, 2);
    assert_eq!(page.total, 10);
    assert_eq!(page.markers.len(), 3);
    for (i, item) in page.items.iter().enumerate() {
        assert_eq!(item.index, i);
    }
}

#[test]
fn dropped_lines_stay_dropped() {
    let page = conversation_of_text(Agent::Claude, &claude_log(), None, None);
    let all = format!("{page:?}");
    for secret in [
        "SECRET-THOUGHT",
        "SIG",
        "SECRET-SIDE",
        "SECRET-META",
        "SECRET-WRAP",
        "SECRET-IMAGE",
        "Summary of the earlier talk",
    ] {
        assert!(!all.contains(secret), "leaks {secret}");
    }
}

fn codex_log() -> String {
    lines(&[
        r#"{"type":"session_meta","timestamp":"2026-11-04T10:00:00Z","payload":{"id":"cafe0000-0000-4000-8000-00000000beef","cwd":"/w","instructions":"SECRET-INSTRUCTIONS"}}"#,
        r#"{"type":"turn_context","payload":{"model":"gpt-6"}}"#,
        r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"SECRET-DEV"}]}}"#,
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>SECRET-ENV</environment_context>"}]}}"#,
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Add a panel"}]}}"#,
        r#"{"type":"response_item","payload":{"type":"reasoning","encrypted_content":"SECRET-REASON","summary":[]}}"#,
        r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"bash\",\"-lc\",\"ls src\"]}","call_id":"c1"}}"#,
        r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"{\"output\":\"main.rs\\n\",\"metadata\":{\"exit_code\":0}}"}}"#,
        r#"{"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch","call_id":"c2","status":"completed"}}"#,
        r#"{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c2","output":"Exit code: 1\nWall time: 0.1 seconds\nOutput:\npatch failed"}}"#,
        r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"rg\",\"x\"]}","call_id":"c3"}}"#,
        r#"{"type":"compacted","payload":{"message":"SECRET-COMPACT"}}"#,
        r#"{"type":"turn_context","payload":{"model":"gpt-6-mini"}}"#,
        r#"{"type":"session_meta","payload":{"id":"cafe0000-0000-4000-8000-00000000beef"}}"#,
        r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done, see the diff"}]}}"#,
        r#"{"type":"event_msg","payload":{"type":"agent_message","message":"Done, see the diff"}}"#,
    ])
}

#[test]
fn codex_items_tools_and_markers() {
    let page = conversation_of_text(Agent::Codex, &codex_log(), None, None);
    assert_eq!(
        kinds(&page),
        vec![
            "user",
            "tool",
            "tool",
            "tool",
            "marker",
            "marker",
            "marker",
            "assistant"
        ]
    );
    let ls = page.items[1].tool.as_ref().unwrap();
    assert_eq!(
        (ls.name.as_str(), ls.summary.as_str()),
        ("shell", "bash -lc ls src")
    );
    assert_eq!(ls.status, ToolStatus::Ok);
    assert_eq!(ls.output, "main.rs");
    let patch = page.items[2].tool.as_ref().unwrap();
    assert_eq!(patch.status, ToolStatus::Error);
    assert_eq!(patch.summary, "*** Begin Patch");
    assert_eq!(
        page.items[3].tool.as_ref().unwrap().status,
        ToolStatus::Pending
    );
    assert_eq!(page.items[4].marker, Some(MarkerKind::Compact));
    assert_eq!(page.items[5].marker, Some(MarkerKind::Model));
    assert_eq!(page.items[6].marker, Some(MarkerKind::Resume));
    assert_eq!(page.model.as_deref(), Some("gpt-6-mini"));
    assert_eq!(page.turns, 1);
    let all = format!("{page:?}");
    for secret in [
        "SECRET-INSTRUCTIONS",
        "SECRET-DEV",
        "SECRET-ENV",
        "SECRET-REASON",
        "SECRET-COMPACT",
    ] {
        assert!(!all.contains(secret), "leaks {secret}");
    }
}

#[test]
fn codex_output_object_with_success_false_is_an_error() {
    let log = lines(&[
        r#"{"type":"response_item","payload":{"type":"function_call","name":"read","arguments":"{\"path\":\"a.md\"}","call_id":"c1"}}"#,
        r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":{"content":"no such file","success":false}}}"#,
    ]);
    let page = conversation_of_text(Agent::Codex, &log, None, None);
    let step = page.items[0].tool.as_ref().unwrap();
    assert_eq!(step.summary, "a.md");
    assert_eq!(step.status, ToolStatus::Error);
    assert_eq!(step.output, "no such file");
}

#[test]
fn tool_output_is_bounded_on_a_char_boundary() {
    let big = "é".repeat(TOOL_OUTPUT_MAX);
    let log = lines(&[
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a"}}]}}"#,
        &format!(
            r#"{{"type":"user","message":{{"content":[{{"type":"tool_result","tool_use_id":"t1","content":"{big}"}}]}}}}"#
        ),
    ]);
    let page = conversation_of_text(Agent::Claude, &log, None, None);
    let step = page.items[0].tool.as_ref().unwrap();
    assert!(step.cut);
    assert!(step.output.len() <= TOOL_OUTPUT_MAX);
    assert!(step.output.len() > TOOL_OUTPUT_MAX - 4);
}

#[test]
fn a_result_without_its_call_is_ignored() {
    let log = lines(&[
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"nope","content":"x"}]}}"#,
    ]);
    let page = conversation_of_text(Agent::Claude, &log, None, None);
    assert_eq!(page.total, 0);
    assert!(page.items.is_empty());
}

#[test]
fn paging_edges() {
    assert_eq!(page_bounds(0, None, None), (0, 0));
    assert_eq!(page_bounds(10, None, Some(3)), (7, 10));
    assert_eq!(page_bounds(10, Some(0), Some(3)), (0, 3));
    assert_eq!(page_bounds(10, Some(8), Some(3)), (8, 10));
    assert_eq!(page_bounds(10, Some(10), Some(3)), (10, 10));
    assert_eq!(page_bounds(10, Some(99), None), (10, 10));
    // A limit of 0 is held to 1, a huge one to the max.
    assert_eq!(page_bounds(10, Some(0), Some(0)), (0, 1));
    assert_eq!(
        page_bounds(5_000, Some(0), Some(usize::MAX)),
        (0, CONVERSATION_PAGE_MAX)
    );
    assert_eq!(page_bounds(500, None, None), (500 - CONVERSATION_PAGE, 500));

    let page = conversation_of_text(Agent::Claude, &claude_log(), Some(2), Some(3));
    assert_eq!(page.from, 2);
    assert_eq!(page.total, 10);
    assert_eq!(
        page.items.iter().map(|i| i.index).collect::<Vec<_>>(),
        vec![2, 3, 4]
    );
    // Whole-session facts do not depend on the page.
    assert_eq!(page.turns, 2);
    assert_eq!(page.markers.len(), 3);
    let tail = conversation_of_text(Agent::Claude, &claude_log(), None, Some(4));
    assert_eq!(tail.from, 6);
    assert_eq!(tail.items.len(), 4);
}

#[test]
fn summaries_and_outputs_hide_secret_values() {
    assert_eq!(
        mask_secrets("API_TOKEN=abc123 make deploy"),
        "API_TOKEN=••• make deploy"
    );
    assert_eq!(
        mask_secrets(r#"{"api_key": "sk-1", "name": "x"}"#),
        r#"{"api_key": "•••", "name": "x"}"#
    );
    assert_eq!(
        mask_secrets("curl -H 'Authorization: Bearer abc.def' https://x.dev"),
        "curl -H 'Authorization: ••• https://x.dev"
    );
    assert_eq!(
        mask_secrets("time 10:00 url https://a.b"),
        "time 10:00 url https://a.b"
    );
    let summary = summarize_input(Some(&serde_json::json!({
        "command": "GITHUB_TOKEN=ghp_x gh pr list"
    })));
    assert_eq!(summary, "GITHUB_TOKEN=••• gh pr list");
}

#[test]
fn summary_is_one_line_and_cut() {
    let long = "a ".repeat(400);
    let s = summarize_input(Some(&serde_json::json!({ "command": long })));
    assert!(s.chars().count() <= 160);
    assert!(s.ends_with('…'));
    assert!(!s.contains('\n'));
    assert_eq!(summarize_input(None), "");
    assert_eq!(
        summarize_input(Some(&serde_json::json!({ "other": "x y" }))),
        "x y"
    );
}

#[test]
fn reads_a_log_file_and_a_missing_one_errors() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("s.jsonl");
    fs::write(&file, claude_log()).unwrap();
    let home = Home {
        id: "own-claude".into(),
        agent: Agent::Claude,
        path: dir.path().to_path_buf(),
        source: HomeSource::Own,
    };
    let page = conversation(&home, &file, None, None).unwrap();
    assert_eq!(page.total, 10);
    assert!(conversation(&home, &dir.path().join("gone.jsonl"), None, None).is_err());
}

#[test]
fn tail_turns_is_unchanged_by_tool_steps() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("s.jsonl");
    fs::write(&file, claude_log()).unwrap();
    let home = Home {
        id: "own-claude".into(),
        agent: Agent::Claude,
        path: dir.path().to_path_buf(),
        source: HomeSource::Own,
    };
    let turns = crate::transcripts::tail_turns(&home, &file, 10, 100);
    assert_eq!(
        turns.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
        vec![
            "Fix the parser in src/lib.rs",
            "Looking at it now",
            "What about this?",
            "Summary of the earlier talk",
            "Switched",
            "Back again"
        ]
    );
}
