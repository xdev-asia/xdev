//! The question an agent stopped on, read from the hook stdin of a
//! `needs-input` event, so the desktop can show it as a card.
//!
//! Only claude sends one (checked against the hook input format of 2.1.317,
//! not against a live run in this repo):
//!
//! - `PreToolUse` / `PermissionRequest` for `AskUserQuestion`: the
//!   `tool_input.questions` list; each has `question`, `header`,
//!   `multiSelect` and `options` (`label`, `description`).
//! - `PermissionRequest` for any other tool: a permission prompt. The payload
//!   holds the tool, not the dialog's options, so none are kept.
//! - `Elicitation`: an MCP server asks for input; its `message` is kept.
//!
//! Every string is cut and the option list is held to [`OPTIONS_MAX`] (the
//! digits a menu answers to). Nothing else of the tool input is kept.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The most chars a question's text keeps.
pub const QUESTION_MAX: usize = 400;
/// The most chars an option's label keeps.
pub const LABEL_MAX: usize = 80;
/// The most chars an option's description or a header keeps.
pub const NOTE_MAX: usize = 120;
/// The most options kept: one digit each.
pub const OPTIONS_MAX: usize = 9;

/// What kind of answer the agent waits for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum QuestionKind {
    /// May the tool run: the CLI's own permission dialog.
    Permission,
    /// Pick one (or more, `multi`) of `options`.
    Choice,
    /// Free input the hook does not describe (an MCP elicitation).
    #[default]
    Input,
}

/// One option of a question.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

/// The question of a `needs-input` hook.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(default, rename_all = "camelCase")]
pub struct HookQuestion {
    pub kind: QuestionKind,
    /// The question; empty for a permission prompt (the tool says it).
    pub text: String,
    /// A short title the CLI shows over the question.
    pub header: Option<String>,
    pub options: Vec<QuestionOption>,
    /// More than one option may be picked.
    pub multi: bool,
    /// Questions the call asks; only the first is kept here.
    pub count: u32,
}

fn clip(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

fn text_of<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
}

/// The question in a hook's stdin JSON; `None` when it holds none.
pub fn question_of(input: &Map<String, Value>) -> Option<HookQuestion> {
    let event = text_of(input, "hook_event_name").unwrap_or("");
    let tool = text_of(input, "tool_name");
    if tool == Some("AskUserQuestion") {
        return ask_user_question(input.get("tool_input")?.as_object()?);
    }
    match event {
        "PermissionRequest" if tool.is_some() => Some(HookQuestion {
            kind: QuestionKind::Permission,
            count: 1,
            ..HookQuestion::default()
        }),
        "Elicitation" => Some(HookQuestion {
            kind: QuestionKind::Input,
            text: clip(text_of(input, "message")?, QUESTION_MAX),
            header: text_of(input, "mcp_server_name").map(|s| clip(s, NOTE_MAX)),
            count: 1,
            ..HookQuestion::default()
        }),
        _ => None,
    }
}

fn ask_user_question(input: &Map<String, Value>) -> Option<HookQuestion> {
    let questions = input.get("questions")?.as_array()?;
    let first = questions.first()?.as_object()?;
    let text = clip(text_of(first, "question")?, QUESTION_MAX);
    let options: Vec<QuestionOption> = first
        .get("options")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|o| {
                    let o = o.as_object()?;
                    Some(QuestionOption {
                        label: clip(text_of(o, "label")?, LABEL_MAX),
                        description: text_of(o, "description").map(|d| clip(d, NOTE_MAX)),
                    })
                })
                .take(OPTIONS_MAX)
                .collect()
        })
        .unwrap_or_default();
    Some(HookQuestion {
        kind: if options.is_empty() {
            QuestionKind::Input
        } else {
            QuestionKind::Choice
        },
        text,
        header: text_of(first, "header").map(|h| clip(h, NOTE_MAX)),
        options,
        multi: first
            .get("multiSelect")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        count: u32::try_from(questions.len()).unwrap_or(u32::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Map<String, Value> {
        let path = format!("{}/fixtures/hooks/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn ask_user_question_keeps_text_header_and_options() {
        let q = question_of(&fixture("claude-ask-user-question.json")).unwrap();
        assert_eq!(q.kind, QuestionKind::Choice);
        assert_eq!(q.text, "Which database should the cache use?");
        assert_eq!(q.header.as_deref(), Some("Cache"));
        assert!(!q.multi);
        assert_eq!(q.count, 1);
        let labels: Vec<&str> = q.options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, ["Redis", "SQLite", "In memory"]);
        assert_eq!(
            q.options[1].description.as_deref(),
            Some("A file next to the app")
        );
    }

    #[test]
    fn a_multi_select_call_keeps_its_first_question_and_count() {
        let q = question_of(&fixture("claude-ask-multi.json")).unwrap();
        assert_eq!(q.kind, QuestionKind::Choice);
        assert!(q.multi);
        assert_eq!(q.count, 2);
        assert_eq!(q.options.len(), 3);
        assert_eq!(q.options[0].description, None);
    }

    #[test]
    fn a_permission_request_is_a_permission_without_options() {
        let q = question_of(&fixture("claude-permission-bash.json")).unwrap();
        assert_eq!(q.kind, QuestionKind::Permission);
        assert!(q.options.is_empty());
        assert_eq!(q.text, "");
        // The command is not copied into the question.
        let text = serde_json::to_string(&q).unwrap();
        assert!(!text.contains("rm -rf"), "{text}");
    }

    #[test]
    fn an_elicitation_keeps_its_message_and_server() {
        let q = question_of(&fixture("claude-elicitation.json")).unwrap();
        assert_eq!(q.kind, QuestionKind::Input);
        assert_eq!(q.text, "Which project should the ticket go to?");
        assert_eq!(q.header.as_deref(), Some("tickets"));
    }

    #[test]
    fn other_hooks_have_no_question() {
        assert_eq!(question_of(&fixture("claude-stop.json")), None);
        assert_eq!(question_of(&Map::new()), None);
        let mut broken = fixture("claude-ask-user-question.json");
        broken.insert("tool_input".into(), Value::String("x".into()));
        assert_eq!(question_of(&broken), None);
    }

    #[test]
    fn long_strings_are_cut_and_options_held_to_nine() {
        let options: Vec<Value> = (0..12)
            .map(|i| serde_json::json!({ "label": format!("{i}{}", "l".repeat(200)), "description": "d".repeat(300) }))
            .collect();
        let input = serde_json::json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "AskUserQuestion",
            "tool_input": { "questions": [{ "question": "q".repeat(1000), "header": "h".repeat(300), "options": options }] }
        });
        let q = question_of(input.as_object().unwrap()).unwrap();
        assert_eq!(q.text.chars().count(), QUESTION_MAX);
        assert_eq!(q.header.unwrap().chars().count(), NOTE_MAX);
        assert_eq!(q.options.len(), OPTIONS_MAX);
        assert_eq!(q.options[0].label.chars().count(), LABEL_MAX);
        assert_eq!(
            q.options[0].description.as_ref().unwrap().chars().count(),
            NOTE_MAX
        );
    }
}
