//! The built-in terminal agents as one data table: what each is called, how
//! it is found, how a prompt and the approval modes reach it, where its docs
//! are and whether xDev can pre-write its folder trust. Everything that
//! differs between agents is a row here; no other code matches on the CLI.

use crate::profiles::{Cli, DefaultAgent, Permissions};

/// How a first prompt reaches the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptMode {
    /// The prompt is the last argument.
    Argv,
    /// The prompt is the last argument after the given separator (`--`).
    ArgvAfter(&'static str),
    /// The prompt follows the given flag.
    Flag(&'static str),
    /// The prompt is typed into the terminal once the agent has started.
    AfterStart,
}

/// Which agent's trust store `trust_folder` writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustKind {
    Claude,
    Codex,
    Cursor,
    Copilot,
    Kimi,
}

#[derive(Debug, Clone, Copy)]
pub struct AgentSpec {
    pub cli: Cli,
    pub title: &'static str,
    /// The program names probed on `PATH`, first match wins.
    pub commands: &'static [&'static str],
    pub prompt: PromptMode,
    /// Args of the full-access mode.
    pub skip: &'static [&'static str],
    /// Env of the full-access mode (set when no arg exists for it).
    pub skip_env: &'static [(&'static str, &'static str)],
    /// Args of the "approve for me" mode.
    pub auto: &'static [&'static str],
    pub accept_edits: &'static [&'static str],
    pub docs_url: &'static str,
    pub trust: Option<TrustKind>,
}

const fn row(
    cli: Cli,
    title: &'static str,
    commands: &'static [&'static str],
    prompt: PromptMode,
    docs_url: &'static str,
) -> AgentSpec {
    AgentSpec {
        cli,
        title,
        commands,
        prompt,
        skip: &[],
        skip_env: &[],
        auto: &[],
        accept_edits: &[],
        docs_url,
        trust: None,
    }
}

/// One row per `Cli`, in `Cli::ALL` order.
static SPECS: [AgentSpec; 13] = [
    AgentSpec {
        skip: &["--dangerously-skip-permissions"],
        auto: &["--permission-mode", "auto"],
        accept_edits: &["--permission-mode", "acceptEdits"],
        trust: Some(TrustKind::Claude),
        ..row(
            Cli::Claude,
            "Claude Code",
            &["claude"],
            PromptMode::Argv,
            "https://code.claude.com/docs",
        )
    },
    AgentSpec {
        skip: &["--dangerously-bypass-approvals-and-sandbox"],
        auto: &["--approve-for-me"],
        accept_edits: &[
            "--sandbox",
            "workspace-write",
            "--ask-for-approval",
            "on-request",
        ],
        trust: Some(TrustKind::Codex),
        ..row(
            Cli::Codex,
            "Codex",
            &["codex"],
            PromptMode::Argv,
            "https://github.com/openai/codex",
        )
    },
    AgentSpec {
        skip: &["--approval-mode", "yolo"],
        accept_edits: &["--approval-mode", "auto_edit"],
        ..row(
            Cli::Gemini,
            "Gemini CLI",
            &["gemini"],
            PromptMode::Flag("--prompt-interactive"),
            "https://github.com/google-gemini/gemini-cli",
        )
    },
    AgentSpec {
        skip: &["--yolo"],
        trust: Some(TrustKind::Cursor),
        ..row(
            Cli::Cursor,
            "Cursor",
            &["cursor-agent"],
            PromptMode::Argv,
            "https://cursor.com/cli",
        )
    },
    AgentSpec {
        skip: &["--yolo"],
        trust: Some(TrustKind::Copilot),
        ..row(
            Cli::Copilot,
            "GitHub Copilot",
            &["copilot"],
            PromptMode::Flag("-i"),
            "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
        )
    },
    row(
        Cli::Opencode,
        "OpenCode",
        &["opencode"],
        PromptMode::Flag("--prompt"),
        "https://opencode.ai/docs/cli/",
    ),
    AgentSpec {
        skip: &["--dangerously-allow-all"],
        ..row(
            Cli::Amp,
            "Amp",
            &["amp"],
            PromptMode::AfterStart,
            "https://ampcode.com/manual#install",
        )
    },
    AgentSpec {
        skip: &["--auto", "high"],
        ..row(
            Cli::Droid,
            "Droid",
            &["droid"],
            PromptMode::Argv,
            "https://docs.factory.ai/cli/getting-started/quickstart",
        )
    },
    AgentSpec {
        skip: &["--approval-mode", "yolo"],
        ..row(
            Cli::QwenCode,
            "Qwen Code",
            &["qwen"],
            PromptMode::AfterStart,
            "https://github.com/QwenLM/qwen-code",
        )
    },
    AgentSpec {
        skip: &["--yolo"],
        trust: Some(TrustKind::Kimi),
        ..row(
            Cli::Kimi,
            "Kimi",
            &["kimi", "kimi-code"],
            PromptMode::AfterStart,
            "https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html",
        )
    },
    AgentSpec {
        skip: &[
            "--permission-mode",
            "bypass",
            "--respect-workspace-trust",
            "false",
        ],
        ..row(
            Cli::Devin,
            "Devin",
            &["devin"],
            PromptMode::ArgvAfter("--"),
            "https://devin.ai/cli",
        )
    },
    AgentSpec {
        skip: &["--yes-always"],
        ..row(
            Cli::Aider,
            "Aider",
            &["aider"],
            PromptMode::AfterStart,
            "https://aider.chat/docs/",
        )
    },
    AgentSpec {
        skip_env: &[("GOOSE_MODE", "auto")],
        ..row(
            Cli::Goose,
            "Goose",
            &["goose"],
            PromptMode::AfterStart,
            "https://goose-docs.ai/docs/quickstart/",
        )
    },
];

/// The order `auto` tries the agents in.
pub const AUTO_ORDER: [Cli; 13] = [
    Cli::Claude,
    Cli::Codex,
    Cli::Copilot,
    Cli::Opencode,
    Cli::Gemini,
    Cli::Aider,
    Cli::Goose,
    Cli::Amp,
    Cli::Cursor,
    Cli::Droid,
    Cli::Kimi,
    Cli::QwenCode,
    Cli::Devin,
];

pub fn spec(cli: Cli) -> &'static AgentSpec {
    SPECS
        .iter()
        .find(|s| s.cli == cli)
        .expect("every Cli has a row")
}

/// The modes the agent offers: `Ask` (its own settings) always, the others
/// when the table has flags or env for them.
pub fn modes(cli: Cli) -> Vec<Permissions> {
    let s = spec(cli);
    let mut out = vec![Permissions::Ask];
    if !s.accept_edits.is_empty() {
        out.push(Permissions::AcceptEdits);
    }
    if !s.auto.is_empty() {
        out.push(Permissions::Auto);
    }
    if !s.skip.is_empty() || !s.skip_env.is_empty() {
        out.push(Permissions::Skip);
    }
    out
}

/// The built-in profile the default agent picks. `usable` says whether a
/// profile id is installed and enabled. A saved agent that is not usable
/// falls back to the `auto` order; no usable agent gives `None` (a shell).
pub fn pick_agent(default: &DefaultAgent, usable: &dyn Fn(&str) -> bool) -> Option<String> {
    match default {
        DefaultAgent::Blank => None,
        DefaultAgent::Agent(id) if usable(id) => Some(id.clone()),
        DefaultAgent::Agent(_) | DefaultAgent::Auto => AUTO_ORDER
            .iter()
            .map(|cli| cli.as_str())
            .find(|id| usable(id))
            .map(str::to_owned),
    }
}

/// The spawn args that carry `prompt`; none for `AfterStart`.
pub fn prompt_args(cli: Cli, prompt: &str) -> Vec<String> {
    match spec(cli).prompt {
        PromptMode::Argv => vec![prompt.to_owned()],
        PromptMode::ArgvAfter(sep) => vec![sep.to_owned(), prompt.to_owned()],
        PromptMode::Flag(flag) => vec![flag.to_owned(), prompt.to_owned()],
        PromptMode::AfterStart => Vec::new(),
    }
}

/// Whether `args` already hold a permission flag of this agent (skip, auto or
/// accept-edits), so xDev adds none of its own.
pub fn has_permission_args(cli: Cli, args: &[String]) -> bool {
    let s = spec(cli);
    [s.skip, s.auto, s.accept_edits]
        .iter()
        .filter_map(|recipe| recipe.first())
        .any(|head| {
            args.iter()
                .any(|a| a == head || a.strip_prefix(head).is_some_and(|r| r.starts_with('=')))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thirteen_specs_in_cli_order() {
        assert_eq!(SPECS.len(), Cli::ALL.len());
        for (cli, spec) in Cli::ALL.iter().zip(SPECS.iter()) {
            assert_eq!(*cli, spec.cli);
        }
        let ids: Vec<_> = Cli::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(
            ids,
            [
                "claude",
                "codex",
                "gemini",
                "cursor",
                "copilot",
                "opencode",
                "amp",
                "droid",
                "qwen-code",
                "kimi",
                "devin",
                "aider",
                "goose"
            ]
        );
    }

    #[test]
    fn serde_ids_round_trip() {
        for cli in Cli::ALL {
            let json = serde_json::to_string(&cli).unwrap();
            assert_eq!(json, format!("\"{}\"", cli.as_str()));
            assert_eq!(serde_json::from_str::<Cli>(&json).unwrap(), cli);
        }
        assert_eq!(
            serde_json::to_string(&Cli::QwenCode).unwrap(),
            "\"qwen-code\""
        );
    }

    #[test]
    fn auto_order_is_a_permutation() {
        let mut order = AUTO_ORDER.to_vec();
        order.sort_by_key(|c| c.as_str());
        let mut all = Cli::ALL.to_vec();
        all.sort_by_key(|c| c.as_str());
        assert_eq!(order, all);
    }

    #[test]
    fn docs_urls_are_https() {
        for s in &SPECS {
            assert!(s.docs_url.starts_with("https://"), "{}", s.title);
            assert!(!s.commands.is_empty());
        }
    }

    #[test]
    fn modes_follow_the_table() {
        assert_eq!(
            modes(Cli::Claude),
            [
                Permissions::Ask,
                Permissions::AcceptEdits,
                Permissions::Auto,
                Permissions::Skip
            ]
        );
        assert_eq!(modes(Cli::Opencode), [Permissions::Ask]);
        assert_eq!(modes(Cli::Goose), [Permissions::Ask, Permissions::Skip]);
        assert!(!modes(Cli::Gemini).contains(&Permissions::Auto));
    }
}
