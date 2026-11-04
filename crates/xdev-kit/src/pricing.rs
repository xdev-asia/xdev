//! A local per-model price table for the Stats page's estimated
//! API-equivalent cost. An unknown model is unpriced, never guessed.

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

/// Normalised model key to rates; `None` is unpriced.
pub fn rates_for(_agent: Agent, _model: &str) -> Option<Rates> {
    None
}

/// Cost of `t` at `r`, saturating.
pub fn cost_nanos(_r: Rates, _t: &Tokens) -> u64 {
    0
}
