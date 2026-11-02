//! Rules the person writes to send small work to a cheaper model. The first
//! rule that matches picks the model; no match leaves the CLI's own default.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::AgentError;
use crate::store::write_atomic;

const FILE: &str = "routing.json";

/// Unset conditions match anything.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RouteRule {
    /// A seat (`lead`, `implement`, `tests`, `review`) or `task` for a
    /// single-agent task.
    #[serde(default)]
    pub role: Option<String>,
    /// `claude` or `codex`.
    #[serde(default)]
    pub provider: Option<String>,
    /// Matches prompts at most this many characters long.
    #[serde(default)]
    pub max_prompt: Option<u32>,
    /// Passed to the CLI as is, so an alias such as `haiku` works too.
    pub model: String,
}

/// Kept in `<data_dir>/routing.json`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Routing {
    #[serde(default)]
    pub rules: Vec<RouteRule>,
}

impl Routing {
    /// No file is no rules.
    pub fn load(data_dir: &Path) -> Result<Routing, AgentError> {
        match fs::read_to_string(data_dir.join(FILE)) {
            Ok(text) => Ok(serde_json::from_str(&text)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Routing::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, data_dir: &Path) -> Result<(), AgentError> {
        if self.rules.iter().any(|r| r.model.trim().is_empty()) {
            return Err(AgentError::EmptyText);
        }
        let mut text = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        text.push('\n');
        write_atomic(data_dir, FILE, &text)?;
        Ok(())
    }

    pub fn pick(&self, role: &str, provider: &str, prompt: &str) -> Option<String> {
        let len = prompt.chars().count();
        self.rules
            .iter()
            .find(|r| {
                r.role.as_deref().is_none_or(|x| x == role)
                    && r.provider.as_deref().is_none_or(|x| x == provider)
                    && r.max_prompt.is_none_or(|max| len <= max as usize)
            })
            .map(|r| r.model.trim().to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(
        role: Option<&str>,
        provider: Option<&str>,
        max: Option<u32>,
        model: &str,
    ) -> RouteRule {
        RouteRule {
            role: role.map(str::to_owned),
            provider: provider.map(str::to_owned),
            max_prompt: max,
            model: model.to_owned(),
        }
    }

    #[test]
    fn the_first_matching_rule_wins() {
        let routing = Routing {
            rules: vec![
                rule(Some("review"), Some("claude"), None, "haiku"),
                rule(None, Some("codex"), Some(10), "gpt-mini"),
                rule(None, None, None, "sonnet"),
            ],
        };
        assert_eq!(
            routing.pick("review", "claude", "x").as_deref(),
            Some("haiku")
        );
        assert_eq!(
            routing.pick("review", "codex", "short").as_deref(),
            Some("gpt-mini")
        );
        assert_eq!(
            routing
                .pick("review", "codex", "a longer prompt")
                .as_deref(),
            Some("sonnet")
        );
        assert_eq!(Routing::default().pick("lead", "claude", ""), None);
    }

    #[test]
    fn rules_round_trip_and_a_missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Routing::load(dir.path()).unwrap(), Routing::default());
        let routing = Routing {
            rules: vec![rule(Some("task"), None, Some(500), "haiku")],
        };
        routing.save(dir.path()).unwrap();
        assert_eq!(Routing::load(dir.path()).unwrap(), routing);

        let blank = Routing {
            rules: vec![rule(None, None, None, " ")],
        };
        assert_eq!(blank.save(dir.path()).unwrap_err().code(), "empty_text");
        assert_eq!(Routing::load(dir.path()).unwrap(), routing);
    }
}
