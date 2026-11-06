//! Per-connection token buckets: 20 requests/s, 5 inputs/s and 2 MiB/s of
//! stream bytes.

use std::sync::Arc;

use crate::clock::Clock;

pub const RPC_PER_S: f64 = 20.0;
pub const INPUT_PER_S: f64 = 5.0;
pub const STREAM_BYTES_PER_S: f64 = 2.0 * 1024.0 * 1024.0;

pub struct TokenBucket {
    capacity: f64,
    per_s: f64,
    tokens: f64,
    last_ms: u64,
}

impl TokenBucket {
    /// Starts full.
    pub fn new(per_s: f64, now_ms: u64) -> TokenBucket {
        TokenBucket {
            capacity: per_s,
            per_s,
            tokens: per_s,
            last_ms: now_ms,
        }
    }

    pub fn take(&mut self, n: f64, now_ms: u64) -> bool {
        let elapsed = now_ms.saturating_sub(self.last_ms) as f64 / 1000.0;
        self.last_ms = self.last_ms.max(now_ms);
        self.tokens = (self.tokens + elapsed * self.per_s).min(self.capacity);
        if self.tokens >= n {
            self.tokens -= n;
            true
        } else {
            false
        }
    }
}

pub struct Limits {
    clock: Arc<dyn Clock>,
    rpc: TokenBucket,
    input: TokenBucket,
    stream: TokenBucket,
}

impl Limits {
    pub fn new(clock: Arc<dyn Clock>) -> Limits {
        let now = clock.now_ms();
        Limits {
            rpc: TokenBucket::new(RPC_PER_S, now),
            input: TokenBucket::new(INPUT_PER_S, now),
            stream: TokenBucket::new(STREAM_BYTES_PER_S, now),
            clock,
        }
    }

    pub fn allow_rpc(&mut self) -> bool {
        let now = self.clock.now_ms();
        self.rpc.take(1.0, now)
    }

    pub fn allow_input(&mut self) -> bool {
        let now = self.clock.now_ms();
        self.input.take(1.0, now)
    }

    pub fn allow_stream(&mut self, bytes: usize) -> bool {
        let now = self.clock.now_ms();
        self.stream.take(bytes as f64, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FakeClock;

    #[test]
    fn rpc_burst_then_refill() {
        let clock = FakeClock::new(0);
        let mut l = Limits::new(Arc::new(clock.clone()));
        for _ in 0..20 {
            assert!(l.allow_rpc());
        }
        assert!(!l.allow_rpc());
        clock.advance(100);
        assert!(l.allow_rpc(), "100 ms refills two tokens");
        assert!(l.allow_rpc());
        assert!(!l.allow_rpc());
    }

    #[test]
    fn input_is_five_per_second() {
        let clock = FakeClock::new(0);
        let mut l = Limits::new(Arc::new(clock.clone()));
        assert!((0..5).all(|_| l.allow_input()));
        assert!(!l.allow_input());
        clock.advance(1_000);
        assert!((0..5).all(|_| l.allow_input()));
        assert!(!l.allow_input());
    }

    #[test]
    fn stream_bytes_per_second() {
        let clock = FakeClock::new(0);
        let mut l = Limits::new(Arc::new(clock.clone()));
        assert!(l.allow_stream(2 * 1024 * 1024));
        assert!(!l.allow_stream(1));
        clock.advance(500);
        assert!(l.allow_stream(1024 * 1024));
        assert!(!l.allow_stream(1024));
    }
}
