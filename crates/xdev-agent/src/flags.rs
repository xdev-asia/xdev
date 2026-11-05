//! The CLI arguments a profile's model, effort and approval mode turn into.

use crate::catalog::spec;
use crate::profiles::{Cli, Permissions};

const CLAUDE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS: [&str; 3] = ["low", "medium", "high"];

/// The effort levels `cli` accepts; Gemini has none.
pub fn efforts(cli: Cli) -> &'static [&'static str] {
    match cli {
        Cli::Claude => &CLAUDE_EFFORTS,
        Cli::Codex => &CODEX_EFFORTS,
        _ => &[],
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
            _ => {}
        }
    }
    let table = spec(cli);
    let recipe = match permissions {
        Permissions::Ask => &[][..],
        Permissions::AcceptEdits => table.accept_edits,
        Permissions::Auto => table.auto,
        Permissions::Skip => table.skip,
    };
    push(recipe);
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
    fn auto_for_claude_and_codex_only() {
        assert_eq!(
            flags(Cli::Claude, None, None, Permissions::Auto),
            ["--permission-mode", "auto"]
        );
        assert_eq!(
            flags(Cli::Codex, None, None, Permissions::Auto),
            ["--approve-for-me"]
        );
        for cli in Cli::ALL {
            if !matches!(cli, Cli::Claude | Cli::Codex) {
                assert!(flags(cli, None, None, Permissions::Auto).is_empty());
            }
        }
    }

    #[test]
    fn skip_follows_the_table() {
        let skip = |cli| flags(cli, None, None, Permissions::Skip);
        assert_eq!(skip(Cli::Cursor), ["--yolo"]);
        assert_eq!(skip(Cli::Copilot), ["--yolo"]);
        assert_eq!(skip(Cli::Amp), ["--dangerously-allow-all"]);
        assert_eq!(skip(Cli::Droid), ["--auto", "high"]);
        assert_eq!(skip(Cli::QwenCode), ["--approval-mode", "yolo"]);
        assert_eq!(skip(Cli::Kimi), ["--yolo"]);
        assert_eq!(
            skip(Cli::Devin),
            [
                "--permission-mode",
                "bypass",
                "--respect-workspace-trust",
                "false"
            ]
        );
        assert_eq!(skip(Cli::Aider), ["--yes-always"]);
        // No flag: opencode has no skip, goose uses env.
        assert!(skip(Cli::Opencode).is_empty());
        assert!(skip(Cli::Goose).is_empty());
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
