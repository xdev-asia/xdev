//! The CLI arguments a profile's model, effort and approval mode turn into.

use crate::profiles::{Cli, Permissions};

const CLAUDE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS: [&str; 3] = ["low", "medium", "high"];

/// The effort levels `cli` accepts; Gemini has none.
pub fn efforts(cli: Cli) -> &'static [&'static str] {
    match cli {
        Cli::Claude => &CLAUDE_EFFORTS,
        Cli::Codex => &CODEX_EFFORTS,
        Cli::Gemini => &[],
    }
}

/// The mapped flags, in the order they go before the profile's own args. A
/// blank model, an effort the CLI has no flag for and `Ask` add nothing.
pub fn flags(
    cli: Cli,
    model: Option<&str>,
    effort: Option<&str>,
    permissions: Permissions,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |parts: &[&str]| out.extend(parts.iter().map(|p| (*p).to_owned()));
    if let Some(model) = model.filter(|m| !m.trim().is_empty()) {
        push(&[if cli == Cli::Claude { "--model" } else { "-m" }, model]);
    }
    if let Some(effort) = effort.filter(|e| !e.trim().is_empty()) {
        match cli {
            Cli::Claude => push(&["--effort", effort]),
            Cli::Codex => push(&["-c", &format!("model_reasoning_effort={effort}")]),
            Cli::Gemini => {}
        }
    }
    match (cli, permissions) {
        (_, Permissions::Ask) => {}
        (Cli::Claude, Permissions::AcceptEdits) => push(&["--permission-mode", "acceptEdits"]),
        (Cli::Claude, Permissions::Skip) => push(&["--dangerously-skip-permissions"]),
        (Cli::Codex, Permissions::AcceptEdits) => push(&[
            "--sandbox",
            "workspace-write",
            "--ask-for-approval",
            "on-request",
        ]),
        (Cli::Codex, Permissions::Skip) => push(&["--dangerously-bypass-approvals-and-sandbox"]),
        (Cli::Gemini, Permissions::AcceptEdits) => push(&["--approval-mode", "auto_edit"]),
        (Cli::Gemini, Permissions::Skip) => push(&["--approval-mode", "yolo"]),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_flags() {
        assert_eq!(
            flags(Cli::Claude, Some("opus"), Some("high"), Permissions::Skip),
            [
                "--model",
                "opus",
                "--effort",
                "high",
                "--dangerously-skip-permissions"
            ]
        );
        assert_eq!(
            flags(Cli::Claude, None, None, Permissions::AcceptEdits),
            ["--permission-mode", "acceptEdits"]
        );
    }

    #[test]
    fn codex_accept_edits() {
        assert_eq!(
            flags(Cli::Codex, None, None, Permissions::AcceptEdits),
            [
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request"
            ]
        );
        assert_eq!(
            flags(Cli::Codex, Some("m"), Some("low"), Permissions::Skip),
            [
                "-m",
                "m",
                "-c",
                "model_reasoning_effort=low",
                "--dangerously-bypass-approvals-and-sandbox"
            ]
        );
    }

    #[test]
    fn gemini_skip_and_no_effort() {
        assert_eq!(
            flags(Cli::Gemini, Some("x"), Some("high"), Permissions::Skip),
            ["-m", "x", "--approval-mode", "yolo"]
        );
        assert_eq!(
            flags(Cli::Gemini, None, None, Permissions::AcceptEdits),
            ["--approval-mode", "auto_edit"]
        );
    }

    #[test]
    fn ask_and_blank_values_add_nothing() {
        for cli in Cli::ALL {
            assert!(flags(cli, None, None, Permissions::Ask).is_empty());
            assert!(flags(cli, Some(" "), Some(""), Permissions::Ask).is_empty());
        }
    }

    #[test]
    fn effort_lists() {
        assert_eq!(
            efforts(Cli::Claude),
            ["low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(efforts(Cli::Codex), ["low", "medium", "high"]);
        assert!(efforts(Cli::Gemini).is_empty());
    }
}
