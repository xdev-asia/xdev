//! AI providers: API key, CLI subprocess and Ollama.

mod accounts;
mod claude;
mod codex;
mod codex_rpc;
pub mod ollama;
mod pool;
pub mod process;
mod quota;
pub mod secrets;
pub mod shim;

pub use accounts::{
    AccountEntry, ActiveAccount, Provider, Registry, Routing, account_dir, carry_session,
    default_home, login_command, status, valid_name,
};
pub use claude::{AccountStatus, StatusState, claude_command, claude_models};
pub use codex::{codex_command, codex_context, codex_home, codex_models};
pub use pool::{AccountId, Policy, Route, Usage, pick_account};
pub use quota::{
    ALERT_WINDOWS, AlertLog, Quota, QuotaAlert, QuotaState, QuotaWindow, Reason, classify, highest,
    pick, quota,
};

pub const NAME: &str = env!("CARGO_PKG_NAME");

#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("unknown provider")]
    UnknownProvider,
    #[error("secret store unavailable")]
    SecretStore,
    #[error("Ollama is unreachable")]
    OllamaUnreachable,
    #[error("Ollama HTTP status {0}")]
    OllamaError(u16),
    #[error("invalid Ollama response")]
    BadOllamaResponse,
    #[error("bad account name")]
    BadName,
    #[error("an account with this name exists")]
    Exists,
    #[error("no account with this name")]
    NotFound,
    #[error("Claude Code is not installed")]
    NoClaude,
    #[error("Codex CLI is not installed")]
    NoCodex,
    #[error("the accounts file is unreadable or from a newer xDev")]
    BadRegistry,
    #[error("reserve must be 0 to 90")]
    BadReserve,
    #[error("no log of this session in the account's home")]
    SessionMissing,
    #[error("routing names an unknown account or a percent out of range")]
    BadRouting,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl AiError {
    /// Stable code the UI and CLI translate.
    pub fn code(&self) -> &'static str {
        match self {
            AiError::UnknownProvider => "unknown_provider",
            AiError::SecretStore => "secret_store",
            AiError::OllamaUnreachable => "ollama_unreachable",
            AiError::OllamaError(_) | AiError::BadOllamaResponse => "ollama_error",
            AiError::BadName => "bad_name",
            AiError::Exists => "exists",
            AiError::NotFound => "not_found",
            AiError::NoClaude => "no_claude",
            AiError::NoCodex => "no_codex",
            AiError::BadRegistry => "bad_registry",
            AiError::BadReserve => "bad_reserve",
            AiError::SessionMissing => "session_missing",
            AiError::BadRouting => "bad_routing",
            AiError::Io(_) => "io",
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn name_matches_package() {
        assert_eq!(super::NAME, "xdev-ai");
    }
}
