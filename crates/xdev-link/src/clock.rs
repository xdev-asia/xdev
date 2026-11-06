//! Time in milliseconds, injected so limits and the link's ping can be tested.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch (or any fixed origin for a fake).
    fn now_ms(&self) -> u64;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

/// A clock that moves only when told to.
#[derive(Debug, Default, Clone)]
pub struct FakeClock(Arc<AtomicU64>);

impl FakeClock {
    pub fn new(start_ms: u64) -> Self {
        FakeClock(Arc::new(AtomicU64::new(start_ms)))
    }

    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn set(&self, ms: u64) {
        self.0.store(ms, Ordering::SeqCst);
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}
