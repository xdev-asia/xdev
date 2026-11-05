//! The error every orchestration function returns.

use std::fmt;

/// A machine code the CLI maps to an exit code, and a sentence for the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrchError {
    /// `not_found`, `bad_request`, `no_run`, `too_large`,
    /// `nested_worker_depth_exceeded`, `worker_prompt_too_large`,
    /// `circuit_broken`, `invalid_transition`, `worker_kept`, `unsupported`,
    /// or `store` for a database failure.
    pub code: &'static str,
    pub message: String,
}

impl OrchError {
    pub fn new(code: &'static str, message: impl Into<String>) -> OrchError {
        OrchError {
            code,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> OrchError {
        OrchError::new("bad_request", message)
    }

    pub fn not_found(message: impl Into<String>) -> OrchError {
        OrchError::new("not_found", message)
    }
}

impl fmt::Display for OrchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for OrchError {}

impl From<rusqlite::Error> for OrchError {
    fn from(e: rusqlite::Error) -> OrchError {
        OrchError::new("store", e.to_string())
    }
}

impl From<serde_json::Error> for OrchError {
    fn from(e: serde_json::Error) -> OrchError {
        OrchError::new("store", e.to_string())
    }
}
