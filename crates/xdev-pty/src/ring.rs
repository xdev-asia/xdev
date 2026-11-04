//! The last output of one PTY, addressed by its byte offset since the start
//! (`seq`), so a client that comes back asks for what it has not drawn.

use std::collections::VecDeque;

#[derive(Debug)]
pub struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
    /// The seq one past the newest byte.
    end: u64,
    /// The newest byte dropped, so a cut right after a newline is a clean one.
    dropped: Option<u8>,
}

impl Ring {
    pub fn new(cap: usize) -> Ring {
        Ring {
            buf: VecDeque::with_capacity(cap.min(64 * 1024)),
            cap: cap.max(1),
            end: 0,
            dropped: None,
        }
    }

    /// Adds `bytes`, dropping the oldest past the capacity; returns the new end.
    pub fn push(&mut self, bytes: &[u8]) -> u64 {
        self.end += bytes.len() as u64;
        let kept = &bytes[bytes.len().saturating_sub(self.cap)..];
        if kept.len() < bytes.len() {
            self.buf.clear();
            self.dropped = Some(bytes[bytes.len() - kept.len() - 1]);
        } else {
            let over = (self.buf.len() + kept.len()).saturating_sub(self.cap);
            if over > 0 {
                self.dropped = self.buf.get(over - 1).copied();
                self.buf.drain(..over);
            }
        }
        self.buf.extend(kept);
        self.end
    }

    /// The seq one past the newest byte.
    pub fn end(&self) -> u64 {
        self.end
    }

    /// The seq of the oldest byte still held.
    pub fn start(&self) -> u64 {
        self.end - self.buf.len() as u64
    }

    /// The bytes from `seq` on, and how many of the ones asked for are gone.
    /// When the ring has dropped some of them, the replay starts after the
    /// first newline past the cut, so it does not open inside an escape
    /// sequence or a half line.
    pub fn since(&self, seq: u64) -> (Vec<u8>, u64) {
        let start = self.start();
        if seq >= self.end {
            return (Vec::new(), 0);
        }
        if seq >= start {
            let skip = (seq - start) as usize;
            return (self.buf.range(skip..).copied().collect(), 0);
        }
        let skip = if self.dropped == Some(b'\n') {
            0
        } else {
            self.buf
                .iter()
                .position(|&b| b == b'\n')
                .map_or(0, |i| i + 1)
        };
        let bytes: Vec<u8> = self.buf.range(skip..).copied().collect();
        (bytes, start - seq + skip as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_everything_below_capacity() {
        let mut r = Ring::new(16);
        assert_eq!(r.push(b"hello "), 6);
        assert_eq!(r.push(b"world"), 11);
        assert_eq!(r.since(0), (b"hello world".to_vec(), 0));
        assert_eq!(r.since(6), (b"world".to_vec(), 0));
        assert_eq!(r.start(), 0);
    }

    #[test]
    fn wraps_and_drops_the_oldest() {
        let mut r = Ring::new(8);
        r.push(b"abc\ndefgh");
        r.push(b"ij\nkl");
        assert_eq!(r.end(), 14);
        assert_eq!(r.start(), 6);
        // Held: "fghij\nkl"; asked from 0, the replay starts past the newline.
        assert_eq!(r.since(0), (b"kl".to_vec(), 12));
        // Inside what is held: no cut, no newline rule.
        assert_eq!(r.since(7), (b"ghij\nkl".to_vec(), 0));
    }

    #[test]
    fn a_push_bigger_than_the_ring_keeps_its_tail() {
        let mut r = Ring::new(4);
        assert_eq!(r.push(b"0123456789"), 10);
        assert_eq!(r.start(), 6);
        assert_eq!(r.since(6), (b"6789".to_vec(), 0));
    }

    #[test]
    fn the_exact_boundary_loses_nothing() {
        let mut r = Ring::new(4);
        r.push(b"ab");
        r.push(b"cd");
        assert_eq!(r.since(0), (b"abcd".to_vec(), 0));
        r.push(b"e");
        assert_eq!(r.since(1), (b"bcde".to_vec(), 0));
        assert_eq!(r.since(5), (Vec::new(), 0));
    }

    #[test]
    fn a_seq_in_the_future_is_empty() {
        let mut r = Ring::new(4);
        r.push(b"ab");
        assert_eq!(r.since(9), (Vec::new(), 0));
    }

    #[test]
    fn a_cut_with_no_newline_replays_what_is_held() {
        let mut r = Ring::new(4);
        r.push(b"abcdefgh");
        assert_eq!(r.since(2), (b"efgh".to_vec(), 2));
    }

    #[test]
    fn a_cut_right_after_a_newline_starts_there() {
        let mut r = Ring::new(4);
        r.push(b"abc\ndefg");
        // Held: "defg" (start 4); the byte before the cut was the newline.
        assert_eq!(r.since(0), (b"defg".to_vec(), 4));
    }
}
