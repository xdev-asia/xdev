//! Reconnect delays: 1, 2, 4, 8, 16, then 30 s; reset after a success.

use std::time::Duration;

const STEPS_S: [u64; 6] = [1, 2, 4, 8, 16, 30];

#[derive(Debug, Default, Clone)]
pub struct Backoff {
    step: usize,
}

impl Backoff {
    pub fn new() -> Backoff {
        Backoff::default()
    }

    pub fn next_delay(&mut self) -> Duration {
        let s = STEPS_S[self.step.min(STEPS_S.len() - 1)];
        self.step = (self.step + 1).min(STEPS_S.len() - 1);
        Duration::from_secs(s)
    }

    pub fn reset(&mut self) {
        self.step = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles_to_a_cap_and_resets() {
        let mut b = Backoff::new();
        let got: Vec<u64> = (0..8).map(|_| b.next_delay().as_secs()).collect();
        assert_eq!(got, [1, 2, 4, 8, 16, 30, 30, 30]);
        b.reset();
        assert_eq!(b.next_delay().as_secs(), 1);
    }
}
