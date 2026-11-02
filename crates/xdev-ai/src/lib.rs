//! AI providers: API key, CLI subprocess and Ollama.

mod accounts;
mod claude;
mod quota;

pub use accounts::{AccountEntry, Provider, Registry, account_dir, valid_name};
pub use claude::{AccountStatus, StatusState, claude_command, login_command, status};
pub use quota::{Quota, QuotaState, QuotaWindow, Reason, classify, pick, quota};

pub const NAME: &str = env!("CARGO_PKG_NAME");

#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("bad account name")]
    BadName,
    #[error("an account with this name exists")]
    Exists,
    #[error("no account with this name")]
    NotFound,
    #[error("Claude Code is not installed")]
    NoClaude,
    #[error("the accounts file is unreadable or from a newer xDev")]
    BadRegistry,
    #[error("reserve must be 0 to 90")]
    BadReserve,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl AiError {
    /// Stable code the UI and CLI translate.
    pub fn code(&self) -> &'static str {
        match self {
            AiError::BadName => "bad_name",
            AiError::Exists => "exists",
            AiError::NotFound => "not_found",
            AiError::NoClaude => "no_claude",
            AiError::BadRegistry => "bad_registry",
            AiError::BadReserve => "bad_reserve",
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
