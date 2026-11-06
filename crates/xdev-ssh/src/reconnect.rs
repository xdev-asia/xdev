//! When a dropped host is tried again, and the state a host is in. Pure: the
//! caller sleeps and spawns.

use std::time::Duration;

use crate::remote_view::RemoteConnState;

/// The waits before each try, in seconds; the last one repeats.
const DELAYS: [u64; 6] = [1, 2, 4, 8, 16, 30];

/// The tries after a drop before the host counts as offline.
pub const MAX_TRIES: u32 = 20;

/// 1, 2, 4, 8, 16, 30, 30, … s, at most `max_tries` times.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backoff {
    tries: u32,
    pub max_tries: u32,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new(MAX_TRIES)
    }
}

impl Backoff {
    pub fn new(max_tries: u32) -> Self {
        Self {
            tries: 0,
            max_tries,
        }
    }

    /// How many tries were handed out since the last reset.
    pub fn tries(&self) -> u32 {
        self.tries
    }

    /// After a good connection: the next drop starts at 1 s again.
    pub fn reset(&mut self) {
        self.tries = 0;
    }
}

impl Iterator for Backoff {
    type Item = Duration;

    /// The wait before the next try, or `None` once every try is spent.
    fn next(&mut self) -> Option<Duration> {
        if self.tries >= self.max_tries {
            return None;
        }
        let at = (self.tries as usize).min(DELAYS.len() - 1);
        self.tries += 1;
        Some(Duration::from_secs(DELAYS[at]))
    }
}

/// Where a host's connection is.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum RemoteState {
    #[default]
    Idle,
    Connecting,
    Connected {
        tmux: bool,
        git: bool,
    },
    /// Try `attempt` (from 1) starts after `next_in`.
    Reconnecting {
        attempt: u32,
        next_in: Duration,
    },
    Offline {
        reason: String,
    },
}

impl RemoteState {
    /// What follows a drop: the next try from `backoff`, or offline once
    /// they are spent.
    pub fn after_drop(backoff: &mut Backoff, reason: &str) -> RemoteState {
        match backoff.next() {
            Some(next_in) => RemoteState::Reconnecting {
                attempt: backoff.tries(),
                next_in,
            },
            None => RemoteState::Offline {
                reason: reason.to_owned(),
            },
        }
    }

    /// A good connection: resets `backoff`.
    pub fn after_connect(backoff: &mut Backoff, tmux: bool, git: bool) -> RemoteState {
        backoff.reset();
        RemoteState::Connected { tmux, git }
    }

    pub fn view(&self) -> RemoteConnState {
        match self {
            Self::Idle => RemoteConnState::Idle,
            Self::Connecting => RemoteConnState::Connecting,
            Self::Connected { tmux, git } => RemoteConnState::Connected {
                tmux: *tmux,
                git: *git,
            },
            Self::Reconnecting { attempt, next_in } => RemoteConnState::Reconnecting {
                attempt: *attempt,
                next_in_secs: next_in.as_secs() as u32,
            },
            Self::Offline { reason } => RemoteConnState::Offline {
                reason: reason.clone(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_sequence_cap_and_reset() {
        let mut b = Backoff::default();
        let secs: Vec<u64> = b.by_ref().map(|d| d.as_secs()).collect();
        assert_eq!(secs.len(), 20);
        assert_eq!(&secs[..8], [1, 2, 4, 8, 16, 30, 30, 30]);
        assert!(secs[5..].iter().all(|&s| s == 30));
        assert_eq!(b.next(), None);
        b.reset();
        assert_eq!(b.next(), Some(Duration::from_secs(1)));
        assert_eq!(b.next(), Some(Duration::from_secs(2)));
    }

    #[test]
    fn state_after_drop_and_connect() {
        let mut b = Backoff::new(2);
        assert_eq!(
            RemoteState::after_drop(&mut b, "exit 255"),
            RemoteState::Reconnecting {
                attempt: 1,
                next_in: Duration::from_secs(1)
            }
        );
        RemoteState::after_drop(&mut b, "exit 255");
        let off = RemoteState::after_drop(&mut b, "exit 255");
        assert_eq!(
            off.view(),
            RemoteConnState::Offline {
                reason: "exit 255".into()
            }
        );
        let on = RemoteState::after_connect(&mut b, true, false);
        assert_eq!(
            on.view(),
            RemoteConnState::Connected {
                tmux: true,
                git: false
            }
        );
        assert_eq!(b.tries(), 0);
    }

    #[test]
    fn the_view_serializes_like_the_ts_type() {
        let v = RemoteState::Reconnecting {
            attempt: 3,
            next_in: Duration::from_secs(4),
        }
        .view();
        assert_eq!(
            serde_json::to_string(&v).unwrap(),
            r#"{"state":"reconnecting","attempt":3,"nextInSecs":4}"#
        );
        assert_eq!(
            serde_json::to_string(&RemoteConnState::Idle).unwrap(),
            r#"{"state":"idle"}"#
        );
    }
}
