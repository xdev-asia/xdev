//! The extra agent arguments an automation may carry: a small allowlist, checked here and
//! again by the backend before a launch.

use serde::{Deserialize, Serialize};
use xdev_agent::Cli;

pub const EXTRA_ARGS_MAX_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum ExtraArgsError {
    TooLarge,
    ControlCharacters,
    ShellSyntax { text: String },
    Terminator,
    NotAnOption { token: String },
    OptionNotAllowed { option: String },
    MissingValue { option: String },
    ValueNotAllowed { option: String, value: String },
    ModelRepeated,
    EffortRepeated,
    Unsupported,
    RequireFreshSession,
}

/// The argv to append for `cli`, or why the text is refused. `None` is a custom shell profile.
pub fn parse_extra_args(_cli: Option<Cli>, _text: &str) -> Result<Vec<String>, ExtraArgsError> {
    Err(ExtraArgsError::Unsupported)
}
