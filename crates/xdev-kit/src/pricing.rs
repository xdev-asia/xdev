//! A local per-model price table for the Stats page's estimated
//! API-equivalent cost. An unknown model is unpriced, never guessed.
//!
//! The figures are list prices as last read from the vendors' public pages
//! and should be re-checked when `PRICES_AS_OF` is bumped.

use crate::{Agent, Tokens};

pub const PRICES_AS_OF: &str = "2026-11-04";

/// Nano-USD per token (1 USD/MTok = 1000). Codex has no cache-write rate (0).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rates {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

const fn usd(input: u64, output: u64, cache_read: u64, cache_write: u64) -> Rates {
    Rates {
        input,
        output,
        cache_read,
        cache_write,
    }
}

// Claude, in nano-USD per token (the 5-minute cache write rate).
const OPUS_OLD: Rates = usd(15_000, 75_000, 1_500, 18_750);
const OPUS_NEW: Rates = usd(5_000, 25_000, 500, 6_250);
const SONNET: Rates = usd(3_000, 15_000, 300, 3_750);
const HAIKU_45: Rates = usd(1_000, 5_000, 100, 1_250);
const HAIKU_35: Rates = usd(800, 4_000, 80, 1_000);
const HAIKU_3: Rates = usd(250, 1_250, 30, 300);

// Codex (OpenAI), no cache-write rate.
const GPT5: Rates = usd(1_250, 10_000, 125, 0);
const GPT5_MINI: Rates = usd(250, 2_000, 25, 0);
const GPT5_NANO: Rates = usd(50, 400, 5, 0);
const GPT52: Rates = usd(1_750, 14_000, 175, 0);
const GPT54: Rates = usd(2_500, 15_000, 250, 0);
const GPT56: Rates = usd(5_000, 30_000, 500, 0);

/// Normalised model key to rates; `None` is unpriced.
pub fn rates_for(agent: Agent, model: &str) -> Option<Rates> {
    match agent {
        Agent::Claude => claude(model),
        Agent::Codex => codex(model),
    }
}

/// Cost of `t` at `r`, saturating.
pub fn cost_nanos(r: Rates, t: &Tokens) -> u64 {
    let term = |rate: u64, n: u64| u128::from(rate) * u128::from(n);
    let sum = term(r.input, t.input)
        .saturating_add(term(r.output, t.output))
        .saturating_add(term(r.cache_read, t.cache_read))
        .saturating_add(term(r.cache_write, t.cache_write));
    u64::try_from(sum).unwrap_or(u64::MAX)
}

/// `claude-opus-4-5-20251101`, `claude-3-5-sonnet-20241022`,
/// `claude-sonnet-4.5` and a `[1m]` / `-1m` suffix all name a family and a
/// version; only versions in the table are priced.
fn claude(model: &str) -> Option<Rates> {
    let m = model.trim().to_lowercase();
    let m = m.strip_suffix("[1m]").unwrap_or(&m).trim_end();
    let m = m.replace('.', "-");
    let mut family = None;
    let mut version: Vec<u32> = Vec::new();
    for part in m.split('-') {
        match part {
            "opus" | "sonnet" | "haiku" => family = Some(part.to_owned()),
            "claude" | "1m" | "latest" => {}
            p => {
                // A date stamp is 8 digits; anything else numeric is a version.
                if p.len() < 8
                    && let Ok(n) = p.parse::<u32>()
                {
                    version.push(n);
                }
            }
        }
    }
    let v = (
        version.first().copied()?,
        version.get(1).copied().unwrap_or(0),
    );
    match family?.as_str() {
        "opus" => match v {
            (3, 0) | (4, 0 | 1) => Some(OPUS_OLD),
            (4, 5..=9) => Some(OPUS_NEW),
            _ => None,
        },
        "sonnet" => match v {
            (3, 5 | 7) | (4, 0) | (4, 5..=9) => Some(SONNET),
            _ => None,
        },
        "haiku" => match v {
            (3, 0) => Some(HAIKU_3),
            (3, 5) => Some(HAIKU_35),
            (4, 5..=9) => Some(HAIKU_45),
            _ => None,
        },
        _ => None,
    }
}

const TIERS: [&str; 7] = ["minimal", "low", "medium", "high", "xhigh", "auto", "none"];

/// `gpt-5-codex`, `gpt-5.1-codex-max-high`, `gpt-5.4 (xhigh)`: the reasoning
/// tier and the `-codex` product suffix do not change the price.
fn codex(model: &str) -> Option<Rates> {
    let mut m = model.trim().to_lowercase();
    if let Some(open) = m.rfind(" (")
        && let Some(tier) = m[open + 2..].strip_suffix(')')
        && TIERS.contains(&tier)
    {
        m.truncate(open);
    }
    for _ in 0..4 {
        let Some((head, tail)) = m.rsplit_once('-') else {
            break;
        };
        if !TIERS.contains(&tail) {
            break;
        }
        m = head.to_owned();
    }
    for suffix in ["-codex-max", "-codex-mini", "-codex"] {
        if let Some(head) = m.strip_suffix(suffix) {
            // `-codex-mini` is the mini model of its generation.
            m = if suffix == "-codex-mini" {
                format!("{head}-mini")
            } else {
                head.to_owned()
            };
            break;
        }
    }
    match m.as_str() {
        "gpt-5" | "gpt-5.1" => Some(GPT5),
        "gpt-5-mini" | "gpt-5.1-mini" => Some(GPT5_MINI),
        "gpt-5-nano" => Some(GPT5_NANO),
        "gpt-5.2" | "gpt-5.3" => Some(GPT52),
        "gpt-5.4" | "gpt-5.5" => Some(GPT54),
        "gpt-5.6" => Some(GPT56),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(m: &str) -> Option<Rates> {
        rates_for(Agent::Claude, m)
    }

    fn x(m: &str) -> Option<Rates> {
        rates_for(Agent::Codex, m)
    }

    #[test]
    fn claude_ids_in_every_spelling() {
        assert_eq!(c("claude-opus-4-5-20251101"), Some(OPUS_NEW));
        assert_eq!(c("claude-3-5-sonnet-20241022"), Some(SONNET));
        assert_eq!(c("claude-sonnet-4.5"), Some(SONNET));
        assert_eq!(c("claude-sonnet-4-5"), Some(SONNET));
        assert_eq!(c("claude-opus-4-1-20250805"), Some(OPUS_OLD));
        assert_eq!(c("claude-3-5-haiku-20241022"), Some(HAIKU_35));
        assert_eq!(c("claude-haiku-4-5"), Some(HAIKU_45));
    }

    #[test]
    fn a_one_million_context_suffix_is_ignored() {
        assert_eq!(c("claude-sonnet-4-5[1m]"), c("claude-sonnet-4-5"));
        assert_eq!(c("claude-sonnet-4-5-1m"), c("claude-sonnet-4-5"));
        assert_eq!(c("Claude-Opus-4-5"), Some(OPUS_NEW));
    }

    #[test]
    fn an_unknown_claude_model_is_unpriced() {
        assert_eq!(c("claude-opus-9"), None);
        assert_eq!(c("claude"), None);
        assert_eq!(c(""), None);
        assert_eq!(c("gpt-5"), None);
    }

    #[test]
    fn codex_ids_in_every_spelling() {
        assert_eq!(x("gpt-5-codex"), Some(GPT5));
        assert_eq!(x("gpt-5"), Some(GPT5));
        assert_eq!(x("gpt-5.1-codex-max-high"), Some(GPT5));
        assert_eq!(x("gpt-5.4 (xhigh)"), Some(GPT54));
        assert_eq!(x("GPT-5.4"), Some(GPT54));
        assert_eq!(x("gpt-5.1-codex-mini"), Some(GPT5_MINI));
        assert_eq!(x("gpt-5.6"), Some(GPT56));
    }

    #[test]
    fn an_unknown_codex_model_is_unpriced() {
        assert_eq!(x("gpt-5.4 (turbo)"), None);
        assert_eq!(x("o9"), None);
        assert_eq!(x(""), None);
    }

    #[test]
    fn cost_is_the_rate_times_the_tokens() {
        let r = usd(1, 2, 3, 4);
        let m = 1_000_000;
        let only = |input, output, cache_read, cache_write| Tokens {
            input,
            output,
            cache_read,
            cache_write,
        };
        assert_eq!(cost_nanos(r, &only(m, 0, 0, 0)), 1_000_000);
        assert_eq!(cost_nanos(r, &only(0, m, 0, 0)), 2_000_000);
        assert_eq!(cost_nanos(r, &only(0, 0, m, 0)), 3_000_000);
        assert_eq!(cost_nanos(r, &only(0, 0, 0, m)), 4_000_000);
        assert_eq!(cost_nanos(r, &Tokens::default()), 0);
    }

    #[test]
    fn cost_saturates() {
        let r = usd(u64::MAX, u64::MAX, 0, 0);
        let t = Tokens {
            input: u64::MAX,
            output: u64::MAX,
            cache_read: 0,
            cache_write: 0,
        };
        assert_eq!(cost_nanos(r, &t), u64::MAX);
    }
}
