//! Every word a squad says to its agents and the markers it reads back, in
//! one place so the wording can be tuned without touching the flow.

use crate::{FileChange, Role, TestResult, tail};

pub(crate) const ESCALATE: &str = "XDEV-ESCALATE:";
pub(crate) const REVIEW: &str = "XDEV-REVIEW:";

/// Longest plan, notes or answer quoted into a prompt. Windows hands a
/// prompt to `claude.cmd` on one command line, which has a length limit.
const QUOTE_MAX: usize = 3000;
/// Changed files listed in a prompt; the agent can find the rest itself.
const FILES_MAX: usize = 40;
const TEST_TAIL: usize = 1500;

const CONTRACT: &str = "You are one seat of a team of agents working in a git worktree made for \
this task. Change files in this folder only. Do not commit, push or switch branches: xDev \
commits the work for a person to review. If a decision you cannot make blocks you, end your \
reply with one line `XDEV-ESCALATE: <question>` and stop.";

pub(crate) fn plan(goal: &str) -> String {
    format!(
        "Goal:\n{goal}\n\nYou are the lead. Read the code and write a short plan for the \
         implementer: which files to change and in what steps. Do not change any file.\n\n\
         {CONTRACT}"
    )
}

pub(crate) fn implement(goal: &str, plan: Option<&str>) -> String {
    format!(
        "Goal:\n{goal}\n{}\nYou are the implementer. Make the change.\n\n{CONTRACT}",
        plan_part(plan)
    )
}

pub(crate) fn tests(goal: &str, plan: Option<&str>, files: &[FileChange], round: u8) -> String {
    let again = if round > 1 {
        "The code changed after review. "
    } else {
        ""
    };
    format!(
        "Goal:\n{goal}\n{}\nChanged files:\n{}\n\nYou write the tests. {again}Add or update \
         tests for this change.\n\n{CONTRACT}",
        plan_part(plan),
        file_list(files)
    )
}

pub(crate) fn review(
    goal: &str,
    plan: Option<&str>,
    files: &[FileChange],
    test: Option<&TestResult>,
    round: u8,
) -> String {
    let again = if round > 1 {
        "The implementer worked on your notes; review the change again. "
    } else {
        ""
    };
    let test = match test {
        Some(t) => format!(
            "\nTest `{}` exited {}. End of its output:\n{}\n",
            t.command.join(" "),
            t.exit
                .map_or_else(|| "without a code".to_owned(), |c| c.to_string()),
            tail(&t.output_tail, TEST_TAIL)
        ),
        None => String::new(),
    };
    format!(
        "Goal:\n{goal}\n{}\nChanged files:\n{}\n{test}\nYou are the reviewer. {again}Read the \
         changed files and judge the change. Do not change any file. End your reply with one \
         line: `{REVIEW} approve` when it is ready for a person, or `{REVIEW} changes` with your \
         notes for the implementer above it.\n\n{CONTRACT}",
        plan_part(plan),
        file_list(files)
    )
}

pub(crate) fn changes(notes: &str) -> String {
    format!(
        "The reviewer asks for changes:\n{}\n\nWork on these notes, then stop.",
        quote(notes)
    )
}

/// The lead is asked a seat's question.
pub(crate) fn lead_question(goal: &str, from: Role, question: &str) -> String {
    format!(
        "Goal:\n{goal}\n\nThe {} seat is blocked and asks:\n{}\n\nAnswer so they can go on. Do \
         not change any file. If only the person can decide, end with one line \
         `{ESCALATE} <question for the person>`.",
        from.as_str(),
        quote(question)
    )
}

pub(crate) fn answer(question: &str, answer: &str, by_person: bool) -> String {
    let who = if by_person { "the person" } else { "the lead" };
    format!(
        "You asked: {}\nAnswer from {who}:\n{}\n\nGo on with your step.",
        quote(question),
        quote(answer)
    )
}

pub(crate) fn steer(text: &str) -> String {
    format!(
        "A message from the person:\n{}\n\nTake it into account and go on.",
        quote(text)
    )
}

/// The question when the last line is `XDEV-ESCALATE: <question>`. A marker
/// with no question asks with the text above it.
pub(crate) fn escalation(text: &str) -> Option<String> {
    let (above, last) = split_last(text);
    let question = last.strip_prefix(ESCALATE)?.trim();
    if !question.is_empty() {
        Some(question.to_owned())
    } else if !above.trim().is_empty() {
        Some(tail(above.trim(), QUOTE_MAX))
    } else {
        Some("(no question given)".to_owned())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    Approve,
    Changes,
}

/// The verdict on the last line and the notes above it. Only an explicit
/// approval passes, so a reviewer that forgot the marker asks for changes.
pub(crate) fn review_verdict(text: &str) -> (Verdict, String) {
    let (above, last) = split_last(text);
    match last.strip_prefix(REVIEW).map(str::trim) {
        Some(v) if v.eq_ignore_ascii_case("approve") => (Verdict::Approve, above.trim().to_owned()),
        Some(_) => (Verdict::Changes, above.trim().to_owned()),
        None => (Verdict::Changes, text.trim().to_owned()),
    }
}

/// The text above the last non-empty line, and that line without the
/// quoting or bold marks agents like to wrap a marker in.
fn split_last(text: &str) -> (&str, &str) {
    let trimmed = text.trim_end();
    let (above, last) = match trimmed.rfind('\n') {
        Some(i) => (&trimmed[..i], &trimmed[i + 1..]),
        None => ("", trimmed),
    };
    (above, last.trim().trim_matches(['`', '*', '>', ' ']))
}

fn plan_part(plan: Option<&str>) -> String {
    match plan {
        Some(plan) if !plan.trim().is_empty() => {
            format!("\nPlan from the lead:\n{}\n", quote(plan))
        }
        _ => String::new(),
    }
}

fn file_list(files: &[FileChange]) -> String {
    if files.is_empty() {
        return "(none yet)".to_owned();
    }
    let count = |n: Option<u64>| n.map_or_else(|| "-".to_owned(), |n| n.to_string());
    let mut lines: Vec<String> = files
        .iter()
        .take(FILES_MAX)
        .map(|f| format!("- {} (+{} -{})", f.path, count(f.added), count(f.removed)))
        .collect();
    if files.len() > FILES_MAX {
        lines.push(format!("- and {} more", files.len() - FILES_MAX));
    }
    lines.join("\n")
}

/// The start of a long text; a plan or a question says the most first.
fn quote(text: &str) -> String {
    let text = text.trim();
    if text.len() <= QUOTE_MAX {
        return text.to_owned();
    }
    let mut end = QUOTE_MAX;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{} [...]", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escalation_needs_the_marker_on_the_last_line() {
        assert_eq!(
            escalation("Looked around.\nXDEV-ESCALATE: Which DB?\n\n").as_deref(),
            Some("Which DB?")
        );
        assert_eq!(
            escalation("`XDEV-ESCALATE: Keep the API?`").as_deref(),
            Some("Keep the API?")
        );
        assert_eq!(escalation("XDEV-ESCALATE: no\nDone anyway."), None);
        assert_eq!(escalation("Done."), None);
        assert_eq!(
            escalation("Should I drop the table?\nXDEV-ESCALATE:").as_deref(),
            Some("Should I drop the table?")
        );
    }

    #[test]
    fn review_verdicts() {
        assert_eq!(
            review_verdict("Looks good.\nXDEV-REVIEW: approve"),
            (Verdict::Approve, "Looks good.".to_owned())
        );
        assert_eq!(
            review_verdict("Fix the name.\n**XDEV-REVIEW: changes**\n"),
            (Verdict::Changes, "Fix the name.".to_owned())
        );
        assert_eq!(
            review_verdict("No marker here."),
            (Verdict::Changes, "No marker here.".to_owned())
        );
    }

    #[test]
    fn long_quotes_are_cut_on_a_char_boundary() {
        let long = "é".repeat(QUOTE_MAX);
        let q = quote(&long);
        assert!(q.ends_with(" [...]"));
        assert!(q.len() <= QUOTE_MAX + 6);
    }

    #[test]
    fn file_list_is_capped() {
        let files: Vec<FileChange> = (0..FILES_MAX + 2)
            .map(|i| FileChange {
                path: format!("f{i}"),
                added: Some(1),
                removed: None,
            })
            .collect();
        let list = file_list(&files);
        assert!(list.starts_with("- f0 (+1 --)"));
        assert!(list.ends_with("- and 2 more"));
    }
}
