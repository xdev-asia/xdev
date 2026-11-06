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

/// Where a kind of work goes: an agent CLI, and optionally a model and an
/// account pool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RouteTarget {
    /// An agent CLI profile id such as `claude` or `codex`.
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub model: Option<String>,
    /// A named pool of accounts to draw from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub pool: Option<String>,
}

impl Default for RouteTarget {
    /// What the default row says until the person writes one.
    fn default() -> RouteTarget {
        RouteTarget {
            agent: "claude".to_owned(),
            model: None,
            pool: None,
        }
    }
}

/// One row of the match table: a kind of work, by keywords or by a task
/// label, and where it goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MatchRow {
    /// Whole words or phrases, any case; one found in the work matches the row.
    #[serde(default)]
    pub keywords: Vec<String>,
    /// A task label, any case; equal to the work's label matches the row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub label: Option<String>,
    pub target: RouteTarget,
}

/// Which row took the work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Matched {
    /// The row's index in the table; none when the default row took it.
    pub row: Option<u32>,
    pub target: RouteTarget,
}

/// Kept in `<data_dir>/routing.json`. `table` and `fallback` are newer than
/// `rules`; a file without them loads as it always did.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Routing {
    #[serde(default)]
    pub rules: Vec<RouteRule>,
    /// Kinds of work, first match wins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub table: Option<Vec<MatchRow>>,
    /// The default row: where work goes when no row of `table` matches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub fallback: Option<RouteTarget>,
}

/// Lower-cased words of `text`, joined by one space and padded, so a phrase
/// is found only between word edges.
fn words(text: &str) -> String {
    let mut out = String::from(" ");
    for w in text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
    {
        out.push_str(&w.to_lowercase());
        out.push(' ');
    }
    out
}

impl MatchRow {
    /// A row with no keywords and no label matches nothing.
    pub fn matches(&self, sentence: &str, label: Option<&str>) -> bool {
        let by_label = match (self.label.as_deref().map(str::trim), label.map(str::trim)) {
            (Some(row), Some(work)) => !row.is_empty() && row.eq_ignore_ascii_case(work),
            _ => false,
        };
        if by_label {
            return true;
        }
        let text = words(sentence);
        self.keywords.iter().any(|k| {
            let k = words(k);
            !k.trim().is_empty() && text.contains(&k)
        })
    }
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
        let blank_agent = |t: &RouteTarget| t.agent.trim().is_empty();
        if self.rules.iter().any(|r| r.model.trim().is_empty())
            || self
                .table
                .iter()
                .flatten()
                .any(|row| blank_agent(&row.target))
            || self.fallback.as_ref().is_some_and(blank_agent)
        {
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

impl Routing {
    /// The first row of the table that matches the work, else the default
    /// row (the built-in one when none is written).
    pub fn route(&self, sentence: &str, label: Option<&str>) -> Matched {
        let found = self
            .table
            .iter()
            .flatten()
            .enumerate()
            .find(|(_, row)| row.matches(sentence, label));
        match found {
            Some((i, row)) => Matched {
                row: Some(i as u32),
                target: clean(&row.target),
            },
            None => Matched {
                row: None,
                target: self.fallback.as_ref().map(clean).unwrap_or_default(),
            },
        }
    }
}

/// A target with its words trimmed and blank optional parts dropped.
fn clean(t: &RouteTarget) -> RouteTarget {
    let keep = |v: &Option<String>| {
        v.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    RouteTarget {
        agent: t.agent.trim().to_owned(),
        model: keep(&t.model),
        pool: keep(&t.pool),
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
            ..Routing::default()
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
            ..Routing::default()
        };
        routing.save(dir.path()).unwrap();
        assert_eq!(Routing::load(dir.path()).unwrap(), routing);

        let blank = Routing {
            rules: vec![rule(None, None, None, " ")],
            ..Routing::default()
        };
        assert_eq!(blank.save(dir.path()).unwrap_err().code(), "empty_text");
        assert_eq!(Routing::load(dir.path()).unwrap(), routing);
    }

    fn row(keywords: &[&str], label: Option<&str>, agent: &str, model: Option<&str>) -> MatchRow {
        MatchRow {
            keywords: keywords.iter().map(|k| (*k).to_owned()).collect(),
            label: label.map(str::to_owned),
            target: RouteTarget {
                agent: agent.to_owned(),
                model: model.map(str::to_owned),
                pool: None,
            },
        }
    }

    fn table() -> Routing {
        Routing {
            table: Some(vec![
                row(&["fix typo", "rename"], None, "codex", Some("gpt-mini")),
                row(
                    &["refactor", "migrate"],
                    Some("big"),
                    "claude",
                    Some("opus"),
                ),
                row(&["refactor"], None, "claude", Some("sonnet")),
            ]),
            ..Routing::default()
        }
    }

    #[test]
    fn the_first_matching_row_wins_and_order_matters() {
        let r = table();
        let m = r.route("Please refactor the parser", None);
        assert_eq!(m.row, Some(1));
        assert_eq!(m.target.model.as_deref(), Some("opus"));
        // Reordered, the later row takes it.
        let mut swapped = table();
        swapped.table.as_mut().unwrap().swap(1, 2);
        let m = swapped.route("Please refactor the parser", None);
        assert_eq!(m.row, Some(1));
        assert_eq!(m.target.model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn keywords_match_whole_words_and_phrases_in_any_case() {
        let r = table();
        assert_eq!(r.route("FIX   Typo in readme", None).row, Some(0));
        assert_eq!(r.route("rename, then ship", None).row, Some(0));
        // Not inside a longer word, and a phrase needs its words in order.
        assert_eq!(r.route("prefactored output", None).row, None);
        assert_eq!(r.route("typo to fix", None).row, None);
    }

    #[test]
    fn a_label_matches_equal_labels_only() {
        let r = Routing {
            table: Some(vec![row(&[], Some("Docs"), "codex", None)]),
            ..Routing::default()
        };
        assert_eq!(r.route("anything", Some(" docs ")).row, Some(0));
        assert_eq!(r.route("docs", None).row, None);
        assert_eq!(r.route("anything", Some("documentation")).row, None);
    }

    #[test]
    fn a_row_without_keywords_or_label_matches_nothing() {
        let r = Routing {
            table: Some(vec![row(&[" ", ""], Some(" "), "codex", None)]),
            ..Routing::default()
        };
        assert_eq!(r.route("whatever", Some("")).row, None);
    }

    #[test]
    fn no_match_takes_the_default_row() {
        let m = table().route("write a poem", None);
        assert_eq!(m.row, None);
        assert_eq!(m.target, RouteTarget::default());
        let mut r = table();
        r.fallback = Some(RouteTarget {
            agent: " codex ".to_owned(),
            model: Some(" ".to_owned()),
            pool: Some("team".to_owned()),
        });
        let m = r.route("write a poem", None);
        assert_eq!(m.target.agent, "codex");
        assert_eq!(m.target.model, None);
        assert_eq!(m.target.pool.as_deref(), Some("team"));
        assert_eq!(Routing::default().route("", None).row, None);
    }

    #[test]
    fn old_rules_still_load_and_new_fields_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(FILE),
            r#"{"rules":[{"role":"review","provider":"claude","maxPrompt":null,"model":"haiku"}]}"#,
        )
        .unwrap();
        let old = Routing::load(dir.path()).unwrap();
        assert_eq!(old.rules.len(), 1);
        assert_eq!(old.table, None);
        assert_eq!(old.pick("review", "claude", "x").as_deref(), Some("haiku"));
        // An old file saves back without the new keys.
        old.save(dir.path()).unwrap();
        let text = fs::read_to_string(dir.path().join(FILE)).unwrap();
        assert!(!text.contains("table") && !text.contains("fallback"));

        let mut next = table();
        next.fallback = Some(RouteTarget::default());
        next.save(dir.path()).unwrap();
        assert_eq!(Routing::load(dir.path()).unwrap(), next);

        let mut blank = table();
        blank.table.as_mut().unwrap()[0].target.agent = " ".to_owned();
        assert_eq!(blank.save(dir.path()).unwrap_err().code(), "empty_text");
    }
}
