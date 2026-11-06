//! The readable conversation of one agent session: messages, tool steps and
//! session markers, a page at a time. The log is only read after the same
//! store check as every other session log command.

use serde::Serialize;
use tauri::State;
use xdev_kit::{
    Agent, ConversationItem, ConversationPage, Home, SessionIndex, SubagentRun, conversation,
};

use crate::agent_session_log::session_log;
use crate::agent_sessions::index_copy;
use crate::commands::{AppState, CmdError};
use crate::kit::Ctx;

/// One tool step: its name, a line about its input, how it ended and up to
/// 2 KB of what it printed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationTool {
    pub name: String,
    pub summary: String,
    /// `ok`, `error` or `pending` (no result logged yet).
    pub status: String,
    pub output: String,
    /// The output was cut to 2 KB.
    pub cut: bool,
}

/// One item of a conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationEntry {
    /// Place in the whole conversation, from 0.
    pub index: u32,
    /// `user`, `assistant`, `tool` or `marker`; more kinds may come, and a
    /// reader skips one it does not know.
    pub kind: String,
    /// The message; for a model marker, the new model.
    pub text: String,
    /// Unix ms; 0 when the line has no time.
    pub at: i64,
    pub tool: Option<ConversationTool>,
    /// `compact`, `resume` or `model` for a marker.
    pub marker: Option<String>,
    /// For the tool step that started a sub-agent: the run's id in
    /// `Conversation::subagents`. Left out otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub subagent: Option<String>,
}

/// One sub-agent run of the session: the call that started it, its own steps
/// and its result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConversationSubagent {
    /// The call id of the tool step that started it.
    pub id: String,
    /// Index of that tool step in the whole conversation.
    pub index: u32,
    pub description: String,
    /// The kind of sub-agent the call asked for, when it names one.
    pub agent_type: Option<String>,
    /// The prompt on one line, at most 300 chars.
    pub prompt: String,
    /// `ok`, `error` or `pending` (no result logged yet).
    pub status: String,
    /// What it gave back, at most 4000 chars.
    pub result: String,
    /// The result was cut.
    pub cut: bool,
    /// Its texts (`assistant`) and tool steps (`tool`), the first 200;
    /// `index` counts within the run.
    pub steps: Vec<ConversationEntry>,
    /// Steps it took in all.
    pub steps_total: u32,
    /// Unix ms of the call; 0 when it has no time.
    pub at: i64,
}

/// One page of a conversation and what holds for the whole session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    /// The session key, `<home id>:<session id>`.
    pub key: String,
    /// `claude` or `codex`.
    pub agent: String,
    pub model: Option<String>,
    /// Index of the first item of `items`.
    pub from: u32,
    /// Items in the whole conversation.
    pub total: u32,
    /// Messages the person typed.
    pub turns: u32,
    pub items: Vec<ConversationEntry>,
    /// The session's markers (the last 50), whatever the page.
    pub markers: Vec<ConversationEntry>,
    /// The session's sub-agent runs (the last 100), whatever the page.
    pub subagents: Vec<ConversationSubagent>,
}

fn n(v: usize) -> u32 {
    u32::try_from(v).unwrap_or(u32::MAX)
}

fn entry(item: ConversationItem) -> ConversationEntry {
    ConversationEntry {
        index: n(item.index),
        kind: item.kind.as_str().to_owned(),
        text: item.text,
        at: item.at,
        tool: item.tool.map(|t| ConversationTool {
            name: t.name,
            summary: t.summary,
            status: t.status.as_str().to_owned(),
            output: t.output,
            cut: t.cut,
        }),
        marker: item.marker.map(|m| m.as_str().to_owned()),
        subagent: item.subagent,
    }
}

fn subagent(run: SubagentRun) -> ConversationSubagent {
    ConversationSubagent {
        id: run.id,
        index: n(run.index),
        description: run.description,
        agent_type: run.agent_type,
        prompt: run.prompt,
        status: run.status.as_str().to_owned(),
        result: run.result,
        cut: run.cut,
        steps: run.steps.into_iter().map(entry).collect(),
        steps_total: n(run.steps_total),
        at: run.at,
    }
}

fn view(key: String, home: &Home, page: ConversationPage) -> Conversation {
    Conversation {
        key,
        agent: match home.agent {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
        }
        .to_owned(),
        model: page.model,
        from: n(page.from),
        total: n(page.total),
        turns: n(page.turns),
        items: page.items.into_iter().map(entry).collect(),
        markers: page.markers.into_iter().map(entry).collect(),
        subagents: page.subagents.into_iter().map(subagent).collect(),
    }
}

/// The full key of `session`: a key itself, or a CLI session id.
fn key_of(index: &SessionIndex, session: &str) -> Result<String, CmdError> {
    index
        .sessions
        .values()
        .find(|s| s.key == session || s.id == session)
        .map(|s| s.key.clone())
        .ok_or_else(|| CmdError {
            code: "not_found",
            detail: Some("session".to_owned()),
        })
}

/// One page of the conversation of `session` (a key or a CLI session id).
pub(crate) fn read_conversation(
    index: &SessionIndex,
    homes: &[Home],
    session: &str,
    from: Option<u32>,
    limit: Option<u32>,
) -> Result<Conversation, CmdError> {
    let key = key_of(index, session)?;
    let (home, file) = session_log(index, homes, &key)?;
    let page = conversation(
        &home,
        &file,
        from.map(|f| f as usize),
        limit.map(|l| l as usize),
    )
    .map_err(|e| CmdError {
        code: "io",
        detail: Some(e.to_string()),
    })?;
    Ok(view(key, &home, page))
}

/// The conversation of an agent session, a page at a time. `from` absent gives
/// the last page; `limit` is 200 when absent and at most 1000.
#[tauri::command(async)]
pub fn agent_conversation(
    state: State<'_, AppState>,
    key: String,
    from: Option<u32>,
    limit: Option<u32>,
) -> Result<Conversation, CmdError> {
    let ctx = Ctx::of(&state)?;
    read_conversation(&index_copy(&ctx.data), &ctx.homes(), &key, from, limit)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use xdev_kit::HomeSource;

    use super::*;

    const LOG: &str = concat!(
        r#"{"type":"user","timestamp":"2026-11-02T10:00:00Z","message":{"content":"hello"}}"#,
        "\n",
        r#"{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"Hi"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#,
        "\n",
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"nope"}]}}"#,
        "\n",
        r#"{"type":"system","subtype":"compact_boundary"}"#,
        "\n",
    );

    fn fixture() -> (tempfile::TempDir, Home, SessionIndex, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("projects").join("-work-demo");
        fs::create_dir_all(&proj).unwrap();
        let file = proj.join("s-1.jsonl");
        fs::write(&file, LOG).unwrap();
        let home = Home {
            id: "own-claude".into(),
            agent: Agent::Claude,
            path: fs::canonicalize(dir.path()).unwrap(),
            source: HomeSource::Own,
        };
        let mut index = SessionIndex::default();
        index.refresh(std::slice::from_ref(&home));
        (dir, home, index, file)
    }

    #[test]
    fn reads_by_key_or_session_id() {
        let (_d, home, index, _f) = fixture();
        let homes = std::slice::from_ref(&home);
        let c = read_conversation(&index, homes, "own-claude:s-1", None, None).unwrap();
        assert_eq!(c.key, "own-claude:s-1");
        assert_eq!(c.agent, "claude");
        assert_eq!(c.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!((c.from, c.total, c.turns), (0, 4, 1));
        let kinds: Vec<&str> = c.items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, vec!["user", "assistant", "tool", "marker"]);
        let tool = c.items[2].tool.as_ref().unwrap();
        assert_eq!(
            (tool.name.as_str(), tool.status.as_str()),
            ("Bash", "error")
        );
        assert_eq!(c.items[3].marker.as_deref(), Some("compact"));
        assert_eq!(c.markers.len(), 1);
        let by_id = read_conversation(&index, homes, "s-1", Some(1), Some(2)).unwrap();
        assert_eq!(by_id.from, 1);
        assert_eq!(by_id.items.len(), 2);
        assert_eq!(by_id.items[0].index, 1);
        let past = read_conversation(&index, homes, "s-1", Some(9), None).unwrap();
        assert!(past.items.is_empty());
        assert_eq!(past.total, 4);
    }

    #[test]
    fn sub_agent_runs_come_with_every_page() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("projects").join("-work-demo");
        fs::create_dir_all(&proj).unwrap();
        let log =
            include_str!("../../../../crates/xdev-kit/tests/fixtures/subagents/claude-task.jsonl");
        fs::write(proj.join("s9.jsonl"), log).unwrap();
        let home = Home {
            id: "own-claude".into(),
            agent: Agent::Claude,
            path: fs::canonicalize(dir.path()).unwrap(),
            source: HomeSource::Own,
        };
        let mut index = SessionIndex::default();
        index.refresh(std::slice::from_ref(&home));
        let c = read_conversation(&index, &[home], "s9", Some(4), Some(1)).unwrap();
        assert_eq!(c.items.len(), 1);
        assert_eq!(c.subagents.len(), 2);
        let a = &c.subagents[0];
        assert_eq!(
            (a.id.as_str(), a.index, a.status.as_str()),
            ("task-a", 2, "ok")
        );
        assert_eq!(a.steps.len(), 3);
        assert_eq!(a.steps[1].kind, "tool");
        assert_eq!(a.steps_total, 3);
        let json = serde_json::to_value(&c.subagents[1]).unwrap();
        assert_eq!(json["status"], "error");
        assert_eq!(json["agentType"], serde_json::Value::Null);
        assert!(json["steps"][0].get("subagent").is_none());
    }

    #[test]
    fn the_call_step_names_its_run_and_others_leave_it_out() {
        let (_d, home, index, _f) = fixture();
        let c = read_conversation(&index, &[home], "s-1", None, None).unwrap();
        let json = serde_json::to_value(&c).unwrap();
        assert!(json["items"][2].get("subagent").is_none());
        assert_eq!(json["subagents"], serde_json::json!([]));
    }

    #[test]
    fn a_bad_key_is_not_found() {
        let (_d, home, index, _f) = fixture();
        let e = read_conversation(&index, &[home], "own-claude:nope", None, None).unwrap_err();
        assert_eq!(e.code, "not_found");
    }

    #[test]
    fn a_log_outside_the_store_is_refused() {
        let (_d, home, mut index, _f) = fixture();
        let other = tempfile::tempdir().unwrap();
        let out = other.path().join("s-1.jsonl");
        fs::write(&out, LOG).unwrap();
        let old = index.files.keys().next().unwrap().clone();
        let mark = index.files.remove(&old).unwrap();
        index.files.insert(out.to_string_lossy().into_owned(), mark);
        let e = read_conversation(&index, &[home], "own-claude:s-1", None, None).unwrap_err();
        assert_eq!(e.code, "bad_path");
    }
}
