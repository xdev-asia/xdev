//! How a message reads to an agent, and the `next` lines the verbs return.

use crate::model::{Message, MessageType, Priority};

/// The rule under a message: 60 box-drawing dashes.
const RULE: &str = "────────────────────────────────────────────────────────────";

pub const NEXT_IDLE: &str = "xDev wakes you when workers report; end your turn when you're done.";
pub const NEXT_MORE_MAIL: &str = "More mail is waiting: run check again.";
pub const NEXT_STARTED: &str = "xDev wakes you when a worker reports. Once every worker you need is started, end your turn. Do not poll.";
pub const NEXT_FINISH_MAIL: &str = "Finish the rest of your mail.";
pub const NEXT_RECORDED: &str = "Recorded. End your turn.";
pub const NEXT_BREAKER: &str = "Report the failure to the user instead of retrying.";

/// One message as a block of text.
pub fn render(m: &Message, name: &str) -> String {
    let tag = match m.priority {
        Priority::Normal => String::new(),
        Priority::High => " [HIGH]".to_owned(),
        Priority::Urgent => " [URGENT]".to_owned(),
    };
    let kind = crate::store::enum_text(&m.kind);
    let mut out = format!(
        "──── From: {name} ({}){tag} ({kind}) ────\nSubject: {}\n{}\n",
        m.from, m.subject, m.body
    );
    if let Some(p) = &m.payload {
        out.push_str(&format!("Payload: {p}\n"));
    }
    if matches!(m.kind, MessageType::Question | MessageType::DecisionGate) {
        out.push_str(&format!(
            "Reply: xdev orchestration reply --id {} --body \"…\"\n",
            m.id
        ));
    }
    out.push_str(RULE);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(kind: MessageType, priority: Priority) -> Message {
        Message {
            id: "msg_1".into(),
            run_id: "run_1".into(),
            from: "dispatch:disp_1".into(),
            to: "run:run_1".into(),
            subject: "Which db?".into(),
            body: "Postgres or sqlite?".into(),
            kind,
            priority,
            thread_id: None,
            payload: None,
            read: false,
            seq: 1,
            created_ms: 1,
            delivered_ms: None,
        }
    }

    #[test]
    fn a_question_shows_its_priority_payload_and_reply_line() {
        let mut m = msg(MessageType::Question, Priority::Urgent);
        m.payload = Some(json!({"taskId": "task_1"}));
        let want = format!(
            "──── From: worker-task_1 (dispatch:disp_1) [URGENT] (question) ────\n\
Subject: Which db?\n\
Postgres or sqlite?\n\
Payload: {{\"taskId\":\"task_1\"}}\n\
Reply: xdev orchestration reply --id msg_1 --body \"…\"\n\
{}",
            "─".repeat(60)
        );
        assert_eq!(render(&m, "worker-task_1"), want);
    }

    #[test]
    fn a_plain_status_has_no_tag_payload_or_reply_line() {
        let want = format!(
            "──── From: coordinator (dispatch:disp_1) (status) ────\nSubject: Which db?\nPostgres or sqlite?\n{}",
            "─".repeat(60)
        );
        assert_eq!(
            render(&msg(MessageType::Status, Priority::Normal), "coordinator"),
            want
        );
        let high = render(&msg(MessageType::Status, Priority::High), "c");
        assert!(high.starts_with("──── From: c (dispatch:disp_1) [HIGH] (status) ────"));
    }

    #[test]
    fn a_decision_gate_gets_a_reply_line_and_the_rule_is_sixty_dashes() {
        let m = render(&msg(MessageType::DecisionGate, Priority::Normal), "c");
        assert!(m.contains("Reply: xdev orchestration reply --id msg_1"));
        assert_eq!(m.lines().last().unwrap().chars().count(), 60);
    }

    #[test]
    fn the_next_lines_are_the_golden_text() {
        assert_eq!(
            NEXT_IDLE,
            "xDev wakes you when workers report; end your turn when you're done."
        );
        assert_eq!(NEXT_MORE_MAIL, "More mail is waiting: run check again.");
        assert_eq!(
            NEXT_STARTED,
            "xDev wakes you when a worker reports. Once every worker you need is started, end your turn. Do not poll."
        );
        assert_eq!(NEXT_FINISH_MAIL, "Finish the rest of your mail.");
        assert_eq!(NEXT_RECORDED, "Recorded. End your turn.");
        assert_eq!(
            NEXT_BREAKER,
            "Report the failure to the user instead of retrying."
        );
    }
}
